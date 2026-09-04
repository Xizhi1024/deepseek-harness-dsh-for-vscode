'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * R14S1 change journal: persists bridge WorkspaceEdits as pending entries
 * in `context.globalStorageUri/changes/journal.json`, snapshots the affected
 * document text before each push, and supports Accept (the only disk-writing
 * path) plus Undo via a checkpoint seam with a snapshot whole-file restore
 * fallback.
 *
 * The module deliberately has no VS Code UI dependencies: it is created in L0
 * with no side effects and the TreeView/commands layer (L2) reads the same
 * journal. When no storageUri is supplied it degrades to a memory-only
 * journal so the v3 handler can always be mounted safely.
 */

const MAX_EDITS = 50;
const MAX_EDIT_TEXT_BYTES = 1 * 1024 * 1024;
const MAX_LABEL_CHARS = 200;
const EDIT_KINDS = Object.freeze(['insert', 'replace', 'delete', 'create']);
// Journal v2: which pipeline recorded the entry. Bridge pushes were the only
// source in 1.0.x, so legacy entries without `source` migrate to 'bridge'.
const ENTRY_SOURCES = Object.freeze(['bridge', 'tool-intercept', 'external']);
// C1 contract: duplicate dshEditObserved notifications for the same
// (path, sessionId) pair within this window merge into one entry.
const TOOL_EDIT_MERGE_WINDOW_MS = 2000;

function entryAtMs(entry) {
  const ms = Date.parse(entry && entry.at);
  return Number.isFinite(ms) ? ms : 0;
}

function normalizeEntry(entry) {
  if (isRecord(entry) && entry.source === undefined) {
    return { ...entry, source: 'bridge' };
  }
  return entry;
}

class ChangeTrackerError extends Error {
  constructor(bridgeCode, message) {
    super(message);
    this.name = 'ChangeTrackerError';
    this.bridgeCode = bridgeCode;
  }
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function invalidParams(message) {
  return new ChangeTrackerError('VSCODE_INVALID_PARAMS', message);
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function assertPosition(value, field) {
  if (!isRecord(value) || !isNonNegativeInteger(value.line) || !isNonNegativeInteger(value.character)) {
    throw invalidParams(`${field} must be a {line, character} position`);
  }
  return { line: value.line, character: value.character };
}

function assertRange(value) {
  if (!isRecord(value)) throw invalidParams('range must be an object');
  const start = assertPosition(value.start, 'range.start');
  const end = assertPosition(value.end, 'range.end');
  if (start.line > end.line || (start.line === end.line && start.character > end.character)) {
    throw invalidParams('range start must be before or equal to end');
  }
  return { start, end };
}

function assertText(value, field) {
  if (typeof value !== 'string') throw invalidParams(`${field} must be a string`);
  if (Buffer.byteLength(value, 'utf8') > MAX_EDIT_TEXT_BYTES) {
    throw new ChangeTrackerError('VSCODE_EDIT_TOO_LARGE', `${field} exceeds the ${MAX_EDIT_TEXT_BYTES} byte limit`);
  }
  return value;
}

function describeUri(uri) {
  return uri && typeof uri.toString === 'function' ? uri.toString() : String(uri);
}

/**
 * Parse and validate wire-supplied workspace edits (WorkspaceEdit safe subset).
 * Every edit uri must be a file URI. F-d: paths outside the open workspace
 * folders are ALLOWED — which paths are writable is single-sourced from the
 * DSH sandbox that owns the calling agent, not from this extension.
 *
 * @param {Array<object>} edits - Raw wire edits.
 * @param {object} vscode - VS Code facade ({ Uri }).
 * @returns {Array<object>} Normalized edits with parsed uri objects.
 */
function validateWireEdits(edits, vscode) {
  if (!Array.isArray(edits) || edits.length === 0 || edits.length > MAX_EDITS) {
    throw invalidParams(`edits must contain 1-${MAX_EDITS} entries`);
  }
  if (!vscode || !vscode.Uri || typeof vscode.Uri.parse !== 'function') {
    throw new TypeError('validateWireEdits requires vscode.Uri.parse');
  }
  const normalized = [];
  for (let index = 0; index < edits.length; index += 1) {
    const edit = edits[index];
    if (!isRecord(edit)) throw invalidParams(`edits[${index}] must be an object`);
    const kind = edit.kind;
    if (typeof kind !== 'string' || !EDIT_KINDS.includes(kind)) {
      throw invalidParams(`edits[${index}].kind must be one of ${EDIT_KINDS.join(', ')}`);
    }
    let uri;
    try {
      uri = vscode.Uri.parse(edit.uri);
    } catch (error) {
      throw invalidParams(`edits[${index}].uri is invalid: ${error && error.message ? error.message : error}`);
    }
    if (!uri || uri.scheme !== 'file') {
      throw new ChangeTrackerError('VSCODE_UNSUPPORTED_DOCUMENT', 'changes/push edits must use file:// URIs');
    }
    const normalizedEdit = { kind, uri };
    if (kind === 'insert') {
      normalizedEdit.at = assertPosition(edit.at, `edits[${index}].at`);
      normalizedEdit.text = assertText(edit.text, `edits[${index}].text`);
    } else if (kind === 'replace') {
      normalizedEdit.range = assertRange(edit.range);
      normalizedEdit.text = assertText(edit.text, `edits[${index}].text`);
    } else if (kind === 'delete') {
      normalizedEdit.range = assertRange(edit.range);
    } else if (kind === 'create') {
      normalizedEdit.text = assertText(edit.text, `edits[${index}].text`);
    }
    normalized.push(normalizedEdit);
  }
  return normalized;
}

/**
 * F-b: verify every position-bearing edit actually lands inside its target
 * document. Out-of-range coordinates (beyond EOF / line length) pass the
 * structural checks above, enter the journal as pending, and only fail later
 * when Accept builds the WorkspaceEdit — leaving zombie entries that can wedge
 * the changes tree. Positions are compared against the document's own
 * validatePosition clamping: a clamped result that differs from the input
 * means the coordinate does not exist in the document.
 *
 * @param {Array<object>} edits - Normalized edits from validateWireEdits.
 * @param {object} vscode - VS Code facade ({ Uri, workspace, Position }).
 * @returns {Promise<void>} Rejects with ChangeTrackerError on violation.
 */
async function assertEditsWithinDocuments(edits, vscode) {
  if (!Array.isArray(edits) || edits.length === 0) return;
  if (!vscode || !vscode.workspace || typeof vscode.workspace.openTextDocument !== 'function'
    || typeof vscode.Position !== 'function') {
    return; // facade without document access: structural checks only (tests)
  }
  const documents = new Map();
  for (const edit of edits) {
    if (edit.kind === 'create') continue; // targets a new file by design
    const uriString = String(edit.uri);
    let document = documents.get(uriString);
    if (document === undefined) {
      try {
        document = await vscode.workspace.openTextDocument(edit.uri);
      } catch {
        // Best-effort hardening: hosts/facades that cannot open the document
        // (test fakes, untitled schemes) skip the range check — VS Code still
        // rejects the WorkspaceEdit at Accept time, which now surfaces a
        // visible error and keeps the entry pending.
        documents.set(uriString, null);
        continue;
      }
      documents.set(uriString, document);
    }
    if (!document || typeof document.validatePosition !== 'function') continue;
    const check = (position, label) => {
      const candidate = new vscode.Position(position.line, position.character);
      const clamped = document.validatePosition(candidate);
      if (clamped.line !== candidate.line || clamped.character !== candidate.character) {
        throw new ChangeTrackerError(
          'VSCODE_EDIT_OUT_OF_RANGE',
          `edits.${label} ({${position.line},${position.character}}) is outside the document (it ends at {${document.lineCount - 1}, ${document.lineAt(document.lineCount - 1).text.length}})`,
        );
      }
    };
    if (edit.kind === 'insert') check(edit.at, 'at');
    else {
      check(edit.range.start, 'range.start');
      check(edit.range.end, 'range.end');
    }
  }
}

/**
 * Compute the end position after inserting `text` at `at`.
 *
 * @param {string} text - Inserted text.
 * @param {{line:number, character:number}} at - Insert position.
 * @returns {{line:number, character:number}} End position.
 */
function positionAfterText(text, at) {
  let line = at.line;
  let character = at.character;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 10) {
      line += 1;
      character = 0;
    } else if (code !== 13) {
      character += 1;
    }
  }
  return { line, character };
}

function positionToRange(start, end, vscode) {
  return new vscode.Range(start.line, start.character, end.line, end.character);
}

/**
 * Build a VS Code WorkspaceEdit from normalized safe edits.
 *
 * @param {Array<object>} edits - Normalized edits from validateWireEdits.
 * @param {object} vscode - VS Code facade with WorkspaceEdit/Position/Range/Uri.
 * @returns {object} A new WorkspaceEdit instance.
 */
function buildWorkspaceEdit(edits, vscode) {
  if (!vscode || typeof vscode.WorkspaceEdit !== 'function') {
    throw new TypeError('buildWorkspaceEdit requires vscode.WorkspaceEdit');
  }
  const workspaceEdit = new vscode.WorkspaceEdit();
  for (const edit of edits) {
    if (edit.kind === 'insert') {
      workspaceEdit.insert(
        edit.uri,
        new vscode.Position(edit.at.line, edit.at.character),
        edit.text,
      );
    } else if (edit.kind === 'replace') {
      workspaceEdit.replace(
        edit.uri,
        positionToRange(edit.range.start, edit.range.end, vscode),
        edit.text,
      );
    } else if (edit.kind === 'delete') {
      workspaceEdit.delete(
        edit.uri,
        positionToRange(edit.range.start, edit.range.end, vscode),
      );
    } else if (edit.kind === 'create') {
      workspaceEdit.createFile(edit.uri, { overwrite: false, ignoreIfExists: true });
      workspaceEdit.insert(
        edit.uri,
        new vscode.Position(0, 0),
        edit.text,
      );
    }
  }
  return workspaceEdit;
}

/**
 * B1: build a snapshot whole-file restore WorkspaceEdit for an accepted
 * journal entry. For every `before` snapshot the CURRENT document text is
 * read and a single full-document-range replace puts the exact pre-change
 * bytes back — unlike the retired incremental inverse this cannot be rejected
 * for overlapping ranges after multiple edits shifted line numbers. A `null`
 * snapshot (the file did not exist before, e.g. the target of a `create`
 * edit) is reversed as a deleteFile.
 *
 * @param {object} entry - Journal entry with edits and before snapshots.
 * @param {object} vscode - VS Code facade.
 * @returns {Promise<object>} A new WorkspaceEdit that restores the entry.
 */
async function buildSnapshotRestoreEdit(entry, vscode) {
  if (!isRecord(entry) || !Array.isArray(entry.edits)) {
    throw new ChangeTrackerError('VSCODE_INVALID_CHANGE', 'Change entry is missing its edits');
  }
  if (!vscode || typeof vscode.WorkspaceEdit !== 'function') {
    throw new TypeError('buildSnapshotRestoreEdit requires vscode.WorkspaceEdit');
  }
  const beforeByUri = new Map();
  for (const snapshot of Array.isArray(entry.before) ? entry.before : []) {
    if (snapshot && typeof snapshot.uri === 'string') beforeByUri.set(snapshot.uri, snapshot);
  }
  const createUriStrings = new Set(
    entry.edits
      .filter((edit) => edit && edit.kind === 'create')
      .map((edit) => (typeof edit.uri === 'string' ? edit.uri : String(edit.uri))),
  );
  const workspaceEdit = new vscode.WorkspaceEdit();
  for (const [uriString, snapshot] of beforeByUri) {
    const uri = vscode.Uri.parse(uriString);
    if (typeof snapshot.text !== 'string') {
      if (createUriStrings.has(uriString)) {
        workspaceEdit.deleteFile(uri, { recursive: false, ignoreIfNotExists: true });
      }
      continue;
    }
    let current = '';
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      current = typeof document.getText === 'function' ? document.getText() : '';
    } catch {
      current = '';
    }
    const end = positionAfterText(current, { line: 0, character: 0 });
    workspaceEdit.replace(uri, positionToRange({ line: 0, character: 0 }, end, vscode), snapshot.text);
  }
  return workspaceEdit;
}

/**
 * @param {object} [options] - Options for createChangeTracker.
 * @param {{fsPath:string}} [options.storageUri] - context.globalStorageUri.
 * @param {object} options.vscode - VS Code facade.
 * @param {Function} [options.now] - Timestamp provider.
 * @param {{readFileSync?, writeFileSync?, renameSync?, mkdirSync?}} [options.fsOps]
 *   - Injectable file operations for tests.
 * @returns {object} Frozen change tracker API.
 */
function createChangeTracker({
  storageUri = null,
  vscode = null,
  now = () => new Date().toISOString(),
  fsOps = {},
} = {}) {
  if (!vscode || !vscode.workspace) {
    throw new TypeError('createChangeTracker requires vscode.workspace');
  }
  // Workspace edit APIs (applyEdit / openTextDocument / getWorkspaceFolder)
  // are validated lazily where they are used: constructing the tracker (an
  // L0-path support) must not fail a host facade that omits them — journal
  // recording still works and edit operations degrade with explicit bridge
  // errors instead of killing the sidebar (plan §1 lifeline).
  const {
    readFileSync = fs.readFileSync,
    writeFileSync = fs.writeFileSync,
    renameSync = fs.renameSync,
    mkdirSync = fs.mkdirSync,
  } = fsOps;
  let memoryOnly = false;
  let journalPath = null;
  if (storageUri && typeof storageUri.fsPath === 'string' && storageUri.fsPath.length > 0) {
    journalPath = path.join(storageUri.fsPath, 'changes', 'journal.json');
  } else {
    memoryOnly = true;
  }
  /** @type {Array<object>} */
  const memoryJournal = memoryOnly ? [] : null;
  let idCounter = 0;

  function readJournal() {
    if (memoryOnly) return memoryJournal.map(normalizeEntry);
    try {
      const parsed = JSON.parse(readFileSync(journalPath, 'utf8'));
      return Array.isArray(parsed) ? parsed.map(normalizeEntry) : [];
    } catch {
      return [];
    }
  }

  function writeJournal(entries) {
    if (memoryOnly) {
      memoryJournal.splice(0, memoryJournal.length, ...entries);
      return;
    }
    mkdirSync(path.dirname(journalPath), { recursive: true });
    const temporary = `${journalPath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(entries, null, 2), { mode: 0o600 });
    renameSync(temporary, journalPath);
  }

  /**
   * F-a: the id watermark is derived from the PERSISTED journal on every
   * allocation. A bare in-memory counter restarts at chg-1 after every
   * extension restart and collides with historical entries, which misroutes
   * Accept/Undo/openDiff (they find() the first matching id). Scanning the
   * journal keeps new ids unique across restarts and legacy data alike.
   */
  function nextId() {
    let max = idCounter;
    for (const entry of readJournal()) {
      const match = /^chg-(\d+)$/.exec(typeof entry.id === 'string' ? entry.id : '');
      if (match) max = Math.max(max, Number(match[1]));
    }
    idCounter = max + 1;
    return `chg-${idCounter}`;
  }

  /**
   * Snapshot the current text of every distinct document referenced by the
   * edits. Missing documents (e.g. the target of a create) get `text: null`.
   *
   * @param {Array<object>} edits - Normalized edits.
   * @returns {Promise<Array<{uri:string, text:string|null}>>} Before snapshots.
   */
  async function snapshotBefore(edits) {
    const seen = new Map();
    for (const edit of edits) {
      const uriString = String(edit.uri);
      if (seen.has(uriString)) continue;
      seen.set(uriString, null);
    }
    for (const uriString of seen.keys()) {
      try {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uriString));
        seen.set(uriString, typeof document.getText === 'function' ? document.getText() : null);
      } catch {
        seen.set(uriString, null);
      }
    }
    return [...seen.entries()].map(([uri, text]) => ({ uri, text }));
  }

  /**
   * Apply normalized edits and return true when VS Code accepted them.
   *
   * @param {Array<object>} edits - Normalized edits.
   * @returns {Promise<{applied: boolean}>} Apply result.
   */
  async function applyEdits(edits) {
    if (typeof vscode.workspace.applyEdit !== 'function') {
      throw new ChangeTrackerError('VSCODE_EDIT_UNAVAILABLE', 'This VS Code facade cannot apply workspace edits');
    }
    const workspaceEdit = buildWorkspaceEdit(edits, vscode);
    const applied = await vscode.workspace.applyEdit(workspaceEdit);
    if (!applied) {
      throw new ChangeTrackerError('VSCODE_EDIT_REJECTED', 'VS Code declined the workspace edit');
    }
    return { applied: true };
  }

  /**
   * B1: re-parse stored journal edits (uri serialized as string) back into
   * Uri objects so buildWorkspaceEdit can replay them through applyEdit.
   */
  function reviveStoredEdits(storedEdits) {
    if (!Array.isArray(storedEdits)) return [];
    return storedEdits.map((edit) => (
      edit && typeof edit.uri === 'string' ? { ...edit, uri: vscode.Uri.parse(edit.uri) } : edit
    ));
  }

  /**
   * B1: Accept one pending change - the ONLY path that writes the edits to
   * disk. Legacy journal entries (status 'applied', written by 1.0.x) are
   * already on disk: accept is a bookkeeping no-op that moves them to
   * 'accepted'. On failure the entry stays 'pending'.
   *
   * @param {string} changeId - Entry id.
   * @returns {Promise<object>} Accept result.
   */
  async function accept(changeId) {
    const entry = get(changeId);
    if (!entry) {
      throw new ChangeTrackerError('VSCODE_CHANGE_NOT_FOUND', 'Unknown change id: ' + changeId);
    }
    if (entry.status === 'accepted') {
      return { accepted: true, changeId, alreadyAccepted: true };
    }
    if (entry.status === 'applied') {
      updateStatus(changeId, 'accepted');
      return { accepted: true, changeId, noOp: true };
    }
    if (entry.status === 'undone' || entry.status === 'discarded') {
      throw new ChangeTrackerError('VSCODE_INVALID_CHANGE', 'Change ' + changeId + ' is ' + entry.status + ' and cannot be accepted');
    }
    await applyEdits(reviveStoredEdits(entry.edits));
    updateStatus(changeId, 'accepted');
    return { accepted: true, changeId };
  }

  /**
   * Record one change batch in the journal (B1: default status 'pending' -
   * pushes no longer write to disk until Accept).
   *
   * @param {object} options - Entry payload.
   * @param {string} [options.sessionId] - DSH session id for grouping.
   * @param {string} [options.label] - Display label.
   * @param {Array<object>} options.edits - Normalized edits.
   * @param {Array<object>} options.before - Before snapshots.
   * @param {string} [options.status] - Entry status (B1 default 'pending';
   *   'applied' only survives for legacy journal entries).
   * @param {string} [options.source] - Journal v2 attribution: 'bridge' |
   *   'tool-intercept' | 'external' (default 'bridge', 1.0.x compatible).
   * @param {string} [options.path] - Journal v2: absolute filesystem path of
   *   the touched file (attribution-only entries: tool-intercept/external).
   * @param {string} [options.tool] - Journal v2: the DSH tool name for
   *   tool-intercept entries ('edit' | 'write').
   * @returns {Promise<object>} The persisted entry.
   */
  async function record({
    sessionId = '',
    label = '',
    edits = [],
    before = [],
    status = 'pending',
    source = 'bridge',
    path = '',
    tool = '',
  }) {
    const entry = {
      id: nextId(),
      source,
      sessionId,
      label,
      at: now(),
      status,
      edits,
      before,
    };
    if (typeof path === 'string' && path.length > 0) entry.path = path;
    if (typeof tool === 'string' && tool.length > 0) entry.tool = tool;
    const entries = readJournal();
    entries.push(entry);
    writeJournal(entries);
    return entry;
  }

  /**
   * C1: consume one `vscode/dshEditObserved` notification emitted by the
   * plugin-side tool interceptor (C2). These entries describe writes the DSH
   * tool ALREADY performed directly on disk (F-d: no pre-approval) — the
   * extension tracks them for attribution/audit only, so edits/before stay
   * empty, status is 'accepted', and openDiff/undo degrade to disk-vs-git.
   * Notifications are at-least-once: a duplicate (path, sessionId) pair
   * inside ±2s merges into the existing entry instead of creating a new one.
   *
   * @param {object} payload - {tool:'edit'|'write', path, sessionId, size, truncated}.
   * @returns {Promise<object>} The persisted entry (or the existing one with
   *   `merged: true` when the notification was a duplicate).
   */
  async function recordToolEdit(payload) {
    if (!isRecord(payload)) throw invalidParams('dshEditObserved payload must be an object');
    const { tool } = payload;
    const filePath = payload.path;
    if (tool !== 'edit' && tool !== 'write') {
      throw invalidParams('dshEditObserved.tool must be "edit" or "write"');
    }
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw invalidParams('dshEditObserved.path must be a non-empty string');
    }
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    const size = Number.isFinite(payload.size) ? payload.size : 0;
    const truncated = Boolean(payload.truncated);
    const atMs = entryAtMs({ at: now() });
    const entries = readJournal();
    const duplicate = entries.find((candidate) => (
      candidate.source === 'tool-intercept'
      && candidate.path === filePath
      && (candidate.sessionId || '') === sessionId
      && Math.abs(entryAtMs(candidate) - atMs) <= TOOL_EDIT_MERGE_WINDOW_MS
    ));
    if (duplicate) return { ...duplicate, merged: true };
    const entry = {
      id: nextId(),
      source: 'tool-intercept',
      sessionId,
      tool,
      path: filePath,
      label: `${tool} ${path.basename(filePath)}`,
      at: now(),
      status: 'accepted',
      edits: [],
      before: [],
      size,
      truncated,
    };
    entries.push(entry);
    writeJournal(entries);
    return entry;
  }

  /**
   * Journal v2: merge a patch into one stored entry (used by the watcher to
   * attach beforeSnapshotPath after the entry id is allocated).
   *
   * @param {string} changeId - Entry id.
   * @param {object} patch - Fields to merge.
   * @returns {object|null} Updated entry or null when not found.
   */
  function updateEntry(changeId, patch) {
    if (!isRecord(patch)) throw invalidParams('updateEntry patch must be an object');
    const entries = readJournal();
    const entry = entries.find((candidate) => candidate.id === changeId);
    if (!entry) return null;
    Object.assign(entry, patch);
    writeJournal(entries);
    return entry;
  }

  /**
   * @returns {Array<object>} Current journal entries (deep copy).
   */
  function list() {
    return readJournal().map((entry) => JSON.parse(JSON.stringify(entry)));
  }

  /**
   * @param {string} changeId - Entry id.
   * @returns {object|null} The journal entry or null.
   */
  function get(changeId) {
    return readJournal().find((entry) => entry.id === changeId) || null;
  }

  /**
   * @param {string} changeId - Entry id.
   * @param {string} status - New status.
   * @returns {object|null} Updated entry or null when not found.
   */
  function updateStatus(changeId, status) {
    const entries = readJournal();
    const entry = entries.find((candidate) => candidate.id === changeId);
    if (!entry) return null;
    entry.status = status;
    writeJournal(entries);
    return entry;
  }

  /**
   * B1: Undo one change. Pending entries were never written to disk, so
   * undo discards them outright ('discarded', zero on-disk effect).
   * Accepted entries (and legacy 'applied' ones) are restored: the
   * checkpoint rollback seam wins when supplied, otherwise a snapshot
   * whole-file replacement WorkspaceEdit (buildSnapshotRestoreEdit).
   *
   * @param {string} changeId - Entry id.
   * @param {object} [options] - Undo options.
   * @param {Function} [options.checkpointRollback] - (changeId, sessionId) => Promise<object|null>.
   * @returns {Promise<object>} Undo result.
   */
  async function undo(changeId, { checkpointRollback = null } = {}) {
    const entry = get(changeId);
    if (!entry) {
      throw new ChangeTrackerError('VSCODE_CHANGE_NOT_FOUND', 'Unknown change id: ' + changeId);
    }
    if (entry.status === 'undone' || entry.status === 'discarded') {
      return { undone: false, reason: 'already-undone', changeId };
    }
    if (entry.status === 'pending') {
      updateStatus(changeId, 'discarded');
      return { undone: true, method: 'discard', changeId };
    }
    if (typeof checkpointRollback === 'function') {
      const checkpointResult = await checkpointRollback(changeId, entry.sessionId || '');
      if (checkpointResult && checkpointResult !== true) {
        updateStatus(changeId, 'undone');
        return { undone: true, method: 'checkpoint', changeId, ...checkpointResult };
      }
    }
    if (typeof vscode.workspace.applyEdit !== 'function') {
      throw new ChangeTrackerError('VSCODE_EDIT_UNAVAILABLE', 'This VS Code facade cannot apply workspace edits');
    }
    const restore = await buildSnapshotRestoreEdit(entry, vscode);
    const applied = await vscode.workspace.applyEdit(restore);
    if (!applied) {
      throw new ChangeTrackerError('VSCODE_EDIT_REJECTED', 'VS Code declined the undo workspace edit');
    }
    updateStatus(changeId, 'undone');
    return { undone: true, method: 'snapshot-restore', changeId };
  }

  return Object.freeze({
    accept,
    applyEdits,
    buildSnapshotRestoreEdit,
    buildWorkspaceEdit,
    get,
    list,
    record,
    recordToolEdit,
    snapshotBefore,
    updateEntry,
    undo,
    updateStatus,
    validateWireEdits,
  });
}

/**
 * DSH-side tool arguments carry session-cwd-RELATIVE paths (the agent passes
 * whatever shape it likes), while the journal, the watcher dedup, openDiff
 * and undo all key on ABSOLUTE host paths (live incident 2026-09-04: the
 * same agent edit was journaled twice — tool-intercept with a relative path,
 * then external with the absolute one — because the dedup compared shapes
 * that could never match). Resolve a relative tool path against the given
 * workspace roots, preferring a root where the file actually exists.
 * Pure/injectable: no vscode, fs.existsSync seamable.
 *
 * @param {object} payload - dshEditObserved payload ({tool, path, sessionId,...}).
 * @param {string[]} roots - Absolute workspace-root candidates (bound cwd first).
 * @param {Function} [existsSyncFn] - fs.existsSync seam for tests.
 * @returns {object} payload with an absolute path when resolvable, else unchanged.
 */
function normalizeToolEditPath(payload, roots, existsSyncFn = fs.existsSync) {
  if (!payload || typeof payload.path !== 'string' || payload.path.length === 0) return payload;
  if (path.isAbsolute(payload.path) || payload.path.startsWith('file:')) return payload;
  const candidates = Array.isArray(roots) ? roots.filter((root) => (
    typeof root === 'string' && root.length > 0 && path.isAbsolute(root)
  )) : [];
  if (candidates.length === 0) return payload;
  for (const root of candidates) {
    try {
      if (existsSyncFn(path.resolve(root, payload.path))) {
        return { ...payload, path: path.resolve(root, payload.path) };
      }
    } catch {
      // existence probing is best-effort; try the next root
    }
  }
  return { ...payload, path: path.resolve(candidates[0], payload.path) };
}

module.exports = {
  ChangeTrackerError,
  normalizeToolEditPath,
  EDIT_KINDS,
  ENTRY_SOURCES,
  MAX_EDITS,
  assertEditsWithinDocuments,
  entryAtMs,
  MAX_EDIT_TEXT_BYTES,
  MAX_LABEL_CHARS,
  buildSnapshotRestoreEdit,
  buildWorkspaceEdit,
  createChangeTracker,
  positionAfterText,
  validateWireEdits,
};
