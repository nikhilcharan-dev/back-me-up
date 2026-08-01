# Architecture

## 1. Overview

`back-me-up` is a control plane + a set of workers that, for each registered Atlas
database, maintain **base snapshots** and a **continuous change log**, and can reconstruct
the database to any past timestamp by replaying the log on top of a base.

The system is designed for **Atlas free/shared tiers (M0–M5)**, so the change log is built
from **Change Streams** (the only change feed available without oplog access) rather than
oplog tailing. See [PITR-DESIGN.md](PITR-DESIGN.md) for why and the consequences.

## 2. Component diagram

```
                         ┌──────────────────────────────┐
        CLI / curl ─────▶│  Single Node process (Fastify)│  register DBs, schedules,
                         │  API + capture + scheduler +  │  retention, trigger restores
                         │  restore, all in-process      │  /metrics for Prometheus
                         └───────────────┬──────────────┘
                     ┌────────────────────┼────────────────────┐
                     ▼                    ▼                    ▼
          ┌────────────────┐   ┌──────────────────┐   ┌──────────────────┐
          │ Capture Workers │   │ node-cron jobs    │   │ Restore path      │
          │ ONE per DB,     │   │ base-backup cron, │   │ base restore +    │
          │ db.watch()      │   │ test-restore cron,│   │ replay to timestamp│
          │ → slices        │   │ retention sweep   │   │                    │
          └────────┬────────┘   └─────────┬─────────┘   └─────────┬──────────┘
                    ▼                      ▼                       ▼
   ┌───────────────────────────────────────────────────────────────────────┐
   │ Object Storage (local FS for dev; S3-compatible planned for prod)      │
   │   {dbId}/base/<ts>/...bson.gz     |     {dbId}/changes/<from>--<to>.gz  │
   └───────────────────────────────────────────────────────────────────────┘
   ┌───────────────────────────────────────────────────────────────────────┐
   │ Metadata Catalog (service-owned MongoDB)                               │
   │   registered_databases · base_backups · change_slices · restore_jobs   │
   │   · test_restore_runs · audit_log + encrypted connection URIs          │
   └───────────────────────────────────────────────────────────────────────┘
```

No Redis, no separate worker processes — see [DECISIONS.md D11](DECISIONS.md) for why:
a single always-on Node process covers everything at this scale, with Redis+BullMQ as
the documented upgrade path if you ever need multiple instances.

## 3. Components

### 3.1 Control plane (REST API)
- CRUD for **registered databases**: name, connection URI (encrypted on write), tier,
  schedule, retention policy, `pitrEnabled`, optional test-restore target.
- Endpoints to **trigger/monitor restores**, browse the **backup catalog**, rotate
  credentials, run retention on demand, and read the **audit log**.
- `GET /metrics` exposes Prometheus-format counters/gauges (see §3.7).

### 3.2 Scheduler
- **`node-cron`**, in-process: each DB's `scheduleCron` drives its base-backup job;
  each DB's `testRestoreCron` (or the global default) drives its test-restore job; one
  global cron runs the retention sweep. All resume automatically on process restart by
  re-reading the catalog (mirrors capture's restart-safety).
- Base cadence is chosen to bound **replay length** (and therefore RTO), not RPO — RPO is
  handled by continuous capture. See [OPERATIONS.md](OPERATIONS.md#rpo--rto).

### 3.3 Capture workers  ← the PITR engine
- **Exactly one worker per registered DB**, enforced by an in-process `Map` (single
  instance today; a Redis lock is the documented upgrade path for multiple instances).
- Opens a Change Stream (`db.watch()`), buffers events, and flushes them to storage as
  **change slices**, persisting the **resume token** after each flush.
- On restart it resumes from the last token — **zero-loss** as long as downtime stays
  inside the shared-tier oplog window (a key constraint; see PITR-DESIGN §5).
- Detects **continuity breaks** (invalid/expired resume token), triggers an immediate
  re-baseline, and increments the `backmeup_continuity_break_total` metric.

### 3.4 Restore path
- Input: `(dbId, targetTimestamp, targetUri)` or `(baseBackupId, targetUri)` for a
  base-only restore.
- Steps: pick newest base ≤ T → `mongorestore` into target → replay change slices covering
  `(base.startedAt, T]` in cluster-time order, stopping at T → verify via doc-count deltas.
- Default target is always a **new** database. Overwriting the source is a guarded feature
  for a later phase.
- **Scheduled test-restores** run this same path against a configured scratch target on a
  cron, dropping the target first for a clean slate each run — "an untested backup is not
  a backup" (docs/OPERATIONS.md).

### 3.5 Object storage
- Stores base dumps and change slices on local FS today; the storage-key layout
  (`{dbId}/base/...`, `{dbId}/changes/...`) is provider-agnostic so swapping in S3/MinIO
  later is a storage-layer change only, not a data-model one.

### 3.6 Metadata catalog
- The service's **own** database — never stored inside a customer cluster.
- Holds the catalog, encrypted connection URIs (source + test-restore target), resume
  tokens, test-restore run history, and the audit log. Schemas in [DATA-MODEL.md](DATA-MODEL.md).

### 3.7 Metrics
- `prom-client` registry exposed at `GET /metrics`: capture lag/running state and
  base-backup age refreshed on a timer from the catalog; backup/restore/test-restore
  counters and continuity-break counts incremented inline where the events happen.

## 4. Primary data flows

**Register:** URI → validated (test connect) → encrypted → catalog → capture worker
started → cron schedules registered. *Capture starts before the first dump so there is no
uncovered gap (see PITR-DESIGN §2).*

**Steady state:** capture worker streams changes → slices to storage + token persisted;
node-cron fires base dumps at the configured cadence; the retention sweep prunes per
policy; scheduled test-restores validate recoverability.

**Restore:** API resolves the base + relevant slices → restores base → replays to T →
verifies (doc-count deltas) → marks complete, all synchronously within the request for
now (no job queue — see D11).

**Unregister:** soft delete — capture and all schedules for that DB stop; existing base
backups and change slices are left in place and still restorable.

## 5. Tech stack

| Concern | Choice | Rationale |
|---|---|---|
| Language/runtime | Node.js | Matches the surrounding stack; first-class Mongo change-stream support |
| API | Fastify | Lightweight, fast, schema-based validation |
| Mongo access | Official `mongodb` driver + `bson` (EJSON) | Native change streams + resume tokens; EJSON round-trips BSON types (ObjectId etc.) through slice storage losslessly — plain JSON silently corrupts them (docs/DECISIONS.md) |
| Dump/restore | `mongodb-database-tools` | `mongodump`/`mongorestore` are the proven engine — do not reinvent |
| Scheduling | `node-cron`, in-process | No new infra at single-instance scale; see D11 for the Redis+BullMQ upgrade path |
| Metrics | `prom-client` | Standard Prometheus exposition format |
| Storage | Local FS (dev); S3-compatible planned | Storage-key layout is already provider-agnostic |
| Catalog | MongoDB | One database technology for the whole service |
| Secrets | AES-256-GCM, key from env/secret mgr (→ KMS) | Encrypt connection URIs at rest |
| Packaging | Docker | `mongodb-database-tools` baked into the image |

## 6. Deployment topology

- A single `api` container: Fastify server, capture workers, node-cron schedules, and the
  metrics endpoint all run in one process · `metadata mongo`.
- Compose for local/dev; the same image to your orchestrator in prod.
- **Egress IP of the API container must be on each Atlas cluster's IP allowlist** (or use
  PrivateLink/peering) — see [OPERATIONS.md](OPERATIONS.md#network--access).
- **Scaling beyond one instance** requires the Redis-backed capture lock and job queue
  documented as the upgrade path in D11 — not needed until you outgrow a single process.
