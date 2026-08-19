'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ServerManager } = require('../../src/serverManager');

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.signalCode = null;
  }
  kill() { /* no-op fake child */ }
}

function fakeLaunch() {
  return {
    command: 'test-dsh',
    args: ['--patch', 'C:\\overlay.yml', '--profile', 'web'],
    env: {},
    windowsHide: true,
    detached: false,
  };
}

/**
 * ServerManager harness that records whether each spawn attempt kept the
 * --patch overlay (usePatch) and returns controllable fake children.
 */
class CleanSpawnHarness extends ServerManager {
  constructor(options) {
    super(options);
    // _spawnAttempt only checks that a runtime is present before delegating to
    // the overridden _buildLaunchSpec, so a placeholder object is enough.
    this.resolvedRuntime = { dshHome: 'C:\\dsh-home' };
    this.usePatches = [];
    this.spawnCalls = 0;
    this.pidCounter = 1000;
    this.probeCalls = 0;
    this.probeReadyAt = Infinity; // never ready unless a test opts in
  }
  _buildLaunchSpec(host, port, usePatch) {
    this.usePatches.push(usePatch);
    return fakeLaunch();
  }
  async probe() {
    this.probeCalls += 1;
    return this.probeCalls >= this.probeReadyAt
      ? { reachable: true, isDsh: true }
      : { reachable: false };
  }
}

function makeSpawnFn(harness, exits = []) {
  return (command, args, opts) => {
    harness.spawnCalls += 1;
    const idx = harness.spawnCalls - 1;
    const child = new FakeChild(harness.pidCounter++);
    if (exits[idx]) {
      setImmediate(() => child.emit('exit', exits[idx].code, exits[idx].signal));
    }
    return child;
  };
}

test('self-heal retries exactly once without --patch and succeeds transparently', async () => {
  const harness = new CleanSpawnHarness({
    embedPatchPath: 'C:\\overlay.yml',
  });
  harness.spawnFn = makeSpawnFn(harness, [{ code: 1, signal: null }, null]);
  harness.probeReadyAt = 2; // second attempt (without --patch) becomes healthy
  const server = await harness._spawnAndWait('127.0.0.1', 4299, null, null);

  assert.strictEqual(server.owned, true);
  assert.strictEqual(harness.usePatches.length, 2, 'first with patch, second without');
  assert.deepStrictEqual(harness.usePatches, [true, false]);
  assert.strictEqual(harness.selfHealCount(), 1, 'successful self-heal is recorded');
});

test('self-heal second failure reports the original SPAWN_EXITED_EARLY code', async () => {
  const harness = new CleanSpawnHarness({
    embedPatchPath: 'C:\\overlay.yml',
  });
  harness.spawnFn = makeSpawnFn(harness, [{ code: 1, signal: null }, { code: 1, signal: null }]);

  await assert.rejects(
    harness._spawnAndWait('127.0.0.1', 4300, null, null),
    (err) => err && err.code === 'SPAWN_EXITED_EARLY'
  );
  assert.strictEqual(harness.usePatches.length, 2, 'exactly one retry, never three');
  assert.deepStrictEqual(harness.usePatches, [true, false]);
  assert.strictEqual(harness.selfHealCount(), 0, 'failed self-heal is not counted');
});

test('no retry when the first spawn had no --patch', async () => {
  const harness = new CleanSpawnHarness({
    embedPatchPath: null,
  });
  harness.spawnFn = makeSpawnFn(harness, [{ code: 1, signal: null }]);

  await assert.rejects(
    harness._spawnAndWait('127.0.0.1', 4301, null, null),
    (err) => err && err.code === 'SPAWN_EXITED_EARLY'
  );
  assert.strictEqual(harness.usePatches.length, 1);
  assert.strictEqual(harness.spawnCalls, 1);
});

test('clean mode selects the clean overlay and toggles back to embed', () => {
  const manager = new ServerManager({ embedPatchPath: 'C:\\embed.overlay.yml' });
  assert.strictEqual(manager._effectivePatchPath(), 'C:\\embed.overlay.yml');
  manager.setCleanMode({ enabled: true, patchPath: 'C:\\clean.overlay.yml' });
  assert.strictEqual(manager.isCleanMode(), true);
  assert.strictEqual(manager._effectivePatchPath(), 'C:\\clean.overlay.yml');
  manager.setCleanMode({ enabled: false });
  assert.strictEqual(manager.isCleanMode(), false);
  assert.strictEqual(manager._effectivePatchPath(), 'C:\\embed.overlay.yml');
});

test('registry clean field writes through and old entries read as non-clean', (t) => {
  const registryFile = path.join(os.tmpdir(), `dsh-clean-registry-${process.pid}-${Date.now()}.json`);
  t.after(() => { try { fs.unlinkSync(registryFile); } catch { /* ignore */ } });

  const manager = new ServerManager();
  manager.setCleanMode({ enabled: true, patchPath: 'C:\\clean.overlay.yml' });
  manager._finalizeReady('127.0.0.1', 4321, 'D:\\ws', process.pid, registryFile);

  const entries = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].clean, true);
  assert.strictEqual(ServerManager.isCleanEntry(entries[0]), true);

  // Backward compatibility: an entry persisted before this feature (no key)
  // reads as non-clean instead of throwing.
  assert.strictEqual(ServerManager.isCleanEntry({ pid: 41001, port: 32011 }), false);
  assert.strictEqual(ServerManager.isCleanEntry(null), false);
});
