# back-me-up

A standalone **MongoDB Atlas backup & point-in-time recovery (PITR)** service, with an
admin web UI.

You register Atlas connection URLs. `back-me-up` takes periodic base snapshots **and**
continuously captures every change, so you can restore a database to its exact state at
**any second in the past** — not just to the last backup.

> **Why build this?** Atlas's native continuous backup / PITR only exists on dedicated
> tiers (M10+). This service targets **free & shared tiers (M0–M5)**, where the only
> available change feed is **Change Streams**. It turns those into a replayable log to
> deliver PITR that Atlas itself won't give you on those tiers.

---

## What it does

- **Register** any number of Atlas (or self-hosted) databases by connection URL, with a name
  and tags — through the admin UI or the JSON API — and edit that metadata, the capture
  toggle, and the backup schedule later from the database page.
- **Base snapshots** on a schedule (in-process cron), downloadable as `.tar.gz`.
- **Browse a snapshot without restoring it** — open a backup, open a collection, search its
  documents, and download that collection as JSON or as the raw `.bson.gz`.
- **Continuous capture** of every insert/update/delete via Change Streams (near-zero RPO).
- **Restore to a timestamp** — pick the newest base ≤ T, restore it, then replay captured
  changes up to exactly T, into a **new** target (never over the live DB by default).
- **GFS retention**, scheduled **test-restores**, Prometheus **metrics**, an **audit log**,
  and credential **rotation**.

## Status

✅ **Implemented and live-tested** (Docker + real MongoDB replica sets) — not just designed.
See [docs/ROADMAP.md](docs/ROADMAP.md) for what's done per phase.

## Getting started

```bash
cp .env.example .env
npm run generate-key           # -> MASTER_KEY   (encrypts registered connection URLs)
npm run generate-session-key   # -> SESSION_KEY  (encrypts the admin UI's session cookie)
# paste both into .env, along with CATALOG_MONGODB_URI

docker compose up -d
docker compose exec api node scripts/create-admin.js <username> <password>
```

Open `http://localhost:4000` and sign in. **There is no self-registration page by
design** — `create-admin.js` is the only way to create a login; run it again to add more
admins.

The navbar shows this server's public egress IP — whitelist that IP in each Atlas
cluster's Network Access settings before registering a database on it.

## Documentation

| Doc | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, data flow, tech stack, deployment |
| [docs/PITR-DESIGN.md](docs/PITR-DESIGN.md) | The change-stream PITR engine, replay semantics, **M0 constraints & risks** |
| [docs/DATA-MODEL.md](docs/DATA-MODEL.md) | Metadata catalog schemas + object-storage layout |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Retention, restore safety, security, RPO/RTO, runbook, alerting |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phased delivery plan and what's done per phase |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Key architecture decisions and their trade-offs |

## Stack

Node.js (≥22) · Fastify · MongoDB native driver (change streams) + `bson` (EJSON) ·
`mongodb-database-tools` (`mongodump`/`mongorestore`) · `node-cron` (in-process scheduling,
see [D11](docs/DECISIONS.md)) · `prom-client` (`/metrics`) · `@fastify/secure-session` +
`@fastify/csrf-protection` (admin auth) · EJS (server-rendered UI) · Docker.
