'use strict';

const fs = require('node:fs');
const path = require('node:path');

// F-c proposal preview: pending entries diff the before snapshot against an
// in-memory application of the proposed edits (read-only), instead of the
// unchanged on-disk file that produced a permanently blank diff.
const PREVIEW_SCHEME = 'dsh-change-preview';
// Mirrors src/changeTracker.js limits; anything beyond them falls back to the
// audited snapshot-vs-disk diff.
const MAX_PREVIEW_EDITS = 50;
const MAX_PREVIEW_DOC_BYTES = 2 * 1024 * 1024;
const MAX_PREVIEW_EDIT_TEXT_BYTES = 1 * 1024 * 1024;

/**
 * Apply normalized wire edits (insert/replace/delete; `create` is handled by
 * the caller) to a before-snapshot text in memory. All edit positions are
 * interpreted in pre-batch document coordinates - the same semantics VS Code
 * gives a single atomic WorkspaceEdit - and applied back-to-front.
 *
 * @param {string} text - Before-snapshot document text.
 * @param {Array<object>} edits - Stored journal edits for one uri.
 * @returns {string|null} Preview text, or null when an edit is malformed.
 */
function applyEditsToText(text, edits) {
  const lines = text.split('\n');
  const lineStarts = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  const total = text.length;

  // Map a VS Code {line, character} position onto a raw string index. VS Code
  // character counts exclude \r, so CR characters are skipped while advancing.
  function rawIndex(position) {
    if (!position || !Number.isInteger(position.line) || !Number.isInteger(position.character)) {
      return null;
    }
    const lineIndex = Math.min(Math.max(position.line, 0), lines.length - 1);
    const line = lines[lineIndex];
    let raw = lineStarts[lineIndex];
    let seen = 0;
    let i = 0;
    while (i < line.length && seen < position.character) {
      if (line.charCodeAt(i) !== 13) seen += 1;
      raw += 1;
      i += 1;
    }
    return Math.min(raw, total);
  }

  const splices = [];
  for (const edit of edits) {
    if (!edit || typeof edit.kind !== 'string') return null;
    if (edit.kind === 'create') continue; // create targets carry no before text
    if (edit.kind === 'insert') {
      const at = rawIndex(edit.at);
      if (at === null) return null;
      splices.push({ start: at, end: at, text: typeof edit.text === 'string' ? edit.text : '' });
    } else if (edit.kind === 'replace' || edit.kind === 'delete') {
      const start = rawIndex(edit.range && edit.range.start);
      const end = rawIndex(edit.range && edit.range.end);
      if (start === null || end === null) return null;
      splices.push({
        start,
        end: Math.max(start, end),
        text: edit.kind === 'delete' ? '' : (typeof edit.text === 'string' ? edit.text : ''),
      });
    } else {
      return null;
    }
  }
  splices.sort((a, b) => (b.start - a.start) || (b.end - a.end));
  let result = text;
  for (const splice of splices) {
    result = result.slice(0, splice.start) + splice.text + result.slice(splice.end);
  }
  return result;
}

function basenameFromUri(uriString) {
  const withoutFragment = String(uriString).split('?')[0].split('#')[0];
  const parts = withoutFragment.split('/');
  const base = parts[parts.length - 1] || 'preview';
  const safe = base.replace(/[^A-Za-z0-9._-]/g, '_');
  return safe.length > 0 ? safe : 'preview';
}

/**
 * Build the in-memory after-text for a pending entry's first edited uri.
 * Returns null (caller falls back to the audited snapshot-vs-disk diff) for
 * oversized documents/edits, empty edit lists, or malformed payloads.
 *
 * @param {object} entry - Journal entry (pending).
 * @returns {object|null} {beforeText, text, fileName} preview descriptor.
 */
function buildPendingPreview(entry) {
  const edits = Array.isArray(entry.edits) ? entry.edits : [];
  if (edits.length === 0 || edits.length > MAX_PREVIEW_EDITS) return null;
  for (const edit of edits) {
    if (
      edit && typeof edit.text === 'string'
      && Buffer.byteLength(edit.text, 'utf8') > MAX_PREVIEW_EDIT_TEXT_BYTES
    ) {
      return null;
    }
  }
  const beforeByUri = new Map();
  for (const snapshot of Array.isArray(entry.before) ? entry.before : []) {
    if (snapshot && typeof snapshot.uri === 'string') beforeByUri.set(snapshot.uri, snapshot);
  }
  const first = edits.find((edit) => edit && edit.uri !== undefined && edit.uri !== null);
  if (!first) return null;
  const targetUri = String(first.uri);
  const snapshot = beforeByUri.get(targetUri);
  const beforeText = snapshot && typeof snapshot.text === 'string' ? snapshot.text : null;
  const targetEdits = edits.filter((edit) => edit && String(edit.uri) === targetUri);
  const fileName = basenameFromUri(targetUri);
  if (beforeText === null) {
    const createEdit = targetEdits.find((edit) => edit.kind === 'create' && typeof edit.text === 'string');
    if (!createEdit || Buffer.byteLength(createEdit.text, 'utf8') > MAX_PREVIEW_DOC_BYTES) return null;
    return { beforeText: null, text: createEdit.text, fileName };
  }
  if (Buffer.byteLength(beforeText, 'utf8') > MAX_PREVIEW_DOC_BYTES) return null;
  const text = applyEditsToText(beforeText, targetEdits);
  if (text === null) return null;
  return { beforeText, text, fileName };
}


/**
 * R14S1 change review TreeView (`dsh.changes`).
 *
 * L2 feature only: `createChangeTree` registers the tree data provider and
 * optional tree view, and exposes the command actions (Open Diff / Accept /
 * Undo / Refresh / Focus) as plain functions so extension.js only wires
 * commands. The change journal itself lives in src/changeTracker.js.
 */

function createTreeEvent() {
  const listeners = new Set();
  const event = (listener, thisArgs, disposables) => {
    const actual = thisArgs ? listener.bind(thisArgs) : listener;
    listeners.add(actual);
    const disposable = {
      dispose() {
        listeners.delete(actual);
      },
    };
    if (Array.isArray(disposables)) disposables.push(disposable);
    return disposable;
  };
  event.fire = (data) => {
    for (const listener of [...listeners]) {
      try {
        listener(data);
      } catch {
        // a failing tree listener must not break the refresh loop
      }
    }
  };
  event.dispose = () => listeners.clear();
  return event;
}

/**
 * @param {object} options - Options for createChangeTree.
 * @param {object} options.vscode - VS Code facade (window, commands, Uri, TreeItem).
 * @param {object} options.tracker - changeTracker instance.
 * @param {{fsPath:string}} [options.storageUri] - context.globalStorageUri for
 *   diff original files.
 * @param {Function} [options.loc] - Localization function.
 * @param {Function} [options.checkpointRollback] - Optional Undo seam.
 * @param {Function} [options.gitRestore] - Optional injectable seam for the
 *   external-undo `git checkout -- <file>` path (defaults to the built-in
 *   vscode.git API when available).
 * @returns {object} Change tree API.
 */
function createChangeTree({
  vscode,
  tracker,
  storageUri = null,
  loc = (value) => value,
  checkpointRollback = null,
  gitRestore = null,
} = {}) {
  if (!vscode || !vscode.window) throw new TypeError('createChangeTree requires a vscode facade');
  if (!tracker || typeof tracker.list !== 'function') throw new TypeError('createChangeTree requires a change tracker');

  const onDidChangeTreeData = createTreeEvent();

  // F-c: read-only in-memory preview documents served through a dedicated
  // scheme so pending entries can diff "before snapshot" vs "edits applied"
  // without touching the workspace on disk.
  const previewDocuments = new Map();
  let previewProviderRegistration = null;
  if (vscode.workspace && typeof vscode.workspace.registerTextDocumentContentProvider === 'function') {
    previewProviderRegistration = vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, {
      provideTextDocumentContent(uri) {
        const text = previewDocuments.get(uri.toString());
        return typeof text === 'string' ? text : '';
      },
    });
  }

  function makePreviewUri(entry, fileName, role) {
    const id = String(entry.id || 'entry').replace(/[^A-Za-z0-9._-]/g, '-');
    return vscode.Uri.parse(PREVIEW_SCHEME + '://changes/' + id + '/' + role + '/' + fileName);
  }

  // Journal v2: the top level groups by SOURCE so attribution is scannable
  // at a glance — bridge pushes (this sidebar), DSH tool writes (interceptor
  // notifications), and everything else the watcher caught (Web GUI, CLI,
  // other machines, manual edits).
  const SOURCE_GROUP_ORDER = ['bridge', 'tool-intercept', 'external'];
  const SOURCE_GROUP_LABELS = {
    bridge: 'DSH edits (via bridge)',
    'tool-intercept': 'DSH tool writes',
    external: 'External changes',
  };

  function groupEntries(entries) {
    const groups = [];
    const bySource = new Map();
    for (const entry of entries) {
      const source = SOURCE_GROUP_LABELS[entry.source] ? entry.source : 'bridge';
      if (!bySource.has(source)) {
        const group = { type: 'group', source, entries: [] };
        bySource.set(source, group);
        groups.push(group);
      }
      bySource.get(source).entries.push(entry);
    }
    groups.sort((a, b) => {
      const ai = SOURCE_GROUP_ORDER.indexOf(a.source);
      const bi = SOURCE_GROUP_ORDER.indexOf(b.source);
      return (ai === -1 ? SOURCE_GROUP_ORDER.length : ai) - (bi === -1 ? SOURCE_GROUP_ORDER.length : bi);
    });
    return groups;
  }

  function getChildren(element) {
    if (!element) {
      return groupEntries(tracker.list());
    }
    if (element && element.type === 'group') {
      return element.entries;
    }
    return [];
  }

  // B1: status descriptions localized for the surfaces a user scans -
  // pending entries carry the ⟳ marker, legacy 1.0.x 'applied' entries are
  // flagged as already on disk.
  function statusDescription(status) {
    if (status === 'pending') return '\u27f3 ' + loc('pending review');
    if (status === 'applied') return loc('applied (legacy)');
    return status;
  }

  // F-c: status-suffixed contextValues let package.json menus hide actions
  // that would only fail on terminal-state entries (undone/discarded cannot
  // be accepted; undone/discarded cannot be undone again).
  function entryContextValue(status) {
    if (status === 'pending') return 'dsh.changes.entry.pending';
    if (status === 'accepted') return 'dsh.changes.entry.accepted';
    if (status === 'undone') return 'dsh.changes.entry.undone';
    if (status === 'discarded') return 'dsh.changes.entry.discarded';
    if (status === 'applied') return 'dsh.changes.entry.legacy';
    return 'dsh.changes.entry';
  }

  function entryLabel(entry) {
    if (entry.label) return entry.label;
    const fromPath = typeof entry.path === 'string' && entry.path.length > 0
      ? entry.path.split(/[\\/]/).pop()
      : null;
    if (fromPath) return fromPath;
    if (Array.isArray(entry.edits) && entry.edits[0] && entry.edits[0].uri) {
      return basenameFromUri(String(entry.edits[0].uri));
    }
    return entry.id;
  }

  function getTreeItem(element) {
    if (!element) return null;
    if (element.type === 'group') {
      const item = new vscode.TreeItem(loc(SOURCE_GROUP_LABELS[element.source] || element.source), 1);
      item.id = 'dsh.changes.source:' + element.source;
      item.description = String(element.entries.length);
      item.contextValue = 'dsh.changes.source';
      return item;
    }
    const item = new vscode.TreeItem(entryLabel(element), 0);
    item.id = element.id;
    const status = statusDescription(element.status);
    item.description = element.sessionId && element.source === 'bridge'
      ? `${status} · ${element.sessionId}`
      : status;
    item.contextValue = entryContextValue(element.status);
    item.command = {
      command: 'dsh.changes.openDiff',
      title: loc('Open Diff'),
      arguments: [element],
    };
    return item;
  }

  function getParent(element) {
    // Journal v2 entries are raw journal records (no type marker); only the
    // group wrappers carry type === 'group'. Anything that is not a group is
    // an entry leaf, so resolve its owning source group by id.
    if (element && element.type !== 'group') {
      return groupEntries(tracker.list())
        .find((group) => group.entries.some((entry) => entry.id === element.id)) || null;
    }
    return null;
  }

  const provider = {
    onDidChangeTreeData,
    getChildren,
    getTreeItem,
    getParent,
  };

  function refresh() {
    onDidChangeTreeData.fire();
  }

  function entries() {
    return tracker.list();
  }

  /**
   * Open a diff for one journal entry. Pending entries (F-c) diff the before
   * snapshot against a read-only in-memory preview of the edits applied; every
   * other status - and pending entries whose document/edits exceed the preview
   * limits - falls back to the audited snapshot-vs-disk diff. In the fallback
   * `create` edits have no before text and are skipped; a change without any
   * snapshot is reported cleanly.
   *
   * @param {object} entry - Journal entry.
   * @returns {Promise<{opened: boolean}>} Open result.
   */
  async function openDiff(entry) {
    if (entry && entry.status === 'pending') {
      const preview = buildPendingPreview(entry);
      if (preview) {
        let leftUri;
        if (preview.beforeText === null || !storageUri || typeof storageUri.fsPath !== 'string') {
          // create targets (or a storage-less host): the left side is an empty
          // read-only preview document instead of an on-disk snapshot.
          leftUri = makePreviewUri(entry, preview.fileName, 'before');
          previewDocuments.set(leftUri.toString(), preview.beforeText === null ? '' : preview.beforeText);
        } else {
          const directory = path.join(storageUri.fsPath, 'changes', entry.id);
          fs.mkdirSync(directory, { recursive: true });
          const originalPath = path.join(directory, 'original');
          fs.writeFileSync(originalPath, preview.beforeText, 'utf8');
          leftUri = vscode.Uri.file(originalPath);
        }
        const rightUri = makePreviewUri(entry, preview.fileName, 'after');
        previewDocuments.set(rightUri.toString(), preview.text);
        await vscode.commands.executeCommand(
          'vscode.diff',
          leftUri,
          rightUri,
          entry.label || entry.id,
          { preview: false, preserveFocus: false },
        );
        return { opened: true, preview: true };
      }
      // Fallback (document/edits over the preview limits, or a malformed
      // batch): keep the audited snapshot-vs-disk diff below.
    }
    const before = (Array.isArray(entry.before) ? entry.before : []).find((snapshot) => (
      snapshot && typeof snapshot.text === 'string'
    ));
    const edit = (Array.isArray(entry.edits) ? entry.edits : []).find((candidate) => (
      candidate && candidate.kind !== 'create' && candidate.uri
    ));
    if (!before || !edit) {
      // Journal v2 attribution-only entries (tool-intercept / external): the
      // write already happened on disk with no captured before text. Annotate
      // that and open the current file — a fabricated blank diff would be
      // misleading, the git SCM view remains the hunk-level fallback.
      const targetUriString = typeof entry.uri === 'string' && entry.uri.length > 0
        ? entry.uri
        : (Array.isArray(entry.edits) && entry.edits[0] && typeof entry.edits[0].uri === 'string'
          ? entry.edits[0].uri
          : null);
      const target = targetUriString
        ? vscode.Uri.parse(targetUriString)
        : (typeof entry.path === 'string' && entry.path.length > 0 ? vscode.Uri.file(entry.path) : null);
      if (target) {
        try {
          await vscode.window.showInformationMessage(loc('No before snapshot for this change; showing the current file'));
        } catch {
          // informational only
        }
        try {
          await vscode.commands.executeCommand('vscode.open', target, { preview: false });
        } catch {
          // opening is best-effort; the annotation above already explained why
        }
        return { opened: true, noSnapshot: true };
      }
      throw new Error('This change has no before snapshot to diff');
    }
    if (!storageUri || typeof storageUri.fsPath !== 'string') {
      throw new Error('Change diff storage is unavailable');
    }
    const directory = path.join(storageUri.fsPath, 'changes', entry.id);
    fs.mkdirSync(directory, { recursive: true });
    const originalPath = path.join(directory, 'original');
    fs.writeFileSync(originalPath, before.text, 'utf8');
    const originalUri = vscode.Uri.file(originalPath);
    const currentUri = vscode.Uri.parse(typeof edit.uri === 'string' ? edit.uri : String(edit.uri));
    await vscode.commands.executeCommand(
      'vscode.diff',
      originalUri,
      currentUri,
      entry.label || entry.id,
      { preview: false, preserveFocus: false },
    );
    return { opened: true };
  }

  // B1: Accept is the only disk-writing path (tracker.accept applies the
  // edits). Legacy 'applied' entries become a bookkeeping no-op there.
  async function accept(entry) {
    const result = await tracker.accept(entry.id);
    refresh();
    return result;
  }

  function entryTargetFsPath(entry) {
    if (typeof entry.path === 'string' && entry.path.length > 0) return entry.path;
    if (typeof entry.uri === 'string' && entry.uri.startsWith('file://')) {
      return decodeURIComponent(entry.uri.replace(/^file:\/\//, ''));
    }
    return null;
  }

  /**
   * Default external-undo git seam: `git checkout -- <file>` through the
   * built-in vscode.git API (same resolution chain as the v3 git handlers).
   * Returns false when git is unavailable or does not expose checkout.
   */
  async function gitRestoreDefault(fsPath) {
    try {
      const extension = vscode.extensions && vscode.extensions.getExtension
        && vscode.extensions.getExtension('vscode.git');
      if (!extension) return false;
      const exported = extension.isActive ? extension.exports : await extension.activate();
      const api = exported && typeof exported.getBuiltInGitApi === 'function'
        ? await exported.getBuiltInGitApi()
        : exported;
      if (!api || typeof api.getRepositories !== 'function') return false;
      const repositories = await api.getRepositories();
      for (const repository of Array.isArray(repositories) ? repositories : []) {
        const target = repository && typeof repository.checkout === 'function'
          ? repository
          : (repository && typeof repository.repository === 'object' ? repository.repository : null);
        if (target && typeof target.checkout === 'function') {
          await target.checkout(undefined, [fsPath]);
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Journal v2 undo for attribution-only entries (external / tool-intercept).
   * Priority: (1) the watcher's beforeSnapshot whole-file restore; (2) after
   * a destructive-action confirmation (NOT a permission gate — the write was
   * already allowed; this protects the user's own uncommitted work)
   * `git checkout -- <file>` when git can restore it. Without either, undo is
   * reported unavailable instead of silently doing nothing.
   */
  async function undoAttributed(entry) {
    const changeId = entry.id;
    if (entry.status === 'undone' || entry.status === 'discarded') {
      return { undone: false, reason: 'already-undone', changeId };
    }
    if (entry.status === 'pending') {
      tracker.updateStatus(changeId, 'discarded');
      refresh();
      return { undone: true, method: 'discard', changeId };
    }
    const targetPath = entryTargetFsPath(entry);
    if (entry.beforeSnapshotPath && targetPath) {
      try {
        const text = fs.readFileSync(entry.beforeSnapshotPath, 'utf8');
        fs.writeFileSync(targetPath, text, 'utf8');
        tracker.updateStatus(changeId, 'undone');
        refresh();
        return { undone: true, method: 'snapshot-restore', changeId };
      } catch {
        // fall through to the git path; the snapshot may have been cleaned
      }
    }
    if (!targetPath) {
      return { undone: false, reason: 'no-target-path', changeId };
    }
    const fileName = targetPath.split(/[\\/]/).pop() || targetPath;
    let choice = null;
    try {
      choice = await vscode.window.showWarningMessage(
        loc('Undo will discard uncommitted changes in {file}. Continue?', { file: fileName }),
        loc('Undo'),
      );
    } catch {
      choice = null;
    }
    if (choice !== loc('Undo')) {
      return { undone: false, reason: 'cancelled', changeId };
    }
    const restored = typeof gitRestore === 'function' ? await gitRestore(targetPath) : await gitRestoreDefault(targetPath);
    if (!restored) {
      try {
        await vscode.window.showErrorMessage(loc('Cannot undo this change: no snapshot and Git is unavailable'));
      } catch {
        // informational only
      }
      return { undone: false, reason: 'no-snapshot-no-git', changeId };
    }
    tracker.updateStatus(changeId, 'undone');
    refresh();
    return { undone: true, method: 'git-checkout', changeId };
  }

  async function undo(entry) {
    if (entry && (entry.source === 'external' || entry.source === 'tool-intercept')) {
      return undoAttributed(entry);
    }
    const result = await tracker.undo(entry.id, { checkpointRollback });
    refresh();
    return result;
  }

  async function reveal(entry) {
    refresh();
    try {
      if (treeView && typeof treeView.reveal === 'function') {
        await treeView.reveal(entry, { select: true, focus: true });
      }
    } catch {
      // reveal is best-effort; the refresh above already updates the list
    }
    try {
      await vscode.commands.executeCommand('dsh.changes.focus');
    } catch {
      // the focus command may be unavailable in tests
    }
  }

  let treeProviderRegistration = null;
  let treeView = null;
  if (typeof vscode.window.registerTreeDataProvider === 'function') {
    treeProviderRegistration = vscode.window.registerTreeDataProvider('dsh.changes', provider);
  }
  if (typeof vscode.window.createTreeView === 'function') {
    treeView = vscode.window.createTreeView('dsh.changes', {
      treeDataProvider: provider,
      showCollapseAll: true,
    });
  }

  function dispose() {
    onDidChangeTreeData.dispose();
    try {
      treeView?.dispose?.();
    } catch {
      // best-effort
    }
    try {
      treeProviderRegistration?.dispose?.();
    } catch {
      // best-effort
    }
    try {
      previewProviderRegistration?.dispose?.();
    } catch {
      // best-effort
    }
    previewDocuments.clear();
    treeView = null;
    treeProviderRegistration = null;
    previewProviderRegistration = null;
  }

  return Object.freeze({
    accept,
    dispose,
    entries,
    openDiff,
    provider,
    refresh,
    reveal,
    treeView,
    undo,
  });
}

module.exports = { createChangeTree };
