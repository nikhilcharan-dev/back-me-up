import { ObjectId } from "mongodb";
import { getCatalogDb } from "../lib/catalogDb.js";

const COLLECTION = "users";

export async function insertUser(doc) {
  const db = getCatalogDb();
  const result = await db.collection(COLLECTION).insertOne(doc);
  return { _id: result.insertedId, ...doc };
}

export async function findUserByUsername(username) {
  const db = getCatalogDb();
  return db.collection(COLLECTION).findOne({ username });
}

export async function findUserById(id) {
  const db = getCatalogDb();
  return db.collection(COLLECTION).findOne({ _id: new ObjectId(id) });
}

export async function countUsers() {
  const db = getCatalogDb();
  return db.collection(COLLECTION).countDocuments();
}
