# Key Decisions (ADR-style)

Short records of the choices that shape the system and why. Reverse them only with reason.

## D1 — Change streams as the PITR log (not oplog tailing)
**Context:** Target sources are Atlas **M0–M5**, where direct oplog reads and
`mongodump --oplog` are blocked.
**Decision:** Build the replayable change log from **Change Streams**.
**Consequences:** Works on every tier; but base dumps aren't cross-collection consistent at
the dump instant, and resume depends on a small, non-configurable oplog window (see
PITR-DESIGN §5). M10+ can swap in oplog slicing behind the same API (§7).

## D2 — Capture-before-dump ordering is invariant
**Decision:** Open the change stream and record its resume token **before** starting each
base dump.
**Why:** Any other order leaves an uncovered write window = permanent data loss. Idempotent
replay makes the overlap harmless. Non-negotiable.

## D3 — Reuse `mongodump`/`mongorestore`, don't reinvent
**Decision:** Base backup/restore uses `mongodb-database-tools`, baked into the image.
**Why:** Battle-tested, handles BSON types/indexes/gzip; reimplementing is pure risk. We add
value in orchestration, capture, catalog, and PITR replay — not in re-writing dump.

## D4 — Restore into a NEW target by default
**Decision:** Restores target a fresh DB/cluster; overwrite-source is opt-in + guarded +
pre-snapshotted.
**Why:** Restoring over a live database is destructive and irreversible; the default must be
safe.

## D5 — One capture connection per source cluster
**Decision:** Watch at cluster/db scope with a Redis single-owner lock; never one stream per
collection.
**Why:** Shared tiers cap connections and concurrent change streams; per-collection streams
would exhaust limits and add load.

## D6 — Order and cut by `clusterTime`, never wall-clock
**Decision:** All replay ordering and the `≤ T` restore cutoff use MongoDB `clusterTime`.
**Why:** It's the server's monotonic event order; ingestion/wall-clock time can reorder and
would corrupt point-in-time correctness.

## D7 — Continuity break ⇒ re-baseline, never silent reconnect-from-now
**Decision:** On an expired/invalid resume token, mark `continuity_break`, trigger an
immediate base dump, and alert — do **not** quietly resume from the current time.
**Why:** Silent reconnect hides a gap and gives false confidence in recoverability.

## D8 — Post-images for correctness-critical collections (when available)
**Decision:** Prefer enabling `changeStreamPreAndPostImages` (Mongo 6.0+) and storing
post-images (clean `replaceOne` replay) over `updateLookup`.
**Why:** Field-delta replay has array edge cases; update-lookup reflects lookup-time, not
event-time. Post-images are exact. Trade extra storage for correctness where it matters.

## D9 — Encrypt connection URIs at rest
**Decision:** AES-256-GCM with a key from a secret manager/KMS; support rotation.
**Why:** URIs carry database credentials; the catalog must never store them in plaintext.

## D10 — Metadata catalog is service-owned, external to customer clusters
**Decision:** Keep the catalog (and encrypted URIs) in the service's own DB.
**Why:** A backup system must not depend on, or write into, the very databases it protects.

## D11 — In-process `node-cron`, not Redis+BullMQ, for scheduling
**Context:** The original design named BullMQ+Redis for scheduling and locking. The
service runs as a single Node process; Redis buys distributed job retries and a
cross-instance capture lock, neither of which matters until there's more than one instance.
**Decision:** Use `node-cron` in-process for base-backup cadence, test-restore cadence, and
the retention sweep. The per-DB capture lock is an in-process `Map` (captureManager.js).
**Consequences:** No new infrastructure to run/operate at current scale; schedules and the
capture lock don't survive past a single instance. If you ever run multiple API instances,
revisit this: move the capture lock to Redis and cron jobs to BullMQ repeatable jobs so
only one instance executes each job/holds each lock.

## D12 — EJSON, not plain JSON, for change-slice serialization
**Context:** Found live during Phase 2 testing: `JSON.stringify`/`JSON.parse` silently
downgrades a BSON `ObjectId` (in `documentKey`/`fullDocument`) to a plain string. On
replay, that string filter fails to match the real `ObjectId` in the target, causing
missed updates and spurious upsert-created documents.
**Decision:** Serialize change events with `bson`'s `EJSON.stringify`/`EJSON.parse`
instead, which round-trips `ObjectId`, `Date`, and other BSON types losslessly.
**Consequences:** One more dependency (`bson`, already transitive via `mongodb`, now
explicit). This is the correctness-critical serialization for the whole PITR replay path —
any future change to the slice format must preserve BSON-type fidelity, not silently
regress to plain JSON.

## D13 — Soft delete for registered databases
**Decision:** Unregistering a database sets `deletedAt` rather than deleting the catalog
record; `listDatabases()` filters it out everywhere (capture resume, scheduler resume,
public listing), while `findDatabaseById()` still returns it and existing base
backups/change slices are left in place and restorable.
**Why:** Once capture and scheduling became automatic background processes (Phase 3), there
needed to be a way to stop them for a given database. Hard-deleting the catalog record
would orphan its `dbId`-referenced backups/slices/restore history for no benefit — keeping
the record (marked deleted) preserves recoverability and audit history at negligible cost.

## D14 — Seeded admin users, no self-registration
**Decision:** The admin web UI has a login page and nothing else for auth — no signup
flow. Accounts are created by `scripts/create-admin.js` (bcrypt-hashed password in a
`users` collection), run directly against the deployment.
**Why:** This is an internal operations tool, not a multi-tenant product; a public
registration flow would just be an unnecessary attack surface. `create-admin.js` can be
re-run to add more admins later without needing a UI for it.
**Consequences:** No self-serve password reset either — resetting means re-running the
script (it upserts... actually it errors on an existing username today; if you need
rotation, delete the user document and recreate, or extend the script). Sessions are
`@fastify/secure-session` (stateless encrypted cookie, `SESSION_KEY` — same encrypt-at-rest
pattern as `MASTER_KEY`). The JSON `/api/*` surface shares this same session cookie
(`requireApiAuth` in `src/web/auth.js`) rather than being a separate open API — otherwise
it would be a complete bypass around the login screen.

## D15 — CSRF verification must run as `preHandler`, not `onRequest`
**Context:** Found live while testing the login form: every CSRF-protected POST failed
with `FST_CSRF_INVALID_TOKEN` even though the secret and token were provably identical
across requests (confirmed with a minimal reproduction outside the app). The cause:
Fastify's request lifecycle runs `onRequest` **before** the body is parsed
(`onRequest → preParsing → body parsing → preValidation → preHandler → handler`). The
route options had been wired as `{ onRequest: app.csrfProtection }`, matching
`@fastify/csrf-protection`'s own README example — but that check reads the token from
`request.body._csrf`, which doesn't exist yet at the `onRequest` stage, so it was silently
validating against `undefined` every time.
**Decision:** Every CSRF-protected route uses `preHandler: [requireAuth, app.csrfProtection]`
(or just `preHandler: app.csrfProtection` where there's no auth guard), never `onRequest`.
**Why it matters going forward:** the plugin's own docs show the `onRequest` form, so this
is an easy regression to reintroduce when adding a new form/route — any new
CSRF-protected POST must use `preHandler`, or it will fail closed (every submission
rejected) rather than fail open, which is at least safe but will look like a mysterious
outage.
