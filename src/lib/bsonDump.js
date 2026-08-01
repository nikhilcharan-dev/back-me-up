import { createReadStream } from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { deserialize } from "bson";
import { config } from "../config/env.js";

// MongoDB's own 16 MB document ceiling, plus slack for the BSON framing overhead
// mongodump can add. Anything larger than this in a length prefix means we've lost
// framing (truncated/corrupt dump) rather than hit a genuinely huge document.
const MAX_BSON_DOC_SIZE = 16 * 1024 * 1024 + 16 * 1024;

export function collectionDumpDir(backup) {
  return path.join(config.storageRoot, backup.storageKey, backup.dbName);
}

export function collectionDumpPath(backup, collectionName) {
  return path.join(collectionDumpDir(backup), `${collectionName}.bson.gz`);
}

// mongodump --gzip writes a collection as gzipped, back-to-back BSON documents with
// no container framing: each document is its own 4-byte little-endian length prefix
// followed by that many bytes total. Stream the gunzip and slice documents off as
// their prefixes complete, so browsing a multi-GB collection never buffers more than
// the tail of the current chunk. Breaking out of the loop destroys the read stream.
export async function* iterateDumpedDocuments(filePath) {
  const gunzip = createReadStream(filePath).pipe(zlib.createGunzip());
  let buffered = Buffer.alloc(0);

  for await (const chunk of gunzip) {
    buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);

    let offset = 0;
    while (buffered.length - offset >= 4) {
      const size = buffered.readInt32LE(offset);
      if (size < 5 || size > MAX_BSON_DOC_SIZE) {
        throw new Error(
          `Corrupt BSON in ${path.basename(filePath)}: implausible document length ${size} at byte ${offset}`
        );
      }
      if (buffered.length - offset < size) break; // wait for the rest of this document
      yield deserialize(buffered.subarray(offset, offset + size));
      offset += size;
    }

    buffered = buffered.subarray(offset);
  }

  if (buffered.length > 0) {
    throw new Error(`Truncated BSON in ${path.basename(filePath)}: ${buffered.length} trailing bytes`);
  }
}
