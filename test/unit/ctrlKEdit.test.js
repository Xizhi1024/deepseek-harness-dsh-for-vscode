'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createCtrlKEditCommand, isNonEmptySelection } = require('../../src/commands/ctrlKEdit');

function createHarness(overrides = {}) {
  const informationMessages = [];
  const errorMessages = [];
  const executedCommands = [];
  const requests = [];
  const inputAnswers = overrides.inputAnswers || [];
  const state = {
    inputAnswers,
    informationMessages,
    errorMessages,
    executedCommands,
    requests,
    vscode: {
      window: {
        activeTextEditor: {
          document: { uri: { toString: () => 'file:///ws/a.js' } },
          selection: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 4 },
          },
        },
        async showInputBox() {
          return inputAnswers.shift();
        },
        async showInformationMessage(message) {
          informationMessages.push(message);
        },
        async showErrorMessage(message) {
          errorMessages.push(message);
        },
      },
      commands: {
        async executeCommand(...args) {
          executedCommands.push(args);
        },
      },
    },
    editorContext: {
      attachActiveSelection() {
        return {
          id: 'ctx-1',
          kind: 'selection',
          document: { uri: 'file:///ws/a.js' },
          content: 'code',
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 4 },
          },
        };
      },
    },
    coordinator: {
      async request(webview, text) {
        requests.push({ webview, text });
      },
    },
    formatSelectionAttachment(attachment, label) {
      return `[${label}]`;
    },
    async waitForResolvedView() {
      return { webview: { postMessage: async () => true } };
    },
    async ensureConnected() {
      return true;
    },
    loc(value) {
      return value;
    },
  };
  if (overrides.noSelection) {
    state.vscode.window.activeTextEditor = { document: {}, selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } };
  }
  const command = createCtrlKEditCommand(state);
  return { ...state, command };
}

test('isNonEmptySelection detects empty and cross-line selections', () => {
  assert.strictEqual(isNonEmptySelection({ start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }), false);
  assert.strictEqual(isNonEmptySelection({ start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }), true);
  assert.strictEqual(isNonEmptySelection({ start: { line: 0, character: 1 }, end: { line: 1, character: 0 } }), true);
});

test('Ctrl+K with no selection only shows a hint', async () => {
  const harness = createHarness({ noSelection: true });
  await harness.command();
  assert.strictEqual(harness.informationMessages.length, 1);
  assert.strictEqual(harness.requests.length, 0);
});

test('Ctrl+K sends instruction + selection draft through the coordinator', async () => {
  const harness = createHarness({ inputAnswers: ['rename this'] });
  await harness.command();
  assert.strictEqual(harness.requests.length, 1);
  assert.ok(harness.requests[0].text.includes('指令:\nrename this'));
  assert.ok(harness.requests[0].text.includes('上下文:\n[file:///ws/a.js]'));
  assert.strictEqual(harness.informationMessages.length, 1);
});

test('Ctrl+K timeout or cancel never sends a draft', async () => {
  const harness = createHarness({ inputAnswers: [undefined] });
  await harness.command();
  assert.strictEqual(harness.requests.length, 0);
  assert.strictEqual(harness.informationMessages.length, 0);
});

test('Ctrl+K reports when DSH is unavailable', async () => {
  const harness = createHarness({ inputAnswers: ['fix'] });
  harness.ensureConnected = async () => false;
  const command = createCtrlKEditCommand(harness);
  await command();
  assert.strictEqual(harness.requests.length, 0);
  assert.strictEqual(harness.errorMessages.length, 1);
});

test('Ctrl+K falls back to the sidebar when no focused composer exists', async () => {
  const harness = createHarness({ inputAnswers: ['fix'] });
  harness.focusedComposerWebview = () => null;
  const command = createCtrlKEditCommand(harness);
  await command();
  assert.ok(harness.executedCommands.some((args) => args[0] === 'dsh.focusSidebar'));
  assert.strictEqual(harness.requests.length, 1);
});
