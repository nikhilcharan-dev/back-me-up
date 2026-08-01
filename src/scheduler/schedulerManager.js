import cron from "node-cron";
import { config } from "../config/env.js";
import { runBaseBackup } from "../services/backupService.js";
import { runScheduledTestRestore } from "../services/testRestoreService.js";
import { pruneDatabase } from "../services/retentionService.js";
import { listDatabases } from "../repositories/databasesRepo.js";

const backupJobs = new Map(); // dbId -> ScheduledTask
const testRestoreJobs = new Map(); // dbId -> ScheduledTask
let retentionSweepJob = null;

function schedule(jobMap, dbId, cronExpr, label, run) {
  const key = String(dbId);
  unschedule(jobMap, key);
  if (!cronExpr) return;
  if (!cron.validate(cronExpr)) {
    console.error(`[scheduler] invalid cron expression for ${label} on db ${key}: "${cronExpr}"`);
    return;
  }
  const task = cron.schedule(cronExpr, async () => {
    try {
      await run(key);
      console.log(`[scheduler] ${label} completed for db ${key}`);
    } catch (err) {
      console.error(`[scheduler] ${label} failed for db ${key}:`, err.message);
    }
  });
  jobMap.set(key, task);
}

function unschedule(jobMap, dbId) {
  const key = String(dbId);
  const task = jobMap.get(key);
  if (task) {
    task.stop();
    jobMap.delete(key);
  }
}

export function scheduleBaseBackups(dbId, cronExpr) {
  schedule(backupJobs, dbId, cronExpr, "base backup", (id) => runBaseBackup(id));
}

export function unscheduleBaseBackups(dbId) {
  unschedule(backupJobs, dbId);
}

export function scheduleTestRestores(dbId, cronExpr) {
  schedule(testRestoreJobs, dbId, cronExpr, "test-restore", (id) => runScheduledTestRestore(id));
}

export function unscheduleTestRestores(dbId) {
  unschedule(testRestoreJobs, dbId);
}

function startRetentionSweep() {
  if (retentionSweepJob) retentionSweepJob.stop();
  retentionSweepJob = cron.schedule(config.retentionSweepCron, async () => {
    const dbs = await listDatabases();
    for (const dbRecord of dbs.filter((d) => d.retention)) {
      try {
        const result = await pruneDatabase(dbRecord._id);
        console.log(`[scheduler] retention sweep for db ${dbRecord._id}:`, result);
      } catch (err) {
        console.error(`[scheduler] retention sweep failed for db ${dbRecord._id}:`, err.message);
      }
    }
  });
}

// Resumes every registered database's schedules on process startup — mirrors
// captureManager's restart-safety so a restart doesn't silently stop cron jobs.
export async function startAllSchedules() {
  const dbs = await listDatabases();
  for (const dbRecord of dbs) {
    if (dbRecord.scheduleCron) {
      scheduleBaseBackups(dbRecord._id, dbRecord.scheduleCron);
    }
    if (dbRecord.testRestoreTargetUriEnc) {
      scheduleTestRestores(dbRecord._id, dbRecord.testRestoreCron || config.testRestoreDefaultCron);
    }
  }
  startRetentionSweep();
}

export function stopAllSchedules() {
  for (const key of [...backupJobs.keys()]) unscheduleBaseBackups(key);
  for (const key of [...testRestoreJobs.keys()]) unscheduleTestRestores(key);
  if (retentionSweepJob) {
    retentionSweepJob.stop();
    retentionSweepJob = null;
  }
}
