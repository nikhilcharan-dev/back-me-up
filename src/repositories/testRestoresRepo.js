import { ObjectId } from "mongodb";
import { getCatalogDb } from "../lib/catalogDb.js";

const COLLECTION = "test_restore_runs";

export async function insertTestRestoreRun(doc) {
  const db = getCatalogDb();
  const result = await db.collection(COLLECTION).insertOne(doc);
  return { _id: result.insertedId, ...doc };
}

export async function listTestRestoreRunsForDb(dbId) {
  const db = getCatalogDb();
  return db
    .collection(COLLECTION)
    .find({ dbId: new ObjectId(dbId) })
    .sort({ ranAt: -1 })
    .toArray();
}

// Dashboard totals need the real historical count and need it to survive a
// restart, which the equivalent in-memory backmeup_test_restore_total Prometheus
// counter does not.
export async function countTestRestoreRunsByResult(dbId) {
  const db = getCatalogDb();
  const rows = await db
    .collection(COLLECTION)
    .aggregate([{ $match: { dbId: new ObjectId(dbId) } }, { $group: { _id: "$ok", count: { $sum: 1 } } }])
    .toArray();
  const out = { ok: 0, failed: 0 };
  for (const row of rows) {
    if (row._id === true) out.ok = row.count;
    else out.failed = row.count;
  }
  return out;
}
