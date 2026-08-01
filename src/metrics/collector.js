import { listDatabases } from "../repositories/databasesRepo.js";
import { isCaptureRunning } from "../capture/captureManager.js";
import { captureLagSeconds, captureRunning, baseBackupAgeSeconds } from "./registry.js";
import { config } from "../config/env.js";

let interval;

// Some metrics (capture lag, base-backup age) reflect current catalog state
// rather than a discrete event, so they're refreshed on a timer instead of
// updated inline where they change.
export function startMetricsCollector() {
  interval = setInterval(() => {
    refresh().catch((err) => console.error("[metrics] refresh failed:", err.message));
  }, config.metricsIntervalMs);
  refresh().catch((err) => console.error("[metrics] refresh failed:", err.message));
}

export function stopMetricsCollector() {
  if (interval) clearInterval(interval);
  interval = null;
}

async function refresh() {
  const dbs = await listDatabases();
  const nowSec = Date.now() / 1000;

  for (const db of dbs) {
    const labels = { db_id: String(db._id), db_name: db.name };
    captureRunning.set(labels, isCaptureRunning(db._id) ? 1 : 0);
    if (db.lastCaptureTs) {
      captureLagSeconds.set(labels, Math.max(0, nowSec - db.lastCaptureTs.t));
    }
    if (db.lastBaseAt) {
      baseBackupAgeSeconds.set(labels, Math.max(0, (Date.now() - new Date(db.lastBaseAt).getTime()) / 1000));
    }
  }
}
