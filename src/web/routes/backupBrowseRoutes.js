import { createReadStream } from "node:fs";
import { requireAuth } from "../auth.js";
import { baseViewContext } from "../viewContext.js";
import { setFlash } from "../flash.js";
import {
  openBackup,
  openCollection,
  readCollectionPage,
  createJsonExportStream,
  collectionFileSize,
  exportFileName,
  normalizePage,
  normalizePageSize,
  PAGE_SIZE_OPTIONS,
} from "../../services/backupBrowseService.js";

export default async function backupBrowseRoutes(app) {
  // Collections inside one backup snapshot.
  app.get("/backups/:id", { preHandler: requireAuth }, async (request, reply) => {
    const opened = await openBackup(request.params.id);
    if (!opened) {
      setFlash(request, "error", "Backup not found.");
      return reply.redirect("/");
    }

    return reply.view("backup-detail.ejs", {
      ...(await baseViewContext(request, reply)),
      title: `Backup · ${opened.backup.dbName}`,
      backup: opened.backup,
      collections: opened.collections,
      filesMissing: opened.filesMissing,
    });
  });

  // Documents inside one collection of that snapshot.
  app.get("/backups/:id/collections/:name", { preHandler: requireAuth }, async (request, reply) => {
    const opened = await openCollection(request.params.id, request.params.name);
    if (!opened) {
      setFlash(request, "error", "That collection is not in this backup, or its files are missing on disk.");
      return reply.redirect(`/backups/${request.params.id}`);
    }

    const q = (request.query.q ?? "").toString();
    const page = normalizePage(request.query.page);
    const pageSize = normalizePageSize(request.query.size);

    let result;
    try {
      result = await readCollectionPage({ filePath: opened.filePath, q, page, pageSize });
    } catch (err) {
      request.log.error({ err: err.message }, "failed to read dumped collection");
      setFlash(request, "error", `Could not read this collection's dump: ${err.message}`);
      return reply.redirect(`/backups/${request.params.id}`);
    }

    return reply.view("backup-collection.ejs", {
      ...(await baseViewContext(request, reply)),
      title: `${opened.collection.name} · backup`,
      backup: opened.backup,
      collection: opened.collection,
      fileSizeBytes: await collectionFileSize(opened.filePath),
      q,
      pageSizeOptions: PAGE_SIZE_OPTIONS,
      ...result,
    });
  });

  // Export one collection: JSON (what the browser shows, optionally filtered by the
  // same search) or the raw mongodump .bson.gz (byte-exact, mongorestore-ready).
  app.get("/backups/:id/collections/:name/download", { preHandler: requireAuth }, async (request, reply) => {
    const opened = await openCollection(request.params.id, request.params.name);
    if (!opened) {
      setFlash(request, "error", "That collection is not in this backup, or its files are missing on disk.");
      return reply.redirect(`/backups/${request.params.id}`);
    }

    const { backup, collection, filePath } = opened;
    const format = request.query.format === "bson" ? "bson" : "json";

    if (format === "bson") {
      reply.header("Content-Type", "application/gzip");
      reply.header(
        "Content-Disposition",
        `attachment; filename="${exportFileName(backup, collection.name, "bson.gz")}"`
      );
      return reply.send(createReadStream(filePath));
    }

    const q = (request.query.q ?? "").toString();
    reply.header("Content-Type", "application/json; charset=utf-8");
    reply.header(
      "Content-Disposition",
      `attachment; filename="${exportFileName(backup, collection.name, "json")}"`
    );
    return reply.send(createJsonExportStream({ filePath, q }));
  });
}
