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
  buildSnapshotRestoreEdit,
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

test('B1: buildSnapshotRestoreEdit replaces whole files from before snapshots and reverses creates', async () => {
  const vscode = fakeVscode({ docs: { 'file:///ws/b.js': 'CURRENT-B' } });
  const entry = {
    edits: [
      { ...edits.insert, uri: 'file:///ws/a.js' },
      { ...edits.replace, uri: 'file:///ws/b.js' },
      { ...edits.create, uri: 'file:///ws/new.md' },
    ],
    before: [
      { uri: 'file:///ws/a.js', text: 'ORIGINAL-A' },
      { uri: 'file:///ws/b.js', text: 'BEFORE-B' },
      { uri: 'file:///ws/new.md', text: null },
    ],
  };
  const restore = await buildSnapshotRestoreEdit(entry, vscode);
  assert.deepStrictEqual(restore.operations.map((op) => op.type), ['replace', 'replace', 'deleteFile']);
  // One whole-document replace per file: range spans (0,0) to the end of
  // the CURRENT text, payload is the exact before bytes.
  const replaceA = restore.operations[0];
  assert.strictEqual(replaceA.uri, 'file:///ws/a.js');
  assert.strictEqual(replaceA.text, 'ORIGINAL-A');
  // docs has no a.js entry, so its current text reads back as empty.
  assert.deepStrictEqual(
    { line: replaceA.range.end.line, character: replaceA.range.end.character },
    { line: 0, character: 0 },
  );
  const replaceB = restore.operations[1];
  assert.strictEqual(replaceB.text, 'BEFORE-B');
  assert.deepStrictEqual(
    { line: replaceB.range.start.line, character: replaceB.range.start.character },
    { line: 0, character: 0 },
  );
  assert.deepStrictEqual(
    { line: replaceB.range.end.line, character: replaceB.range.end.character },
    { line: 0, character: 'CURRENT-B'.length },
  );
  assert.strictEqual(restore.operations[2].uri, 'file:///ws/new.md');
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
  assert.strictEqual(entry.status, 'pending', 'B1: pushes land in the journal as pending, not on disk');
  assert.strictEqual(entry.sessionId, 's-1');

  const reopened = createChangeTracker({ storageUri: { fsPath: root }, vscode });
  const list = reopened.list();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].id, entry.id);
  assert.strictEqual(list[0].sessionId, 's-1');
  assert.ok(fs.existsSync(path.join(root, 'changes', 'journal.json')));
});

test('B1: undo discards a pending entry with zero on-disk effect', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-changes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const vscode = fakeVscode({ docs: { 'file:///ws/a.js': 'before-a' } });
  const tracker = createChangeTracker({ storageUri: { fsPath: root }, vscode });
  const normalized = validateWireEdits([edits.insert], vscode);
  const before = await tracker.snapshotBefore(normalized);
  const entry = await tracker.record({ edits: normalized.map((edit) => ({ ...edit, uri: String(edit.uri) })), before });
  const result = await tracker.undo(entry.id);
  assert.deepStrictEqual(result, { undone: true, method: 'discard', changeId: entry.id });
  assert.strictEqual(tracker.get(entry.id).status, 'discarded');
  assert.strictEqual(vscode.applied.length, 0, 'discarding a pending entry must never touch the editor');
  const second = await tracker.undo(entry.id);
  assert.deepStrictEqual(second, { undone: false, reason: 'already-undone', changeId: entry.id });
});

test('B1: undo of an accepted entry snapshot-restores whole files', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-changes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const vscode = fakeVscode({ docs: { 'file:///ws/a.js': 'current-a' } });
  const tracker = createChangeTracker({ storageUri: { fsPath: root }, vscode });
  const normalized = validateWireEdits([edits.insert], vscode);
  const before = await tracker.snapshotBefore(normalized);
  const entry = await tracker.record({ edits: normalized.map((edit) => ({ ...edit, uri: String(edit.uri) })), before });
  await tracker.accept(entry.id);
  assert.strictEqual(vscode.applied.length, 1, 'accept applies the pending edits');
  const result = await tracker.undo(entry.id);
  assert.deepStrictEqual(result, { undone: true, method: 'snapshot-restore', changeId: entry.id });
  assert.strictEqual(tracker.get(entry.id).status, 'undone');
  const restore = vscode.applied[1];
  assert.strictEqual(restore.operations.length, 1);
  assert.strictEqual(restore.operations[0].type, 'replace');
  assert.strictEqual(restore.operations[0].uri, 'file:///ws/a.js');
  assert.strictEqual(restore.operations[0].text, 'current-a', 'undo puts the exact before-accept snapshot bytes back');
  assert.deepStrictEqual(
    { line: restore.operations[0].range.end.line, character: restore.operations[0].range.end.character },
    { line: 0, character: 'current-a'.length },
    'the restore range spans the whole current document',
  );
});

test('B1: accept applies pending edits and keeps pending on applyEdit rejection', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-changes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const vscode = fakeVscode({ docs: { 'file:///ws/a.js': 'before-a' } });
  const tracker = createChangeTracker({ storageUri: { fsPath: root }, vscode });
  const normalized = validateWireEdits([edits.insert], vscode);
  const entry = await tracker.record({ edits: normalized.map((edit) => ({ ...edit, uri: String(edit.uri) })) });
  const result = await tracker.accept(entry.id);
  assert.deepStrictEqual(result, { accepted: true, changeId: entry.id });
  assert.strictEqual(tracker.get(entry.id).status, 'accepted');

  const rejected = fakeVscode({ docs: {}, applyResult: false });
  const tracker2 = createChangeTracker({ vscode: rejected });
  const entry2 = await tracker2.record({ edits: normalized.map((edit) => ({ ...edit, uri: String(edit.uri) })) });
  await assert.rejects(
    tracker2.accept(entry2.id),
    (error) => error.bridgeCode === 'VSCODE_EDIT_REJECTED',
  );
  assert.strictEqual(tracker2.get(entry2.id).status, 'pending', 'failed accept keeps the entry pending');
});

test('B1: accept of a legacy applied entry is a no-op; undo snapshot-restores it', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-changes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const vscode = fakeVscode({ docs: { 'file:///ws/a.js': 'current-a' } });
  const tracker = createChangeTracker({ storageUri: { fsPath: root }, vscode });
  const normalized = validateWireEdits([edits.insert], vscode);
  // Simulate a 1.0.x journal entry that was already written to disk.
  const entry = await tracker.record({
    status: 'applied',
    edits: normalized.map((edit) => ({ ...edit, uri: String(edit.uri) })),
    before: [{ uri: 'file:///ws/a.js', text: 'before-a' }],
  });
  const result = await tracker.accept(entry.id);
  assert.deepStrictEqual(result, { accepted: true, changeId: entry.id, noOp: true });
  assert.strictEqual(vscode.applied.length, 0, 'legacy accept must not re-apply already-on-disk edits');
  assert.strictEqual(tracker.get(entry.id).status, 'accepted');

  const undone = await tracker.undo(entry.id);
  assert.deepStrictEqual(undone, { undone: true, method: 'snapshot-restore', changeId: entry.id });
  assert.strictEqual(vscode.applied[0].operations[0].text, 'before-a');
});

test('undo prefers the checkpoint rollback seam when provided', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-changes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const vscode = fakeVscode({ docs: { 'file:///ws/a.js': 'before-a' } });
  const tracker = createChangeTracker({ storageUri: { fsPath: root }, vscode });
  const normalized = validateWireEdits([edits.insert], vscode);
  const entry = await tracker.record({ edits: normalized.map((edit) => ({ ...edit, uri: String(edit.uri) })) });
  await tracker.accept(entry.id);
  const result = await tracker.undo(entry.id, {
    checkpointRollback: async () => ({ rolledBack: true }),
  });
  assert.deepStrictEqual(result, { undone: true, method: 'checkpoint', changeId: entry.id, rolledBack: true });
  assert.strictEqual(tracker.get(entry.id).status, 'undone');
  assert.strictEqual(vscode.applied.length, 1, 'only the accept edit was applied; checkpoint path adds none');
});

test('B1: checkpointRollback is not consulted for pending entries (discard wins)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-changes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const vscode = fakeVscode({ docs: { 'file:///ws/a.js': 'before-a' } });
  const tracker = createChangeTracker({ storageUri: { fsPath: root }, vscode });
  const normalized = validateWireEdits([edits.insert], vscode);
  const entry = await tracker.record({ edits: normalized.map((edit) => ({ ...edit, uri: String(edit.uri) })) });
  let checkpointCalls = 0;
  const result = await tracker.undo(entry.id, {
    checkpointRollback: async () => {
      checkpointCalls += 1;
      return { rolledBack: true };
    },
  });
  assert.deepStrictEqual(result, { undone: true, method: 'discard', changeId: entry.id });
  assert.strictEqual(checkpointCalls, 0, 'pending entries are discarded before any checkpoint seam runs');
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
test('B1: construction tolerates a facade without applyEdit; accept degrades to VSCODE_EDIT_UNAVAILABLE, pending undo still works', async () => {
  const base = fakeVscode();
  const vscode = {
    Uri: base.Uri,
    Position: base.Position,
    Range: base.Range,
    WorkspaceEdit: base.WorkspaceEdit,
    workspace: {
      workspaceFolders: base.workspace.workspaceFolders,
      getWorkspaceFolder: base.workspace.getWorkspaceFolder,
      openTextDocument: base.workspace.openTextDocument,
    },
  };
  const tracker = createChangeTracker({ vscode });
  const normalized = validateWireEdits([edits.insert], vscode);
  await assert.rejects(
    tracker.applyEdits(normalized),
    (error) => error.bridgeCode === 'VSCODE_EDIT_UNAVAILABLE',
  );
  const entry = await tracker.record({ edits: normalized.map((edit) => ({ ...edit, uri: String(edit.uri) })) });
  await assert.rejects(
    tracker.accept(entry.id),
    (error) => error.bridgeCode === 'VSCODE_EDIT_UNAVAILABLE',
  );
  // Discarding a pending entry never touches applyEdit, so it must work.
  const discarded = await tracker.undo(entry.id);
  assert.deepStrictEqual(discarded, { undone: true, method: 'discard', changeId: entry.id });
});
