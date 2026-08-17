'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { activateWithDependencies, deactivate } = require('../../src/extension');

function disposable() {
  return { dispose() {} };
}

function createFakeVscode() {
  const commands = new Map();
  const registrations = {};
  const selectionHandlerHolder = { handler: null };
  const diagnosticsHandlerHolder = { handler: null };
  const activeEditorHandlerHolder = { handler: null };
  const configuration = {
    host: '127.0.0.1',
    port: 3080,
    autoStart: false,
    closePolicy: 'onVscodeExit',
    'home.mode': 'isolated',
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
      onDidChangeDiagnostics(handler) {
        diagnosticsHandlerHolder.handler = handler;
        return disposable();
      },
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
      onDidChangeActiveTextEditor(handler) {
        activeEditorHandlerHolder.handler = handler;
        return disposable();
      },
      onDidChangeTextEditorSelection(handler) {
        selectionHandlerHolder.handler = handler;
        return disposable();
      },
      registerWebviewViewProvider(id, provider, options) {
        registrations.webview = { id, provider, options };
        return disposable();
      },
      async showErrorMessage() {},
      async showInformationMessage() {},
      async showTextDocument() {},
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
  return {
    api,
    commands,
    registrations,
    selectionHandlerHolder,
    diagnosticsHandlerHolder,
    activeEditorHandlerHolder,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('extension deactivate disposes CH1 v2 notification subscriptions so later events do not send', async () => {
  const fake = createFakeVscode();
  const context = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-extension-b3-qa-${process.pid}`) },
    subscriptions: [],
  };
  const notifyCalls = [];
  const bridge = {
    env: {},
    hasProtocolVersion(version) { return version === 2; },
    notify(method, params) { notifyCalls.push({ method, params }); },
    async close() {},
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
      return bridge;
    },
    createServerManager() { return manager; },
    async ensureManagedRuntime() {
      throw new Error('autoStart=false must not resolve the managed runtime');
    },
  });

  fake.api.workspace.workspaceFolders = [
    { uri: { fsPath: 'D:\\workspace' }, name: 'workspace', index: 0 },
  ];
  fake.api.workspace.getWorkspaceFolder = () => ({
    uri: { fsPath: 'D:\\workspace' },
    name: 'workspace',
    index: 0,
  });
  const uri = 'file:///D:/workspace/a.ts';
  const document = {
    uri: { toString: () => uri, fsPath: 'D:\\workspace\\a.ts', scheme: 'file' },
    languageId: 'typescript',
    version: 7,
    isDirty: false,
    getText() { return 'const a = 1;\n'; },
  };
  fake.api.window.activeTextEditor = { document };

  await fake.commands.get('dsh.addActiveFile')();
  notifyCalls.length = 0; // ignore the immediate contextChanged advisory

  fake.selectionHandlerHolder.handler({
    textEditor: { document: { ...document, version: 8 } },
  });
  await sleep(200);

  const beforeSelection = notifyCalls.filter((call) => call.method === 'vscode/editor/selectionChanged');
  assert.strictEqual(beforeSelection.length, 1, 'selection notification should be live before deactivate');
  const beforeCount = notifyCalls.length;

  await deactivate();

  fake.selectionHandlerHolder.handler({
    textEditor: { document: { ...document, version: 9 } },
  });
  fake.diagnosticsHandlerHolder.handler({ uris: [document.uri] });
  await sleep(200);

  const afterCount = notifyCalls.length;
  const afterSelection = notifyCalls.filter((call) => call.method === 'vscode/editor/selectionChanged').length;
  const afterDiagnostics = notifyCalls.filter((call) => call.method === 'vscode/diagnosticsChanged').length;

  assert.strictEqual(afterCount, beforeCount, 'no CH1 notifications may be sent after deactivate');
  assert.strictEqual(afterSelection, beforeSelection.length, 'selection send count must stay unchanged');
  assert.strictEqual(afterDiagnostics, 0, 'diagnostics must not send after deactivate');
});