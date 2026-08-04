import { MongoClient, ObjectId } from "mongodb";
import { config } from "../config/env.js";
import { decrypt } from "../lib/crypto.js";
import { toPlainClusterTime } from "../lib/clusterTime.js";
import { findDatabaseById, updateDatabase } from "../repositories/databasesRepo.js";
import { insertChangeSlice } from "../repositories/changeSlicesRepo.js";
import { writeSlice } from "./sliceWriter.js";
import { insertAuditEntry } from "../repositories/auditRepo.js";
import { continuityBreakTotal } from "../metrics/registry.js";

const FLUSH_INTERVAL_MS = 5000;
const MAX_BATCH_SIZE = 500;

// Resume-token-expired errors vary by server version/driver; match broadly on the
// documented codeName/message rather than a single numeric code. See
// docs/PITR-DESIGN.md §5.2 — this is the top risk on shared Atlas tiers.
function isContinuityBreak(err) {
  return (
    err?.codeName === "ChangeStreamHistoryLost" ||
    err?.code === 286 ||
    /resume point may no longer be in the oplog|the resume token .* was not found|ChangeStreamHistoryLost/i.test(
      err?.message ?? ""
    )
  );
}

// One worker per registered database. Owns a single db-scoped change stream
// (docs/DECISIONS.md D5), buffers events, and flushes them to gzipped NDJSON
// slices on a timer or batch-size trigger, persisting the resume token after
// every flush so a restart resumes with zero loss (within the oplog window).
export class CaptureWorker {
  constructor(dbId, { onContinuityBreak } = {}) {
    this.dbId = String(dbId);
    this.onContinuityBreak = onContinuityBreak;
    this.buffer = [];
    this.client = null;
    this.changeStream = null;
    this.flushTimer = null;
    this.stopped = false;
  }

  async start() {
    const dbRecord = await findDatabaseById(this.dbId);
    if (!dbRecord) throw new Error(`No registered database with id ${this.dbId}`);
    if (dbRecord.deletedAt) throw new Error(`Database ${this.dbId} has been unregistered`);

    const connectionUri = decrypt(dbRecord.connectionUriEnc, config.masterKey);
    this.client = new MongoClient(connectionUri);
    await this.client.connect();
    const sourceDb = this.client.db(dbRecord.dbName);

    const watchOptions = { fullDocument: "updateLookup" };
    if (dbRecord.resumeTokenRef) {
      watchOptions.resumeAfter = dbRecord.resumeTokenRef;
    }

    try {
      this.changeStream = sourceDb.watch([], watchOptions);
    } catch (err) {
      await this.handleError(err);
      throw err;
    }

    // An open cursor guarantees no subsequent write is missed, even before the
    // first event is consumed (resumeToken is null until then) — this is what
    // base backups rely on for the capture-before-dump invariant (PITR-DESIGN §2).
    // captureLastError is cleared here too: a fresh start that gets this far has
    // cleared whatever previously killed the stream, so a stale message shouldn't
    // keep showing on the database page.
    await updateDatabase(this.dbId, { captureStatus: "running", captureLastError: null, updatedAt: new Date() });

    this.changeStream.on("change", (event) => this.handleEvent(event));
    this.changeStream.on("error", (err) => {
      this.handleError(err).catch((e) => console.error(`[capture:${this.dbId}] error handler failed:`, e.message));
    });
    this.changeStream.on("close", () => {
      if (!this.stopped) {
        updateDatabase(this.dbId, { captureStatus: "stopped", updatedAt: new Date() }).catch(() => {});
      }
    });

    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => console.error(`[capture:${this.dbId}] flush error:`, err.message));
    }, FLUSH_INTERVAL_MS);
  }

  handleEvent(event) {
    const ct = toPlainClusterTime(event.clusterTime);
    const normalized = {
      ct,
      ns: `${event.ns.db}.${event.ns.coll}`,
      op: event.operationType,
      k: event.documentKey,
      doc: event.fullDocument ?? null,
      upd:
        event.operationType === "update"
          ? { set: event.updateDescription?.updatedFields ?? {}, unset: event.updateDescription?.removedFields ?? [] }
          : undefined,
    };
    this.buffer.push({ normalized, resumeToken: event._id });

    if (this.buffer.length >= MAX_BATCH_SIZE) {
      this.flush().catch((err) => console.error(`[capture:${this.dbId}] flush error:`, err.message));
    }
  }

  async flush() {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];

    const events = batch.map((b) => b.normalized);
    const fromClusterTs = events[0].ct;
    const toClusterTs = events[events.length - 1].ct;
    const lastResumeToken = batch[batch.length - 1].resumeToken;

    const { storageKey, sizeBytes, eventCount } = await writeSlice({
      dbId: this.dbId,
      fromClusterTs,
      toClusterTs,
      events,
    });

    await insertChangeSlice({
      dbId: new ObjectId(this.dbId),
      fromClusterTs,
      toClusterTs,
      storageKey,
      eventCount,
      sizeBytes,
      createdAt: new Date(),
    });

    await updateDatabase(this.dbId, {
      resumeTokenRef: lastResumeToken,
      lastCaptureTs: toClusterTs,
      updatedAt: new Date(),
    });
  }

  async handleError(err) {
    console.error(`[capture:${this.dbId}] change stream error:`, err.stack || err.message);
    const broken = isContinuityBreak(err);
    // First few stack frames, not just the message — a bare message like
    // "Cannot read properties of undefined (reading 'db')" is meaningless
    // without knowing which line threw it, and the DB record is currently the
    // only place this ever surfaces (no server-log access on this deployment).
    const errorDetail = (err.stack || err.message || String(err)).split("\n").slice(0, 6).join("\n");

    await this.stopInternal();

    if (broken) {
      continuityBreakTotal.inc({ db_id: this.dbId });
      // The server has already declared this resume point invalid, so clearing
      // it here is what lets the retry below (or a later manual "Start capture")
      // open a clean change stream instead of resuming from the same token and
      // hitting ChangeStreamHistoryLost again immediately.
      await updateDatabase(this.dbId, {
        captureStatus: "continuity_break",
        captureLastError: errorDetail,
        resumeTokenRef: null,
        updatedAt: new Date(),
      });
      console.error(
        `[ALERT] Capture continuity break for db ${this.dbId} — resume token expired, capture cannot resume without a new base backup.`
      );
      if (this.onContinuityBreak) {
        await this.onContinuityBreak(this.dbId);
      }
    } else {
      await updateDatabase(this.dbId, { captureStatus: "stopped", captureLastError: errorDetail, updatedAt: new Date() });
      // Unlike the continuity-break path (whose onContinuityBreak callback always
      // audits its own outcome), a plain stream error had no audit trail at all
      // before this — it just went silent in captureStatus with nothing to show
      // for it short of server console logs.
      await insertAuditEntry({
        actor: "system",
        action: "capture-error",
        dbId: this.dbId,
        detail: { error: err.message, code: err.code ?? null, codeName: err.codeName ?? null },
      }).catch(() => {});
    }
  }

  async stop() {
    this.stopped = true;
    await this.stopInternal();
    await updateDatabase(this.dbId, { captureStatus: "stopped", updatedAt: new Date() });
  }

  // The change stream can die on its own — a network blip, cursor timeout, or
  // continuity break all tear down the worker via handleError()/the "close"
  // listener, not via stop(). captureManager uses this to tell a worker that's
  // still doing its job apart from one that's a corpse left behind in its map.
  isRunning() {
    return !this.stopped;
  }

  async stopInternal() {
    this.stopped = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;

    try {
      await this.flush();
    } catch (err) {
      console.error(`[capture:${this.dbId}] final flush error:`, err.message);
    }

    if (this.changeStream) {
      try {
        await this.changeStream.close();
      } catch {
        // already closed
      }
      this.changeStream = null;
    }
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // already closed
      }
      this.client = null;
    }
  }
}
