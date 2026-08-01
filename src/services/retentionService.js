import {
  listBaseBackupsForDb,
  deleteBaseBackupRecord,
} from "../repositories/backupsRepo.js";
import { listChangeSlicesForDb, deleteChangeSlicesByIds } from "../repositories/changeSlicesRepo.js";
import { deleteStorageKey } from "../lib/storageCleanup.js";
import { findDatabaseById } from "../repositories/databasesRepo.js";
import { insertAuditEntry } from "../repositories/auditRepo.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

function bucketKey(date, unitMs) {
  return Math.floor(date.getTime() / unitMs);
}

// Grandfather-father-son: keep the newest backup per hour/day/week bucket,
// within each policy's lookback window. The single newest completed backup is
// always kept regardless of policy — never prune down to zero recovery points.
// Exported standalone so it's testable against a synthetic backup list without
// touching the catalog or storage.
export function computeGfsKeepSet(backups, retention, now = new Date()) {
  const keep = new Set();
  const completed = backups.filter((b) => b.status === "completed" && b.finishedAt);
  if (completed.length === 0) return keep;

  keep.add(String(completed[0]._id));

  function keepNewestPerBucket(unitMs, count) {
    if (!count) return;
    const cutoff = now.getTime() - count * unitMs;
    const seenBuckets = new Set();
    for (const b of completed) {
      if (b.finishedAt.getTime() < cutoff) continue;
      const bucket = bucketKey(b.finishedAt, unitMs);
      if (!seenBuckets.has(bucket)) {
        seenBuckets.add(bucket);
        keep.add(String(b._id));
      }
    }
  }

  keepNewestPerBucket(HOUR_MS, retention?.hourly ?? 0);
  keepNewestPerBucket(DAY_MS, retention?.daily ?? 0);
  keepNewestPerBucket(WEEK_MS, retention?.weekly ?? 0);

  return keep;
}

// Deletes both the base_backups records/storage that fall outside the GFS
// keep-set, and any change slice that's now older than every retained base's
// dump window — never a slice a retained base could still need to replay
// through (docs/OPERATIONS.md — retention, slice-safety pruning).
export async function pruneDatabase(dbId) {
  const dbRecord = await findDatabaseById(dbId);
  if (!dbRecord) throw new Error(`No registered database with id ${dbId}`);
  if (!dbRecord.retention) {
    return { prunedBases: 0, prunedSlices: 0, message: "No retention policy set — nothing to prune" };
  }

  const backups = await listBaseBackupsForDb(dbId);
  const keepSet = computeGfsKeepSet(backups, dbRecord.retention);

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
