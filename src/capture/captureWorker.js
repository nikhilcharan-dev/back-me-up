import { MongoClient, ObjectId, Timestamp } from "mongodb";
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

// A resume token whose `_data` hex-encodes a `dropDatabase` or `invalidate`
// operationType is un-resumable on a database-scoped watch: the server
// invalidated the cursor at that point, so resumeAfter just gives an
// immediate close/error. Detect this by scanning the token's hex for the
// known operationType strings that MongoDB encodes verbatim in the v1 token
// format (documented in the change-stream spec).
const INVALIDATING_OPS_IN_TOKEN = [
  Buffer.from("dropDatabase").toString("hex"),
  Buffer.from("invalidate").toString("hex"),
];

function isInvalidatingResumeToken(resumeTokenRef) {
  if (!resumeTokenRef?._data) return false;
  const hex = resumeTokenRef._data.toLowerCase();
  return INVALIDATING_OPS_IN_TOKEN.some((pattern) => hex.includes(pattern));
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

    // If the persisted resume token came from an invalidating event (e.g. the
    // watched database was dropped), resumeAfter will fail immediately — the
    // cursor was already dead at that oplog point. Instead of opening a fully
    // fresh stream (which loses every event since capture died), try
    // startAtOperationTime with the last captured cluster timestamp — this
    // reads the oplog from that exact point, recovering the gap if the oplog
    // still has it. Only falls back to a fully fresh stream if even that fails.
    let useResumeToken = dbRecord.resumeTokenRef;
    if (useResumeToken && isInvalidatingResumeToken(useResumeToken)) {
      console.warn(
        `[capture:${this.dbId}] resume token points to an invalidating event (dropDatabase/invalidate) — will try startAtOperationTime instead`
      );
      useResumeToken = null;
      await updateDatabase(this.dbId, { resumeTokenRef: null, updatedAt: new Date() });
    }

    this.changeStream = await this._openChangeStream(sourceDb, useResumeToken, dbRecord.lastCaptureTs);
  }

  // Opens the change stream, probing the cursor to fail-fast on bad tokens.
  // Fallback chain:  resumeAfter → startAtOperationTime → fresh (no position).
  // This ensures we recover gap events whenever the oplog still has them,
  // instead of unconditionally discarding history.
  async _openChangeStream(sourceDb, resumeToken, lastCaptureTs) {
    const watchOptions = { fullDocument: "updateLookup" };
    if (resumeToken) {
      watchOptions.resumeAfter = resumeToken;
    } else if (lastCaptureTs?.t) {
      // No usable token, but we know the last captured cluster time. Use
      // startAtOperationTime to resume from that exact oplog position — this
      // replays every event since capture died, closing the gap with zero
      // data loss (as long as the oplog hasn't rolled past this point).
      watchOptions.startAtOperationTime = new Timestamp({ t: lastCaptureTs.t, i: lastCaptureTs.i ?? 0 });
    }

    let cs;
    try {
      cs = sourceDb.watch([], watchOptions);
      // Bad resume tokens / expired oplog positions surface as an "error" or
      // "close" event almost immediately (within one server round-trip). We
      // cannot use hasNext() because it blocks indefinitely on a tailable
      // cursor when the DB is quiet. Instead, race a short timer against the
      // first error/close event: if the cursor survives 2 s it's very likely
      // good.
      await this._probeCursor(cs);
    } catch (err) {
      try { await cs?.close(); } catch { /* already dead */ }

      // Fallback 1: if we used resumeAfter and it failed, try
      // startAtOperationTime with the last captured cluster time.
      if (resumeToken) {
        console.warn(
          `[capture:${this.dbId}] resume token failed (${err.message}) — falling back to startAtOperationTime`
        );
        await updateDatabase(this.dbId, { resumeTokenRef: null, updatedAt: new Date() });
        return this._openChangeStream(sourceDb, null, lastCaptureTs);
      }

      // Fallback 2: if we used startAtOperationTime and it failed too (oplog
      // rolled past that point), open a completely fresh stream from now.
      if (lastCaptureTs?.t) {
        console.warn(
          `[capture:${this.dbId}] startAtOperationTime failed (${err.message}) — oplog may have rolled past last capture; opening fresh stream (gap in change history is unavoidable)`
        );
        return this._openChangeStream(sourceDb, null, null);
      }

      // No fallbacks left — genuine connection/permission issue.
      await this.handleError(err);
      throw err;
    }

    // Cursor is live and validated — commit it.
    this.changeStream = cs;

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
      // A cursor can close on its own (idle connection reaped by the server,
      // network drop) without ever emitting "error" first. This used to only
      // update captureStatus and leave `this.stopped` false — so the worker
      // stayed "running" in captureManager's map forever: isRunning() kept
      // returning true, isCaptureRunning() agreed, and a later "Start capture"
      // just handed back this same dead worker instead of opening a fresh
      // stream. stopInternal() also clears the flush timer and closes the
      // MongoClient, which this leaked before too.
      if (this.stopped) return;
      this.stopInternal()
        .then(() => updateDatabase(this.dbId, { captureStatus: "stopped", updatedAt: new Date() }))
        .catch((e) => console.error(`[capture:${this.dbId}] close cleanup failed:`, e.message));
    });

    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => console.error(`[capture:${this.dbId}] flush error:`, err.message));
    }, FLUSH_INTERVAL_MS);

    return cs;
  }

  // Waits up to 2 s for the cursor to die. A bad resume token or expired
  // oplog position causes an error/close almost instantly (one server round-
  // trip). If nothing goes wrong in that window the cursor is live.
  _probeCursor(cs) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cs.removeListener("error", onErr);
        cs.removeListener("close", onClose);
        resolve();
      }, 2000);
      function onErr(err) {
        clearTimeout(timeout);
        cs.removeListener("close", onClose);
        reject(err);
      }
      function onClose() {
        clearTimeout(timeout);
        cs.removeListener("error", onErr);
        reject(new Error("ChangeStream closed immediately — resume position may be invalid"));
      }
      cs.once("error", onErr);
      cs.once("close", onClose);
    });
  }

  // replayService.applyEvent() only understands insert/update/replace/delete —
  // its default case already documents drop/rename/dropDatabase/invalidate as
  // out of scope. That filtering was never actually done here, though: every
  // admin/DDL event was normalized unconditionally, and invalidate (fired when
  // the watched database itself is dropped — has no `ns` at all) crashed this
  // handler outright, tearing down capture on what should've been a no-op.
  static CAPTURED_OPS = new Set(["insert", "update", "replace", "delete"]);

  handleEvent(event) {
    if (!CaptureWorker.CAPTURED_OPS.has(event.operationType)) return;

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
      // Calling close() on a stream that's already closed itself (e.g. we got
      // here from the stream's own "close" event) can race the driver's
      // internal cleanup and throw "ChangeStream is closed" from deep inside
      // its readable-stream plumbing — outside this try/catch, since it
      // surfaces asynchronously via the stream's own "error" event rather
      // than as a rejection of this call. .closed is a real getter the driver
      // exposes for exactly this check.
      if (!this.changeStream.closed) {
        try {
          await this.changeStream.close();
        } catch {
          // already closed
        }
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
