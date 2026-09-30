'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { activateWithDependencies, deactivate, openInstancePanel, focusedComposerWebview } = require('../../src/extension');
const { createVscodeFacade } = require('../../src/vscodeFacade');

function disposable() {
  return { dispose() {} };
}

function createFakeVscode(configOverrides = {}) {
  const commands = new Map();
  const registrations = {};
  const panels = [];
  const informationMessages = [];
  const configuration = {
    host: '127.0.0.1',
    port: 3080,
    autoStart: false,
    closePolicy: 'onVscodeExit',
    'home.mode': 'isolated',
    ...configOverrides,
  };
  const api = {
    ViewColumn: { Active: 1 },
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
    languages: { getDiagnostics() { return []; } },
    l10n: {
      t(template, params = {}) {
        return String(template).replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? '{' + key + '}'));
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
      isUri(value) { return Boolean(value && typeof value.toString === 'function' && typeof value.scheme === 'string'); },
    },
    window: {
      activeTextEditor: null,
      createQuickPick() {
        return { items: [], selectedItems: [], canPickMany: false, placeholder: '', onDidAccept() {}, onDidHide() {}, show() {}, dispose() {} };
      },
      createStatusBarItem() { return { show() {}, text: '', tooltip: '' }; },
      createWebviewPanel(viewType, title, column, options) {
        const stateListeners = [];
        const disposeListeners = [];
        let receiveMessage;
        const panel = {
          viewType,
          title,
          column,
          options,
          active: true,
          webview: {
            html: '',
            options,
            onDidReceiveMessage(handler) { receiveMessage = handler; return disposable(); },
          },
          onDidChangeViewState(fn) { stateListeners.push(fn); },
          onDidDispose(fn) { disposeListeners.push(fn); },
          dispose() {
            if (!panel.active) return;
            panel.active = false;
            for (const fn of disposeListeners) fn();
          },
          _activate() {
            panel.active = true;
            for (const fn of stateListeners) fn({ webviewPanel: panel });
          },
          _receiveMessage(message) { return receiveMessage(message); },
        };
        panels.push(panel);
        return panel;
      },
      onDidChangeActiveTextEditor() { return disposable(); },
      onDidChangeTextEditorSelection() { return disposable(); },
      registerWebviewViewProvider(id, provider) { registrations.webview = { id, provider }; return disposable(); },
      async showTextDocument() {},
      async showErrorMessage() {},
      async showInformationMessage(message) { informationMessages.push(message); },
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
  return { api, commands, panels, informationMessages, configuration, registrations };
}

const managerStub = () => ({
  cancelPending() {},
  hasOwnedChild() { return false; },
  async stop() {},
});

async function activate(fake, context, dependencies = {}) {
  await activateWithDependencies(context, {
    vscode: fake.api,
    async startTextDocumentBridge() { return { env: {}, async close() {} }; },
    async startVersionedBridge() { return { env: {}, async close() {} }; },
    createServerManager() { return managerStub(); },
    async ensureManagedRuntime() { throw new Error('autoStart=false must not resolve the managed runtime'); },
    ...dependencies,
  });
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Panel connection did not finish');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('dsh.newInstance is registered last and declines politely without a connected server', async () => {
  const fake = createFakeVscode();
  const context = { globalStorageUri: { fsPath: path.join(os.tmpdir(), 'dsh-mi-1-' + process.pid) }, subscriptions: [] };
  await activate(fake, context);
  const ids = [...fake.commands.keys()];
  assert.strictEqual(ids.at(-1), 'dsh.newInstance', 'newInstance registers after every other command');
  await fake.commands.get('dsh.newInstance')();
  assert.strictEqual(fake.panels.length, 0, 'no panel may be created without a server');
  assert.ok(fake.informationMessages.some((m) => m.includes('Connect the DSH sidebar')), 'friendly guidance is shown');
  await deactivate();
});

test('openInstancePanel shares the one DSH child and gives the panel its own session', async () => {
  const fake = createFakeVscode();
  const context = { globalStorageUri: { fsPath: path.join(os.tmpdir(), 'dsh-mi-2-' + process.pid) }, subscriptions: [] };
  await activate(fake, context);

  const sharedServer = { url: 'http://127.0.0.1:3080', host: '127.0.0.1', port: 3080, pid: 111, owned: true };
  const sessionCalls = [];
  await openInstancePanel({
    server: sharedServer,
    createSessionFn: async (baseUrl, opts) => {
      sessionCalls.push({ baseUrl, opts });
      return 'sess-42';
    },
    // No explicit vscode param: exercise the default module facade path
    // exactly as production does (regression for the ViewColumn crash).
  });

  assert.strictEqual(fake.panels.length, 1);
  const panel = fake.panels[0];
  assert.strictEqual(panel.title, 'DSH #1');
  assert.ok(panel.webview.html.includes('127.0.0.1:3080'), 'the panel paints the SHARED server URL');
  assert.ok(panel.webview.html.includes('dsh_session'), 'the iframe carries the per-panel session');
  assert.ok(panel.webview.html.includes('sess-42'), 'the created session id reaches the iframe');
  assert.strictEqual(sessionCalls.length, 1);
  assert.strictEqual(sessionCalls[0].baseUrl, 'http://127.0.0.1:3080', 'session API uses the raw loopback URL');

  // Focus routing: an active panel wins over the sidebar for attachments.
  assert.strictEqual(focusedComposerWebview(), panel.webview, 'the focused panel is the composer target');
  panel.dispose();
  assert.strictEqual(focusedComposerWebview(), null, 'a disposed panel never receives attachments');
  await deactivate();
});

test('a failed session creation disposes the panel and surfaces the error', async () => {
  const fake = createFakeVscode();
  const context = { globalStorageUri: { fsPath: path.join(os.tmpdir(), 'dsh-mi-3-' + process.pid) }, subscriptions: [] };
  await activate(fake, context);
  const sharedServer = { url: 'http://127.0.0.1:3080', host: '127.0.0.1', port: 3080, pid: 111, owned: true };
  await assert.rejects(
    openInstancePanel({
      server: sharedServer,
      createSessionFn: async () => { throw new Error('session api down'); },
      // No explicit vscode param: exercise the default module facade path
    // exactly as production does (regression for the ViewColumn crash).
    }),
    /session api down/,
  );
  assert.strictEqual(fake.panels.length, 1, 'the panel was created optimistically');
  assert.strictEqual(fake.panels[0].active, false, 'and disposed again on failure');
  await deactivate();
});

test('surviving panel and Retry use the newly bound URL after a shared runtime restart', async (t) => {
  t.after(() => deactivate());
  const fake = createFakeVscode({ autoStart: true, 'features.changes-review': false, 'features.chat-participant': false });
  const context = { globalStorageUri: { fsPath: path.join(os.tmpdir(), 'dsh-mi-restart-' + process.pid) }, subscriptions: [] };
  const opened = [];
  fake.api.env.openExternal = async (uri) => opened.push(uri.toString());
  fake.api.env.asExternalUri = async (uri) => {
    const external = new URL(uri.toString());
    external.port = String(Number(external.port) + 10000);
    return fake.api.Uri.parse(external.toString());
  };
  let server = null;
  let launches = 0;
  let stops = 0;
  const manager = {
    cancelPending() {}, setResolvedRuntime() {},
    hasOwnedChild() { return server !== null; },
    async stop() { stops++; server = null; },
    async ensureServer() {
      if (!server) {
        const port = 3080 + launches++;
        server = { url: `http://127.0.0.1:${port}`, host: '127.0.0.1', port, owned: true, pid: 1000 + launches };
      }
      return server;
    },
  };
  await activate(fake, context, { createServerManager: () => manager, ensureManagedRuntime: async () => ({ dshVersion: '0.1.2-rc.1' }) });
  const view = { webview: { html: '', onDidReceiveMessage() { return disposable(); } }, onDidDispose() { return disposable(); } };
  fake.registrations.webview.provider.resolveWebviewView(view);
  await waitFor(() => view.webview.html.includes('<iframe'));
  await openInstancePanel({ createSessionFn: async () => 'panel-session' });
  const panel = fake.panels[0];
  assert.ok(panel.webview.html.includes('127.0.0.1:13080'), 'the first panel uses the externalized initial endpoint');
  await fake.commands.get('dsh.restartServer')();
  assert.equal(launches, 2, 'restart replaces the shared child exactly once');
  assert.equal(stops, 1);
  assert.equal(panel.active, true, 'the same panel survives the restart');
  assert.ok(panel.webview.html.includes('127.0.0.1:13081'), 'a surviving panel is repainted with the new externalized endpoint');
  assert.ok(!panel.webview.html.includes('127.0.0.1:13080'), 'the dead endpoint is no longer embedded');
  assert.ok(panel.webview.html.includes('dsh_session=panel-session'), 'the panel retains its conversation');
  panel._receiveMessage({ type: 'retry' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(panel.webview.html.includes('127.0.0.1:13081'), 'Retry resolves the current endpoint');
  assert.ok(!panel.webview.html.includes('127.0.0.1:13080'), 'Retry cannot resurrect its old closure URL');
  panel._receiveMessage({ type: 'openBrowser' });
  assert.deepEqual(opened, ['http://127.0.0.1:3081'], 'Open in browser also uses the current runtime');
});

test('deactivate disposes instance panels without touching the shared server', async () => {
  const fake = createFakeVscode();
  const context = { globalStorageUri: { fsPath: path.join(os.tmpdir(), 'dsh-mi-4-' + process.pid) }, subscriptions: [] };
  await activate(fake, context);
  const sharedServer = { url: 'http://127.0.0.1:3080', host: '127.0.0.1', port: 3080, pid: 111, owned: true };
  await openInstancePanel({
    server: sharedServer,
    createSessionFn: async () => 'sess-1',
    // No explicit vscode param: exercise the default module facade path
    // exactly as production does (regression for the ViewColumn crash).
  });
  const panel = fake.panels[0];
  await deactivate();
  assert.strictEqual(panel.active, false, 'deactivate disposes the panel webview');
  await deactivate();
});
