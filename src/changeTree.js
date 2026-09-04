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


function entryAtMs(entry) {
  const ms = Date.parse(entry && entry.at);
  return Number.isFinite(ms) ? ms : 0;
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
 * @param {'session'|'all'} [options.scope] - Which entries the tree shows.
 *   'session' (default) follows the sidebar's active DSH session: only
 *   bridge/tool-intercept entries attributed to that session are listed, in a
 *   single flat group. 'all' keeps the global three-source grouped view.
 * @param {Function} [options.additionalRoots] - () => string[] extra roots
 *   (typically [boundCwd]) prepended to workspace folders when resolving
 *   session-cwd-relative entry paths. Cross-window bug 2026-09-04: a relative
 *   tool-intercept path recorded against the DSH instance cwd must resolve
 *   even when the extension window's workspaceFolders do not contain it.
 * @returns {object} Change tree API.
 */
function createChangeTree({
  vscode,
  tracker,
  storageUri = null,
  loc = (value) => value,
  checkpointRollback = null,
  gitRestore = null,
  scope = 'session',
  additionalRoots = null,
} = {}) {
  if (!vscode || !vscode.window) throw new TypeError('createChangeTree requires a vscode facade');
  if (!tracker || typeof tracker.list !== 'function') throw new TypeError('createChangeTree requires a change tracker');

  // Session-following scope (default 'session'): the tree tracks the
  // sidebar's active DSH session. 'all' restores the global grouped view.
  let activeScope = scope === 'all' ? 'all' : 'session';
  let activeSessionId = null;
  let activeSessionLabel = null;
  let activeSessionSince = 0; // epoch-ms when the active session became active

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
    'external-session': 'During this session (unattributed)',
  };

  // Session scope: bridge/tool-intercept entries attributed to the active
  // session, PLUS external (watcher) entries recorded while that session was
  // active. Hiding every external edit made during the session made the
  // session view read as "changes missing" (live bug report 2026-09-04:
  // manual/test edits never appeared until the user flipped to the all view).
  function sessionFilteredEntries() {
    return tracker.list().filter((entry) => (
      entry.source !== 'external' && entry.sessionId === activeSessionId
    ));
  }

  function sessionExternalEntries() {
    if (!activeSessionId || !activeSessionSince) return [];
    return tracker.list().filter((entry) => (
      // External entries plus UNATTRIBUTED tool writes (sessionId '') recorded
      // during the session window — cross-window attribution drift must not
      // hide an edit made while this session was on screen.
      (entry.source === 'external' || (entry.source === 'tool-intercept' && !(entry.sessionId || '')))
      && entryAtMs(entry) >= activeSessionSince
    ));
  }

  function computeRoots() {
    if (activeScope !== 'session') {
      return groupEntries(tracker.list());
    }
    if (!activeSessionId) {
      return [{ type: 'info', id: 'dsh.changes.scope-hint' }];
    }
    const entries = sessionFilteredEntries();
    const externalEntries = sessionExternalEntries();
    if (entries.length === 0 && externalEntries.length === 0) return [];
    const roots = [];
    if (entries.length > 0) {
      roots.push({ type: 'group', source: 'session', entries });
    }
    if (externalEntries.length > 0) {
      roots.push({ type: 'group', source: 'external-session', entries: externalEntries });
    }
    return roots;
  }

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
      return computeRoots();
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
    if (element.type === 'info') {
      const item = new vscode.TreeItem(loc('Switch to a DSH session to see its changes'), 0);
      item.id = element.id;
      item.contextValue = 'dsh.changes.info';
      return item;
    }
    if (element.type === 'group') {
      const groupLabel = element.source === 'session'
        ? (activeSessionLabel || loc('Current session'))
        : loc(SOURCE_GROUP_LABELS[element.source] || element.source);
      const item = new vscode.TreeItem(groupLabel, 1);
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
      return computeRoots()
        .filter((node) => node.type === 'group')
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
   * Point the session scope at a DSH session (null/'' clears it back to the
   * empty state). Triggers a tree refresh.
   *
   * @param {string|null} sessionId - Active sidebar session id.
   * @param {string} [label] - Optional display name for the session group.
   * @returns {string|null} The stored session id.
   */
  function setActiveSession(sessionId, label) {
    const next = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
    if (next !== activeSessionId) {
      // Only a real session CHANGE resets the external-window boundary, so
      // label refreshes never drop already-visible external entries.
      activeSessionSince = next === null ? 0 : Date.now() + 1;
    }
    activeSessionId = next;
    activeSessionLabel = typeof label === 'string' && label.length > 0 ? label : null;
    refresh();
    return activeSessionId;
  }

  /**
   * Toggle between the session-following and the global ('all') view.
   * Triggers a tree refresh.
   *
   * @returns {'session'|'all'} The new scope.
   */
  function toggleScope() {
    activeScope = activeScope === 'session' ? 'all' : 'session';
    refresh();
    return activeScope;
  }

  function getScope() {
    return activeScope;
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
      const resolvedFsPath = entryTargetFsPath(entry); // absolute when resolvable
      const target = resolvedFsPath
        ? vscode.Uri.file(resolvedFsPath)
        : (targetUriString
          ? vscode.Uri.parse(targetUriString)
          : null);
      if (target) {
        // A deleted (or moved) target must never reach vscode.open — VS Code
        // answers with "cannot open the editor because the file was not found"
        // (live bug report 2026-09-04). Prefer the recorded snapshot when one
        // exists; otherwise state plainly that the file is gone.
        let targetExists = false;
        try {
          targetExists = Boolean(resolvedFsPath) && fs.existsSync(resolvedFsPath);
        } catch {
          targetExists = false;
        }
        if (!targetExists) {
          const snapshotPath = typeof entry.beforeSnapshotPath === 'string' ? entry.beforeSnapshotPath : null;
          let snapshotExists = false;
          try {
            snapshotExists = Boolean(snapshotPath) && fs.existsSync(snapshotPath);
          } catch {
            snapshotExists = false;
          }
          if (snapshotExists) {
            try {
              await vscode.window.showInformationMessage(loc('This file no longer exists; showing the recorded snapshot'));
            } catch {
              // informational only
            }
            try {
              await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(snapshotPath), { preview: false });
            } catch {
              // opening is best-effort
            }
            return { opened: true, noSnapshot: true, deleted: true };
          }
          try {
            await vscode.window.showInformationMessage(loc('This file has been deleted; there is nothing to diff or open'));
          } catch {
            // informational only
          }
          return { opened: false, noSnapshot: true, deleted: true };
        }
        // True before snapshot (pre-execute observer text, 2026-09-04):
        // real before/after diff instead of merely opening the current file.
        const snapshotPath = typeof entry.beforeSnapshotPath === 'string' ? entry.beforeSnapshotPath : null;
        let snapshotExists = false;
        try {
          snapshotExists = Boolean(snapshotPath) && fs.existsSync(snapshotPath);
        } catch {
          snapshotExists = false;
        }
        if (snapshotExists) {
          try {
            await vscode.commands.executeCommand(
              'vscode.diff',
              vscode.Uri.file(snapshotPath),
              target,
              entry.label || entry.id,
              { preview: false, preserveFocus: false },
            );
            return { opened: true, diff: true };
          } catch {
            // diff is best-effort; fall through to opening the current file
          }
        }
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

  /**
   * Roots for resolving session-cwd-relative tool paths: injected extra roots
   * (the bound DSH instance cwd) first, then workspace folders. Cross-window
   * bug 2026-09-04: an entry whose relative path was recorded against the
   * instance cwd resolved against the extension window's folders only and was
   * misreported as deleted — the bound cwd must win as a resolution base.
   */
  function workspaceRoots() {
    const roots = [];
    if (typeof additionalRoots === 'function') {
      try {
        for (const root of additionalRoots() || []) {
          if (typeof root === 'string' && root.length > 0 && !roots.includes(root)) roots.push(root);
        }
      } catch {
        // injected roots are best-effort
      }
    }
    try {
      const folders = vscode.workspace && Array.isArray(vscode.workspace.workspaceFolders)
        ? vscode.workspace.workspaceFolders
        : [];
      for (const folder of folders) {
        const root = folder && folder.uri && typeof folder.uri.fsPath === 'string' ? folder.uri.fsPath : null;
        if (root && !roots.includes(root)) roots.push(root);
      }
    } catch {
      // workspace folders unavailable; injected roots still apply
    }
    return roots;
  }

  /**
   * Absolute fsPath for an entry target. Tool-intercept entries recorded by
   * older builds (or by the projector) may carry a session-cwd-RELATIVE path
   * — fs.existsSync on such a string resolves against the extension-host cwd
   * and always reads as missing, which misreported existing files as deleted
   * (live bug 2026-09-04: hello.js existed but openDiff said "has been
   * deleted"). Relative paths resolve against the workspace roots,
   * preferring a root where the file exists.
   */
  function entryTargetFsPath(entry) {
    let raw = null;
    if (typeof entry.path === 'string' && entry.path.length > 0) raw = entry.path;
    else if (typeof entry.uri === 'string' && entry.uri.startsWith('file://')) {
      raw = decodeURIComponent(entry.uri.replace(/^file:\/\//, ''));
    }
    if (raw === null || path.isAbsolute(raw)) return raw;
    const roots = workspaceRoots();
    if (roots.length === 0) return raw;
    for (const root of roots) {
      const candidate = path.resolve(root, raw);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // probe next root
      }
    }
    return path.resolve(roots[0], raw);
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
  // Bug 2026-09-04 ("undo change has no response"): every terminal branch
  // must tell the user what happened — silent {undone:false} returns read as
  // a dead button even when they are correct bookkeeping answers.
  async function announceUndoResult(result) {
    if (!result || typeof result !== 'object') return result;
    try {
      if (result.undone === true) {
        await vscode.window.showInformationMessage(loc('Change undone'));
      } else if (result.reason === 'already-undone') {
        await vscode.window.showInformationMessage(loc('This change was already undone'));
      } else if (result.reason === 'no-target-path') {
        await vscode.window.showInformationMessage(loc('Cannot undo this change: the target file path cannot be resolved'));
      } else if (result.reason === 'cancelled') {
        await vscode.window.showInformationMessage(loc('Undo cancelled'));
      }
    } catch {
      // announcements are informational only
    }
    return result;
  }

  async function undoAttributed(entry) {
    const changeId = entry.id;
    if (entry.status === 'undone' || entry.status === 'discarded') {
      return announceUndoResult({ undone: false, reason: 'already-undone', changeId });
    }
    if (entry.status === 'pending') {
      tracker.updateStatus(changeId, 'discarded');
      refresh();
      return announceUndoResult({ undone: true, method: 'discard', changeId });
    }
    const targetPath = entryTargetFsPath(entry);
    if (entry.beforeSnapshotPath && targetPath) {
      try {
        const text = fs.readFileSync(entry.beforeSnapshotPath, 'utf8');
        fs.writeFileSync(targetPath, text, 'utf8');
        tracker.updateStatus(changeId, 'undone');
        refresh();
        return announceUndoResult({ undone: true, method: 'snapshot-restore', changeId });
      } catch {
        // fall through to the git path; the snapshot may have been cleaned
      }
    }
    if (!targetPath) {
      return announceUndoResult({ undone: false, reason: 'no-target-path', changeId });
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
      return announceUndoResult({ undone: false, reason: 'cancelled', changeId });
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
    return announceUndoResult({ undone: true, method: 'git-checkout', changeId });
  }

  async function undo(entry) {
    if (entry && (entry.source === 'external' || entry.source === 'tool-intercept')) {
      return undoAttributed(entry);
    }
    const result = await tracker.undo(entry.id, { checkpointRollback });
    refresh();
    return announceUndoResult(result);
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
    getScope,
    openDiff,
    provider,
    refresh,
    reveal,
    setActiveSession,
    toggleScope,
    treeView,
    undo,
  });
}

module.exports = { createChangeTree };
