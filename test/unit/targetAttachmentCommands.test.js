'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createAddFileToThreadCommand, createAddFolderToThreadCommand } = require('../../src/commands/addFileToThread');
const { createCtrlIEditCommand } = require('../../src/commands/ctrlIEdit');
const { createCtrlKEditCommand } = require('../../src/commands/ctrlKEdit');

function fixture() {
  const events = [];
  const uri = { toString: () => 'file:///workspace/file.js' };
  const attachment = { document: { uri } };
  const controller = new AbortController();
  let disposedPick = false;
  let accept;
  const picker = { selectedItems: [{ uri }], onDidAccept: (fn) => { accept = fn; }, onDidHide() {}, show() { events.push('picker'); accept(); }, dispose() { disposedPick = true; } };
  const vscode = {
    commands: { executeCommand: async () => { events.push('legacy-focus'); } },
    workspace: { findFiles: async () => { events.push('find'); return [uri]; } },
    window: {
      activeTextEditor: { selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } } },
      showInformationMessage: async () => { events.push('success'); }, showErrorMessage: async () => { events.push('error'); }, showWarningMessage: async () => {},
      createQuickPick: () => picker,
      showInputBox: async () => { events.push('input'); return 'edit'; },
    },
  };
  const deps = {
    vscode,
    editorContext: {
      attachActiveFile: () => { events.push('snapshot-file'); return attachment; },
      attachActiveSelection: () => { events.push('snapshot-selection'); return attachment; },
      attachFolder: async () => { events.push('read-folder'); return attachment; },
      attachFiles: async () => { events.push('read-files'); return [attachment]; },
    },
    coordinator: { request: async () => { throw new Error('Legacy insertion is forbidden'); } },
    formatFileAttachment: () => { events.push('format'); return 'file'; },
    formatFolderAttachment: () => { events.push('format'); return 'folder'; },
    formatSelectionAttachment: () => { events.push('format'); return 'selection'; },
    waitForResolvedView: async () => null, ensureConnected: async () => true, loc: (text) => text,
    useSessionBridge: () => true,
    insertTargetAttachment: async (prepare) => { events.push('capture'); const text = await prepare(controller.signal); events.push('commit'); return text; },
  };
  return { deps, events, uri, controller, picker, disposedPick: () => disposedPick };
}

test('target file and selection snapshot synchronously but format only after capture', async () => {
  const f = fixture(); await createAddFileToThreadCommand(f.deps)();
  assert.deepEqual(f.events, ['snapshot-file', 'capture', 'format', 'commit', 'success']);
  const g = fixture(); await createCtrlKEditCommand(g.deps)();
  assert.deepEqual(g.events, ['snapshot-selection', 'capture', 'input', 'format', 'commit', 'success']);
});
test('target folder reads and file picker work start after capture', async () => {
  const f = fixture(); await createAddFolderToThreadCommand(f.deps)(f.uri);
  assert.deepEqual(f.events, ['capture', 'read-folder', 'format', 'commit', 'success']);
  const g = fixture(); await createCtrlIEditCommand(g.deps)();
  assert.deepEqual(g.events, ['capture', 'find', 'picker', 'read-files', 'format', 'commit', 'success']);
  assert.equal(g.disposedPick(), true);
});
test('target cancellation closes picker without insertion or error notification', async () => {
  const f = fixture();
  f.picker.show = () => { f.events.push('picker'); f.controller.abort(); };
  await createCtrlIEditCommand(f.deps)();
  assert.equal(f.disposedPick(), true);
  assert.deepEqual(f.events, ['capture', 'find', 'picker']);
  const g = fixture();
  g.deps.vscode.window.showInputBox = async () => { g.events.push('input'); return undefined; };
  await createCtrlKEditCommand(g.deps)();
  assert.deepEqual(g.events, ['snapshot-selection', 'capture', 'input']);
});
