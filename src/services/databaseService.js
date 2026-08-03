import { MongoClient } from "mongodb";
import cron from "node-cron";
import { config } from "../config/env.js";
import { encrypt } from "../lib/crypto.js";
import { extractDbName } from "../lib/mongoUri.js";
import { insertDatabase, listDatabases, findDatabaseById, updateDatabase } from "../repositories/databasesRepo.js";
import { insertAuditEntry } from "../repositories/auditRepo.js";

// Tier is informational metadata — nothing branches on it — but it's the fastest
// way to see which registrations are on a shared Atlas tier, where change streams
// are the only PITR mechanism available (docs/PITR-DESIGN.md §5). Self-hosted
// deployments get their own value rather than being filed under "unknown".
export const DATABASE_TIERS = [
  { value: "unknown", label: "Unknown / not sure" },
  { value: "M0", label: "M0 (Atlas free)" },
  { value: "M2", label: "M2 (Atlas shared)" },
  { value: "M5", label: "M5 (Atlas shared)" },
  { value: "M10", label: "M10+ (Atlas dedicated)" },
  { value: "self-hosted", label: "Self-hosted / on-prem" },
];

export function isKnownTier(tier) {
  return DATABASE_TIERS.some((t) => t.value === tier);
}

// Counts, not days: "keep the newest backup per hour/day/week bucket, going
// back this many buckets" (see retentionService.computeGfsKeepSet). Bounded
// well above any realistic policy so a typo doesn't silently create an
// effectively-unlimited retention window.
export const RETENTION_MAX = 1000;
const RETENTION_FIELDS = ["hourly", "daily", "weekly"];

// Shared by registerDatabase() and setRetentionPolicy() so a policy can't be
// saved from either path without being validated. Returns null for "no
// policy" (all-zero/blank), which downstream code already treats as "keep
// every backup forever."
export function validateRetention(retention) {
  if (retention === null || retention === undefined) return null;

  const out = {};
  for (const field of RETENTION_FIELDS) {
    const raw = retention[field];
    if (raw === undefined || raw === null || raw === "") {
      out[field] = 0;
      continue;
    }
    const num = Number(raw);
    if (!Number.isInteger(num) || num < 0 || num > RETENTION_MAX) {
      throw new Error(
        `Retention "${field}" must be a whole number between 0 and ${RETENTION_MAX} (got "${raw}").`
      );
    }
    out[field] = num;
  }

  if (out.hourly === 0 && out.daily === 0 && out.weekly === 0) return null;
  return out;
}

// Blank means "no schedule"; anything else has to be a cron expression node-cron
// will actually accept, otherwise the schedule is silently never registered.
function normalizeCron(expr) {
  const trimmed = (expr ?? "").toString().trim();
  if (!trimmed) return null;
  if (!cron.validate(trimmed)) {
    throw new Error(`"${trimmed}" is not a valid cron expression (five or six fields, e.g. "0 * * * *").`);
  }
  return trimmed;
}

export async function testConnection(uri) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
  } finally {
    await client.close();
  }
}

export async function registerDatabase({
  name,
  connectionUri,
  tier = "unknown",
  tags = [],
  scheduleCron = null,
  retention = null,
  pitrEnabled = false,
  testRestoreTargetUri = null,
  testRestoreCron = null,
}) {
  const dbName = extractDbName(connectionUri);
  const normalizedCron = normalizeCron(scheduleCron);
  const normalizedRetention = validateRetention(retention);
  await testConnection(connectionUri);

  if (testRestoreTargetUri) {
    await testConnection(testRestoreTargetUri);
  }

  const doc = {
    name,
    dbName,
    connectionUriEnc: encrypt(connectionUri, config.masterKey),
    tier,
    tags,
    scheduleCron: normalizedCron,
    retention: normalizedRetention,
    pitrEnabled,
    testRestoreTargetUriEnc: testRestoreTargetUri ? encrypt(testRestoreTargetUri, config.masterKey) : null,
    testRestoreCron,
    captureStatus: "stopped",
    lastBaseAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const saved = await insertDatabase(doc);
  await insertAuditEntry({ actor: "api", action: "register-database", dbId: saved._id, detail: { name, tier, pitrEnabled } });
  return toPublicDatabase(saved);
}

// Strips encrypted fields before a record leaves the service layer.
export function toPublicDatabase(doc) {
  const { connectionUriEnc, testRestoreTargetUriEnc, ...rest } = doc;
  return { ...rest, testRestoreTargetConfigured: Boolean(testRestoreTargetUriEnc) };
}

export async function listRegisteredDatabases() {
  const docs = await listDatabases();
  return docs.map(toPublicDatabase);
}

// Returns the full internal record (including encrypted fields) for callers
// that need to decrypt them, e.g. the backup/restore services. Route handlers
// should use toPublicDatabase() before sending a response.
export async function getRegisteredDatabase(id) {
  return findDatabaseById(id);
}

// Edits the metadata a registration can safely change after the fact. Deliberately
// excludes the connection URL — that goes through rotateConnectionUri(), which
// enforces that the new URL still points at the same database, since repointing a
// registration would orphan the backup history already filed under it.
export async function updateDatabaseSettings(dbId, { name, tier, tags, scheduleCron, pitrEnabled }) {
  const dbRecord = await findDatabaseById(dbId);
  if (!dbRecord) throw new Error(`No registered database with id ${dbId}`);
  if (dbRecord.deletedAt) throw new Error(`Database ${dbId} has been unregistered`);

  const trimmedName = (name ?? "").toString().trim();
  if (!trimmedName) throw new Error("Name is required.");

  const update = {
    name: trimmedName,
    tier: (tier ?? "").toString().trim() || "unknown",
    tags: Array.isArray(tags) ? tags : [],
    scheduleCron: normalizeCron(scheduleCron),
    pitrEnabled: Boolean(pitrEnabled),
    updatedAt: new Date(),
  };

  try {
    await updateDatabase(dbId, update);
  } catch (err) {
    // registered_databases.name is uniquely indexed, and unregistering is a soft
    // delete — so a "taken" name may belong to a database that's no longer listed.
    if (err.code === 11000) {
      throw new Error(`The name "${trimmedName}" is already taken by another registration.`);
    }
    throw err;
  }

  await insertAuditEntry({
    actor: "api",
    action: "update-database",
    dbId: dbRecord._id,
    detail: {
      name: update.name,
      tier: update.tier,
      scheduleCron: update.scheduleCron,
      pitrEnabled: update.pitrEnabled,
      tags: update.tags,
    },
  });
  return getRegisteredDatabase(dbId);
}

export async function rotateConnectionUri(dbId, newUri) {
  const dbRecord = await findDatabaseById(dbId);
  if (!dbRecord) throw new Error(`No registered database with id ${dbId}`);

  const newDbName = extractDbName(newUri);
  if (newDbName !== dbRecord.dbName) {
    throw new Error(
      `New URI's database name ("${newDbName}") must match the existing one ("${dbRecord.dbName}") — rotate credentials, not the target database`
    );
  }
  await testConnection(newUri);

  await updateDatabase(dbId, { connectionUriEnc: encrypt(newUri, config.masterKey), updatedAt: new Date() });
  await insertAuditEntry({ actor: "api", action: "rotate-uri", dbId });
  return getRegisteredDatabase(dbId);
}

export async function setTestRestoreTarget(dbId, targetUri, cronExpr = null) {
  const dbRecord = await findDatabaseById(dbId);
  if (!dbRecord) throw new Error(`No registered database with id ${dbId}`);

  await testConnection(targetUri);
  await updateDatabase(dbId, {
    testRestoreTargetUriEnc: encrypt(targetUri, config.masterKey),
    testRestoreCron: cronExpr,
    updatedAt: new Date(),
  });
  await insertAuditEntry({ actor: "api", action: "set-test-restore-target", dbId });
  return getRegisteredDatabase(dbId);
}

export async function setRetentionPolicy(dbId, retention) {
  const dbRecord = await findDatabaseById(dbId);
  if (!dbRecord) throw new Error(`No registered database with id ${dbId}`);

  const normalized = validateRetention(retention);
  await updateDatabase(dbId, { retention: normalized, updatedAt: new Date() });
  await insertAuditEntry({ actor: "api", action: "set-retention-policy", dbId, detail: normalized });
  return getRegisteredDatabase(dbId);
}

// Soft delete: hides the database from listDatabases() (so capture-resume and
// scheduler-resume both stop touching it) without deleting its existing base
// backups or change slices — those remain recoverable.
export async function softDeleteDatabase(dbId) {
  const dbRecord = await findDatabaseById(dbId);
  if (!dbRecord) throw new Error(`No registered database with id ${dbId}`);

  await updateDatabase(dbId, { deletedAt: new Date(), updatedAt: new Date() });
  await insertAuditEntry({ actor: "api", action: "unregister-database", dbId });
}
