'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createAddFileToThreadCommand } = require('../../src/commands/addFileToThread');
const { formatFileAttachment } = require('../../src/threadAttachment');

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
