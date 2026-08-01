import { ObjectId } from "mongodb";
import { getCatalogDb } from "../lib/catalogDb.js";

const COLLECTION = "registered_databases";

export async function insertDatabase(doc) {
  const db = getCatalogDb();
  const result = await db.collection(COLLECTION).insertOne(doc);
  return { _id: result.insertedId, ...doc };
}

export async function findDatabaseById(id) {
  const db = getCatalogDb();
  return db.collection(COLLECTION).findOne({ _id: new ObjectId(id) });
}

// Soft-deleted databases (deletedAt set) are excluded everywhere: the public
// list, capture-startup resume, and scheduler-startup resume all go through
// this one query, so unregistering a database reliably stops all of its
// background activity without touching its existing backups/slices.
export async function listDatabases() {
  const db = getCatalogDb();
  return db
    .collection(COLLECTION)
    .find({ deletedAt: { $exists: false } })
    .sort({ createdAt: -1 })
    .toArray();
}

export async function updateDatabase(id, update) {
  const db = getCatalogDb();
  await db.collection(COLLECTION).updateOne({ _id: new ObjectId(id) }, { $set: update });
}
