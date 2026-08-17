'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createCleanupOrphansCommand } = require('../../src/commands/cleanupOrphans');

function defaultLoc(template, params = {}) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? `{${key}}`));
}

function fakeVscode(entries) {
  const info = [];
  const errors = [];
  let picker = null;
  const api = {
    window: {
      infoMessages: info,
      errorMessages: errors,
      async showInformationMessage(message) {
        info.push(message);
      },
      async showErrorMessage(message) {
        errors.push(message);
      },
      createQuickPick() {
        picker = {
          items: [],
          selectedItems: [],
          canPickMany: false,
          placeholder: '',
          _accept: null,
          _hide: null,
          onDidAccept(callback) {
            this._accept = callback;
          },
          onDidHide(callback) {
            this._hide = callback;
          },
          show() {},
          dispose() {},
        };
        return picker;
      },
    },
  };
  return { api, info, errors, picker: () => picker };
}

function makeCommand(overrides = {}) {
  const state = {
    entries: [],
    probes: {},
    terminated: [],
    removed: [],
    ownedPid: null,
  };
  const fake = fakeVscode();
  const deps = {
    vscode: fake.api,
    registryFilePath: () => '/tmp/dsh-instances.json',
    listAliveEntries: () => state.entries,
    async probeEntry(host, port) {
      return state.probes[`${host}:${port}`] || { reachable: false, reason: 'refused' };
    },
    async terminate(pid) {
      state.terminated.push(pid);
    },
    removeEntries(file, pids) {
      state.removed.push({ file, pids });
    },
    ownedPid: () => state.ownedPid,
    loc: defaultLoc,
    ...overrides,
  };
  return { deps, state, command: createCleanupOrphansCommand(deps), picker: fake.picker, info: fake.info, errors: fake.errors };
}

test('cleanupOrphans reports no orphans when the registry has no live entries', async () => {
  const { command, info } = makeCommand();
  await command();
  assert.deepStrictEqual(info, ['No orphan DSH servers were found']);
});

test('cleanupOrphans excludes this window child and only terminates verified DSH endpoints', async () => {
  const { command, deps, state, picker } = makeCommand();
  state.entries = [
    { pid: 100, port: 4301, host: '127.0.0.1', cwd: '/ws' },
    { pid: 200, port: 4302, host: '127.0.0.1', cwd: null },
    { pid: 300, port: 4303, host: '127.0.0.1', cwd: null },
  ];
  state.ownedPid = 100;
  state.probes['127.0.0.1:4302'] = { reachable: true, isDsh: true };
  state.probes['127.0.0.1:4303'] = { reachable: false, reason: 'timeout' };

  const run = command();
  await new Promise((resolve) => setImmediate(resolve));
  const current = picker();
  assert.ok(current, 'command must show a QuickPick');
  assert.strictEqual(current.canPickMany, true);
  assert.strictEqual(current.items.length, 2, 'own child must be excluded');
  assert.strictEqual(current.items[0].action, 'stop');
  assert.strictEqual(current.items[1].action, 'record');

  current.selectedItems = [current.items[0], current.items[1]];
  current._accept();
  await run;

  assert.deepStrictEqual(state.terminated, [200], 'only the verified DSH pid may be killed');
  assert.deepStrictEqual(state.removed, [{ file: '/tmp/dsh-instances.json', pids: [200, 300] }]);
  assert.deepStrictEqual(deps.vscode.window.infoMessages, [
    'Cleaned up 1 orphan DSH process(es) and 2 registry record(s)',
  ]);
});

test('cleanupOrphans hides dismissal and never kills record-only selections', async () => {
  const { command, deps, state, picker } = makeCommand();
  state.entries = [{ pid: 400, port: 4304, host: '127.0.0.1', cwd: null }];
  state.probes['127.0.0.1:4304'] = { reachable: false, reason: 'timeout' };

  const run = command();
  await new Promise((resolve) => setImmediate(resolve));
  const current = picker();
  current.selectedItems = [];
  current._hide();
  await run;

  assert.deepStrictEqual(state.terminated, []);
  assert.deepStrictEqual(state.removed, []);
  assert.deepStrictEqual(deps.vscode.window.infoMessages, []);
});

test('cleanupOrphans surfaces failures without killing', async () => {
  const { command, deps } = makeCommand({
    listAliveEntries: () => {
      throw new Error('registry unreadable');
    },
  });
  await command();
  assert.deepStrictEqual(deps.vscode.window.errorMessages, [
    'Cleanup orphan DSH servers failed: registry unreadable',
  ]);
});

test('createCleanupOrphansCommand validates required dependencies', () => {
  assert.throws(() => createCleanupOrphansCommand({}), TypeError);
});
