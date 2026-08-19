'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createAddFileToThreadCommand, createAddFolderToThreadCommand } = require('../../src/commands/addFileToThread');
const { formatFileAttachment, formatFolderAttachment } = require('../../src/threadAttachment');

function fakeVscode() {
  const executed = [];
  const infoMessages = [];
  const errorMessages = [];
  const api = {
    commands: {
      executed,
      async executeCommand(...args) {
        executed.push(args);
      },
    },
    window: {
      infoMessages,
      async showInformationMessage(message) {
        infoMessages.push(message);
      },
      errorMessages,
      async showErrorMessage(message) {
        errorMessages.push(message);
      },
    },
  };
  return { api, executed, infoMessages, errorMessages };
}

function defaultLoc(template, params = {}) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? `{${key}}`));
}

function makeDeps(overrides = {}) {
  const requests = [];
  const attachCalls = [];
  const state = {
    view: { webview: {} },
    connected: true,
    attachError: null,
  };
  const deps = {
    vscode: fakeVscode().api,
    editorContext: {
      attachActiveFile(options) {
        attachCalls.push(options);
        if (state.attachError) throw state.attachError;
        return {
          id: 'ctx-1',
          kind: 'active-file',
          content: 'full text',
          document: { uri: 'file:///ws/a.ts' },
        };
      },
    },
    coordinator: {
      async request(webview, text) {
        requests.push({ webview, text });
      },
    },
    formatFileAttachment,
    waitForResolvedView: async () => state.view,
    ensureConnected: async () => state.connected,
    loc: defaultLoc,
    ...overrides,
  };
  return { deps, requests, state, attachCalls };
}

test('addFileToThread attaches the active file and posts a clickable file link', async () => {
  const { deps, requests, state, attachCalls } = makeDeps();
  const command = createAddFileToThreadCommand(deps);

  await command();

  assert.deepStrictEqual(attachCalls, [{ allowOutsideWorkspace: true }]);
  assert.deepStrictEqual(deps.vscode.commands.executed, [
    ['workbench.view.extension.dsh-sidebar'],
    ['dsh.webview.focus'],
  ]);
  assert.strictEqual(requests.length, 1);
  assert.strictEqual(requests[0].webview, state.view.webview);
  assert.strictEqual(requests[0].text, '[a.ts](https://dsh-vscode.invalid/attachment/ctx-1)');
  assert.deepStrictEqual(deps.vscode.window.infoMessages, ['File added to the DSH conversation']);
  assert.deepStrictEqual(deps.vscode.window.errorMessages, []);
});

test('addFileToThread does not post when the DSH server is unavailable', async () => {
  const { deps, requests } = makeDeps();
  deps.vscode = fakeVscode().api;
  deps.ensureConnected = async () => false;
  const command = createAddFileToThreadCommand(deps);

  await command();

  assert.strictEqual(requests.length, 0);
  assert.deepStrictEqual(deps.vscode.window.errorMessages, ['Add to DSH conversation failed: DSH: unavailable']);
  assert.deepStrictEqual(deps.vscode.window.infoMessages, []);
});

test('addFileToThread surfaces attach failures without posting', async () => {
  const { deps, requests, state } = makeDeps();
  state.attachError = new Error('no active editor');
  const command = createAddFileToThreadCommand(deps);

  await command();

  assert.strictEqual(requests.length, 0);
  assert.deepStrictEqual(deps.vscode.window.errorMessages, ['Add to DSH conversation failed: no active editor']);
  assert.deepStrictEqual(deps.vscode.window.infoMessages, []);
});

test('createAddFileToThreadCommand validates required dependencies', () => {
  assert.throws(() => createAddFileToThreadCommand({}), TypeError);
  assert.throws(() => createAddFileToThreadCommand({
    vscode: { commands: { executeCommand() {} } },
    editorContext: {},
    coordinator: {},
    formatFileAttachment() {},
    waitForResolvedView() {},
    ensureConnected() {},
  }), TypeError);
});

function makeFolderDeps(overrides = {}) {
  const requests = [];
  const attachCalls = [];
  const folderUri = { scheme: 'file', fsPath: 'D:\\ws\\src' };
  const state = {
    view: { webview: {} },
    connected: true,
    attachError: null,
  };
  const deps = {
    vscode: fakeVscode().api,
    editorContext: {
      attachFolder(uri, options) {
        attachCalls.push({ uri, options });
        if (state.attachError) throw state.attachError;
        return {
          id: 'ctx-1',
          kind: 'folder',
          content: 'folder: 1 entry (depth <= 2)\na.ts',
          document: { uri: 'file:///D:/ws/src' },
        };
      },
    },
    coordinator: {
      async request(webview, text) {
        requests.push({ webview, text });
      },
    },
    formatFolderAttachment,
    waitForResolvedView: async () => state.view,
    ensureConnected: async () => state.connected,
    loc: defaultLoc,
    ...overrides,
  };
  return { deps, requests, state, attachCalls, folderUri };
}

test('addFolderToThread attaches the explorer folder and posts a clickable folder link', async () => {
  const { deps, requests, state, attachCalls, folderUri } = makeFolderDeps();
  const command = createAddFolderToThreadCommand(deps);

  await command(folderUri);

  assert.deepStrictEqual(attachCalls, [{ uri: folderUri, options: { allowOutsideWorkspace: true } }]);
  assert.deepStrictEqual(deps.vscode.commands.executed, [
    ['workbench.view.extension.dsh-sidebar'],
    ['dsh.webview.focus'],
  ]);
  assert.strictEqual(requests.length, 1);
  assert.strictEqual(requests[0].webview, state.view.webview);
  assert.strictEqual(requests[0].text, '[src](https://dsh-vscode.invalid/attachment/ctx-1)');
  assert.deepStrictEqual(deps.vscode.window.infoMessages, ['Folder added to the DSH conversation']);
  assert.deepStrictEqual(deps.vscode.window.errorMessages, []);
});

test('addFolderToThread does not post when the DSH server is unavailable', async () => {
  const { deps, requests, folderUri } = makeFolderDeps();
  deps.vscode = fakeVscode().api;
  deps.ensureConnected = async () => false;
  const command = createAddFolderToThreadCommand(deps);

  await command(folderUri);

  assert.strictEqual(requests.length, 0);
  assert.deepStrictEqual(deps.vscode.window.errorMessages, ['Add to DSH conversation failed: DSH: unavailable']);
  assert.deepStrictEqual(deps.vscode.window.infoMessages, []);
});

test('addFolderToThread surfaces a missing folder URI without posting', async () => {
  const { deps, requests, attachCalls } = makeFolderDeps();
  const command = createAddFolderToThreadCommand(deps);

  await command();

  assert.strictEqual(requests.length, 0);
  assert.deepStrictEqual(attachCalls, []);
  assert.deepStrictEqual(deps.vscode.window.errorMessages, ['Add to DSH conversation failed: A folder URI is required']);
});

test('addFolderToThread surfaces attach failures without posting', async () => {
  const { deps, requests, state, folderUri } = makeFolderDeps();
  state.attachError = new Error('not a folder');
  const command = createAddFolderToThreadCommand(deps);

  await command(folderUri);

  assert.strictEqual(requests.length, 0);
  assert.deepStrictEqual(deps.vscode.window.errorMessages, ['Add to DSH conversation failed: not a folder']);
});

test('createAddFolderToThreadCommand validates required dependencies', () => {
  assert.throws(() => createAddFolderToThreadCommand({}), TypeError);
  assert.throws(() => createAddFolderToThreadCommand({
    vscode: { commands: { executeCommand() {} } },
    editorContext: {},
    coordinator: {},
    formatFolderAttachment() {},
    waitForResolvedView() {},
    ensureConnected() {},
  }), TypeError);
});
