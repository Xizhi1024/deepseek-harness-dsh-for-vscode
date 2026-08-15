'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createExtensionBridgeHandlers,
  detectProviderStates,
  diagnosticSnapshot,
} = require('../src/providerDetector');
const { catalogSnapshot } = require('../src/capabilityCatalog');

function createFakeVscode(extensionsById = {}) {
  const opened = [];
  const executed = [];
  return {
    api: {
      extensions: {
        getExtension(providerId) {
          return extensionsById[providerId] ?? undefined;
        },
        all: Object.values(extensionsById),
        onDidChange() {
          return { dispose() {} };
        },
      },
      env: {
        async openExternal(uri) {
          opened.push(uri);
        },
      },
      Uri: {
        parse(value) {
          return { value, toString: () => value };
        },
      },
      commands: {
        async executeCommand(...args) {
          executed.push(args);
        },
      },
    },
    opened,
    executed,
  };
}

function stateFor(states, providerId) {
  return states.find((state) => state.providerId === providerId);
}

test('detectProviderStates returns exactly the catalog providers, never extras', () => {
  const fake = createFakeVscode();
  const states = detectProviderStates({ vscode: fake.api });
  const catalog = catalogSnapshot();

  assert.deepStrictEqual(states.map((state) => state.providerId), catalog.map((entry) => entry.providerId));
  for (const state of states) {
    assert.strictEqual(state.installed, false);
    assert.strictEqual(state.enabled, false);
    assert.strictEqual(state.version, undefined);
    assert.notStrictEqual(state.compatible, true);
    assert.strictEqual(state.health, 'unknown');
    assert.strictEqual(state.reason, 'interface audit pending (G3)');
  }
});

test('installed, active extension is enabled and reports packageJSON.version', () => {
  const fake = createFakeVscode({
    'ms-vscode-remote.remote-wsl': {
      isActive: true,
      packageJSON: { version: '1.2.3' },
    },
  });
  const state = stateFor(detectProviderStates({ vscode: fake.api }), 'ms-vscode-remote.remote-wsl');

  assert.strictEqual(state.installed, true);
  assert.strictEqual(state.enabled, true);
  assert.strictEqual(state.version, '1.2.3');
});

test('installed, inactive extension with command contributions is approximated as enabled', () => {
  const fake = createFakeVscode({
    'GitHub.vscode-pull-request-github': {
      isActive: false,
      packageJSON: {
        version: '0.80.0',
        contributes: { commands: [{ command: 'github.openPullRequest' }] },
      },
    },
  });
  const state = stateFor(detectProviderStates({ vscode: fake.api }), 'GitHub.vscode-pull-request-github');

  assert.strictEqual(state.installed, true);
  assert.strictEqual(state.enabled, true);
  assert.strictEqual(state.version, '0.80.0');
});

test('installed, inactive extension with view contributions is approximated as enabled', () => {
  const fake = createFakeVscode({
    'ms-vscode-remote.remote-ssh': {
      isActive: false,
      packageJSON: {
        version: '0.110.0',
        contributes: { views: { ssh: [{ id: 'sshHosts' }] } },
      },
    },
  });
  const state = stateFor(detectProviderStates({ vscode: fake.api }), 'ms-vscode-remote.remote-ssh');

  assert.strictEqual(state.installed, true);
  assert.strictEqual(state.enabled, true);
});

test('installed, inactive extension with no visible contribution is approximated as disabled', () => {
  const fake = createFakeVscode({
    'ms-vscode-remote.remote-wsl': {
      isActive: false,
      packageJSON: { version: '1.0.0', contributes: {} },
    },
  });
  const state = stateFor(detectProviderStates({ vscode: fake.api }), 'ms-vscode-remote.remote-wsl');

  assert.strictEqual(state.installed, true);
  assert.strictEqual(state.enabled, false);
  assert.strictEqual(state.reason, 'extension-disabled-or-inactive');
  assert.strictEqual(state.version, '1.0.0');
});

test('detectProviderStates re-reads vscode.extensions on every call (no cross-workspace cache)', () => {
  const byId = {
    'GitHub.vscode-pull-request-github': {
      isActive: false,
      packageJSON: {
        version: '1.0.0',
        contributes: { commands: [{ command: 'github.openPullRequest' }] },
      },
    },
  };
  const fake = createFakeVscode(byId);

  const first = stateFor(detectProviderStates({ vscode: fake.api }), 'GitHub.vscode-pull-request-github');
  assert.strictEqual(first.installed, true);

  delete byId['GitHub.vscode-pull-request-github'];
  const second = stateFor(detectProviderStates({ vscode: fake.api }), 'GitHub.vscode-pull-request-github');
  assert.strictEqual(second.installed, false);
});

test('manual-assist entries are never reported as integrated or healthy', () => {
  const catalog = catalogSnapshot();
  for (const entry of catalog) {
    assert.strictEqual(entry.integrationMode, 'manual-assist');
  }
  const fake = createFakeVscode({
    'ms-vscode-remote.remote-wsl': {
      isActive: true,
      packageJSON: { version: '1.0.0' },
    },
  });
  for (const state of detectProviderStates({ vscode: fake.api })) {
    assert.notStrictEqual(state.compatible, true);
    assert.strictEqual(state.health, 'unknown');
  }
});

test('diagnosticSnapshot exposes stable fields with live server and bridge', () => {
  const fake = createFakeVscode();
  const snapshot = diagnosticSnapshot({
    vscode: fake.api,
    config: {
      host: '127.0.0.1', port: 3080, autoStart: false, closePolicy: 'onVscodeExit',
      homeMode: 'shared', homePath: '',
    },
    home: { mode: 'shared', path: 'D:\\DSH', source: 'setting' },
    server: { owned: true, url: 'http://127.0.0.1:3080', port: 3080 },
    bridge: { port: 5678 },
    now: () => '2026-08-15T00:00:00.000Z',
  });

  assert.strictEqual(snapshot.generatedAt, '2026-08-15T00:00:00.000Z');
  assert.match(snapshot.catalogRevision, /^[a-f0-9]{64}$/);
  assert.strictEqual(snapshot.providers.length, catalogSnapshot().length);
  assert.deepStrictEqual(snapshot.config, {
    host: '127.0.0.1',
    port: 3080,
    autoStart: false,
    closePolicy: 'onVscodeExit',
    homeMode: 'shared',
    homePath: '',
  });
  assert.deepStrictEqual(snapshot.home, { mode: 'shared', path: 'D:\\DSH', source: 'setting' });
  assert.deepStrictEqual(snapshot.server, {
    available: true,
    owned: true,
    url: 'http://127.0.0.1:3080',
    port: 3080,
  });
  assert.deepStrictEqual(snapshot.bridge, { listening: true, port: 5678 });
});

test('diagnosticSnapshot reports unavailable server and bridge for null inputs', () => {
  const fake = createFakeVscode();
  const snapshot = diagnosticSnapshot({
    vscode: fake.api,
    config: {},
    server: null,
    bridge: null,
    now: () => '2026-08-15T00:00:00.000Z',
  });

  assert.deepStrictEqual(snapshot.server, {
    available: false,
    owned: false,
    url: null,
    port: null,
  });
  assert.deepStrictEqual(snapshot.bridge, { listening: false, port: null });
  assert.deepStrictEqual(snapshot.config, {
    host: null,
    port: null,
    autoStart: null,
    closePolicy: null,
    homeMode: null,
    homePath: null,
  });
  assert.deepStrictEqual(snapshot.home, { mode: null, path: null, source: null });
});

test('getProviderStates handler returns a providers array', async () => {
  const fake = createFakeVscode();
  const handlers = createExtensionBridgeHandlers({ vscode: fake.api });
  const result = await handlers['vscode/extensions/getProviderStates']({});

  assert.ok(Array.isArray(result.providers));
  assert.strictEqual(result.providers.length, catalogSnapshot().length);
});

test('openDetails opens https entries through vscode.env.openExternal', async () => {
  const fake = createFakeVscode();
  const handlers = createExtensionBridgeHandlers({ vscode: fake.api });
  const browser = catalogSnapshot().find((entry) => entry.detailsUri.startsWith('https://'));

  const result = await handlers['vscode/extensions/openDetails']({ providerId: browser.providerId });

  assert.deepStrictEqual(result, { opened: true });
  assert.strictEqual(fake.opened.length, 1);
  assert.strictEqual(fake.opened[0].value, browser.detailsUri);
  assert.strictEqual(fake.executed.length, 0);
});

test('openDetails opens vscode:extension entries through workbench.extensions.show', async () => {
  const fake = createFakeVscode();
  const handlers = createExtensionBridgeHandlers({ vscode: fake.api });
  const remoteWsl = catalogSnapshot().find((entry) => entry.providerId === 'ms-vscode-remote.remote-wsl');

  const result = await handlers['vscode/extensions/openDetails']({ providerId: remoteWsl.providerId });

  assert.deepStrictEqual(result, { opened: true });
  assert.strictEqual(fake.opened.length, 0);
  assert.deepStrictEqual(fake.executed.at(-1), ['workbench.extensions.show', remoteWsl.providerId]);
});

test('openDetails rejects providers outside the controlled catalog', async () => {
  const fake = createFakeVscode();
  const handlers = createExtensionBridgeHandlers({ vscode: fake.api });

  await assert.rejects(
    handlers['vscode/extensions/openDetails']({ providerId: 'unknown.provider' }),
    (error) => error.bridgeCode === 'VSCODE_INVALID_PARAMS'
  );
  await assert.rejects(
    handlers['vscode/extensions/openDetails']({}),
    (error) => error.bridgeCode === 'VSCODE_INVALID_PARAMS'
  );
  assert.strictEqual(fake.opened.length, 0);
  assert.strictEqual(fake.executed.length, 0);
});
