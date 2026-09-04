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

test('validateWireEdits rejects malformed edits', () => {
  const vscode = fakeVscode();
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

test('buildSnapshotRestoreEdit restores whole files from before snapshots and deletes created files', async () => {
  const vscode = fakeVscode({ docs: { 'file:///ws/b.js': 'AFTER' } });
  const entry = {
    edits: [edits.create],
    before: [
      { uri: 'file:///ws/b.js', text: 'BEFORE' },
      { uri: 'file:///ws/new.md' }, // create target without a snapshot text
    ],
  };
  const restore = await buildSnapshotRestoreEdit(entry, vscode);
  assert.deepStrictEqual(restore.operations.map((op) => op.type).sort(), ['deleteFile', 'replace']);
  const replaceOp = restore.operations.find((op) => op.type === 'replace');
  assert.strictEqual(replaceOp.text, 'BEFORE');
  assert.strictEqual(replaceOp.range.start.line, 0);
  assert.strictEqual(replaceOp.range.start.character, 0);
  const deleteOp = restore.operations.find((op) => op.type === 'deleteFile');
  assert.strictEqual(deleteOp.uri, 'file:///ws/new.md');
});

test('journal persists to globalStorage/changes/journal.json with session isolation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-changes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const vscode = fakeVscode({ docs: { 'file:///ws/a.js': 'before-a' } });
  const tracker = createChangeTracker({ storageUri: { fsPath: root }, vscode });
  const normalized = validateWireEdits([edits.insert], vscode);
  const before = await tracker.snapshotBefore(normalized);
  assert.deepStrictEqual(before, [{ uri: 'file:///ws/a.js', text: 'before-a' }]);
  // B1: record lands as pending — nothing is written to disk until accept.
  const entry = await tracker.record({ sessionId: 's-1', label: 'add x', edits: normalized.map((edit) => ({ ...edit, uri: String(edit.uri) })), before });
  assert.strictEqual(entry.status, 'pending');
  assert.strictEqual(entry.sessionId, 's-1');
  assert.strictEqual(vscode.applied.length, 0, 'pending push never applies edits');
  const accepted = await tracker.accept(entry.id);
  assert.deepStrictEqual(accepted, { accepted: true, changeId: entry.id });
  assert.strictEqual(tracker.get(entry.id).status, 'accepted');
  assert.strictEqual(vscode.applied.length, 1, 'accept is the only path that writes');

  const reopened = createChangeTracker({ storageUri: { fsPath: root }, vscode });
  const list = reopened.list();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].id, entry.id);
  assert.strictEqual(list[0].sessionId, 's-1');
  assert.ok(fs.existsSync(path.join(root, 'changes', 'journal.json')));
});

test('undo discards pending entries without touching disk; accepted entries restore snapshots', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-changes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const vscode = fakeVscode({ docs: { 'file:///ws/a.js': 'before-a' } });
  const tracker = createChangeTracker({ storageUri: { fsPath: root }, vscode });
  const normalized = validateWireEdits([edits.insert], vscode);
  const before = await tracker.snapshotBefore(normalized);
  const pendingEntry = await tracker.record({ edits: normalized.map((edit) => ({ ...edit, uri: String(edit.uri) })), before });
  const discard = await tracker.undo(pendingEntry.id);
  assert.deepStrictEqual(discard, { undone: true, method: 'discard', changeId: pendingEntry.id });
  assert.strictEqual(tracker.get(pendingEntry.id).status, 'discarded');
  assert.strictEqual(vscode.applied.length, 0, 'discarding a pending entry never applies edits');
  const second = await tracker.undo(pendingEntry.id);
  assert.deepStrictEqual(second, { undone: false, reason: 'already-undone', changeId: pendingEntry.id });

  const acceptedEntry = await tracker.record({ edits: normalized.map((edit) => ({ ...edit, uri: String(edit.uri) })), before });
  await tracker.accept(acceptedEntry.id);
  const restore = await tracker.undo(acceptedEntry.id);
  assert.deepStrictEqual(restore, { undone: true, method: 'snapshot-restore', changeId: acceptedEntry.id });
  assert.strictEqual(tracker.get(acceptedEntry.id).status, 'undone');
  assert.strictEqual(vscode.applied.length, 2, 'accept + snapshot restore');
});

test('undo prefers the checkpoint rollback seam when provided', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-changes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const vscode = fakeVscode({ docs: { 'file:///ws/a.js': 'before-a' } });
  const tracker = createChangeTracker({ storageUri: { fsPath: root }, vscode });
  const normalized = validateWireEdits([edits.insert], vscode);
  const entry = await tracker.record({ edits: normalized.map((edit) => ({ ...edit, uri: String(edit.uri) })) });
  await tracker.accept(entry.id); // checkpoint competes only once the entry is on disk
  const result = await tracker.undo(entry.id, {
    checkpointRollback: async () => ({ rolledBack: true }),
  });
  assert.deepStrictEqual(result, { undone: true, method: 'checkpoint', changeId: entry.id, rolledBack: true });
  assert.strictEqual(tracker.get(entry.id).status, 'undone');
  assert.strictEqual(vscode.applied.length, 1, 'accept applied once; checkpoint undo adds no inverse edit');
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
test('construction tolerates a facade without applyEdit; applyEdits/accept degrade, pending undo still works', async () => {
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
  // B1: a pending entry journals without any editor surface, and undo just
  // discards it — no applyEdit needed on degraded facades.
  const entry = await tracker.record({ edits: normalized.map((edit) => ({ ...edit, uri: String(edit.uri) })) });
  const result = await tracker.undo(entry.id);
  assert.deepStrictEqual(result, { undone: true, method: 'discard', changeId: entry.id });
  // Accept is the write path, so a facade without applyEdit degrades there.
  const second = await tracker.record({ edits: normalized.map((edit) => ({ ...edit, uri: String(edit.uri) })) });
  await assert.rejects(
    tracker.accept(second.id),
    (error) => error.bridgeCode === 'VSCODE_EDIT_UNAVAILABLE',
  );
});
