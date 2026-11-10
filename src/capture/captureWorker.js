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
// How long a "close" with no error and no invalidate may go without the driver
// bringing the stream back before the worker gives up on it. A resume that cannot
// reach the server fails by itself (emitting "error") after the driver's 30 s
// server-selection timeout, so this only has to outlast that.
const STREAM_RESUME_GRACE_MS = 45000;

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
  // onDied(reason) is called once when a started worker stops on its own (stream
  // error, stream ended), never for stop() and never for a failed start() (that
  // one throws to its caller). captureManager restarts it from there.
  constructor(dbId, { onContinuityBreak, onDied } = {}) {
    this.dbId = String(dbId);
    this.onContinuityBreak = onContinuityBreak;
    this.onDied = onDied;
    this.started = false;
    this.explicitStop = false;
    this.diedNotified = false;
    // Why the worker stopped while it was still starting, so start() can throw it.
    this.stopMessage = null;
    // The stream being probed in _openChangeStream, which stopInternal() must be
    // able to close even though it isn't this.changeStream yet.
    this.openingStream = null;
    this.closeWatch = null;
    this.invalidated = false;
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
    this._throwIfStopped();
    const sourceDb = this.client.db(dbRecord.dbName);

    // If the persisted resume token came from an invalidating event (e.g. the
    // watched database was dropped), resumeAfter will fail immediately — the
    // cursor was already dead at that oplog point.
    //
    // Crucially, lastCaptureTs IS the timestamp of the invalidating event
    // itself, so startAtOperationTime would just replay the dropDatabase →
    // invalidate sequence and the driver would close the cursor right back.
    // Clear both the token and the fallback timestamp so _openChangeStream
    // opens a completely fresh stream. The database was dropped — there's
    // nothing useful to replay.
    let useResumeToken = dbRecord.resumeTokenRef;
    let useLastCaptureTs = dbRecord.lastCaptureTs;
    if (useResumeToken && isInvalidatingResumeToken(useResumeToken)) {
      console.warn(
        `[capture:${this.dbId}] resume token points to an invalidating event (dropDatabase/invalidate) — opening fresh stream`
      );
      useResumeToken = null;
      useLastCaptureTs = null;
      await updateDatabase(this.dbId, { resumeTokenRef: null, updatedAt: new Date() });
    }

    this.changeStream = await this._openChangeStream(sourceDb, useResumeToken, useLastCaptureTs);
    // The worker can be stopped (an explicit stop) or die in the gap between the
    // stream going live and here. That's a failed start: the caller must hear
    // about it rather than get a corpse.
    this._throwIfStopped();
    this.started = true;
  }

  _throwIfStopped() {
    if (this.stopped) throw new Error(this.stopMessage ?? "Capture was stopped while it was starting");
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
      this.openingStream = cs;
      // Attached before probing, not after: resuming replays every change made
      // while capture was down, and those arrive within the probe window. A
      // listener that only inspected them (as the probe's does) would consume
      // and discard exactly the gap the resume exists to recover.
      cs.on("change", (event) => this.handleEvent(event));
      // Bad resume tokens / expired oplog positions surface as an "error" or
      // "close" event almost immediately (within one server round-trip). We
      // cannot use hasNext() because it blocks indefinitely on a tailable
      // cursor when the DB is quiet. Instead, race a short timer against the
      // first error/close event: if the cursor survives 2 s it's very likely
      // good.
      await this._probeCursor(cs);
    } catch (err) {
      this.openingStream = null;
      try { await cs?.close(); } catch { /* already dead */ }
      // Whatever this failed cursor delivered is superseded: the next attempt
      // re-reads from the same base position (or deliberately from "now").
      this.buffer = [];

      // The probe failed because the worker itself was stopped mid-start, which
      // closed the client under the stream. That isn't a bad resume position, so
      // none of the fallbacks below apply — they'd also reconnect a client nobody
      // owns.
      this._throwIfStopped();

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
    this.openingStream = null;
    if (this.stopped) {
      try { await cs.close(); } catch { /* already dead */ }
      this._throwIfStopped();
    }
    this.changeStream = cs;
    // Before the await below, not after it: the probe has just detached its own
    // "error" listener, and an "error" event nobody listens for is thrown as an
    // uncaught exception, taking the whole process down.
    this._attachLifecycleListeners(cs);

    // An open cursor guarantees no subsequent write is missed, even before the
    // first event is consumed (resumeToken is null until then) — this is what
    // base backups rely on for the capture-before-dump invariant (PITR-DESIGN §2).
    // captureLastError is cleared here too: a fresh start that gets this far has
    // cleared whatever previously killed the stream, so a stale message shouldn't
    // keep showing on the database page.
    await updateDatabase(this.dbId, { captureStatus: "running", captureLastError: null, updatedAt: new Date() });
    if (this.stopped) return cs; // start() reports it; don't leave a flush timer behind

    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => console.error(`[capture:${this.dbId}] flush error:`, err.message));
    }, FLUSH_INTERVAL_MS);

    return cs;
  }

  _attachLifecycleListeners(cs) {
    cs.on("error", (err) => {
      // Errors after we've stopped on purpose (e.g. the driver's "ChangeStream is
      // closed" for events still in flight) must not overwrite the reason we
      // stopped with a stack trace.
      if (this.stopped) return;
      this.handleError(err).catch((e) => console.error(`[capture:${this.dbId}] error handler failed:`, e.message));
    });
    cs.on("close", () => this._onStreamClose(cs));
  }

  // "close" does NOT mean the stream died. On a resumable error (dropped
  // connection, mongod restart, failover, cursor not found) the driver closes the
  // failed cursor, which emits "close" on the ChangeStream, and then re-opens it
  // from the last token on its own. Verified against a live server: the event
  // arrives within ~100 ms of the drop, ChangeStream.closed is true at that moment,
  // and the stream then goes on delivering with no "error" ever emitted. Tearing
  // the worker down on "close" — which this used to do — killed a healthy,
  // self-healing capture mid-stream and marked it stopped.
  //
  // A stream that is really over announces it differently: "error" when the driver
  // gives up (non-resumable error, or the resume could not reach the server), or an
  // "invalidate" event when the watched database is dropped. So on "close" we only
  // watch: if the driver brings the stream back (closed flips to false) all is
  // well; if it doesn't within the grace period, the stream is dead.
  _onStreamClose(cs) {
    if (this.stopped || this.closeWatch) return;
    if (this.invalidated) {
      this._streamEnded("The watched database was dropped or invalidated, which ends its change stream");
      return;
    }
    console.warn(`[capture:${this.dbId}] change stream closed — waiting for the driver to resume it`);
    const deadline = Date.now() + STREAM_RESUME_GRACE_MS;
    this.closeWatch = setInterval(() => {
      if (this.stopped || this.changeStream !== cs) {
        this._clearCloseWatch();
      } else if (this.invalidated) {
        this._clearCloseWatch();
        this._streamEnded("The watched database was dropped or invalidated, which ends its change stream");
      } else if (!cs.closed) {
        this._clearCloseWatch();
        console.log(`[capture:${this.dbId}] change stream resumed by the driver`);
      } else if (Date.now() >= deadline) {
        this._clearCloseWatch();
        this._streamEnded(
          `The change stream closed and was not resumed within ${STREAM_RESUME_GRACE_MS / 1000}s (the server may have reaped the cursor)`
        );
      }
    }, 250);
  }

  _clearCloseWatch() {
    if (this.closeWatch) clearInterval(this.closeWatch);
    this.closeWatch = null;
  }

  // The stream is over without an "error" to say why (see _onStreamClose).
  async _streamEnded(message) {
    if (this.stopped) return;
    console.warn(`[capture:${this.dbId}] ${message}`);
    try {
      await this.stopInternal();
      await updateDatabase(this.dbId, { captureStatus: "stopped", captureLastError: message, updatedAt: new Date() });
      await insertAuditEntry({ actor: "system", action: "capture-error", dbId: this.dbId, detail: { error: "stream-ended", message } });
    } catch (e) {
      console.error(`[capture:${this.dbId}] close cleanup failed:`, e.message);
    }
    this._notifyDied(message);
  }

  // Tells captureManager the worker stopped on its own so it can restart it. Not
  // for stop(), and not for a failed start() — that one throws to whoever started
  // it, who decides whether to retry.
  _notifyDied(reason) {
    if (this.explicitStop || this.diedNotified) return;
    if (!this.started) {
      this.stopMessage = this.stopMessage ?? reason;
      return;
    }
    this.diedNotified = true;
    try {
      this.onDied?.(reason);
    } catch (e) {
      console.error(`[capture:${this.dbId}] onDied handler failed:`, e.message);
    }
  }

  // Observes the cursor for up to 4 s; it never consumes events (the permanent
  // listener in _openChangeStream handles those). Waits up to 4 s for the cursor
  // to die. A bad resume token or expired oplog position causes an error/close
  // almost instantly (one server round-trip), but on M0 shared tiers the server
  // can be slower. Also catches invalidating change events (dropDatabase,
  // invalidate) that would kill the stream moments later — catching them here
  // triggers the fallback chain instead of silently transitioning to "stopped".
  _probeCursor(cs) {
    return new Promise((resolve, reject) => {
      function cleanup() {
        cs.removeListener("error", onErr);
        cs.removeListener("close", onClose);
        cs.removeListener("change", onChange);
      }
      const timeout = setTimeout(() => {
        cleanup();
        resolve();
      }, 4000);
      function onErr(err) {
        clearTimeout(timeout);
        cleanup();
        reject(err);
      }
      function onClose() {
        clearTimeout(timeout);
        cleanup();
        reject(new Error("ChangeStream closed immediately — resume position may be invalid"));
      }
      function onChange(event) {
        if (event.operationType === "invalidate" || event.operationType === "dropDatabase") {
          clearTimeout(timeout);
          cleanup();
          reject(new Error(`Received ${event.operationType} event — stream will be invalidated`));
        }
        // Normal change events are fine — stream is healthy.
      }
      cs.once("error", onErr);
      cs.once("close", onClose);
      cs.on("change", onChange);
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
    // A stream the worker already gave up on can still deliver what was in flight.
    if (this.stopped) return;
    // Nothing to capture, but it is what tells us the "close" that follows is the
    // real end of the stream and not the driver resuming (see _onStreamClose).
    if (event.operationType === "invalidate") this.invalidated = true;
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
      try {
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
      } finally {
        this._notifyDied(errorDetail);
      }
    }
  }

  async stop() {
    this.explicitStop = true;
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
    this._clearCloseWatch();

    try {
      await this.flush();
    } catch (err) {
      console.error(`[capture:${this.dbId}] final flush error:`, err.message);
    }

    // A stream still being probed by start() isn't this.changeStream yet.
    if (this.openingStream) {
      const opening = this.openingStream;
      this.openingStream = null;
      try { await opening.close(); } catch { /* already closed */ }
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
