'use strict';

const fs = require('node:fs');
const path = require('node:path');

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
 * @returns {object} Change tree API.
 */
function createChangeTree({
  vscode,
  tracker,
  storageUri = null,
  loc = (value) => value,
  checkpointRollback = null,
} = {}) {
  if (!vscode || !vscode.window) throw new TypeError('createChangeTree requires a vscode facade');
  if (!tracker || typeof tracker.list !== 'function') throw new TypeError('createChangeTree requires a change tracker');

  const onDidChangeTreeData = createTreeEvent();

  function groupEntries(entries) {
    const groups = [];
    const bySession = new Map();
    for (const entry of entries) {
      const key = entry.sessionId || '';
      if (!bySession.has(key)) {
        const group = { key, entries: [] };
        bySession.set(key, group);
        groups.push(group);
      }
      bySession.get(key).entries.push(entry);
    }
    return groups;
  }

  function getChildren(element) {
    if (!element) {
      return groupEntries(tracker.list()).map((group) => ({
        type: 'session',
        sessionId: group.key,
        entries: group.entries,
      }));
    }
    if (element && element.type === 'session') {
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

  function getTreeItem(element) {
    if (!element) return null;
    if (element.type === 'session') {
      const label = element.sessionId.length > 0 ? element.sessionId : loc('Untitled session');
      const item = new vscode.TreeItem(label, 1);
      item.id = 'dsh.changes.session:' + element.sessionId;
      item.contextValue = 'dsh.changes.session';
      return item;
    }
    const item = new vscode.TreeItem(element.label || element.id, 0);
    item.id = element.id;
    item.description = statusDescription(element.status);
    item.contextValue = 'dsh.changes.entry';
    item.command = {
      command: 'dsh.changes.openDiff',
      title: loc('Open Diff'),
      arguments: [element],
    };
    return item;
  }

  function getParent(element) {
    if (element && element.type === 'entry') {
      return {
        type: 'session',
        sessionId: element.sessionId || '',
        entries: tracker.list().filter((entry) => (entry.sessionId || '') === (element.sessionId || '')),
      };
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
   * Write the first available before-snapshot next to the journal and open a
   * diff against the current document. `create` edits have no before text and
   * are skipped; a change without any snapshot is reported cleanly.
   *
   * @param {object} entry - Journal entry.
   * @returns {Promise<{opened: boolean}>} Open result.
   */
  async function openDiff(entry) {
    const before = (Array.isArray(entry.before) ? entry.before : []).find((snapshot) => (
      snapshot && typeof snapshot.text === 'string'
    ));
    const edit = (Array.isArray(entry.edits) ? entry.edits : []).find((candidate) => (
      candidate && candidate.kind !== 'create' && candidate.uri
    ));
    if (!before || !edit) {
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

  async function undo(entry) {
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
    treeView = null;
    treeProviderRegistration = null;
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
