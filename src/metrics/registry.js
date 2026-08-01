import client from "prom-client";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const captureLagSeconds = new client.Gauge({
  name: "backmeup_capture_lag_seconds",
  help: "Seconds since the last captured change event for this database",
  labelNames: ["db_id", "db_name"],
  registers: [registry],
});

export const captureRunning = new client.Gauge({
  name: "backmeup_capture_running",
  help: "1 if change-stream capture is currently running for this database, else 0",
  labelNames: ["db_id", "db_name"],
  registers: [registry],
});

export const baseBackupAgeSeconds = new client.Gauge({
  name: "backmeup_base_backup_age_seconds",
  help: "Seconds since the last completed base backup for this database",
  labelNames: ["db_id", "db_name"],
  registers: [registry],
});

export const baseBackupTotal = new client.Counter({
  name: "backmeup_base_backup_total",
  help: "Total base backup attempts",
  labelNames: ["db_id", "status"],
  registers: [registry],
});

export const restoreTotal = new client.Counter({
  name: "backmeup_restore_total",
  help: "Total restore attempts",
  labelNames: ["db_id", "status"],
  registers: [registry],
});

export const continuityBreakTotal = new client.Counter({
  name: "backmeup_continuity_break_total",
  help: "Total capture continuity breaks (expired resume token)",
  labelNames: ["db_id"],
  registers: [registry],
});

export const testRestoreTotal = new client.Counter({
  name: "backmeup_test_restore_total",
  help: "Total scheduled test-restore runs",
  labelNames: ["db_id", "result"],
  registers: [registry],
});
