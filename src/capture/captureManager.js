import { CaptureWorker } from "./captureWorker.js";
import { runBaseBackup } from "../services/backupService.js";
import { listDatabases } from "../repositories/databasesRepo.js";
import { insertAuditEntry } from "../repositories/auditRepo.js";

const workers = new Map(); // dbId (string) -> CaptureWorker

export async function startCapture(dbId) {
  const key = String(dbId);
  if (workers.has(key)) return workers.get(key);

  const worker = new CaptureWorker(key, {
    onContinuityBreak: async (brokenDbId) => {
      console.error(`[capture-manager] re-baselining db ${brokenDbId} after continuity break`);
      workers.delete(brokenDbId);
      try {
        await runBaseBackup(brokenDbId, { allowWithoutCapture: true });
        await startCapture(brokenDbId);
        await insertAuditEntry({ actor: "system", action: "continuity-break-rebaseline", dbId: brokenDbId, detail: { ok: true } });
      } catch (err) {
        console.error(`[capture-manager] re-baseline for db ${brokenDbId} failed:`, err.message);
        await insertAuditEntry({
          actor: "system",
          action: "continuity-break-rebaseline",
          dbId: brokenDbId,
          detail: { ok: false, error: err.message },
        });
      }
    },
  });

  workers.set(key, worker);
  try {
    await worker.start();
  } catch (err) {
    workers.delete(key);
    throw err;
  }
  return worker;
}

export async function stopCapture(dbId) {
  const key = String(dbId);
  const worker = workers.get(key);
  if (!worker) return;
  workers.delete(key);
  await worker.stop();
}

export function isCaptureRunning(dbId) {
  return workers.has(String(dbId));
}

// Called at server startup so restarting the process resumes every PITR-enabled
// database's capture from its last persisted resume token — no manual step needed.
export async function startAllEnabledCaptures() {
  const dbs = await listDatabases();
  for (const dbRecord of dbs.filter((d) => d.pitrEnabled)) {
    try {
      await startCapture(dbRecord._id);
    } catch (err) {
      console.error(`[capture-manager] failed to start capture for ${dbRecord._id}:`, err.message);
    }
  }
}

export async function stopAllCaptures() {
  const ids = [...workers.keys()];
  for (const id of ids) {
    await stopCapture(id);
  }
}
