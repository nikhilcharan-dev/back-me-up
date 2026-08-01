import "dotenv/config";

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  catalogMongoUri: required("CATALOG_MONGODB_URI"),
  masterKey: required("MASTER_KEY"),
  storageRoot: process.env.STORAGE_ROOT ?? "./data/storage",
  retentionSweepCron: process.env.RETENTION_SWEEP_CRON ?? "0 3 * * *",
  testRestoreDefaultCron: process.env.TEST_RESTORE_DEFAULT_CRON ?? "0 4 * * 0",
  metricsIntervalMs: Number(process.env.METRICS_INTERVAL_MS ?? 15000),
  // Ceiling on how many documents the backup browser reads out of a dumped
  // collection to build one page. Collections larger than this stay browsable —
  // the UI just reports the counts as capped instead of exact. Downloads are
  // never capped; they stream the whole collection.
  browseScanLimit: Number(process.env.BROWSE_SCAN_LIMIT ?? 50000),
  sessionKey: required("SESSION_KEY"),
  // Public egress IP shown in the navbar for Atlas IP-allowlist purposes. Detection
  // hits an external service; results are cached (src/lib/publicIp.js).
  publicIpCheckUrl: process.env.PUBLIC_IP_CHECK_URL ?? "https://api.ipify.org?format=json",
};
