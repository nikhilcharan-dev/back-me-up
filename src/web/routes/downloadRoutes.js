import path from "node:path";
import fs from "node:fs/promises";
import * as tar from "tar";
import { config } from "../../config/env.js";
import { requireAuth } from "../auth.js";
import { setFlash } from "../flash.js";
import { findBaseBackupById } from "../../repositories/backupsRepo.js";

export default async function downloadRoutes(app) {
  app.get("/backups/:id/download", { preHandler: requireAuth }, async (request, reply) => {
    const backup = await findBaseBackupById(request.params.id);
    if (!backup || backup.status !== "completed") {
      setFlash(request, "error", "Backup not found or not completed.");
      return reply.redirect("/");
    }

    const dumpDir = path.join(config.storageRoot, backup.storageKey);
    try {
      await fs.access(dumpDir);
    } catch {
      setFlash(request, "error", "Backup files are missing on disk (possibly pruned by retention).");
      return reply.redirect("/");
    }

    const filename = `${backup.dbName}-${backup._id}.tar.gz`;
    reply.header("Content-Type", "application/gzip");
    reply.header("Content-Disposition", `attachment; filename="${filename}"`);
    return reply.send(tar.create({ gzip: true, cwd: dumpDir }, ["."]));
  });
}
