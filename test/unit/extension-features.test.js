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
