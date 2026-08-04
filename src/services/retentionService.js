import {
  listBaseBackupsForDb,
  deleteBaseBackupRecord,
} from "../repositories/backupsRepo.js";
import { listChangeSlicesForDb, deleteChangeSlicesByIds } from "../repositories/changeSlicesRepo.js";
import { deleteStorageKey } from "../lib/storageCleanup.js";
import { findDatabaseById } from "../repositories/databasesRepo.js";
import { insertAuditEntry } from "../repositories/auditRepo.js";
import { validateRetention } from "./databaseService.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

// Each retention field is a max-age *window* expressed in its own unit, not a
// bucket count: hourly=24 means "keep everything finished in the last 24
// hours". A backup survives if it falls inside ANY of the three windows, so the
// union is just the longest one — a shorter field can never exclude what a
// longer field keeps. With {hourly:24, daily:30, weekly:4} the effective window
// is 30 days and the other two fields have no effect on the outcome.
export function effectiveWindowMs(retention) {
  if (!retention) return 0;
  return Math.max(
    (retention.hourly ?? 0) * HOUR_MS,
    (retention.daily ?? 0) * DAY_MS,
    (retention.weekly ?? 0) * WEEK_MS
  );
}

// Human-readable form of the above, surfaced in the UI so the "longest window
// wins" collapse is visible rather than something the user has to infer from
// three inputs that mostly do nothing.
export function describeWindow(ms) {
  if (!ms) return "unlimited";
  // Sub-2-day windows read better in hours ("24 hours", not "1 day") since
  // they almost always come from the hourly field.
  if (ms < 2 * DAY_MS) {
    const n = Math.round(ms / HOUR_MS);
    return `${n} hour${n === 1 ? "" : "s"}`;
  }
  if (ms % DAY_MS === 0) {
    const n = ms / DAY_MS;
    return `${n} day${n === 1 ? "" : "s"}`;
  }
  const n = Math.round(ms / HOUR_MS);
  return `${n} hour${n === 1 ? "" : "s"}`;
}

// Keep every completed backup inside the retention window; delete the rest.
// No per-bucket thinning — two backups a minute apart both survive as long as
// they're inside the window. Exported standalone so it's testable against a
// synthetic backup list without touching the catalog or storage.
export function computeRetentionKeepSet(backups, retention, now = new Date()) {
  const keep = new Set();
  const completed = backups.filter((b) => b.status === "completed" && b.finishedAt);
  if (completed.length === 0) return keep;

  // The single newest completed backup is always kept regardless of policy —
  // never prune down to zero recovery points. This is what stops a window
  // shorter than the gap since the last successful backup from wiping
  // everything. Picked by finishedAt rather than trusting the caller's sort,
  // which is by startedAt and can disagree when runs overlap.
  const newest = completed.reduce((a, b) => (b.finishedAt > a.finishedAt ? b : a));
  keep.add(String(newest._id));

  const windowMs = effectiveWindowMs(retention);
  if (windowMs === 0) return keep;

  const cutoff = now.getTime() - windowMs;
  for (const b of completed) {
    if (b.finishedAt.getTime() >= cutoff) keep.add(String(b._id));
  }

  return keep;
}

// Read-only counterpart to pruneDatabase(): same keep-set math, no
// deletes. Takes `retention` as a parameter (rather than reading the saved
// policy) so the UI can preview the impact of a policy the user is about to
// save, before it's persisted.
export async function previewPrune(dbId, retention) {
  if (!retention) {
    return { prunedBases: 0, prunedSlices: 0, keptBases: 0, totalBases: 0, windowLabel: "unlimited" };
  }

  const dbRecord = await findDatabaseById(dbId);
  if (!dbRecord) throw new Error(`No registered database with id ${dbId}`);

  const backups = await listBaseBackupsForDb(dbId);
  const keepSet = computeRetentionKeepSet(backups, retention);
  const completed = backups.filter((b) => b.status === "completed");
  const toDelete = completed.filter((b) => !keepSet.has(String(b._id)));

  let prunedSlices = 0;
  const retainedBackups = completed.filter((b) => keepSet.has(String(b._id)));
  if (retainedBackups.length > 0) {
    const oldestRetainedStart = retainedBackups.reduce(
      (min, b) => (b.startedAt < min ? b.startedAt : min),
      retainedBackups[0].startedAt
    );
    const floorSec = Math.floor(oldestRetainedStart.getTime() / 1000);
    const slices = await listChangeSlicesForDb(dbId);
    prunedSlices = slices.filter((s) => s.toClusterTs.t < floorSec).length;
  }

  return {
    prunedBases: toDelete.length,
    prunedSlices,
    keptBases: keepSet.size,
    totalBases: completed.length,
    windowLabel: describeWindow(effectiveWindowMs(retention)),
  };
}

// Deletes both the base_backups records/storage that fall outside the retention
// window, and any change slice that's now older than every retained base's
// dump window — never a slice a retained base could still need to replay
// through (docs/OPERATIONS.md — retention, slice-safety pruning).
export async function pruneDatabase(dbId) {
  const dbRecord = await findDatabaseById(dbId);
  if (!dbRecord) throw new Error(`No registered database with id ${dbId}`);

  // Re-validate the stored policy rather than trusting it as-is: records saved
  // before setRetentionPolicy() normalized all-zero input to null (a real bug —
  // {hourly:0,daily:0,weekly:0} is truthy, so it passed this guard and pruned
  // every backup but the single newest one, every time the cron ran) can still
  // have that literal object sitting in the catalog. This makes them self-heal
  // on the next prune instead of requiring everyone to notice and re-save.
  const retention = validateRetention(dbRecord.retention);
  if (!retention) {
    return { prunedBases: 0, prunedSlices: 0, message: "No retention policy set — nothing to prune" };
  }

  const backups = await listBaseBackupsForDb(dbId);
  const keepSet = computeRetentionKeepSet(backups, retention);

  const toDelete = backups.filter((b) => b.status === "completed" && !keepSet.has(String(b._id)));
  for (const b of toDelete) {
    await deleteStorageKey(b.storageKey);
    await deleteBaseBackupRecord(b._id);
  }

  const retainedBackups = backups.filter((b) => keepSet.has(String(b._id)));
  let prunedSlices = 0;
  if (retainedBackups.length > 0) {
    const oldestRetainedStart = retainedBackups.reduce(
      (min, b) => (b.startedAt < min ? b.startedAt : min),
      retainedBackups[0].startedAt
    );
    const floorSec = Math.floor(oldestRetainedStart.getTime() / 1000);
    const slices = await listChangeSlicesForDb(dbId);
    const staleSlices = slices.filter((s) => s.toClusterTs.t < floorSec);

    for (const s of staleSlices) {
      await deleteStorageKey(s.storageKey);
    }
    if (staleSlices.length > 0) {
      await deleteChangeSlicesByIds(staleSlices.map((s) => s._id));
      prunedSlices = staleSlices.length;
    }
  }

  await insertAuditEntry({
    actor: "system",
    action: "retention-prune",
    dbId: dbRecord._id,
    detail: { prunedBases: toDelete.length, prunedSlices, keptBases: keepSet.size },
  });

  return { prunedBases: toDelete.length, prunedSlices, keptBases: keepSet.size };
}
