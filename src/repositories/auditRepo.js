import { ObjectId } from "mongodb";
import { getCatalogDb } from "../lib/catalogDb.js";

const COLLECTION = "audit_log";

export async function insertAuditEntry({ actor = "system", action, dbId = null, detail = {}, at = new Date() }) {
  const db = getCatalogDb();
  const doc = { actor, action, dbId: dbId ? new ObjectId(dbId) : null, detail, at };
  const result = await db.collection(COLLECTION).insertOne(doc);
  return { _id: result.insertedId, ...doc };
}

export async function listAuditEntries({ dbId, limit = 100 } = {}) {
  const db = getCatalogDb();
  const filter = dbId ? { dbId: new ObjectId(dbId) } : {};
  return db.collection(COLLECTION).find(filter).sort({ at: -1 }).limit(limit).toArray();
}
