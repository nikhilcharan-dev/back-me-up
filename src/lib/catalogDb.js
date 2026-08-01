import { MongoClient } from "mongodb";
import { config } from "../config/env.js";

let client;
let db;

export async function connectCatalog() {
  if (db) return db;
  client = new MongoClient(config.catalogMongoUri);
  await client.connect();
  db = client.db();
  await ensureIndexes(db);
  return db;
}

async function ensureIndexes(database) {
  await database.collection("registered_databases").createIndex({ name: 1 }, { unique: true });
  await database.collection("base_backups").createIndex({ dbId: 1, startedAt: -1 });
  await database.collection("restore_jobs").createIndex({ dbId: 1, createdAt: -1 });
  await database.collection("change_slices").createIndex({ dbId: 1, "fromClusterTs.t": 1, "fromClusterTs.i": 1 });
  await database.collection("audit_log").createIndex({ dbId: 1, at: -1 });
  await database.collection("audit_log").createIndex({ at: -1 });
  await database.collection("test_restore_runs").createIndex({ dbId: 1, ranAt: -1 });
  await database.collection("users").createIndex({ username: 1 }, { unique: true });
}

export function getCatalogDb() {
  if (!db) throw new Error("Catalog DB not connected yet — call connectCatalog() at startup");
  return db;
}

export async function closeCatalog() {
  if (client) await client.close();
}
