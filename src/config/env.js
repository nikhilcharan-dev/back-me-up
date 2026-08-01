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
  sessionKey: required("SESSION_KEY"),
  // Public egress IP shown in the navbar for Atlas IP-allowlist purposes. Detection
  // hits an external service; results are cached (src/lib/publicIp.js).
  publicIpCheckUrl: process.env.PUBLIC_IP_CHECK_URL ?? "https://api.ipify.org?format=json",
};
