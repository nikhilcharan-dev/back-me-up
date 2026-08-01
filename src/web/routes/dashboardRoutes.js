import { requireAuth } from "../auth.js";
import { baseViewContext } from "../viewContext.js";
import { listRegisteredDatabases } from "../../services/databaseService.js";

export default async function dashboardRoutes(app) {
  app.get("/", { preHandler: requireAuth }, async (request, reply) => {
    const databases = await listRegisteredDatabases();
    return reply.view("dashboard.ejs", {
      ...(await baseViewContext(request, reply)),
      title: "Dashboard",
      databases,
    });
  });
}
