import { registry } from "../metrics/registry.js";

export default async function metricsRoutes(app) {
  app.get("/metrics", async (request, reply) => {
    reply.header("Content-Type", registry.contentType);
    return registry.metrics();
  });
}
