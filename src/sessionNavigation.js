"use strict";

/**
 * Session navigation for the DSH sidebar.
 *
 * Thin client over the DSH Web API's session.list / session.create methods
 * plus pure mapping helpers for the QuickPick UI. The extension host does not
 * keep a second session tree: the DSH server stays the single source of truth
 * and the sidebar only remembers the one session id that should be passed to
 * the iframe as the `dsh_session` query parameter.
 */

const path = require("node:path");
const crypto = require("node:crypto");

/** API path for the JSON-RPC session methods. @type {string} */
const SESSION_LIST_PATH = "/api/session.list";
/** API path for the JSON-RPC session methods. @type {string} */
const SESSION_CREATE_PATH = "/api/session.create";

/** Valid base URL hostnames for the loopback DSH Web API. */
const ALLOWED_HOSTNAMES = new Set(["127.0.0.1", "localhost"]);

/** Maximum length of a session id that may be embedded in an iframe URL. */
const MAX_SESSION_ID_LENGTH = 200;

/**
 * Error raised by the session navigation client. `code` is one of the
 * DSH_SESSION_* constants so callers can branch without string matching.
 */
class DshSessionError extends Error {
  /**
   * @param {string} code - DSH_SESSION_API_UNAVAILABLE | DSH_SESSION_API_INVALID_RESPONSE | DSH_SESSION_API_BUSINESS_ERROR | DSH_SESSION_INVALID_SESSION_ID
   * @param {string} message - Human-readable detail.
   */
  constructor(code, message) {
    super(message || code);
    this.name = "DshSessionError";
    this.code = code;
  }
}

/**
 * Parse and validate the loopback base URL.
 *
 * @param {string} baseUrl - Base URL of the DSH web server.
 * @returns {URL} Parsed base URL.
 * @throws {DshSessionError} DSH_SESSION_API_UNAVAILABLE when the URL is not
 *   `http://127.0.0.1:<port>` or `http://localhost:<port>`.
 */
function assertLoopbackBaseUrl(baseUrl) {
  let parsed;
  try {
    parsed = new URL(String(baseUrl || ""));
  } catch (_) {
    throw new DshSessionError(
      "DSH_SESSION_API_UNAVAILABLE",
      "DSH session API unavailable: invalid base URL"
    );
  }
  if (
    parsed.protocol !== "http:"
    || !ALLOWED_HOSTNAMES.has(parsed.hostname)
    || !parsed.port
  ) {
    throw new DshSessionError(
      "DSH_SESSION_API_UNAVAILABLE",
      "DSH session API unavailable: base URL must be http://127.0.0.1:<port> or http://localhost:<port>"
    );
  }
  return parsed;
}

/**
 * Resolve an API path against a validated loopback base URL. Using the URL
 * API keeps the host/port untouched and replaces any path on the base.
 *
 * @param {URL} baseUrl - Validated base URL.
 * @param {string} apiPath - API path, e.g. "/api/session.list".
 * @returns {string} Absolute endpoint URL.
 */
function endpointUrl(baseUrl, apiPath) {
  return new URL(apiPath, baseUrl).toString();
}

/**
 * Resolve the fetch implementation from options.
 *
 * @param {object} options - Caller options.
 * @returns {Function} fetch implementation.
 * @throws {DshSessionError} DSH_SESSION_API_UNAVAILABLE when no function is available.
 */
function resolveFetchImpl(options) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new DshSessionError(
      "DSH_SESSION_API_UNAVAILABLE",
      "DSH session API unavailable: fetch implementation is not a function"
    );
  }
  return fetchImpl;
}

/**
 * True for fetch AbortError rejections, which must propagate unchanged so the
 * caller can distinguish cancellation from a real API failure.
 *
 * @param {*} err - Rejection value.
 * @returns {boolean} True when `err` is an AbortError.
 */
function isAbortError(err) {
  return Boolean(err) && (err.name === "AbortError" || err.code === "ABORT_ERR");
}

/**
 * Build the JSON-RPC request envelope shared by all session methods.
 *
 * @param {string} method - DSH method name.
 * @param {object} payload - Method payload.
 * @returns {object} JSON-RPC client request envelope.
 */
function clientRequest(method, payload) {
  return {
    type: "client-request",
    rpcId: crypto.randomUUID(),
    method,
    payload,
  };
}

/**
 * Read and JSON-parse a response body once.
 *
 * @param {Response} response - Fetch Response-like object.
 * @returns {Promise<object>} Parsed JSON body.
 * @throws {DshSessionError} DSH_SESSION_API_INVALID_RESPONSE on invalid JSON.
 */
async function readJsonBody(response) {
  let text;
  try {
    text = await response.text();
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new DshSessionError(
      "DSH_SESSION_API_UNAVAILABLE",
      "DSH session API unavailable: " + (err && err.message ? err.message : String(err))
    );
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new DshSessionError(
      "DSH_SESSION_API_INVALID_RESPONSE",
      "DSH session API invalid response: body is not valid JSON"
    );
  }
}

/**
 * Validate the server-response envelope shared by all session methods and
 * return its `result` object.
 *
 * @param {object} body - Parsed response body.
 * @returns {object} The `result` object.
 * @throws {DshSessionError} INVALID_RESPONSE on structural mismatch.
 * @throws {DshSessionError} BUSINESS_ERROR when result.ok === false.
 */
function assertServerResponse(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new DshSessionError(
      "DSH_SESSION_API_INVALID_RESPONSE",
      "DSH session API invalid response: body must be a JSON object"
    );
  }
  const result = body.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new DshSessionError(
      "DSH_SESSION_API_INVALID_RESPONSE",
      "DSH session API invalid response: result must be an object"
    );
  }
  if (result.ok === false) {
    const errorCode = result.error && typeof result.error === "object"
      ? result.error.code
      : undefined;
    const err = new DshSessionError(
      "DSH_SESSION_API_BUSINESS_ERROR",
      "DSH session API business error" + (errorCode ? `: ${errorCode}` : "")
    );
    if (errorCode !== undefined) {
      err.businessCode = errorCode;
    }
    throw err;
  }
  if (result.ok !== true) {
    throw new DshSessionError(
      "DSH_SESSION_API_INVALID_RESPONSE",
      "DSH session API invalid response: result.ok must be true or false"
    );
  }
  return result;
}

/**
 * Perform the POST shared by all session methods.
 *
 * @param {string} baseUrl - Validated loopback base URL.
 * @param {string} apiPath - API path.
 * @param {object} envelope - JSON-RPC request envelope.
 * @param {Function} fetchImpl - Fetch implementation.
 * @param {AbortSignal} [signal] - Optional abort signal.
 * @returns {Promise<Response>} Fetch response.
 * @throws {DshSessionError} DSH_SESSION_API_UNAVAILABLE on network / non-200.
 */
async function postJson(baseUrl, apiPath, envelope, fetchImpl, signal) {
  let response;
  try {
    response = await fetchImpl(endpointUrl(baseUrl, apiPath), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
      signal,
    });
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new DshSessionError(
      "DSH_SESSION_API_UNAVAILABLE",
      "DSH session API unavailable: " + (err && err.message ? err.message : String(err))
    );
  }
  if (!response || typeof response.status !== "number") {
    throw new DshSessionError(
      "DSH_SESSION_API_UNAVAILABLE",
      "DSH session API unavailable: invalid fetch response"
    );
  }
  if (response.status !== 200) {
    throw new DshSessionError(
      "DSH_SESSION_API_UNAVAILABLE",
      "DSH session API unavailable: HTTP " + response.status
    );
  }
  return response;
}

/**
 * List DSH sessions through `POST <baseUrl>/api/session.list`.
 *
 * @param {string} baseUrl - Loopback base URL (`http://127.0.0.1:<port>` or
 *   `http://localhost:<port>`).
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] - Fetch-compatible function; defaults
 *   to `globalThis.fetch`.
 * @param {AbortSignal} [options.signal] - Optional abort signal.
 * @returns {Promise<Array<object>>} New array of session items sorted by
 *   `updatedAt` descending. The input is never mutated.
 * @throws {DshSessionError} With the DSH_SESSION_API_* error codes.
 */
async function listSessions(baseUrl, options = {}) {
  const fetchImpl = resolveFetchImpl(options);
  const parsed = assertLoopbackBaseUrl(baseUrl);
  const response = await postJson(
    parsed,
    SESSION_LIST_PATH,
    clientRequest("session.list", {}),
    fetchImpl,
    options.signal
  );
  const body = await readJsonBody(response);
  const result = assertServerResponse(body);
  const value = result.value;
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.items)) {
    throw new DshSessionError(
      "DSH_SESSION_API_INVALID_RESPONSE",
      "DSH session API invalid response: result.value.items must be an array"
    );
  }
  for (const item of value.items) {
    if (
      !item || typeof item !== "object" || Array.isArray(item)
      || typeof item.sessionId !== "string" || item.sessionId.length === 0
    ) {
      throw new DshSessionError(
        "DSH_SESSION_API_INVALID_RESPONSE",
        "DSH session API invalid response: each session item must have a non-empty sessionId string"
      );
    }
  }
  return [...value.items].sort(
    (a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0)
  );
}

/**
 * Create a DSH session through `POST <baseUrl>/api/session.create`.
 *
 * @param {string} baseUrl - Loopback base URL (`http://127.0.0.1:<port>` or
 *   `http://localhost:<port>`).
 * @param {object} [options]
 * @param {string} [options.cwd] - Workspace root for the new session; only
 *   included in the payload when it is a non-empty string.
 * @param {Function} [options.fetchImpl] - Fetch-compatible function; defaults
 *   to `globalThis.fetch`.
 * @param {AbortSignal} [options.signal] - Optional abort signal.
 * @returns {Promise<string>} The created session id.
 * @throws {DshSessionError} With the DSH_SESSION_API_* error codes.
 */
async function createSession(baseUrl, options = {}) {
  const fetchImpl = resolveFetchImpl(options);
  const parsed = assertLoopbackBaseUrl(baseUrl);
  const payload = {};
  if (typeof options.cwd === "string" && options.cwd.length > 0) {
    payload.cwd = options.cwd;
  }
  const response = await postJson(
    parsed,
    SESSION_CREATE_PATH,
    clientRequest("session.create", payload),
    fetchImpl,
    options.signal
  );
  const body = await readJsonBody(response);
  const result = assertServerResponse(body);
  const value = result.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DshSessionError(
      "DSH_SESSION_API_INVALID_RESPONSE",
      "DSH session API invalid response: result.value must be an object"
    );
  }
  if (typeof value.sessionId !== "string" || value.sessionId.length === 0) {
    throw new DshSessionError(
      "DSH_SESSION_API_INVALID_RESPONSE",
      "DSH session API invalid response: result.value.sessionId must be a non-empty string"
    );
  }
  return value.sessionId;
}

/**
 * Reduce raw session items to root (non-subagent, non-child) QuickPick rows.
 *
 * Only `sessionId` is required; every other field is passed through loosely.
 *
 * @param {Array<object>} items - Raw `session.list` items.
 * @returns {Array<object>} Rows shaped as
 *   `{ sessionId, title, cwd, updatedAt, running, blank }`.
 */
function rootSessionItems(items) {
  if (!Array.isArray(items)) return [];
  const rows = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    if (item.origin === "subagent") continue;
    if (item.parentSessionId) continue;
    const title = item.projections
      && item.projections.values
      && item.projections.values.sessionTitle
      && typeof item.projections.values.sessionTitle.title === "string"
      && item.projections.values.sessionTitle.title.length > 0
      ? item.projections.values.sessionTitle.title
      : item.sessionId;
    rows.push({
      sessionId: item.sessionId,
      title,
      cwd: item.cwd,
      updatedAt: item.updatedAt,
      running: item.running,
      blank: item.blank,
    });
  }
  return rows;
}

/**
 * Compare two cwd values with platform-appropriate normalization.
 *
 * @param {string} a - First path.
 * @param {string} b - Second path.
 * @returns {boolean} True when both resolve to the same workspace root.
 */
function sameCwd(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = path.resolve(a);
  const right = path.resolve(b);
  if (process.platform === "win32") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

/**
 * Find a blank root session for the given cwd and return its session id.
 *
 * @param {Array<object>} items - Raw `session.list` items.
 * @param {string} cwd - Workspace root to match.
 * @returns {string|null} session id, or null when cwd is empty or no blank
 *   session matches the resolved cwd.
 */
function reuseBlankSession(items, cwd) {
  if (!cwd || typeof cwd !== "string") return null;
  for (const row of rootSessionItems(items)) {
    if (row.blank === true && sameCwd(row.cwd, cwd)) {
      return row.sessionId;
    }
  }
  return null;
}

/**
 * Format a relative update time using a deliberately small/simple rule set.
 *
 * @param {number} updatedAt - Unix epoch milliseconds.
 * @param {number} now - Reference epoch milliseconds.
 * @param {boolean} zh - True for Simplified Chinese labels.
 * @returns {string} Relative time label (or ISO date for ≥ 24h).
 */
function relativeUpdatedLabel(updatedAt, now, zh) {
  const numeric = Number(updatedAt);
  if (!Number.isFinite(numeric)) {
    return new Date(0).toISOString();
  }
  const seconds = Math.floor(Math.max(0, now - numeric) / 1000);
  if (seconds < 60) return zh ? "刚刚" : "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return zh ? `${minutes} 分钟前` : `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return zh ? `${hours} 小时前` : `${hours} h ago`;
  return new Date(numeric).toISOString();
}

/**
 * Build VS Code QuickPick items from root session rows.
 *
 * The label is the session title only — the workspace path is never placed in
 * the label (it is the description when present).
 *
 * @param {Array<object>} rows - Root session rows (see `rootSessionItems`).
 * @param {object} [options]
 * @param {string} [options.locale='en'] - `zh` selects Simplified Chinese.
 * @param {number} [options.now=Date.now()] - Reference time for relative labels.
 * @returns {Array<object>} QuickPick items with `label`, `description`, `detail`.
 */
function buildQuickPickItems(rows, { locale = "en", now = Date.now() } = {}) {
  const zh = locale === "zh";
  return rows.map((row) => {
    const title = row && typeof row.title === "string" && row.title.length > 0
      ? row.title
      : row && row.sessionId;
    const description = row && (row.cwd || row.sessionId);
    const statuses = [];
    if (row && row.running) statuses.push(zh ? "运行中" : "running");
    if (row && row.blank) statuses.push(zh ? "新会话" : "new");
    if (statuses.length > 0) {
      return { label: title, description, detail: statuses.join(" · ") };
    }
    const prefix = zh ? "更新于 " : "updated ";
    return {
      label: title,
      description,
      detail: prefix + relativeUpdatedLabel(row && row.updatedAt, now, zh),
    };
  });
}

/**
 * Show a VS Code QuickPick for session selection and resolve with the chosen
 * root session row (or null on cancel/hide). The QuickPick is disposed after
 * either event. Pure-mapping tests should cover `buildQuickPickItems`; this
 * wrapper intentionally stays small.
 *
 * @param {object} vscode - VS Code API facade.
 * @param {Array<object>} rows - Root session rows.
 * @param {object} [options]
 * @param {string} [options.placeholder='Select a DSH session'] - Placeholder text.
 * @param {string} [options.locale] - Forwarded to `buildQuickPickItems`.
 * @param {number} [options.now] - Forwarded to `buildQuickPickItems`.
 * @returns {Promise<object|null>} Selected row or null.
 */
function showSessionQuickPick(vscode, rows, options = {}) {
  if (
    !vscode
    || !vscode.window
    || typeof vscode.window.createQuickPick !== "function"
  ) {
    return Promise.reject(new TypeError("vscode.window.createQuickPick must be a function"));
  }
  const {
    placeholder = "Select a DSH session",
    locale,
    now,
  } = options;
  const pickerItems = buildQuickPickItems(rows, { locale, now });
  const rowByItem = new Map();
  rows.forEach((row, index) => {
    if (pickerItems[index]) rowByItem.set(pickerItems[index], row);
  });
  const picker = vscode.window.createQuickPick();
  picker.canPickMany = false;
  picker.items = pickerItems;
  picker.placeholder = placeholder;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        picker.dispose();
      } catch (_) { /* ignore dispose failures */ }
      resolve(value);
    };
    if (typeof picker.onDidAccept === "function") {
      picker.onDidAccept(() => {
        const selected = picker.selectedItems && picker.selectedItems[0];
        finish(selected ? (rowByItem.get(selected) || null) : null);
      });
    }
    if (typeof picker.onDidHide === "function") {
      picker.onDidHide(() => finish(null));
    }
    picker.show();
  });
}

/**
 * Validate a session id value before it is embedded in an iframe URL.
 *
 * @param {string} value - Candidate session id.
 * @returns {string} The original value when valid.
 * @throws {DshSessionError} DSH_SESSION_INVALID_SESSION_ID.
 */
function sessionIdFromValue(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_SESSION_ID_LENGTH
    || value.includes("\0")
  ) {
    throw new DshSessionError(
      "DSH_SESSION_INVALID_SESSION_ID",
      "DSH session id must be a non-empty string of at most 200 characters without NUL"
    );
  }
  return value;
}

module.exports = {
  DshSessionError,
  listSessions,
  createSession,
  rootSessionItems,
  reuseBlankSession,
  buildQuickPickItems,
  showSessionQuickPick,
  sessionIdFromValue,
};
