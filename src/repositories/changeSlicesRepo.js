import { ObjectId } from "mongodb";
import { getCatalogDb } from "../lib/catalogDb.js";

const COLLECTION = "change_slices";

export async function insertChangeSlice(doc) {
  const db = getCatalogDb();
  const result = await db.collection(COLLECTION).insertOne(doc);
  return { _id: result.insertedId, ...doc };
}

export async function listChangeSlicesForDb(dbId) {
  const db = getCatalogDb();
  return db
    .collection(COLLECTION)
    .find({ dbId: new ObjectId(dbId) })
    .sort({ "fromClusterTs.t": 1, "fromClusterTs.i": 1 })
    .toArray();
}

// Slices whose range could contain events relevant to replaying from floorSec
// up through ceilSec (inclusive) — the candidate set for a point-in-time restore.
// Event-level filtering against the exact cutoff still happens during replay.
export async function listChangeSlicesInRange(dbId, floorSec, ceilSec) {
  const db = getCatalogDb();
  return db
    .collection(COLLECTION)
    .find({
      dbId: new ObjectId(dbId),
      "toClusterTs.t": { $gte: floorSec },
      "fromClusterTs.t": { $lte: ceilSec },
    })
    .sort({ "fromClusterTs.t": 1, "fromClusterTs.i": 1 })
    .toArray();
}

export async function deleteChangeSlicesByIds(ids) {
  if (ids.length === 0) return;
  const db = getCatalogDb();
  await db.collection(COLLECTION).deleteMany({ _id: { $in: ids.map((id) => new ObjectId(id)) } });
}
