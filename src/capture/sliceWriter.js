import zlib from "node:zlib";
import fs from "node:fs/promises";
import path from "node:path";
import { EJSON } from "bson";
import { config } from "../config/env.js";

// A slice is a gzipped NDJSON batch of normalized change events, one line per event.
// Layout matches docs/DATA-MODEL.md: {dbId}/changes/<fromT>-<fromI>--<toT>-<toI>.ndjson.gz
//
// Uses BSON Extended JSON, not plain JSON: events carry real BSON values
// (ObjectId documentKeys, Dates, etc.) and plain JSON.stringify/parse silently
// downgrades an ObjectId to a string, which then fails to match anything when
// replayed as a query filter against real BSON-typed documents.
export async function writeSlice({ dbId, fromClusterTs, toClusterTs, events }) {
  const ndjson = events.map((e) => EJSON.stringify(e)).join("\n") + "\n";
  const gz = zlib.gzipSync(Buffer.from(ndjson, "utf8"));

  const fileName = `${fromClusterTs.t}-${fromClusterTs.i}--${toClusterTs.t}-${toClusterTs.i}.ndjson.gz`;
  const storageKey = path.posix.join(String(dbId), "changes", fileName);
  const filePath = path.join(config.storageRoot, storageKey);

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, gz);

  return { storageKey, sizeBytes: gz.length, eventCount: events.length };
}

export async function readSlice(storageKey) {
  const filePath = path.join(config.storageRoot, storageKey);
  const gz = await fs.readFile(filePath);
  const ndjson = zlib.gunzipSync(gz).toString("utf8");
  return ndjson
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => EJSON.parse(line));
}
