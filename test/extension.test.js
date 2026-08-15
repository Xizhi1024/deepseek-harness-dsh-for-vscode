'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { activateWithDependencies, deactivate } = require('../src/extension');
const { CONTAINER_ID, VIEW_ID } = require('../src/types');

function disposable() {
  return { dispose() {} };
}

function createFakeVscode(configOverrides = {}) {
  const commands = new Map();
  const registrations = {};
  const shownDocuments = [];
  const informationMessages = [];
  const errorMessages = [];
  const warningMessages = [];
  const configuration = {
    host: '127.0.0.1',
    port: 3080,
    autoStart: false,
    closePolicy: 'onVscodeExit',
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
    },
    window: {
      activeTextEditor: null,
      createQuickPick() {
        return {
          onDidAccept: null,
          onDidHide: null,
          selectedItems: [],
          items: [],
          canPickMany: false,
          placeholder: '',
          dispose() {},
          show() {},
        };
      },
      createStatusBarItem() {
        return { show() {}, text: '', tooltip: '' };
      },
      onDidChangeActiveTextEditor() { return disposable(); },
      registerWebviewViewProvider(id, provider, options) {
        registrations.webview = { id, provider, options };
        return disposable();
      },
      async showErrorMessage(message) {
        errorMessages.push(message);
      },
      async showInformationMessage(message) {
        informationMessages.push(message);
      },
      async showTextDocument(document, options) {
        shownDocuments.push({ document, options });
      },
      async showWarningMessage(message) {
        warningMessages.push(message);
      },
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
      async openTextDocument(uri) { return { uri }; },
    },
  };
  return { api, commands, registrations, shownDocuments, informationMessages, errorMessages, warningMessages };
}

function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) {
        return reject(new Error('waitFor condition was not met before timeout'));
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

test('activation registers the public host surface through injected dependencies', async () => {
  const fake = createFakeVscode();
  const context = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-extension-test-${process.pid}`) },
    subscriptions: [],
  };
  let bridgeOptions = null;
  let bridgeCloseCalls = 0;
  let versionedBridgeCloseCalls = 0;
  let versionedBridgeOptions = null;
  let managerOptions = null;
  let cancelCalls = 0;
  let ensureRuntimeCalls = 0;
  const manager = {
    cancelPending() { cancelCalls += 1; },
    hasOwnedChild() { return false; },
    async stop() {},
  };

  await activateWithDependencies(context, {
    vscode: fake.api,
    async startTextDocumentBridge(options) {
      bridgeOptions = options;
      return {
        env: { DSH_VSCODE_OPEN_TOKEN: 'test-only' }, // allow-secret-scan
        async close() { bridgeCloseCalls += 1; },
      };
    },
    async startVersionedBridge(options) {
      versionedBridgeOptions = options;
      return {
        env: { DSH_VSCODE_BRIDGE_TOKEN: 'versioned-test' }, // allow-secret-scan
        async close() { versionedBridgeCloseCalls += 1; },
      };
    },
    createServerManager(options) {
      managerOptions = options;
      return manager;
    },
    async ensureManagedRuntime() {
      ensureRuntimeCalls += 1;
      throw new Error('autoStart=false must not resolve the managed runtime');
    },
  });

  assert.deepStrictEqual([...fake.commands.keys()], [
    'dsh.openInBrowser',
    'dsh.restartServer',
    'dsh.stopServer',
    'dsh.addActiveFile',
    'dsh.addActiveSelection',
    'dsh.addProblems',
    'dsh.newSession',
    'dsh.switchSession',
    'dsh.focusSidebar',
    'dsh.capabilities',
    'dsh.diagnose',
  ]);
  assert.strictEqual(fake.registrations.webview.id, VIEW_ID);
  assert.deepStrictEqual(
    fake.registrations.webview.options,
    { webviewOptions: { retainContextWhenHidden: true } }
  );
  assert.strictEqual(typeof fake.registrations.webview.provider.resolveWebviewView, 'function');
  assert.strictEqual(typeof managerOptions.onStatus, 'function');
  assert.deepStrictEqual(managerOptions.spawnEnv, {
    DSH_VSCODE_OPEN_TOKEN: 'test-only', // allow-secret-scan
    DSH_VSCODE_BRIDGE_TOKEN: 'versioned-test', // allow-secret-scan
  });
  assert.ok(path.isAbsolute(managerOptions.embedPatchPath), 'embed overlay path must be absolute');
  assert.strictEqual(path.basename(managerOptions.embedPatchPath), 'vscode-embed.overlay.yml');
  assert.strictEqual(typeof versionedBridgeOptions.handlers['vscode/editor/getContext'], 'function');
  assert.strictEqual(typeof versionedBridgeOptions.handlers['vscode/editor/open'], 'function');
  assert.strictEqual(typeof versionedBridgeOptions.handlers['vscode/editor/openDiff'], 'function');
  assert.strictEqual(typeof versionedBridgeOptions.handlers['vscode/workspace/getDiagnostics'], 'function');
  assert.strictEqual(typeof versionedBridgeOptions.handlers['vscode/extensions/getProviderStates'], 'function');
  assert.strictEqual(typeof versionedBridgeOptions.handlers['vscode/extensions/openDetails'], 'function');
  assert.strictEqual(context.subscriptions.length, 18);
  assert.strictEqual(ensureRuntimeCalls, 0, 'autoStart=false must not resolve the managed runtime');

  fake.api.workspace.workspaceFolders = [
    { uri: { fsPath: 'D:\\workspace' }, name: 'workspace', index: 0 },
  ];

  await bridgeOptions.openTextDocument('D:\\workspace\\file.js');
  assert.deepStrictEqual(fake.shownDocuments, [{
    document: { uri: { fsPath: 'D:\\workspace\\file.js' } },
    options: { preview: false, preserveFocus: false },
  }]);

  await assert.rejects(
    bridgeOptions.openTextDocument('D:\\other\\secret.txt'),
    /outside the workspace/
  );
  assert.strictEqual(fake.shownDocuments.length, 1, 'outside-workspace path must not be opened');

  await fake.commands.get('dsh.focusSidebar')();
  assert.strictEqual(CONTAINER_ID, 'dsh-sidebar');

  await fake.commands.get('dsh.capabilities')();
  assert.ok(fake.informationMessages.some((message) => message.includes('Capabilities center')));

  await fake.commands.get('dsh.diagnose')();
  assert.ok(fake.informationMessages.some((message) => message.includes('DSH diagnose')));

  await deactivate();
  assert.strictEqual(cancelCalls, 1);
  assert.strictEqual(bridgeCloseCalls, 1);
  assert.strictEqual(versionedBridgeCloseCalls, 1);
});

test('crash after ready clears stale state and restart reconnects', async () => {
  const fake = createFakeVscode();
  const context = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-extension-test-crash-${process.pid}`) },
    subscriptions: [],
  };
  let statusCallback = null;
  let ensureServerCalls = 0;
  const manager = {
    setResolvedRuntime() {},
    ensureServer(options) {
      ensureServerCalls += 1;
      return Promise.resolve({
        url: `http://${options.host}:${options.port}`,
        host: options.host,
        port: options.port,
        pid: 4242,
        owned: true,
      });
    },
    hasOwnedChild() { return false; },
    cancelPending() {},
    async stop() {},
  };

  await activateWithDependencies(context, {
    vscode: fake.api,
    async startTextDocumentBridge() {
      return { env: {}, async close() {} };
    },
    async startVersionedBridge() {
      return { env: {}, async close() {} };
    },
    createServerManager(options) {
      statusCallback = options.onStatus;
      return manager;
    },
    async ensureManagedRuntime() {
      throw new Error('autoStart=false must not resolve the managed runtime');
    },
  });

  let viewHtml = '';
  const view = {
    webview: {
      options: null,
      onDidReceiveMessage() { return disposable(); },
      set html(value) { viewHtml = value; },
      get html() { return viewHtml; },
    },
    onDidDispose() { return disposable(); },
  };
  fake.registrations.webview.provider.resolveWebviewView(view);
  await waitFor(() => viewHtml.includes('iframe'));

  statusCallback({
    state: 'error',
    message: 'DSH process exited unexpectedly (pid=4242, code=1, signal=null)',
  });
  await waitFor(() => !viewHtml.includes('iframe') && viewHtml.includes('btn-retry'));

  assert.ok(viewHtml.includes('DeepSeek Harness unavailable'), 'error page should be rendered');
  assert.ok(viewHtml.includes('btn-retry'), 'error page should offer Retry');

  const before = ensureServerCalls;
  await fake.commands.get('dsh.restartServer')();
  assert.ok(ensureServerCalls > before, 'restart should re-ensure the server after a crash');
  assert.ok(
    !fake.informationMessages.some((message) => message.includes('reused')),
    'restart after crash must not report a reused server'
  );

  await deactivate();
});

test('autoStart resolves the managed runtime before spawn and hands it to ServerManager', async () => {
  const fake = createFakeVscode({ autoStart: true });
  const context = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-extension-test-autostart-${process.pid}`) },
    subscriptions: [],
  };
  const runtime = { executablePath: 'D:\\runtime\\dsh.exe' };
  let ensureRuntimeOptions = null;
  let ensureRuntimeCalls = 0;
  let setResolvedRuntimeArgs = [];
  let ensureServerCalls = 0;
  let ensureServerOptions = null;
  const manager = {
    setResolvedRuntime(value) { setResolvedRuntimeArgs.push(value); },
    ensureServer(options) {
      ensureServerCalls += 1;
      ensureServerOptions = options;
      return Promise.resolve({
        url: `http://${options.host}:${options.port}`,
        host: options.host,
        port: options.port,
        pid: 4242,
        owned: true,
      });
    },
    hasOwnedChild() { return false; },
    cancelPending() {},
    async stop() {},
  };

  await activateWithDependencies(context, {
    vscode: fake.api,
    async startTextDocumentBridge() {
      return { env: { DSH_VSCODE_OPEN_TOKEN: 'test-only' }, async close() {} }; // allow-secret-scan
    },
    async startVersionedBridge() {
      return { env: { DSH_VSCODE_BRIDGE_TOKEN: 'versioned-test' }, async close() {} }; // allow-secret-scan
    },
    createServerManager() { return manager; },
    async ensureManagedRuntime(options) {
      ensureRuntimeCalls += 1;
      ensureRuntimeOptions = options;
      return runtime;
    },
  });

  await waitFor(() => ensureServerCalls === 1);
  assert.strictEqual(ensureRuntimeCalls, 1);
  assert.deepStrictEqual(setResolvedRuntimeArgs, [runtime]);
  assert.deepStrictEqual(ensureServerOptions, {
    host: '127.0.0.1',
    port: 3080,
    autoStart: true,
    cwd: null,
    registryFile: path.join(context.globalStorageUri.fsPath, 'dsh-instances.json'),
  });
  assert.strictEqual(ensureRuntimeOptions.manifestUrl, '');
  assert.strictEqual(ensureRuntimeOptions.version, '');
  assert.strictEqual(ensureRuntimeOptions.platform, process.platform);
  assert.strictEqual(ensureRuntimeOptions.arch, process.arch);
  assert.strictEqual(
    ensureRuntimeOptions.storageRoot,
    path.join(context.globalStorageUri.fsPath, 'runtime')
  );

  await deactivate();
});

test('autoStart fails closed without spawning when managed runtime resolution fails', async () => {
  const fake = createFakeVscode({ autoStart: true });
  const context = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-extension-test-autostart-fail-${process.pid}`) },
    subscriptions: [],
  };
  let ensureRuntimeCalls = 0;
  let ensureServerCalls = 0;
  let statusBarText = '';
  fake.api.window.createStatusBarItem = () => {
    const item = { show() {}, text: '', tooltip: '' };
    Object.defineProperty(item, 'text', {
      get() { return statusBarText; },
      set(value) { statusBarText = value; },
    });
    return item;
  };
  const manager = {
    setResolvedRuntime() {},
    ensureServer() {
      ensureServerCalls += 1;
      return Promise.reject(new Error('spawn must not be reached'));
    },
    hasOwnedChild() { return false; },
    cancelPending() {},
    async stop() {},
  };

  await activateWithDependencies(context, {
    vscode: fake.api,
    async startTextDocumentBridge() {
      return { env: { DSH_VSCODE_OPEN_TOKEN: 'test-only' }, async close() {} }; // allow-secret-scan
    },
    async startVersionedBridge() {
      return { env: { DSH_VSCODE_BRIDGE_TOKEN: 'versioned-test' }, async close() {} }; // allow-secret-scan
    },
    createServerManager() { return manager; },
    async ensureManagedRuntime() {
      ensureRuntimeCalls += 1;
      throw new Error('runtime verification failed');
    },
  });

  await waitFor(() => ensureRuntimeCalls === 1);
  // Give the caught connectNow a tick to finish rendering the status page.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.strictEqual(ensureServerCalls, 0, 'failed runtime resolution must not spawn');
  assert.ok(statusBarText.includes('DSH: unavailable'), `status bar should show unavailable, got "${statusBarText}"`);

  await deactivate();
});
