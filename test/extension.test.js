'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { activate, activateWithDependencies, deactivate, isRetryableStartupError, FEATURE_CATALOG, callExportJournal, readMcpSources } = require('../src/extension');
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
  const outputChannels = new Map();
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
      registerInlineCompletionItemProvider(selector, provider) {
        registrations.inlineCompletion = { selector, provider };
        return disposable();
      },
    },
    chat: {
      createChatParticipant(id, handler) {
        registrations.chatParticipant = { id, handler, followupProvider: null };
        return registrations.chatParticipant;
      },
    },
    lm: {
      registerLanguageModelChatProvider(vendor, provider) {
        registrations.lmProvider = { vendor, provider };
        return disposable();
      },
    },
    LanguageModelError: class LanguageModelError extends Error {
      static NoPermissions(message) { const error = new LanguageModelError(message); error.code = 'NoPermissions'; return error; }
      static Blocked(message) { const error = new LanguageModelError(message); error.code = 'Blocked'; return error; }
      static NotFound(message) { const error = new LanguageModelError(message); error.code = 'NotFound'; return error; }
    },
    LanguageModelTextPart: class LanguageModelTextPart {
      constructor(text) { this.text = text; }
    },
    l10n: {
      t(template, params = {}) {
        return String(template).replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? `{${key}}`));
      },
    },
    Position: class Position {
      constructor(line, character) {
        this.line = line;
        this.character = character;
      }
    },
    Range: class Range {
      constructor(startLine, startCharacter, endLine, endCharacter) {
        this.start = { line: startLine, character: startCharacter };
        this.end = { line: endLine, character: endCharacter };
      }
    },
    WorkspaceEdit: class WorkspaceEdit {
      insert() {}
      replace() {}
      delete() {}
      createFile() {}
      deleteFile() {}
    },
    TreeItem: class TreeItem {
      constructor(label, collapsibleState) {
        this.label = label;
        this.collapsibleState = collapsibleState;
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
      createOutputChannel(name) {
        const lines = [];
        const channel = {
          name,
          lines,
          appendLine(text) {
            lines.push(text);
          },
          show() {},
          dispose() {},
        };
        outputChannels.set(name, channel);
        return channel;
      },
      createStatusBarItem() {
        return { show() {}, text: '', tooltip: '' };
      },
      onDidChangeActiveTextEditor() { return disposable(); },
      registerTreeDataProvider(id, provider) {
        registrations.tree = { id, provider };
        return disposable();
      },
      createTreeView(id, options) {
        registrations.treeView = { id, options };
        return { reveal() {}, dispose() {} };
      },
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
      async showInputBox() {
        return undefined;
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
      async findFiles() { return []; },
      getConfiguration() {
        return { get: (key, fallback) => configuration[key] ?? fallback };
      },
      getWorkspaceFolder() { return undefined; },
      onDidChangeConfiguration() { return disposable(); },
      onDidChangeWorkspaceFolders() { return disposable(); },
      async openTextDocument(uri) { return { uri }; },
      async applyEdit() { return true; },
    },
  };
  return { api, commands, registrations, shownDocuments, informationMessages, errorMessages, warningMessages, outputChannels };
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
  const fake = createFakeVscode({ 'features.changes-review': false, 'features.chat-participant': false });
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
    'dsh.addFolderToThread',
    'dsh.addProblems',
    'dsh.newSession',
    'dsh.switchSession',
    'dsh.focusSidebar',
    'dsh.capabilities',
    'dsh.diagnose',
    'dsh.cleanupOrphans',
    'dsh.restartClean',
    'dsh.onboarding',
    'dsh.newInstance',
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
  // Cumulative merge resolution: theme-follow listener + dsh.restartClean (B)
  // + dsh.addFolderToThread registration (C3) + DSH OutputChannel (C1) each add one,
  // + the L0 fallback dsh.changes tree provider (0.9.4 view-data guard).
  assert.strictEqual(context.subscriptions.length, 27);
  assert.strictEqual(ensureRuntimeCalls, 0, 'autoStart=false must not resolve the managed runtime');

  // Windows drive paths are not absolute on POSIX; build platform-neutral
  // absolute paths so the bridge gate (path.isAbsolute) is exercised the
  // same way on every development platform.
  const workspaceRoot = path.join(os.tmpdir(), 'dsh-extension-test-ws-' + process.pid);
  const workspaceFile = path.join(workspaceRoot, 'file.js');
  fake.api.workspace.workspaceFolders = [
    { uri: { fsPath: workspaceRoot }, name: 'workspace', index: 0 },
  ];

  await bridgeOptions.openTextDocument(workspaceFile);
  assert.deepStrictEqual(fake.shownDocuments, [{
    document: { uri: { fsPath: workspaceFile } },
    options: { preview: false, preserveFocus: false },
  }]);

  await bridgeOptions.openTextDocument(path.join(os.tmpdir(), 'dsh-shared-session-' + process.pid + '.txt'));
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
    async discoverDshWebPorts() { return []; }, // no real process scan in tests
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

  await bridgeOptions.openTextDocument(path.join(os.tmpdir(), 'dsh-shared-session-2-' + process.pid + '.txt'));
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

test('C1 activation creates the DSH OutputChannel and runs the owner-marked orphan sweep before L0', async () => {
  const fake = createFakeVscode();
  const context = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-scan-test-${process.pid}`) },
    subscriptions: [],
  };
  const manager = { hasOwnedChild() { return false; }, cancelPending() {} };
  const sweepInvocations = [];
  const swept = [{ pid: 7001, port: 4050, vscodePid: 7701 }];
  const sweepFn = async (file, options) => {
    sweepInvocations.push({ file, options });
    return swept;
  };

  await activateWithDependencies(context, {
    vscode: fake.api,
    sweepDeadOwnerEntries: sweepFn,
    extensionHostStartMs: () => 1111,
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

  // §3 degradation-chain last link: an OutputChannel named DSH is created,
  // pushed into the subscription set and received the sweep diagnostic.
  const channel = fake.outputChannels.get('DSH');
  assert.ok(channel, 'activation must create the DSH OutputChannel');
  assert.strictEqual(channel.name, 'DSH');
  assert.ok(context.subscriptions.includes(channel), 'the channel must be disposed with the context');
  assert.strictEqual(sweepInvocations.length, 1, 'scan runs once during activation');
  assert.strictEqual(typeof sweepInvocations[0].options.terminate, 'function');
  assert.strictEqual(sweepInvocations[0].options.currentVscodePid, process.pid);
  assert.ok(
    channel.lines.some((line) => line.includes('Orphan sweep') && line.includes('7001')),
    'swept-child diagnostics must be appended to the OutputChannel'
  );

  await deactivate();
});

test('changes-review L2 feature mounts the bridge handler, tree view and commands only when enabled', async () => {
  const fake = createFakeVscode({ 'features.changes-review': true });
  const context = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-changes-review-test-${process.pid}`) },
    subscriptions: [],
  };
  let versionedBridgeOptions = null;
  await activateWithDependencies(context, {
    vscode: fake.api,
    realpath: async (value) => value,
    async startTextDocumentBridge() {
      return { env: {}, async close() {} };
    },
    async startVersionedBridge(options) {
      versionedBridgeOptions = options;
      return { env: {}, async close() {} };
    },
    createServerManager() {
      return {
        setSpawnEnv() {},
        setOwnerIdentity() {},
        cancelPending() {},
        currentChildPid() { return null; },
        hasOwnedChild() { return false; },
        async stop() {},
      };
    },
    async ensureManagedRuntime() {
      throw new Error('autoStart=false must not resolve the managed runtime');
    },
  });

  assert.ok(fake.commands.has('dsh.changes.openDiff'));
  assert.ok(fake.commands.has('dsh.changes.accept'));
  assert.ok(fake.commands.has('dsh.changes.undo'));
  assert.ok(fake.commands.has('dsh.changes.refresh'));
  assert.ok(!fake.commands.has('dsh.changes.focus'), 'dsh.changes.focus is auto-generated by VS Code for the view');
  assert.ok(fake.registrations.tree, 'tree provider must be registered');
  assert.strictEqual(fake.registrations.tree.id, 'dsh.changes');
  assert.ok(fake.registrations.treeView, 'tree view must be created');
  assert.strictEqual(typeof versionedBridgeOptions.handlers['vscode/changes/push'], 'function');

  await deactivate();
});

test('ctrl-k L2 feature registers the Edit with DSH command only when enabled', async () => {
  const fake = createFakeVscode({ 'features.ctrl-k': true });
  const context = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-ctrlk-test-${process.pid}`) },
    subscriptions: [],
  };
  await activateWithDependencies(context, {
    vscode: fake.api,
    realpath: async (value) => value,
    async startTextDocumentBridge() {
      return { env: {}, async close() {} };
    },
    async startVersionedBridge() {
      return { env: {}, async close() {} };
    },
    createServerManager() {
      return {
        setSpawnEnv() {},
        setOwnerIdentity() {},
        cancelPending() {},
        currentChildPid() { return null; },
        hasOwnedChild() { return false; },
        async stop() {},
      };
    },
    async ensureManagedRuntime() {
      throw new Error('autoStart=false must not resolve the managed runtime');
    },
  });

  assert.ok(fake.commands.has('dsh.ctrlKEdit'), 'dsh.ctrlKEdit must be registered when the L2 feature is enabled');
  await deactivate();
});

test('ctrl-i L2 feature registers the Edit with DSH Files command only when enabled', async () => {
  const off = createFakeVscode();
  const offContext = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-ctrli-off-${process.pid}`) },
    subscriptions: [],
  };
  await activateWithDependencies(offContext, {
    vscode: off.api,
    realpath: async (value) => value,
    async startTextDocumentBridge() {
      return { env: {}, async close() {} };
    },
    async startVersionedBridge() {
      return { env: {}, async close() {} };
    },
    createServerManager() {
      return {
        setSpawnEnv() {},
        setOwnerIdentity() {},
        cancelPending() {},
        currentChildPid() { return null; },
        hasOwnedChild() { return false; },
        async stop() {},
      };
    },
    async ensureManagedRuntime() {
      throw new Error('autoStart=false must not resolve the managed runtime');
    },
  });

  assert.ok(!off.commands.has('dsh.ctrlIEdit'), 'dsh.ctrlIEdit must not be registered when the L2 feature is disabled');
  await deactivate();

  const on = createFakeVscode({ 'features.ctrl-i': true });
  const onContext = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-ctrli-on-${process.pid}`) },
    subscriptions: [],
  };
  await activateWithDependencies(onContext, {
    vscode: on.api,
    realpath: async (value) => value,
    async startTextDocumentBridge() {
      return { env: {}, async close() {} };
    },
    async startVersionedBridge() {
      return { env: {}, async close() {} };
    },
    createServerManager() {
      return {
        setSpawnEnv() {},
        setOwnerIdentity() {},
        cancelPending() {},
        currentChildPid() { return null; },
        hasOwnedChild() { return false; },
        async stop() {},
      };
    },
    async ensureManagedRuntime() {
      throw new Error('autoStart=false must not resolve the managed runtime');
    },
  });

  assert.ok(on.commands.has('dsh.ctrlIEdit'), 'dsh.ctrlIEdit must be registered when the L2 feature is enabled');
  assert.strictEqual(on.commands.size, off.commands.size + 1, 'enabling ctrl-i must add exactly one command');
  await deactivate();
});

test('ctrl-i command is registered before ctrl-k when both L2 features are enabled', async () => {
  const fake = createFakeVscode({ 'features.ctrl-i': true, 'features.ctrl-k': true });
  const context = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-ctrli-order-${process.pid}`) },
    subscriptions: [],
  };
  await activateWithDependencies(context, {
    vscode: fake.api,
    realpath: async (value) => value,
    async startTextDocumentBridge() {
      return { env: {}, async close() {} };
    },
    async startVersionedBridge() {
      return { env: {}, async close() {} };
    },
    createServerManager() {
      return {
        setSpawnEnv() {},
        setOwnerIdentity() {},
        cancelPending() {},
        currentChildPid() { return null; },
        hasOwnedChild() { return false; },
        async stop() {},
      };
    },
    async ensureManagedRuntime() {
      throw new Error('autoStart=false must not resolve the managed runtime');
    },
  });

  const keys = [...fake.commands.keys()];
  assert.ok(
    keys.indexOf('dsh.ctrlIEdit') >= 0 && keys.indexOf('dsh.ctrlKEdit') >= 0
      && keys.indexOf('dsh.ctrlIEdit') < keys.indexOf('dsh.ctrlKEdit'),
    'dsh.ctrlIEdit must be registered before dsh.ctrlKEdit'
  );
  await deactivate();
});

function managerStubWithSpawnEnv(spawnEnvCalls) {
  return {
    setSpawnEnv(env) { spawnEnvCalls.push(env); },
    setOwnerIdentity() {},
    cancelPending() {},
    currentChildPid() { return null; },
    hasOwnedChild() { return false; },
    async stop() {},
  };
}

test('chat-participant L2 feature registers the @dsh chat participant only when enabled', async () => {
  const off = createFakeVscode({ 'features.chat-participant': false });
  const offContext = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-chat-participant-off-${process.pid}`) },
    subscriptions: [],
  };
  await activateWithDependencies(offContext, {
    vscode: off.api,
    realpath: async (value) => value,
    async startTextDocumentBridge() {
      return { env: {}, async close() {} };
    },
    async startVersionedBridge() {
      return { env: {}, async close() {} };
    },
    createServerManager() {
      return {
        setSpawnEnv() {},
        setOwnerIdentity() {},
        cancelPending() {},
        currentChildPid() { return null; },
        hasOwnedChild() { return false; },
        async stop() {},
      };
    },
    async ensureManagedRuntime() {
      throw new Error('autoStart=false must not resolve the managed runtime');
    },
  });

  assert.strictEqual(off.registrations.chatParticipant, undefined, 'disabled feature must not create the chat participant');
  await deactivate();

  const on = createFakeVscode({ 'features.chat-participant': true });
  const onContext = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-chat-participant-on-${process.pid}`) },
    subscriptions: [],
  };
  await activateWithDependencies(onContext, {
    vscode: on.api,
    realpath: async (value) => value,
    async startTextDocumentBridge() {
      return { env: {}, async close() {} };
    },
    async startVersionedBridge() {
      return { env: {}, async close() {} };
    },
    createServerManager() {
      return {
        setSpawnEnv() {},
        setOwnerIdentity() {},
        cancelPending() {},
        currentChildPid() { return null; },
        hasOwnedChild() { return false; },
        async stop() {},
      };
    },
    async ensureManagedRuntime() {
      throw new Error('autoStart=false must not resolve the managed runtime');
    },
  });

  assert.ok(on.registrations.chatParticipant, 'enabled feature must create the chat participant');
  assert.strictEqual(on.registrations.chatParticipant.id, 'dsh');
  assert.strictEqual(typeof on.registrations.chatParticipant.handler, 'function');
  assert.strictEqual(typeof on.registrations.chatParticipant.followupProvider.provideFollowups, 'function');
  await deactivate();
});

test('tab-completion L2 feature registers the file-scheme provider and clears the bridge token on teardown', async () => {
  const off = createFakeVscode();
  const offSpawnEnvCalls = [];
  const offContext = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-fim-off-${process.pid}`) },
    subscriptions: [],
  };
  await activateWithDependencies(offContext, {
    vscode: off.api,
    realpath: async (value) => value,
    async startTextDocumentBridge() {
      return { env: {}, async close() {} };
    },
    async startVersionedBridge() {
      return { env: {}, async close() {} };
    },
    createServerManager() {
      return managerStubWithSpawnEnv(offSpawnEnvCalls);
    },
    async ensureManagedRuntime() {
      throw new Error('autoStart=false must not resolve the managed runtime');
    },
  });

  assert.strictEqual(off.registrations.inlineCompletion, undefined, 'disabled feature must not register the provider');
  assert.ok(
    !offSpawnEnvCalls.some((env) => Object.hasOwn(env, 'DSH_FIM_BRIDGE_TOKEN')),
    'disabled feature must not write the FIM bridge token',
  );
  await deactivate();

  const on = createFakeVscode({ 'features.tab-completion': true, 'fim.model': 'test-fim-model' });
  const onSpawnEnvCalls = [];
  const onContext = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-fim-on-${process.pid}`) },
    subscriptions: [],
  };
  await activateWithDependencies(onContext, {
    vscode: on.api,
    realpath: async (value) => value,
    async startTextDocumentBridge() {
      return { env: {}, async close() {} };
    },
    async startVersionedBridge() {
      return { env: {}, async close() {} };
    },
    createServerManager() {
      return managerStubWithSpawnEnv(onSpawnEnvCalls);
    },
    async ensureManagedRuntime() {
      throw new Error('autoStart=false must not resolve the managed runtime');
    },
  });

  assert.ok(on.registrations.inlineCompletion, 'enabled feature must register the inline completion provider');
  assert.deepStrictEqual(on.registrations.inlineCompletion.selector, { scheme: 'file' });
  assert.strictEqual(typeof on.registrations.inlineCompletion.provider.provideInlineCompletionItems, 'function');
  assert.ok(
    onSpawnEnvCalls.some((env) => typeof env.DSH_FIM_BRIDGE_TOKEN === 'string' && env.DSH_FIM_BRIDGE_TOKEN.length === 64),
    'enabled feature must inject a 64-char hex FIM bridge token',
  );

  await deactivate();
  assert.ok(
    onSpawnEnvCalls.some((env) => env.DSH_FIM_BRIDGE_TOKEN === ''),
    'deactivate must clear the injected FIM bridge token',
  );
});

test('chat-participant and tab-completion each add exactly one command when enabled', async () => {
  const off = createFakeVscode({ 'features.chat-participant': false, 'features.tab-completion': false });
  const offContext = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-asm2-commands-off-${process.pid}`) },
    subscriptions: [],
  };
  await activateWithDependencies(offContext, {
    vscode: off.api,
    realpath: async (value) => value,
    async startTextDocumentBridge() {
      return { env: {}, async close() {} };
    },
    async startVersionedBridge() {
      return { env: {}, async close() {} };
    },
    createServerManager() {
      return {
        setSpawnEnv() {},
        setOwnerIdentity() {},
        cancelPending() {},
        currentChildPid() { return null; },
        hasOwnedChild() { return false; },
        async stop() {},
      };
    },
    async ensureManagedRuntime() {
      throw new Error('autoStart=false must not resolve the managed runtime');
    },
  });

  const offCount = off.commands.size;
  assert.ok(!off.commands.has('dsh.openSessionHistory'), 'openSessionHistory must be absent when disabled');
  assert.ok(!off.commands.has('dsh.fim.setApiKey'), 'fim.setApiKey must be absent when disabled');
  await deactivate();

  const on = createFakeVscode({ 'features.chat-participant': true, 'features.tab-completion': true });
  const onContext = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-asm2-commands-on-${process.pid}`) },
    subscriptions: [],
  };
  await activateWithDependencies(onContext, {
    vscode: on.api,
    realpath: async (value) => value,
    async startTextDocumentBridge() {
      return { env: {}, async close() {} };
    },
    async startVersionedBridge() {
      return { env: {}, async close() {} };
    },
    createServerManager() {
      return {
        setSpawnEnv() {},
        setOwnerIdentity() {},
        cancelPending() {},
        currentChildPid() { return null; },
        hasOwnedChild() { return false; },
        async stop() {},
      };
    },
    async ensureManagedRuntime() {
      throw new Error('autoStart=false must not resolve the managed runtime');
    },
  });

  assert.ok(on.commands.has('dsh.openSessionHistory'), 'openSessionHistory must be registered when enabled');
  assert.ok(on.commands.has('dsh.fim.setApiKey'), 'fim.setApiKey must be registered when enabled');
  assert.strictEqual(on.commands.size, offCount + 2, 'enabling both features must add exactly two commands');
  const keys = [...on.commands.keys()];
  assert.ok(
    keys.indexOf('dsh.openSessionHistory') === keys.indexOf('dsh.switchSession') + 1,
    'dsh.openSessionHistory must be registered immediately after dsh.switchSession',
  );
  await deactivate();
});

test('dsh.fim.setApiKey is registered immediately after dsh.mcp.refresh when both features are enabled', async () => {
  const fake = createFakeVscode({ 'features.tab-completion': true, 'features.mcp-consume': true });
  const context = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-fim-command-order-${process.pid}`) },
    globalState: {
      _store: new Map(),
      get(key) { return this._store.get(key); },
      update(key, value) { this._store.set(key, value); },
    },
    subscriptions: [],
  };
  await activateWithDependencies(context, {
    vscode: fake.api,
    realpath: async (value) => value,
    async startTextDocumentBridge() {
      return { env: {}, async close() {} };
    },
    async startVersionedBridge() {
      return { env: {}, async close() {} };
    },
    createServerManager() {
      return {
        setSpawnEnv() {},
        setOwnerIdentity() {},
        cancelPending() {},
        currentChildPid() { return null; },
        hasOwnedChild() { return false; },
        async stop() {},
      };
    },
    async ensureManagedRuntime() {
      throw new Error('autoStart=false must not resolve the managed runtime');
    },
  });

  const keys = [...fake.commands.keys()];
  assert.ok(
    keys.indexOf('dsh.fim.setApiKey') === keys.indexOf('dsh.mcp.refresh') + 1,
    'dsh.fim.setApiKey must be registered immediately after dsh.mcp.refresh',
  );
  await deactivate();
});

test('dsh.fim.setApiKey stores non-empty input and deletes on empty input', async () => {
  const fake = createFakeVscode({ 'features.tab-completion': true });
  const inputBoxCalls = [];
  let inputValue = '';
  fake.api.window.showInputBox = async (options) => {
    inputBoxCalls.push(options);
    return inputValue;
  };
  const stored = [];
  const deleted = [];
  const context = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-fim-apikey-${process.pid}`) },
    secrets: {
      async store(key, value) { stored.push({ key, value }); },
      async delete(key) { deleted.push(key); },
    },
    subscriptions: [],
  };
  await activateWithDependencies(context, {
    vscode: fake.api,
    realpath: async (value) => value,
    async startTextDocumentBridge() {
      return { env: {}, async close() {} };
    },
    async startVersionedBridge() {
      return { env: {}, async close() {} };
    },
    createServerManager() {
      return {
        setSpawnEnv() {},
        setOwnerIdentity() {},
        cancelPending() {},
        currentChildPid() { return null; },
        hasOwnedChild() { return false; },
        async stop() {},
      };
    },
    async ensureManagedRuntime() {
      throw new Error('autoStart=false must not resolve the managed runtime');
    },
  });

  inputValue = 'sk-test-fim-key';
  await fake.commands.get('dsh.fim.setApiKey')();
  assert.deepStrictEqual(stored, [{ key: 'dsh.fim.apiKey', value: 'sk-test-fim-key' }]);
  assert.ok(fake.informationMessages.some((message) => message.includes('DSH FIM API key stored')));

  inputValue = '';
  await fake.commands.get('dsh.fim.setApiKey')();
  assert.deepStrictEqual(deleted, ['dsh.fim.apiKey']);
  assert.ok(fake.informationMessages.some((message) => message.includes('DSH FIM API key deleted')));

  assert.strictEqual(inputBoxCalls.length, 2);
  assert.strictEqual(inputBoxCalls[0].password, true);
  assert.strictEqual(inputBoxCalls[0].prompt, 'dsh.fim.setApiKey.prompt');
  await deactivate();
});

test('lm-route L2 feature registers the dsh chat provider and injects the bridge token', async () => {
  const fake = createFakeVscode({ 'features.lm-route': true, 'lm.route': 'fixed' });
  const context = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-lm-route-test-${process.pid}`) },
    subscriptions: [],
  };
  const spawnEnvCalls = [];
  await activateWithDependencies(context, {
    vscode: fake.api,
    realpath: async (value) => value,
    async startTextDocumentBridge() {
      return { env: {}, async close() {} };
    },
    async startVersionedBridge() {
      return { env: {}, async close() {} };
    },
    createServerManager() {
      return {
        setSpawnEnv(env) { spawnEnvCalls.push(env); },
        setOwnerIdentity() {},
        cancelPending() {},
        currentChildPid() { return null; },
        hasOwnedChild() { return false; },
        async stop() {},
      };
    },
    async ensureManagedRuntime() {
      throw new Error('autoStart=false must not resolve the managed runtime');
    },
  });

  assert.ok(fake.registrations.lmProvider, 'lm provider must be registered');
  assert.strictEqual(fake.registrations.lmProvider.vendor, 'dsh');
  assert.ok(
    spawnEnvCalls.some((env) => typeof env.DSH_LM_BRIDGE_TOKEN === 'string' && env.DSH_LM_BRIDGE_TOKEN.length > 0),
    'DSH_LM_BRIDGE_TOKEN must be injected for DSH-side /api/lm routes',
  );

  await deactivate();
  assert.ok(
    spawnEnvCalls.some((env) => env.DSH_LM_BRIDGE_TOKEN === ''),
    'deactivate must clear the injected bridge token',
  );
});

test('mcp-consume L2 feature registers refresh and forget-consent commands only when enabled', async () => {
  const fake = createFakeVscode({ 'features.mcp-consume': true });
  const context = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-mcp-test-${process.pid}`) },
    globalState: {
      _store: new Map(),
      get(key) { return this._store.get(key); },
      update(key, value) { this._store.set(key, value); },
    },
    subscriptions: [],
  };
  await activateWithDependencies(context, {
    vscode: fake.api,
    realpath: async (value) => value,
    async startTextDocumentBridge() {
      return { env: {}, async close() {} };
    },
    async startVersionedBridge(options) {
      return { env: {}, async close() {} };
    },
    createServerManager() {
      return {
        setSpawnEnv() {},
        setOwnerIdentity() {},
        cancelPending() {},
        currentChildPid() { return null; },
        hasOwnedChild() { return false; },
        async stop() {},
      };
    },
    async ensureManagedRuntime() {
      throw new Error('autoStart=false must not resolve the managed runtime');
    },
  });

  assert.ok(fake.commands.has('dsh.mcp.refresh'), 'dsh.mcp.refresh must be registered when enabled');
  assert.ok(fake.commands.has('dsh.mcp.forgetConsent'), 'dsh.mcp.forgetConsent must be registered when enabled');
  await deactivate();
});

test('activate() returns the exports face with a stable v1 shape and disabled call behavior', async () => {
  const fake = createFakeVscode();
  const context = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-exports-face-${process.pid}`) },
    subscriptions: [],
  };

  const face = await activate(context, {
    vscode: fake.api,
    realpath: async (value) => value,
    async startTextDocumentBridge() {
      return { env: {}, async close() {} };
    },
    async startVersionedBridge() {
      return { env: {}, async close() {} };
    },
    createServerManager() {
      return {
        setSpawnEnv() {},
        setOwnerIdentity() {},
        cancelPending() {},
        currentChildPid() { return null; },
        hasOwnedChild() { return false; },
        async stop() {},
      };
    },
    async ensureManagedRuntime() {
      throw new Error('autoStart=false must not resolve the managed runtime');
    },
  });

  assert.ok(face, 'activate() must return the exports face even when dsh.features.exports is off');
  assert.strictEqual(face.version, '1');
  assert.strictEqual(typeof face.ask, 'function');
  assert.strictEqual(typeof face.listSessions, 'function');
  assert.strictEqual(typeof face.addContext, 'function');
  await assert.rejects(
    face.ask('hello'),
    (err) => err && err.name === 'DshExportError' && err.code === 'DSH_EXPORT_DISABLED'
  );
  await deactivate();
});

test('call-export L2 feature is catalogued off by default and contributes no command', () => {
  const feature = FEATURE_CATALOG.find((entry) => entry.id === 'call-export');
  assert.ok(feature, 'call-export must be present in FEATURE_CATALOG');
  assert.strictEqual(feature.layer, 'L2');
  assert.strictEqual(feature.defaultEnabled, false);
  assert.strictEqual(feature.core, false);
  assert.strictEqual(typeof feature.setup, 'function');

  const manifest = require('../package.json');
  const entry = manifest.contributes.configuration.properties['dsh.features.call-export'];
  assert.ok(entry, 'dsh.features.call-export must be contributed');
  assert.strictEqual(entry.type, 'boolean');
  assert.strictEqual(entry.default, false);
  assert.strictEqual(entry.scope, 'machine');
  assert.ok(
    !manifest.activationEvents.some((event) => event.includes('callExport')),
    'callExport contributes no activation event',
  );
  assert.ok(
    !manifest.contributes.commands.some((command) => command.command.includes('callExport')),
    'callExport contributes no command',
  );
});

test('C1 spawn env injection: heartbeat path + window id always; watchdog off only under closePolicy=never', async () => {
  const setSpawnEnvCalls = [];
  const setOwnerIdentityCalls = [];

  async function activateWith(closePolicy) {
    const fake = createFakeVscode({ closePolicy });
    const context = {
      globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-env-test-${process.pid}-${closePolicy}`) },
      subscriptions: [],
    };
    const manager = {
      setSpawnEnv(env) { setSpawnEnvCalls.push(env); },
      setOwnerIdentity(identity) { setOwnerIdentityCalls.push(identity); },
      hasOwnedChild() { return false; },
      cancelPending() {},
      currentChildPid() { return null; },
    };
    await activateWithDependencies(context, {
      vscode: fake.api,
      extensionHostStartMs: () => 2222,
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
    await deactivate();
  }

  await activateWith('onVscodeExit');
  await activateWith('never');

  const first = setSpawnEnvCalls.filter((env) => env.DSH_VSCODE_WINDOW_ID && env.DSH_VSCODE_HEARTBEAT_PATH)
    .map((env) => JSON.parse(JSON.stringify(env)));
  assert.ok(first.length >= 2, 'each activation injects the heartbeat + window identity');

  const normal = first[0];
  assert.strictEqual(typeof normal.DSH_VSCODE_WINDOW_ID, 'string');
  assert.ok(normal.DSH_VSCODE_WINDOW_ID.length > 0);
  assert.ok(path.isAbsolute(normal.DSH_VSCODE_HEARTBEAT_PATH), 'heartbeat path must be absolute');
  assert.strictEqual(normal.DSH_VSCODE_WATCHDOG, undefined, 'onVscodeExit keeps the watchdog on (no override)');

  const never = first[1];
  assert.strictEqual(never.DSH_VSCODE_WATCHDOG, 'off', 'closePolicy=never disables the DSH-side watchdog');

  // Every activation stamps the registry owner identity (that the scan relies on).
  assert.strictEqual(setOwnerIdentityCalls.length, 2);
  for (const identity of setOwnerIdentityCalls) {
    assert.strictEqual(identity.vscodePid, process.pid, 'owner vscodePid is this extension host');
    assert.ok(typeof identity.windowId === 'string' && identity.windowId.length > 0);
  }
});

test('callExportJournal no-ops when storageDirProvider is null or returns null', () => {
  const noProvider = callExportJournal.createCallExportJournal({});
  noProvider.record({ extensionId: 'pub.a', method: 'run', argsSummary: { type: 'undefined', keys: [], bytes: 0 }, result: { ok: true } });
  const nullProvider = callExportJournal.createCallExportJournal({ storageDirProvider: () => null });
  nullProvider.record({ extensionId: 'pub.a', method: 'run', argsSummary: { type: 'undefined', keys: [], bytes: 0 }, result: { ok: true } });
});

test('callExportJournal persists a JSON array and trims the oldest entries', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-call-export-journal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const journal = callExportJournal.createCallExportJournal({
    storageDirProvider: () => ({ fsPath: root }),
    now: () => Date.parse('2025-01-01T00:00:00.000Z'),
    maxEntries: 2,
  });
  const summary = { type: 'undefined', keys: [], bytes: 0 };
  journal.record({ extensionId: 'pub.a', method: 'echo', argsSummary: summary, result: { ok: true } });
  journal.record({ extensionId: 'pub.b', method: 'boom', argsSummary: summary, result: { ok: false, errorCode: 'VSCODE_CALL_EXPORT_FAILED' } });
  journal.record({ extensionId: 'pub.c', method: 'run', argsSummary: summary, result: { ok: true } });
  const filePath = path.join(root, 'callExport', 'journal.json');
  assert.ok(fs.existsSync(filePath), 'journal.json must be written');
  const entries = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].extensionId, 'pub.b');
  assert.strictEqual(entries[1].extensionId, 'pub.c');
  assert.strictEqual(entries[0].id, 'ce-2');
  assert.strictEqual(entries[1].id, 'ce-3');
  assert.strictEqual(entries[1].at, '2025-01-01T00:00:00.000Z');
  assert.deepStrictEqual(entries[0].result, { ok: false, errorCode: 'VSCODE_CALL_EXPORT_FAILED' });
  assert.deepStrictEqual(entries[1].argsSummary, { type: 'undefined', keys: [], bytes: 0 });
  assert.ok(!fs.existsSync(filePath + '.' + process.pid + '.tmp'), 'tmp file must be renamed away');
});

test('callExportJournal writes through tmp+rename and swallows rename failure', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-call-export-io-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const journal = callExportJournal.createCallExportJournal({
    storageDirProvider: () => ({ fsPath: root }),
  });
  const filePath = path.join(root, 'callExport', 'journal.json');
  // Occupy the destination as a directory so the final rename fails. The
  // temporary file still gets written first, proving the tmp+rename path.
  fs.mkdirSync(filePath, { recursive: true });
  journal.record({ extensionId: 'pub.a', method: 'run', argsSummary: { type: 'undefined', keys: [], bytes: 0 }, result: { ok: true } });
  assert.ok(fs.existsSync(filePath + '.' + process.pid + '.tmp'), 'tmp write must be attempted before rename');
});
test('readMcpSources includes the remoteValue layer between user and workspace', () => {
  const inspectResult = {
    key: 'servers',
    globalValue: { alpha: { command: 'alpha-user' } },
    remoteValue: { beta: { command: 'beta-remote' } },
    workspaceValue: { gamma: { command: 'gamma-ws' } },
  };
  const fakeVscode = {
    workspace: {
      workspaceFolders: [],
      isTrusted: true,
      getConfiguration() {
        return { inspect: () => inspectResult };
      },
      fs: {
        readFile: async () => { throw new Error('no mcp.json in tests'); },
      },
    },
  };
  const sources = readMcpSources(fakeVscode);
  assert.deepStrictEqual(sources.map((entry) => entry.source), ['user', 'remote', 'workspace']);
  assert.ok(sources[1].servers.some((server) => server.name === 'beta'));
});

