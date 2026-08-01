import { MongoClient } from "mongodb";
import { config } from "../config/env.js";
import { encrypt } from "../lib/crypto.js";
import { extractDbName } from "../lib/mongoUri.js";
import { insertDatabase, listDatabases, findDatabaseById, updateDatabase } from "../repositories/databasesRepo.js";
import { insertAuditEntry } from "../repositories/auditRepo.js";

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
    scheduleCron,
    retention,
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

  await updateDatabase(dbId, { retention, updatedAt: new Date() });
  await insertAuditEntry({ actor: "api", action: "set-retention-policy", dbId, detail: retention });
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
