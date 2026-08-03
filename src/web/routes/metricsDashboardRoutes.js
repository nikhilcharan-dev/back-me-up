import { requireAuth } from "../auth.js";
import { baseViewContext } from "../viewContext.js";
import { getDashboardMetrics } from "../../services/metricsService.js";

// A human-readable view onto the same registry /metrics exposes to Prometheus.
// Kept under a distinct path (rather than reusing /metrics) since /metrics stays
// unauthenticated for scraping — this page sits behind the normal admin login.
export default async function metricsDashboardRoutes(app) {
  app.get("/metrics-dashboard", { preHandler: requireAuth }, async (request, reply) => {
    const data = await getDashboardMetrics();
    return reply.view("metrics-dashboard.ejs", {
      ...(await baseViewContext(request, reply)),
      title: "Metrics",
      ...data,
    });
  });
}
