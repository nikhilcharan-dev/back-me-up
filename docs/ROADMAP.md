# Roadmap

Ordered so each phase is independently demoable and de-risks the next. Because the target
is **near-zero RPO**, continuous capture appears early (Phase 1), not at the end.

## Phase 0 — Walking skeleton (dump → restore round-trip)  ✅ done
Prove the core pipeline end-to-end on one DB, manual trigger.
- Register a DB (encrypted URI), detect tier, test-connect.
- `mongodump` a base → object storage; write a `base_backups` record + manifest.
- `mongorestore` that base into a **new** target DB.
- **Exit criteria:** a database is dumped and restored into a fresh target; counts match.

## Phase 1 — Continuous capture (the PITR engine)  ✅ done — near-zero RPO lands here
- One capture worker per DB, `db.watch()` → normalized change slices.
- Persist resume token after each flush; resume cleanly on restart.
- **Capture-before-dump** invariant wired into base creation.
- Continuity-break detection → mark status, trigger re-baseline, emit alert.
- **Exit criteria:** all writes to a source appear as ordered slices; killing/restarting the
  worker loses nothing (within the oplog window). *Verified live: killed/restarted the
  process mid-stream against a real replica set, confirmed zero loss via the resume token.*

## Phase 2 — Restore to a timestamp (the payoff)  ✅ done
- Resolve base ≤ T + slice range; `mongorestore` base; replay slices with `ct ≤ T` cutoff.
- Idempotent apply (insert/replace/update/delete by `_id`).
- Restore into new target; post-restore verification (doc-count deltas).
- **Exit criteria:** given a past timestamp, the target matches the source's state at that
  instant for a scripted write workload. *Verified live against 5 distinct timestamps
  across insert/update/delete; also where EJSON serialization (D12) was found necessary.*

## Phase 3 — Automation & scale  ✅ done
- Scheduler (`node-cron`, in-process — see D11) for base cadence per DB.
- Age-window retention + slice-safety pruning rules (`retentionService.js`).
- Multi-DB onboarding; per-DB isolation (capture/scheduler keyed by dbId).
- Soft-delete lifecycle (D13) so unregistering a DB stops its background activity.
- **Exit criteria:** many DBs run unattended with correct retention.

## Phase 4 — Hardening & UX  ✅ mostly done (UI deferred)
- Scheduled **test-restores** to a scratch target + verification reports (`testRestoreService.js`).
- Metrics via `GET /metrics` (Prometheus format): capture lag, base-backup age, backup/restore/
  test-restore counters, continuity-break counter.
- Audit log (`GET /api/audit`) covering register/backup/restore/rotate/prune/re-baseline.
- URI rotation (`POST /api/databases/:id/rotate-uri`), capture-preserving.
- Web UI: deliberately skipped for now — everything is reachable via REST; revisit if/when
  a UI is actually needed.
- **Exit criteria:** production-ready SLAs with monitoring and tested recovery — met for a
  single-instance deployment; horizontal scaling still needs the D11 upgrade path.

## Phase 5 — Admin web UI  ✅ done
Server-rendered (EJS), session-authenticated admin panel — the UI originally deferred in
Phase 4 is now built.
- Login only, no self-registration (`scripts/create-admin.js` seeds accounts) — D14.
- Dashboard (databases + tags + status) → add-database form (URL, name, tags) → detail
  page: capture controls, backup list with `.tar.gz` download links, run-backup button,
  retention policy editor, test-restore config/history, PITR restore form (with
  timezone-correct timestamp conversion) with live status polling, credential rotation,
  unregister.
- Navbar shows the server's public egress IP for Atlas allowlisting.
- The JSON `/api/*` surface is now session-gated too (shares the UI's cookie) — see D14.
- **Exit criteria:** every capability reachable via curl in Phases 0–4 is also reachable
  through the browser. *Verified live end-to-end through the actual HTTP forms (not just
  the JSON API): login → add DB with tags → navbar IP badge → run backup → download and
  extract the archive → PITR restore to two independent checkpoints, each verified against
  the target via `mongosh` → logout invalidates both the UI and the API session → unregister
  hides the DB from the dashboard while keeping its backups reachable.*

## Later / optional
- **M10+ oplog-slicing backend** (consistent base via `--oplog`, `--oplogReplay`) behind the
  same catalog/restore API — one system across tiers (see PITR-DESIGN §7).
- Cross-region artifact replication; client-side artifact encryption; cost tiering.
