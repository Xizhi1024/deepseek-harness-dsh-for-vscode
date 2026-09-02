"use strict";

/**
 * C2.5: edit/write attribution projected from the DSH session event stream.
 *
 * DSH is log-everything: every tool call an agent makes is recorded as a
 * `tool/call` event on the session log and mirrored live on
 * `GET /api/events.mux`. This projector rides that architecture instead of
 * intercepting anything: it
 *
 *   1. performs ONE bounded back-scan per session id (GET /api/session.export
 *      returns a ZIP whose root entry is the session's `session.jsonl`
 *      artifact verbatim; only the trailing MAX_BACKFILL_EVENTS lines are ever
 *      projected), and
 *   2. keeps a long-lived `streamSession` subscription whose `onEvent` seam
 *      forwards every live `tool/call` (text deltas are irrelevant here).
 *
 * Every hit is fed to `changeTracker.recordToolEdit({tool, path, sessionId})`
 * whose (path, sessionId, ±2s) idempotent merge folds the duplicate a C2
 * bridge notification may already have recorded, so double-record is safe.
 *
 * Every entry point is wrapped: a projection failure only logs and never
 * disturbs the subscription or the caller.
 */

const { inflateRawSync } = require("node:zlib");
const { createDshChatClient } = require("./dshChatClient");

/** Hard cap on back-scanned events per session (tail window only). */
const MAX_BACKFILL_EVENTS = 300;
/** Hard cap on the downloaded export archive (memory guard). */
const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
/** Delay before re-subscribing after a stream ends or stalls. */
const DEFAULT_RESUBSCRIBE_DELAY_MS = 2000;
/** Tool names whose calls mutate files and are projected. */
const PROJECTED_TOOLS = new Set(["edit", "write"]);

/** ZIP signatures. */
const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_LOCAL_SIG = 0x04034b50;

/**
 * Defensively extract an edit/write tool call from one session event.
 * Pure: any malformed shape returns null, never throws.
 *
 * Event shape (verified from a real session.jsonl decode): tool calls are
 * `{type:'tool/call', data:{name, ...}}` with arguments in
 * `data.arguments`/`data.args` and the path under `file_path`/`path`/
 * `absolute_path`. Both the name and the arguments carriers are probed
 * defensively because the wire shape may drift.
 *
 * @param {*} event - One decoded session event.
 * @returns {{tool: string, path: string}|null} Hit, or null when not an
 *   edit/write tool call with a usable path.
 */
function extractToolEdit(event) {
  try {
    if (!event || typeof event !== "object" || Array.isArray(event)) return null;
    if (event.type !== "tool/call") return null;
    const data = event.data && typeof event.data === "object" && !Array.isArray(event.data)
      ? event.data
      : {};
    const name = typeof event.name === "string" && event.name.length > 0
      ? event.name
      : (typeof data.name === "string" && data.name.length > 0 ? data.name : null);
    if (!name || !PROJECTED_TOOLS.has(name)) return null;
    const argsCarrier = [
      data.arguments,
      data.args,
      event.arguments,
      event.args,
    ].find((c) => c && typeof c === "object" && !Array.isArray(c));
    if (!argsCarrier) return null;
    const rawPath = [
      argsCarrier.file_path,
      argsCarrier.path,
      argsCarrier.absolute_path,
    ].find((p) => typeof p === "string" && p.length > 0);
    if (!rawPath) return null;
    return { tool: name, path: rawPath };
  } catch (_) {
    return null;
  }
}

/**
 * Read one fetch response body as a Buffer, enforcing a hard byte cap.
 *
 * @param {object} response - Fetch response with a web ReadableStream body.
 * @param {number} cap - Maximum accepted bytes.
 * @returns {Promise<Buffer>} Body bytes.
 * @throws {Error} When the body exceeds the cap or cannot be read.
 */
async function readBodyCapped(response, cap) {
  if (!response.body || typeof response.body.getReader !== "function") {
    throw new Error("export response has no stream body");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const read = await reader.read();
    if (read.done) break;
    total += read.value.byteLength;
    if (total > cap) {
      try {
        await reader.cancel();
      } catch (_) {
        /* already cancelled */
      }
      throw new Error(`session export exceeds ${cap} bytes`);
    }
    chunks.push(Buffer.from(read.value));
  }
  return Buffer.concat(chunks);
}

/**
 * Extract the root session-log text from an export ZIP buffer. The root
 * artifact sits at the archive top level (`session.jsonl`); subagent logs
 * live under `subagents/` and media under `media/` and are ignored.
 *
 * Minimal central-directory reader (STORE + DEFLATE only); ZIP64 archives are
 * rejected defensively (a session log far below 4 GiB never needs them).
 *
 * @param {Buffer} zip - Raw ZIP bytes.
 * @returns {string|null} Artifact text, or null when no usable entry exists.
 */
function extractSessionLogText(zip) {
  try {
    if (!Buffer.isBuffer(zip) || zip.length < 22) return null;
    // locate the End Of Central Directory record (scan backwards; the only
    // variable tail is a <=64 KiB archive comment)
    let eocd = -1;
    const scanStart = Math.max(0, zip.length - 22 - 65535);
    for (let i = zip.length - 22; i >= scanStart; i -= 1) {
      if (zip.readUInt32LE(i) === ZIP_EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return null;
    const entries = zip.readUInt16LE(eocd + 10);
    let offset = zip.readUInt32LE(eocd + 16);
    const candidates = [];
    for (let i = 0; i < entries; i += 1) {
      if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== ZIP_CENTRAL_SIG) return null;
      const method = zip.readUInt16LE(offset + 10);
      const compressedSize = zip.readUInt32LE(offset + 20);
      const nameLen = zip.readUInt16LE(offset + 28);
      const extraLen = zip.readUInt16LE(offset + 30);
      const commentLen = zip.readUInt16LE(offset + 32);
      const localOffset = zip.readUInt32LE(offset + 42);
      const name = zip.slice(offset + 46, offset + 46 + nameLen).toString("utf8");
      candidates.push({ name, method, compressedSize, localOffset });
      offset += 46 + nameLen + extraLen + commentLen;
    }
    const entry = candidates.find((c) =>
      typeof c.name === "string"
      && c.name.endsWith(".jsonl")
      && !c.name.includes("/")
    );
    if (!entry) return null;
    const lo = entry.localOffset;
    if (lo + 30 > zip.length || zip.readUInt32LE(lo) !== ZIP_LOCAL_SIG) return null;
    const loNameLen = zip.readUInt16LE(lo + 26);
    const loExtraLen = zip.readUInt16LE(lo + 28);
    const dataStart = lo + 30 + loNameLen + loExtraLen;
    const raw = zip.slice(dataStart, dataStart + entry.compressedSize);
    if (entry.method === 0) return raw.toString("utf8");
    if (entry.method === 8) return inflateRawSync(raw).toString("utf8");
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * Create the edit event projector. At most one session is followed at a
 * time; switching sessions aborts the previous subscription. Each session id
 * is back-scanned at most once per projector lifetime.
 *
 * @param {object} options
 * @param {Function} options.recordToolEdit - Journal sink
 *   (`({tool, path, sessionId}) => ...`).
 * @param {Function} [options.log] - Diagnostic line sink.
 * @param {Function} [options.fetchImpl] - Fetch-compatible transport
 *   (defaults to globalThis.fetch through the chat client).
 * @param {string|Function} [options.baseUrl] - DSH web base URL, or a
 *   provider returning it (or null when the server is down).
 * @param {number} [options.resubscribeDelayMs] - Re-subscribe delay after a
 *   stream ends or stalls (tests inject large values).
 * @returns {{followSession: Function, unfollow: Function, dispose: Function}}
 *   Frozen projector API.
 */
function createEditEventProjector({
  recordToolEdit,
  log,
  fetchImpl,
  baseUrl,
  resubscribeDelayMs = DEFAULT_RESUBSCRIBE_DELAY_MS,
} = {}) {
  if (typeof recordToolEdit !== "function") {
    throw new TypeError("recordToolEdit must be a function");
  }
  const safeLog = (line) => {
    try {
      if (typeof log === "function") log("[editEventProjector] " + line);
    } catch (_) {
      /* logging must never break projection */
    }
  };
  const resolveBase = () => {
    const value = typeof baseUrl === "function" ? baseUrl() : baseUrl;
    return typeof value === "string" && value.length > 0 ? value : null;
  };
  const client = createDshChatClient({
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    baseUrlProvider: () => {
      const base = resolveBase();
      if (base === null) throw new Error("no DSH server URL");
      return base;
    },
  });

  /** Session ids already back-scanned in this projector lifetime. */
  const backfilled = new Set();
  /** Current subscription state (one at a time). */
  let subscription = null;

  const project = (event, sessionId) => {
    try {
      const hit = extractToolEdit(event);
      if (hit === null) return;
      Promise.resolve(recordToolEdit({ tool: hit.tool, path: hit.path, sessionId }))
        .catch((err) => safeLog("recordToolEdit rejected: " + (err && err.message ? err.message : String(err))));
    } catch (err) {
      safeLog("projection failed: " + (err && err.message ? err.message : String(err)));
    }
  };

  /**
   * Bounded back-scan: download the export ZIP, keep only the tail
   * MAX_BACKFILL_EVENTS artifact lines, project each edit/write hit.
   */
  const backfillSession = async (sessionId) => {
    const base = resolveBase();
    if (base === null) {
      safeLog("backfill skipped: no DSH server URL");
      return;
    }
    const url = new URL("/api/session.export", base);
    url.searchParams.set("sessionId", sessionId);
    let response;
    try {
      response = await (fetchImpl || globalThis.fetch)(url.toString(), { method: "GET" });
    } catch (err) {
      safeLog("backfill fetch failed: " + (err && err.message ? err.message : String(err)));
      return;
    }
    if (!response || typeof response.status !== "number" || response.status !== 200) {
      safeLog("backfill skipped: export HTTP " + (response && response.status));
      return;
    }
    let zip;
    try {
      zip = await readBodyCapped(response, MAX_EXPORT_BYTES);
    } catch (err) {
      safeLog("backfill body failed: " + (err && err.message ? err.message : String(err)));
      return;
    }
    const text = extractSessionLogText(zip);
    if (text === null) {
      safeLog("backfill skipped: no session.jsonl entry in export");
      return;
    }
    // Empty lines (e.g. the trailing newline) are not events: the tail
    // window is computed over non-empty artifact lines only.
    const lines = text.split("\n").filter((line) => line.length > 0);
    const tail = lines.slice(-MAX_BACKFILL_EVENTS);
    for (const line of tail) {
      let event;
      try {
        event = JSON.parse(line);
      } catch (_) {
        continue; // unparsable artifact lines cannot be tool calls
      }
      project(event, sessionId);
    }
  };

  /** Start the live events.mux subscription for one session. */
  const startSubscription = (sessionId) => {
    const abort = new AbortController();
    const record = { sessionId, abort, timer: null };
    subscription = record;
    client.streamSession({
      sessionId,
      onText: () => {}, // required seam; text deltas are not projected
      onDone: () => {
        if (subscription !== record) return;
        // the SSE stream ended or stalled: re-subscribe unless unfollowed /
        // superseded in the meantime.
        record.timer = setTimeout(() => {
          if (subscription === record) startSubscription(sessionId);
        }, resubscribeDelayMs);
        if (typeof record.timer.unref === "function") record.timer.unref();
      },
      onEvent: (event) => project(event, sessionId),
      signal: abort.signal,
    }).catch((err) => {
      safeLog("subscription failed: " + (err && err.message ? err.message : String(err)));
    });
  };

  const unfollow = () => {
    if (subscription === null) return;
    clearTimeout(subscription.timer);
    try {
      subscription.abort.abort();
    } catch (_) {
      /* double-abort is fine */
    }
    subscription = null;
  };

  /**
   * Follow one session: bounded back-scan (once per id), then a live
   * subscription. Switching sessions aborts the previous subscription.
   * Never rejects; failures only log.
   *
   * @param {string} sessionId - Session to follow.
   * @returns {Promise<void>} Resolves once the follow attempt settled.
   */
  const followSession = (sessionId) => (async () => {
    try {
      if (typeof sessionId !== "string" || sessionId.length === 0) return;
      unfollow();
      if (!backfilled.has(sessionId)) {
        backfilled.add(sessionId);
        await backfillSession(sessionId);
      }
      startSubscription(sessionId);
    } catch (err) {
      safeLog("followSession failed: " + (err && err.message ? err.message : String(err)));
    }
  })();

  return Object.freeze({ followSession, unfollow, dispose: unfollow });
}

module.exports = {
  createEditEventProjector,
  extractToolEdit,
  MAX_BACKFILL_EVENTS,
};
