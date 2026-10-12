"use strict";

/**
 * wsStreamClient.js — minimal zero-dependency RFC 6455 WebSocket client and
 * typert Remote-stream transport for the DSH gateway (dsh >= 0.1.5-rc.2).
 *
 * The extension host Node versions (18/20) expose `globalThis.fetch` but no
 * `WebSocket` global, and the extension deliberately ships without runtime
 * dependencies, so the streaming replacement for `/api/events.mux` (SSE) is a
 * small hand-rolled WS client. It implements just enough of RFC 6455 for one
 * loopback endpoint (client masking, text/close/ping/pong, continuation
 * reassembly, 7/16/64-bit length forms) plus the gateway's Remote-stream
 * frame protocol on `GET`-upgraded `/api/remote.mux`:
 *
 *     client -> server: {type:"open", streamId, endpoint, payload:{args}}
 *                       {type:"cancel", streamId}
 *     server -> client: {type:"item", streamId, value?}
 *                       {type:"end", streamId}
 *                       {type:"error", streamId, error:{code,message,details}}
 *
 * Only loopback hosts are accepted (the same rule as the HTTP client), and
 * loopback streams need no auth token (verified against a live dsh 0.1.5-rc.1
 * gateway). The gateway sends no periodic pings, so an idle follow stream is
 * legitimately silent; terminal conditions are the socket closing/erroring,
 * an end/error frame, or the caller's abort signal - there is deliberately no
 * stall watchdog that would reconnect-churn on idle sessions.
 */

const http = require("node:http");
const crypto = require("node:crypto");

/** Gateway WebSocket route carrying every typert Remote stream. */
const REMOTE_STREAM_MUX_PATH = "/api/remote.mux";
/** WebSocket GUID used in the upgrade handshake accept verification. */
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** Hard cap on one decoded text message (memory guard). */
const MAX_TEXT_MESSAGE_BYTES = 32 * 1024 * 1024;
/** Connect / handshake deadline in milliseconds. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/** Allowed base URL hostnames for the loopback DSH gateway. */
const ALLOWED_HOSTNAMES = new Set(["127.0.0.1", "localhost"]);
/** WebSocket opcodes used here. */
const OPCODES = Object.freeze({
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
});

/** Error type for handshake / protocol failures. */
class WebSocketStreamError extends Error {
  /**
   * @param {string} code - Stable failure code.
   * @param {string} message - Human-readable detail.
   */
  constructor(code, message) {
    super(message || code);
    this.name = "WebSocketStreamError";
    this.code = code;
  }
}

/**
 * Build the raw `Sec-WebSocket-Key` value: base64 of 16 random bytes.
 *
 * @returns {string} The key for one handshake.
 */
function buildWebSocketKey() {
  return crypto.randomBytes(16).toString("base64");
}

/**
 * Verify a handshake `Accept` against the requested key, per RFC 6455 4.2.2.
 *
 * @param {string} key - The `Sec-WebSocket-Key` sent in the request.
 * @param {string} accept - The `Sec-WebSocket-Accept` header received.
 * @returns {boolean} True when the accept matches the key.
 */
function verifyWebSocketAccept(key, accept) {
  if (typeof key !== "string" || typeof accept !== "string") return false;
  const digest = crypto.createHash("sha1").update(key + WEBSOCKET_GUID).digest("base64");
  return accept === digest;
}

/**
 * Transform a loopback HTTP base URL into the remote.mux WebSocket URL.
 *
 * @param {string} baseUrl - `http://127.0.0.1:<port>` or `http://localhost:<port>`.
 * @returns {string} `ws://127.0.0.1:<port>/api/remote.mux`.
 * @throws {WebSocketStreamError} WS_STREAM_MALFORMED_URL / WS_STREAM_NOT_LOOPBACK.
 */
function remoteMuxUrlFromBaseUrl(baseUrl) {
  let parsed;
  try {
    parsed = new URL(String(baseUrl || ""));
  } catch (_) {
    throw new WebSocketStreamError("WS_STREAM_MALFORMED_URL", "invalid DSH base URL");
  }
  if (!ALLOWED_HOSTNAMES.has(parsed.hostname) || !parsed.port) {
    throw new WebSocketStreamError(
      "WS_STREAM_NOT_LOOPBACK",
      "DSH stream URL must be http://127.0.0.1:<port> or http://localhost:<port>"
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new WebSocketStreamError("WS_STREAM_MALFORMED_URL", "DSH base URL must use http");
  }
  return `ws${parsed.protocol === "https:" ? "s" : ""}://${parsed.host}${REMOTE_STREAM_MUX_PATH}`;
}

/**
 * Encode one client frame (masked by default, per RFC 6455 5.3).
 * Exported for unit tests.
 *
 * @param {function} payload - UTF-8 text to send in one frame.
 * @param {object} [options]
 * @param {boolean} [options.mask=true] - Mask the payload (client MUST mask).
 * @param {number} [options.opcode=OPCODES.TEXT] - Frame opcode.
 * @param {boolean} [options.fin=true] - FIN bit.
 * @returns {Buffer} The encoded frame.
 */
function encodeClientFrame(text, { mask = true, opcode = OPCODES.TEXT, fin = true } = {}) {
  const payload = Buffer.from(String(text), "utf8");
  const length = payload.length;
  const first = (fin ? 0x80 : 0) | (opcode & 0x0f);
  let header;
  if (length < 126) {
    header = Buffer.from([first, (mask ? 0x80 : 0) | length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = first;
    header[1] = (mask ? 0x80 : 0) | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = first;
    header[1] = (mask ? 0x80 : 0) | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(length, 6);
  }
  if (!mask) return Buffer.concat([header, payload]);
  const maskKey = crypto.randomBytes(4);
  const masked = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i += 1) {
    masked[i] = payload[i] ^ maskKey[i & 3];
  }
  return Buffer.concat([header, maskKey, masked]);
}

/**
 * Encode a masked binary frame (pong echo / close mirror). Exported for
 * unit tests.
 *
 * @param {Buffer} payload - Raw payload bytes.
 * @param {number} opcode - Frame opcode (PONG / PING / BINARY / CLOSE).
 * @returns {Buffer} The encoded masked frame.
 */
function encodeBinaryClientFrame(payload, opcode) {
  const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const length = buffer.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | (opcode & 0x0f), 0x80 | length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 0x80 | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(length, 6);
  }
  const maskKey = crypto.randomBytes(4);
  const masked = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i += 1) {
    masked[i] = buffer[i] ^ maskKey[i & 3];
  }
  return Buffer.concat([header, maskKey, masked]);
}

/** Shared tax: emit one decoded frame from the RFC 6455 byte stream. */
function pushDecodedFrame(frames, state, fin, opcode, payload) {
  if (opcode === OPCODES.PING) {
    frames.push({ type: "ping", payload: Buffer.from(payload) });
    return;
  }
  if (opcode === OPCODES.PONG) {
    frames.push({ type: "pong", payload: Buffer.from(payload) });
    return;
  }
  if (opcode === OPCODES.CLOSE) {
    if (fin) {
      frames.push({ type: "close", code: closeCode(payload), reason: closeReason(payload) });
      state.partial = null;
      state.partialOpcode = 0;
    }
    return;
  }
  if (opcode === OPCODES.TEXT || opcode === OPCODES.BINARY) {
    if (!fin) {
      state.partial = payload.length > 0 ? Buffer.from(payload) : Buffer.alloc(0);
      state.partialOpcode = opcode;
      return;
    }
    frames.push(textOrBinary(opcode, payload));
    return;
  }
  if (opcode === OPCODES.CONTINUATION) {
    if (state.partial === null) {
      throw new WebSocketStreamError("WS_STREAM_PROTOCOL", "unexpected continuation frame");
    }
    state.partial = Buffer.concat([state.partial, Buffer.from(payload)]);
    if (fin) {
      const completed = textOrBinary(state.partialOpcode, state.partial);
      state.partial = null;
      state.partialOpcode = 0;
      frames.push(completed);
    }
    return;
  }
  throw new WebSocketStreamError("WS_STREAM_PROTOCOL", "unknown opcode " + opcode);
}

/** Convert a TEXT/BINARY opcode + payload into a decoded frame. */
function textOrBinary(opcode, payload) {
  if (opcode === OPCODES.TEXT) {
    if (payload.length > MAX_TEXT_MESSAGE_BYTES) {
      throw new WebSocketStreamError("WS_STREAM_PROTOCOL", "text message exceeds size cap");
    }
    return { type: "text", text: payload.toString("utf8") };
  }
  return { type: "binary", payload: Buffer.from(payload) };
}

/** Parse a close-frame payload into its status code (RFC 6455 5.5.1). */
function closeCode(payload) {
  if (!payload || payload.length < 2) return undefined;
  return payload.readUInt16BE(0);
}

/** Parse a close-frame payload into its UTF-8 reason string. */
function closeReason(payload) {
  if (!payload || payload.length <= 2) return undefined;
  return payload.subarray(2).toString("utf8");
}

/**
 * Parse as many complete WebSocket frames as `buffer` holds, reassembling
 * fragmented messages through a persistent `state`. Exported for unit tests.
 *
 * Incremental contract: a frame that is not fully buffered yet leaves its
 * WHOLE frame (header + partial payload) in `rest`, so the caller feeds the
 * returned `rest` back with more bytes and the parse resumes cleanly. Only
 * complete frames advance the cursor.
 *
 * @param {Buffer} buffer - Accumulated bytes (previous `rest` plus new chunk).
 * @param {object} [state] - Mutable fragmentation state (defaults to fresh).
 * @returns {{frames: Array<object>, rest: Buffer, state: object}} Decoded
 *   frames (`{type:'text'|'binary'|'ping'|'pong'|'close', ...}`), unconsumed
 *   tail bytes, and the updated state.
 * @throws {WebSocketStreamError} WS_STREAM_PROTOCOL on a malformed frame.
 */
function parseServerFrames(buffer, state = { partial: null, partialOpcode: 0 }) {
  const frames = [];
  const length = buffer.length;
  let cursor = 0;
  for (;;) {
    if (length - cursor < 2) break;
    const start = cursor;
    const b0 = buffer[start];
    const fin = (b0 & 0x80) === 0x80;
    if ((b0 & 0x70) !== 0) {
      throw new WebSocketStreamError("WS_STREAM_PROTOCOL", "RSV bits must be zero");
    }
    const opcode = b0 & 0x0f;
    const b1 = buffer[start + 1];
    const masked = (b1 & 0x80) === 0x80;
    let payloadLen = b1 & 0x7f;
    let headerSize = 2;
    if (payloadLen === 126) {
      if (length - start < 4) break;
      payloadLen = buffer.readUInt16BE(start + 2);
      headerSize = 4;
    } else if (payloadLen === 127) {
      if (length - start < 10) break;
      const big = buffer.readBigUInt64BE(start + 2);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new WebSocketStreamError("WS_STREAM_PROTOCOL", "payload length exceeds safe range");
      }
      payloadLen = Number(big);
      headerSize = 10;
    }
    let maskKey = null;
    if (masked) {
      if (length - start < headerSize + 4) break;
      maskKey = buffer.slice(start + headerSize, start + headerSize + 4);
      headerSize += 4;
    }
    if (length - start < headerSize + payloadLen) break; // frame incomplete: keep it in rest
    const payloadStart = start + headerSize;
    let payload = buffer.slice(payloadStart, payloadStart + payloadLen);
    cursor = payloadStart + payloadLen;
    if (maskKey) {
      const unmasked = Buffer.allocUnsafe(payloadLen);
      for (let i = 0; i < payloadLen; i += 1) unmasked[i] = payload[i] ^ maskKey[i & 3];
      payload = unmasked;
    }
    pushDecodedFrame(frames, state, fin, opcode, payload);
    if (cursor === start) break; // defensive: a frame made no progress at all
  }
  return { frames, rest: buffer.subarray(cursor), state };
}

/**
 * Open one WebSocket connection to a remote.mux URL (loopback only).
 *
 * @param {object} options
 * @param {string} options.url - `ws://127.0.0.1:<port>/api/remote.mux`.
 * @param {Function} [options.onText] - Called with every complete text frame;
 *   a throw destroys the socket (handled by the caller's frame loop).
 * @param {AbortSignal} [options.signal] - Abort rejects the handshake or
 *   destroys the socket once open.
 * @returns {Promise<object>} Frozen handle `{ sendText, close, destroy, closed }`.
 * @throws {WebSocketStreamError} On a failed upgrade or protocol error.
 */
function openWebSocket({ url, onText, signal } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return Promise.reject(new WebSocketStreamError("WS_STREAM_MALFORMED_URL", "invalid WebSocket URL"));
  }
  if (!ALLOWED_HOSTNAMES.has(parsed.hostname) || !parsed.port) {
    return Promise.reject(new WebSocketStreamError("WS_STREAM_NOT_LOOPBACK", "WebSocket URL must be loopback"));
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    return Promise.reject(new WebSocketStreamError("WS_STREAM_MALFORMED_URL", "WebSocket URL must use ws"));
  }

  return new Promise((resolve, reject) => {
    const key = buildWebSocketKey();
    let settled = false;
    const parseState = { partial: null, partialOpcode: 0 };

    const fail = (code, message) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(new WebSocketStreamError(code, message));
    };

    const onAbort = () => {
      if (!settled) fail("WS_STREAM_ABORTED", "DSH stream aborted");
      if (socket) socket.destroy();
    };

    let socket = null;

    const request = http.request({
      hostname: parsed.hostname,
      port: Number(parsed.port),
      path: parsed.pathname || "/",
      method: "GET",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": key,
      },
    });

    request.setTimeout(HANDSHAKE_TIMEOUT_MS, () => {
      fail("WS_STREAM_TIMEOUT", "DSH stream handshake timed out");
      request.destroy();
    });
    request.on("error", (err) => {
      fail("WS_STREAM_CONNECT_FAILED", (err && err.message) || String(err));
    });
    request.on("response", (response) => {
      fail(
        "WS_STREAM_UNAVAILABLE",
        "DSH stream unavailable: HTTP " + (response.statusCode || "unknown")
      );
      request.destroy();
    });
    request.on("upgrade", (response, upgraded) => {
      socket = upgraded;
      if (!verifyWebSocketAccept(key, String(response.headers["sec-websocket-accept"] || ""))) {
        fail("WS_STREAM_HANDSHAKE_REJECTED", "DSH stream handshake accept mismatch");
        return;
      }
      if (settled) {
        upgraded.destroy();
        return;
      }
      settled = true;
      if (signal) signal.removeEventListener("abort", onAbort);

      let buffer = Buffer.alloc(0);
      let destroyed = false;
      const closedPromise = new Promise((resolveClosed) => {
        upgraded.on("close", () => resolveClosed(undefined));
      });

      const sendFrame = (frameBuffer) => {
        if (destroyed || upgraded.destroyed) return false;
        upgraded.write(frameBuffer);
        return true;
      };

      upgraded.on("data", (chunk) => {
        buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
        let parsedFrames;
        try {
          parsedFrames = parseServerFrames(buffer, parseState);
        } catch (_) {
          upgraded.destroy();
          return;
        }
        buffer = parsedFrames.rest;
        for (const frame of parsedFrames.frames) {
          if (frame.type === "ping") {
            // RFC 6455 5.5.3: reply with a masked pong carrying the payload.
            sendFrame(encodeBinaryClientFrame(frame.payload, OPCODES.PONG));
            continue;
          }
          if (frame.type === "close") {
            // Mirror the close and drop the socket; `closed` settles.
            sendFrame(encodeBinaryClientFrame(Buffer.from([0x03, 0xe8]), OPCODES.CLOSE));
            upgraded.end();
            continue;
          }
          if (frame.type === "text" && typeof onText === "function") {
            try {
              onText(frame.text);
            } catch (_) {
              upgraded.destroy();
              return;
            }
          }
        }
      });
      upgraded.on("error", () => {
        upgraded.destroy();
      });

      const handle = Object.freeze({
        /**
         * Send one masked text frame.
         * @param {string} text - UTF-8 text.
         * @returns {boolean} True when the frame was written.
         */
        sendText(text) {
          return sendFrame(encodeClientFrame(text));
        },
        /** Destroy the underlying socket immediately. */
        destroy() {
          destroyed = true;
          upgraded.destroy();
        },
        /** Close the socket (best effort; no close-frame negotiation). */
        close() {
          destroyed = true;
          if (!upgraded.destroyed) upgraded.destroy();
        },
        /** Resolves when the underlying socket closes. */
        closed: closedPromise,
      });

      resolve(handle);
    });

    if (signal) {
      if (signal.aborted) {
        fail("WS_STREAM_ABORTED", "DSH stream aborted");
        request.destroy();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    request.end();
  });
}

/**
 * Open one typert Remote stream over `/api/remote.mux`.
 *
 * `done` settles exactly once with `{reason}` where reason is one of
 * `'end'` (server end frame), `'error'` (server error frame; `error`
 * carries `{code, message, details}`), `'closed'` (socket closed without an
 * explicit end), `'aborted'` (caller signal), or `'consumer-error'` (an
 * `onValue` throw - the stream is cancelled).
 *
 * @param {object} options
 * @param {string} options.baseUrl - Loopback base URL
 *   (`http://127.0.0.1:<port>` or `http://localhost:<port>`).
 * @param {string} options.endpoint - Typert stream endpoint (`session/follow`).
 * @param {object} options.args - Endpoint argument map
 *   (`{ request: { ... } }`).
 * @param {Function} [options.onValue] - Called with every item `value`.
 * @param {AbortSignal} [options.signal] - Abort cancels the stream with
 *   `'aborted'`.
 * @returns {Promise<object>} Frozen handle `{ streamId, cancel, done }`.
 */
async function createTypertStream({ baseUrl, endpoint, args, onValue, signal } = {}) {
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    throw new TypeError("endpoint must be a non-empty string");
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new TypeError("args must be an object");
  }
  const streamId = crypto.randomUUID();
  if (signal && signal.aborted) {
    return Object.freeze({
      streamId,
      cancel: () => {},
      done: Promise.resolve(Object.freeze({ reason: "aborted" })),
    });
  }

  // All stream state lives here so the frame router below can reference it
  // before the socket resolves.
  let wsHandle = null;
  let settledFlag = false;
  let resolveDone = null;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const settle = (result) => {
    if (settledFlag) return;
    settledFlag = true;
    resolveDone(Object.freeze(result));
  };
  const closeQuietly = () => {
    if (wsHandle) {
      try {
        wsHandle.close();
      } catch (_) {
        /* already dead */
      }
    }
  };

  const routeText = (text) => {
    if (settledFlag) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch (_) {
      settle({ reason: "error", error: { code: "malformed-frame", message: "stream frame is not JSON" } });
      closeQuietly();
      return;
    }
    if (
      !message || typeof message !== "object" || Array.isArray(message)
      || message.streamId !== streamId
    ) {
      return; // non-matching or malformed frames are ignored
    }
    if (message.type === "item") {
      if (typeof onValue === "function") {
        try {
          onValue(message.value);
        } catch (err) {
          const detail = err && err.message ? String(err.message) : String(err);
          settle({ reason: "consumer-error", error: { name: "Error", message: detail } });
          try {
            if (wsHandle) wsHandle.sendText(JSON.stringify({ type: "cancel", streamId }));
          } catch (_) {
            /* socket already gone */
          }
          closeQuietly();
        }
      }
      return;
    }
    if (message.type === "end") {
      settle({ reason: "end" });
      closeQuietly();
      return;
    }
    if (message.type === "error") {
      const error = message.error && typeof message.error === "object" ? message.error : {};
      settle({ reason: "error", error });
      closeQuietly();
      return;
    }
  };

  wsHandle = await openWebSocket({
    url: remoteMuxUrlFromBaseUrl(baseUrl),
    signal,
    onText: routeText,
  });

  wsHandle.closed.then(() => {
    if (!settledFlag) settle({ reason: "closed" });
  });

  wsHandle.sendText(
    JSON.stringify({ type: "open", streamId, endpoint, payload: { args } })
  );

  return Object.freeze({
    streamId,
    /**
     * Send a cancel frame and close the socket; idempotent and safe after
     * the stream settled.
     */
    cancel() {
      if (settledFlag) return;
      try {
        wsHandle.sendText(JSON.stringify({ type: "cancel", streamId }));
      } catch (_) {
        /* socket already gone */
      }
      closeQuietly();
    },
    done,
  });
}

module.exports = {
  WebSocketStreamError,
  REMOTE_STREAM_MUX_PATH,
  buildWebSocketKey,
  verifyWebSocketAccept,
  encodeClientFrame,
  encodeBinaryClientFrame,
  parseServerFrames,
  remoteMuxUrlFromBaseUrl,
  openWebSocket,
  createTypertStream,
};