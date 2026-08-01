import { listAuditEntries } from "../repositories/auditRepo.js";

export default async function auditRoutes(app) {
  app.get("/api/audit", async (request) => {
    const { dbId, limit } = request.query ?? {};
    return listAuditEntries({ dbId, limit: limit ? Number(limit) : undefined });
  });
}
