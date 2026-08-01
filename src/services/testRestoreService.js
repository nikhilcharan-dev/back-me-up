import { MongoClient } from "mongodb";
import { config } from "../config/env.js";
import { decrypt } from "../lib/crypto.js";
import { findDatabaseById } from "../repositories/databasesRepo.js";
import { runRestore } from "./restoreService.js";
import { insertTestRestoreRun } from "../repositories/testRestoresRepo.js";
import { insertAuditEntry } from "../repositories/auditRepo.js";
import { testRestoreTotal } from "../metrics/registry.js";

async function dropTarget(targetUri) {
  const client = new MongoClient(targetUri, { serverSelectionTimeoutMS: 8000 });
  try {
    await client.connect();
    await client.db().dropDatabase();
  } finally {
    await client.close();
  }
}

// "An untested backup is not a backup" (docs/OPERATIONS.md). Restores to right
// now — exercising the full base+replay pipeline, not just the last snapshot —
// into the configured scratch target, verifies, and records the outcome.
// Drops the target first so repeated runs never accumulate stale data from a
// prior run and produce a false failure.
export async function runScheduledTestRestore(dbId) {
  const dbRecord = await findDatabaseById(dbId);
  if (!dbRecord) throw new Error(`No registered database with id ${dbId}`);
  if (!dbRecord.testRestoreTargetUriEnc) {
    return { skipped: true, reason: "No test-restore target configured for this database" };
  }

  const targetUri = decrypt(dbRecord.testRestoreTargetUriEnc, config.masterKey);
  const ranAt = new Date();
  let restoreResult = null;
  let ok = false;
  let error = null;

  try {
    await dropTarget(targetUri);
    restoreResult = await runRestore({
      dbId,
      targetTimestamp: new Date().toISOString(),
      targetUri,
    });
    ok = restoreResult.status === "completed";
    if (!ok) error = "Restore completed but verification failed";
  } catch (err) {
    error = err.message;
  }

  const run = await insertTestRestoreRun({
    dbId: dbRecord._id,
    restoreJobId: restoreResult?._id ?? null,
    ranAt,
    ok,
    error,
  });

  testRestoreTotal.inc({ db_id: String(dbId), result: ok ? "ok" : "failed" });

  if (!ok) {
    console.error(`[ALERT] Scheduled test-restore failed for db ${dbId}: ${error}`);
  }

  await insertAuditEntry({
    actor: "system",
    action: "scheduled-test-restore",
    dbId: dbRecord._id,
    detail: { ok, error },
  });

  return run;
}
