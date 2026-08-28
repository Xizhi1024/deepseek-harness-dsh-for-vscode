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
 * Every edit uri must be a file URI inside an open workspace folder.
 *
 * @param {Array<object>} edits - Raw wire edits.
 * @param {object} vscode - VS Code facade ({ Uri, workspace }).
 * @returns {Array<object>} Normalized edits with parsed uri objects.
 */
function validateWireEdits(edits, vscode) {
  if (!Array.isArray(edits) || edits.length === 0 || edits.length > MAX_EDITS) {
    throw invalidParams(`edits must contain 1-${MAX_EDITS} entries`);
  }
  if (!vscode || !vscode.Uri || typeof vscode.Uri.parse !== 'function') {
    throw new TypeError('validateWireEdits requires vscode.Uri.parse');
  }
  if (!vscode.workspace || typeof vscode.workspace.getWorkspaceFolder !== 'function') {
    throw new TypeError('validateWireEdits requires vscode.workspace.getWorkspaceFolder');
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
    let folder = null;
    try {
      folder = vscode.workspace.getWorkspaceFolder(uri);
    } catch {
      folder = undefined;
    }
    if (folder === undefined) {
      throw new ChangeTrackerError('VSCODE_URI_OUTSIDE_WORKSPACE', `Edit URI is outside the workspace: ${describeUri(uri)}`);
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
    if (memoryOnly) return memoryJournal.slice();
    try {
      const parsed = JSON.parse(readFileSync(journalPath, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
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

  function nextId() {
    idCounter += 1;
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
   * @returns {Promise<object>} The persisted entry.
   */
  async function record({ sessionId = '', label = '', edits = [], before = [], status = 'pending' }) {
    const entry = {
      id: nextId(),
      sessionId,
      label,
      at: now(),
      status,
      edits,
      before,
    };
    const entries = readJournal();
    entries.push(entry);
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
    snapshotBefore,
    undo,
    updateStatus,
    validateWireEdits,
  });
}

module.exports = {
  ChangeTrackerError,
  EDIT_KINDS,
  MAX_EDITS,
  MAX_EDIT_TEXT_BYTES,
  MAX_LABEL_CHARS,
  buildSnapshotRestoreEdit,
  buildWorkspaceEdit,
  createChangeTracker,
  positionAfterText,
  validateWireEdits,
};
