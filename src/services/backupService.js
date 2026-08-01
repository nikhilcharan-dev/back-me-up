import path from "node:path";
import fs from "node:fs/promises";
import { MongoClient } from "mongodb";
import { config } from "../config/env.js";
import { decrypt } from "../lib/crypto.js";
import { mongodump, sha256File, listCollectionFiles, collectionFilePath } from "../lib/mongoTools.js";
import { findDatabaseById, updateDatabase } from "../repositories/databasesRepo.js";
import { insertBaseBackup, updateBaseBackup } from "../repositories/backupsRepo.js";
import { insertAuditEntry } from "../repositories/auditRepo.js";
import { baseBackupTotal } from "../metrics/registry.js";

// Doc counts are collected via a direct query against the source right after the
// dump completes. On shared Atlas tiers there's no cross-collection-consistent
// snapshot instant (no --oplog), so this is a close approximation, not a strict
// guarantee — see docs/PITR-DESIGN.md §5.1. It's what restore verification checks against.
async function collectSourceDocCounts(connectionUri, dbName, collectionNames) {
  const client = new MongoClient(connectionUri, { serverSelectionTimeoutMS: 8000 });
  try {
    await client.connect();
    const sourceDb = client.db(dbName);
    const counts = {};
    for (const name of collectionNames) {
      counts[name] = await sourceDb.collection(name).countDocuments();
    }
    return counts;
  } finally {
    await client.close();
  }
}

// The capture-before-dump invariant (docs/PITR-DESIGN.md §2): for a PITR-enabled
// database, a base dump is only trustworthy for point-in-time replay if change
// capture is already running — otherwise there's an unrecorded gap. The one
// exception is re-baselining right after a continuity break, where capture is
// deliberately down at dump time and will be (re)started immediately after
// (see captureManager.js's onContinuityBreak) — that path passes
// allowWithoutCapture to bypass the guard.
export async function runBaseBackup(dbId, { allowWithoutCapture = false } = {}) {
  const dbRecord = await findDatabaseById(dbId);
  if (!dbRecord) throw new Error(`No registered database with id ${dbId}`);
  if (dbRecord.deletedAt) throw new Error(`Database ${dbId} has been unregistered`);

  if (dbRecord.pitrEnabled && !allowWithoutCapture && dbRecord.captureStatus !== "running") {
    throw new Error(
      `Change-stream capture is not running for this database (status: ${dbRecord.captureStatus}). ` +
        `Start capture first — a base backup taken without active capture cannot be used for point-in-time replay.`
    );
  }

  const connectionUri = decrypt(dbRecord.connectionUriEnc, config.masterKey);
  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const storageKey = path.posix.join(String(dbRecord._id), "base", stamp);
  const outDir = path.join(config.storageRoot, storageKey);

  const backupRecord = await insertBaseBackup({
    dbId: dbRecord._id,
    type: "base",
    startedAt,
    finishedAt: null,
    storageKey,
    dbName: dbRecord.dbName,
    sizeBytes: 0,
    collections: [],
    status: "running",
  });

  try {
    await mongodump({ uri: connectionUri, outDir });

    const dumpDbDir = path.join(outDir, dbRecord.dbName);
    const collectionNames = await listCollectionFiles(dumpDbDir);
    const docCounts = await collectSourceDocCounts(connectionUri, dbRecord.dbName, collectionNames);

    let sizeBytes = 0;
    const collections = [];
    for (const name of collectionNames) {
      const filePath = collectionFilePath(dumpDbDir, name);
      const stat = await fs.stat(filePath);
      const checksumSha256 = await sha256File(filePath);
      sizeBytes += stat.size;
      collections.push({ name, sizeBytes: stat.size, checksumSha256, docCount: docCounts[name] ?? null });
    }

    const manifest = {
      dbId: String(dbRecord._id),
      dbName: dbRecord.dbName,
      capturedAt: startedAt.toISOString(),
      collections,
    };
    await fs.writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

    const finishedAt = new Date();
    await updateBaseBackup(backupRecord._id, {
      finishedAt,
      sizeBytes,
      collections,
      status: "completed",
    });
    await updateDatabase(dbRecord._id, { lastBaseAt: finishedAt, updatedAt: new Date() });

    baseBackupTotal.inc({ db_id: String(dbRecord._id), status: "completed" });
    await insertAuditEntry({
      actor: "system",
      action: "base-backup",
      dbId: dbRecord._id,
      detail: { backupId: backupRecord._id, sizeBytes, collectionCount: collections.length },
    });

    return { ...backupRecord, finishedAt, sizeBytes, collections, status: "completed" };
  } catch (err) {
    await updateBaseBackup(backupRecord._id, { status: "failed", error: err.message, finishedAt: new Date() });
    baseBackupTotal.inc({ db_id: String(dbRecord._id), status: "failed" });
    throw err;
  }
}
