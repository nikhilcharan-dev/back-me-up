import {
  registerDatabase,
  listRegisteredDatabases,
  getRegisteredDatabase,
  toPublicDatabase,
  rotateConnectionUri,
  setTestRestoreTarget,
  softDeleteDatabase,
} from "../services/databaseService.js";
import { startCapture, stopCapture, isCaptureRunning } from "../capture/captureManager.js";
import {
  scheduleBaseBackups,
  unscheduleBaseBackups,
  scheduleTestRestores,
  unscheduleTestRestores,
} from "../scheduler/schedulerManager.js";
import { runScheduledTestRestore } from "../services/testRestoreService.js";
import { listTestRestoreRunsForDb } from "../repositories/testRestoresRepo.js";
import { pruneDatabase } from "../services/retentionService.js";
import { config } from "../config/env.js";

export default async function databaseRoutes(app) {
  // pitrEnabled defaults to true: near-zero RPO is the point of this service
  // (docs/README.md design targets), so continuous capture starts automatically
  // unless the caller opts out.
  app.post("/api/databases", async (request, reply) => {
    const {
      name,
      connectionUri,
      tier,
      scheduleCron,
      retention,
      pitrEnabled = true,
      testRestoreTargetUri,
      testRestoreCron,
    } = request.body ?? {};
    if (!name || !connectionUri) {
      return reply.code(400).send({ error: "name and connectionUri are required" });
    }
    try {
      const created = await registerDatabase({
        name,
        connectionUri,
        tier,
        scheduleCron,
        retention,
        pitrEnabled,
        testRestoreTargetUri,
        testRestoreCron,
      });
      if (pitrEnabled) {
        try {
          await startCapture(created._id);
        } catch (err) {
          request.log.error({ err: err.message, dbId: created._id }, "failed to auto-start capture");
        }
      }
      if (scheduleCron) {
        scheduleBaseBackups(created._id, scheduleCron);
      }
      if (testRestoreTargetUri) {
        scheduleTestRestores(created._id, testRestoreCron || config.testRestoreDefaultCron);
      }
      return reply.code(201).send(created);
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.get("/api/databases", async () => {
    return listRegisteredDatabases();
  });

  app.get("/api/databases/:id", async (request, reply) => {
    const doc = await getRegisteredDatabase(request.params.id);
    if (!doc) return reply.code(404).send({ error: "Not found" });
    return toPublicDatabase(doc);
  });

  // Soft delete: stops capture and all schedules, keeps existing backups/slices
  // recoverable (docs/DECISIONS.md).
  app.delete("/api/databases/:id", async (request) => {
    await stopCapture(request.params.id);
    unscheduleBaseBackups(request.params.id);
    unscheduleTestRestores(request.params.id);
    await softDeleteDatabase(request.params.id);
    return { status: "unregistered" };
  });

  app.post("/api/databases/:id/capture/start", async (request, reply) => {
    try {
      await startCapture(request.params.id);
      return { status: "running" };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.post("/api/databases/:id/capture/stop", async (request) => {
    await stopCapture(request.params.id);
    return { status: "stopped" };
  });

  app.get("/api/databases/:id/capture", async (request, reply) => {
    const doc = await getRegisteredDatabase(request.params.id);
    if (!doc) return reply.code(404).send({ error: "Not found" });
    return {
      captureStatus: doc.captureStatus,
      lastCaptureTs: doc.lastCaptureTs ?? null,
      running: isCaptureRunning(request.params.id),
    };
  });

  // Credential rotation: same cluster/database, new URI (e.g. rotated Atlas
  // user). Restarts capture with the new URI while preserving the resume
  // token, so continuity isn't broken (docs/OPERATIONS.md — security).
  app.post("/api/databases/:id/rotate-uri", async (request, reply) => {
    const { connectionUri } = request.body ?? {};
    if (!connectionUri) return reply.code(400).send({ error: "connectionUri is required" });
    try {
      const updated = await rotateConnectionUri(request.params.id, connectionUri);
      const wasRunning = isCaptureRunning(request.params.id);
      if (wasRunning) {
        await stopCapture(request.params.id);
        await startCapture(request.params.id);
      }
      return { ...toPublicDatabase(updated), captureRestarted: wasRunning };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.post("/api/databases/:id/test-restore-target", async (request, reply) => {
    const { targetUri, cron } = request.body ?? {};
    if (!targetUri) return reply.code(400).send({ error: "targetUri is required" });
    try {
      const updated = await setTestRestoreTarget(request.params.id, targetUri, cron ?? null);
      scheduleTestRestores(request.params.id, cron || config.testRestoreDefaultCron);
      return toPublicDatabase(updated);
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.post("/api/databases/:id/test-restores/run", async (request, reply) => {
    try {
      const result = await runScheduledTestRestore(request.params.id);
      return reply.code(201).send(result);
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.get("/api/databases/:id/test-restores", async (request) => {
    return listTestRestoreRunsForDb(request.params.id);
  });

  app.post("/api/databases/:id/retention/run", async (request, reply) => {
    try {
      const result = await pruneDatabase(request.params.id);
      return result;
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });
}
