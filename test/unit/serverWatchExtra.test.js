'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const { ServerManager } = require('../../src/serverManager');

function makeRuntime(home) {
  return {
    executablePath: process.execPath,
    entrypointArgs: [],
    dshHome: home,
    profileHome: path.join(home, 'profiles', 'web'),
    profileName: 'web',
    dshVersion: '0.1.1-rc.1',
  };
}

test('setExtraArgs validates and appends to owned launch specs', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-extra-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const manager = new ServerManager({ spawnFn: () => { throw new Error('never spawned'); } });
  manager.setResolvedRuntime(makeRuntime(home));

  assert.deepStrictEqual(manager.setExtraArgs(['--patch', '/tmp/o.yml']), ['--patch', '/tmp/o.yml']);
  const spec = manager._buildLaunchSpec('127.0.0.1', 3080, true);
  assert.strictEqual(spec.args[spec.args.length - 2], '--patch');
  assert.strictEqual(spec.args[spec.args.length - 1], '/tmp/o.yml');
  assert.ok(spec.args.includes('--host'), 'extension-owned flags stay present');

  assert.throws(() => manager.setExtraArgs([42]), TypeError);
  assert.throws(() => manager.setExtraArgs(['bad\0arg']), TypeError);
  manager.setExtraArgs(undefined);
  const cleared = manager._buildLaunchSpec('127.0.0.1', 3080, true);
  assert.strictEqual(cleared.args.includes('--patch'), false);
});

test('health watchdog emits lost when the ready endpoint dies', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-watch-'));
  const registryFile = path.join(os.tmpdir(), `dsh-watch-reg-${process.pid}-${Date.now()}.json`);
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(registryFile, { force: true });
  });

  const events = [];
  // free → ready → dead: the fake child answers probes from the moment it
  // is spawned, then dies for the watchdog to detect.
  let phase = 'free';
  class FlakyManager extends ServerManager {
    async probe(host, port) {
      if (phase === 'ready') return { reachable: true, isDsh: true };
      return { reachable: false, reason: 'refused' };
    }
  }
  const manager = new FlakyManager({
    onStatus: (s) => events.push(s.state),
    spawnFn: () => {
      const child = new EventEmitter();
      child.pid = 9910;
      child.kill = () => true;
      phase = 'ready';
      return child;
    },
  });
  manager.setResolvedRuntime(makeRuntime(home));
  manager._healthIntervalMs = 20; // fast cadence for the test only

  const server = await manager.ensureServer({
    host: '127.0.0.1', port: 4611, autoStart: true, cwd: null, registryFile,
  });
  assert.ok(server);
  assert.strictEqual(manager._healthTimer !== null, true, 'watchdog armed after ready');

  phase = 'dead';
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(events.includes('lost'), 'lost emitted after probe failures: ' + events.join(','));
  assert.strictEqual(manager._healthTimer, null, 'watchdog self-cleared');
  await manager.stop();
  assert.ok(events.includes('stopped'));
});
