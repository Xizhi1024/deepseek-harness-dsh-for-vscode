"use strict";

/**
 * DSH chat HTTP client for the VS Code sidebar.
 *
 * Thin client over two owned-DSH web endpoints:
 *   - POST /api/session.prompt  — enqueue a prompt into a session
 *   - GET  /api/events.mux      — multiplexed SSE stream of session events
 *
 * Both endpoints live on the loopback DSH web server, so the base URL is
 * re-validated against `sessionNavigation.assertLoopbackBaseUrl` on every
 * request (only `http://127.0.0.1:<port>` / `http://localhost:<port>`).
 *
 * The JSON-RPC envelope and error handling deliberately reuse the
 * `sessionNavigation` clientRequest / postJson / readJsonBody /
 * assertServerResponse precedent so the DSH_SESSION_API_* error surface stays
 * identical across the extension host.
 */

const {
  DshSessionError,
  assertLoopbackBaseUrl,
  clientRequest,
  postJson,
  readJsonBody,
  assertServerResponse,
  resolveFetchImpl,
} = require("./sessionNavigation");

/** API path for the session.prompt method. @type {string} */
const PROMPT_PATH = "/api/session.prompt";
/** API path for the multiplexed event stream. @type {string} */
const EVENTS_MUX_PATH = "/api/events.mux";

/** prompt() default timeout in milliseconds. */
const PROMPT_TIMEOUT_MS = 10_000;
/** streamSession() stall deadline: 15s without any SSE data frame fails closed. */
const STREAM_STALL_TIMEOUT_MS = 15_000;
/** Maximum accepted SSE frame size (raw bytes between "\n\n" boundaries): 1 MiB. */
const SSE_FRAME_MAX_BYTES = 1024 * 1024;

/**
 * True for fetch AbortError rejections, which must propagate unchanged so the
 * caller can distinguish cancellation from a real API failure. Mirrors the
 * same check inside sessionNavigation.postJson.
 *
 * @param {*} err - Rejection value.
 * @returns {boolean} True when `err` is an AbortError.
 */
function isAbortError(err) {
  return Boolean(err) && (err.name === "AbortError" || err.code === "ABORT_ERR");
}

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
 *     dsh-host-apiproxy/lib/types/api/sessions.schema.js L220-223,
 *     promptContentPartSchema).
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
 * Parse one SSE `data:` payload into a mux frame.
 *
 * SSE wire shape (pinned from real source):
 *   dsh-host-apiproxy/lib/index.js L4973-4979 `fullFrame` writes every mux
 *   frame as a full ServerRequest envelope, and L4990 writes
 *   `data: ${JSON.stringify(fullFrame)}\n\n`; the parser in
 *   dsh-client-connection/lib/client.js L6246-6278 reads that same shape.
 *   The envelope is `{ type:'server-request', rpcId, method, payload }` with
 *   `payload` being the mux frame (dsh-host-apiproxy/lib/types/api/rpc.schema.js
 *   L91-96, serverRequestSchema).
 *
 * @param {string} data - Concatenated `data:` line payload.
 * @returns {{ok: boolean, frame?: object}} Parse result.
 */
function parseMuxFrame(data) {
  let full;
  try {
    full = JSON.parse(data);
  } catch (_) {
    return { ok: false };
  }
  if (!full || typeof full !== "object" || Array.isArray(full)) {
    return { ok: false };
  }
  if (full.type !== "server-request") {
    return { ok: false };
  }
  const frame = full.payload;
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
    return { ok: false };
  }
  return { ok: true, frame };
}

/**
 * Extract the visible text delta from one `session/event` frame.
 *
 * Real-source field chain (rc.8 installed packages):
 *   - frame: `{ type:'session/event', sessionId, event }` —
 *     dsh-client-connection/lib/client.js L5584-5589 (muxFrameSchema).
 *   - event: `{ type, seq, time, data }` —
 *     dsh-host-apiproxy/lib/types/api/sessions.schema.js L21-29
 *     (sessionEventSchema).
 *   - live text deltas are `event.type === 'assistant/chunk'` with
 *     `event.data.chunk === { type:'text-delta', index, text }` —
 *     dsh-session/lib/index.js L787-789 (classify text-delta shape) and
 *     L982-986 (expandRow reconstructs the same shape).
 *   - consumer precedent: dsh-client-ui-conversation/lib/client.js L7265-7270
 *     appends `chunk.text` for `chunk.type === 'text-delta'`.
 *
 * The installed source shows exactly one live text-delta shape, so there is
 * no speculative `delta`/`content` fallback here: forwarding other fields
 * would risk surfacing reasoning/tool text as visible assistant output.
 *
 * @param {*} event - The `event` object of a `session/event` frame.
 * @returns {string|null} The visible text delta, or null when the event is
 *   not a visible text increment.
 */
function extractTextDelta(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  if (event.type !== "assistant/chunk") return null;
  const data = event.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const chunk = data.chunk;
  if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) return null;
  if (chunk.type !== "text-delta") return null;
  if (typeof chunk.text !== "string") return null;
  return chunk.text;
}

/**
 * Extract the concatenated `data:` payload from one raw SSE frame chunk,
 * mirroring the real client parser:
 *   dsh-client-connection/lib/client.js L6262
 *   `chunk.split("\n").filter((line) => line.startsWith("data: ")).map(...).join("")`
 *
 * @param {string} rawFrame - Raw SSE chunk between two `\n\n` boundaries.
 * @returns {string} Concatenated data payload (empty for comments/keepalives).
 */
function sseDataPayload(rawFrame) {
  return rawFrame
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6))
    .join("");
}

/**
 * Create the frozen DSH chat client.
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
 * @returns {{prompt: Function, streamSession: Function}} Frozen chat client API.
 */
function createDshChatClient({
  fetchImpl = globalThis.fetch,
  baseUrlProvider,
  ensureConnected,
} = {}) {
  if (typeof baseUrlProvider !== "function") {
    throw new TypeError("baseUrlProvider must be a function");
  }
  if (typeof ensureConnected !== "undefined" && typeof ensureConnected !== "function") {
    throw new TypeError("ensureConnected must be a function when provided");
  }

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
   * POST <baseUrl>/api/session.prompt with a sessionNavigation-compatible
   * JSON-RPC envelope and return `{ accepted: true, sessionId }`.
   *
   * Response value schema pinned from real source:
   *   dsh-host-apiproxy/lib/types/api/sessions.schema.js L231-238
   *   sessionPromptValueSchema = { accepted: literal(true),
   *   command?: { kind:'success', text?: string } }.
   * We echo our own sessionId back (the server value does not repeat it) and
   * ignore the optional `command` slot.
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
        clientRequest("session.prompt", { sessionId, mode, content: wireContent }),
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
   * GET <baseUrl>/api/events.mux and stream `session/event` text deltas for
   * one session.
   *
   * SSE protocol facts pinned from real source:
   *   - endpoint is GET, response content-type text/event-stream:
   *     dsh-host-apiproxy/lib/index.js L5027-5030.
   *   - framing is `data: <json>\n\n` (plus one leading `: connected\n\n`
   *     comment): dsh-host-apiproxy/lib/index.js L4985-4990.
   *   - each data payload is the ServerRequest full form whose `payload` is
   *     the mux frame: dsh-host-apiproxy/lib/index.js L4973-4979 and
   *     dsh-client-connection/lib/client.js L6246-6278.
   *
   * Behaviour:
   *   - only `session/event` frames whose `sessionId` matches are considered;
   *     every other frame is ignored.
   *   - `onText(string)` is called once per visible text delta, in order.
   *   - `onReady()` (optional) is called exactly once after the SSE connection
   *     is established and the server has subscribed the session bus - at that
   *     point no live session/event can be missed. It is never called when
   *     the connection fails; a throw routes to `consumer-error`.
   *   - `onDone({reason})` is called exactly once when the stream ends or is
   *     interrupted. Reasons: `'stream-end'`, `'aborted'`,
   *     `'DSH_SESSION_STREAM_STALLED'`, `'DSH_SESSION_API_INVALID_RESPONSE'`,
   *     `'DSH_SESSION_API_UNAVAILABLE'`, `'consumer-error'`.
   *   - a frame (raw bytes between `\n\n` boundaries) larger than 1 MiB
   *     disconnects with `DSH_SESSION_API_INVALID_RESPONSE`.
   *   - 15s without any data frame disconnects with
   *     `DSH_SESSION_STREAM_STALLED` (fail-closed).
   *   - the caller signal is forwarded to fetch; cancellation ends the stream
   *     with `{reason:'aborted'}`.
   *
   * @param {object} args
   * @param {string} args.sessionId - Session whose text deltas are forwarded.
   * @param {Function} args.onText - Called with each text delta string.
   * @param {Function} args.onDone - Called once with `{reason}`.
   * @param {Function} [args.onReady] - Called once after the connection is
   *   established (server subscribed; no delta can be missed from this point).
   * @param {AbortSignal} [args.signal] - Caller abort signal.
   * @returns {Promise<{reason: string}>} Terminal reason (also passed to onDone).
   */
  async function streamSession({ sessionId, onText, onDone, onReady, signal } = {}) {
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

    const resolvedFetch = resolveFetchImpl({ fetchImpl });
    const controller = new AbortController();
    let done = null;
    let reader = null;
    let stallTimer = null;
    let readerCancelPromise = null;

    const clearStall = () => {
      if (stallTimer !== null) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
    };
    const armStall = () => {
      clearStall();
      stallTimer = setTimeout(() => finish("DSH_SESSION_STREAM_STALLED"), STREAM_STALL_TIMEOUT_MS);
    };
    const finish = (reason) => {
      if (done !== null) return;
      done = Object.freeze({ reason });
      clearStall();
      try {
        controller.abort();
      } catch (_) {
        /* ignore double-abort */
      }
      if (reader) {
        readerCancelPromise = reader.cancel().catch(() => {});
      }
      try {
        const maybePromise = onDone({ reason });
        if (maybePromise && typeof maybePromise.then === "function") {
          maybePromise.catch(() => {});
        }
      } catch (_) {
        /* onDone must never become a rejection */
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

    try {
      if (done !== null) return done;

      let baseUrl;
      try {
        baseUrl = await resolveBaseUrl();
      } catch (err) {
        if (done !== null) return done;
        throw err;
      }
      if (done !== null) return done;

      const parsed = assertLoopbackBaseUrl(baseUrl);
      const url = new URL(EVENTS_MUX_PATH, parsed).toString();

      let response;
      try {
        response = await resolvedFetch(url, {
          method: "GET",
          headers: { accept: "text/event-stream" },
          signal: controller.signal,
        });
      } catch (err) {
        finish(isAbortError(err) ? "aborted" : "DSH_SESSION_API_UNAVAILABLE");
        return done;
      }
      if (done !== null) return done;

      if (!response || typeof response.status !== "number") {
        finish("DSH_SESSION_API_UNAVAILABLE");
        return done;
      }
      if (response.status !== 200) {
        if (response.body && typeof response.body.cancel === "function") {
          response.body.cancel().catch(() => {});
        }
        finish("DSH_SESSION_API_UNAVAILABLE");
        return done;
      }
      if (!response.body || typeof response.body.getReader !== "function") {
        finish("DSH_SESSION_API_UNAVAILABLE");
        return done;
      }

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      armStall();

      // The server subscribes the session bus before returning the SSE
      // Response, so once the reader is acquired no live session/event frame
      // can be missed. Notify readiness before consuming any delta so callers
      // can order dependent requests (e.g. send session.prompt only now).
      if (typeof onReady === "function") {
        try {
          const maybePromise = onReady();
          if (maybePromise && typeof maybePromise.then === "function") {
            await maybePromise;
          }
        } catch (_) {
          finish("consumer-error");
          return done;
        }
        if (done !== null) return done;
        armStall();
      }

      while (done === null) {
        let read;
        try {
          read = await reader.read();
        } catch (err) {
          if (done !== null) break;
          finish(isAbortError(err) ? "aborted" : "DSH_SESSION_API_UNAVAILABLE");
          break;
        }
        if (done !== null) break;
        if (read.done) {
          finish("stream-end");
          break;
        }
        buffer += decoder.decode(read.value, { stream: true });
        while (done === null) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary === -1) {
            // No complete frame yet; fail closed if the pending frame already
            // exceeds the 1 MiB frame cap.
            if (Buffer.byteLength(buffer, "utf8") > SSE_FRAME_MAX_BYTES) {
              finish("DSH_SESSION_API_INVALID_RESPONSE");
            }
            break;
          }
          const rawFrame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (Buffer.byteLength(rawFrame, "utf8") > SSE_FRAME_MAX_BYTES) {
            finish("DSH_SESSION_API_INVALID_RESPONSE");
            break;
          }
          const data = sseDataPayload(rawFrame);
          if (data === "") continue; // SSE comment/keepalive; not a data frame.
          armStall(); // a data frame arrived: reset the 15s stall deadline.
          const parsedFrame = parseMuxFrame(data);
          if (!parsedFrame.ok) {
            finish("DSH_SESSION_API_INVALID_RESPONSE");
            break;
          }
          const frame = parsedFrame.frame;
          if (frame.type === "stream/error") {
            finish("DSH_SESSION_API_UNAVAILABLE");
            break;
          }
          if (frame.type !== "session/event") continue;
          if (frame.sessionId !== sessionId) continue;
          const text = extractTextDelta(frame.event);
          if (text === null) continue;
          try {
            const maybePromise = onText(text);
            if (maybePromise && typeof maybePromise.then === "function") {
              await maybePromise;
            }
          } catch (_) {
            finish("consumer-error");
            break;
          }
        }
      }
    } finally {
      clearStall();
      if (signal) signal.removeEventListener("abort", onCallerAbort);
      if (reader) {
        if (readerCancelPromise) {
          await readerCancelPromise;
        } else {
          await reader.cancel().catch(() => {});
        }
      }
    }

    if (done === null) finish("stream-end");
    return done;
  }

  return Object.freeze({ prompt, streamSession });
}

module.exports = {
  createDshChatClient,
};
