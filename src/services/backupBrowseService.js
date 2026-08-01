import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { EJSON, ObjectId } from "bson";
import { config } from "../config/env.js";
import { findBaseBackupById } from "../repositories/backupsRepo.js";
import { listCollectionFiles } from "../lib/mongoTools.js";
import { iterateDumpedDocuments, collectionDumpDir, collectionDumpPath } from "../lib/bsonDump.js";

export const PAGE_SIZE_OPTIONS = [25, 50, 100];
const DEFAULT_PAGE_SIZE = 25;

// Documents are matched, displayed and exported as *relaxed* Extended JSON so that
// what you search is exactly what you see on screen and in the JSON download —
// canonical EJSON would render a date as {"$date":{"$numberLong":"1720511530000"}},
// which nobody can search for. The .bson.gz download stays the byte-exact,
// type-preserving copy (see the format=bson export below).
function toDisplayJson(doc, indent) {
  return EJSON.stringify(doc, null, indent);
}

function formatDocId(id) {
  if (id === undefined) return "(no _id)";
  if (id === null) return "null";
  if (typeof id === "string" || typeof id === "number" || typeof id === "bigint") return String(id);
  if (id instanceof ObjectId) return id.toHexString();
  return EJSON.stringify(id);
}

// Loads a completed backup and the collections actually sitting in its dump
// directory. The on-disk listing — not the catalog record — is what later calls
// validate a requested collection name against, so a crafted `..%2Fetc%2Fpasswd`
// name can never reach the filesystem.
export async function openBackup(backupId) {
  if (!ObjectId.isValid(backupId)) return null;

  const backup = await findBaseBackupById(backupId);
  if (!backup) return null;

  const recorded = new Map((backup.collections ?? []).map((c) => [c.name, c]));
  const dumpDir = collectionDumpDir(backup);

  let names = [];
  let filesMissing = false;
  try {
    names = await listCollectionFiles(dumpDir);
  } catch {
    // Pruned by retention, or the dump never finished — fall back to the catalog
    // record so the page can still explain what *used* to be here.
    filesMissing = true;
    names = [...recorded.keys()];
  }

  const collections = names.sort((a, b) => a.localeCompare(b)).map((name) => {
    const meta = recorded.get(name) ?? {};
    return {
      name,
      sizeBytes: meta.sizeBytes ?? null,
      docCount: meta.docCount ?? null,
      checksumSha256: meta.checksumSha256 ?? null,
      available: !filesMissing,
    };
  });

  return { backup, dumpDir, collections, filesMissing };
}

// Resolves a user-supplied collection name against the browsable backup, returning
// its dump path only when it's a real entry in that backup.
export async function openCollection(backupId, collectionName) {
  const opened = await openBackup(backupId);
  if (!opened) return null;

  const collection = opened.collections.find((c) => c.name === collectionName);
  if (!collection || !collection.available) return null;

  return { ...opened, collection, filePath: collectionDumpPath(opened.backup, collectionName) };
}

export function normalizePageSize(raw) {
  const size = Number(raw);
  return PAGE_SIZE_OPTIONS.includes(size) ? size : DEFAULT_PAGE_SIZE;
}

export function normalizePage(raw) {
  const page = Number(raw);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

// Reads one page of documents out of a dumped collection. Scanning is linear (a
// BSON dump has no index), so it's bounded by config.browseScanLimit: past that we
// stop and flag the counts as partial rather than tie up the server.
export async function readCollectionPage({ filePath, q = "", page = 1, pageSize = DEFAULT_PAGE_SIZE }) {
  const needle = q.trim().toLowerCase();
  const firstOrdinal = (page - 1) * pageSize + 1;
  const lastOrdinal = page * pageSize;

  const documents = [];
  let scanned = 0;
  let matched = 0;
  let scanTruncated = false;

  for await (const doc of iterateDumpedDocuments(filePath)) {
    scanned += 1;

    if (needle && !toDisplayJson(doc).toLowerCase().includes(needle)) {
      if (scanned >= config.browseScanLimit) {
        scanTruncated = true;
        break;
      }
      continue;
    }

    matched += 1;
    if (matched >= firstOrdinal && matched <= lastOrdinal) {
      documents.push({ ordinal: matched, id: formatDocId(doc._id), json: toDisplayJson(doc, 2) });
    }

    if (scanned >= config.browseScanLimit) {
      scanTruncated = true;
      break;
    }
  }

  return {
    documents,
    page,
    pageSize,
    matched,
    scanned,
    scanTruncated,
    hasPrev: page > 1,
    hasNext: matched > lastOrdinal,
    totalPages: Math.max(1, Math.ceil(matched / pageSize)),
  };
}

// Streams the whole collection (optionally filtered by the same search term as the
// browser) as a JSON array, one document per line. Deliberately uncapped and
// streamed — an export should be complete, and it never buffers the collection.
export function createJsonExportStream({ filePath, q = "" }) {
  const needle = q.trim().toLowerCase();

  return Readable.from(
    (async function* () {
      yield "[\n";
      let first = true;
      for await (const doc of iterateDumpedDocuments(filePath)) {
        const json = toDisplayJson(doc);
        if (needle && !json.toLowerCase().includes(needle)) continue;
        yield first ? json : `,\n${json}`;
        first = false;
      }
      yield "\n]\n";
    })()
  );
}

export async function collectionFileSize(filePath) {
  try {
    return (await fs.stat(filePath)).size;
  } catch {
    return null;
  }
}

export function exportFileName(backup, collectionName, extension) {
  const stamp = path.posix.basename(backup.storageKey);
  return `${backup.dbName}-${collectionName}-${stamp}.${extension}`;
}
