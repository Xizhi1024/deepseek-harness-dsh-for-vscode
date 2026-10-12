'use strict';

// Known-issue #1 fix (plugin bridge endpoints 404 on unconfigured instances):
// the extension half of the fix — a per-window configure token for the DSH
// plugin's POST /api/vscode/configure route, injected into every spawn env,
// recorded in the instance registry (next to authToken) so an adopting window
// can configure a shared instance it did not spawn, and carried on every
// RunningServer handle.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ServerManager } = require('../../src/serverManager');

test('configureToken() is a stable 64-hex secret per manager', () => {
  const manager = new ServerManager();
  const first = manager.configureToken();
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(manager.configureToken(), first);
  assert.notEqual(new ServerManager().configureToken(), first);
});

test('_buildSpawnEnv injects DSH_VSCODE_CONFIGURE_TOKEN', () => {
  const manager = new ServerManager();
  const env = manager._buildSpawnEnv();
  assert.equal(env.DSH_VSCODE_CONFIGURE_TOKEN, manager.configureToken());
  // setSpawnEnv merges must not clobber the configure token.
  manager.setSpawnEnv({ DSH_LM_BRIDGE_TOKEN: 'lm' });
  assert.equal(manager._buildSpawnEnv().DSH_VSCODE_CONFIGURE_TOKEN, manager.configureToken());
});

test('_finalizeReady records configureToken in the registry entry and the handle', () => {
  const registryFile = path.join(os.tmpdir(), `dsh-registry-cfg-${process.pid}-${Date.now()}.json`);
  const manager = new ServerManager();
  const statuses = [];
  manager.onStatus((status) => statuses.push(status));
  const server = manager._finalizeReady('127.0.0.1', 39999, '/tmp', 424242, registryFile, null, 'launch-tok');
  try {
    assert.equal(server.configureToken, manager.configureToken());
    const entries = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    const entry = entries.find((e) => e.port === 39999);
    assert.ok(entry, 'registry entry written');
    assert.equal(entry.configureToken, manager.configureToken());
    assert.equal(entry.authToken, 'launch-tok');
  } finally {
    try { fs.unlinkSync(registryFile); } catch { /* tmp cleanup */ }
  }
});

test('_reuseHandle carries the adopted instance configureToken from the registry entry', () => {
  const manager = new ServerManager();
  const handle = manager._reuseHandle('127.0.0.1', 39998, 'launch-tok', {
    pid: 424241,
    managed: true,
    configureToken: 'adopted-cfg-tok',
  });
  assert.equal(handle.owned, false);
  assert.equal(handle.managed, true);
  assert.equal(handle.authToken, 'launch-tok');
  assert.equal(handle.configureToken, 'adopted-cfg-tok');
  // No registry entry → no configure token on the handle (cannot configure).
  const foreign = manager._reuseHandle('127.0.0.1', 39997, null, null);
  assert.equal(foreign.configureToken, undefined);
});
