'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createChangeTree } = require('../../src/changeTree');
const { createChangeTracker } = require('../../src/changeTracker');

class FakeTreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
    this.id = undefined;
    this.description = undefined;
    this.contextValue = undefined;
    this.command = undefined;
  }
}

class FakePosition {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class FakeRange {
  constructor(startLine, startCharacter, endLine, endCharacter) {
    this.start = new FakePosition(startLine, startCharacter);
    this.end = new FakePosition(endLine, endCharacter);
  }
}

class FakeWorkspaceEdit {
  insert() {}
  replace() {}
  delete() {}
  createFile() {}
  deleteFile() {}
}

function fakeVscode() {
  const registeredProviders = [];
  const contentProviders = [];
  const reveals = [];
  const executedCommands = [];
  const treeView = {
    reveals,
    async reveal(item, options) {
      reveals.push({ item, options });
    },
    dispose() {},
  };
  return {
    registeredProviders,
    contentProviders,
    reveals,
    executedCommands,
    TreeItem: FakeTreeItem,
    Position: FakePosition,
    Range: FakeRange,
    WorkspaceEdit: FakeWorkspaceEdit,
    Uri: {
      file(fsPath) {
        return { scheme: 'file', fsPath, toString: () => fsPath };
      },
      parse(value) {
        const text = String(value);
        const colon = text.indexOf(':');
        const scheme = colon > 0 ? text.slice(0, colon) : 'file';
        return { scheme, value: text, toString: () => text };
      },
    },
    window: {
      registerTreeDataProvider(id, provider) {
        registeredProviders.push({ id, provider });
        return { dispose() {} };
      },
      messages: [],
      async showInformationMessage(message) {
        this.messages.push({ level: 'info', message });
      },
      async showWarningMessage(message, ...buttons) {
        this.messages.push({ level: 'warning', message, buttons });
        return this.warningChoice === undefined ? undefined : this.warningChoice;
      },
      async showErrorMessage(message) {
        this.messages.push({ level: 'error', message });
      },
      createTreeView(id, options) {
        return { ...treeView, id, options };
      },
    },
    commands: {
      async executeCommand(...args) {
        executedCommands.push(args);
      },
    },
    workspace: {
      registerTextDocumentContentProvider(scheme, provider) {
        contentProviders.push({ scheme, provider });
        return { dispose() {} };
      },
      async applyEdit() {
        return true;
      },
      async openTextDocument() {
        throw new Error('not used');
      },
    },
  };
}

test('change tree registers the dsh.changes provider and groups entries by source (journal v2)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-change-tree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vscode = fakeVscode();
  const tracker = createChangeTracker({ storageUri: { fsPath: root }, vscode });
  await tracker.record({ sessionId: 's-1', label: 'a', edits: [] });
  await tracker.record({ sessionId: 's-2', label: 'b', edits: [] });
  await tracker.recordToolEdit({ tool: 'write', path: '/ws/c.js', sessionId: 's-1', size: 3, truncated: false });
  await tracker.record({ source: 'external', label: 'watched.js', edits: [], status: 'accepted' });

  const labels = [];
  const tree = createChangeTree({
    vscode,
    tracker,
    storageUri: { fsPath: root },
    // The grouped-by-source view is the explicit 'all' scope.
    scope: 'all',
    loc: (value) => {
      labels.push(value);
      return value;
    },
  });
  assert.strictEqual(vscode.registeredProviders[0].id, 'dsh.changes');
  const provider = vscode.registeredProviders[0].provider;

  const groups = provider.getChildren(null);
  // Canonical order: bridge first, then tool-intercept, then external.
  assert.deepStrictEqual(groups.map((group) => group.source), ['bridge', 'tool-intercept', 'external']);
  assert.strictEqual(provider.getChildren(groups[0]).length, 2);
  assert.strictEqual(provider.getChildren(groups[1]).length, 1);
  assert.strictEqual(provider.getChildren(groups[2]).length, 1);

  const bridgeItem = provider.getTreeItem(groups[0]);
  assert.ok(bridgeItem instanceof FakeTreeItem);
  assert.strictEqual(bridgeItem.collapsibleState, 1);
  assert.strictEqual(bridgeItem.label, 'DSH edits (via bridge)');
  assert.strictEqual(provider.getTreeItem(groups[1]).label, 'DSH tool writes');
  assert.strictEqual(provider.getTreeItem(groups[2]).label, 'External changes');
  assert.ok(labels.includes('DSH edits (via bridge)'));
  assert.ok(labels.includes('DSH tool writes'));
  assert.ok(labels.includes('External changes'));

  const entryItem = provider.getTreeItem(groups[0].entries[0]);
  assert.strictEqual(entryItem.contextValue, 'dsh.changes.entry.pending');
  assert.strictEqual(entryItem.command.command, 'dsh.changes.openDiff');
  // Session attribution rides the entry description inside the bridge group.
  assert.ok(entryItem.description.includes('s-1'));
  // tool-intercept entries keep the tool+file label and accepted status.
  const toolItem = provider.getTreeItem(groups[1].entries[0]);
  assert.strictEqual(toolItem.label, 'write c.js');
  assert.strictEqual(toolItem.contextValue, 'dsh.changes.entry.accepted');
  // getParent resolves the owning source group.
  const parent = provider.getParent(groups[1].entries[0]);
  assert.strictEqual(parent.source, 'tool-intercept');
  tree.dispose();
});

test('session scope shows only the active session entries and hides external ones', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-change-tree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vscode = fakeVscode();
  const tracker = createChangeTracker({ storageUri: { fsPath: root }, vscode });
  await tracker.record({ sessionId: 's-1', label: 'mine', edits: [] });
  await tracker.record({ sessionId: 's-2', label: 'theirs', edits: [] });
  await tracker.recordToolEdit({ tool: 'write', path: '/ws/mine.js', sessionId: 's-1', size: 3, truncated: false });
  await tracker.record({ source: 'external', label: 'watched.js', edits: [], status: 'accepted' });
  const tree = createChangeTree({ vscode, tracker, storageUri: { fsPath: root }, scope: 'session' });
  const provider = vscode.registeredProviders[0].provider;

  let refreshes = 0;
  provider.onDidChangeTreeData(() => { refreshes += 1; });
  tree.setActiveSession('s-1');
  assert.ok(refreshes >= 1, 'setActiveSession must trigger a refresh');

  const roots = provider.getChildren(null);
  assert.strictEqual(roots.length, 1);
  assert.strictEqual(roots[0].type, 'group');
  assert.strictEqual(roots[0].source, 'session');
  // Same-session bridge + tool-intercept entries only; other-session and
  // external entries stay hidden in the session scope.
  assert.deepStrictEqual(roots[0].entries.map((entry) => entry.label), ['mine', 'write mine.js']);
  assert.strictEqual(provider.getChildren(roots[0]).length, 2);

  const groupItem = provider.getTreeItem(roots[0]);
  assert.strictEqual(groupItem.label, 'Current session');
  assert.strictEqual(groupItem.collapsibleState, 1);
  assert.strictEqual(provider.getParent(roots[0].entries[0]).source, 'session');

  // Switching the active session re-filters the flat group.
  tree.setActiveSession('s-2');
  assert.deepStrictEqual(provider.getChildren(null)[0].entries.map((entry) => entry.label), ['theirs']);
  tree.dispose();
});

test('session scope without an active session renders the empty-state hint', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-change-tree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vscode = fakeVscode();
  const tracker = createChangeTracker({ storageUri: { fsPath: root }, vscode });
  await tracker.record({ sessionId: 's-1', label: 'a', edits: [] });
  const tree = createChangeTree({ vscode, tracker, storageUri: { fsPath: root } });
  const provider = vscode.registeredProviders[0].provider;

  // Default scope is 'session' and no active session is set: hint node only.
  assert.strictEqual(tree.getScope(), 'session');
  const roots = provider.getChildren(null);
  assert.strictEqual(roots.length, 1);
  assert.strictEqual(roots[0].type, 'info');
  const item = provider.getTreeItem(roots[0]);
  assert.strictEqual(item.label, 'Switch to a DSH session to see its changes');
  assert.strictEqual(item.contextValue, 'dsh.changes.info');
  assert.deepStrictEqual(provider.getChildren(roots[0]), []);
  assert.strictEqual(provider.getParent(roots[0]), null);

  // Clearing the session id restores the same empty state.
  tree.setActiveSession('s-1');
  assert.strictEqual(provider.getChildren(null)[0].type, 'group');
  tree.setActiveSession(null);
  assert.strictEqual(provider.getChildren(null)[0].type, 'info');
  tree.dispose();
});

test('toggleScope flips between the session view and the all-scope grouped view', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-change-tree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vscode = fakeVscode();
  const tracker = createChangeTracker({ storageUri: { fsPath: root }, vscode });
  await tracker.record({ sessionId: 's-1', label: 'a', edits: [] });
  await tracker.record({ sessionId: 's-2', label: 'b', edits: [] });
  await tracker.recordToolEdit({ tool: 'write', path: '/ws/c.js', sessionId: 's-1', size: 3, truncated: false });
  await tracker.record({ source: 'external', label: 'watched.js', edits: [], status: 'accepted' });
  const tree = createChangeTree({ vscode, tracker, storageUri: { fsPath: root }, scope: 'session' });
  const provider = vscode.registeredProviders[0].provider;
  tree.setActiveSession('s-1');

  assert.strictEqual(tree.getScope(), 'session');
  assert.strictEqual(tree.toggleScope(), 'all');
  assert.strictEqual(tree.getScope(), 'all');
  const groups = provider.getChildren(null);
  assert.deepStrictEqual(groups.map((group) => group.source), ['bridge', 'tool-intercept', 'external']);
  assert.strictEqual(provider.getChildren(groups[0]).length, 2);
  assert.strictEqual(provider.getChildren(groups[2]).length, 1);

  // And back: the single flat session group returns.
  assert.strictEqual(tree.toggleScope(), 'session');
  const roots = provider.getChildren(null);
  assert.strictEqual(roots.length, 1);
  assert.strictEqual(roots[0].source, 'session');
  assert.strictEqual(roots[0].entries.length, 2);
  tree.dispose();
});

test('change tree reveal refreshes, reveals the entry and focuses the view', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-change-tree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vscode = fakeVscode();
  const tracker = createChangeTracker({ storageUri: { fsPath: root }, vscode });
  const entry = await tracker.record({ label: 'x', edits: [] });
  const tree = createChangeTree({ vscode, tracker, storageUri: { fsPath: root } });

  await tree.reveal(entry);
  assert.strictEqual(vscode.reveals.length, 1);
  assert.strictEqual(vscode.reveals[0].item.id, entry.id);
  assert.ok(vscode.executedCommands.some((args) => args[0] === 'dsh.changes.focus'));
  tree.dispose();
});

test('change tree accept and undo delegate to the tracker', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-change-tree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vscode = fakeVscode();
  const tracker = createChangeTracker({ storageUri: { fsPath: root }, vscode });
  const entry = await tracker.record({
    label: 'undo me',
    edits: [{ kind: 'insert', uri: 'file:///ws/a.js', at: { line: 0, character: 0 }, text: 'x' }],
    before: [{ uri: 'file:///ws/a.js', text: '' }],
  });
  const tree = createChangeTree({ vscode, tracker, storageUri: { fsPath: root } });

  await tree.accept(entry);
  assert.strictEqual(tracker.get(entry.id).status, 'accepted');

  const result = await tree.undo(entry);
  assert.strictEqual(result.undone, true);
  assert.strictEqual(tracker.get(entry.id).status, 'undone');
  tree.dispose();
});

test('pending entry openDiff previews applied edits in memory against the before snapshot', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-change-tree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vscode = fakeVscode();
  const tracker = createChangeTracker({ storageUri: { fsPath: root }, vscode });
  const entry = await tracker.record({
    label: 'diff me',
    edits: [{ kind: 'replace', uri: 'file:///ws/a.js', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, text: 'new' }],
    before: [{ uri: 'file:///ws/a.js', text: 'old' }],
  });
  const tree = createChangeTree({ vscode, tracker, storageUri: { fsPath: root } });

  // F-c: the tree registers a read-only preview content provider.
  assert.strictEqual(vscode.contentProviders[0].scheme, 'dsh-change-preview');

  const result = await tree.openDiff(entry);
  assert.deepStrictEqual(result, { opened: true, preview: true });
  // Left side stays the on-disk before snapshot.
  const originalPath = path.join(root, 'changes', entry.id, 'original');
  assert.strictEqual(fs.readFileSync(originalPath, 'utf8'), 'old');
  const diffCall = vscode.executedCommands.find((args) => args[0] === 'vscode.diff');
  assert.ok(diffCall, 'vscode.diff must be invoked');
  assert.strictEqual(diffCall[1].fsPath, originalPath);
  // Right side is the in-memory preview uri and serves the applied text ('o' -> 'new').
  assert.strictEqual(diffCall[2].scheme, 'dsh-change-preview');
  assert.strictEqual(vscode.contentProviders[0].provider.provideTextDocumentContent(diffCall[2]), 'newld');
  tree.dispose();
});

test('pending entry openDiff preview applies multi-edit insert/replace/delete batches', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-change-tree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vscode = fakeVscode();
  const tracker = createChangeTracker({ storageUri: { fsPath: root }, vscode });
  const before = 'one\ntwo\r\nthree\nfour';
  const entry = await tracker.record({
    label: 'batch',
    edits: [
      { kind: 'insert', uri: 'file:///ws/a.txt', at: { line: 0, character: 3 }, text: '!!' },
      { kind: 'delete', uri: 'file:///ws/a.txt', range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } } },
      { kind: 'replace', uri: 'file:///ws/a.txt', range: { start: { line: 3, character: 0 }, end: { line: 3, character: 4 } }, text: 'FOUR' },
    ],
    before: [{ uri: 'file:///ws/a.txt', text: before }],
  });
  const tree = createChangeTree({ vscode, tracker, storageUri: { fsPath: root } });

  await tree.openDiff(entry);
  const diffCall = vscode.executedCommands.find((args) => args[0] === 'vscode.diff');
  assert.strictEqual(diffCall[2].scheme, 'dsh-change-preview');
  assert.strictEqual(
    vscode.contentProviders[0].provider.provideTextDocumentContent(diffCall[2]),
    'one!!\ntwo\r\n\nFOUR'
  );
  tree.dispose();
});

test('pending create entry openDiff previews the created file with an empty left side', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-change-tree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vscode = fakeVscode();
  const tracker = createChangeTracker({ storageUri: { fsPath: root }, vscode });
  const entry = await tracker.record({
    label: 'new file',
    edits: [{ kind: 'create', uri: 'file:///ws/made-up.ts', text: 'export const x = 1;\n' }],
    before: [{ uri: 'file:///ws/made-up.ts', text: null }],
  });
  const tree = createChangeTree({ vscode, tracker, storageUri: { fsPath: root } });

  const result = await tree.openDiff(entry);
  assert.deepStrictEqual(result, { opened: true, preview: true });
  const diffCall = vscode.executedCommands.find((args) => args[0] === 'vscode.diff');
  assert.strictEqual(diffCall[1].scheme, 'dsh-change-preview');
  assert.strictEqual(diffCall[2].scheme, 'dsh-change-preview');
  const provider = vscode.contentProviders[0].provider;
  assert.strictEqual(provider.provideTextDocumentContent(diffCall[1]), '');
  assert.strictEqual(provider.provideTextDocumentContent(diffCall[2]), 'export const x = 1;\n');
  tree.dispose();
});

test('oversized pending entry openDiff falls back to the audited snapshot-vs-disk diff', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-change-tree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vscode = fakeVscode();
  const tracker = createChangeTracker({ storageUri: { fsPath: root }, vscode });
  const entry = await tracker.record({
    label: 'huge',
    edits: [{ kind: 'replace', uri: 'file:///ws/big.txt', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, text: 'xyz' }],
    before: [{ uri: 'file:///ws/big.txt', text: 'x'.repeat(3 * 1024 * 1024) }],
  });
  const tree = createChangeTree({ vscode, tracker, storageUri: { fsPath: root } });

  const result = await tree.openDiff(entry);
  assert.deepStrictEqual(result, { opened: true });
  const diffCall = vscode.executedCommands.find((args) => args[0] === 'vscode.diff');
  // Right side is the real on-disk file (result auditor fallback, not a preview).
  assert.strictEqual(diffCall[2].scheme, 'file');
  assert.strictEqual(diffCall[2].value, 'file:///ws/big.txt');
  tree.dispose();
});

test('entry contextValue reflects the journal status for menu gating', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-change-tree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vscode = fakeVscode();
  const tracker = createChangeTracker({ storageUri: { fsPath: root }, vscode });
  const mk = async (status) => {
    const entry = await tracker.record({
      label: status,
      status: status === 'legacy' ? 'applied' : status,
      edits: [{ kind: 'insert', uri: 'file:///ws/a.js', at: { line: 0, character: 0 }, text: 'x' }],
      before: [{ uri: 'file:///ws/a.js', text: '' }],
    });
    return entry;
  };
  await mk('pending');
  await mk('accepted');
  await mk('undone');
  await mk('discarded');
  await mk('legacy');
  const tree = createChangeTree({ vscode, tracker, storageUri: { fsPath: root }, scope: 'all' });
  const provider = vscode.registeredProviders[0].provider;

  const groups = provider.getChildren(null);
  const items = groups[0].entries.map((element) => provider.getTreeItem(element).contextValue);
  assert.deepStrictEqual(items, [
    'dsh.changes.entry.pending',
    'dsh.changes.entry.accepted',
    'dsh.changes.entry.undone',
    'dsh.changes.entry.discarded',
    'dsh.changes.entry.legacy',
  ]);
  tree.dispose();
});
// ---- journal v2 (C1): external/tool-intercept undo + no-snapshot openDiff ----

test('external entry undo restores the before snapshot file and marks the entry undone', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tree-ext-undo-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'watched.txt');
  fs.writeFileSync(target, 'changed-by-web-gui', 'utf8');
  const snapshotPath = path.join(root, 'snap.txt');
  fs.writeFileSync(snapshotPath, 'before-text', 'utf8');
  const vscode = fakeVscode();
  const tracker = createChangeTracker({ storageUri: { fsPath: root }, vscode });
  const entry = await tracker.record({
    source: 'external',
    label: 'watched.txt',
    edits: [],
    before: [],
    status: 'accepted',
    path: target,
  });
  tracker.updateEntry(entry.id, { beforeSnapshotPath: snapshotPath });
  const tree = createChangeTree({ vscode, tracker, storageUri: { fsPath: root } });

  const result = await tree.undo(tracker.get(entry.id));
  assert.deepStrictEqual(result, { undone: true, method: 'snapshot-restore', changeId: entry.id });
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'before-text');
  assert.strictEqual(tracker.get(entry.id).status, 'undone');
  // No confirmation prompt is needed when a snapshot exists.
  assert.strictEqual(vscode.window.messages.length, 0);
  tree.dispose();
});

test('external entry undo without snapshot asks for confirmation, then git-checkouts the file', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tree-ext-git-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'dirty.js');
  fs.writeFileSync(target, 'dirty', 'utf8');
  const vscode = fakeVscode();
  vscode.window.warningChoice = 'Undo';
  const tracker = createChangeTracker({ storageUri: { fsPath: root }, vscode });
  const entry = await tracker.record({
    source: 'external',
    label: 'dirty.js',
    edits: [],
    before: [],
    status: 'accepted',
    path: target,
  });
  const restored = [];
  const tree = createChangeTree({
    vscode,
    tracker,
    storageUri: { fsPath: root },
    loc: (value, params) => Object.entries(params || {}).reduce(
      (text, [key, replacement]) => text.split('{' + key + '}').join(String(replacement)),
      value,
    ),
    gitRestore: async (fsPath) => {
      restored.push(fsPath);
      return true;
    },
  });

  const result = await tree.undo(tracker.get(entry.id));
  assert.deepStrictEqual(result, { undone: true, method: 'git-checkout', changeId: entry.id });
  assert.deepStrictEqual(restored, [target]);
  assert.strictEqual(tracker.get(entry.id).status, 'undone');
  // The destructive-undo confirmation was shown exactly once (an undo safety
  // prompt, not a permission gate).
  const warnings = vscode.window.messages.filter((message) => message.level === 'warning');
  assert.strictEqual(warnings.length, 1);
  assert.ok(warnings[0].message.includes('dirty.js'));
  tree.dispose();
});

test('external entry undo without snapshot respects cancellation and git unavailability', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tree-ext-no-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'dirty2.js');
  fs.writeFileSync(target, 'dirty', 'utf8');
  const vscode = fakeVscode();
  vscode.window.warningChoice = undefined; // user dismisses the prompt
  const tracker = createChangeTracker({ storageUri: { fsPath: root }, vscode });
  const entry = await tracker.record({
    source: 'external',
    label: 'dirty2.js',
    edits: [],
    before: [],
    status: 'accepted',
    path: target,
  });
  const tree = createChangeTree({ vscode, tracker, storageUri: { fsPath: root } });

  const cancelled = await tree.undo(tracker.get(entry.id));
  assert.deepStrictEqual(cancelled, { undone: false, reason: 'cancelled', changeId: entry.id });
  assert.strictEqual(tracker.get(entry.id).status, 'accepted');

  vscode.window.warningChoice = 'Undo'; // confirm, but git cannot restore
  const unavailable = await tree.undo(tracker.get(entry.id));
  assert.deepStrictEqual(unavailable, { undone: false, reason: 'no-snapshot-no-git', changeId: entry.id });
  assert.strictEqual(tracker.get(entry.id).status, 'accepted');
  assert.ok(vscode.window.messages.some((message) => message.level === 'error'));
  tree.dispose();
});

test('tool-intercept entry openDiff annotates the missing snapshot and opens the current file', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tree-tool-diff-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vscode = fakeVscode();
  const tracker = createChangeTracker({ storageUri: { fsPath: root }, vscode });
  const entry = await tracker.recordToolEdit({
    tool: 'edit',
    path: '/ws/src/a.js',
    sessionId: 'sess-9',
    size: 42,
    truncated: false,
  });
  const tree = createChangeTree({ vscode, tracker, storageUri: { fsPath: root } });

  const result = await tree.openDiff(tracker.get(entry.id));
  assert.deepStrictEqual(result, { opened: true, noSnapshot: true });
  assert.ok(vscode.window.messages.some((message) => message.level === 'info'
    && message.message.includes('No before snapshot')));
  const openCall = vscode.executedCommands.find((args) => args[0] === 'vscode.open');
  assert.ok(openCall, 'vscode.open must be invoked for the current file');
  tree.dispose();
});

test('tool-intercept entry undo follows the external semantics (snapshot first)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tree-tool-undo-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'tool-written.js');
  fs.writeFileSync(target, 'after-tool', 'utf8');
  const snapshotPath = path.join(root, 'tool-snap.txt');
  fs.writeFileSync(snapshotPath, 'before-tool', 'utf8');
  const vscode = fakeVscode();
  const tracker = createChangeTracker({ storageUri: { fsPath: root }, vscode });
  const entry = await tracker.recordToolEdit({
    tool: 'write',
    path: target,
    sessionId: 'sess-1',
    size: 11,
    truncated: false,
  });
  tracker.updateEntry(entry.id, { beforeSnapshotPath: snapshotPath });
  const tree = createChangeTree({ vscode, tracker, storageUri: { fsPath: root } });

  const result = await tree.undo(tracker.get(entry.id));
  assert.deepStrictEqual(result, { undone: true, method: 'snapshot-restore', changeId: entry.id });
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'before-tool');
  tree.dispose();
});

