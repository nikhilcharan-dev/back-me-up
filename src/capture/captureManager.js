import { CaptureWorker } from "./captureWorker.js";
import { config } from "../config/env.js";
import { runBaseBackup } from "../services/backupService.js";
import { findDatabaseById, listDatabases, updateDatabase } from "../repositories/databasesRepo.js";
import { insertAuditEntry } from "../repositories/auditRepo.js";

const workers = new Map(); // dbId (string) -> CaptureWorker

// Databases whose capture should be running: added by startCapture(), removed by
// stopCapture(). A capture that dies on its own while its dbId is in here is
// restarted; one that someone stopped is not.
const wanted = new Set();
// dbId -> { attempt, delayMs, nextAttemptAt, timer, upSince, reason } for captures
// waiting out a backoff before their next restart attempt.
const retries = new Map();

// Wait before restart attempt N (1-based): base * 2^(N-1), capped at max, shaved by
// up to 10% so many databases on one source don't all come back in the same instant.
function retryDelayMs(attempt) {
  const ceiling = Math.min(config.captureRetryMaxMs, config.captureRetryBaseMs * 2 ** (attempt - 1));
  return Math.round(ceiling * (1 - Math.random() * 0.1));
}

function describeDelay(ms) {
  return ms < 10000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

function cancelRetry(key) {
  const state = retries.get(key);
  if (state?.timer) clearTimeout(state.timer);
  retries.delete(key);
  return state;
}

// Creates the worker and starts it; throws if it can't be started. Shared by the
// explicit startCapture() and the automatic restarts.
async function spawn(key) {
  const worker = new CaptureWorker(key, {
    onContinuityBreak: async (brokenDbId) => {
      console.error(`[capture-manager] re-baselining db ${brokenDbId} after continuity break`);
      workers.delete(brokenDbId);
      try {
        await runBaseBackup(brokenDbId, { allowWithoutCapture: true });
        await startCapture(brokenDbId);
        await insertAuditEntry({ actor: "system", action: "continuity-break-rebaseline", dbId: brokenDbId, detail: { ok: true } });
      } catch (err) {
        // Deliberately not retried automatically: a re-baseline is a full dump, and
        // restarting capture without one would resume over a known gap in history.
        console.error(`[capture-manager] re-baseline for db ${brokenDbId} failed:`, err.message);
        await insertAuditEntry({
          actor: "system",
          action: "continuity-break-rebaseline",
          dbId: brokenDbId,
          detail: { ok: false, error: err.message },
        });
      }
    },
    // The worker stopped on its own (stream error, stream ended).
    onDied: (reason) => {
      if (workers.get(key) === worker) workers.delete(key);
      if (!wanted.has(key)) return;
      scheduleRetry(key, reason).catch((err) =>
        console.error(`[capture-manager] could not schedule a restart for ${key}:`, err.message)
      );
    },
  });

  workers.set(key, worker);
  try {
    await worker.start();
  } catch (err) {
    if (workers.get(key) === worker) workers.delete(key);
    throw err;
  }
  const state = retries.get(key);
  if (state) state.upSince = Date.now();
  return worker;
}

export async function startCapture(dbId) {
  const key = String(dbId);
  const existing = workers.get(key);
  if (existing) {
    // A worker whose change stream died on its own tears itself down but can stay
    // in this map until it is replaced — only an explicit stopCapture() or the
    // restart below removes it. Without this check, handing back that corpse makes
    // "start" a no-op: captureStatus reads "stopped" while the map insists capture
    // is running, and no new change stream ever opens.
    if (existing.isRunning()) return existing;
    workers.delete(key);
  }

  // An explicit start supersedes any automatic restart already waiting, and starts
  // the backoff ladder over.
  cancelRetry(key);
  wanted.add(key);
  try {
    return await spawn(key);
  } catch (err) {
    // The caller gets the error and decides; we don't keep retrying behind it.
    wanted.delete(key);
    throw err;
  }
}

export async function stopCapture(dbId) {
  const key = String(dbId);
  wanted.delete(key);
  const pending = cancelRetry(key);
  const worker = workers.get(key);
  if (!worker) {
    // Waiting out a backoff: there is no worker, but the record still promises an
    // automatic restart that will now never happen.
    if (pending) {
      await updateDatabase(key, {
        captureLastError: `${pending.reason}\n\nAutomatic restart cancelled.`,
        updatedAt: new Date(),
      }).catch(() => {});
    }
    return;
  }
  workers.delete(key);
  await worker.stop();
}

export function isCaptureRunning(dbId) {
  const worker = workers.get(String(dbId));
  return Boolean(worker && worker.isRunning());
}

// What the supervisor is doing about a stopped capture: null unless a restart is
// scheduled. attempt is the number of restarts scheduled since the ladder last reset.
export function getCaptureRetryState(dbId) {
  const state = retries.get(String(dbId));
  return state ? { attempt: state.attempt, delayMs: state.delayMs, nextAttemptAt: state.nextAttemptAt } : null;
}

// Waits out the next backoff step, then tries again. Every attempt that fails
// schedules the one after it with twice the wait (up to the cap), so a source that
// stays down is retried ever more gently and never given up on.
async function scheduleRetry(key, reason) {
  if (!wanted.has(key)) return;
  const state = retries.get(key) ?? { attempt: 0, delayMs: 0, nextAttemptAt: 0, timer: null, upSince: null, reason: "" };
  clearTimeout(state.timer);
  // It had been healthy for a while before this: a new problem, not the old one
  // continuing, so the ladder starts over.
  if (state.upSince && Date.now() - state.upSince >= config.captureRetryStableMs) state.attempt = 0;
  state.upSince = null;
  state.attempt += 1;
  state.delayMs = retryDelayMs(state.attempt);
  state.nextAttemptAt = Date.now() + state.delayMs;
  state.reason = reason;
  state.timer = setTimeout(() => {
    attemptRestart(key).catch((err) => console.error(`[capture-manager] restart attempt for ${key} crashed:`, err.message));
  }, state.delayMs);
  state.timer.unref?.(); // never keep the process alive just to retry
  retries.set(key, state);

  console.warn(
    `[capture-manager] capture for ${key} stopped; restart attempt ${state.attempt} in ${describeDelay(state.delayMs)}`
  );
  await updateDatabase(key, {
    captureStatus: "stopped",
    captureLastError: `${reason}\n\nRetrying automatically in ${describeDelay(state.delayMs)} (attempt ${state.attempt}).`,
    updatedAt: new Date(),
  }).catch((err) => console.error(`[capture-manager] could not record the retry for ${key}:`, err.message));
}

async function attemptRestart(key) {
  const state = retries.get(key);
  if (state) state.timer = null;
  if (!wanted.has(key)) return;

  let record;
  try {
    record = await findDatabaseById(key);
  } catch (err) {
    return scheduleRetry(key, `Could not read the catalog: ${err.message}`);
  }
  if (!wanted.has(key)) return; // stopped while the catalog was being read
  if (!record || record.deletedAt) {
    // Unregistered while we were waiting: nothing left to restart.
    wanted.delete(key);
    cancelRetry(key);
    return;
  }

  try {
    await spawn(key);
  } catch (err) {
    if (!wanted.has(key)) return; // stopped while it was starting
    return scheduleRetry(key, `Restart attempt failed: ${err.message}`);
  }
  console.log(`[capture-manager] capture for ${key} restarted on its own (attempt ${state?.attempt ?? 1})`);
  await insertAuditEntry({
    actor: "system",
    action: "capture-auto-restart",
    dbId: key,
    detail: { attempt: state?.attempt ?? 1 },
  }).catch(() => {});
}

// Called at server startup so restarting the process resumes every PITR-enabled
// database's capture from its last persisted resume token — no manual step needed.
// One that can't start right now (source briefly unreachable) is retried with the
// same backoff instead of staying dead until someone clicks "Start".
export async function startAllEnabledCaptures() {
  const dbs = await listDatabases();
  for (const dbRecord of dbs.filter((d) => d.pitrEnabled)) {
    const key = String(dbRecord._id);
    try {
      await startCapture(key);
    } catch (err) {
      console.error(`[capture-manager] failed to start capture for ${key}:`, err.message);
      wanted.add(key);
      await scheduleRetry(key, `Capture could not start: ${err.message}`);
    }
  }
}

export async function stopAllCaptures() {
  const ids = new Set([...workers.keys(), ...wanted]);
  for (const id of ids) {
    await stopCapture(id);
  }
}
