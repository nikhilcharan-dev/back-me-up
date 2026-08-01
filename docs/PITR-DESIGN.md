# PITR Design — Change-Stream Point-in-Time Recovery

This is the heart of `back-me-up`. It explains how we deliver **restore-to-any-second** on
Atlas tiers that give us **no oplog access**, and — just as importantly — the **limits and
risks** of doing so honestly.

## 1. Why change streams (not oplog)

True PITR needs a **base snapshot + a replayable, ordered change log**.

- On **dedicated** clusters (M10+) you can read `local.oplog.rs` directly and slice the
  oplog — that is what Percona Backup for MongoDB and Atlas's native PITR do.
- On **shared** clusters (M0/M2/M5) direct oplog reads and `mongodump --oplog` are
  **blocked**. The only ordered change feed exposed is **Change Streams** (`db.watch()`),
  which are themselves built on the oplog but surface a resumable, filtered event stream.

So our change log = **captured change-stream events**. Each event carries everything needed
to replay it: `operationType`, `documentKey._id`, `updateDescription`, `clusterTime`, and a
resumable `resumeToken` / `_id`.

## 2. The capture-before-dump invariant  ⚠️

The single most important rule. To guarantee **no gap** between "base captured" and
"change capture started":

```
1. Open the change stream.
2. Record its starting resume token  →  stored on the base_backups record.
3. THEN start mongodump for the base.
4. Changes that land during/after the dump are captured; replay overlaps the base
   harmlessly because every operation is applied idempotently (see §4).
```

Doing the dump first and *then* opening the stream leaves an uncovered window where writes
are lost forever. Capture-first, dump-second — always.

## 3. Change slices (the on-disk log format)

The capture worker buffers events and flushes them as **slices**:

```
{dbId}/changes/<fromClusterTs>--<toClusterTs>.ndjson.gz
```

- One slice = an ordered, gzipped NDJSON batch of normalized events.
- Flush trigger: every N events **or** every T seconds (whichever first) — bounds data at
  risk in worker memory and keeps slices small enough for selective replay.
- After a successful flush, the **last resume token is persisted** (catalog + Redis) so a
  crash resumes exactly where it left off.
- A `change_slices` catalog record indexes each slice by `(dbId, fromClusterTs, toClusterTs)`.

Normalized event shape stored per line:

```jsonc
{
  "ct":  { "t": 1720511530, "i": 3 },   // clusterTime (ts, increment) — the replay clock
  "ns":  "shop.orders",                  // namespace
  "op":  "insert|update|replace|delete", // operationType
  "k":   { "_id": "..." },               // documentKey
  "doc": { ... },                        // fullDocument (insert/replace) OR post-image
  "upd": { "set": {...}, "unset": [...] }// update deltas (update only)
}
```

## 4. Replay semantics (how a timestamp is reconstructed)

Given target time **T**:

1. Resolve **base B** = newest base backup with `captureStartTs ≤ T`.
2. `mongorestore` B into the target (empty) database.
3. Stream all slices where `toClusterTs > B.captureStartTs` and `fromClusterTs ≤ T`.
4. Apply events **in `clusterTime` order**, **skipping any event with `ct > T`**:
   - `insert` / `replace` → `replaceOne({_id}, doc, {upsert:true})`
   - `update` → `updateOne({_id}, { $set: upd.set, $unset: upd.unset })`
   - `delete` → `deleteOne({_id})`

Every operation is **idempotent and keyed by `_id`**, so replaying events that overlap the
base (writes during the dump) converges to the correct state. Ordering by `clusterTime`
plus the `ct ≤ T` cutoff is what makes it *point-in-time*.

## 5. Constraints & risks on shared tiers (M0–M5)  ⚠️ read this

These are inherent to the tier, not bugs. They shape SLAs and must be surfaced to users.

### 5.1 Base dumps are **not cross-collection consistent**
Without `--oplog`, `mongodump` gives per-collection point-in-time reads but **no single
global snapshot instant** across collections. **Mitigation:** the change-log replay closes
most of the gap — replaying to T reconciles collections to the same logical time. Residual
risk exists for writes racing the dump; the idempotent replay minimizes it. Document the
base as "consistency achieved *after* replay," not at dump instant.

### 5.2 Small oplog ⇒ **short capture-downtime tolerance**
Change-stream resume relies on the source oplog still containing the resume point. On
shared tiers the oplog is small and **not user-configurable**, so if a capture worker is
down longer than the oplog window (can be **minutes**, especially under write load), the
resume token **expires** → continuity break. **This is the top risk for near-zero RPO.**
Mitigations:
- Run capture workers **highly available** (fast auto-restart, health checks, supervised).
- On invalid-resume-token error: **do not silently reconnect from `now`** (that loses the
  gap). Mark a `continuityBreak`, **trigger an immediate base dump**, and alert. The new
  base re-establishes a clean recovery floor.

### 5.3 Concurrency / connection limits
Shared clusters cap concurrent connections (M0 ≈ 500) and impose limits on concurrent
change streams and ops/sec. **Design:** exactly **one** change-stream connection per
cluster (watch at cluster or db scope, not per-collection). Verify current limits against
Atlas docs before onboarding many DBs onto one M0.

### 5.4 Storage & throughput ceilings
M0 is ~512 MB and throttled. Continuous capture adds read load. Keep capture lightweight;
prefer db/cluster-scope watch with server-side filtering; monitor lag.

### 5.5 Update-replay edge cases (arrays)
`updateDescription.updatedFields` expresses results with dotted paths (e.g. `items.2.qty`).
Applying them as `$set`/`$unset` reconstructs scalar and nested-field changes faithfully,
but **array element removal/reordering** can leave holes or nulls in pathological cases.
Two mitigations, choose per correctness need:
- **Post-images (recommended where available):** enable `changeStreamPreAndPostImages` on
  hot collections (MongoDB 6.0+) and store the **post-image** as `doc`; replay becomes a
  clean `replaceOne` — exact, no array edge cases. Costs extra storage/IO.
- **Update-lookup fallback:** `fullDocument:'updateLookup'` fetches the *current* doc at
  capture time — simpler but reflects lookup-time state, not event-time, so it's weaker for
  rapid successive updates. Prefer post-images over this for correctness.

## 6. Correctness guarantees & non-goals

**Guaranteed:** restore to any T ≥ oldest retained base, reconstructing document state via
idempotent, time-ordered replay, into an isolated target you can verify before cutover.

**Not guaranteed on shared tiers:** transaction-boundary atomicity across collections at
the exact dump instant (mitigated by replay); recovery to a T older than retention; zero
RPO if a capture outage exceeds the oplog window (mitigated by re-baseline + alerting).

## 7. M10+ upgrade path

When a source is dedicated, the capture worker can switch to **oplog slicing** (read
`local.oplog.rs`, store idempotent oplog entries) and base dumps can use `--oplog` for a
**consistent** base. Replay then uses `mongorestore --oplogReplay --oplogLimit=T`. The
catalog and restore flow are unchanged — only the capture/replay backend swaps. This keeps
one system across both tiers.
