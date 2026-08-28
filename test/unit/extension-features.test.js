'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { activateWithDependencies, deactivate, FEATURE_CATALOG } = require('../../src/extension');
const { VIEW_ID } = require('../../src/types');

function disposable() {
  return { dispose() {} };
}

function createFakeVscode(configOverrides = {}) {
  const commands = new Map();
  const registrations = {};
  const configuration = {
    host: '127.0.0.1',
    port: 3080,
    autoStart: false,
    closePolicy: 'onVscodeExit',
    'home.mode': 'isolated',
    ...configOverrides,
  };
  const api = {
    commands: {
      registerCommand(id, handler) {
        commands.set(id, handler);
        return disposable();
      },
      async executeCommand() {},
    },
    env: {
      language: 'en',
      async asExternalUri(uri) { return uri; },
      async openExternal() {},
    },
    extensions: {
      getExtension() { return undefined; },
      all: [],
      onDidChange() { return disposable(); },
    },
    languages: {
      getDiagnostics() { return []; },
    },
    l10n: {
      t(template, params = {}) {
        return String(template).replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? `{${key}}`));
      },
    },
    Range: class Range {
      constructor(startLine, startCharacter, endLine, endCharacter) {
        this.start = { line: startLine, character: startCharacter };
        this.end = { line: endLine, character: endCharacter };
      }
    },
    StatusBarAlignment: { Right: 2 },
    Uri: {
      file(fsPath) { return { fsPath }; },
      joinPath(base, child) { return { fsPath: path.join(base.fsPath, child) }; },
      parse(value) { return { value, toString: () => value }; },
      isUri(value) { return Boolean(value && typeof value === 'object' && typeof value.toString === 'function' && typeof value.scheme === 'string'); },
    },
    window: {
      activeTextEditor: null,
      createQuickPick() {
        return {
          items: [],
          selectedItems: [],
          canPickMany: false,
          placeholder: '',
          onDidAccept() {},
          onDidHide() {},
          show() {},
          dispose() {},
        };
      },
      createStatusBarItem() {
        return { show() {}, text: '', tooltip: '' };
      },
      onDidChangeActiveTextEditor() { return disposable(); },
      onDidChangeTextEditorSelection() { return disposable(); },
      registerWebviewViewProvider(id, provider, options) {
        registrations.webview = { id, provider, options };
        return disposable();
      },
      async showTextDocument() {},
      async showErrorMessage() {},
      async showInformationMessage() {},
      async showWarningMessage() {},
    },
    workspace: {
      workspaceFolders: [],
      isTrusted: true,
      getConfiguration() {
        return { get: (key, fallback) => configuration[key] ?? fallback };
      },
      getWorkspaceFolder() { return undefined; },
      onDidChangeConfiguration() { return disposable(); },
      onDidChangeWorkspaceFolders() { return disposable(); },
      async openTextDocument() { return {}; },
    },
  };
  return { api, commands, registrations };
}

const managerStub = () => ({
  cancelPending() {},
  hasOwnedChild() { return false; },
  async stop() {},
});

test('dsh.features.statusbar-basic=false skips status bar creation while the rest still wires', async () => {
  const fake = createFakeVscode({ 'features.statusbar-basic': false });
  let statusBarCalls = 0;
  fake.api.window.createStatusBarItem = () => {
    statusBarCalls += 1;
    return { show() {}, text: '', tooltip: '' };
  };
  const context = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-ext-features-off-${process.pid}`) },
    subscriptions: [],
  };

  await activateWithDependencies(context, {
    vscode: fake.api,
    async startTextDocumentBridge() { return { env: {}, async close() {} }; },
    async startVersionedBridge() { return { env: {}, async close() {} }; },
    createServerManager() { return managerStub(); },
    async ensureManagedRuntime() { throw new Error('autoStart=false must not resolve the managed runtime'); },
  });

  assert.strictEqual(statusBarCalls, 0, 'no status bar item may be created while the feature is off');
  assert.strictEqual(fake.registrations.webview.id, VIEW_ID, 'core-sidebar provider must still register');
  for (const command of [
    'dsh.openInBrowser',
    'dsh.restartServer',
    'dsh.stopServer',
    'dsh.addFileToThread',
    'dsh.diagnose',
  ]) {
    assert.ok(fake.commands.has(command), command + ' must still be registered');
  }

  await deactivate();
});

test('default config creates the status bar item exactly once at activation', async () => {
  const fake = createFakeVscode();
  let statusBarCalls = 0;
  fake.api.window.createStatusBarItem = () => {
    statusBarCalls += 1;
    return { show() {}, text: '', tooltip: '' };
  };
  const context = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-ext-features-on-${process.pid}`) },
    subscriptions: [],
  };

  await activateWithDependencies(context, {
    vscode: fake.api,
    async startTextDocumentBridge() { return { env: {}, async close() {} }; },
    async startVersionedBridge() { return { env: {}, async close() {} }; },
    createServerManager() { return managerStub(); },
    async ensureManagedRuntime() { throw new Error('autoStart=false must not resolve the managed runtime'); },
  });

  assert.strictEqual(statusBarCalls, 1, 'the default-on indicator feature creates the item once');

  await deactivate();
});

test('A1/U1: the status bar indicator is a clickable sidebar toggle', async () => {
  const fake = createFakeVscode();
  const items = [];
  fake.api.window.createStatusBarItem = () => {
    const item = { show() {}, text: '', tooltip: '', command: undefined };
    items.push(item);
    return item;
  };
  const context = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-a1-statusbar-${process.pid}`) },
    subscriptions: [],
  };

  await activateWithDependencies(context, {
    vscode: fake.api,
    async startTextDocumentBridge() { return { env: {}, async close() {} }; },
    async startVersionedBridge() { return { env: {}, async close() {} }; },
    createServerManager() { return managerStub(); },
    async ensureManagedRuntime() { throw new Error('autoStart=false must not resolve the managed runtime'); },
  });

  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].command, 'dsh.focusSidebar', 'clicking the indicator toggles the DSH sidebar');

  await deactivate();
});

test('A2/U2: injection-class setting changes prompt "Restart now?" and restart on confirm', async () => {
  const fake = createFakeVscode();
  let configHandler = null;
  fake.api.workspace.onDidChangeConfiguration = (handler) => {
    configHandler = handler;
    return disposable();
  };
  const prompts = [];
  fake.api.window.showInformationMessage = async (message, ...choices) => {
    prompts.push({ message, choices });
    return choices[0];
  };
  const executed = [];
  fake.api.commands.executeCommand = async (id) => { executed.push(id); };
  const context = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-a2-restart-prompt-${process.pid}`) },
    subscriptions: [],
  };

  await activateWithDependencies(context, {
    vscode: fake.api,
    async startTextDocumentBridge() { return { env: {}, async close() {} }; },
    async startVersionedBridge() { return { env: {}, async close() {} }; },
    createServerManager() { return managerStub(); },
    async ensureManagedRuntime() { throw new Error('autoStart=false must not resolve the managed runtime'); },
  });
  assert.ok(configHandler, 'the configuration-change handler must be registered');

  // A burst of injection-class changes coalesces into ONE prompt.
  configHandler({ affectsConfiguration: (key) => key === 'dsh.fim.baseUrl' });
  configHandler({ affectsConfiguration: (key) => key === 'dsh.fim.model' });
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.strictEqual(prompts.length, 1, 'burst changes coalesce into one restart prompt');
  assert.match(prompts[0].message, /Restart now\?/);
  assert.ok(prompts[0].choices.includes('Restart now'));
  assert.ok(executed.includes('dsh.restartServer'), 'confirming restarts the DSH service');

  // Unrelated keys never prompt.
  prompts.length = 0;
  executed.length = 0;
  configHandler({ affectsConfiguration: () => false });
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.strictEqual(prompts.length, 0, 'unrelated settings changes do not prompt');

  await deactivate();
});

test('A4/U5: successful new/switch session commands reveal the sidebar', async (t) => {
  const http = require('node:http');
  const sessions = [{ sessionId: 'sess-a', updatedAt: 1 }];
  const apiServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/session.list') {
        res.end(JSON.stringify({ result: { ok: true, value: { items: sessions } } }));
      } else if (req.url === '/api/session.create') {
        res.end(JSON.stringify({ result: { ok: true, value: { sessionId: 'sess-new' } } }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
  });
  await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  t.after(() => apiServer.close());
  const port = apiServer.address().port;

  const fake = createFakeVscode({ port });
  const executed = [];
  fake.api.commands.executeCommand = async (id) => { executed.push(id); };
  fake.api.window.showInformationMessage = async () => {};
  // Interactive session QuickPick: auto-accept the first row.
  fake.api.window.createQuickPick = () => {
    const picker = {
      items: [],
      selectedItems: [],
      canPickMany: false,
      placeholder: '',
      onDidAccept(fn) { picker._accept = fn; },
      onDidHide(fn) { picker._hide = fn; },
      show() {
        picker.selectedItems = picker.items.slice(0, 1);
        setImmediate(() => picker._accept());
      },
      dispose() {},
    };
    return picker;
  };
  const handle = { url: `http://127.0.0.1:${port}`, host: '127.0.0.1', port, pid: 4242, owned: false };
  const context = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-a4-session-reveal-${process.pid}`) },
    subscriptions: [],
  };

  await activateWithDependencies(context, {
    vscode: fake.api,
    async startTextDocumentBridge() { return { env: {}, async close() {} }; },
    async startVersionedBridge() { return { env: {}, async close() {} }; },
    createServerManager() {
      return { ...managerStub(), async ensureServer() { return handle; } };
    },
    async ensureManagedRuntime() { throw new Error('autoStart=false must not resolve the managed runtime'); },
  });

  await fake.commands.get('dsh.newSession')();
  assert.ok(executed.includes('dsh.focusSidebar'), 'newSession reveals the sidebar on success');

  executed.length = 0;
  await fake.commands.get('dsh.switchSession')();
  assert.ok(executed.includes('dsh.focusSidebar'), 'switchSession reveals the sidebar on success');

  await deactivate();
});

test('FEATURE_CATALOG carries the frozen R25 layers', () => {
  const layers = Object.fromEntries(FEATURE_CATALOG.map((entry) => [entry.id, entry.layer]));
  assert.deepStrictEqual(layers, {
    'core-server': 'L0',
    'core-sidebar': 'L0',
    'clipboard-bridge': 'L1',
    'thread-attachment': 'L1',
    'editor-links': 'L1',
    'statusbar-basic': 'L1',
    'theme-follow': 'L1',
    'changes-review': 'L2',
    'ctrl-k': 'L2',
    'lm-route': 'L2',
    'mcp-consume': 'L2',
    'call-export': 'L2',
    'ctrl-i': 'L2',
    'exports': 'L2',
    'chat-participant': 'L2',
    'tab-completion': 'L2',
  });
});
