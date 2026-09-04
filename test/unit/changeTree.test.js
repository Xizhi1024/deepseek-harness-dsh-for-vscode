'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createChangeTree, shouldSurfaceEntry } = require('../../src/changeTree');
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
        return { scheme: 'file', value: String(value), toString: () => String(value) };
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
      async applyEdit() {
        return true;
      },
      async openTextDocument() {
        throw new Error('not used');
      },
    },
  };
}

test('change tree registers the dsh.changes provider and groups journal entries by source', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-change-tree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vscode = fakeVscode();
  const tracker = createChangeTracker({ storageUri: { fsPath: root }, vscode });
  await tracker.record({ sessionId: 's-1', label: 'a', edits: [] });
  await tracker.record({ sessionId: 's-1', label: 'b', edits: [] });
  await tracker.recordToolEdit({ tool: 'write', path: '/ws/x.js', sessionId: 's-1' });

  const tree = createChangeTree({ vscode, tracker, storageUri: { fsPath: root }, scope: 'all' });
  assert.strictEqual(vscode.registeredProviders[0].id, 'dsh.changes');
  const provider = vscode.registeredProviders[0].provider;

  const groups = provider.getChildren(null);
  assert.deepStrictEqual(groups.map((group) => group.source), ['bridge', 'tool-intercept']);
  assert.strictEqual(provider.getChildren(groups[0]).length, 2);
  assert.strictEqual(provider.getChildren(groups[1]).length, 1);

  const item = provider.getTreeItem(groups[0]);
  assert.ok(item instanceof FakeTreeItem);
  assert.strictEqual(item.collapsibleState, 1);
  const entryItem = provider.getTreeItem(groups[0].entries[0]);
  assert.match(entryItem.contextValue, /^dsh\.changes\.entry(\.\w+)?$/, 'status-suffixed contextValue');
  assert.strictEqual(entryItem.command.command, 'dsh.changes.openDiff');
  tree.dispose();
});

test('change tree reveal selects the entry without stealing focus (2026-09-04 regression)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-change-tree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vscode = fakeVscode();
  const tracker = createChangeTracker({ storageUri: { fsPath: root }, vscode });
  const entry = await tracker.record({ label: 'x', edits: [] });
  const tree = createChangeTree({ vscode, tracker, storageUri: { fsPath: root } });

  await tree.reveal(entry);
  assert.strictEqual(vscode.reveals.length, 1);
  assert.strictEqual(vscode.reveals[0].item.id, entry.id);
  assert.strictEqual(vscode.reveals[0].options.focus, false, 'default reveal never steals focus');
  assert.ok(!vscode.executedCommands.some((args) => args[0] === 'dsh.changes.focus'),
    'default reveal must not run the focus command');

  // Explicit opt-in still focuses (e.g. a user-initiated jump).
  await tree.reveal(entry, { focus: true });
  assert.strictEqual(vscode.reveals[1].options.focus, true);
  assert.ok(vscode.executedCommands.some((args) => args[0] === 'dsh.changes.focus'));
  tree.dispose();
});

test('shouldSurfaceEntry: only bridge entries surface in place, attributed/external edits refresh silently', () => {
  assert.strictEqual(shouldSurfaceEntry({ source: 'bridge' }), true);
  assert.strictEqual(shouldSurfaceEntry({ source: 'tool-intercept' }), false);
  assert.strictEqual(shouldSurfaceEntry({ source: 'external' }), false);
  assert.strictEqual(shouldSurfaceEntry({}), false);
  assert.strictEqual(shouldSurfaceEntry(null), false);
  assert.strictEqual(shouldSurfaceEntry(undefined), false);
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

test('change tree openDiff writes the before snapshot and opens vscode.diff', async (t) => {
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

  const result = await tree.openDiff(entry);
  assert.deepStrictEqual(result, { opened: true, preview: true });
  const originalPath = path.join(root, 'changes', entry.id, 'original');
  assert.strictEqual(fs.readFileSync(originalPath, 'utf8'), 'old');
  const diffCall = vscode.executedCommands.find((args) => args[0] === 'vscode.diff');
  assert.ok(diffCall, 'vscode.diff must be invoked');
  assert.strictEqual(diffCall[1].fsPath, originalPath);
  tree.dispose();
});
