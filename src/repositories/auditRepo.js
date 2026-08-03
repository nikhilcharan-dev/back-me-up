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

// Continuity breaks have no dedicated collection — captureWorker.js records them
// here (action: "continuity-break-rebaseline") and bumps the in-memory
// backmeup_continuity_break_total counter alongside it. The audit log is the
// durable half of that pair; the dashboard counts from here so a restart doesn't
// make past breaks vanish from the total.
export async function countAuditEntriesByAction(dbId, action) {
  const db = getCatalogDb();
  return db.collection(COLLECTION).countDocuments({ dbId: new ObjectId(dbId), action });
}
