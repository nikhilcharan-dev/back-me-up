import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (err.code === "ENOENT") {
        reject(
          new Error(
            `${command} not found on PATH. Install mongodb-database-tools locally, or run this service via its Docker image which bundles them.`
          )
        );
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

export async function mongodump({ uri, outDir }) {
  await fs.mkdir(outDir, { recursive: true });
  await run("mongodump", ["--uri", uri, "--out", outDir, "--gzip"]);
}

// dumpDir must point directly at the directory containing the .bson.gz files
// (i.e. <outDir>/<sourceDbName>), not the top-level dump directory.
export async function mongorestore({ uri, dumpDir, dbName }) {
  await run("mongorestore", ["--uri", uri, "--gzip", "--db", dbName, dumpDir]);
}

export async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

// mongodump writes both <collection>.bson.gz and <collection>.metadata.json.gz per
// collection — filter to the data files to get the collection name list.
export async function listCollectionFiles(dbDumpDir) {
  const entries = await fs.readdir(dbDumpDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".bson.gz"))
    .map((e) => e.name.replace(/\.bson\.gz$/, ""));
}

export function collectionFilePath(dbDumpDir, collectionName) {
  return path.join(dbDumpDir, `${collectionName}.bson.gz`);
}
