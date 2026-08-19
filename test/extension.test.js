'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { activateWithDependencies, deactivate, isRetryableStartupError } = require('../src/extension');
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
    realpath: async (value) => value,
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
    'dsh.addSelectionToThread',
    'dsh.addFileToThread',
    'dsh.addProblems',
    'dsh.newSession',
    'dsh.switchSession',
    'dsh.focusSidebar',
    'dsh.capabilities',
    'dsh.diagnose',
    'dsh.cleanupOrphans',
    'dsh.restartClean',
    'dsh.onboarding',
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
  // B-batch merge resolution: theme-follow listener + dsh.restartClean each add one.
  assert.strictEqual(context.subscriptions.length, 24);
  assert.strictEqual(ensureRuntimeCalls, 0, 'autoStart=false must not resolve the managed runtime');

  fake.api.workspace.workspaceFolders = [
    { uri: { fsPath: 'D:\\workspace' }, name: 'workspace', index: 0 },
  ];

  await bridgeOptions.openTextDocument('D:\\workspace\\file.js');
  assert.deepStrictEqual(fake.shownDocuments, [{
    document: { uri: { fsPath: 'D:\\workspace\\file.js' } },
    options: { preview: false, preserveFocus: false },
  }]);

  await bridgeOptions.openTextDocument('D:\\other\\shared-session.txt');
  assert.strictEqual(fake.shownDocuments.length, 2, 'shared-session paths outside the current workspace must open');

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

test('autoStart resolves the configured runtime before spawn and hands it to ServerManager', async () => {
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
  assert.deepStrictEqual(setResolvedRuntimeArgs, [{
    ...runtime,
    dshHome: path.join(context.globalStorageUri.fsPath, '.dsh'),
    profileHome: path.join(context.globalStorageUri.fsPath, '.dsh', 'profiles', 'web'),
    profileName: 'web',
  }]);
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
    ensureRuntimeOptions.dshHome,
    path.join(context.globalStorageUri.fsPath, '.dsh')
  );
  assert.strictEqual(ensureRuntimeOptions.packageRoot, '');
  assert.strictEqual(ensureRuntimeOptions.nodePath, '');
  assert.strictEqual(
    ensureRuntimeOptions.storageRoot,
    path.join(context.globalStorageUri.fsPath, 'runtime')
  );
  assert.ok(ensureRuntimeOptions.signal, 'runtime provisioning must receive an abort signal');
  assert.strictEqual(ensureRuntimeOptions.signal.aborted, false, 'signal starts un-aborted');

  await deactivate();
  assert.strictEqual(ensureRuntimeOptions.signal.aborted, true, 'deactivate must abort in-flight provisioning');
});

test('owned autoStart instance binds through workspaceBinding and iframe carries dsh_session', async () => {
  const fake = createFakeVscode({ autoStart: true });
  fake.api.workspace.workspaceFolders = [
    { uri: { fsPath: 'D:\\workspace' }, name: 'workspace', index: 0 },
  ];
  const context = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-extension-test-autobind-${process.pid}`) },
    subscriptions: [],
  };
  const bindingCalls = [];
  const fakeBinding = {
    async resolve(server, cwd) {
      bindingCalls.push({ server, cwd });
      return 'sid-1';
    },
    async refresh() { return 'sid-1'; },
    dispose() {},
    state() {
      return {
        state: 'bound',
        cwd: 'D:\\workspace',
        workspaceId: 'w-1',
        sessionId: 'sid-1',
        owned: true,
        error: null,
        at: 0,
      };
    },
  };
  const manager = {
    setResolvedRuntime() {},
    ensureServer(options) {
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
    createServerManager() { return manager; },
    createWorkspaceBinding() { return fakeBinding; },
    async ensureManagedRuntime() { return {}; },
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
  await waitFor(() => viewHtml.includes('dsh_session=sid-1'));

  assert.ok(bindingCalls.length >= 1, 'owned autoStart must attempt workspace binding');
  assert.strictEqual(bindingCalls[0].cwd, 'D:\\workspace');
  assert.strictEqual(bindingCalls[0].server.url, 'http://127.0.0.1:3080', 'binding must use the raw loopback URL');
  assert.strictEqual(bindingCalls[0].server.owned, true);
  assert.ok(viewHtml.includes('iframe'), 'owned connect should render the DSH iframe');

  await deactivate();
});

test('reused external instance binds through workspaceBinding and iframe carries dsh_session', async () => {
  const fake = createFakeVscode();
  fake.api.workspace.workspaceFolders = [
    { uri: { fsPath: 'D:\\workspace' }, name: 'workspace', index: 0 },
  ];
  const context = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-extension-test-reusedbind-${process.pid}`) },
    subscriptions: [],
  };
  const bindingCalls = [];
  const fakeBinding = {
    async resolve(server, cwd) {
      bindingCalls.push({ server, cwd });
      return 'sid-1';
    },
    async refresh() { return 'sid-1'; },
    dispose() {},
    state() {
      return {
        state: 'bound',
        cwd: 'D:\\workspace',
        workspaceId: 'w-1',
        sessionId: 'sid-1',
        owned: false,
        error: null,
        at: 0,
      };
    },
  };
  const manager = {
    cancelPending() {},
    hasOwnedChild() { return false; },
    async stop() {},
    ensureServer(options) {
      return Promise.resolve({
        url: `http://${options.host}:${options.port}`,
        host: options.host,
        port: options.port,
        pid: null,
        owned: false,
      });
    },
  };

  await activateWithDependencies(context, {
    vscode: fake.api,
    async startTextDocumentBridge() {
      return { env: {}, async close() {} };
    },
    async startVersionedBridge() {
      return { env: {}, async close() {} };
    },
    createServerManager() { return manager; },
    createWorkspaceBinding() { return fakeBinding; },
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
  await waitFor(() => viewHtml.includes('dsh_session=sid-1'));

  assert.ok(bindingCalls.length >= 1, 'reused instances must bind through the workspace registry');
  assert.strictEqual(bindingCalls[0].cwd, 'D:\\workspace');
  assert.strictEqual(bindingCalls[0].server.owned, false);
  assert.ok(viewHtml.includes('iframe'), 'reused connect should render the DSH iframe');

  await deactivate();
});

test('workspace rebind resolves through binding without stopping the owned child', async () => {
  const fake = createFakeVscode({ autoStart: true });
  fake.api.workspace.workspaceFolders = [
    { uri: { fsPath: 'D:\\a' }, name: 'a', index: 0 },
  ];
  let workspaceFoldersCb = null;
  fake.api.workspace.onDidChangeWorkspaceFolders = (cb) => {
    workspaceFoldersCb = cb;
    return disposable();
  };
  const context = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-extension-test-rebind-${process.pid}`) },
    subscriptions: [],
  };
  const bindingCalls = [];
  const fakeBinding = {
    async resolve(server, cwd) {
      bindingCalls.push({ server, cwd });
      return cwd === 'D:\\b' ? 'sid-b' : 'sid-a';
    },
    async refresh() { return 'sid-a'; },
    dispose() {},
    state() {
      return {
        state: 'bound',
        cwd: bindingCalls.length ? bindingCalls[bindingCalls.length - 1].cwd : 'D:\\a',
        workspaceId: 'w-1',
        sessionId: bindingCalls.length ? (bindingCalls[bindingCalls.length - 1].cwd === 'D:\\b' ? 'sid-b' : 'sid-a') : 'sid-a',
        owned: true,
        error: null,
        at: 0,
      };
    },
  };
  let ensureServerCalls = 0;
  let stopCalls = 0;
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
    hasOwnedChild() { return true; },
    cancelPending() {},
    async stop() { stopCalls += 1; },
  };

  await activateWithDependencies(context, {
    vscode: fake.api,
    async startTextDocumentBridge() {
      return { env: {}, async close() {} };
    },
    async startVersionedBridge() {
      return { env: {}, async close() {} };
    },
    createServerManager() { return manager; },
    createWorkspaceBinding() { return fakeBinding; },
    async ensureManagedRuntime() { return {}; },
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
  await waitFor(() => viewHtml.includes('dsh_session=sid-a'));
  const ensureServerCallsBeforeRebind = ensureServerCalls;

  fake.api.workspace.workspaceFolders = [
    { uri: { fsPath: 'D:\\b' }, name: 'b', index: 0 },
  ];
  workspaceFoldersCb();
  await waitFor(() => viewHtml.includes('dsh_session=sid-b'));

  assert.ok(bindingCalls.some((call) => call.cwd === 'D:\\b'), 'rebind must resolve the new cwd');
  const rebindCall = bindingCalls[bindingCalls.length - 1];
  assert.strictEqual(rebindCall.cwd, 'D:\\b');
  assert.strictEqual(rebindCall.server.pid, 4242, 'rebind must reuse the same child pid');
  assert.strictEqual(stopCalls, 0, 'workspace switch must not stop the owned child');
  assert.strictEqual(ensureServerCalls, ensureServerCallsBeforeRebind, 'workspace switch must not re-ensure/reconnect');

  await deactivate();
});

test('binding API failure renders error status page and does not keep the old iframe session', async () => {
  const fake = createFakeVscode({ autoStart: true });
  fake.api.workspace.workspaceFolders = [
    { uri: { fsPath: 'D:\\a' }, name: 'a', index: 0 },
  ];
  let workspaceFoldersCb = null;
  fake.api.workspace.onDidChangeWorkspaceFolders = (cb) => {
    workspaceFoldersCb = cb;
    return disposable();
  };
  const context = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-extension-test-rebind-error-${process.pid}`) },
    subscriptions: [],
  };
  const bindingCalls = [];
  let bindingState = {
    state: 'bound',
    cwd: 'D:\\a',
    workspaceId: 'w-1',
    sessionId: 'sid-a',
    owned: true,
    error: null,
    at: 0,
  };
  const fakeBinding = {
    async resolve(server, cwd) {
      bindingCalls.push({ server, cwd });
      if (cwd === 'D:\\b') {
        bindingState = {
          state: 'error',
          cwd: 'D:\\b',
          workspaceId: null,
          sessionId: null,
          owned: true,
          error: 'workspace API boom',
          at: 0,
        };
        return null;
      }
      return 'sid-a';
    },
    async refresh() { return 'sid-a'; },
    dispose() {},
    state() { return bindingState; },
  };
  let stopCalls = 0;
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
    hasOwnedChild() { return true; },
    cancelPending() {},
    async stop() { stopCalls += 1; },
  };

  await activateWithDependencies(context, {
    vscode: fake.api,
    async startTextDocumentBridge() {
      return { env: {}, async close() {} };
    },
    async startVersionedBridge() {
      return { env: {}, async close() {} };
    },
    createServerManager() { return manager; },
    createWorkspaceBinding() { return fakeBinding; },
    async ensureManagedRuntime() { return {}; },
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
  await waitFor(() => viewHtml.includes('dsh_session=sid-a'));
  const ensureServerCallsBeforeRebind = ensureServerCalls;

  fake.api.workspace.workspaceFolders = [
    { uri: { fsPath: 'D:\\b' }, name: 'b', index: 0 },
  ];
  workspaceFoldersCb();
  await waitFor(() => viewHtml.includes('DSH workspace binding failed'));

  assert.ok(!viewHtml.includes('dsh_session=sid-a'), 'old iframe session must not remain after binding failure');
  assert.ok(!viewHtml.includes('iframe'), 'error status page must not render the old DSH iframe');
  assert.strictEqual(stopCalls, 0, 'binding failure must not stop the owned child');
  assert.ok(bindingCalls.some((call) => call.cwd === 'D:\\b'), 'rebind must attempt the new cwd');
  assert.strictEqual(bindingCalls[bindingCalls.length - 1].cwd, 'D:\\b');
  assert.strictEqual(ensureServerCalls, ensureServerCallsBeforeRebind, 'binding failure must not re-ensure/reconnect');

  await deactivate();
});

test('autoStart fails closed without spawning when runtime resolution fails', async () => {
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

test('autoStart adopts a running DSH instance when managed runtime is unavailable', async () => {
  const fake = createFakeVscode({ autoStart: true });
  const context = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-extension-test-autostart-adopt-${process.pid}`) },
    subscriptions: [],
  };
  let ensureRuntimeCalls = 0;
  let adoptCalls = 0;
  let ensureServerCalls = 0;
  let setResolvedRuntimeArgs = [];
  const manager = {
    setResolvedRuntime(value) { setResolvedRuntimeArgs.push(value); },
    async adoptRunningDsh(host, port) {
      adoptCalls += 1;
      return {
        url: `http://${host}:${port}`,
        host,
        port,
        pid: null,
        owned: false,
      };
    },
    ensureServer() {
      ensureServerCalls += 1;
      throw new Error('ensureServer must not be reached after adoption');
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
    createServerManager() { return manager; },
    async ensureManagedRuntime() {
      ensureRuntimeCalls += 1;
      throw new Error('managed runtime unavailable');
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

  assert.ok(ensureRuntimeCalls >= 1, 'managed runtime resolution must be attempted');
  assert.ok(adoptCalls >= 1, 'the configured endpoint must be probed at least once');
  assert.strictEqual(ensureServerCalls, 0, 'an adopted server must not re-enter ensureServer');
  assert.ok(setResolvedRuntimeArgs.length >= 1, 'adoption must clear managed runtime state');
  assert.ok(setResolvedRuntimeArgs.every((value) => value === null), 'adoption must never leave a managed runtime active');
  assert.ok(viewHtml.includes('http://127.0.0.1:3080'), 'iframe must point at the adopted endpoint');
  assert.ok(!viewHtml.includes('dsh_session='), 'adopted external instances must never be auto-bound');

  await deactivate();
});

test('failed-connect status page can open the configured endpoint in browser', async () => {
  const fake = createFakeVscode({ autoStart: true });
  const openExternalCalls = [];
  fake.api.env.openExternal = async (uri) => {
    openExternalCalls.push(uri.toString());
  };
  const context = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-extension-test-status-open-${process.pid}`) },
    subscriptions: [],
  };
  const manager = {
    setResolvedRuntime() {},
    async adoptRunningDsh() { return null; },
    ensureServer() {
      return Promise.reject(new Error('no dsh service'));
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
    createServerManager() { return manager; },
    async ensureManagedRuntime() {
      throw new Error('managed runtime unavailable');
    },
  });

  let viewHtml = '';
  let messageHandler = null;
  const view = {
    webview: {
      options: null,
      onDidReceiveMessage(handler) {
        messageHandler = handler;
        return disposable();
      },
      set html(value) { viewHtml = value; },
      get html() { return viewHtml; },
    },
    onDidDispose() { return disposable(); },
  };
  fake.registrations.webview.provider.resolveWebviewView(view);
  await waitFor(() => viewHtml.includes('DeepSeek Harness unavailable') && viewHtml.includes('btn-open-browser'));

  assert.strictEqual(typeof messageHandler, 'function', 'status page message handler must be registered');
  messageHandler({ type: 'openBrowser' });
  await waitFor(() => openExternalCalls.length === 1);
  assert.strictEqual(openExternalCalls[0], 'http://127.0.0.1:3080', 'status page must open the configured endpoint');

  await deactivate();
});

test('openInBrowser does not open a fallback URL when connect fails', async () => {
  const fake = createFakeVscode();
  let openExternalCalls = 0;
  fake.api.env.openExternal = async () => {
    openExternalCalls += 1;
  };
  const context = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-extension-test-openbrowser-${process.pid}`) },
    subscriptions: [],
  };
  const manager = {
    setResolvedRuntime() {},
    ensureServer() {
      return Promise.reject(new Error('no dsh service'));
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
    createServerManager() {
      return manager;
    },
    async ensureManagedRuntime() {
      throw new Error('autoStart=false must not resolve the managed runtime');
    },
  });

  await fake.commands.get('dsh.openInBrowser')();
  assert.strictEqual(openExternalCalls, 0, 'must not open a fallback URL after a failed connect');
  assert.ok(
    fake.errorMessages.some((message) => message.includes('DSH: unavailable')),
    'must surface the unavailable state as an error message'
  );

  await deactivate();
});

test('text-document bridge opens authenticated absolute paths from shared sessions', async () => {
  const fake = createFakeVscode();
  fake.api.workspace.workspaceFolders = [
    { uri: { fsPath: 'D:\\workspace' }, name: 'workspace', index: 0 },
  ];
  let openExternalCalls = 0;
  fake.api.env.openExternal = async () => { openExternalCalls += 1; };
  const context = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-extension-test-symlink-${process.pid}`) },
    subscriptions: [],
  };
  let bridgeOptions = null;
  const manager = {
    cancelPending() {},
    hasOwnedChild() { return false; },
    async stop() {},
  };

  await activateWithDependencies(context, {
    vscode: fake.api,
    async startTextDocumentBridge(options) {
      bridgeOptions = options;
      return { env: {}, async close() {} };
    },
    async startVersionedBridge() {
      return { env: {}, async close() {} };
    },
    createServerManager() { return manager; },
    async ensureManagedRuntime() {
      throw new Error('autoStart=false must not resolve the managed runtime');
    },
  });

  await bridgeOptions.openTextDocument('D:\\other\\shared-session.txt');
  assert.strictEqual(fake.shownDocuments.length, 1, 'shared-session file must open in the owning VS Code window');

  await assert.rejects(bridgeOptions.openTextDocument('relative.txt'), /absolute path/);
  assert.strictEqual(fake.shownDocuments.length, 1, 'relative paths must remain rejected');

  await deactivate();
});

test('webview openBrowser message is ignored when no server is connected', async () => {
  const fake = createFakeVscode();
  let openExternalCalls = 0;
  fake.api.env.openExternal = async () => { openExternalCalls += 1; };
  const context = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-extension-test-openmsg-${process.pid}`) },
    subscriptions: [],
  };
  const manager = {
    cancelPending() {},
    hasOwnedChild() { return false; },
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
    createServerManager() { return manager; },
    async ensureManagedRuntime() {
      throw new Error('autoStart=false must not resolve the managed runtime');
    },
  });

  let messageHandler = null;
  const view = {
    webview: {
      options: null,
      onDidReceiveMessage(handler) { messageHandler = handler; return disposable(); },
      set html(_value) {},
      get html() { return ''; },
    },
    onDidDispose() { return disposable(); },
  };
  fake.registrations.webview.provider.resolveWebviewView(view);

  messageHandler({ type: 'openBrowser' });
  assert.strictEqual(openExternalCalls, 0, 'openBrowser message without a server must be ignored');

  await deactivate();
});

test('error status without a message still clears stale state and shows Retry', async () => {
  const fake = createFakeVscode();
  const context = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-extension-test-errnomessage-${process.pid}`) },
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

  statusCallback({ state: 'error' });
  await waitFor(() => !viewHtml.includes('iframe') && viewHtml.includes('btn-retry'));

  assert.ok(viewHtml.includes('DeepSeek Harness unavailable'), 'error page should be rendered without a message');
  assert.ok(viewHtml.includes('btn-retry'), 'error page should offer Retry');

  const before = ensureServerCalls;
  await fake.commands.get('dsh.restartServer')();
  assert.ok(ensureServerCalls > before, 'restart should re-ensure the server after a message-less error');

  await deactivate();
});

test('connect error page hides Retry for non-retryable startup classes', async () => {
  assert.strictEqual(isRetryableStartupError({ code: 'AUTOSTART_DISABLED' }), false);
  assert.strictEqual(isRetryableStartupError({ code: 'CONFIG_HOST_UNSUPPORTED' }), false);
  assert.strictEqual(isRetryableStartupError({ code: 'CONFIG_PORT_INVALID' }), false);
  assert.strictEqual(isRetryableStartupError({ code: 'CONFIG_PACKAGE_ROOT_INVALID' }), false);
  assert.strictEqual(isRetryableStartupError({ code: 'CONFIG_NODE_PATH_INVALID' }), false);
  assert.strictEqual(isRetryableStartupError({ code: 'CONFIG_HOME_PATH_INVALID' }), false);
  assert.strictEqual(isRetryableStartupError(new Error('download failed')), true);
  assert.strictEqual(isRetryableStartupError(undefined), true);
});

test('connect failure with autoStart disabled renders no Retry button', async () => {
  const fake = createFakeVscode({ autoStart: false });
  const context = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-extension-test-retry-gate-${process.pid}`) },
    subscriptions: [],
  };
  const configError = new Error('DSH is not running and dsh.autoStart is disabled');
  configError.code = 'AUTOSTART_DISABLED';
  configError.template = 'DSH is not running and dsh.autoStart is disabled';
  configError.params = {};
  const manager = {
    setResolvedRuntime() {},
    async ensureServer() {
      throw configError;
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
    createServerManager() { return manager; },
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
  await waitFor(() => viewHtml.includes('DeepSeek Harness unavailable') && viewHtml.includes('btn-open-browser'));

  assert.ok(!viewHtml.includes('id="btn-retry"'), 'config-only failures must not offer a bare Retry');
  assert.ok(viewHtml.includes('autoStart is disabled'), 'the rendered detail names the failure class');

  await deactivate();
});
