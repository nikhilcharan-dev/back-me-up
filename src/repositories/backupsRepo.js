import { ObjectId } from "mongodb";
import { getCatalogDb } from "../lib/catalogDb.js";

const COLLECTION = "base_backups";

export async function insertBaseBackup(doc) {
  const db = getCatalogDb();
  const result = await db.collection(COLLECTION).insertOne(doc);
  return { _id: result.insertedId, ...doc };
}

export async function updateBaseBackup(id, update) {
  const db = getCatalogDb();
  await db.collection(COLLECTION).updateOne({ _id: new ObjectId(id) }, { $set: update });
}

export async function findBaseBackupById(id) {
  const db = getCatalogDb();
  return db.collection(COLLECTION).findOne({ _id: new ObjectId(id) });
}

export async function listBaseBackupsForDb(dbId) {
  const db = getCatalogDb();
  return db
    .collection(COLLECTION)
    .find({ dbId: new ObjectId(dbId) })
    .sort({ startedAt: -1 })
    .toArray();
}

// The base a point-in-time restore replays on top of: the newest completed base
// whose dump finished at or before the requested time.
export async function findNewestCompletedBaseBefore(dbId, cutoffDate) {
  const db = getCatalogDb();
  return db
    .collection(COLLECTION)
    .find({ dbId: new ObjectId(dbId), status: "completed", finishedAt: { $lte: cutoffDate } })
    .sort({ finishedAt: -1 })
    .limit(1)
    .next();
}

export async function deleteBaseBackupRecord(id) {
  const db = getCatalogDb();
  await db.collection(COLLECTION).deleteOne({ _id: new ObjectId(id) });
}
