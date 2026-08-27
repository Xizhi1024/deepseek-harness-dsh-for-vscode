'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { EventEmitter } = require('node:events');
const { ServerManager } = require('../../src/serverManager');

function runtime(overrides = {}) {
  return {
    executablePath: process.execPath,
    entrypointArgs: [],
    dshHome: fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-nolog-home-')),
    profileHome: '',
    profileName: 'web',
    dshVersion: null,
    ...overrides,
  };
}

const fs = require('node:fs');

test('ServerManager self-heals a runtime that rejects --no-open', async (t) => {
  const files = [];
  const children = [];
  const state = { ready: false };

  class FlipProbeManager extends ServerManager {
    async probe() {
      return state.ready
        ? { reachable: true, isDsh: true }
        : { reachable: false, reason: 'refused' };
    }
  }

  const statuses = [];
  const manager = new FlipProbeManager({
    onStatus: (s) => statuses.push(s.state),
    spawnFn: (command, args, opts) => {
      const child = new EventEmitter();
      child.pid = 7300 + children.length;
      child.kill = () => true;
      children.push(child);
      if (children.length === 1) {
        // The runtime is older than 0.1.0-rc.7: Commander rejects the flag
        // and the process exits before any health check can pass. Write the
        // rejection into the per-spawn log exactly like the real child would.
        const fd = Array.isArray(opts.stdio) ? opts.stdio[1] : null;
        if (typeof fd === 'number') {
          try { fs.writeSync(fd, "error: unknown option '--no-open'\n"); } catch { /* fd already closed */ }
        }
        setImmediate(() => child.emit('exit', 1, null));
      } else {
        state.ready = true;
      }
      return child;
    },
  });
  t.after(async () => {
    try { await manager.stop(); } catch { /* best-effort cleanup */ }
    for (const file of files) fs.rmSync(file, { force: true });
  });

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-selfheal-home-'));
  const rt = runtime({
    dshHome: home,
    profileHome: path.join(home, 'profiles', 'web'),
    dshVersion: null, // unknown version: the optimistic gate passes the flag once
  });
  manager.setResolvedRuntime(rt);

  const registryFile = path.join(os.tmpdir(), `dsh-selfheal-reg-${process.pid}-${Date.now()}.json`);
  files.push(registryFile);

  const server = await manager.ensureServer({
    host: '127.0.0.1',
    port: 4531,
    autoStart: true,
    cwd: null,
    registryFile,
  });

  assert.ok(server, 'second attempt becomes ready');
  assert.strictEqual(manager.noOpenSuppressed(), true, 'suppression sticks for the session');
  assert.ok(statuses.includes('selfheal'), 'selfheal event emitted');
  // The retry must have dropped the flag while keeping the profile/host/port.
  const spawnCalls = children.map((_, index) => index);
  assert.strictEqual(spawnCalls.length, 2, 'exactly one retry');
  assert.strictEqual(manager.selfHealCount() >= 1, true);
  files.push(path.join(path.dirname(registryFile), `dsh-server-4531-${process.pid}.log`));
});
