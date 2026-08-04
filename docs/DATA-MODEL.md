# Data Model & Storage Layout

## 1. Metadata catalog (service-owned DB)

> Store this in the service's **own** database — never inside a customer cluster. Connection
> URIs are encrypted at rest (AES-256-GCM); the master key comes from a secret manager.

### registered_databases
```jsonc
{
  "_id": "ObjectId",
  "name": "shop-prod",
  "connectionUriEnc": "<base64 AES-256-GCM: iv|tag|ciphertext>",
  "tier": "M0",                      // M0|M2|M5|M10+  (detected on register)
  "scheduleCron": "0 * * * *",       // base-dump cadence (bounds replay length / RTO)
  "retention": { "hourly": 24, "daily": 30, "weekly": 12 },  // max-age windows; longest wins
  "pitrEnabled": true,
  "captureStatus": "running|stopped|continuity_break",
  "lastBaseAt": "ISODate",
  "lastCaptureTs": { "t": 1720511530, "i": 3 },
  "resumeTokenRef": "redis:key or inline",   // last persisted change-stream token
  "createdAt": "ISODate", "updatedAt": "ISODate"
}
```

### base_backups
```jsonc
{
  "_id": "ObjectId",
  "dbId": "ObjectId",
  "type": "base",
  "startedAt": "ISODate", "finishedAt": "ISODate",
  "captureStartTs": { "t": 1720511500, "i": 1 }, // token recorded BEFORE dump (PITR §2)
  "storageKey": "shop-prod/base/2026-07-09T00-00-00Z/",
  "sizeBytes": 10485760,
  "collections": ["orders", "users", "products"],
  "checksumSha256": "…",
  "status": "completed|running|failed"
}
```

### change_slices  (the PITR log index)
```jsonc
{
  "_id": "ObjectId",
  "dbId": "ObjectId",
  "fromClusterTs": { "t": 1720511530, "i": 1 },
  "toClusterTs":   { "t": 1720511590, "i": 9 },
  "storageKey": "shop-prod/changes/1720511530-1--1720511590-9.ndjson.gz",
  "eventCount": 842,
  "sizeBytes": 65536,
  "createdAt": "ISODate"
}
```
Indexed on `{ dbId: 1, fromClusterTs: 1 }` for fast range selection during restore.

### restore_jobs
```jsonc
{
  "_id": "ObjectId",
  "dbId": "ObjectId",
  "targetTimestamp": { "t": 1720511575, "i": 0 },
  "targetUri": "<encrypted>",
  "mode": "new-target|overwrite-source",
  "baseBackupId": "ObjectId",
  "sliceIds": ["ObjectId", "..."],
  "status": "queued|restoring-base|replaying|verifying|completed|failed",
  "verification": { "docCounts": {...}, "checksumsOk": true },
  "requestedBy": "userId",
  "log": [ { "at": "ISODate", "msg": "…" } ],
  "createdAt": "ISODate"
}
```

### audit_log
```jsonc
{ "_id", "actor", "action": "register|rotate-uri|trigger-restore|delete-backup",
  "dbId", "detail", "at": "ISODate" }
```

## 2. Object-storage layout

```
{bucket}/
  {dbId}/
    base/
      2026-07-09T00-00-00Z/
        manifest.json          # captureStartTs, collections, checksums, tool version
        shop/orders.bson.gz
        shop/orders.metadata.json.gz
        shop/users.bson.gz
        …
    changes/
      1720511530-1--1720511590-9.ndjson.gz
      1720511590-9--1720511650-2.ndjson.gz
      …
```

### base manifest.json
```jsonc
{
  "dbId": "…",
  "capturedAt": "2026-07-09T00:00:00Z",
  "captureStartTs": { "t": 1720511500, "i": 1 },
  "mongoServerVersion": "7.0.x",
  "toolsVersion": "mongodump 100.x",
  "collections": [
    { "ns": "shop.orders", "docCount": 12043, "checksumSha256": "…", "sizeBytes": 8388608 }
  ]
}
```

## 3. Time is `clusterTime`, not wall clock

All ordering and the restore cutoff use MongoDB **`clusterTime`** (`{ t, i }`: seconds +
increment), which is monotonic and matches how events are ordered on the server. The UI may
accept a wall-clock timestamp and map it to the nearest `clusterTime ≤ requested`. Never
order the change log by ingestion/wall-clock time — only by `clusterTime`.
