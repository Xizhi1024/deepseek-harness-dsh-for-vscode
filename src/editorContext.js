'use strict';

const { Buffer } = require('node:buffer');

/**
 * Default maximum attachment content size in UTF-8 bytes.
 * @type {number}
 */
const DEFAULT_MAX_ATTACHMENT_BYTES = 1 * 1024 * 1024;

/**
 * Default maximum number of diagnostics returned per request/attachment.
 * @type {number}
 */
const DEFAULT_MAX_DIAGNOSTIC_ITEMS = 1000;

/**
 * Default maximum number of characters kept from a diagnostic message.
 * @type {number}
 */
const DEFAULT_MAX_DIAGNOSTIC_MESSAGE_CHARS = 2000;

/**
 * Supported editor attachment kinds, in wire-protocol spelling.
 * @type {readonly string[]}
 */
const ATTACHMENT_KINDS = Object.freeze(['active-file', 'selection', 'problems']);

/**
 * Error raised by editor-context operations. Carries a stable bridge code
 * that versionedBridgeServer serializes into the JSON-RPC error data.
 */
class EditorContextError extends Error {
  /**
   * @param {string} bridgeCode - Stable machine-readable error code.
   * @param {string} message - Human-readable error message.
   */
  constructor(bridgeCode, message) {
    super(message);
    this.name = 'EditorContextError';
    this.bridgeCode = bridgeCode;
  }
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function deepClone(value) {
  if (Array.isArray(value)) return value.map((item) => deepClone(item));
  if (isRecord(value)) {
    const cloned = {};
    for (const [key, entry] of Object.entries(value)) cloned[key] = deepClone(entry);
    return cloned;
  }
  return value;
}

function invalidParams(message) {
  return new EditorContextError('VSCODE_INVALID_PARAMS', message);
}

/**
 * Validate the VS Code facade surface consumed by this module.
 *
 * Uri.parse, workspace.getWorkspaceFolder, workspace.isTrusted,
 * workspace.openTextDocument, window.activeTextEditor,
 * window.showTextDocument, languages.getDiagnostics and
 * commands.executeCommand must be present. The members that are methods in
 * the real VS Code API are checked for function type; workspaceFolders,
 * workspace.isTrusted and window.activeTextEditor are data properties (their
 * runtime values may legitimately be undefined) and are checked for property
 * presence only.
 *
 * @param {object} vscode - VS Code facade.
 * @returns {void}
 */
function assertVscodeFacade(vscode) {
  if (!isRecord(vscode)) throw new TypeError('vscode facade must be an object');
  const functionMembers = [
    ['Uri', 'parse'],
    ['workspace', 'getWorkspaceFolder'],
    ['workspace', 'openTextDocument'],
    ['window', 'showTextDocument'],
    ['languages', 'getDiagnostics'],
    ['commands', 'executeCommand'],
  ];
  for (const [owner, member] of functionMembers) {
    const ownerObject = vscode[owner];
    if (!ownerObject || typeof ownerObject[member] !== 'function') {
      throw new TypeError(`vscode.${owner}.${member} must be a function`);
    }
  }
  if (!isRecord(vscode.workspace) || !('workspaceFolders' in vscode.workspace)) {
    throw new TypeError('vscode.workspace.workspaceFolders is required');
  }
  if (!isRecord(vscode.workspace) || !('isTrusted' in vscode.workspace)) {
    throw new TypeError('vscode.workspace.isTrusted is required');
  }
  if (!isRecord(vscode.window) || !('activeTextEditor' in vscode.window)) {
    throw new TypeError('vscode.window.activeTextEditor is required');
  }
}

/**
 * @param {object} options - Options for createEditorContext.
 * @param {object} options.vscode - VS Code facade.
 * @param {object} [options.limits] - Optional limit overrides.
 * @param {number} [options.limits.maxAttachmentBytes] - Attachment byte cap.
 * @param {number} [options.limits.maxDiagnosticItems] - Diagnostic count cap.
 * @param {number} [options.limits.maxDiagnosticMessageChars] - Message cap.
 * @param {(payload: {revision: number, attachmentIds: string[]}) => void} [options.onChange] - Change callback.
 * @param {() => string} [options.now] - Timestamp provider.
 * @returns {object} Frozen editor context API.
 */
function createEditorContext(options = {}) {
  const vscode = options.vscode;
  assertVscodeFacade(vscode);

  const limits = isRecord(options.limits) ? options.limits : {};
  const maxAttachmentBytes = limits.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
  const maxDiagnosticItems = limits.maxDiagnosticItems ?? DEFAULT_MAX_DIAGNOSTIC_ITEMS;
  const maxDiagnosticMessageChars = limits.maxDiagnosticMessageChars ?? DEFAULT_MAX_DIAGNOSTIC_MESSAGE_CHARS;
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};

  /** @type {Map<string, object>} */
  const attachments = new Map();
  let revision = 1;
  let attachmentCounter = 0;

  /**
   * @param {AbortSignal} [signal] - Request signal.
   * @returns {void}
   */
  function throwIfAborted(signal) {
    if (!signal || !signal.aborted) return;
    const reason = signal.reason;
    if (reason instanceof Error) throw reason;
    throw new EditorContextError('VSCODE_REQUEST_CANCELLED', 'VS Code bridge request cancelled');
  }

  /**
   * @returns {void}
   */
  function assertTrusted() {
    if (vscode.workspace.isTrusted === false) {
      throw new EditorContextError('VSCODE_WORKSPACE_UNTRUSTED', 'VS Code workspace is not trusted');
    }
  }

  /**
   * @param {object} uri - VS Code URI object.
   * @returns {void}
   */
  function assertUriInWorkspace(uri) {
    assertTrusted();
    const folders = vscode.workspace.workspaceFolders;
    if (!Array.isArray(folders) || folders.length === 0) {
      throw new EditorContextError('VSCODE_URI_OUTSIDE_WORKSPACE', 'URI is outside the workspace: no workspace folders are open');
    }
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder === undefined) {
      throw new EditorContextError('VSCODE_URI_OUTSIDE_WORKSPACE', `URI is outside the workspace: ${describeUri(uri)}`);
    }
  }

  /**
   * @param {object} uri - VS Code URI object.
   * @returns {string} Best-effort human readable URI.
   */
  function describeUri(uri) {
    return uri && typeof uri.toString === 'function' ? uri.toString() : String(uri);
  }

  /**
   * Parse a wire-supplied URI string and require the file scheme. Never
   * converts the URI to a local path for comparison.
   *
   * @param {string} value - URI string from the wire.
   * @returns {object} Parsed VS Code URI object.
   */
  function parseWireUri(value) {
    if (typeof value !== 'string') {
      throw invalidParams('URI must be a string');
    }
    let uri;
    try {
      uri = vscode.Uri.parse(value);
    } catch (error) {
      throw invalidParams(`Invalid URI: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!uri || typeof uri !== 'object' || uri.scheme !== 'file') {
      const scheme = uri && typeof uri === 'object' && uri.scheme ? uri.scheme : 'none';
      throw new EditorContextError('VSCODE_UNSUPPORTED_DOCUMENT', `Unsupported document URI scheme (expected file): ${scheme}`);
    }
    return uri;
  }

  /**
   * Validate a document URI taken from the active editor.
   *
   * @param {object} uri - VS Code URI object.
   * @returns {void}
   */
  function assertDocumentUriSafe(uri) {
    if (!uri || typeof uri !== 'object' || uri.scheme !== 'file') {
      throw new EditorContextError('VSCODE_UNSUPPORTED_DOCUMENT', 'Active editor document is not a file URI');
    }
    assertUriInWorkspace(uri);
  }

  /**
   * @param {object} document - VS Code TextDocument.
   * @param {string} uriString - URI string for the wire payload.
   * @returns {object} Document metadata for an attachment.
   */
  function documentMetadata(document, uriString) {
    const metadata = { uri: uriString };
    if (document.languageId !== undefined) metadata.languageId = document.languageId;
    if (document.version !== undefined) metadata.version = document.version;
    metadata.dirty = Boolean(document.isDirty);
    return metadata;
  }

  /**
   * @param {object} item - VS Code Diagnostic.
   * @param {string} uriString - URI string for the projected document.
   * @returns {object} Wire-projected diagnostic.
   */
  function projectDiagnosticItem(item, uriString) {
    const severityByValue = { 0: 'error', 1: 'warning', 2: 'information', 3: 'hint' };
    const severity = Object.prototype.hasOwnProperty.call(severityByValue, item.severity)
      ? severityByValue[item.severity]
      : 'information';
    let message = typeof item.message === 'string' ? item.message : String(item.message);
    // String#slice cuts on UTF-16 code units, so a surrogate pair may be
    // split at the boundary; this edge case is accepted here deliberately.
    if (message.length > maxDiagnosticMessageChars) {
      message = `${message.slice(0, maxDiagnosticMessageChars)}…`;
    }
    const projected = {
      document: { uri: uriString },
      range: {
        start: { line: item.range.start.line, character: item.range.start.character },
        end: { line: item.range.end.line, character: item.range.end.character },
      },
      severity,
      message,
    };
    if (item.source !== undefined) projected.source = item.source;
    if (typeof item.code === 'string' || typeof item.code === 'number') projected.code = item.code;
    return projected;
  }

  /**
   * @param {object[]} items - VS Code Diagnostic array.
   * @param {string} uriString - URI string for the projected document.
   * @returns {object[]} Wire-projected diagnostics, not yet capped.
   */
  function projectDiagnostics(items, uriString) {
    const projected = [];
    for (const item of items) projected.push(projectDiagnosticItem(item, uriString));
    return projected;
  }

  /**
   * @returns {string[]} Unique document URI strings from current attachments.
   */
  function uniqueAttachmentDocumentUris() {
    const seen = new Set();
    const uris = [];
    for (const attachment of attachments.values()) {
      const uri = attachment.document && attachment.document.uri;
      if (typeof uri !== 'string' || seen.has(uri)) continue;
      seen.add(uri);
      uris.push(uri);
    }
    return uris;
  }

  /**
   * @param {string} content - Attachment content.
   * @returns {void}
   */
  function assertAttachmentFits(content) {
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > maxAttachmentBytes) {
      throw new EditorContextError('VSCODE_ATTACHMENT_TOO_LARGE', `Editor attachment exceeds the ${maxAttachmentBytes} byte limit`);
    }
  }

  /**
   * @returns {string} Next monotonic attachment id.
   */
  function nextAttachmentId() {
    attachmentCounter += 1;
    return `ctx-${attachmentCounter}`;
  }

  /**
   * @param {object} attachment - Newly built attachment.
   * @returns {object} Deep-copied attachment.
   */
  function addAttachment(attachment) {
    attachments.set(attachment.id, attachment);
    revision += 1;
    onChange({ revision, attachmentIds: [...attachments.keys()] });
    return deepClone(attachment);
  }

  /**
   * @returns {object} Attachment for the active file.
   */
  function attachActiveFile() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !editor.document || !editor.document.uri) {
      throw new EditorContextError('VSCODE_NO_ACTIVE_EDITOR', 'No active text editor is available');
    }
    const document = editor.document;
    assertDocumentUriSafe(document.uri);
    const content = document.getText();
    assertAttachmentFits(content);
    return addAttachment({
      id: nextAttachmentId(),
      kind: 'active-file',
      document: documentMetadata(document, describeUri(document.uri)),
      content,
      createdAt: now(),
    });
  }

  /**
   * @returns {object} Attachment for the active selection.
   */
  function attachActiveSelection() {
    const editor = vscode.window.activeTextEditor;
    const selection = editor && editor.selection;
    if (!editor || !editor.document || !isRecord(selection) || !isRecord(selection.start) || !isRecord(selection.end)) {
      throw new EditorContextError('VSCODE_EMPTY_SELECTION', 'Active editor has no non-empty selection');
    }
    const start = selection.start;
    const end = selection.end;
    if (start.line === end.line && start.character === end.character) {
      throw new EditorContextError('VSCODE_EMPTY_SELECTION', 'Active editor has no non-empty selection');
    }
    const document = editor.document;
    assertDocumentUriSafe(document.uri);
    const content = document.getText(editor.selection);
    assertAttachmentFits(content);
    return addAttachment({
      id: nextAttachmentId(),
      kind: 'selection',
      document: documentMetadata(document, describeUri(document.uri)),
      range: {
        start: { line: start.line, character: start.character },
        end: { line: end.line, character: end.character },
      },
      content,
      createdAt: now(),
    });
  }

  /**
   * @returns {object} Attachment for diagnostics of the active file.
   */
  function attachProblems() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !editor.document || !editor.document.uri) {
      throw new EditorContextError('VSCODE_NO_ACTIVE_EDITOR', 'No active text editor is available');
    }
    const document = editor.document;
    assertDocumentUriSafe(document.uri);
    const uriString = describeUri(document.uri);
    const raw = vscode.languages.getDiagnostics(document.uri);
    const items = Array.isArray(raw) ? raw : [];
    const diagnostics = projectDiagnostics(items, uriString).slice(0, maxDiagnosticItems);
    const content = JSON.stringify(diagnostics);
    assertAttachmentFits(content);
    return addAttachment({
      id: nextAttachmentId(),
      kind: 'problems',
      document: documentMetadata(document, uriString),
      content,
      createdAt: now(),
    });
  }

  /**
   * Clear all attachments and bump the revision.
   *
   * @returns {void}
   */
  function clearAttachments() {
    attachments.clear();
    revision += 1;
    onChange({ revision, attachmentIds: [] });
  }

  /**
   * @returns {object[]} Deep copy of current attachments in insertion order.
   */
  function attachmentSnapshot() {
    return [...attachments.values()].map((attachment) => deepClone(attachment));
  }

  /**
   * Open one approved in-memory attachment in its owning VS Code editor.
   * @param {string} attachmentId - Current window attachment id.
   * @returns {Promise<{opened: boolean}>} Open result.
   */
  async function openAttachment(attachmentId) {
    if (typeof attachmentId !== 'string') throw invalidParams('attachmentId must be a string');
    const attachment = attachments.get(attachmentId);
    if (!attachment || !attachment.document || typeof attachment.document.uri !== 'string') {
      throw new EditorContextError('VSCODE_ATTACHMENT_NOT_FOUND', 'Editor attachment is no longer available');
    }
    return openHandler({ document: attachment.document, range: attachment.range, preserveFocus: false });
  }

  /**
   * @param {object} [params] - Request params.
   * @param {string[]} [params.attachmentIds] - Optional ids to filter by.
   * @param {{ signal?: AbortSignal }} [context] - Request context.
   * @returns {Promise<{ revision: number, attachments: object[] }>} Context result.
   */
  async function getContextHandler(params, { signal } = {}) {
    throwIfAborted(signal);
    assertTrusted();
    const body = isRecord(params) ? params : {};
    let requestedIds;
    if (body.attachmentIds === undefined) {
      requestedIds = [...attachments.keys()];
    } else {
      if (!Array.isArray(body.attachmentIds)) throw invalidParams('attachmentIds must be an array');
      requestedIds = body.attachmentIds;
    }
    const selected = [];
    for (const id of requestedIds) {
      const attachment = attachments.get(id);
      if (attachment) selected.push(deepClone(attachment));
    }
    throwIfAborted(signal);
    return { revision, attachments: selected };
  }

  /**
   * @param {object} [params] - Request params.
   * @param {{ signal?: AbortSignal }} [context] - Request context.
   * @returns {Promise<{ opened: boolean }>} Open result.
   */
  async function openHandler(params, { signal } = {}) {
    throwIfAborted(signal);
    const body = isRecord(params) ? params : {};
    if (!isRecord(body.document) || typeof body.document.uri !== 'string') {
      throw invalidParams('open requires document.uri as a string');
    }
    const selection = readSelection(body.range);
    const uri = parseWireUri(body.document.uri);
    assertUriInWorkspace(uri);
    throwIfAborted(signal);
    const document = await vscode.workspace.openTextDocument(uri);
    throwIfAborted(signal);
    const showOptions = { preview: false, preserveFocus: body.preserveFocus === true };
    if (selection) {
      showOptions.selection = new vscode.Range(selection.start.line, selection.start.character, selection.end.line, selection.end.character);
    }
    await vscode.window.showTextDocument(document, showOptions);
    throwIfAborted(signal);
    return { opened: true };
  }

  /**
   * Validate and normalize the optional open range.
   *
   * @param {object|undefined} range - Wire range.
   * @returns {object|null} Normalized range or null when absent.
   */
  function readSelection(range) {
    if (range === undefined) return null;
    if (!isRecord(range)) throw invalidParams('range must be an object');
    const start = range.start;
    const end = range.end;
    if (start === undefined && end === undefined) return null;
    if (start === undefined || end === undefined || !isRecord(start) || !isRecord(end)) {
      throw invalidParams('range requires both start and end');
    }
    for (const coordinate of [start.line, start.character, end.line, end.character]) {
      if (!Number.isInteger(coordinate) || coordinate < 0) {
        throw invalidParams('range coordinates must be non-negative integers');
      }
    }
    if (start.line > end.line || (start.line === end.line && start.character > end.character)) {
      throw invalidParams('range start must be before or equal to end');
    }
    return {
      start: { line: start.line, character: start.character },
      end: { line: end.line, character: end.character },
    };
  }

  /**
   * @param {object} [params] - Request params.
   * @param {{ signal?: AbortSignal }} [context] - Request context.
   * @returns {Promise<{ opened: boolean }>} OpenDiff result.
   */
  async function openDiffHandler(params, { signal } = {}) {
    throwIfAborted(signal);
    const body = isRecord(params) ? params : {};
    if (!isRecord(body.left) || typeof body.left.uri !== 'string' || !isRecord(body.right) || typeof body.right.uri !== 'string') {
      throw invalidParams('openDiff requires left.uri and right.uri as strings');
    }
    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || body.title.length === 0 || body.title.length > 200) {
        throw invalidParams('openDiff title must be a non-empty string of at most 200 characters');
      }
    }
    if (body.preserveFocus !== undefined && typeof body.preserveFocus !== 'boolean') {
      throw invalidParams('openDiff preserveFocus must be a boolean');
    }
    const leftUri = parseWireUri(body.left.uri);
    const rightUri = parseWireUri(body.right.uri);
    assertUriInWorkspace(leftUri);
    assertUriInWorkspace(rightUri);
    throwIfAborted(signal);
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, body.title === undefined ? undefined : body.title, {
      preview: false,
      preserveFocus: body.preserveFocus === true,
    });
    throwIfAborted(signal);
    return { opened: true };
  }

  /**
   * @param {object} [params] - Request params.
   * @param {string[]} [params.uris] - Optional explicit URI list.
   * @param {{ signal?: AbortSignal }} [context] - Request context.
   * @returns {Promise<{ diagnostics: object[] }>} Diagnostics result.
   */
  async function getDiagnosticsHandler(params, { signal } = {}) {
    throwIfAborted(signal);
    const body = isRecord(params) ? params : {};
    let uriStrings;
    if (body.uris === undefined) {
      uriStrings = uniqueAttachmentDocumentUris();
    } else {
      if (!Array.isArray(body.uris)) throw invalidParams('uris must be an array');
      for (const value of body.uris) {
        if (typeof value !== 'string') throw invalidParams('uris must contain only strings');
      }
      uriStrings = body.uris;
    }
    const all = [];
    for (const uriString of uriStrings) {
      throwIfAborted(signal);
      const uri = parseWireUri(uriString);
      assertUriInWorkspace(uri);
      throwIfAborted(signal);
      const raw = await vscode.languages.getDiagnostics(uri);
      throwIfAborted(signal);
      const items = Array.isArray(raw) ? raw : [];
      for (const item of items) all.push(projectDiagnosticItem(item, uriString));
    }
    throwIfAborted(signal);
    return { diagnostics: all.slice(0, maxDiagnosticItems) };
  }

  const handlers = Object.freeze({
    'vscode/editor/getContext': getContextHandler,
    'vscode/editor/open': openHandler,
    'vscode/editor/openDiff': openDiffHandler,
    'vscode/workspace/getDiagnostics': getDiagnosticsHandler,
  });

  const api = {
    get revision() {
      return revision;
    },
    handlers,
    attachActiveFile,
    attachActiveSelection,
    attachProblems,
    clearAttachments,
    attachmentSnapshot,
    openAttachment,
  };
  return Object.freeze(api);
}

module.exports = {
  ATTACHMENT_KINDS,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  DEFAULT_MAX_DIAGNOSTIC_ITEMS,
  DEFAULT_MAX_DIAGNOSTIC_MESSAGE_CHARS,
  EditorContextError,
  createEditorContext,
};
