'use strict';

/**
 * Frozen exports face for driving DSH as a programmable agent.
 *
 * This module is deliberately pure: every dependency is injected, so the core
 * never imports the real HTTP client, session navigation, or VS Code workspace
 * modules. The asm layer wires these deps to the real implementations.
 */

/** Maximum accepted prompt length in characters. */
const MAX_PROMPT_LENGTH = 100000;

/** Frozen error codes raised by the exports face. */
const DSH_EXPORT_DISABLED = 'DSH_EXPORT_DISABLED';
const DSH_EXPORT_NO_SERVER = 'DSH_EXPORT_NO_SERVER';
const DSH_EXPORT_INVALID_PROMPT = 'DSH_EXPORT_INVALID_PROMPT';
const DSH_EXPORT_INVALID_URI = 'DSH_EXPORT_INVALID_URI';
const DSH_EXPORT_OUTSIDE_WORKSPACE = 'DSH_EXPORT_OUTSIDE_WORKSPACE';
const DSH_EXPORT_TOO_LARGE = 'DSH_EXPORT_TOO_LARGE';
const DSH_EXPORT_TOO_MANY_FILES = 'DSH_EXPORT_TOO_MANY_FILES';

/**
 * Error raised by the exports face. Carries a stable machine-readable `code`
 * so callers can branch without string matching the message.
 */
class DshExportError extends Error {
  /**
   * @param {string} code - One of the DSH_EXPORT_* error codes.
   * @param {string} message - Human-readable error message.
   */
  constructor(code, message) {
    super(message || code);
    this.name = 'DshExportError';
    this.code = code;
  }
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * Minimal l10n fallback for tests and non-localized hosts, mirroring the
 * `defaultLoc` precedent in src/commands/addFileToThread.js.
 *
 * @param {string} template - Message template with `{key}` placeholders.
 * @param {object} [params] - Placeholder values.
 * @returns {string} Interpolated message.
 */
function defaultLoc(template, params = {}) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? `{${key}}`));
}

/**
 * Create the frozen exports face.
 *
 * @param {object} deps - Injected dependencies (all fake in core tests).
 * @param {Function} deps.isEnabled - Feature gate for `dsh.features.exports`.
 * @param {object} deps.chatClient - Chat client with `prompt()` (the
 *   `createDshChatClient` return face).
 * @param {Function} deps.resolveSessionId - Resolves the current workspace
 *   session id when `ask` is called without an explicit sessionId.
 * @param {Function} deps.listSessionsFn - Lists sessions via
 *   `sessionNavigation.listSessions(currentServer.url, { signal })`.
 * @param {Function} deps.getBaseUrl - Returns the current DSH server URL, or
 *   null/undefined/empty when no server is connected.
 * @param {object} deps.editorContext - Editor context with `attachFiles` and
 *   `attachFolder`.
 * @param {Function} [deps.loc] - Localization helper (defaults to
 *   `defaultLoc`).
 * @param {object} deps.vscode - VS Code facade; only `Uri.isUri` and
 *   `Uri.parse` are used.
 * @returns {object} Frozen `{ version, ask, listSessions, addContext }` face.
 */
function createExportsFace(deps) {
  if (!isRecord(deps)) throw new TypeError('deps must be an object');
  if (typeof deps.isEnabled !== 'function') {
    throw new TypeError('deps.isEnabled must be a function');
  }
  if (!isRecord(deps.chatClient) || typeof deps.chatClient.prompt !== 'function') {
    throw new TypeError('deps.chatClient.prompt must be a function');
  }
  if (typeof deps.resolveSessionId !== 'function') {
    throw new TypeError('deps.resolveSessionId must be a function');
  }
  if (typeof deps.listSessionsFn !== 'function') {
    throw new TypeError('deps.listSessionsFn must be a function');
  }
  if (typeof deps.getBaseUrl !== 'function') {
    throw new TypeError('deps.getBaseUrl must be a function');
  }
  if (
    !isRecord(deps.editorContext)
    || typeof deps.editorContext.attachFiles !== 'function'
    || typeof deps.editorContext.attachFolder !== 'function'
  ) {
    throw new TypeError('deps.editorContext.attachFiles and deps.editorContext.attachFolder must be functions');
  }
  if (
    !isRecord(deps.vscode)
    || !isRecord(deps.vscode.Uri)
    || typeof deps.vscode.Uri.parse !== 'function'
    || typeof deps.vscode.Uri.isUri !== 'function'
  ) {
    throw new TypeError('deps.vscode.Uri.parse and deps.vscode.Uri.isUri must be functions');
  }

  const isEnabled = deps.isEnabled;
  const chatClient = deps.chatClient;
  const resolveSessionId = deps.resolveSessionId;
  const listSessionsFn = deps.listSessionsFn;
  const getBaseUrl = deps.getBaseUrl;
  const editorContext = deps.editorContext;
  const vscodeUri = deps.vscode.Uri;
  const loc = typeof deps.loc === 'function' ? deps.loc : defaultLoc;

  /**
   * @param {string} code - DSH_EXPORT_* code.
   * @param {string} message - Message template (localized via `loc`).
   * @returns {DshExportError} Localized export error.
   */
  function exportError(code, message) {
    return new DshExportError(code, loc(message));
  }

  /**
   * @returns {void}
   * @throws {DshExportError} DSH_EXPORT_DISABLED when the feature is off.
   */
  function assertEnabled() {
    if (!isEnabled()) {
      throw exportError(
        DSH_EXPORT_DISABLED,
        'DSH export is disabled; enable dsh.features.exports in settings'
      );
    }
  }

  /**
   * @returns {string} Current DSH server base URL.
   * @throws {DshExportError} DSH_EXPORT_NO_SERVER when no server is connected.
   */
  function assertServer() {
    const baseUrl = getBaseUrl();
    if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
      throw exportError(DSH_EXPORT_NO_SERVER, 'DSH export unavailable: no DSH server URL');
    }
    return baseUrl;
  }

  /**
   * @param {string} message - Invalid-prompt detail message.
   * @returns {never}
   * @throws {DshExportError} DSH_EXPORT_INVALID_PROMPT.
   */
  function invalidPrompt(message) {
    throw exportError(DSH_EXPORT_INVALID_PROMPT, message);
  }

  /**
   * @param {string} message - Invalid-URI detail message.
   * @returns {never}
   * @throws {DshExportError} DSH_EXPORT_INVALID_URI.
   */
  function invalidUri(message) {
    throw exportError(DSH_EXPORT_INVALID_URI, message);
  }

  /**
   * Resolve and validate the addContext `uri` argument.
   *
   * @param {object|string} uri - VS Code URI or URI string.
   * @returns {object} Parsed file-scheme URI object.
   * @throws {DshExportError} DSH_EXPORT_INVALID_URI on parse failures,
   *   non-file schemes, and non-Uri objects.
   */
  function parseUri(uri) {
    if (typeof uri === 'string') {
      let parsed;
      try {
        parsed = vscodeUri.parse(uri);
      } catch (err) {
        throw invalidUri(
          `DSH export context URI could not be parsed: ${err && err.message ? err.message : String(err)}`
        );
      }
      if (!parsed || typeof parsed !== 'object' || parsed.scheme !== 'file') {
        throw invalidUri('DSH export context URI must use the file scheme');
      }
      return parsed;
    }
    if (isRecord(uri) && vscodeUri.isUri(uri) === true) {
      if (uri.scheme !== 'file') {
        throw invalidUri('DSH export context URI must use the file scheme');
      }
      return uri;
    }
    throw invalidUri('DSH export context URI must be a vscode.Uri or a file URI string');
  }

  /**
   * Validate the optional addContext range shape.
   *
   * @param {object|undefined} range - `{ start: { line, character }, end:
   *   { line, character } }`.
   * @returns {object|undefined} The range when valid (undefined stays
   *   undefined).
   * @throws {DshExportError} DSH_EXPORT_INVALID_URI on shape violations.
   */
  function assertRangeShape(range) {
    if (range === undefined) return undefined;
    if (!isRecord(range) || !isRecord(range.start) || !isRecord(range.end)) {
      throw invalidUri('DSH export range must be { start: { line, character }, end: { line, character } }');
    }
    for (const coordinate of [range.start.line, range.start.character, range.end.line, range.end.character]) {
      if (!Number.isInteger(coordinate) || coordinate < 0) {
        throw invalidUri('DSH export range coordinates must be non-negative integers');
      }
    }
    return range;
  }

  /**
   * Duck-typed EditorContextError check. The core never imports the real
   * editorContext module, so it recognizes the injected error by its frozen
   * shape: `name === 'EditorContextError'` plus a string `bridgeCode`.
   *
   * @param {*} err - Thrown value.
   * @returns {boolean} True when `err` looks like an EditorContextError.
   */
  function isEditorContextError(err) {
    return Boolean(err) && err.name === 'EditorContextError' && typeof err.bridgeCode === 'string';
  }

  /**
   * Map editor-context bridge errors onto the frozen DSH_EXPORT_* surface.
   *
   * - `VSCODE_URI_OUTSIDE_WORKSPACE` → `DSH_EXPORT_OUTSIDE_WORKSPACE`
   * - size-limit errors (bridgeCode contains `TOO_LARGE`, or the message
   *   matches the editor-context budget-limit text) → `DSH_EXPORT_TOO_LARGE`
   * - every other error is returned unchanged (error direct-display rule).
   *
   * @param {*} err - Thrown value.
   * @returns {*} DshExportError replacement, or the original error.
   */
  function mapEditorContextError(err) {
    if (!isEditorContextError(err)) return err;
    if (err.bridgeCode === 'VSCODE_URI_OUTSIDE_WORKSPACE') {
      return new DshExportError(DSH_EXPORT_OUTSIDE_WORKSPACE, err.message);
    }
    if (err.bridgeCode.includes('TOO_LARGE') || /byte limit/i.test(err.message || '')) {
      return new DshExportError(DSH_EXPORT_TOO_LARGE, err.message);
    }
    return err;
  }

  /**
   * Ask DSH as a programmable agent.
   *
   * @param {string} prompt - Non-empty prompt of at most 100000 characters.
   * @param {object} [opts] - Options.
   * @param {string} [opts.sessionId] - Explicit session id; when omitted the
   *   current workspace session is resolved via `resolveSessionId()`.
   * @param {string} [opts.mode='queue'] - `'queue'` or `'steer'`.
   * @param {AbortSignal} [opts.signal] - Caller abort signal, forwarded to
   *   `chatClient.prompt`.
   * @returns {Promise<{accepted: true, sessionId: string}>} Chat client result.
   */
  async function ask(prompt, opts = {}) {
    assertEnabled();
    if (typeof prompt !== 'string' || prompt.length === 0 || prompt.length > MAX_PROMPT_LENGTH) {
      invalidPrompt('DSH export prompt must be a non-empty string of at most 100000 characters');
    }
    if (opts.sessionId !== undefined) {
      if (typeof opts.sessionId !== 'string' || opts.sessionId.length === 0) {
        invalidPrompt('DSH export sessionId must be a non-empty string');
      }
    }
    const mode = opts.mode === undefined ? 'queue' : opts.mode;
    if (mode !== 'queue' && mode !== 'steer') {
      invalidPrompt("DSH export mode must be 'queue' or 'steer'");
    }
    assertServer();
    let sessionId = opts.sessionId;
    if (sessionId === undefined) {
      // resolveSessionId errors propagate unchanged (unwrapped).
      sessionId = await resolveSessionId();
    }
    return chatClient.prompt({ sessionId, content: prompt, mode, signal: opts.signal });
  }

  /**
   * List DSH sessions.
   *
   * @param {object} [opts] - Options.
   * @param {AbortSignal} [opts.signal] - Caller abort signal, forwarded to
   *   `listSessionsFn`.
   * @returns {Promise<Array<object>>} Sorted session items (pass-through).
   */
  async function listSessions(opts = {}) {
    assertEnabled();
    assertServer();
    return listSessionsFn({ signal: opts.signal });
  }

  /**
   * Attach a file or folder to the current DSH context.
   *
   * A URI whose string form ends with `/` is treated as a folder; anything
   * else is attached as a file. `attachFiles` is async and returns an array,
   * while `attachFolder` returns a single attachment.
   *
   * @param {object|string} uri - VS Code URI or file-scheme URI string.
   * @param {object} [range] - Optional `{ start: { line, character }, end:
   *   { line, character } }` for file attachments.
   * @returns {Promise<{id: *, kind: 'file'|'folder', uri: string}>} Attachment
   *   projection with the first returned attachment id.
   */
  async function addContext(uri, range) {
    assertEnabled();
    const parsed = parseUri(uri);
    const uriString = typeof uri === 'string' ? uri : uri.toString();
    assertRangeShape(range);

    if (uriString.endsWith('/')) {
      let attachment;
      try {
        attachment = editorContext.attachFolder(parsed);
      } catch (err) {
        throw mapEditorContextError(err);
      }
      return {
        id: attachment && attachment.id,
        kind: 'folder',
        uri: uriString,
      };
    }

    let attachments;
    try {
      attachments = await editorContext.attachFiles([parsed], { range });
    } catch (err) {
      throw mapEditorContextError(err);
    }
    const first = Array.isArray(attachments) ? attachments[0] : undefined;
    return {
      id: first && first.id,
      kind: 'file',
      uri: uriString,
    };
  }

  return Object.freeze({ version: '1', ask, listSessions, addContext });
}

module.exports = {
  DshExportError,
  createExportsFace,
};
