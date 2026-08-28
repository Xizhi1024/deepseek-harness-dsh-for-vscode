'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ONBOARDING_DONE_KEY,
  isProfileNameValid,
  runOnboardingWizard,
  maybeOnboard,
} = require('../../src/onboarding');
const { activateWithDependencies, deactivate } = require('../../src/extension');

const FEATURE_SWITCHES = [
  { id: 'clipboard-bridge', label: 'Clipboard bridge' },
  { id: 'thread-attachment', label: 'Add to DSH thread' },
  { id: 'editor-links', label: 'Editor links (Read…)' },
  { id: 'statusbar-basic', label: 'Status bar indicator' },
  { id: 'theme-follow', label: 'Theme follow (dark/light)' },
];

function identityLoc(template, params = {}) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? `{${key}}`));
}

function disposable() {
  return { dispose() {} };
}

function tick(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One comprehensive fake VS Code host with scriptable QuickPick / InputBox
 * screens, scriptable showInformationMessage, a recording configuration store
 * and a command map — enough for both the direct wizard tests and the
 * activateWithDependencies integration tests.
 */
function makeFakeVscode({
  globalStateValue,
  infoResult,
  extraConfig = {},
} = {}) {
  const commands = new Map();
  const registrations = {};
  const uiCalls = [];
  const infos = [];
  const updates = [];
  const config = {
    host: '127.0.0.1',
    port: 3080,
    autoStart: false,
    closePolicy: 'onVscodeExit',
    'home.mode': 'isolated',
    ...extraConfig,
  };
  const getConfig = (key, fallback) => (key in config ? config[key] : fallback);

  const makePick = () => ({
    title: '',
    placeholder: '',
    canPickMany: false,
    items: [],
    value: '',
    selectedItems: [],
    activeItems: [],
    validationMessage: '',
    _accept: null,
    _hide: null,
    _change: null,
    _disposed: false,
    onDidAccept(cb) { this._accept = cb; return disposable(); },
    onDidHide(cb) { this._hide = cb; return disposable(); },
    onDidChangeValue(cb) { this._change = cb; return disposable(); },
    show() { uiCalls.push({ kind: 'pick', control: this }); },
    dispose() { this._disposed = true; },
  });
  const makeInput = () => ({
    title: '',
    prompt: '',
    value: '',
    placeholder: '',
    validationMessage: '',
    _accept: null,
    _hide: null,
    _change: null,
    _disposed: false,
    onDidAccept(cb) { this._accept = cb; return disposable(); },
    onDidHide(cb) { this._hide = cb; return disposable(); },
    onDidChangeValue(cb) { this._change = cb; return disposable(); },
    show() { uiCalls.push({ kind: 'input', control: this }); },
    dispose() { this._disposed = true; },
  });

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
      constructor(sl, sc, el, ec) {
        this.start = { line: sl, character: sc };
        this.end = { line: el, character: ec };
      }
    },
    StatusBarAlignment: { Right: 2 },
    ConfigurationTarget: { Global: 1 },
    Uri: {
      file(fsPath) { return { fsPath }; },
      joinPath(base, child) { return { fsPath: path.join(base.fsPath, child) }; },
      parse(value) { return { value, toString: () => value }; },
    },
    window: {
      activeTextEditor: null,
      createQuickPick: makePick,
      createInputBox: makeInput,
      createStatusBarItem() { return { show() {}, text: '', tooltip: '' }; },
      onDidChangeActiveTextEditor() { return disposable(); },
      onDidChangeTextEditorSelection() { return disposable(); },
      registerWebviewViewProvider(id, provider, options) {
        registrations.webview = { id, provider, options };
        return disposable();
      },
      async showErrorMessage() {},
      async showInformationMessage(message, ...buttons) {
        infos.push({ message, buttons });
        return infoResult;
      },
      async showTextDocument() {},
      async showWarningMessage() {},
    },
    workspace: {
      workspaceFolders: [],
      isTrusted: true,
      getConfiguration() {
        return {
          get: getConfig,
          async update(key, value, target) {
            updates.push({ key, value, target });
            config[key] = value;
          },
        };
      },
      getWorkspaceFolder() { return undefined; },
      onDidChangeConfiguration() { return disposable(); },
      onDidChangeWorkspaceFolders() { return disposable(); },
      async openTextDocument() { return { uri: {} }; },
    },
  };

  return {
    api,
    commands,
    registrations,
    uiCalls,
    infos,
    updates,
    config,
    getConfig,
  };
}

/** Build the runOnboardingWizard workspace adapter for a fake host. */
function makeWorkspaceAdapter(host, settings = {}, featureSwitches = FEATURE_SWITCHES) {
  const updateRecord = [];
  const adapter = {
    updateRecord,
    vscode: host.api,
    loc: identityLoc,
    featureSwitches,
    getSetting(key, fallback) {
      return key in settings ? settings[key] : fallback;
    },
    async updateSetting(key, value) {
      updateRecord.push({ key, value });
      settings[key] = value;
    },
  };
  return adapter;
}

/** Drive one quick pick screen: select the given item index(es) and accept. */
async function acceptPick(host, index = 0) {
  const screen = host.uiCalls.shift();
  assert.ok(screen, 'expected a quick pick screen to be shown');
  assert.strictEqual(screen.kind, 'pick');
  if (Array.isArray(index)) {
    screen.control.selectedItems = index.map((i) => screen.control.items[i]);
  } else {
    screen.control.selectedItems = [screen.control.items[index]];
  }
  screen.control._accept();
  await tick();
  return screen.control;
}

/** Drive one input screen: set value, validate on change, accept. */
async function acceptInput(host, value) {
  const screen = host.uiCalls.shift();
  assert.ok(screen, 'expected an input box screen to be shown');
  assert.strictEqual(screen.kind, 'input');
  screen.control.value = value;
  screen.control._change(value);
  screen.control._accept();
  await tick();
  return screen.control;
}

/** Drive one screen by dismissing it (Esc → onDidHide). */
async function skipScreen(host) {
  const screen = host.uiCalls.shift();
  assert.ok(screen, 'expected a screen to be shown');
  screen.control._hide();
  await tick();
  return screen.control;
}

test('isProfileNameValid accepts the managed profile pattern and rejects dot/separator abuse', () => {
  assert.equal(isProfileNameValid('web'), true);
  assert.equal(isProfileNameValid('dev'), true);
  assert.equal(isProfileNameValid('a-1.b_c'), true);
  assert.equal(isProfileNameValid('.hidden'), true);
  assert.equal(isProfileNameValid('x'.repeat(64)), true);
  assert.equal(isProfileNameValid(''), false);
  assert.equal(isProfileNameValid('.'), false);
  assert.equal(isProfileNameValid('..'), false);
  assert.equal(isProfileNameValid('x'.repeat(65)), false);
  assert.equal(isProfileNameValid('bad/name'), false);
  assert.equal(isProfileNameValid('bad\\name'), false);
  assert.equal(isProfileNameValid('中文'), false);
  assert.equal(isProfileNameValid('a b'), false);
  assert.equal(isProfileNameValid(null), false);
  assert.equal(isProfileNameValid(undefined), false);
});

test('maybeOnboard does not prompt when the globalState gate is already truthy', async () => {
  for (const doneValue of [true, 'never']) {
    const host = makeFakeVscode();
    const context = {
      globalState: {
        get: () => doneValue,
        async update() { throw new Error('must not write when already done'); },
      },
    };
    const result = await maybeOnboard({
      vscode: host.api,
      context,
      loc: identityLoc,
      workspace: makeWorkspaceAdapter(host),
    });
    assert.deepStrictEqual(result, { prompted: false, reason: 'already-done' });
    assert.strictEqual(host.infos.length, 0, 'no prompt may be shown once done');
  }
});

test('maybeOnboard writes the exact dsh.onboarding.done=never key on Never', async () => {
  const host = makeFakeVscode({ infoResult: 'Never' });
  let wrote = null;
  const context = {
    globalState: {
      get: () => undefined,
      async update(key, value) { wrote = { key, value }; },
    },
  };
  const result = await maybeOnboard({
    vscode: host.api,
    context,
    loc: identityLoc,
    workspace: makeWorkspaceAdapter(host),
  });
  assert.deepStrictEqual(result, { prompted: true, choice: 'never' });
  assert.deepStrictEqual(wrote, { key: 'dsh.onboarding.done', value: 'never' });
  assert.strictEqual(host.infos.length, 1);
  assert.ok(host.infos[0].message.includes('set it up'));
  assert.deepStrictEqual(host.infos[0].buttons, ['Set up', 'Not now', 'Never']);
});

test('maybeOnboard leaves the gate untouched on Not now', async () => {
  const host = makeFakeVscode({ infoResult: 'Not now' });
  let wrote = null;
  const context = {
    globalState: {
      get: () => undefined,
      async update(key, value) { wrote = { key, value }; },
    },
  };
  const result = await maybeOnboard({
    vscode: host.api,
    context,
    loc: identityLoc,
    workspace: makeWorkspaceAdapter(host),
  });
  assert.deepStrictEqual(result, { prompted: true, choice: 'not-now' });
  assert.strictEqual(wrote, null, 'Not now must not touch globalState');
});

test('wizard flow writes each accepted step and records done on confirmation', async () => {
  const host = makeFakeVscode();
  const settings = {
    profile: 'web',
    autoStart: true,
    closePolicy: 'onVscodeExit',
    'features.clipboard-bridge': true,
    'features.thread-attachment': true,
    'features.editor-links': false,
    'features.statusbar-basic': false,
    'features.theme-follow': true,
  };
  const workspace = makeWorkspaceAdapter(host, settings);
  let wroteDone = null;
  const context = {
    globalState: {
      get: () => undefined,
      async update(key, value) { wroteDone = { key, value }; },
    },
  };

  const promise = runOnboardingWizard({ context, workspace });

  // Step 1 Profile: enter dev
  await acceptInput(host, 'dev');
  // Step 2 Auto-start: keep on (item 0 = on)
  await acceptPick(host, 0);
  // Step 3 Close policy: onViewClose (item 1)
  await acceptPick(host, 1);
  // Step 4 Watchdog & roadmap info: anything
  await acceptPick(host, 0);
  // Step 5 Features: multi-select → re-enable editor-links, disable theme-follow
  // (items order follows featureSwitches)
  await acceptPick(host, [0, 1, 2, 3]); // select clipboard, thread, editor-links, statusbar
  // Step 6 Summary: confirm
  await acceptPick(host, 0);

  const result = await promise;
  assert.deepStrictEqual(result, { completed: true, changed: [
    'profile', 'autoStart', 'closePolicy',
    'features.editor-links', 'features.statusbar-basic', 'features.theme-follow',
  ] });

  assert.deepStrictEqual(workspace.updateRecord, [
    { key: 'profile', value: 'dev' },
    { key: 'autoStart', value: true },
    { key: 'closePolicy', value: 'onViewClose' },
    { key: 'features.editor-links', value: true },
    { key: 'features.statusbar-basic', value: true },
    { key: 'features.theme-follow', value: false },
  ]);
  assert.deepStrictEqual(wroteDone, { key: 'dsh.onboarding.done', value: true });
  assert.ok(host.infos.some((info) => info.message.includes('DSH setup complete')));
});

test('wizard feature step defaults to current values and skips unchanged switches', async () => {
  const host = makeFakeVscode();
  const settings = {
    'features.clipboard-bridge': true,
    'features.thread-attachment': false,
  };
  const workspace = makeWorkspaceAdapter(host, settings);
  let wroteDone = false;
  const context = {
    globalState: {
      get: () => undefined,
      async update() { wroteDone = true; },
    },
  };

  const promise = runOnboardingWizard({ context, workspace });

  await acceptInput(host, 'web'); // profile, same value
  await acceptPick(host, 0);
  await acceptPick(host, 0);
  await acceptPick(host, 0);
  // Feature step: keep exactly the defaults (current values) -> no writes
  const featureScreen = host.uiCalls.shift();
  assert.strictEqual(featureScreen.kind, 'pick');
  assert.strictEqual(featureScreen.control.canPickMany, true);
  assert.deepStrictEqual(
    featureScreen.control.items.map((item) => ({ id: item.id, picked: item.picked })),
    [
      { id: 'clipboard-bridge', picked: true },
      { id: 'thread-attachment', picked: false },
      { id: 'editor-links', picked: true },
      { id: 'statusbar-basic', picked: true },
      { id: 'theme-follow', picked: true },
    ]
  );
  // Select exactly the current defaults (clipboard on, thread off, rest on):
  // the selection equals the defaults so nothing must be written back.
  featureScreen.control.selectedItems = [
    featureScreen.control.items[0], // clipboard-bridge (on)
    featureScreen.control.items[2], // editor-links (on)
    featureScreen.control.items[3], // statusbar-basic (on)
    featureScreen.control.items[4], // theme-follow (on)
  ];
  featureScreen.control._accept();
  await tick();

  const summary = await acceptPick(host, 0);
  const result = await promise;
  assert.strictEqual(result.completed, true);
  // No feature writes because the selection equals the current values.
  assert.ok(!workspace.updateRecord.some((entry) => entry.key.startsWith('features.')));
  assert.ok(wroteDone);
  assert.ok(summary.items.some((item) => item.label.includes('Features:')));
});

test('Esc on every step keeps current values and the wizard still finishes', async () => {
  const host = makeFakeVscode();
  const settings = { autoStart: false, closePolicy: 'never' };
  const workspace = makeWorkspaceAdapter(host, settings);
  let wroteDone = false;
  const context = {
    globalState: {
      get: () => undefined,
      async update() { wroteDone = true; },
    },
  };

  const promise = runOnboardingWizard({ context, workspace });

  await skipScreen(host); // profile
  await skipScreen(host); // auto-start
  await skipScreen(host); // close policy
  await skipScreen(host); // watchdog & roadmap
  await skipScreen(host); // features
  await acceptPick(host, 0); // summary confirms

  const result = await promise;
  assert.deepStrictEqual(result, { completed: true, changed: [] });
  assert.deepStrictEqual(workspace.updateRecord, [], 'skipped steps must not write settings');
  assert.strictEqual(wroteDone, true);
});

test('cancelling the final summary does not mark onboarding done', async () => {
  const host = makeFakeVscode();
  const workspace = makeWorkspaceAdapter(host, {});
  let wroteDone = false;
  const context = {
    globalState: {
      get: () => undefined,
      async update() { wroteDone = true; },
    },
  };

  const promise = runOnboardingWizard({ context, workspace });

  await acceptInput(host, 'dev');
  await acceptPick(host, 0);
  await acceptPick(host, 0);
  await acceptPick(host, 0);
  await acceptPick(host, [0, 1, 2, 3, 4]);
  await skipScreen(host); // summary Esc

  const result = await promise;
  assert.strictEqual(result.completed, false);
  assert.strictEqual(wroteDone, false, 'cancelled summary must not write done');
  assert.ok(workspace.updateRecord.some((entry) => entry.key === 'profile'));
});

test('profile input validates inline and keeps the box open on invalid input', async () => {
  const host = makeFakeVscode();
  const workspace = makeWorkspaceAdapter(host, {});
  const context = {
    globalState: { get: () => undefined, async update() {} },
  };

  const promise = runOnboardingWizard({ context, workspace });

  const profileScreen = host.uiCalls.shift();
  assert.strictEqual(profileScreen.kind, 'input');
  // Invalid value: accept must not advance (validation message set).
  profileScreen.control.value = 'bad/name';
  profileScreen.control._change('bad/name');
  profileScreen.control._accept();
  assert.ok(profileScreen.control.validationMessage, 'invalid profile must set a validation message');
  assert.strictEqual(host.uiCalls.length, 0, 'invalid input must keep the wizard on the profile step');

  // Correct the value and accept again.
  profileScreen.control.value = 'dev';
  profileScreen.control._change('dev');
  profileScreen.control._accept();
  await tick();

  // The wizard advances to auto-start afterwards.
  const next = host.uiCalls.shift();
  assert.ok(next, 'valid profile input must advance the wizard');
  assert.strictEqual(next.kind, 'pick');
  assert.ok(next.control.title.includes('Auto-start'));
});

test('B5: ctrl-k appears with a description and one checkbox enables the feature + binds Ctrl+K', async () => {
  const host = makeFakeVscode();
  const featureSwitches = [
    ...FEATURE_SWITCHES,
    { id: 'ctrl-k', label: 'Edit with DSH (Ctrl+K)', defaultEnabled: false },
  ];
  // Everything except ctrl-k already sits at its target value (off), so the
  // only possible write from the feature step is the ctrl-k toggle itself.
  const settings = {
    'features.clipboard-bridge': false,
    'features.thread-attachment': false,
    'features.editor-links': false,
    'features.statusbar-basic': false,
    'features.theme-follow': false,
  };
  const workspace = makeWorkspaceAdapter(host, settings, featureSwitches);
  const context = {
    globalState: { get: () => undefined, async update() {} },
  };

  const promise = runOnboardingWizard({ context, workspace });

  await skipScreen(host); // profile
  await skipScreen(host); // auto-start
  await skipScreen(host); // close policy
  await skipScreen(host); // watchdog & roadmap
  const featureScreen = host.uiCalls.shift();
  assert.strictEqual(featureScreen.kind, 'pick');
  const ctrlKItem = featureScreen.control.items.find((item) => item.id === 'ctrl-k');
  assert.ok(ctrlKItem, 'ctrl-k must appear in the feature step');
  assert.strictEqual(ctrlKItem.picked, false, 'ctrl-k is opt-in: never pre-picked');
  assert.ok(
    typeof ctrlKItem.description === 'string' && ctrlKItem.description.includes('Ctrl+K'),
    'the ctrl-k item must carry a description explaining that it also activates the Ctrl+K keybinding'
  );
  // One interaction: checking the single ctrl-k box.
  featureScreen.control.selectedItems = [ctrlKItem];
  featureScreen.control._accept();
  await tick();
  await acceptPick(host, 0); // summary confirms

  const result = await promise;
  assert.strictEqual(result.completed, true);
  assert.ok(result.changed.includes('features.ctrl-k'));
  assert.deepStrictEqual(workspace.updateRecord, [
    { key: 'features.ctrl-k', value: true },
  ], 'checking ctrl-k once must write exactly features.ctrl-k=true — the when-gated keybinding activates with it');
});

test('activation registers dsh.onboarding last and the command re-opens the wizard', async () => {
  const fake = makeFakeVscode({ extraConfig: { autoStart: false } });
  const globalStateValue = 'never';
  let doneWritten = null;
  const context = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-onboarding-act-${process.pid}`) },
    globalState: {
      get: () => globalStateValue,
      async update(key, value) { doneWritten = { key, value }; },
    },
    subscriptions: [],
  };
  const manager = {
    cancelPending() {},
    hasOwnedChild() { return false; },
    async stop() {},
  };

  await activateWithDependencies(context, {
    vscode: fake.api,
    async startTextDocumentBridge() { return { env: {}, async close() {} }; },
    async startVersionedBridge() { return { env: {}, async close() {} }; },
    createServerManager() { return manager; },
    async ensureManagedRuntime() { throw new Error('autoStart=false must not resolve runtime'); },
  });

  assert.ok(fake.commands.has('dsh.onboarding'), 'dsh.onboarding command must be registered');
  assert.strictEqual([...fake.commands.keys()].at(-2), 'dsh.onboarding');
  // 'never' suppresses the first-run prompt.
  assert.strictEqual(fake.infos.length, 0);

  // Invoke the command: the wizard runs and writes through the global target.
  const promise = fake.commands.get('dsh.onboarding')();
  await acceptInput(fake, 'dev');
  await acceptPick(fake, 0);
  await acceptPick(fake, 1);
  await acceptPick(fake, 0);
  await acceptPick(fake, [0, 1, 2, 3, 4]);
  await acceptPick(fake, 0);
  const result = await promise;
  assert.strictEqual(result.completed, true);
  assert.ok(fake.updates.some((u) => u.key === 'profile' && u.value === 'dev' && u.target === true));
  assert.ok(fake.updates.some((u) => u.key === 'closePolicy' && u.value === 'onViewClose'));
  assert.deepStrictEqual(doneWritten, { key: 'dsh.onboarding.done', value: true });

  await deactivate();
});

test('activation prompts once on first run and Not now leaves the gate unset', async () => {
  const fake = makeFakeVscode({ infoResult: 'Not now' });
  const writes = [];
  const context = {
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `dsh-onboarding-prompt-${process.pid}`) },
    globalState: {
      get: () => undefined,
      async update(key, value) { writes.push({ key, value }); },
    },
    subscriptions: [],
  };
  const manager = {
    cancelPending() {},
    hasOwnedChild() { return false; },
    async stop() {},
  };

  await activateWithDependencies(context, {
    vscode: fake.api,
    async startTextDocumentBridge() { return { env: {}, async close() {} }; },
    async startVersionedBridge() { return { env: {}, async close() {} }; },
    createServerManager() { return manager; },
    async ensureManagedRuntime() { throw new Error('autoStart=false must not resolve runtime'); },
  });

  await tick();
  assert.strictEqual(fake.infos.length, 1, 'first activation must show the onboarding prompt');
  assert.ok(fake.infos[0].message.includes('DSH is ready'));
  assert.ok(
    !writes.some((entry) => entry.key === ONBOARDING_DONE_KEY),
    'Not now must not write the onboarding done gate'
  );

  await deactivate();
});

test('Set up from the first-run prompt drives the whole wizard to completion', async () => {
  const fake = makeFakeVscode({ infoResult: 'Set up' });
  let wroteDone = null;
  const context = {
    globalState: {
      get: () => undefined,
      async update(key, value) { wroteDone = { key, value }; },
    },
  };
  const workspace = makeWorkspaceAdapter(fake, {
    'features.editor-links': true,
  });

  const promise = maybeOnboard({
    vscode: fake.api,
    context,
    loc: identityLoc,
    workspace,
  });

  // The prompt resolves on a microtask before the wizard's first screen shows.
  await tick();
  // Prompt shown first, then the wizard's six steps.
  let next = fake.uiCalls.shift();
  assert.ok(next, 'wizard must start after Set up');
  assert.strictEqual(next.kind, 'input');
  next.control.value = 'prod';
  next.control._change('prod');
  next.control._accept();
  await tick();
  await acceptPick(fake, 0);
  await acceptPick(fake, 0);
  await acceptPick(fake, 0);
  await acceptPick(fake, [0, 1, 2, 3, 4]);
  await acceptPick(fake, 0);

  const result = await promise;
  assert.deepStrictEqual(result, { prompted: true, choice: 'set-up' });
  assert.deepStrictEqual(wroteDone, { key: 'dsh.onboarding.done', value: true });
  assert.ok(workspace.updateRecord.some((entry) => entry.key === 'profile' && entry.value === 'prod'));
});
