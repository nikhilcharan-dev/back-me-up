import { MongoClient } from "mongodb";
import { readSlice } from "../capture/sliceWriter.js";
import { listChangeSlicesInRange } from "../repositories/changeSlicesRepo.js";
import { compareClusterTime } from "../lib/clusterTime.js";

// Accepts either an ISO8601 string / epoch millis (wall-clock precision — the
// cutoff includes the entire second) or an explicit {t,i} clusterTime for exact
// precision. clusterTime.t is server wall-clock seconds (confirmed live against
// a real change stream), so the two are directly comparable.
export function parseTargetTimestamp(input) {
  if (input && typeof input === "object" && typeof input.t === "number") {
    return { t: input.t, i: typeof input.i === "number" ? input.i : Number.MAX_SAFE_INTEGER };
  }
  const ms = typeof input === "number" ? input : Date.parse(input);
  if (Number.isNaN(ms)) throw new Error(`Invalid targetTimestamp: ${input}`);
  return { t: Math.floor(ms / 1000), i: Number.MAX_SAFE_INTEGER };
}

function collectionNameFromNs(ns) {
  return ns.slice(ns.indexOf(".") + 1);
}

// floorDate = the base backup's startedAt, not finishedAt: dumps aren't
// cross-collection consistent (docs/PITR-DESIGN.md §5.1), so replay must cover
// writes that landed during the dump window too — idempotent apply makes
// re-applying anything already reflected in the base harmless.
export async function selectSlicesForReplay(dbId, floorDate, cutoff) {
  const floorSec = Math.floor(floorDate.getTime() / 1000);
  return listChangeSlicesInRange(dbId, floorSec, cutoff.t);
}

// Replays slices in order onto the target, stopping at `cutoff`. Every
// operation is idempotent and keyed by _id (docs/PITR-DESIGN.md §4), so
// overlap with the base or repeated replay converges to the same state.
// Tracks per-collection doc-count deltas as it goes — that's what restoreService
// uses to verify the restore, since the source can't be queried "as of T".
export async function replaySlices({ targetUri, slices, cutoff }) {
  const client = new MongoClient(targetUri, { serverSelectionTimeoutMS: 8000 });
  const stats = { eventsApplied: 0, eventsSkippedPastCutoff: 0, slicesUsed: slices.length, countDeltas: {} };
  try {
    await client.connect();
    const targetDb = client.db();

    for (const slice of slices) {
      const events = await readSlice(slice.storageKey);
      for (const event of events) {
        if (compareClusterTime(event.ct, cutoff) > 0) {
          stats.eventsSkippedPastCutoff += 1;
          continue;
        }
        await applyEvent(targetDb, event, stats);
        stats.eventsApplied += 1;
      }
    }
  } finally {
    await client.close();
  }
  return stats;
}

async function applyEvent(targetDb, event, stats) {
  const collName = collectionNameFromNs(event.ns);
  const coll = targetDb.collection(collName);
  const filter = event.k;

  switch (event.op) {
    case "insert":
    case "replace":
      await coll.replaceOne(filter, event.doc, { upsert: true });
      if (event.op === "insert") {
        stats.countDeltas[collName] = (stats.countDeltas[collName] ?? 0) + 1;
      }
      break;
    case "update": {
      const updateOp = {};
      if (event.upd?.set && Object.keys(event.upd.set).length > 0) {
        updateOp.$set = event.upd.set;
      }
      if (event.upd?.unset && event.upd.unset.length > 0) {
        updateOp.$unset = Object.fromEntries(event.upd.unset.map((field) => [field, ""]));
      }
      if (Object.keys(updateOp).length > 0) {
        // upsert:true is a defensive safety net, not the expected path — the
        // insert that created this document should already have been applied
        // (or the doc came from the base dump) before its first update.
        await coll.updateOne(filter, updateOp, { upsert: true });
      }
      break;
    }
    case "delete":
      await coll.deleteOne(filter);
      stats.countDeltas[collName] = (stats.countDeltas[collName] ?? 0) - 1;
      break;
    default:
      // drop/rename/dropDatabase/invalidate and similar admin events are out of
      // scope for this baseline replay — document-level ops only.
      break;
  }
}
