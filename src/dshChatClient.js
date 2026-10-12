"use strict";

/**
 * DSH chat client for the VS Code sidebar.
 *
 * Thin client over two owned-DSH endpoints (dsh >= 0.1.5-rc.2, typert gateway):
 *   - POST /api/session/prompt  — enqueue a prompt into a session
 *   - WS   /api/remote.mux      — typert Remote stream carrying session/follow
 *
 * Both live on the loopback DSH web server, so the base URL is re-validated
 * against `sessionNavigation.assertLoopbackBaseUrl` on every request (only
 * `http://127.0.0.1:<port>` / `http://localhost:<port>`).
 *
 * The HTTP JSON-RPC envelope and error handling deliberately reuse the
 * `sessionNavigation` clientRequest / postJson / readJsonBody /
 * assertServerResponse precedent so the DSH_SESSION_API_* error surface stays
 * identical across the extension host.
 *
 * Wire sources (verified 2026-09-17 against the installed dsh 0.1.5-rc.1):
 *   - prompt: SessionPromptRequest { requestId (client-minted), sessionId,
 *     mode, content } -> SessionPromptValue { accepted: true }.
 *   - follow: SessionFollowRequest { address: { kind:'session', sessionId },
 *     maxMessages?, assistantStream:true } streams SessionFollowFrame values:
 *     the opening `{type:'snapshot', ..., records}` (records = durable history
 *     tail, used for one-shot backfill) followed by live
 *     `{type:'event', event: SessionWireEvent}` values. Live text deltas come
 *     as transient `assistant/live-chunk` events whose `event.data.chunk` is
 *     `{ type:'text-delta', index, text }` - the same chunk shape the old
 *     `assistant/chunk` SSE events carried.
 */

const crypto = require("node:crypto");
const {
  DshSessionError,
  assertLoopbackBaseUrl,
  clientRequest,
  postJson,
  readJsonBody,
  assertServerResponse,
  resolveFetchImpl,
} = require("./sessionNavigation");
const { createTypertStream } = require("./wsStreamClient");

/** API path for the session.prompt method. @type {string} */
const PROMPT_PATH = "/api/session/prompt";

/** prompt() default timeout in milliseconds. */
const PROMPT_TIMEOUT_MS = 10_000;

/**
 * Create an abort signal that fires after `ms` milliseconds. We use our own
 * controller (instead of AbortSignal.timeout) so the timer can be cleared the
 * moment the request settles and never keeps the extension host alive.
 *
 * @param {number} ms - Timeout in milliseconds.
 * @returns {{signal: AbortSignal, cancel: Function}} Timeout signal + cancel.
 */
function createTimeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    let reason;
    if (typeof DOMException === "function") {
      reason = new DOMException(`DSH chat request timed out after ${ms}ms`, "TimeoutError");
    }
    controller.abort(reason);
  }, ms);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
  };
}

/**
 * Combine an optional caller signal with a local signal so that either abort
 * aborts the composed signal. The composed signal is what gets passed to
 * fetch; caller cancellation therefore still aborts the underlying request.
 *
 * @param {AbortSignal} [callerSignal] - Optional caller signal.
 * @param {AbortSignal} localSignal - Local signal (e.g. timeout).
 * @returns {AbortSignal} Composed signal.
 */
function mergeAbortSignals(callerSignal, localSignal) {
  if (!callerSignal) return localSignal;
  if (callerSignal.aborted) return AbortSignal.abort(callerSignal.reason);
  if (localSignal && localSignal.aborted) return AbortSignal.abort(localSignal.reason);
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([callerSignal, localSignal]);
  }
  const controller = new AbortController();
  const forwardCaller = () => controller.abort(callerSignal.reason);
  const forwardLocal = () => controller.abort(localSignal.reason);
  callerSignal.addEventListener("abort", forwardCaller, { once: true });
  localSignal.addEventListener("abort", forwardLocal, { once: true });
  return controller.signal;
}

/**
 * Build the wire `content` array for session.prompt.
 *
 * The frozen contract allows both call styles:
 *   - `content` as a non-empty string → wrapped as `[{ type: 'text', text }]`
 *     (R24 ask / R20 participant pass the prompt string this way);
 *   - `content` as a non-empty array → passed through untouched (the wire
 *     schema is `[{type:'text', text}]` per the real source:
 *     PromptContentPart).
 *
 * @param {string|Array<object>} content - Prompt text or content parts.
 * @returns {Array<object>} Wire content array.
 */
function toWireContent(content) {
  if (typeof content === "string") {
    if (content.length === 0) {
      throw new TypeError("content must be a non-empty string");
    }
    return [{ type: "text", text: content }];
  }
  if (Array.isArray(content) && content.length > 0) {
    return content;
  }
  throw new TypeError("content must be a non-empty string or a non-empty array of content parts");
}

/**
 * Extract the visible text delta from one SessionWireEvent.
 *
 * Real-source field chain (dsh 0.1.5-rc.1 installed packages):
 *   - live text deltas are `event.type === 'assistant/live-chunk'` with
 *     `event.data.chunk === { type:'text-delta', index, text }` - the chunk is
 *     built from `assistant-stream` frames (dsh-client-ui-trajectory/lib/client.js
 *     consumes exactly this shape at `match.event.data.chunk`).
 *   - consumer precedent: dsh-client-ui-conversation appends `chunk.text` for
 *     `chunk.type === 'text-delta'`.
 *
 * There is exactly one live text-delta shape in 0.1.5, so no speculative
 * `delta`/`content` fallback: forwarding other fields would risk surfacing
 * reasoning/tool text as visible assistant output.
 *
 * @param {*} event - The `event` object of a stream `SessionWireEvent`.
 * @returns {string|null} The visible text delta, or null when the event is
 *   not a visible text increment.
 */
function extractTextDelta(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  if (event.type !== "assistant/live-chunk") return null;
  const data = event.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const chunk = data.chunk;
  if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) return null;
  if (chunk.type !== "text-delta") return null;
  if (typeof chunk.text !== "string") return null;
  return chunk.text;
}

/**
 * Create the DSH chat client.
 *
 * @param {object} [options]
 * @param {Function} [options.fetchImpl=globalThis.fetch] - Fetch-compatible
 *   function; injected in tests, defaults to `globalThis.fetch`.
 * @param {Function} options.baseUrlProvider - Required function returning the
 *   current DSH web base URL (e.g. `() => currentServer.url`). Called per
 *   request so a server that starts later is picked up.
 * @param {Function} [options.ensureConnected] - Optional seam (extension.js
 *   `scheduleConnect`). When provided it is awaited before every request so a
 *   not-yet-running owned server can be started first; rejections map to
 *   `DSH_SESSION_API_UNAVAILABLE`.
 * @param {Function} [options.createStream] - Injectable stream opener
 *   (defaults to `wsStreamClient.createTypertStream`); tests stub the
 *   transport here instead of opening real sockets.
 * @returns {{prompt: Function, streamSession: Function, openFollow: Function}}
 *   Frozen chat client API.
 */
function createDshChatClient({
  fetchImpl = globalThis.fetch,
  baseUrlProvider,
  ensureConnected,
  createStream,
} = {}) {
  if (typeof baseUrlProvider !== "function") {
    throw new TypeError("baseUrlProvider must be a function");
  }
  if (typeof ensureConnected !== "undefined" && typeof ensureConnected !== "function") {
    throw new TypeError("ensureConnected must be a function when provided");
  }
  if (typeof createStream !== "undefined" && typeof createStream !== "function") {
    throw new TypeError("createStream must be a function when provided");
  }
  const createStreamImpl = typeof createStream === "function" ? createStream : createTypertStream;

  /**
   * Resolve and loopback-validate the current base URL, optionally running
   * the injected `ensureConnected` seam first so a stopped server can be
   * brought up before the request.
   *
   * @returns {Promise<string>} Raw base URL string.
   * @throws {DshSessionError} DSH_SESSION_API_UNAVAILABLE.
   */
  async function resolveBaseUrl() {
    if (typeof ensureConnected === "function") {
      try {
        await ensureConnected();
      } catch (err) {
        throw new DshSessionError(
          "DSH_SESSION_API_UNAVAILABLE",
          "DSH session API unavailable: " + (err && err.message ? err.message : String(err))
        );
      }
    }
    let baseUrl;
    try {
      baseUrl = await baseUrlProvider();
    } catch (err) {
      throw new DshSessionError(
        "DSH_SESSION_API_UNAVAILABLE",
        "DSH session API unavailable: " + (err && err.message ? err.message : String(err))
      );
    }
    if (typeof baseUrl !== "string" || baseUrl.length === 0) {
      throw new DshSessionError(
        "DSH_SESSION_API_UNAVAILABLE",
        "DSH session API unavailable: no DSH server URL"
      );
    }
    return baseUrl;
  }

  /**
   * POST <baseUrl>/api/session/prompt with a typert envelope and return
   * `{ accepted: true, sessionId }`.
   *
   * The payload carries a client-minted `requestId` (SessionPromptRequest
   * requires it; it is persisted on the exact accepted user message).
   *
   * Response value schema (pinned from real source):
   *   SessionPromptValue = { accepted: literal(true) }. We echo our own
   *   sessionId back (the server value does not repeat it).
   *
   * @param {object} args
   * @param {string} args.sessionId - Non-empty session id.
   * @param {string|Array<object>} args.content - Prompt text (string) or wire
   *   content parts.
   * @param {string} [args.mode='queue'] - `'queue'` or `'steer'`.
   * @param {AbortSignal} [args.signal] - Caller abort signal, forwarded to
   *   fetch; cancellation rejects with the original AbortError.
   * @returns {Promise<{accepted: true, sessionId: string}>}
   * @throws {DshSessionError} With the DSH_SESSION_API_* error codes.
   * @throws {AbortError} When the caller signal aborts.
   */
  async function prompt({ sessionId, content, mode = "queue", signal } = {}) {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new TypeError("sessionId must be a non-empty string");
    }
    if (mode !== "queue" && mode !== "steer") {
      throw new TypeError("mode must be 'queue' or 'steer'");
    }
    const wireContent = toWireContent(content);
    const resolvedFetch = resolveFetchImpl({ fetchImpl });
    const baseUrl = await resolveBaseUrl();
    const parsed = assertLoopbackBaseUrl(baseUrl);

    const timeout = createTimeoutSignal(PROMPT_TIMEOUT_MS);
    const requestSignal = mergeAbortSignals(signal, timeout.signal);
    try {
      const response = await postJson(
        parsed,
        PROMPT_PATH,
        clientRequest("session/prompt", {
          request: {
            requestId: crypto.randomUUID ? crypto.randomUUID() : randomUuidFallback(),
            sessionId,
            mode,
            content: wireContent,
          },
        }),
        resolvedFetch,
        requestSignal
      );
      const body = await readJsonBody(response);
      const result = assertServerResponse(body);
      const value = result.value;
      if (!value || typeof value !== "object" || Array.isArray(value) || value.accepted !== true) {
        throw new DshSessionError(
          "DSH_SESSION_API_INVALID_RESPONSE",
          "DSH session API invalid response: result.value.accepted must be true"
        );
      }
      return Object.freeze({ accepted: true, sessionId });
    } finally {
      timeout.cancel();
    }
  }

  /**
   * Open a session/follow Remote stream for one session.
   *
   * The follow stream always starts with a `{type:'snapshot'}` value carrying
   * the durable history tail (`records`), then yields live
   * `{type:'event', event}` values. `ready` resolves with that opening value
   * once it arrives (or null when the stream fails before producing an item) -
   * it doubles as the "subscription is live, no event will be missed from
   * here" signal the old events.mux connection provided (now the
   * `/api/remote.mux` WebSocket).
   *
   * @param {object} args
   * @param {string} args.sessionId - Session to follow.
   * @param {Function} [args.onValue] - Called with every item value (snapshot
   *   and live event values alike). A throw settles `done` with
   *   `'consumer-error'` and cancels the stream.
   * @param {number} [args.maxMessages] - Bound the snapshot `records` tail.
   * @param {boolean} [args.assistantStream=false] - Request the transient
   *   assistant live-chunk stream (needed for chat text deltas).
   * @param {AbortSignal} [args.signal] - Abort cancels the stream.
   * @returns {Promise<object>} Frozen handle
   *   `{ streamId, cancel, done, ready }`.
   * @throws {DshSessionError} DSH_SESSION_API_UNAVAILABLE when no base URL or
   *   the stream cannot be opened.
   */
  async function openFollow({ sessionId, onValue, maxMessages, assistantStream = false, signal } = {}) {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new TypeError("sessionId must be a non-empty string");
    }
    const request = {
      address: { kind: "session", sessionId },
      ...(typeof maxMessages === "number" && Number.isInteger(maxMessages) ? { maxMessages } : {}),
      ...(assistantStream ? { assistantStream: true } : {}),
    };
    const baseUrl = await resolveBaseUrl();
    const parsed = assertLoopbackBaseUrl(baseUrl);

    let readyResolve = null;
    let firstValue = null;
    const ready = new Promise((resolve) => {
      readyResolve = resolve;
    });
    let streamHandle;
    try {
      streamHandle = await createStreamImpl({
        baseUrl: parsed.toString(),
        endpoint: "session/follow",
        args: { request },
        onValue: (value) => {
          if (firstValue === null) {
            firstValue = value;
            readyResolve(value);
          }
          if (typeof onValue === "function") onValue(value);
        },
        signal,
      });
    } catch (err) {
      if (signal && signal.aborted) throw err;
      throw new DshSessionError(
        "DSH_SESSION_API_UNAVAILABLE",
        "DSH session API unavailable: " + (err && err.message ? err.message : String(err))
      );
    }
    // resolve `ready` with null when the stream dies before the snapshot.
    streamHandle.done.then(({ reason }) => {
      if (firstValue === null) {
        firstValue = reason;
        readyResolve(null);
      }
    });

    return Object.freeze({
      streamId: streamHandle.streamId,
      cancel: () => {
        try {
          streamHandle.cancel();
        } catch (_) {
          /* already settled */
        }
      },
      done: streamHandle.done,
      ready,
    });
  }

  /**
   * Stream live session events for one session through `session/follow`.
   *
   * Behaviour (semantics preserved from the legacy events.mux SSE client,
   * now carried by the `/api/remote.mux` WebSocket follow stream):
   *   - only live `{type:'event'}` items are considered (the opening snapshot
   *     is consumed by `onReady`).
   *   - `onText(string)` is called once per visible text delta, in order.
   *   - `onReady(snapshot)` (optional) is called exactly once after the
   *     snapshot arrives - the subscription is live, no event can be missed
   *     from that point. It is never called when the stream fails. A throw
   *     routes to `consumer-error`.
   *   - `onEvent(event, sessionId)` (optional) is called once for every live
   *     event BEFORE the text-delta filter, so non-text events (e.g.
   *     `tool/call`) are observable too.
   *   - `onDone({reason})` is called exactly once when the stream ends or is
   *     interrupted. Reasons: `'stream-end'`, `'aborted'`,
   *     `'DSH_SESSION_API_UNAVAILABLE'`, `'consumer-error'`.
   *   - the caller signal cancels the stream with `{reason:'aborted'}`.
   *
   * @param {object} args
   * @param {string} args.sessionId - Session whose text deltas are forwarded.
   * @param {Function} args.onText - Called with each text delta string.
   * @param {Function} args.onDone - Called once with `{reason}`.
   * @param {Function} [args.onReady] - Called once with the follow snapshot.
   * @param {Function} [args.onEvent] - Called with (event, sessionId) for
   *   every live event, before the text-delta filter.
   * @param {AbortSignal} [args.signal] - Caller abort signal.
   * @returns {Promise<{reason: string}>} Terminal reason (also passed to
   *   onDone).
   */
  async function streamSession({ sessionId, onText, onDone, onReady, onEvent, signal } = {}) {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new TypeError("sessionId must be a non-empty string");
    }
    if (typeof onText !== "function") {
      throw new TypeError("onText must be a function");
    }
    if (typeof onDone !== "function") {
      throw new TypeError("onDone must be a function");
    }
    if (typeof onReady !== "undefined" && typeof onReady !== "function") {
      throw new TypeError("onReady must be a function when provided");
    }
    if (typeof onEvent !== "undefined" && typeof onEvent !== "function") {
      throw new TypeError("onEvent must be a function when provided");
    }

    let terminal = null;
    let handle = null;
    let drain = Promise.resolve();

    const finish = (reason) => {
      if (terminal !== null) return;
      terminal = Object.freeze({ reason });
      try {
        const maybePromise = onDone(terminal);
        if (maybePromise && typeof maybePromise.then === "function") {
          maybePromise.catch(() => {});
        }
      } catch (_) {
        /* onDone must never become a rejection */
      }
      if (handle) {
        try {
          handle.cancel();
        } catch (_) {
          /* already settled */
        }
      }
    };

    const onCallerAbort = () => finish("aborted");
    if (signal) {
      if (signal.aborted) {
        finish("aborted");
      } else {
        signal.addEventListener("abort", onCallerAbort, { once: true });
      }
    }

    // Sequential drain so async consumers never interleave, mirroring the old
    // SSE loop that awaited onEvent/onText in order.
    const drainValue = (value) => {
      if (terminal !== null) return;
      if (!value || typeof value !== "object" || Array.isArray(value) || value.type !== "event") return;
      if (!value.event || typeof value.event !== "object" || Array.isArray(value.event)) return;
      const event = value.event;
      drain = drain.then(async () => {
        if (terminal !== null) return;
        try {
          if (typeof onEvent === "function") {
            await onEvent(event, sessionId);
          }
          const text = extractTextDelta(event);
          if (text !== null) await onText(text);
        } catch (_) {
          finish("consumer-error");
        }
      }).catch((err) => {
        if (terminal === null) finish("consumer-error");
      });
    };

    try {
      if (terminal !== null) return terminal;

      let baseUrl;
      try {
        baseUrl = await resolveBaseUrl();
      } catch (err) {
        if (terminal !== null) return terminal;
        throw err;
      }
      if (terminal !== null) return terminal;
      const parsed = assertLoopbackBaseUrl(baseUrl);

      handle = await openFollow({
        sessionId,
        assistantStream: true,
        signal,
        onValue: drainValue,
      });
      if (terminal !== null) {
        handle.cancel();
        return terminal;
      }

      if (typeof onReady === "function") {
        handle.ready.then(async (snapshot) => {
          if (terminal !== null) return;
          try {
            await onReady(snapshot);
          } catch (_) {
            finish("consumer-error");
          }
        });
      }

      const outcome = await handle.done;
      if (terminal === null) {
        if (outcome.reason === "end") {
          finish("stream-end");
        } else if (outcome.reason === "aborted") {
          finish("aborted");
        } else if (outcome.reason === "consumer-error") {
          finish("consumer-error");
        } else {
          finish("DSH_SESSION_API_UNAVAILABLE");
        }
      }
      return terminal;
    } finally {
      if (signal) signal.removeEventListener("abort", onCallerAbort);
    }
  }

  return Object.freeze({ prompt, streamSession, openFollow });
}

/**
 * Small randomUUID fallback for hosts where crypto.randomUUID is missing
 * (older Node 18 minor). Matches the RFC 4122 v4 layout used by router ids.
 *
 * @returns {string} A UUID v4 string.
 */
function randomUuidFallback() {
  const bytes = crypto.randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16),
    hex.slice(16, 20), hex.slice(20),
  ].join("-");
}

module.exports = {
  createDshChatClient,
  extractTextDelta,
};