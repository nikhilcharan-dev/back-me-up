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
  validateRetention,
  softDeleteDatabase,
  updateDatabaseSettings,
  DATABASE_TIERS,
} from "../../services/databaseService.js";
import { runBaseBackup } from "../../services/backupService.js";
import { runRestore } from "../../services/restoreService.js";
import { runScheduledTestRestore } from "../../services/testRestoreService.js";
import { pruneDatabase, previewPrune } from "../../services/retentionService.js";
import { startCapture, stopCapture, isCaptureRunning } from "../../capture/captureManager.js";
import {
  scheduleBaseBackups,
  unscheduleBaseBackups,
  scheduleTestRestores,
  unscheduleTestRestores,
} from "../../scheduler/schedulerManager.js";
import { SCHEDULE_PRESETS, WEEKDAYS, parseSchedule, describeCron, serverTimeZone } from "../schedulePresets.js";
import { listBaseBackupsForDb, listBaseBackupsForDbPage } from "../../repositories/backupsRepo.js";
import { listRestoreJobsForDb } from "../../repositories/restoresRepo.js";
import { listTestRestoreRunsForDb } from "../../repositories/testRestoresRepo.js";
import { config } from "../../config/env.js";

// Locals the shared schedule-field partial needs, on both the add and edit forms.
function scheduleFieldLocals(cronExpr) {
  return {
    presets: SCHEDULE_PRESETS,
    weekdays: WEEKDAYS,
    schedule: parseSchedule(cronExpr),
    serverTimeZone: serverTimeZone(),
  };
}

function parseTags(raw) {
  if (!raw) return [];
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

const BACKUPS_PAGE_SIZE = 15;

function normalizeBackupsPage(raw) {
  const page = Number(raw);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

async function loadDetail(request, reply, extra = {}) {
  const dbRecord = await getRegisteredDatabase(request.params.id);
  if (!dbRecord) return null;
  const db = toPublicDatabase(dbRecord);
  const backupsPage = normalizeBackupsPage(request.query.backupsPage);
  const [allBackups, backupsPageResult, restoreJobs, testRestoreRuns, retentionPreview] = await Promise.all([
    // Full history: the Restore card's "specific snapshot" dropdown and its
    // "earliest available" hint need every completed backup, not just
    // whichever page the Backups table happens to be showing.
    listBaseBackupsForDb(request.params.id),
    listBaseBackupsForDbPage(request.params.id, { page: backupsPage, pageSize: BACKUPS_PAGE_SIZE }),
    listRestoreJobsForDb(request.params.id),
    listTestRestoreRunsForDb(request.params.id),
    previewPrune(request.params.id, db.retention),
  ]);
  const backupsTotalPages = Math.max(1, Math.ceil(backupsPageResult.total / BACKUPS_PAGE_SIZE));
  return {
    ...(await baseViewContext(request, reply)),
    title: db.name,
    db,
    scheduleWords: describeCron(db.scheduleCron),
    allBackups,
    backups: backupsPageResult.items,
    backupsTotal: backupsPageResult.total,
    backupsPage: Math.min(backupsPage, backupsTotalPages),
    backupsTotalPages,
    restoreJobs,
    testRestoreRuns,
    captureRunning: isCaptureRunning(request.params.id),
    retentionPreview,
    ...extra,
  };
}

export default async function databaseWebRoutes(app) {
  app.get("/databases/new", { preHandler: requireAuth }, async (request, reply) => {
    return reply.view("database-new.ejs", {
      ...(await baseViewContext(request, reply)),
      title: "Add database",
      tiers: DATABASE_TIERS,
      ...scheduleFieldLocals(null),
    });
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
      // Schedule the normalized expression the record actually stored, not the raw
      // form value.
      if (created.scheduleCron) {
        scheduleBaseBackups(created._id, created.scheduleCron);
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

  app.get("/databases/:id/edit", { preHandler: requireAuth }, async (request, reply) => {
    const dbRecord = await getRegisteredDatabase(request.params.id);
    if (!dbRecord || dbRecord.deletedAt) {
      setFlash(request, "error", "Database not found.");
      return reply.redirect("/");
    }
    return reply.view("database-edit.ejs", {
      ...(await baseViewContext(request, reply)),
      title: `Edit ${dbRecord.name}`,
      db: toPublicDatabase(dbRecord),
      tiers: DATABASE_TIERS,
      ...scheduleFieldLocals(dbRecord.scheduleCron),
    });
  });

  app.post("/databases/:id/edit", { preHandler: [requireAuth, app.csrfProtection] }, async (request, reply) => {
    const body = request.body ?? {};
    const before = await getRegisteredDatabase(request.params.id);
    if (!before || before.deletedAt) {
      setFlash(request, "error", "Database not found.");
      return reply.redirect("/");
    }

    try {
      const updated = await updateDatabaseSettings(request.params.id, {
        name: body.name,
        tier: body.tier || "unknown",
        tags: parseTags(body.tags),
        scheduleCron: body.scheduleCron,
        pitrEnabled: body.pitrEnabled === "true",
      });

      // scheduleBaseBackups() replaces any existing job for this db, so applying
      // the saved value unconditionally keeps cron in sync with the record.
      if (updated.scheduleCron) {
        scheduleBaseBackups(request.params.id, updated.scheduleCron);
      } else {
        unscheduleBaseBackups(request.params.id);
      }

      // Only react to an actual change, so saving unrelated edits never disturbs
      // a running capture (and its resume token).
      let flashType = "success";
      let captureNote = "";
      if (updated.pitrEnabled !== before.pitrEnabled) {
        if (updated.pitrEnabled) {
          try {
            await startCapture(request.params.id);
            captureNote = ". Continuous capture started.";
          } catch (err) {
            flashType = "error";
            captureNote = ` — but continuous capture could not start: ${err.message}`;
          }
        } else {
          await stopCapture(request.params.id);
          captureNote = ". Continuous capture stopped.";
        }
      }

      setFlash(request, flashType, `Saved changes to "${updated.name}"${captureNote || "."}`);
      return reply.redirect(`/databases/${request.params.id}`);
    } catch (err) {
      setFlash(request, "error", err.message);
      return reply.redirect(`/databases/${request.params.id}/edit`);
    }
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
    try {
      await setRetentionPolicy(request.params.id, { hourly, daily, weekly });
      setFlash(request, "success", "Retention policy saved.");
    } catch (err) {
      setFlash(request, "error", err.message);
    }
    return reply.redirect(`/databases/${request.params.id}`);
  });

  // AJAX-only: lets the retention form show "N backup(s), M slice(s) would be
  // removed" for whatever the user has typed *before* they save it, using the
  // same CSRF token already embedded in the page's forms.
  app.post(
    "/databases/:id/retention/preview",
    { preHandler: [requireAuth, app.csrfProtection] },
    async (request, reply) => {
      const { hourly, daily, weekly } = request.body ?? {};
      try {
        const retention = validateRetention({ hourly, daily, weekly });
        const result = await previewPrune(request.params.id, retention);
        return result;
      } catch (err) {
        return reply.code(400).send({ error: err.message });
      }
    }
  );

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
