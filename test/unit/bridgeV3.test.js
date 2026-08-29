'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createV3Handlers, CALL_EXPORT_TIMEOUT_MS, MAX_TERMINALS, MAX_FIND_FILES, MAX_PROGRESS, RING_BYTES,
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

test('protocol v3 freezes the full v3 method table and versions', () => {
  assert.ok(PROTOCOL_VERSIONS.includes(3));
  assert.strictEqual(METHODS_BY_VERSION[3], METHODS_V3);
  for (const method of ['vscode/terminal/create', 'vscode/tasks/run', 'vscode/git/getStatus', 'vscode/editor/read', 'vscode/confirm/ask', 'vscode/changes/push', 'vscode/mcp/callTool', 'vscode/extensions/callExport']) {
    assert.ok(METHODS_V3.includes(method), method + ' must be frozen in v3');
  }
  assert.strictEqual(METHODS_V3.length, 32, 'E-T2a freezes the v3 method table at 32 entries');
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

test('A8: terminal/read mirrors real output captured through onDidWriteTerminalData', async () => {
  let dataHandler = null;
  const holder = { terminal: null };
  const api = {
    window: {
      createTerminal(options) {
        const terminal = {
          name: typeof options === 'string' ? options : options.name,
          sendText() {},
        };
        holder.terminal = terminal;
        return terminal;
      },
      onDidWriteTerminalData(handler) {
        dataHandler = handler;
        return { dispose() {} };
      },
    },
    workspace: {},
  };
  const handlers = createV3Handlers({ vscode: api, getFlag: flags({ 'bridge.terminal': true }) });
  const created = await handlers['vscode/terminal/create']({ name: 'probe' });
  await handlers['vscode/terminal/sendText']({ terminalId: created.terminalId, text: 'node -e "console.log(42)"' });
  // The terminal process wrote its output; the bridge must capture it.
  dataHandler({ terminal: holder.terminal, data: '42\r\n' });
  // Output of OTHER terminals must not leak into this ring.
  dataHandler({ terminal: { name: 'elsewhere' }, data: 'LEAK' });
  const read = await handlers['vscode/terminal/read']({ terminalId: created.terminalId });
  assert.ok(read.text.includes('42'), 'process output reaches terminal/read');
  assert.ok(!read.text.includes('LEAK'), 'other terminals output stays out');
});

test('A8 regression: a throwing proposed-API getter must not break handler construction', () => {
  // terminalDataWriteEvent is a PROPOSED API: hosts that have not enabled the
  // proposal for this extension install a getter on vscode.window that throws
  // "CANNOT use API proposal: terminalDataWriteEvent" on mere property access.
  // Handler construction (and thus activation) must survive that probe.
  const api = {
    window: {
      createTerminal() { return { name: 'x', sendText() {} }; },
    },
    workspace: {},
  };
  Object.defineProperty(api.window, 'onDidWriteTerminalData', {
    enumerable: true,
    get() {
      throw new Error("Extension 'Xizhi1024.dsh-vs-sidebar' CANNOT use API proposal: terminalDataWriteEvent.");
    },
  });
  let handlers;
  assert.doesNotThrow(() => {
    handlers = createV3Handlers({ vscode: api, getFlag: flags({ 'bridge.terminal': true }) });
  }, 'probing the proposed API must degrade, never throw');
  assert.strictEqual(typeof handlers['vscode/terminal/create'], 'function', 'terminal bridge still mounts (sendText ring only)');
});

test('A8 regression: a call-time gated proposed API must not break handler construction', () => {
  // VS Code 1.12x exposes the wrapper method to EVERY extension and enforces
  // the proposal entitlement when the wrapper is INVOKED, not when it is read:
  // the property probe succeeds and the subscription call itself throws
  // "CANNOT use API proposal: terminalDataWriteEvent". Handler construction
  // (and thus activation) must survive that call.
  const api = {
    window: {
      createTerminal() { return { name: 'x', sendText() {} }; },
      onDidWriteTerminalData() {
        throw new Error("Extension 'Xizhi1024.dsh-vs-sidebar' CANNOT use API proposal: terminalDataWriteEvent.");
      },
    },
    workspace: {},
  };
  let handlers;
  assert.doesNotThrow(() => {
    handlers = createV3Handlers({ vscode: api, getFlag: flags({ 'bridge.terminal': true }) });
  }, 'subscribing through the gated wrapper must degrade, never throw');
  assert.strictEqual(typeof handlers['vscode/terminal/create'], 'function', 'terminal bridge still mounts (sendText ring only)');
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

test('changes/push journals as pending after Allow Once and does not touch disk (B1)', async () => {
  const fake = fakeVscode();
  fake.api.window.showWarningMessage = async () => 'Allow Once';
  const handlers = createV3Handlers({ vscode: fake.api, getFlag: flags({ 'features.changes-review': true }) });
  const result = await handlers['vscode/changes/push']({
    label: 'demo',
    edits: [{ kind: 'insert', uri: 'file:///ws/a.js', at: { line: 0, character: 0 }, text: 'x' }],
  });
  assert.strictEqual(result.aproved === undefined, true); // no typo field
  assert.strictEqual(result.applied, false, 'B1: push no longer writes to disk');
  assert.strictEqual(result.approved, true);
  assert.strictEqual(result.pending, true);
  assert.strictEqual(result.changeIds.length, 1);
  assert.strictEqual(fake.appliedEdits.length, 0, 'B1: nothing is applied until the tree Accept command');
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
  assert.strictEqual(fake.appliedEdits.length, 0, 'B1: both pushes journal as pending; disk writes happen on Accept');
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

test('extensions/callExport is gated by dsh.features.call-export', () => {
  const fake = fakeVscode();
  const off = createV3Handlers({ vscode: fake.api, getFlag: flags() });
  assert.strictEqual(off['vscode/extensions/callExport'], undefined, 'callExport is an L2 feature, off by default');
  const on = createV3Handlers({ vscode: fake.api, getFlag: flags({ 'features.call-export': true }) });
  assert.ok(typeof on['vscode/extensions/callExport'] === 'function', 'callExport mounts when the feature is enabled');
});

test('extensions/callExport rejects invalid params as VSCODE_INVALID_PARAMS', async () => {
  const fake = fakeVscode();
  const handlers = createV3Handlers({ vscode: fake.api, getFlag: flags({ 'features.call-export': true }) });
  const invalid = [
    null,
    {},
    { extensionId: 7, method: 'run' },
    { extensionId: 'pub.a', method: '' },
    { extensionId: 'pub.a', method: 'x'.repeat(129) },
    { extensionId: 'not-an-id', method: 'run' },
    { extensionId: 'pub.a', method: 'run', args: 'nope' },
    { extensionId: 'pub.a', method: 'run', args: { f() {} } },
    { extensionId: 'pub.a', method: 'run', args: { n: 1n } },
  ];
  for (const params of invalid) {
    await assert.rejects(
      handlers['vscode/extensions/callExport'](params),
      (error) => error.bridgeCode === 'VSCODE_INVALID_PARAMS',
    );
  }
  const circular = {};
  circular.self = circular;
  await assert.rejects(
    handlers['vscode/extensions/callExport']({ extensionId: 'pub.a', method: 'run', args: circular }),
    (error) => error.bridgeCode === 'VSCODE_INVALID_PARAMS',
  );
});

test('extensions/callExport returns model-visible not-approved on rejection', async () => {
  const fake = fakeVscode();
  fake.api.window.showWarningMessage = async () => 'Reject';
  const handlers = createV3Handlers({ vscode: fake.api, getFlag: flags({ 'features.call-export': true }) });
  const result = await handlers['vscode/extensions/callExport']({ extensionId: 'pub.a', method: 'run', args: {} });
  assert.deepStrictEqual(result, { called: false, approved: false, reason: 'user-rejected' });
});

test('extensions/callExport consent timeout fails closed without throwing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = fakeVscode();
  fake.api.window.showWarningMessage = () => new Promise(() => {});
  const handlers = createV3Handlers({ vscode: fake.api, getFlag: flags({ 'features.call-export': true }) });
  const pending = handlers['vscode/extensions/callExport']({ extensionId: 'pub.a', method: 'run', args: {} });
  await Promise.resolve();
  t.mock.timers.tick(120000);
  const result = await pending;
  assert.deepStrictEqual(result, { called: false, approved: false, reason: 'timeout-or-dismissed' });
});

test('extensions/callExport Allow Session skips the next modal for the same extension+method', async () => {
  const fake = fakeVscode();
  let asks = 0;
  const calls = [];
  fake.api.window.showWarningMessage = async () => {
    asks += 1;
    return asks === 1 ? 'Allow Session' : 'Allow Once';
  };
  fake.api.extensions.getExtension = () => ({
    id: 'pub.a',
    isActive: true,
    exports: {
      run(v) {
        calls.push(v);
        return v.n * 2;
      },
    },
  });
  const handlers = createV3Handlers({ vscode: fake.api, getFlag: flags({ 'features.call-export': true }) });
  const first = await handlers['vscode/extensions/callExport']({ extensionId: 'pub.a', method: 'run', args: { n: 2 } });
  const second = await handlers['vscode/extensions/callExport']({ extensionId: 'pub.a', method: 'run', args: { n: 3 } });
  assert.deepStrictEqual(first, { called: true, approved: true, result: 4 });
  assert.deepStrictEqual(second, { called: true, approved: true, result: 6 });
  assert.strictEqual(asks, 1, 'session approval must skip the second modal');
  assert.deepStrictEqual(calls, [{ n: 2 }, { n: 3 }]);
});

test('extensions/callExport passes arrays as positional arguments', async () => {
  const fake = fakeVscode();
  fake.api.window.showWarningMessage = async () => 'Allow Once';
  const calls = [];
  fake.api.extensions.getExtension = () => ({
    isActive: true,
    exports: {
      add(a, b) {
        calls.push([a, b]);
        return a + b;
      },
    },
  });
  const handlers = createV3Handlers({ vscode: fake.api, getFlag: flags({ 'features.call-export': true }) });
  const result = await handlers['vscode/extensions/callExport']({ extensionId: 'pub.a', method: 'add', args: [2, 3] });
  assert.deepStrictEqual(result, { called: true, approved: true, result: 5 });
  assert.deepStrictEqual(calls, [[2, 3]]);
});

test('extensions/callExport maps missing extension/method/throw/timeout to bridge codes', async (t) => {
  const fake = fakeVscode();
  fake.api.window.showWarningMessage = async () => 'Allow Once';
  const handlers = createV3Handlers({ vscode: fake.api, getFlag: flags({ 'features.call-export': true }) });

  fake.api.extensions.getExtension = () => undefined;
  await assert.rejects(
    handlers['vscode/extensions/callExport']({ extensionId: 'pub.nope', method: 'run' }),
    (error) => error.bridgeCode === 'VSCODE_EXTENSION_NOT_FOUND',
  );

  fake.api.extensions.getExtension = () => ({ isActive: true, exports: { nope: 42 } });
  await assert.rejects(
    handlers['vscode/extensions/callExport']({ extensionId: 'pub.a', method: 'run' }),
    (error) => error.bridgeCode === 'VSCODE_CALL_EXPORT_METHOD_NOT_FOUND',
  );

  fake.api.extensions.getExtension = () => ({ isActive: true, exports: { run() { throw new Error('boom-original'); } } });
  await assert.rejects(
    handlers['vscode/extensions/callExport']({ extensionId: 'pub.a', method: 'run' }),
    (error) => error.bridgeCode === 'VSCODE_CALL_EXPORT_FAILED' && /boom-original/.test(error.message),
  );

  t.mock.timers.enable({ apis: ['setTimeout'] });
  fake.api.extensions.getExtension = () => ({ isActive: true, exports: { run() { return new Promise(() => {}); } } });
  const pending = handlers['vscode/extensions/callExport']({ extensionId: 'pub.a', method: 'run' });
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(CALL_EXPORT_TIMEOUT_MS);
  await assert.rejects(pending, (error) => error.bridgeCode === 'VSCODE_CALL_EXPORT_TIMEOUT');
});

test('extensions/callExport journals only summary metadata and skips when journal is null', async () => {
  const entries = [];
  const fake = fakeVscode();
  fake.api.window.showWarningMessage = async () => 'Allow Once';
  fake.api.extensions.getExtension = () => ({
    isActive: true,
    exports: {
      echo(v) {
        return v;
      },
      boom() {
        throw new Error('boom');
      },
    },
  });
  const handlers = createV3Handlers({
    vscode: fake.api,
    getFlag: flags({ 'features.call-export': true }),
    callExportJournal: { record(entry) { entries.push(entry); } },
  });

  const argValue = { secret: 'do-not-log', nested: [1, 2] };
  await handlers['vscode/extensions/callExport']({ extensionId: 'pub.a', method: 'echo', args: argValue });
  assert.strictEqual(entries.length, 1);
  const okEntry = entries[0];
  assert.strictEqual(okEntry.extensionId, 'pub.a');
  assert.strictEqual(okEntry.method, 'echo');
  assert.deepStrictEqual(okEntry.argsSummary, {
    type: 'object',
    keys: ['secret', 'nested'],
    bytes: Buffer.byteLength(JSON.stringify(argValue), 'utf8'),
  });
  assert.deepStrictEqual(okEntry.result, { ok: true });
  assert.ok(!('args' in okEntry), 'journal never stores the full args');
  assert.ok(!JSON.stringify(okEntry).includes('do-not-log'), 'journal content must not include arg values');

  await assert.rejects(
    handlers['vscode/extensions/callExport']({ extensionId: 'pub.a', method: 'boom' }),
    (error) => error.bridgeCode === 'VSCODE_CALL_EXPORT_FAILED',
  );
  assert.strictEqual(entries.length, 2);
  assert.deepStrictEqual(entries[1].result, { ok: false, errorCode: 'VSCODE_CALL_EXPORT_FAILED' });
  assert.deepStrictEqual(entries[1].argsSummary, { type: 'undefined', keys: [], bytes: 0 });

  const noJournal = createV3Handlers({
    vscode: fake.api,
    getFlag: flags({ 'features.call-export': true }),
    callExportJournal: null,
  });
  fake.api.extensions.getExtension = () => ({ isActive: true, exports: { echo: (v) => v } });
  const result = await noJournal['vscode/extensions/callExport']({ extensionId: 'pub.a', method: 'echo', args: { a: 1 } });
  assert.strictEqual(result.called, true);
});
