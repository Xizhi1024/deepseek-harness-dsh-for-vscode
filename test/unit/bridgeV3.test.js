'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createV3Handlers, MAX_TERMINALS, MAX_FIND_FILES, MAX_PROGRESS, RING_BYTES,
} = require('../../src/bridge/v3');
const { METHODS_V3, METHODS_BY_VERSION, PROTOCOL_VERSIONS } = require('../../src/protocol/ch1');

function fakeVscode(overrides = {}) {
  const terminals = [];
  const quickPickAnswers = [];
  return {
    terminals,
    api: {
      ProgressLocation: { Notification: 15 },
      StatusBarAlignment: { Right: 2 },
      Uri: {
        parse: (value) => ({ fsPath: value, toString: () => value }),
        joinPath: (base, child) => ({ fsPath: base.fsPath + '/' + child }),
      },
      window: {
        activeTextEditor: null,
        createTerminal(options) {
          const terminal = {
            name: typeof options === 'string' ? options : options.name,
            sent: [],
            sendText(text, addNewline) { this.sent.push([text, addNewline]); },
          };
          terminals.push(terminal);
          return terminal;
        },
        createStatusBarItem() { return { text: '', tooltip: '', show() { this.shown = true; } }; },
        showInformationMessage() { return Promise.resolve(undefined); },
        showWarningMessage() { return Promise.resolve(undefined); },
        showErrorMessage() { return Promise.resolve(undefined); },
        showInputBox() { return Promise.resolve('typed'); },
        showQuickPick() { return Promise.resolve(quickPickAnswers.shift()); },
        withProgress(options, callback) {
          return Promise.resolve(callback({ report() { this.reported = (this.reported || 0) + 1; } }));
        },
      },
      workspace: {
        textDocuments: [],
        workspaceFolders: [{ uri: { fsPath: 'C:\\ws' }, name: 'ws', index: 0 }],
        async findFiles(include, exclude, maxResults) { return Array.from({ length: 600 }, (_, i) => ({ toString: () => 'file://' + i })); },
        getConfiguration() { return { get: () => false }; },
        async openTextDocument() { throw new Error('no file'); },
      },
      tasks: {
        async fetchTasks() {
          return [
            { name: 'build', source: 'Workspace', detail: 'npm build', executeTask: null },
            { name: 'hidden-detector', source: 'npm', detail: '' },
          ];
        },
        async executeTask(task) { this.executed = task.name; return {}; },
      },
      debug: {
        async startDebugging(folder, config) { this.started = config.name; return true; },
      },
      extensions: {
        all: [{ id: 'pub.a', isActive: true, packageJSON: { main: 'x' } }, { id: 'pub.b', isActive: false, packageJSON: {} }],
        getExtension() { return undefined; },
      },
      ...overrides,
    },
  };
}

const flags = (map = {}) => (key) => Boolean(map[key]);

test('protocol v3 freezes the full v3a method table and versions', () => {
  assert.ok(PROTOCOL_VERSIONS.includes(3));
  assert.strictEqual(METHODS_BY_VERSION[3], METHODS_V3);
  for (const method of ['vscode/terminal/create', 'vscode/tasks/run', 'vscode/git/getStatus', 'vscode/editor/read', 'vscode/confirm/ask', 'vscode/changes/push', 'vscode/mcp/callTool']) {
    assert.ok(METHODS_V3.includes(method), method + ' must be frozen in v3');
  }
  assert.ok(!METHODS_V3.includes('vscode/extensions/callExport'), 'T2 callExport stays E-batch');
});

test('consent gates keep terminal and editor/read unmounted by default', () => {
  const fake = fakeVscode();
  const handlers = createV3Handlers({ vscode: fake.api, getFlag: flags() });
  assert.strictEqual(handlers['vscode/terminal/create'], undefined);
  assert.strictEqual(handlers['vscode/editor/read'], undefined);
  assert.ok(typeof handlers['vscode/editor/getState'] === 'function', 'metadata state stays ungated');
});

test('terminal bridge caps terminals and trims the ring buffer', async () => {
  const fake = fakeVscode();
  const handlers = createV3Handlers({ vscode: fake.api, getFlag: flags({ 'bridge.terminal': true }) });
  const created = [];
  for (let i = 0; i < MAX_TERMINALS; i += 1) {
    created.push((await handlers['vscode/terminal/create']({ name: 't' + i })).terminalId);
  }
  await assert.rejects(
    handlers['vscode/terminal/create']({ name: 'over' }),
    /at most/,
    'the terminal cap is enforced',
  );
  await handlers['vscode/terminal/sendText']({ terminalId: created[0], text: 'x'.repeat(RING_BYTES + 100) });
  const read = await handlers['vscode/terminal/read']({ terminalId: created[0], maxBytes: 64 });
  assert.strictEqual(read.text.length, 64, 'read honors maxBytes');
  assert.strictEqual(read.truncated, true, 'oversized rings report truncation');
  await assert.rejects(handlers['vscode/terminal/read']({ terminalId: 'nope' }), /Unknown terminalId/);
});

test('tasks list filters to workspace-declared tasks and run executes exactly those', async () => {
  const fake = fakeVscode();
  const handlers = createV3Handlers({ vscode: fake.api, getFlag: flags() });
  const list = await handlers['vscode/tasks/list']();
  assert.deepStrictEqual(list.tasks.map((task) => task.name), ['build'], 'detector tasks never appear');
  const run = await handlers['vscode/tasks/run']({ name: 'build' });
  assert.deepStrictEqual(run, { started: true, name: 'build' });
  assert.strictEqual(fake.api.tasks.executed, 'build');
  await assert.rejects(handlers['vscode/tasks/run']({ name: 'nope' }), /not found/);
  await assert.rejects(handlers['vscode/tasks/run']({ name: 'hidden-detector' }), /not found/);
});

test('findFiles caps results and showMessage routes levels', async () => {
  const fake = fakeVscode();
  const handlers = createV3Handlers({ vscode: fake.api, getFlag: flags() });
  const found = await handlers['vscode/workspace/findFiles']({ include: '**' });
  assert.strictEqual(found.files.length, MAX_FIND_FILES);
  assert.strictEqual(found.capped, true);
  await handlers['vscode/window/showMessage']({ level: 'error', message: 'boom' });
});

test('extensions list reports exportsFace and git methods surface unavailable cleanly', async () => {
  const fake = fakeVscode();
  const handlers = createV3Handlers({ vscode: fake.api, getFlag: flags() });
  const list = await handlers['vscode/extensions/list']();
  assert.deepStrictEqual(list.extensions, [
    { id: 'pub.a', isActive: true, exportsFace: true },
    { id: 'pub.b', isActive: false, exportsFace: false },
  ]);
  await assert.rejects(handlers['vscode/git/getStatus'](), /Git extension is not available/);
});

test('editor state is metadata-only and gated read returns buffer text', async () => {
  const fake = fakeVscode();
  fake.api.window.activeTextEditor = {
    document: { uri: { toString: () => 'file:///a.js' }, languageId: 'javascript', isDirty: true, getText: () => 'buffer-text' },
    selection: { start: { line: 0, character: 0 }, end: { line: 1, character: 2 } },
  };
  const gated = createV3Handlers({ vscode: fake.api, getFlag: flags({ 'bridge.editorRead': true }) });
  const text = await gated['vscode/editor/read']({});
  assert.strictEqual(text.text, 'buffer-text');
  const state = await gated['vscode/editor/getState']();
  assert.strictEqual(state.active.languageId, 'javascript');
  assert.strictEqual(state.active.dirty, true);
  assert.ok(!('text' in state.active), 'state never carries content');
});

test('progress bridge caps concurrency and confirm fails closed', async () => {
  const fake = fakeVscode();
  const handlers = createV3Handlers({ vscode: fake.api, getFlag: flags() });
  const first = await handlers['vscode/progress/start']({ title: 'one' });
  const second = await handlers['vscode/progress/start']({ title: 'two' });
  await assert.rejects(handlers['vscode/progress/start']({ title: 'three' }), /at most/);
  await handlers['vscode/progress/report']({ progressId: first.progressId, message: 'half' });
  await handlers['vscode/progress/end']({ progressId: first.progressId });
  await handlers['vscode/progress/end']({ progressId: second.progressId });
  const denied = await handlers['vscode/confirm/ask']({ kind: 'pick', prompt: 'choose', items: ['a'] });
  assert.strictEqual(denied.approved, false, 'no quickpick answer fails closed');
  const typed = await handlers['vscode/confirm/ask']({ kind: 'input', prompt: 'type' });
  assert.deepStrictEqual(typed, { approved: true, value: 'typed' });
});
