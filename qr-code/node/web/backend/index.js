// @ts-check
import path from "path";
import express from "express";
import cookieParser from "cookie-parser";
import { Shopify, ApiVersion } from "@shopify/shopify-api";

import applyAuthMiddleware from "./middleware/auth.js";
import verifyRequest from "./middleware/verify-request.js";
import { setupGDPRWebHooks } from "./gdpr.js";
import { QRCodesDB } from "./qr-codes-db.js";

const USE_ONLINE_TOKENS = true;
const TOP_LEVEL_OAUTH_COOKIE = "shopify_top_level_oauth";

const PORT = parseInt(process.env.BACKEND_PORT, 10);
const isTest = process.env.NODE_ENV === "test" || !!process.env.VITE_TEST_BUILD;

// TODO: There should be provided by env vars
const DEV_INDEX_PATH = `${process.cwd()}/frontend/`;
const PROD_INDEX_PATH = `${process.cwd()}/dist/`;

const sessionDbFile = path.join(process.cwd(), "session_db.sqlite");
const qrCodesDbFile = path.join(process.cwd(), "qr_codes_db.sqlite");

Shopify.Context.initialize({
  API_KEY: process.env.SHOPIFY_API_KEY,
  API_SECRET_KEY: process.env.SHOPIFY_API_SECRET,
  SCOPES: process.env.SCOPES.split(","),
  HOST_NAME: process.env.HOST.replace(/https?:\/\//, ""),
  HOST_SCHEME: process.env.HOST.split("://")[0],
  API_VERSION: ApiVersion.April22,
  IS_EMBEDDED_APP: true,
  // This should be replaced with your preferred storage strategy
  SESSION_STORAGE: new Shopify.Session.MemorySessionStorage(),
  // SESSION_STORAGE: new Shopify.Session.SQLiteSessionStorage(sessionDbFile),
});

const qrCodesDB = new QRCodesDB(qrCodesDbFile);

// Storing the currently active shops in memory will force them to re-login when your server restarts. You should
// persist this object in your app.
const ACTIVE_SHOPIFY_SHOPS = {};
Shopify.Webhooks.Registry.addHandler("APP_UNINSTALLED", {
  path: "/api/webhooks",
  webhookHandler: async (topic, shop, body) =>
    delete ACTIVE_SHOPIFY_SHOPS[shop],
});

// This sets up the mandatory GDPR webhooks. You’ll need to fill in the endpoint
// in the “GDPR mandatory webhooks” section in the “App setup” tab, and customize
// the code when you store customer data.
//
// More details can be found on shopify.dev:
// https://shopify.dev/apps/webhooks/configuration/mandatory-webhooks
setupGDPRWebHooks("/api/webhooks");

// export for test use only
export async function createServer(
  root = process.cwd(),
  isProd = process.env.NODE_ENV === "production"
) {
  const app = express();
  app.set("top-level-oauth-cookie", TOP_LEVEL_OAUTH_COOKIE);
  app.set("active-shopify-shops", ACTIVE_SHOPIFY_SHOPS);
  app.set("use-online-tokens", USE_ONLINE_TOKENS);

  app.use(cookieParser(Shopify.Context.API_SECRET_KEY));

  applyAuthMiddleware(app);

  app.post("/api/webhooks", async (req, res) => {
    try {
      await Shopify.Webhooks.Registry.process(req, res);
      console.log(`Webhook processed, returned status code 200`);
    } catch (error) {
      console.log(`Failed to process webhook: ${error}`);
      if (!res.headersSent) {
        res.status(500).send(error.message);
      }
    }
  });

  // All endpoints from this point on will require authentication, comment to disable authentication as a whole
  // app.use("/api/*", verifyRequest(app));

  app.get("/api/products-count", async (req, res) => {
    const session = await Shopify.Utils.loadCurrentSession(req, res, true);
    const { Product } = await import(
      `@shopify/shopify-api/dist/rest-resources/${Shopify.Context.API_VERSION}/index.js`
    );

    const countData = await Product.count({ session });
    res.status(200).send(countData);
  });

  app.post("/api/graphql", async (req, res) => {
    try {
      const response = await Shopify.Utils.graphqlProxy(req, res);
      res.status(200).send(response.body);
    } catch (error) {
      res.status(500).send(error.message);
    }
  });

  app.use(express.json());

  app.post("/api/qrcode", async (req, res) => {
    try {
      await qrCodesDB.create(parseQrCodeBody(req));
      res.status(201).send();
    } catch (error) {
      res.status(500).send(error.message);
    }
  });

  app.put("/api/qrcode/:id", async (req, res) => {
    const qrCode = await getQrCodeOr404(req, res);

    if (qrCode) {
      try {
        await qrCodesDB.update(req.params.id, parseQrCodeBody(req));
        res.status(200).send();
      } catch (error) {
        res.status(500).send(error.message);
      }
    }
  });

  app.get("/api/qrcode", async (req, res) => {
    try {
      const response = await qrCodesDB.list();
      res.status(200).send(response);
    } catch (error) {
      res.status(500).send(error.message);
    }
  });

  app.get("/api/qrcode/:id", async (req, res) => {
    const qrCode = await getQrCodeOr404(req, res);

    if (qrCode) {
      res.status(200).send(qrCode);
    }
  });

  app.delete("/api/qrcode/:id", async (req, res) => {
    const qrCode = await getQrCodeOr404(req, res);

    if (qrCode) {
      await qrCodesDB.delete(req.params.id);
      res.status(200).send();
    }
  });

  app.use((req, res, next) => {
    const shop = req.query.shop;
    if (Shopify.Context.IS_EMBEDDED_APP && shop) {
      res.setHeader(
        "Content-Security-Policy",
        `frame-ancestors https://${shop} https://admin.shopify.com;`
      );
    } else {
      res.setHeader("Content-Security-Policy", `frame-ancestors 'none';`);
    }
    next();
  });

  if (isProd) {
    const compression = await import("compression").then(
      ({ default: fn }) => fn
    );
    const serveStatic = await import("serve-static").then(
      ({ default: fn }) => fn
    );
    app.use(compression());
    app.use(serveStatic(PROD_INDEX_PATH));
  }

  app.use("/*", async (req, res, next) => {
    const shop = req.query.shop;

    // Detect whether we need to reinstall the app, any request from Shopify will
    // include a shop in the query parameters.
    if (app.get("active-shopify-shops")[shop] === undefined && shop) {
      res.redirect(`/api/auth?shop=${shop}`);
    } else {
      // res.set('X-Shopify-App-Nothing-To-See-Here', '1');
      const fs = await import("fs");
      const fallbackFile = path.join(
        isProd ? PROD_INDEX_PATH : DEV_INDEX_PATH,
        "index.html"
      );
      res
        .status(200)
        .set("Content-Type", "text/html")
        .send(fs.readFileSync(fallbackFile));
    }
  });

  return { app };
}

if (!isTest) {
  createServer().then(({ app }) => app.listen(PORT));
}

/**
 * Expect body to contain
 * {
 *   productId: "<product id>",
 *   goToCheckout: "true" | "false",
 *   discountCode: "" | "<discount code id>"
 * }
 */
function parseQrCodeBody(req) {
  return {
    productId: req.body.productId,
    goToCheckout: !!req.body.goToCheckout,
    discountCode: req.body.discountCode,
  };
}

async function getQrCodeOr404(req, res) {
  try {
    const response = await qrCodesDB.read(req.params.id);
    if (response === undefined) {
      res.status(404).send();
    } else {
      return response;
    }
  } catch (error) {
    res.status(500).send(error.message);
  }

  return undefined;
}