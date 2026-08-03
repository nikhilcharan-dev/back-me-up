import { ObjectId } from "mongodb";
import { getCatalogDb } from "../lib/catalogDb.js";

const COLLECTION = "restore_jobs";

export async function insertRestoreJob(doc) {
  const db = getCatalogDb();
  const result = await db.collection(COLLECTION).insertOne(doc);
  return { _id: result.insertedId, ...doc };
}

export async function updateRestoreJob(id, update) {
  const db = getCatalogDb();
  await db.collection(COLLECTION).updateOne({ _id: new ObjectId(id) }, { $set: update });
}

export async function findRestoreJobById(id) {
  const db = getCatalogDb();
  return db.collection(COLLECTION).findOne({ _id: new ObjectId(id) });
}

export async function listRestoreJobsForDb(dbId, limit = 20) {
  const db = getCatalogDb();
  return db
    .collection(COLLECTION)
    .find({ dbId: new ObjectId(dbId) })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
}

// Unbounded (unlike listRestoreJobsForDb's default 20) — dashboard totals need the
// real historical count, and need it to survive a restart, which the equivalent
// in-memory backmeup_restore_total Prometheus counter does not.
export async function countRestoreJobsByStatus(dbId) {
  const db = getCatalogDb();
  const rows = await db
    .collection(COLLECTION)
    .aggregate([{ $match: { dbId: new ObjectId(dbId) } }, { $group: { _id: "$status", count: { $sum: 1 } } }])
    .toArray();
  return Object.fromEntries(rows.map((r) => [r._id, r.count]));
}
