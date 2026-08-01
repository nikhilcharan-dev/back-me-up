import { runRestore } from "../services/restoreService.js";
import { findRestoreJobById } from "../repositories/restoresRepo.js";

export default async function restoreRoutes(app) {
  // Point-in-time: { dbId, targetTimestamp, targetUri } — base auto-selected, replayed to the second.
  // Base-only:      { baseBackupId, targetUri } — last snapshot, no replay.
  app.post("/api/restores", async (request, reply) => {
    const { dbId, baseBackupId, targetTimestamp, targetUri, mode } = request.body ?? {};
    if (!targetUri) {
      return reply.code(400).send({ error: "targetUri is required" });
    }
    if (!targetTimestamp && !baseBackupId) {
      return reply.code(400).send({ error: "Provide targetTimestamp (with dbId) or baseBackupId" });
    }
    try {
      const result = await runRestore({ dbId, baseBackupId, targetTimestamp, targetUri, mode });
      return reply.code(201).send(result);
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.get("/api/restores/:id", async (request, reply) => {
    const doc = await findRestoreJobById(request.params.id);
    if (!doc) return reply.code(404).send({ error: "Not found" });
    return doc;
  });
}
