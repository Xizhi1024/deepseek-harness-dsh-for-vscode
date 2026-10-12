"use strict";

/**
 * C2.5: edit/write attribution projected from the DSH session event stream.
 *
 * DSH is log-everything: every tool call an agent makes is recorded as a
 * `tool/call` event on the session log and mirrored live on the
 * `session/follow` Remote stream (`/api/remote.mux`). This projector rides
 * that architecture instead of intercepting anything: it
 *
 *   1. performs ONE bounded back-scan per session id (the follow stream's
 *      opening snapshot carries the durable history tail in `records`; only
 *      the trailing MAX_BACKFILL_EVENTS records are ever projected), and
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

const { createDshChatClient } = require("./dshChatClient");

/** Hard cap on back-scanned events per session (tail window only). */
const MAX_BACKFILL_EVENTS = 300;
/** Delay before re-subscribing after a stream ends. */
const DEFAULT_RESUBSCRIBE_DELAY_MS = 2000;
/** Tool names whose calls mutate files and are projected. */
const PROJECTED_TOOLS = new Set(["edit", "write"]);

/**
 * Defensively extract an edit/write tool call from one session event.
 * Pure: any malformed shape returns null, never throws.
 *
 * Event shape (verified from a real session decode): tool calls are
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
 *   stream ends (tests inject large values).
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
   * Bounded back-scan: open one session/follow stream, take the opening
   * snapshot's durable `records` tail, project each edit/write hit, then
   * cancel. The snapshot is the first item the server emits, so this is a
   * single bounded round-trip, not a subscription.
   */
  const backfillSession = async (sessionId) => {
    const base = resolveBase();
    if (base === null) {
      safeLog("backfill skipped: no DSH server URL");
      return;
    }
    let handle;
    try {
      handle = await client.openFollow({
        sessionId,
        maxMessages: MAX_BACKFILL_EVENTS,
        onValue: () => {}, // backfill reads only the snapshot via `ready`
      });
    } catch (err) {
      safeLog("backfill failed: " + (err && err.message ? err.message : String(err)));
      return;
    }
    const snapshot = await handle.ready;
    if (snapshot === null || !snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      safeLog("backfill skipped: follow stream ended before its snapshot");
      handle.cancel();
      return;
    }
    if (snapshot.type !== "snapshot") {
      safeLog("backfill skipped: unexpected first follow value");
      handle.cancel();
      return;
    }
    const records = Array.isArray(snapshot.records) ? snapshot.records : [];
    const tail = records.slice(-MAX_BACKFILL_EVENTS);
    for (const record of tail) {
      if (!record || typeof record !== "object" || Array.isArray(record)) continue;
      if (record.type !== "event" || !record.event) continue;
      project(record.event, sessionId);
    }
    handle.cancel();
  };

  /** Start the live session/follow subscription for one session. */
  const startSubscription = (sessionId) => {
    const abort = new AbortController();
    const record = { sessionId, abort, timer: null };
    subscription = record;
    client.streamSession({
      sessionId,
      onText: () => {}, // required seam; text deltas are not projected
      onDone: () => {
        if (subscription !== record) return;
        // the stream ended or failed: re-subscribe unless unfollowed /
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