import Fastify from "fastify";
import healthRoutes from "./routes/health.js";
import databaseRoutes from "./routes/databases.js";
import backupRoutes from "./routes/backups.js";
import restoreRoutes from "./routes/restores.js";
import changeRoutes from "./routes/changes.js";
import metricsRoutes from "./routes/metrics.js";
import auditRoutes from "./routes/audit.js";
import { registerWebPlugins } from "./web/plugins.js";
import { requireApiAuth } from "./web/auth.js";
import authRoutes from "./web/routes/authRoutes.js";
import dashboardRoutes from "./web/routes/dashboardRoutes.js";
import databaseWebRoutes from "./web/routes/databaseWebRoutes.js";
import restoreStatusRoutes from "./web/routes/restoreStatusRoutes.js";
import downloadRoutes from "./web/routes/downloadRoutes.js";
import backupBrowseRoutes from "./web/routes/backupBrowseRoutes.js";
import metricsDashboardRoutes from "./web/routes/metricsDashboardRoutes.js";

export async function buildApp() {
  const app = Fastify({ logger: true });

  // Session/CSRF/view/static plugins must be ready before anything below
  // references their decorators (app.csrfProtection, request.session, reply.view).
  await registerWebPlugins(app);

  app.register(healthRoutes); // infra health check — intentionally open
  app.register(metricsRoutes); // Prometheus scrape — intentionally open

  // JSON API: guarded by the same session cookie as the SSR UI (the
  // restore-status page polls these from the browser) — not a separate auth
  // system. Without this, /api/* would be a wide-open bypass around /login.
  app.register(async (apiScope) => {
    apiScope.addHook("onRequest", requireApiAuth);
    apiScope.register(databaseRoutes);
    apiScope.register(backupRoutes);
    apiScope.register(restoreRoutes);
    apiScope.register(changeRoutes);
    apiScope.register(auditRoutes);
  });

  // SSR admin UI
  app.register(authRoutes);
  app.register(dashboardRoutes);
  app.register(databaseWebRoutes);
  app.register(restoreStatusRoutes);
  app.register(downloadRoutes);
  app.register(backupBrowseRoutes);
  app.register(metricsDashboardRoutes);

  return app;
}
