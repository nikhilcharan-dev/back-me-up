import { verifyCredentials, recordLogin } from "../../services/userService.js";
import { isRateLimited, recordFailedAttempt, clearAttempts } from "../loginRateLimit.js";
import { popFlash } from "../flash.js";

export default async function authRoutes(app) {
  app.get("/login", async (request, reply) => {
    if (request.session.get("userId")) return reply.redirect("/");
    const flash = popFlash(request);
    return reply.view("login.ejs", { flash, csrfToken: reply.generateCsrf(), error: null });
  });

  app.post("/login", { preHandler: app.csrfProtection }, async (request, reply) => {
    const ip = request.ip;
    if (isRateLimited(ip)) {
      return reply
        .code(429)
        .view("login.ejs", { flash: null, csrfToken: reply.generateCsrf(), error: "Too many attempts — try again in a few minutes." });
    }

    const { username, password } = request.body ?? {};
    const user = await verifyCredentials(username, password);
    await recordLogin(username, Boolean(user), ip);

    if (!user) {
      recordFailedAttempt(ip);
      return reply
        .code(401)
        .view("login.ejs", { flash: null, csrfToken: reply.generateCsrf(), error: "Invalid username or password." });
    }

    clearAttempts(ip);
    request.session.set("userId", String(user._id));
    request.session.set("username", user.username);
    return reply.redirect("/");
  });

  app.post("/logout", { preHandler: app.csrfProtection }, async (request, reply) => {
    request.session.delete();
    return reply.redirect("/login");
  });
}
