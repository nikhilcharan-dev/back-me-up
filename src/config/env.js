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
  // When a capture stops on its own (not because someone stopped it) it is restarted
  // automatically. The wait before attempt N is base * 2^(N-1), capped at max, so a
  // source that stays down is retried ever more gently instead of hammered. The
  // ladder starts over once a restarted capture has stayed up for "stable".
  captureRetryBaseMs: Number(process.env.CAPTURE_RETRY_BASE_MS ?? 2000),
  captureRetryMaxMs: Number(process.env.CAPTURE_RETRY_MAX_MS ?? 300000),
  captureRetryStableMs: Number(process.env.CAPTURE_RETRY_STABLE_MS ?? 60000),
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
