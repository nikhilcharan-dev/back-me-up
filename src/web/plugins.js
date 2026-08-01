import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyView from "@fastify/view";
import fastifyFormbody from "@fastify/formbody";
import fastifySecureSession from "@fastify/secure-session";
import fastifyCsrf from "@fastify/csrf-protection";
import fastifyStatic from "@fastify/static";
import ejs from "ejs";
import { config } from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function registerWebPlugins(app) {
  await app.register(fastifyFormbody);

  await app.register(fastifySecureSession, {
    key: Buffer.from(config.sessionKey, "base64"),
    cookieName: "backmeup_session",
    cookie: { path: "/", httpOnly: true, sameSite: "lax" },
  });

  await app.register(fastifyCsrf, { sessionPlugin: "@fastify/secure-session" });

  await app.register(fastifyView, {
    engine: { ejs },
    root: path.join(__dirname, "views"),
  });

  await app.register(fastifyStatic, {
    root: path.join(__dirname, "public"),
    prefix: "/static/",
  });
}
