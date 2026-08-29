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

test('change tree registers the dsh.changes provider and groups journal entries by session', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-change-tree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vscode = fakeVscode();
  const tracker = createChangeTracker({ storageUri: { fsPath: root }, vscode });
  await tracker.record({ sessionId: 's-1', label: 'a', edits: [] });
  await tracker.record({ sessionId: 's-1', label: 'b', edits: [] });
  await tracker.record({ sessionId: 's-2', label: 'c', edits: [] });

  const tree = createChangeTree({ vscode, tracker, storageUri: { fsPath: root } });
  assert.strictEqual(vscode.registeredProviders[0].id, 'dsh.changes');
  const provider = vscode.registeredProviders[0].provider;

  const groups = provider.getChildren(null);
  assert.deepStrictEqual(groups.map((group) => group.sessionId), ['s-1', 's-2']);
  assert.strictEqual(provider.getChildren(groups[0]).length, 2);
  assert.strictEqual(provider.getChildren(groups[1]).length, 1);

  const item = provider.getTreeItem(groups[0]);
  assert.ok(item instanceof FakeTreeItem);
  assert.strictEqual(item.collapsibleState, 1);
  const entryItem = provider.getTreeItem(groups[0].entries[0]);
  assert.strictEqual(entryItem.contextValue, 'dsh.changes.entry.pending');
  assert.strictEqual(entryItem.command.command, 'dsh.changes.openDiff');
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
  const tree = createChangeTree({ vscode, tracker, storageUri: { fsPath: root } });
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
