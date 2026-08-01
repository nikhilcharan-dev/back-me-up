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
