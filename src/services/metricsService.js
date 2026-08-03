import { registry } from "../metrics/registry.js";
import { listRegisteredDatabases } from "./databaseService.js";
import { countBaseBackupsByStatus } from "../repositories/backupsRepo.js";
import { countRestoreJobsByStatus } from "../repositories/restoresRepo.js";
import { countTestRestoreRunsByResult } from "../repositories/testRestoresRepo.js";
import { countAuditEntriesByAction } from "../repositories/auditRepo.js";

// Live process/gauge stats (uptime, memory, capture lag, backup age, capture
// running) come from the same prom-client registry /metrics exposes — a second
// view onto it for humans. Using getMetricsAsJSON() instead of parsing the text
// exposition format keeps this immune to prom-client's formatting.
//
// Totals (backups/restores/test-restores/continuity-breaks) deliberately do NOT
// come from the matching backmeup_*_total Prometheus counters: those are
// in-process Counters with no persistence, so they reset to zero on every
// restart — a redeploy would make this page show "0 backups" for a database with
// years of history still sitting in the catalog. Prometheus itself doesn't have
// this problem (it scrapes continuously and PromQL's rate()/increase() are
// built to handle counter resets), but a page that just reads the current value
// once does. Totals here are instead aggregated straight from the catalog
// collections that already back the database detail page, so the two pages
// can't disagree about how many backups a database has.

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

async function loadDatabaseTotals(dbId) {
  const [backups, restores, testRestores, continuityBreaks] = await Promise.all([
    countBaseBackupsByStatus(dbId),
    countRestoreJobsByStatus(dbId),
    countTestRestoreRunsByResult(dbId),
    countAuditEntriesByAction(dbId, "continuity-break-rebaseline"),
  ]);
  return {
    backupsCompleted: backups.completed ?? 0,
    backupsFailed: backups.failed ?? 0,
    restoresCompleted: restores.completed ?? 0,
    restoresFailed: restores.failed ?? 0,
    testRestoresOk: testRestores.ok ?? 0,
    testRestoresFailed: testRestores.failed ?? 0,
    continuityBreaks,
  };
}

export async function getDashboardMetrics() {
  const [json, databases] = await Promise.all([registry.getMetricsAsJSON(), listRegisteredDatabases()]);
  const metrics = metricMap(json);

  const captureLag = metrics.get("backmeup_capture_lag_seconds");
  const captureRunningMetric = metrics.get("backmeup_capture_running");
  const baseBackupAge = metrics.get("backmeup_base_backup_age_seconds");

  const perDatabase = await Promise.all(
    databases.map(async (db) => {
      const dbId = String(db._id);
      return {
        dbId,
        name: db.name,
        dbName: db.dbName,
        captureStatus: db.captureStatus,
        pitrEnabled: db.pitrEnabled,
        captureLagSeconds: findValue(captureLag, { db_id: dbId }),
        captureRunningNow: findValue(captureRunningMetric, { db_id: dbId }) === 1,
        baseBackupAgeSeconds: findValue(baseBackupAge, { db_id: dbId }),
        ...(await loadDatabaseTotals(dbId)),
      };
    })
  );

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
