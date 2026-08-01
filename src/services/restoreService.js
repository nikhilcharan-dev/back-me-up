import path from "node:path";
import { MongoClient } from "mongodb";
import { config } from "../config/env.js";
import { extractDbName } from "../lib/mongoUri.js";
import { mongorestore } from "../lib/mongoTools.js";
import { findBaseBackupById, findNewestCompletedBaseBefore } from "../repositories/backupsRepo.js";
import { insertRestoreJob, updateRestoreJob } from "../repositories/restoresRepo.js";
import { insertAuditEntry } from "../repositories/auditRepo.js";
import { testConnection } from "./databaseService.js";
import { parseTargetTimestamp, selectSlicesForReplay, replaySlices } from "./replayService.js";
import { restoreTotal } from "../metrics/registry.js";

// Two ways to call this:
//  - { dbId, targetTimestamp, targetUri }: point-in-time restore. The newest
//    completed base at or before targetTimestamp is auto-selected, then change
//    slices are replayed on top of it up to the exact second requested.
//  - { baseBackupId, targetUri }: base-only restore, no replay (Phase 0 behavior,
//    still useful for a fast "just the last snapshot" recovery).
// Restores always target a NEW database — overwrite-source is a deliberately
// separate, guarded feature for a later phase (docs/OPERATIONS.md).
export async function runRestore({ dbId, baseBackupId, targetTimestamp, targetUri, mode = "new-target" }) {
  if (mode !== "new-target") {
    throw new Error(
      "Only mode='new-target' is supported right now. Restoring over an existing database is a guarded feature planned for a later phase."
    );
  }

  let baseBackup;
  let cutoff = null;

  if (targetTimestamp !== undefined && targetTimestamp !== null) {
    if (!dbId) throw new Error("dbId is required when restoring to a targetTimestamp");
    cutoff = parseTargetTimestamp(targetTimestamp);
    baseBackup = await findNewestCompletedBaseBefore(dbId, new Date(cutoff.t * 1000));
    if (!baseBackup) {
      throw new Error(
        `No completed base backup found at or before the requested time for database ${dbId}. ` +
          `The earliest recoverable point is bounded by retention — check GET /api/databases/${dbId}/backups.`
      );
    }
  } else if (baseBackupId) {
    baseBackup = await findBaseBackupById(baseBackupId);
    if (!baseBackup) throw new Error(`No base backup with id ${baseBackupId}`);
  } else {
    throw new Error(
      "Provide either targetTimestamp (with dbId) for a point-in-time restore, or baseBackupId for a base-only restore"
    );
  }

  if (baseBackup.status !== "completed") {
    throw new Error(`Base backup ${baseBackup._id} is not completed (status: ${baseBackup.status})`);
  }

  const targetDbName = extractDbName(targetUri);
  await testConnection(targetUri);

  const restoreJob = await insertRestoreJob({
    dbId: baseBackup.dbId,
    baseBackupId: baseBackup._id,
    targetTimestamp: cutoff ? new Date(cutoff.t * 1000) : baseBackup.finishedAt,
    mode,
    status: "restoring-base",
    log: [
      {
        at: new Date(),
        msg: cutoff
          ? `Restore started into database "${targetDbName}" (point-in-time replay to t=${cutoff.t})`
          : `Restore started into database "${targetDbName}" (base only)`,
      },
    ],
    createdAt: new Date(),
  });

  try {
    const dumpDbDir = path.join(config.storageRoot, baseBackup.storageKey, baseBackup.dbName);
    await mongorestore({ uri: targetUri, dumpDir: dumpDbDir, dbName: targetDbName });

    let replayStats = null;
    if (cutoff) {
      await updateRestoreJob(restoreJob._id, { status: "replaying" });
      const slices = await selectSlicesForReplay(baseBackup.dbId, baseBackup.startedAt, cutoff);
      replayStats = await replaySlices({ targetUri, slices, cutoff });
    }

    await updateRestoreJob(restoreJob._id, { status: "verifying" });
    const verification = await verifyRestore(targetUri, baseBackup, replayStats);

    const finalStatus = verification.ok ? "completed" : "failed";
    await updateRestoreJob(restoreJob._id, {
      status: finalStatus,
      replayStats,
      verification,
      finishedAt: new Date(),
    });

    restoreTotal.inc({ db_id: String(baseBackup.dbId), status: finalStatus });
    await insertAuditEntry({
      actor: "system",
      action: "restore",
      dbId: baseBackup.dbId,
      detail: { restoreJobId: restoreJob._id, targetDbName, mode: cutoff ? "point-in-time" : "base-only", ok: verification.ok },
    });

    return { ...restoreJob, status: finalStatus, replayStats, verification };
  } catch (err) {
    await updateRestoreJob(restoreJob._id, { status: "failed", error: err.message, finishedAt: new Date() });
    restoreTotal.inc({ db_id: String(baseBackup.dbId), status: "failed" });
    throw err;
  }
}

// The source can't be queried "as of T" — it only has current state — so we
// can't verify against a fresh source read. Instead, expected counts are
// derived from the base's recorded doc counts plus the net insert/delete delta
// tallied while replaying (replayService.js). This still catches real
// divergence: a stuck replay, a misapplied event, or a bug in delta tracking.
async function verifyRestore(targetUri, baseBackup, replayStats) {
  const client = new MongoClient(targetUri, { serverSelectionTimeoutMS: 8000 });
  try {
    await client.connect();
    const targetDb = client.db();
    const docCounts = {};
    const expectedDocCounts = {};
    let ok = true;

    const collNames = new Set(baseBackup.collections.map((c) => c.name));
    if (replayStats) {
      for (const name of Object.keys(replayStats.countDeltas)) collNames.add(name);
    }

    for (const name of collNames) {
      const base = baseBackup.collections.find((c) => c.name === name);
      const baseCount = base?.docCount ?? 0;
      const delta = replayStats?.countDeltas?.[name] ?? 0;
      const expected = baseCount + delta;

      const count = await targetDb.collection(name).countDocuments();
      docCounts[name] = count;
      expectedDocCounts[name] = expected;
      if (count !== expected) ok = false;
    }

    return { docCounts, expectedDocCounts, ok };
  } finally {
    await client.close();
  }
}
