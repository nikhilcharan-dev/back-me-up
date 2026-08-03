import { registry } from "../metrics/registry.js";
import { listRegisteredDatabases } from "./databaseService.js";

// Everything here reads the same prom-client registry /metrics scrapes — this is
// a second view onto it for humans, not a separate source of truth. Using
// getMetricsAsJSON() instead of parsing the text exposition format keeps this
// immune to prom-client's text formatting and avoids a second parser to maintain.

function metricMap(json) {
  const map = new Map();
  for (const m of json) map.set(m.name, m);
  return map;
}

function findValue(metric, labels) {
  if (!metric) return null;
  const entry = metric.values.find((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val));
  return entry ? entry.value : null;
}

// Sums a counter's values for one db_id, broken out by a second label (e.g.
// status: completed/failed) — prom-client keeps one time series per label
// combination, so "total completed backups for db X" is a sum, not a lookup.
function sumByLabel(metric, dbId, labelName) {
  const out = {};
  if (!metric) return out;
  for (const v of metric.values) {
    if (v.labels.db_id !== dbId) continue;
    const key = v.labels[labelName] ?? "unknown";
    out[key] = (out[key] ?? 0) + v.value;
  }
  return out;
}

function sumAll(metric, dbId) {
  if (!metric) return 0;
  return metric.values.filter((v) => v.labels.db_id === dbId).reduce((total, v) => total + v.value, 0);
}

function buildProcessStats(metrics) {
  const startTime = findValue(metrics.get("process_start_time_seconds"), {});
  const residentMemory = findValue(metrics.get("process_resident_memory_bytes"), {});
  const heapUsed = findValue(metrics.get("nodejs_heap_size_used_bytes"), {});
  const heapTotal = findValue(metrics.get("nodejs_heap_size_total_bytes"), {});
  const cpuSeconds = findValue(metrics.get("process_cpu_seconds_total"), {});
  const eventLoopLag = findValue(metrics.get("nodejs_eventloop_lag_seconds"), {});
  const openFds = findValue(metrics.get("process_open_fds"), {});

  const versionMetric = metrics.get("nodejs_version_info");
  const nodeVersion = versionMetric?.values?.[0]?.labels?.version ?? null;

  return {
    uptimeSeconds: startTime !== null ? Date.now() / 1000 - startTime : null,
    residentMemoryBytes: residentMemory,
    heapUsedBytes: heapUsed,
    heapTotalBytes: heapTotal,
    cpuSeconds,
    eventLoopLagMs: eventLoopLag !== null ? eventLoopLag * 1000 : null,
    openFds,
    nodeVersion,
  };
}

export async function getDashboardMetrics() {
  const [json, databases] = await Promise.all([registry.getMetricsAsJSON(), listRegisteredDatabases()]);
  const metrics = metricMap(json);

  const captureLag = metrics.get("backmeup_capture_lag_seconds");
  const captureRunningMetric = metrics.get("backmeup_capture_running");
  const baseBackupAge = metrics.get("backmeup_base_backup_age_seconds");
  const baseBackupTotal = metrics.get("backmeup_base_backup_total");
  const restoreTotal = metrics.get("backmeup_restore_total");
  const continuityBreakTotal = metrics.get("backmeup_continuity_break_total");
  const testRestoreTotal = metrics.get("backmeup_test_restore_total");

  const perDatabase = databases.map((db) => {
    const dbId = String(db._id);
    const backups = sumByLabel(baseBackupTotal, dbId, "status");
    const restores = sumByLabel(restoreTotal, dbId, "status");
    const testRestores = sumByLabel(testRestoreTotal, dbId, "result");

    return {
      dbId,
      name: db.name,
      dbName: db.dbName,
      captureStatus: db.captureStatus,
      pitrEnabled: db.pitrEnabled,
      captureLagSeconds: findValue(captureLag, { db_id: dbId }),
      captureRunningNow: findValue(captureRunningMetric, { db_id: dbId }) === 1,
      baseBackupAgeSeconds: findValue(baseBackupAge, { db_id: dbId }),
      backupsCompleted: backups.completed ?? 0,
      backupsFailed: backups.failed ?? 0,
      restoresCompleted: restores.completed ?? 0,
      restoresFailed: restores.failed ?? 0,
      testRestoresOk: testRestores.ok ?? 0,
      testRestoresFailed: testRestores.failed ?? 0,
      continuityBreaks: sumAll(continuityBreakTotal, dbId),
    };
  });

  const totals = perDatabase.reduce(
    (acc, row) => ({
      backupsCompleted: acc.backupsCompleted + row.backupsCompleted,
      backupsFailed: acc.backupsFailed + row.backupsFailed,
      restoresCompleted: acc.restoresCompleted + row.restoresCompleted,
      restoresFailed: acc.restoresFailed + row.restoresFailed,
      testRestoresOk: acc.testRestoresOk + row.testRestoresOk,
      testRestoresFailed: acc.testRestoresFailed + row.testRestoresFailed,
      continuityBreaks: acc.continuityBreaks + row.continuityBreaks,
    }),
    {
      backupsCompleted: 0,
      backupsFailed: 0,
      restoresCompleted: 0,
      restoresFailed: 0,
      testRestoresOk: 0,
      testRestoresFailed: 0,
      continuityBreaks: 0,
    }
  );

  return {
    perDatabase,
    totals,
    process: buildProcessStats(metrics),
  };
}
