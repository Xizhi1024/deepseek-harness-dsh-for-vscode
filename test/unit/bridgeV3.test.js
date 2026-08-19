'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createV3Handlers, MAX_TERMINALS, MAX_FIND_FILES, MAX_PROGRESS, RING_BYTES,
} = require('../../src/bridge/v3');
const { METHODS_V3, METHODS_BY_VERSION, PROTOCOL_VERSIONS } = require('../../src/protocol/ch1');

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

  insert(uri, position, text) { this.operations.push({ type: 'insert', uri: String(uri), position, text }); }
  replace(uri, range, text) { this.operations.push({ type: 'replace', uri: String(uri), range, text }); }
  delete(uri, range) { this.operations.push({ type: 'delete', uri: String(uri), range }); }
  createFile(uri, options) { this.operations.push({ type: 'createFile', uri: String(uri), options }); }
  deleteFile(uri, options) { this.operations.push({ type: 'deleteFile', uri: String(uri), options }); }
}

function fakeVscode(overrides = {}) {
  const terminals = [];
  const quickPickAnswers = [];
  const appliedEdits = [];
  return {
    terminals,
    appliedEdits,
    api: {
      Position: FakePosition,
      Range: FakeRange,
      WorkspaceEdit: FakeWorkspaceEdit,
      ProgressLocation: { Notification: 15 },
      StatusBarAlignment: { Right: 2 },
      Uri: {
        parse: (value) => ({ scheme: 'file', fsPath: value, toString: () => value }),
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
        getWorkspaceFolder(uri) {
          const value = String(uri);
          if (value.startsWith('file:///ws')) return { name: 'ws', index: 0 };
          return undefined;
        },
        async openTextDocument() { throw new Error('no file'); },
        async applyEdit(workspaceEdit) { appliedEdits.push(workspaceEdit); return true; },
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

test('consent gates keep terminal, editor/read and UI surfaces unmounted by default', () => {
  const fake = fakeVscode();
  const handlers = createV3Handlers({ vscode: fake.api, getFlag: flags() });
  assert.strictEqual(handlers['vscode/terminal/create'], undefined);
  assert.strictEqual(handlers['vscode/editor/read'], undefined);
  assert.strictEqual(handlers['vscode/window/showMessage'], undefined, 'showMessage requires bridge.ui');
  assert.strictEqual(handlers['vscode/progress/start'], undefined, 'progress requires bridge.ui');
  assert.strictEqual(handlers['vscode/statusbar/update'], undefined, 'statusbar requires bridge.ui');
  assert.strictEqual(handlers['vscode/output/append'], undefined, 'output requires bridge.ui');
  assert.strictEqual(handlers['vscode/confirm/ask'], undefined, 'confirm requires bridge.ui');
  assert.ok(typeof handlers['vscode/editor/getState'] === 'function', 'metadata state stays ungated');
});

test('dsh.bridge.ui mounts the five user-visible handlers when enabled', () => {
  const fake = fakeVscode();
  const handlers = createV3Handlers({ vscode: fake.api, getFlag: flags({ 'bridge.ui': true }) });
  for (const method of ['vscode/window/showMessage', 'vscode/progress/start', 'vscode/statusbar/update', 'vscode/output/append', 'vscode/confirm/ask']) {
    assert.ok(typeof handlers[method] === 'function', method + ' mounts with bridge.ui');
  }
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
  const handlers = createV3Handlers({ vscode: fake.api, getFlag: flags({ 'bridge.ui': true }) });
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
  const handlers = createV3Handlers({ vscode: fake.api, getFlag: flags({ 'bridge.ui': true }) });
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

test('changes/push is gated by dsh.features.changes-review', () => {
  const fake = fakeVscode();
  const off = createV3Handlers({ vscode: fake.api, getFlag: flags() });
  assert.strictEqual(off['vscode/changes/push'], undefined, 'changes/push is an L2 feature, off by default');
  const on = createV3Handlers({ vscode: fake.api, getFlag: flags({ 'features.changes-review': true }) });
  assert.ok(typeof on['vscode/changes/push'] === 'function', 'changes/push mounts when the feature is enabled');
});

test('changes/push applies after Allow Once and returns applied:true', async () => {
  const fake = fakeVscode();
  fake.api.window.showWarningMessage = async () => 'Allow Once';
  const handlers = createV3Handlers({ vscode: fake.api, getFlag: flags({ 'features.changes-review': true }) });
  const result = await handlers['vscode/changes/push']({
    label: 'demo',
    edits: [{ kind: 'insert', uri: 'file:///ws/a.js', at: { line: 0, character: 0 }, text: 'x' }],
  });
  assert.strictEqual(result.applied, true);
  assert.strictEqual(result.approved, true);
  assert.strictEqual(result.changeIds.length, 1);
  assert.strictEqual(fake.appliedEdits.length, 1);
});

test('changes/push returns model-visible not-approved on rejection', async () => {
  const fake = fakeVscode();
  fake.api.window.showWarningMessage = async () => 'Reject';
  const handlers = createV3Handlers({ vscode: fake.api, getFlag: flags({ 'features.changes-review': true }) });
  const result = await handlers['vscode/changes/push']({
    edits: [{ kind: 'insert', uri: 'file:///ws/a.js', at: { line: 0, character: 0 }, text: 'x' }],
  });
  assert.deepStrictEqual(result, { applied: false, approved: false, reason: 'user-rejected' });
  assert.strictEqual(fake.appliedEdits.length, 0);
});

test('changes/push session approval skips the next modal for the same session', async () => {
  const fake = fakeVscode();
  let asks = 0;
  fake.api.window.showWarningMessage = async () => {
    asks += 1;
    return asks === 1 ? 'Allow Session' : 'Allow Once';
  };
  const handlers = createV3Handlers({ vscode: fake.api, getFlag: flags({ 'features.changes-review': true }) });
  const params = {
    sessionId: 's-1',
    mode: 'session',
    edits: [{ kind: 'insert', uri: 'file:///ws/a.js', at: { line: 0, character: 0 }, text: 'x' }],
  };
  const first = await handlers['vscode/changes/push'](params);
  const second = await handlers['vscode/changes/push'](params);
  assert.strictEqual(first.approved, true);
  assert.strictEqual(second.approved, true);
  assert.strictEqual(asks, 1, 'session approval must skip the second modal');
  assert.strictEqual(fake.appliedEdits.length, 2);
});

test('changes/push rejects edits outside the workspace', async () => {
  const fake = fakeVscode();
  fake.api.window.showWarningMessage = async () => 'Allow Once';
  const handlers = createV3Handlers({ vscode: fake.api, getFlag: flags({ 'features.changes-review': true }) });
  await assert.rejects(
    handlers['vscode/changes/push']({
      edits: [{ kind: 'insert', uri: 'file:///outside/a.js', at: { line: 0, character: 0 }, text: 'x' }],
    }),
    (error) => error.bridgeCode === 'VSCODE_URI_OUTSIDE_WORKSPACE',
  );
});

test('mcp/* handlers are gated by features.mcp-consume; a missing manager degrades to VSCODE_MCP_UNAVAILABLE', async () => {
  const fake = fakeVscode();
  const manager = {
    async listServers() { return { servers: [] }; },
    async listTools(server) { return { server, tools: [] }; },
    async callTool(server, tool) { return { server, tool }; },
  };
  const off = createV3Handlers({ vscode: fake.api, getFlag: flags() });
  assert.strictEqual(off['vscode/mcp/listServers'], undefined, 'mcp methods must be off by default');
  assert.strictEqual(off['vscode/mcp/listTools'], undefined);
  assert.strictEqual(off['vscode/mcp/callTool'], undefined);

  // Flag on + degraded manager: methods stay advertised and fail with a
  // visible bridge error instead of silently disappearing (L0 hardening).
  const noManager = createV3Handlers({ vscode: fake.api, getFlag: flags({ 'features.mcp-consume': true }) });
  assert.ok(typeof noManager['vscode/mcp/listServers'] === 'function', 'flag on advertises mcp methods even without a manager');
  await assert.rejects(
    noManager['vscode/mcp/listServers'](),
    (error) => error.bridgeCode === 'VSCODE_MCP_UNAVAILABLE',
  );
  await assert.rejects(
    noManager['vscode/mcp/callTool']({ server: 's1', tool: 't1' }),
    (error) => error.bridgeCode === 'VSCODE_MCP_UNAVAILABLE',
  );

  const on = createV3Handlers({ vscode: fake.api, getFlag: flags({ 'features.mcp-consume': true }), mcpManager: manager });
  assert.ok(typeof on['vscode/mcp/listServers'] === 'function');
  assert.ok(typeof on['vscode/mcp/listTools'] === 'function');
  assert.ok(typeof on['vscode/mcp/callTool'] === 'function');
  const tools = await on['vscode/mcp/listTools']({ server: 's1' });
  assert.deepStrictEqual(tools, { server: 's1', tools: [] });

  // Production wiring passes a getter, so a manager assigned after the
  // handler map was built is still resolved at call time.
  let resolved = null;
  const lazy = createV3Handlers({ vscode: fake.api, getFlag: flags({ 'features.mcp-consume': true }), getMcpManager: () => resolved });
  resolved = manager;
  const lazyTools = await lazy['vscode/mcp/listTools']({ server: 's2' });
  assert.deepStrictEqual(lazyTools, { server: 's2', tools: [] });
});
