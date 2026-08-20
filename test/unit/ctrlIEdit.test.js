'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createCtrlIEditCommand,
  CTRLI_MAX_FILES,
  CTRLI_MAX_PICKED_FILES,
  CTRLI_TIMEOUT_MS,
} = require('../../src/commands/ctrlIEdit');

function defaultLoc(template, params = {}) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? `{${key}}`));
}

function fakeUri(value) {
  return {
    scheme: 'file',
    path: new URL(value).pathname,
    toString() {
      return value;
    },
  };
}

function createHarness(options = {}) {
  const infoMessages = [];
  const warningMessages = [];
  const errorMessages = [];
  const requests = [];
  const pickers = [];
  const findFilesCalls = [];
  const attachCalls = [];
  const waitCalls = [];

  let pickerReadyResolve;
  const pickerReady = new Promise((resolve) => {
    pickerReadyResolve = resolve;
  });

  const fileUris = Array.isArray(options.files)
    ? options.files
    : [fakeUri('file:///ws/a.ts'), fakeUri('file:///ws/b.ts')];

  const state = {
    infoMessages,
    warningMessages,
    errorMessages,
    requests,
    pickers,
    findFilesCalls,
    attachCalls,
    waitCalls,
    focusedWebview: Object.prototype.hasOwnProperty.call(options, 'focusedWebview')
      ? options.focusedWebview
      : { postMessage: async () => true },
    view: Object.prototype.hasOwnProperty.call(options, 'view')
      ? options.view
      : { webview: { postMessage: async () => true } },
    connected: Object.prototype.hasOwnProperty.call(options, 'connected') ? options.connected : true,
    findFilesError: options.findFilesError || null,
    attachError: options.attachError || null,
  };

  const window = {
    createQuickPick() {
      const picker = {
        canPickMany: false,
        title: undefined,
        placeholder: undefined,
        items: [],
        selectedItems: [],
        disposed: false,
        shown: false,
        handlers: {},
        onDidAccept(fn) {
          picker.handlers.accept = fn;
        },
        onDidHide(fn) {
          picker.handlers.hide = fn;
        },
        show() {
          picker.shown = true;
          pickerReadyResolve(picker);
        },
        dispose() {
          picker.disposed = true;
        },
      };
      pickers.push(picker);
      return picker;
    },
    async showWarningMessage(message) {
      warningMessages.push(message);
    },
    async showErrorMessage(message) {
      errorMessages.push(message);
    },
    async showInformationMessage(message) {
      infoMessages.push(message);
    },
  };

  const workspace = {
    async findFiles(...args) {
      findFilesCalls.push(args);
      if (state.findFilesError) throw state.findFilesError;
      return fileUris;
    },
    getWorkspaceFolder(uri) {
      const text = uri.toString();
      if (text.startsWith('file:///ws')) return { uri: fakeUri('file:///ws') };
      return undefined;
    },
  };

  const deps = {
    vscode: { window, workspace },
    editorContext: {
      async attachFiles(uris) {
        attachCalls.push(uris);
        if (state.attachError) throw state.attachError;
        return uris.map((uri, index) => ({
          id: `ctx-${index + 1}`,
          kind: 'file',
          document: { uri: uri.toString() },
          content: `content-${index + 1}`,
          createdAt: '2025-01-01T00:00:00.000Z',
        }));
      },
    },
    coordinator: {
      async request(webview, text) {
        requests.push({ webview, text });
      },
    },
    formatFileAttachment(attachment, uri) {
      return `[file:${uri.toString()}]`;
    },
    waitForResolvedView: async () => {
      waitCalls.push(1);
      return state.view;
    },
    ensureConnected: async () => state.connected,
    loc: defaultLoc,
    focusedComposerWebview: () => state.focusedWebview,
  };

  return { deps, state, pickerReady };
}

async function runCommand(harness) {
  const command = createCtrlIEditCommand(harness.deps);
  const pending = command();
  const picker = await harness.pickerReady;
  return { pending, picker };
}

test('createCtrlIEditCommand validates required dependencies', () => {
  assert.throws(() => createCtrlIEditCommand({}), TypeError);
  assert.throws(() => createCtrlIEditCommand({
    vscode: { window: {}, workspace: {} },
    editorContext: {},
    coordinator: {},
    formatFileAttachment() {},
    waitForResolvedView() {},
    ensureConnected() {},
  }), TypeError);
});

test('factory has no module-level or creation-time side effects', () => {
  const harness = createHarness();
  const command = createCtrlIEditCommand(harness.deps);

  assert.strictEqual(typeof command, 'function');
  assert.strictEqual(harness.state.findFilesCalls.length, 0);
  assert.strictEqual(harness.state.pickers.length, 0);
  assert.strictEqual(harness.state.requests.length, 0);
});

test('Ctrl+I picker is bounded, multi-select, and labelled with file name + relative path', async () => {
  const harness = createHarness();
  const { pending, picker } = await runCommand(harness);

  assert.strictEqual(picker.canPickMany, true);
  assert.strictEqual(picker.items.length, 2);
  assert.deepStrictEqual(picker.items.map((item) => item.label), ['a.ts', 'b.ts']);
  assert.deepStrictEqual(picker.items.map((item) => item.description), ['a.ts', 'b.ts']);
  assert.deepStrictEqual(harness.state.findFilesCalls, [['**/*', undefined, CTRLI_MAX_FILES]]);

  picker.handlers.hide();
  await pending;
});

test('Ctrl+I sends a multi-file context block through the coordinator', async () => {
  const harness = createHarness();
  const { pending, picker } = await runCommand(harness);

  picker.selectedItems = picker.items.slice();
  picker.handlers.accept();
  await pending;

  assert.strictEqual(harness.state.requests.length, 1);
  assert.strictEqual(harness.state.requests[0].webview, harness.state.focusedWebview);
  assert.strictEqual(
    harness.state.requests[0].text,
    'DSH: editing context (2 files)\n[file:file:///ws/a.ts]\n[file:file:///ws/b.ts]'
  );
  assert.strictEqual(harness.state.attachCalls.length, 1);
  assert.deepStrictEqual(harness.state.attachCalls[0].map((uri) => uri.toString()), [
    'file:///ws/a.ts',
    'file:///ws/b.ts',
  ]);
  assert.deepStrictEqual(harness.state.infoMessages, ['DSH: editing context sent to the DSH conversation']);
  assert.deepStrictEqual(harness.state.warningMessages, []);
  assert.deepStrictEqual(harness.state.errorMessages, []);
});

test('Ctrl+I prefers the focused composer webview and never resolves the sidebar when it exists', async () => {
  const focusedWebview = { postMessage: async () => true };
  const harness = createHarness({ focusedWebview });
  const { pending, picker } = await runCommand(harness);

  picker.selectedItems = picker.items.slice();
  picker.handlers.accept();
  await pending;

  assert.strictEqual(harness.state.requests.length, 1);
  assert.strictEqual(harness.state.requests[0].webview, focusedWebview);
  assert.strictEqual(harness.state.waitCalls.length, 0);
});

test('Ctrl+I falls back to waitForResolvedView when no focused composer exists', async () => {
  const harness = createHarness({ focusedWebview: null });
  const { pending, picker } = await runCommand(harness);

  picker.selectedItems = picker.items.slice();
  picker.handlers.accept();
  await pending;

  assert.strictEqual(harness.state.waitCalls.length, 1);
  assert.strictEqual(harness.state.requests.length, 1);
  assert.strictEqual(harness.state.requests[0].webview, harness.state.view.webview);
});

test('Ctrl+I shows an error and does not send when no webview is available', async () => {
  const harness = createHarness({ focusedWebview: null, view: null });
  const { pending, picker } = await runCommand(harness);

  picker.selectedItems = picker.items.slice();
  picker.handlers.accept();
  await pending;

  assert.strictEqual(harness.state.requests.length, 0);
  assert.deepStrictEqual(harness.state.errorMessages, ['DSH sidebar is unavailable']);
  assert.deepStrictEqual(harness.state.infoMessages, []);
});

test('Ctrl+I shows an error and does not send when DSH is unavailable', async () => {
  const harness = createHarness({ connected: false });
  const { pending, picker } = await runCommand(harness);

  picker.selectedItems = picker.items.slice();
  picker.handlers.accept();
  await pending;

  assert.strictEqual(harness.state.requests.length, 0);
  assert.deepStrictEqual(harness.state.errorMessages, ['DSH: unavailable']);
  assert.deepStrictEqual(harness.state.infoMessages, []);
});

test('Ctrl+I rejects more than 8 picked files with a warning and never sends', async () => {
  const files = Array.from({ length: 9 }, (_, index) => fakeUri(`file:///ws/f${index}.ts`));
  const harness = createHarness({ files });
  const { pending, picker } = await runCommand(harness);

  picker.selectedItems = picker.items.slice();
  picker.handlers.accept();
  await pending;

  assert.strictEqual(harness.state.requests.length, 0);
  assert.strictEqual(harness.state.attachCalls.length, 0);
  assert.deepStrictEqual(harness.state.warningMessages, [
    `DSH: editing context supports up to ${CTRLI_MAX_PICKED_FILES} files`,
  ]);
  assert.deepStrictEqual(harness.state.infoMessages, []);
  assert.deepStrictEqual(harness.state.errorMessages, []);
});

test('Ctrl+I cancel via onDidHide silently never sends', async () => {
  const harness = createHarness();
  const { pending, picker } = await runCommand(harness);

  picker.handlers.hide();
  await pending;

  assert.strictEqual(harness.state.requests.length, 0);
  assert.strictEqual(harness.state.attachCalls.length, 0);
  assert.deepStrictEqual(harness.state.infoMessages, []);
  assert.deepStrictEqual(harness.state.warningMessages, []);
  assert.deepStrictEqual(harness.state.errorMessages, []);
  assert.strictEqual(picker.disposed, true);
});

test('Ctrl+I accept with an empty selection silently never sends', async () => {
  const harness = createHarness();
  const { pending, picker } = await runCommand(harness);

  picker.selectedItems = [];
  picker.handlers.accept();
  await pending;

  assert.strictEqual(harness.state.requests.length, 0);
  assert.strictEqual(harness.state.attachCalls.length, 0);
  assert.deepStrictEqual(harness.state.infoMessages, []);
  assert.deepStrictEqual(harness.state.warningMessages, []);
  assert.deepStrictEqual(harness.state.errorMessages, []);
  assert.strictEqual(picker.disposed, true);
});

test('Ctrl+I times out after 120s without sending and disposes the picker', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const harness = createHarness();
  const { pending, picker } = await runCommand(harness);

  t.mock.timers.tick(CTRLI_TIMEOUT_MS);
  await pending;

  assert.strictEqual(harness.state.requests.length, 0);
  assert.strictEqual(harness.state.attachCalls.length, 0);
  assert.deepStrictEqual(harness.state.infoMessages, []);
  assert.deepStrictEqual(harness.state.warningMessages, []);
  assert.deepStrictEqual(harness.state.errorMessages, []);
  assert.strictEqual(picker.disposed, true);
});

test('Ctrl+I surfaces attach failures without sending', async () => {
  const harness = createHarness({ attachError: new Error('VSCODE_URI_OUTSIDE_WORKSPACE') });
  const { pending, picker } = await runCommand(harness);

  picker.selectedItems = picker.items.slice();
  picker.handlers.accept();
  await pending;

  assert.strictEqual(harness.state.requests.length, 0);
  assert.deepStrictEqual(harness.state.errorMessages, [
    'DSH: editing context failed: VSCODE_URI_OUTSIDE_WORKSPACE',
  ]);
  assert.deepStrictEqual(harness.state.infoMessages, []);
});
