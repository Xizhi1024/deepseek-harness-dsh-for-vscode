'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { activateWithDependencies, deactivate, openInstancePanel, focusedComposerWebview } = require('../../src/extension');

function disposable() {
  return { dispose() {} };
}

function createFakeVscode(configOverrides = {}) {
  const commands = new Map();
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
        const panel = {
          viewType,
          title,
          column,
          options,
          active: true,
          webview: {
            html: '',
            options,
            onDidReceiveMessage() { return disposable(); },
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
        };
        panels.push(panel);
        return panel;
      },
      onDidChangeActiveTextEditor() { return disposable(); },
      onDidChangeTextEditorSelection() { return disposable(); },
      registerWebviewViewProvider() { return disposable(); },
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
  return { api, commands, panels, informationMessages, configuration };
}

const managerStub = () => ({
  cancelPending() {},
  hasOwnedChild() { return false; },
  async stop() {},
});

async function activate(fake, context) {
  await activateWithDependencies(context, {
    vscode: fake.api,
    async startTextDocumentBridge() { return { env: {}, async close() {} }; },
    async startVersionedBridge() { return { env: {}, async close() {} }; },
    createServerManager() { return managerStub(); },
    async ensureManagedRuntime() { throw new Error('autoStart=false must not resolve the managed runtime'); },
  });
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
    vscode: fake.api,
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
      vscode: fake.api,
    }),
    /session api down/,
  );
  assert.strictEqual(fake.panels.length, 1, 'the panel was created optimistically');
  assert.strictEqual(fake.panels[0].active, false, 'and disposed again on failure');
  await deactivate();
});

test('deactivate disposes instance panels without touching the shared server', async () => {
  const fake = createFakeVscode();
  const context = { globalStorageUri: { fsPath: path.join(os.tmpdir(), 'dsh-mi-4-' + process.pid) }, subscriptions: [] };
  await activate(fake, context);
  const sharedServer = { url: 'http://127.0.0.1:3080', host: '127.0.0.1', port: 3080, pid: 111, owned: true };
  await openInstancePanel({
    server: sharedServer,
    createSessionFn: async () => 'sess-1',
    vscode: fake.api,
  });
  const panel = fake.panels[0];
  await deactivate();
  assert.strictEqual(panel.active, false, 'deactivate disposes the panel webview');
  await deactivate();
});
