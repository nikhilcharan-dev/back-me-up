import { runBaseBackup } from "../services/backupService.js";
import { listBaseBackupsForDb, findBaseBackupById } from "../repositories/backupsRepo.js";

export default async function backupRoutes(app) {
  app.post("/api/databases/:id/backups", async (request, reply) => {
    try {
      const result = await runBaseBackup(request.params.id);
      return reply.code(201).send(result);
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.get("/api/databases/:id/backups", async (request) => {
    return listBaseBackupsForDb(request.params.id);
  });

  app.get("/api/backups/:id", async (request, reply) => {
    const doc = await findBaseBackupById(request.params.id);
    if (!doc) return reply.code(404).send({ error: "Not found" });
    return doc;
  });
}
