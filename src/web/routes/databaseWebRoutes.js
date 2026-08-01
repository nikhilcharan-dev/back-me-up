import { requireAuth } from "../auth.js";
import { baseViewContext } from "../viewContext.js";
import { setFlash } from "../flash.js";
import {
  registerDatabase,
  getRegisteredDatabase,
  toPublicDatabase,
  rotateConnectionUri,
  setTestRestoreTarget,
  setRetentionPolicy,
  softDeleteDatabase,
} from "../../services/databaseService.js";
import { runBaseBackup } from "../../services/backupService.js";
import { runRestore } from "../../services/restoreService.js";
import { runScheduledTestRestore } from "../../services/testRestoreService.js";
import { pruneDatabase } from "../../services/retentionService.js";
import { startCapture, stopCapture, isCaptureRunning } from "../../capture/captureManager.js";
import {
  scheduleBaseBackups,
  unscheduleBaseBackups,
  scheduleTestRestores,
  unscheduleTestRestores,
} from "../../scheduler/schedulerManager.js";
import { listBaseBackupsForDb } from "../../repositories/backupsRepo.js";
import { listRestoreJobsForDb } from "../../repositories/restoresRepo.js";
import { listTestRestoreRunsForDb } from "../../repositories/testRestoresRepo.js";
import { config } from "../../config/env.js";

function parseTags(raw) {
  if (!raw) return [];
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

async function loadDetail(request, reply, extra = {}) {
  const dbRecord = await getRegisteredDatabase(request.params.id);
  if (!dbRecord) return null;
  const db = toPublicDatabase(dbRecord);
  const [backups, restoreJobs, testRestoreRuns] = await Promise.all([
    listBaseBackupsForDb(request.params.id),
    listRestoreJobsForDb(request.params.id),
    listTestRestoreRunsForDb(request.params.id),
  ]);
  return {
    ...(await baseViewContext(request, reply)),
    title: db.name,
    db,
    backups,
    restoreJobs,
    testRestoreRuns,
    captureRunning: isCaptureRunning(request.params.id),
    ...extra,
  };
}

export default async function databaseWebRoutes(app) {
  app.get("/databases/new", { preHandler: requireAuth }, async (request, reply) => {
    return reply.view("database-new.ejs", { ...(await baseViewContext(request, reply)), title: "Add database" });
  });

  app.post("/databases", { preHandler: [requireAuth, app.csrfProtection] }, async (request, reply) => {
    const body = request.body ?? {};
    try {
      const created = await registerDatabase({
        name: body.name,
        connectionUri: body.connectionUri,
        tier: body.tier || "unknown",
        tags: parseTags(body.tags),
        scheduleCron: body.scheduleCron || null,
        pitrEnabled: body.pitrEnabled === "true",
      });
      if (body.pitrEnabled === "true") {
        try {
          await startCapture(created._id);
        } catch (err) {
          request.log.error({ err: err.message }, "failed to auto-start capture");
        }
      }
      if (body.scheduleCron) {
        scheduleBaseBackups(created._id, body.scheduleCron);
      }
      setFlash(request, "success", `Database "${created.name}" registered.`);
      return reply.redirect(`/databases/${created._id}`);
    } catch (err) {
      setFlash(request, "error", err.message);
      return reply.redirect("/databases/new");
    }
  });

  app.get("/databases/:id", { preHandler: requireAuth }, async (request, reply) => {
    const view = await loadDetail(request, reply);
    if (!view) {
      setFlash(request, "error", "Database not found.");
      return reply.redirect("/");
    }
    return reply.view("database-detail.ejs", view);
  });

  app.post(
    "/databases/:id/capture/start",
    { preHandler: [requireAuth, app.csrfProtection] },
    async (request, reply) => {
      try {
        await startCapture(request.params.id);
        setFlash(request, "success", "Capture started.");
      } catch (err) {
        setFlash(request, "error", err.message);
      }
      return reply.redirect(`/databases/${request.params.id}`);
    }
  );

  app.post(
    "/databases/:id/capture/stop",
    { preHandler: [requireAuth, app.csrfProtection] },
    async (request, reply) => {
      await stopCapture(request.params.id);
      setFlash(request, "success", "Capture stopped.");
      return reply.redirect(`/databases/${request.params.id}`);
    }
  );

  app.post("/databases/:id/backups", { preHandler: [requireAuth, app.csrfProtection] }, async (request, reply) => {
    try {
      await runBaseBackup(request.params.id);
      setFlash(request, "success", "Backup completed.");
    } catch (err) {
      setFlash(request, "error", err.message);
    }
    return reply.redirect(`/databases/${request.params.id}`);
  });

  app.post("/databases/:id/retention", { preHandler: [requireAuth, app.csrfProtection] }, async (request, reply) => {
    const { hourly, daily, weekly } = request.body ?? {};
    const toNum = (v) => (v && Number(v) > 0 ? Number(v) : 0);
    try {
      await setRetentionPolicy(request.params.id, { hourly: toNum(hourly), daily: toNum(daily), weekly: toNum(weekly) });
      setFlash(request, "success", "Retention policy saved.");
    } catch (err) {
      setFlash(request, "error", err.message);
    }
    return reply.redirect(`/databases/${request.params.id}`);
  });

  app.post(
    "/databases/:id/retention/run",
    { preHandler: [requireAuth, app.csrfProtection] },
    async (request, reply) => {
      try {
        const result = await pruneDatabase(request.params.id);
        setFlash(request, "success", `Pruned ${result.prunedBases} backup(s), ${result.prunedSlices} slice(s).`);
      } catch (err) {
        setFlash(request, "error", err.message);
      }
      return reply.redirect(`/databases/${request.params.id}`);
    }
  );

  app.post("/databases/:id/rotate-uri", { preHandler: [requireAuth, app.csrfProtection] }, async (request, reply) => {
    const { connectionUri } = request.body ?? {};
    try {
      await rotateConnectionUri(request.params.id, connectionUri);
      const wasRunning = isCaptureRunning(request.params.id);
      if (wasRunning) {
        await stopCapture(request.params.id);
        await startCapture(request.params.id);
      }
      setFlash(request, "success", "Connection URL rotated.");
    } catch (err) {
      setFlash(request, "error", err.message);
    }
    return reply.redirect(`/databases/${request.params.id}`);
  });

  app.post(
    "/databases/:id/test-restore-target",
    { preHandler: [requireAuth, app.csrfProtection] },
    async (request, reply) => {
      const { targetUri, cron } = request.body ?? {};
      try {
        await setTestRestoreTarget(request.params.id, targetUri, cron || null);
        scheduleTestRestores(request.params.id, cron || config.testRestoreDefaultCron);
        setFlash(request, "success", "Test-restore target saved.");
      } catch (err) {
        setFlash(request, "error", err.message);
      }
      return reply.redirect(`/databases/${request.params.id}`);
    }
  );

  app.post(
    "/databases/:id/test-restores/run",
    { preHandler: [requireAuth, app.csrfProtection] },
    async (request, reply) => {
      try {
        const result = await runScheduledTestRestore(request.params.id);
        setFlash(request, result.ok ? "success" : "error", result.ok ? "Test-restore passed." : `Test-restore failed: ${result.error}`);
      } catch (err) {
        setFlash(request, "error", err.message);
      }
      return reply.redirect(`/databases/${request.params.id}`);
    }
  );

  app.post("/databases/:id/restore", { preHandler: [requireAuth, app.csrfProtection] }, async (request, reply) => {
    const { mode, targetTimestamp, baseBackupId, targetUri } = request.body ?? {};
    try {
      const params = { targetUri };
      if (mode === "base") {
        params.baseBackupId = baseBackupId;
      } else {
        params.dbId = request.params.id;
        params.targetTimestamp = targetTimestamp;
      }
      const job = await runRestore(params);
      return reply.redirect(`/restores/${job._id}`);
    } catch (err) {
      setFlash(request, "error", err.message);
      return reply.redirect(`/databases/${request.params.id}`);
    }
  });

  app.post("/databases/:id/delete", { preHandler: [requireAuth, app.csrfProtection] }, async (request, reply) => {
    await stopCapture(request.params.id);
    unscheduleBaseBackups(request.params.id);
    unscheduleTestRestores(request.params.id);
    await softDeleteDatabase(request.params.id);
    setFlash(request, "success", "Database unregistered. Existing backups remain available.");
    return reply.redirect("/");
  });
}
