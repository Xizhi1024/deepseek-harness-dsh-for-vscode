'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ChangeTrackerError,
  MAX_EDITS,
  MAX_EDIT_TEXT_BYTES,
  buildInverseWorkspaceEdit,
  buildWorkspaceEdit,
  createChangeTracker,
  positionAfterText,
  validateWireEdits,
} = require('../../src/changeTracker');

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
  constructor() {
    this.operations = [];
  }

  insert(uri, position, text) {
    this.operations.push({ type: 'insert', uri: String(uri), position, text });
  }

  replace(uri, range, text) {
    this.operations.push({ type: 'replace', uri: String(uri), range, text });
  }

  delete(uri, range) {
    this.operations.push({ type: 'delete', uri: String(uri), range });
  }

  createFile(uri, options) {
    this.operations.push({ type: 'createFile', uri: String(uri), options });
  }

  deleteFile(uri, options) {
    this.operations.push({ type: 'deleteFile', uri: String(uri), options });
  }
}

function fakeVscode({ docs = {}, applyResult = true } = {}) {
  const applied = [];
  const parse = (value) => ({
    scheme: 'file',
    fsPath: value,
    toString: () => value,
  });
  const workspaceFolders = [{ uri: parse('file:///ws') }];
  return {
    applied,
    docs,
    Uri: { parse },
    Position: FakePosition,
    Range: FakeRange,
    WorkspaceEdit: FakeWorkspaceEdit,
    workspace: {
      workspaceFolders,
      getWorkspaceFolder(uri) {
        const value = String(uri);
        if (value.startsWith('file:///ws')) return workspaceFolders[0];
        return undefined;
      },
      async openTextDocument(uri) {
        const value = String(uri);
        if (Object.prototype.hasOwnProperty.call(docs, value)) {
          return { getText: () => docs[value] };
        }
        throw new Error('document not found');
      },
      async applyEdit(workspaceEdit) {
        applied.push(workspaceEdit);
        return applyResult;
      },
    },
  };
}

const edits = {
  insert: { kind: 'insert', uri: 'file:///ws/a.js', at: { line: 1, character: 0 }, text: 'x' },
  replace: {
    kind: 'replace',
    uri: 'file:///ws/b.js',
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } },
    text: 'replacement',
  },
  delete: {
    kind: 'delete',
    uri: 'file:///ws/c.js',
    range: { start: { line: 3, character: 0 }, end: { line: 4, character: 0 } },
  },
  create: { kind: 'create', uri: 'file:///ws/new.md', text: 'hello' },
};

test('validateWireEdits accepts the frozen WorkspaceEdit safe subset', () => {
  const vscode = fakeVscode();
  const normalized = validateWireEdits([edits.insert, edits.replace, edits.delete, edits.create], vscode);
  assert.strictEqual(normalized.length, 4);
  assert.strictEqual(normalized[0].at.line, 1);
  assert.strictEqual(normalized[1].text, 'replacement');
});

test('validateWireEdits rejects outside-workspace and malformed edits', () => {
  const vscode = fakeVscode();
  assert.throws(
    () => validateWireEdits([{ ...edits.insert, uri: 'file:///outside/a.js' }], vscode),
    (error) => error instanceof ChangeTrackerError && error.bridgeCode === 'VSCODE_URI_OUTSIDE_WORKSPACE',
  );
  assert.throws(
    () => validateWireEdits([], vscode),
    (error) => error.bridgeCode === 'VSCODE_INVALID_PARAMS',
  );
  assert.throws(
    () => validateWireEdits(Array.from({ length: MAX_EDITS + 1 }, () => edits.insert), vscode),
    /1-50/,
  );
  assert.throws(
    () => validateWireEdits([{ ...edits.insert, text: 'x'.repeat(MAX_EDIT_TEXT_BYTES + 1) }], vscode),
    (error) => error.bridgeCode === 'VSCODE_EDIT_TOO_LARGE',
  );
  assert.throws(
    () => validateWireEdits([{ ...edits.insert, kind: 'rename' }], vscode),
    (error) => error.bridgeCode === 'VSCODE_INVALID_PARAMS',
  );
});

test('buildWorkspaceEdit translates every supported edit kind', () => {
  const vscode = fakeVscode();
  const workspaceEdit = buildWorkspaceEdit(
    validateWireEdits([edits.insert, edits.replace, edits.delete, edits.create], vscode),
    vscode,
  );
  assert.deepStrictEqual(workspaceEdit.operations.map((op) => op.type), [
    'insert',
    'replace',
    'delete',
    'createFile',
    'insert',
  ]);
  assert.strictEqual(workspaceEdit.operations[3].uri, 'file:///ws/new.md');
});

test('positionAfterText advances lines for LF and ignores CR in CRLF', () => {
  assert.deepStrictEqual(positionAfterText('ab', { line: 1, character: 2 }), { line: 1, character: 4 });
  assert.deepStrictEqual(positionAfterText('a\nb', { line: 1, character: 2 }), { line: 2, character: 1 });
  assert.deepStrictEqual(positionAfterText('a\r\nb', { line: 0, character: 0 }), { line: 1, character: 1 });
});

test('buildInverseWorkspaceEdit replays insert/replace/delete/create from before snapshots', () => {
  const vscode = fakeVscode({ docs: { 'file:///ws/b.js': 'BEFORE' } });
  const entry = {
    edits: [
      { ...edits.insert, uri: 'file:///ws/a.js' },
      { ...edits.replace, uri: 'file:///ws/b.js' },
      { ...edits.delete, uri: 'file:///ws/c.js' },
      { ...edits.create, uri: 'file:///ws/new.md' },
    ],
    before: [{ uri: 'file:///ws/b.js', text: 'BEFORE' }, { uri: 'file:///ws/c.js', text: 'ORIGINAL' }],
  };
  const inverse = buildInverseWorkspaceEdit(entry, vscode);
  assert.deepStrictEqual(inverse.operations.map((op) => op.type), [
    'delete',
    'replace',
    'insert',
    'deleteFile',
  ]);
  assert.deepStrictEqual(
    { line: inverse.operations[0].range.start.line, character: inverse.operations[0].range.start.character },
    { line: 1, character: 0 },
  );
  assert.deepStrictEqual(
    { line: inverse.operations[0].range.end.line, character: inverse.operations[0].range.end.character },
    { line: 1, character: 1 },
  );
  assert.strictEqual(inverse.operations[1].text, 'BEFORE');
  assert.strictEqual(inverse.operations[2].text, 'ORIGINAL');
});

test('journal persists to globalStorage/changes/journal.json with session isolation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-changes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const vscode = fakeVscode({ docs: { 'file:///ws/a.js': 'before-a' } });
  const tracker = createChangeTracker({ storageUri: { fsPath: root }, vscode });
  const normalized = validateWireEdits([edits.insert], vscode);
  const before = await tracker.snapshotBefore(normalized);
  assert.deepStrictEqual(before, [{ uri: 'file:///ws/a.js', text: 'before-a' }]);
  await tracker.applyEdits(normalized);
  const entry = await tracker.record({ sessionId: 's-1', label: 'add x', edits: normalized.map((edit) => ({ ...edit, uri: String(edit.uri) })), before });
  assert.strictEqual(entry.status, 'applied');
  assert.strictEqual(entry.sessionId, 's-1');

  const reopened = createChangeTracker({ storageUri: { fsPath: root }, vscode });
  const list = reopened.list();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].id, entry.id);
  assert.strictEqual(list[0].sessionId, 's-1');
  assert.ok(fs.existsSync(path.join(root, 'changes', 'journal.json')));
});

test('undo falls back to journal replay and marks the entry undone', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-changes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const vscode = fakeVscode({ docs: { 'file:///ws/a.js': 'before-a' } });
  const tracker = createChangeTracker({ storageUri: { fsPath: root }, vscode });
  const normalized = validateWireEdits([edits.insert], vscode);
  const before = await tracker.snapshotBefore(normalized);
  const entry = await tracker.record({ edits: normalized.map((edit) => ({ ...edit, uri: String(edit.uri) })), before });
  const result = await tracker.undo(entry.id);
  assert.deepStrictEqual(result, { undone: true, method: 'journal-replay', changeId: entry.id });
  assert.strictEqual(tracker.get(entry.id).status, 'undone');
  const second = await tracker.undo(entry.id);
  assert.deepStrictEqual(second, { undone: false, reason: 'already-undone', changeId: entry.id });
});

test('undo prefers the checkpoint rollback seam when provided', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-changes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const vscode = fakeVscode({ docs: { 'file:///ws/a.js': 'before-a' } });
  const tracker = createChangeTracker({ storageUri: { fsPath: root }, vscode });
  const normalized = validateWireEdits([edits.insert], vscode);
  const entry = await tracker.record({ edits: normalized.map((edit) => ({ ...edit, uri: String(edit.uri) })) });
  const result = await tracker.undo(entry.id, {
    checkpointRollback: async () => ({ rolledBack: true }),
  });
  assert.deepStrictEqual(result, { undone: true, method: 'checkpoint', changeId: entry.id, rolledBack: true });
  assert.strictEqual(tracker.get(entry.id).status, 'undone');
  assert.strictEqual(vscode.applied.length, 0, 'checkpoint path must not apply an inverse edit');
});

test('applyEdits surfaces VS Code rejection as VSCODE_EDIT_REJECTED', async () => {
  const vscode = fakeVscode({ applyResult: false });
  const tracker = createChangeTracker({ vscode });
  const normalized = validateWireEdits([edits.insert], vscode);
  await assert.rejects(
    tracker.applyEdits(normalized),
    (error) => error.bridgeCode === 'VSCODE_EDIT_REJECTED',
  );
});
