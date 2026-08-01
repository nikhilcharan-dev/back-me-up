# Operations

The practices that make this an actual backup system rather than a script that copies data.

## RPO & RTO

| Metric | Meaning | In this design |
|---|---|---|
| **RPO** (recovery point objective) | Max acceptable data loss | **Near-zero** — bounded by capture flush interval (seconds) while capture is healthy. Degrades to "since last base" only during a continuity break |
| **RTO** (recovery time objective) | Time to complete a restore | `mongorestore` of base + replay of `(base → T)` changes. **Base cadence is tuned to bound replay length** — more frequent bases = shorter replay = lower RTO, at more storage |

Tune base cadence to keep worst-case replay within your RTO. Capture handles RPO; base
frequency handles RTO. They are independent knobs.

## Restore safety  ⚠️

- **Default restore target is a NEW database/cluster.** Restoring over a live DB is
  destructive and irreversible.
- **Overwrite-source is opt-in**, requires an explicit confirmation, and **pre-snapshots
  the target first** (safety net for the safety net).
- Every restore runs into isolation → **verify** (document counts, checksums, spot checks)
  → only then does a human cut traffic over.
- Support a **dry-run / restore-to-scratch** so users can validate a timestamp before
  committing.

## Retention (GFS)

Grandfather-father-son, per DB, configurable:
- Hourly bases kept 24h → daily 30d → weekly 12w (defaults; override per DB).
- **Never delete a change slice newer than the oldest retained base** — doing so would
  punch a hole in the replay range. Prune slices only once every base that could need them
  is gone.
- Apply object-storage lifecycle rules for cold tiers / cost once artifacts age out of the
  active window.

## Backup integrity — "an untested backup is not a backup"

- **Scheduled test-restores** (e.g. weekly) of each DB to a scratch cluster, with automated
  count/checksum verification. A backup that has never been restored does not count.
- **Checksums** (SHA-256) on every base collection and every change slice; verify on read.
- **Manifest** per base records tool versions, doc counts, and checksums.

## Network & access

- **Atlas IP allowlist:** the egress IPs of **capture and restore workers** must be
  allowlisted on every source cluster (or use PrivateLink/VPC peering). This is the #1
  cause of "it worked in dev, fails in prod."
- **Least-privilege backup user** per cluster: `read` on the databases being captured
  (change streams need read); `backup` role where available (dedicated). Do **not** reuse
  the application's admin user.
- **Restore target credentials** are separate and scoped to the target only.

## Security

- Connection URIs (contain credentials) are **encrypted at rest** with AES-256-GCM; the
  master key lives in a secret manager / KMS, never in the repo or the catalog.
- Support **URI rotation** without losing capture continuity.
- **Audit log** every restore, credential change, and backup deletion (who/what/when).
- Storage bucket is private; artifacts optionally encrypted client-side before upload.

## Observability & alerting

Emit metrics and alert on:
- **Capture lag** (now − `lastCaptureTs`) exceeding threshold → RPO at risk.
- **Continuity break** (resume token expired) → immediate page; auto re-baseline kicked off.
- **Missed/failed base backup**.
- **Restore job failures** and replay errors.
- **Storage growth / slice backlog**, approaching M0 limits.
- Per-DB dashboard: last base, capture lag, slice count, next scheduled base, RPO/RTO est.

## Failure runbook (summary)

| Symptom | Likely cause | Action |
|---|---|---|
| Capture lag rising | Worker slow / source throttled | Check worker health, source load; scale/queue |
| `continuity_break` status | Worker was down > oplog window | Auto re-baseline should fire; verify new base; investigate downtime |
| Base backup failing | IP allowlist / auth / storage | Check allowlist, backup-user creds, bucket perms |
| Restore replay error | Array-update edge case (PITR §5.5) | Re-run with post-image collection enabled; escalate |
| Cannot restore to T | T older than retention | Recover to oldest available base; adjust retention |
