'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { activateWithDependencies, deactivate, themeFromColorThemeKind } = require('../../src/extension');
const { VIEW_ID } = require('../../src/types');

function disposable() {
  return { dispose() {} };
}

function createFakeVscode({
  configOverrides = {},
  activeColorTheme = { kind: 2 },
  onChangeActiveColorTheme = null,
} = {}) {
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
  const windowApi = {
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
    onDidChangeTextEditorSelection() { return disposable(); },
    registerWebviewViewProvider(id, provider, options) {
      registrations.webview = { id, provider, options };
      return disposable();
    },
    async showTextDocument() {},
    async showErrorMessage() {},
    async showInformationMessage() {},
    async showWarningMessage() {},
  };
  if (activeColorTheme !== undefined) {
    windowApi.activeColorTheme = activeColorTheme;
  }
  if (typeof onChangeActiveColorTheme === 'function') {
    windowApi.onDidChangeActiveColorTheme = onChangeActiveColorTheme;
  }
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
    window: windowApi,
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

function managerStub() {
  return {
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

function makeView(posted) {
  let html = '';
  return {
    webview: {
      options: null,
      onDidReceiveMessage() { return disposable(); },
      postMessage(message) { posted.push(message); },
      set html(value) { html = value; },
      get html() { return html; },
    },
    onDidDispose() { return disposable(); },
  };
}

async function activateWithTheme(fake, options = {}) {
  const context = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-theme-follow-${process.pid}`) },
    subscriptions: [],
  };
  await activateWithDependencies(context, {
    vscode: fake.api,
    async startTextDocumentBridge() { return { env: {}, async close() {} }; },
    async startVersionedBridge() { return { env: {}, async close() {} }; },
    createServerManager() { return managerStub(); },
    async ensureManagedRuntime() { throw new Error('autoStart=false must not resolve the managed runtime'); },
    ...options.dependencies,
  });
  return context;
}

test('themeFromColorThemeKind maps VS Code theme kinds to dark/light markers', () => {
  assert.strictEqual(themeFromColorThemeKind({ kind: 1 }), 'light');
  assert.strictEqual(themeFromColorThemeKind({ kind: 2 }), 'dark');
  assert.strictEqual(themeFromColorThemeKind({ kind: 3 }), 'dark');
  assert.strictEqual(themeFromColorThemeKind({ kind: 4 }), 'light');
  assert.strictEqual(themeFromColorThemeKind(undefined), undefined);
  assert.strictEqual(themeFromColorThemeKind({ kind: 99 }), undefined);
});

test('theme-follow enabled stamps the iframe URL with the initial theme kind and forwards onDidChangeActiveColorTheme', async () => {
  const posted = [];
  let themeListener = null;
  const fake = createFakeVscode({
    activeColorTheme: { kind: 2 },
    onChangeActiveColorTheme(listener) {
      themeListener = listener;
      return disposable();
    },
  });
  const context = await activateWithTheme(fake);

  const view = makeView(posted);
  fake.registrations.webview.provider.resolveWebviewView(view);
  await waitFor(() => view.webview.html.includes('iframe'));
  assert.ok(view.webview.html.includes('dsh_theme=dark'), 'iframe URL must carry the initial dark theme');

  assert.strictEqual(typeof themeListener, 'function', 'theme listener must be registered when the feature is on');
  themeListener({ kind: 1 });
  assert.ok(
    posted.some((message) => message.type === 'dshThemeChanged' && message.theme === 'light'),
    'a color theme change must be forwarded through the webview message channel'
  );
  themeListener({ kind: 4 });
  assert.ok(
    posted.some((message) => message.type === 'dshThemeChanged' && message.theme === 'light'),
    'HighContrastLight must map to light'
  );

  await deactivate();
});

test('theme-follow off registers no theme listener and the iframe URL carries no dsh_theme', async () => {
  const posted = [];
  const fake = createFakeVscode({
    configOverrides: { 'features.theme-follow': false },
    activeColorTheme: { kind: 2 },
    onChangeActiveColorTheme() {
      throw new Error('theme listener must not be registered when theme-follow is disabled');
    },
  });
  const context = await activateWithTheme(fake);

  const view = makeView(posted);
  fake.registrations.webview.provider.resolveWebviewView(view);
  await waitFor(() => view.webview.html.includes('iframe'));
  assert.ok(!view.webview.html.includes('dsh_theme='), 'feature off must keep the pre-R12 iframe URL');
  assert.deepStrictEqual(posted, [], 'no theme change may be forwarded when the feature is off');

  await deactivate();
});

test('theme-follow activation still registers the sidebar provider', async () => {
  const fake = createFakeVscode({});
  await activateWithTheme(fake);
  assert.strictEqual(fake.registrations.webview.id, VIEW_ID);
  await deactivate();
});
