'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const {
  ServerManager,
  CLOSE_POLICIES,
  normalizeClosePolicy,
  shouldStopOnViewClose,
  shouldStopOwnedServer,
  sameEndpoint,
  reconcileConfigChange,
} = require('../src/serverManager');
const { detectRuntimeEnvironment } = require('../src/runtimeEnvironment');

const SELF_TEST_PORT_SCAN_LIMIT = 50;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

/**
 * Probe a port that must read as free, retrying briefly.
 *
 * Closing a listener can leave its port answering ECONNRESET for a moment
 * (OS/sandbox dependent) before settling into a clean refusal; production
 * treats both as "not a DSH answer", so the strict `refused` assertions here
 * wait for the transient state to pass instead of racing it.
 */
async function waitForRefused(manager, port, attempts = 20) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    last = await manager.probe('127.0.0.1', port);
    if (last && last.reason === 'refused') return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return last;
}

test('probe recognizes a fragmented boot marker over raw HTTP/TCP', async (t) => {
  const server = net.createServer((socket) => {
    socket.once('data', () => {
      socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n__DSH_');
      setImmediate(() => socket.end('BOOT__'));
    });
  });
  t.after(() => close(server));
  await listen(server);

  assert.deepStrictEqual(
    await new ServerManager().probe('127.0.0.1', server.address().port),
    { reachable: true, isDsh: true }
  );
});

test('ServerManager preserves the standalone self-test behavior', async (t) => {
  const servers = [];
  const files = [];
  let sleeper = null;

  t.after(async () => {
    for (const server of servers) await close(server);
    if (sleeper && sleeper.exitCode === null) {
      try { sleeper.kill(); } catch { /* best-effort test cleanup */ }
    }
    for (const file of files) {
      try { fs.unlinkSync(file); } catch { /* best-effort test cleanup */ }
    }
  });

  const dshServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><script>window.__DSH_BOOT__={config:{}}</script>');
  });
  servers.push(dshServer);
  await listen(dshServer);
  const dshPort = dshServer.address().port;
  assert.notStrictEqual(dshPort, 3080, 'tests must never collide with the default DSH port');

  const plainServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('hello');
  });
  servers.push(plainServer);
  await listen(plainServer);
  const plainPort = plainServer.address().port;
  assert.notStrictEqual(plainPort, 3080);
  assert.notStrictEqual(plainPort, dshPort);

  const temporaryServer = http.createServer();
  await listen(temporaryServer);
  const closedPort = temporaryServer.address().port;
  await close(temporaryServer);

  const manager = new ServerManager();
  await assert.rejects(
    manager.ensureServer({ host: '0.0.0.0', port: 3080 }),
    /requires 127\.0\.0\.1/
  );
  await assert.rejects(
    manager.ensureServer({ host: '127.0.0.1', port: 0 }),
    /integer from 1 to 65535/
  );

  assert.deepStrictEqual(
    await manager.probe('127.0.0.1', dshPort),
    { reachable: true, isDsh: true }
  );
  assert.deepStrictEqual(
    await manager.probe('127.0.0.1', plainPort),
    { reachable: true, isDsh: false }
  );
  assert.deepStrictEqual(
    await waitForRefused(manager, closedPort),
    { reachable: false, reason: 'refused' }
  );
  assert.strictEqual(await manager.healthCheck(`http://127.0.0.1:${dshPort}/`), true);
  assert.strictEqual(await manager.healthCheck(`http://127.0.0.1:${plainPort}/`), false);

  const freePort = await manager._findFreePort('127.0.0.1', plainPort);
  assert.ok(
    freePort > plainPort && freePort <= plainPort + SELF_TEST_PORT_SCAN_LIMIT,
    `free=${freePort}`
  );
  assert.strictEqual((await waitForRefused(manager, freePort)).reachable, false);
  assert.strictEqual((await waitForRefused(manager, freePort)).reason, 'refused');

  const statuses = [];
  const reuseManager = new ServerManager({ onStatus: (status) => statuses.push(status.state) });
  assert.deepStrictEqual(
    await reuseManager.ensureServer({ host: '127.0.0.1', port: dshPort, autoStart: false }),
    {
      url: `http://127.0.0.1:${dshPort}`,
      host: '127.0.0.1',
      port: dshPort,
      pid: null,
      owned: false,
    }
  );
  assert.deepStrictEqual(statuses, ['probing', 'reusing']);
  await assert.rejects(
    reuseManager.ensureServer({ host: '127.0.0.1', port: plainPort, autoStart: false }),
    /autoStart/
  );

  const adoptManager = new ServerManager();
  assert.deepStrictEqual(
    await adoptManager.adoptRunningDsh('127.0.0.1', dshPort),
    {
      url: `http://127.0.0.1:${dshPort}`,
      host: '127.0.0.1',
      port: dshPort,
      pid: null,
      owned: false,
    }
  );
  assert.strictEqual(await adoptManager.adoptRunningDsh('127.0.0.1', plainPort), null);
  assert.strictEqual(await adoptManager.adoptRunningDsh('127.0.0.1', closedPort), null);

  const missingRegistry = path.join(os.tmpdir(), `dsh-stale-missing-${process.pid}-${Date.now()}.json`);
  assert.doesNotThrow(() => ServerManager.cleanupStalePid(missingRegistry));
  const corruptRegistry = path.join(os.tmpdir(), `dsh-stale-bad-${process.pid}-${Date.now()}.json`);
  files.push(corruptRegistry);
  fs.writeFileSync(corruptRegistry, 'this is not json');
  assert.doesNotThrow(() => ServerManager.cleanupStalePid(corruptRegistry));
  assert.strictEqual(fs.existsSync(corruptRegistry), false);

  const stopStatuses = [];
  const stoppedManager = new ServerManager({ onStatus: (status) => stopStatuses.push(status.state) });
  await stoppedManager.stop();
  assert.deepStrictEqual(stopStatuses, ['stopping', 'stopped']);

  let slowHits = 0;
  const slowDshServer = http.createServer((req, res) => {
    slowHits += 1;
    if (slowHits === 1) return;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><script>window.__DSH_BOOT__={}</script>');
  });
  servers.push(slowDshServer);
  await listen(slowDshServer);
  const slowDshPort = slowDshServer.address().port;
  assert.notStrictEqual(slowDshPort, 3080);
  assert.deepStrictEqual(
    await manager.probe('127.0.0.1', slowDshPort),
    { reachable: false, reason: 'timeout' }
  );
  assert.deepStrictEqual(
    await manager.probeWithRetry('127.0.0.1', slowDshPort, { attempts: 3, delayMs: 400 }),
    { reachable: true, isDsh: true }
  );

  class FlakyProbe extends ServerManager {
    constructor() {
      super();
      this.calls = 0;
    }

    async probe() {
      this.calls += 1;
      return this.calls < 3
        ? { reachable: false }
        : { reachable: true, isDsh: true };
    }
  }
  const flaky = new FlakyProbe();
  assert.deepStrictEqual(
    await flaky.probeWithRetry('127.0.0.1', 1, { attempts: 3, delayMs: 10 }),
    { reachable: true, isDsh: true }
  );
  assert.strictEqual(flaky.calls, 3);

  for (const [input, expected] of [
    [null, undefined],
    [undefined, undefined],
    ['', undefined],
    ['D:\\ws', 'D:\\ws'],
    ['/home/user/ws', '/home/user/ws'],
  ]) {
    assert.strictEqual(manager._resolveSpawnCwd(input), expected);
  }

  if (process.platform === 'win32') {
    assert.strictEqual(ServerManager.samePath('D:\\Coding', 'D:\\Coding\\'), true);
    assert.strictEqual(ServerManager.samePath('D:\\Coding', 'd:\\coding'), true);
    assert.strictEqual(ServerManager.samePath('D:\\Coding', 'D:\\Other'), false);
    assert.strictEqual(ServerManager.samePath('D:\\Coding', ''), false);
  } else {
    assert.strictEqual(ServerManager.samePath('/home/u/ws', '/home/u/ws/'), true);
    assert.strictEqual(ServerManager.samePath('/home/u/ws', '/home/u/other'), false);
  }

  const registryFile = path.join(os.tmpdir(), `dsh-registry-${process.pid}-${Date.now()}.json`);
  files.push(registryFile);
  fs.writeFileSync(registryFile, JSON.stringify([
    { pid: process.pid, port: dshPort, host: '127.0.0.1', cwd: 'D:\\A', at: Date.now() },
  ], null, 2));

  class NoSpawnManager extends ServerManager {
    constructor() {
      super();
      this.spawnBranch = false;
    }

    async _spawnAndWait() {
      this.spawnBranch = true;
      throw new Error('spawn-branch-reached');
    }
  }

  const autoStartManager = new NoSpawnManager();
  await assert.rejects(
    autoStartManager.ensureServer({
      host: '127.0.0.1', port: dshPort, cwd: 'D:\\A', registryFile,
    }),
    /spawn-branch-reached/
  );
  assert.strictEqual(autoStartManager.spawnBranch, true);

  const manualReuseManager = new NoSpawnManager();
  assert.deepStrictEqual(
    await manualReuseManager.ensureServer({
      host: '127.0.0.1', port: dshPort, cwd: 'D:\\A', registryFile, autoStart: false,
    }),
    {
      url: `http://127.0.0.1:${dshPort}`,
      host: '127.0.0.1',
      port: dshPort,
      pid: null,
      owned: false,
    }
  );
  assert.strictEqual(manualReuseManager.spawnBranch, false);

  const ownedAgainManager = new NoSpawnManager();
  ownedAgainManager._child = { pid: process.pid };
  ownedAgainManager._ownedServer = {
    url: `http://127.0.0.1:${dshPort}`,
    host: '127.0.0.1',
    port: dshPort,
    pid: process.pid,
    owned: true,
  };
  assert.deepStrictEqual(
    await ownedAgainManager.ensureServer({
      host: '127.0.0.1', port: dshPort, cwd: 'D:\\A', registryFile,
    }),
    ownedAgainManager._ownedServer
  );
  assert.strictEqual(ownedAgainManager.hasOwnedChild(), true);

  const scannedForwardManager = new NoSpawnManager();
  await assert.rejects(
    scannedForwardManager.ensureServer({
      host: '127.0.0.1', port: plainPort, cwd: 'D:\\A', registryFile,
    }),
    /spawn-branch-reached/
  );
  assert.strictEqual(scannedForwardManager.spawnBranch, true);

  const noWorkspaceManager = new NoSpawnManager();
  await assert.rejects(
    noWorkspaceManager.ensureServer({
      host: '127.0.0.1', port: dshPort, cwd: null, registryFile,
    }),
    /spawn-branch-reached/
  );
  assert.strictEqual(noWorkspaceManager.spawnBranch, true);

  const deadRegistry = path.join(os.tmpdir(), `dsh-registry-dead-${process.pid}-${Date.now()}.json`);
  files.push(deadRegistry);
  fs.writeFileSync(deadRegistry, JSON.stringify([
    { pid: 99999999, port: 32000, host: '127.0.0.1', cwd: null, at: Date.now() },
  ], null, 2));
  assert.deepStrictEqual(ServerManager._readRegistry(deadRegistry), []);

  sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' });
  sleeper.unref();
  const liveRegistry = path.join(os.tmpdir(), `dsh-registry-live-${process.pid}-${Date.now()}.json`);
  files.push(liveRegistry);
  const liveAt = Date.now();
  fs.writeFileSync(liveRegistry, JSON.stringify([
    { pid: sleeper.pid, port: 32001, host: '127.0.0.1', cwd: 'D:\\Live', at: liveAt },
  ], null, 2));
  assert.deepStrictEqual(ServerManager._readRegistry(liveRegistry), [
    { pid: sleeper.pid, port: 32001, host: '127.0.0.1', cwd: 'D:\\Live', at: liveAt },
  ]);
  assert.strictEqual(sleeper.exitCode, null);
  ServerManager.cleanupStaleRegistry(liveRegistry);
  assert.strictEqual(JSON.parse(fs.readFileSync(liveRegistry, 'utf8')).length, 1);
  assert.strictEqual(sleeper.exitCode, null);
  ServerManager.cleanupStaleRegistry(deadRegistry);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(deadRegistry, 'utf8')), []);

  const stopRegistry = path.join(os.tmpdir(), `dsh-registry-stop-${process.pid}-${Date.now()}.json`);
  files.push(stopRegistry);
  fs.writeFileSync(stopRegistry, JSON.stringify([
    { pid: 41001, port: 32010, host: '127.0.0.1', cwd: 'D:\\Own', at: 1 },
    { pid: 41002, port: 32011, host: '127.0.0.1', cwd: 'D:\\Other', at: 2 },
  ], null, 2));
  class NoKillManager extends ServerManager {
    async _killChild() { /* never kill a real process in this test */ }
  }
  const noKillManager = new NoKillManager();
  noKillManager._child = { pid: 41001, exitCode: 1, signalCode: null, kill() {} };
  noKillManager._registryFile = stopRegistry;
  await noKillManager.stop();
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(stopRegistry, 'utf8')),
    [{ pid: 41002, port: 32011, host: '127.0.0.1', cwd: 'D:\\Other', at: 2 }]
  );

  assert.strictEqual(normalizeClosePolicy(undefined), CLOSE_POLICIES.ON_VSCODE_EXIT);
  assert.strictEqual(normalizeClosePolicy('onVscodeExit'), CLOSE_POLICIES.ON_VSCODE_EXIT);
  assert.strictEqual(normalizeClosePolicy('onViewClose'), CLOSE_POLICIES.ON_VIEW_CLOSE);
  assert.strictEqual(normalizeClosePolicy('never'), CLOSE_POLICIES.NEVER);
  assert.strictEqual(normalizeClosePolicy('garbage'), CLOSE_POLICIES.ON_VSCODE_EXIT);
  assert.strictEqual(shouldStopOnViewClose('onViewClose'), true);
  assert.strictEqual(shouldStopOnViewClose('onVscodeExit'), false);
  assert.strictEqual(shouldStopOnViewClose('never'), false);
  assert.strictEqual(shouldStopOnViewClose(undefined), false);
  assert.strictEqual(shouldStopOwnedServer({ pid: 123, owned: true }), true);
  assert.strictEqual(shouldStopOwnedServer({ pid: null, owned: false }), false);
  assert.strictEqual(shouldStopOwnedServer(null), false);
  assert.strictEqual(shouldStopOwnedServer(undefined), false);
  assert.strictEqual(sameEndpoint(
    { host: '127.0.0.1', port: 3080 },
    { host: '127.0.0.1', port: 3080 }
  ), true);
  assert.strictEqual(sameEndpoint(
    { host: '127.0.0.1', port: 3080 },
    { host: '127.0.0.1', port: 3081 }
  ), false);
  assert.strictEqual(sameEndpoint(
    { host: '127.0.0.1', port: 3080 },
    { host: 'localhost', port: 3080 }
  ), false);
  assert.strictEqual(sameEndpoint(
    { host: '127.0.0.1', port: '3080' },
    { host: '127.0.0.1', port: 3080 }
  ), true);

  const base = {
    host: '127.0.0.1', port: 3080, autoStart: true, closePolicy: 'onVscodeExit',
  };
  assert.deepStrictEqual(
    reconcileConfigChange(base, { ...base }, true, true),
    {
      shouldReconnect: false,
      reason: null,
      endpointChanged: false,
      autoStartEnabled: false,
      closePolicyChanged: false,
    }
  );
  const portChange = reconcileConfigChange(base, { ...base, port: 3081 }, true, true);
  assert.strictEqual(portChange.shouldReconnect, true);
  assert.strictEqual(portChange.reason, 'port');
  assert.strictEqual(
    reconcileConfigChange(base, { ...base, host: 'localhost' }, true, true).reason,
    'host'
  );
  assert.strictEqual(
    reconcileConfigChange(base, { ...base, autoStart: false }, true, true).shouldReconnect,
    false
  );
  assert.strictEqual(
    reconcileConfigChange(
      { ...base, autoStart: false }, { ...base, autoStart: true }, false, false
    ).reason,
    'autoStart'
  );
  assert.strictEqual(
    reconcileConfigChange(
      { ...base, autoStart: false }, { ...base, autoStart: true }, true, true
    ).shouldReconnect,
    false
  );
  const policyChange = reconcileConfigChange(
    base, { ...base, closePolicy: 'onViewClose' }, true, true
  );
  assert.strictEqual(policyChange.shouldReconnect, false);
  assert.strictEqual(policyChange.closePolicyChanged, true);

  const bridgeInput = {
    DSH_VSCODE_OPEN_URL: 'http://127.0.0.1:43123/open-text-document',
    DSH_VSCODE_OPEN_TOKEN: 'window-token', // allow-secret-scan
    DSH_TEXT_EDITOR: 'wrong-value',
  };
  const bridgeManager = new ServerManager({ spawnEnv: bridgeInput });
  bridgeInput.DSH_VSCODE_OPEN_TOKEN = 'mutated'; // allow-secret-scan
  assert.deepStrictEqual(
    {
      url: bridgeManager._buildSpawnEnv().DSH_VSCODE_OPEN_URL,
      token: bridgeManager._buildSpawnEnv().DSH_VSCODE_OPEN_TOKEN,
      editor: bridgeManager._buildSpawnEnv().DSH_TEXT_EDITOR,
    },
    {
      url: 'http://127.0.0.1:43123/open-text-document',
      token: 'window-token',
      editor: 'vscode',
    }
  );

  class CancelledEnsureManager extends ServerManager {
    constructor() {
      super();
      this.spawnAttempted = false;
    }

    async probeWithRetry() {
      this.cancelPending();
      return { reachable: false };
    }

    async _spawnAndWait() {
      this.spawnAttempted = true;
      throw new Error('must-not-spawn');
    }
  }
  const cancelledManager = new CancelledEnsureManager();
  await assert.rejects(
    cancelledManager.ensureServer({ host: '127.0.0.1', port: 3080, autoStart: true }),
    /cancelled/
  );
  assert.strictEqual(cancelledManager.spawnAttempted, false);
});

test('ServerManager passes the generated embed overlay through as --patch', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-embed-overlay-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, process.platform === 'win32' ? 'dsh.exe' : 'dsh');
  fs.writeFileSync(executable, 'runtime');
  if (process.platform !== 'win32') fs.chmodSync(executable, 0o755);
  const overlay = path.join(root, 'vscode-embed.overlay.yml');
  fs.writeFileSync(overlay, '- id: better-sidebar\n  disabled: true\n');
  const runtime = {
    executablePath: executable,
    dshHome: root,
    profileHome: path.join(root, 'profiles', 'web'),
    profileName: 'web',
    entrypointArgs: [],
  };

  const manager = new ServerManager({ resolvedRuntime: runtime, embedPatchPath: overlay });
  const launch = manager._buildLaunchSpec('127.0.0.1', 4321);
  assert.strictEqual(launch.command, executable);
  assert.deepStrictEqual(launch.args, [
    '--patch', overlay, '--profile', 'web', '--host', '127.0.0.1', '--port', '4321', '--no-open',
  ]);
  assert.throws(
    () => new ServerManager({ resolvedRuntime: runtime, embedPatchPath: 'relative.yml' })._buildLaunchSpec('127.0.0.1', 4321),
    /embed patchPath must be an absolute path/
  );
});

test('ServerManager never reuses the last spawned port within the same instance', async () => {
  class FreshOriginManager extends ServerManager {
    constructor() {
      super();
      this.starts = [];
      this.probeWithRetry = async () => ({ reachable: false, reason: 'refused' });
    }

    async _findFreePort(host, startPort) {
      this.starts.push(startPort);
      return startPort;
    }

    async _spawnAndWait(host, port) {
      return { url: `http://${host}:${port}`, host, port, pid: 4242, owned: true };
    }
  }

  const manager = new FreshOriginManager();
  await manager.ensureServer({ host: '127.0.0.1', port: 4000, autoStart: true });
  await manager.ensureServer({ host: '127.0.0.1', port: 4000, autoStart: true });

  assert.deepStrictEqual(manager.starts, [4000, 4001]);
});

test('ServerManager Windows taskkill timeout resolves, kills the hanging killer, and retries tree-kill', async () => {
  const manager = new ServerManager();
  let killCalls = 0;
  let spawnCalls = 0;
  const killer = {
    handlers: {},
    once(event, callback) {
      this.handlers[event] = callback;
      return this;
    },
    removeListener(event, callback) {
      if (this.handlers[event] === callback) delete this.handlers[event];
    },
    kill() {
      killCalls += 1;
    },
  };
  const retryKiller = {
    once() { return this; },
    removeListener() { return this; },
    kill() {},
    unref() {},
  };

  await manager._killChild(
    { pid: 12345 },
    {
      platform: 'win32',
      spawnFn: () => {
        spawnCalls += 1;
        return spawnCalls === 1 ? killer : retryKiller;
      },
      timeoutMs: 20,
    }
  );

  assert.strictEqual(spawnCalls, 2, 'timeout must spawn a second best-effort taskkill');
  assert.strictEqual(killCalls, 1, 'timeout must kill the hanging taskkill process');
});

test('_findFreePort skips timed-out (silent-listener) ports and accepts only refusals', async () => {
  const probes = [];
  class SilentPortManager extends ServerManager {
    async probe(host, port) {
      probes.push(port);
      return port === 4300
        ? { reachable: false, reason: 'timeout' }
        : { reachable: false, reason: 'refused' };
    }
  }
  const manager = new SilentPortManager();
  assert.strictEqual(await manager._findFreePort('127.0.0.1', 4300), 4301);
  assert.deepStrictEqual(probes, [4300, 4301]);
});

test('registry helpers list only live pids and remove selected records without killing', async (t) => {
  const file = path.join(os.tmpdir(), `dsh-registry-orphans-${process.pid}-${Date.now()}.json`);
  t.after(() => fs.rmSync(file, { force: true }));
  fs.writeFileSync(file, JSON.stringify([
    { pid: process.pid, port: 4301, host: '127.0.0.1', cwd: null, at: 1 },
    { pid: 999999999, port: 4302, host: '127.0.0.1', cwd: null, at: 1 },
  ]));

  const alive = ServerManager.aliveRegistryEntries(file);
  assert.deepStrictEqual(alive.map((entry) => entry.pid), [process.pid]);

  ServerManager.removeRegistryEntries(file, [process.pid]);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(raw.map((entry) => entry.pid), [999999999]);
});

test('sweepDeadOwnerEntries tree-kills only entries whose owner pid is dead', async (t) => {
  const file = path.join(os.tmpdir(), `dsh-sweep-${process.pid}-${Date.now()}.json`);
  t.after(() => fs.rmSync(file, { force: true }));
  const terminated = [];
  // ownerPid is the extension-host pid recorded alongside each DSH child pid.
  const entries = [
    { pid: 5001, port: 4010, host: '127.0.0.1', vscodePid: 9001, at: 1 }, // dead owner → swept
    { pid: 5002, port: 4011, host: '127.0.0.1', vscodePid: 9002, at: 2 }, // live owner → kept
    { pid: 5003, port: 4012, host: '127.0.0.1', vscodePid: 9003, at: 3 }, // legacy-compatible ownerless → kept
    { pid: 5004, port: 4013, host: '127.0.0.1', vscodePid: 9004, at: 4 }, // non-integer pid → kept
  ];
  entries[3].pid = '5004'; // not an integer pid: reader keeps it untouched
  fs.writeFileSync(file, JSON.stringify(entries, null, 2));

  const swept = await ServerManager.sweepDeadOwnerEntries(file, {
    terminate: async (pid) => { terminated.push(pid); },
    isProcessAlive: (pid) => pid === 9002 || pid === 9003 || pid === 9004,
    verify: () => null, // hermetic: skip the real process-identity check
    currentVscodePid: null,
  });

  assert.deepStrictEqual(swept, [{ pid: 5001, port: 4010, vscodePid: 9001, at: 1 }]);
  assert.deepStrictEqual(terminated, [5001], 'only the dead-owner child is tree-killed');
  const remaining = JSON.parse(fs.readFileSync(file, 'utf8')).map((entry) => entry.pid);
  assert.deepStrictEqual(remaining, [5002, 5003, '5004'], 'live-owner and legacy entries survive');
});

test('sweepDeadOwnerEntries never sweeps entries owned by the current window', async (t) => {
  const file = path.join(os.tmpdir(), `dsh-sweep-self-${process.pid}-${Date.now()}.json`);
  t.after(() => fs.rmSync(file, { force: true }));
  fs.writeFileSync(file, JSON.stringify([
    { pid: 6001, port: 4020, host: '127.0.0.1', vscodePid: 7700, at: 1 }, // other (dead) owner → swept
    { pid: 6002, port: 4021, host: '127.0.0.1', vscodePid: 8800, at: 2 }, // this window → never swept
  ], null, 2));
  const terminated = [];

  const swept = await ServerManager.sweepDeadOwnerEntries(file, {
    terminate: async (pid) => { terminated.push(pid); },
    isProcessAlive: () => false, // even if every owner looks dead…
    verify: () => null, // hermetic: skip the real process-identity check
    currentVscodePid: 8800,
  });

  assert.deepStrictEqual(swept.map((entry) => entry.pid), [6001]);
  assert.deepStrictEqual(terminated, [6001]);
  const remaining = JSON.parse(fs.readFileSync(file, 'utf8')).map((entry) => entry.pid);
  assert.deepStrictEqual(remaining, [6002]);
});

test('sweepDeadOwnerEntries skips a recycled pid whose process postdates its entry', async (t) => {
  const file = path.join(os.tmpdir(), `dsh-sweep-reuse-${process.pid}-${Date.now()}.json`);
  t.after(() => fs.rmSync(file, { force: true }));
  const now = Date.now();
  // The dead window's dsh was pid 6100. Windows since recycled that pid: the
  // live process behind pid 6100 was created AFTER the entry was written.
  fs.writeFileSync(file, JSON.stringify([
    { pid: 6100, port: 4040, host: '127.0.0.1', vscodePid: 999001, at: now - 60000 },
  ], null, 2));
  const terminated = [];

  const swept = await ServerManager.sweepDeadOwnerEntries(file, {
    terminate: async (pid) => { terminated.push(pid); },
    isProcessAlive: () => false, // every OWNER looks dead…
    // pid 6100 was born 1s ago; its entry was written 60s ago, so the live
    // process postdates the entry: _processCreatedBeforeMs must answer false.
    verify: (pid, atMs) => (pid === 6100 ? (now - 1000) < atMs : null),
    currentVscodePid: null,
  });

  assert.deepStrictEqual(swept.map((entry) => entry.pid), [6100],
    'the stale entry is still reported as swept');
  assert.deepStrictEqual(terminated, [],
    'the recycled pid must NEVER be tree-killed — it belongs to a new process');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [],
    'the stale entry itself is still dropped');
});

test('spawn readiness: an explicit short readyTimeoutMs fails HEALTH_TIMEOUT fast', async (t) => {
  const freePort = await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
  const neverReadyChild = new EventEmitter();
  neverReadyChild.pid = 424242;
  neverReadyChild.kill = () => {};
  neverReadyChild.exitCode = null;
  neverReadyChild.signalCode = null;
  const manager = new ServerManager({ spawnFn: () => neverReadyChild });
  const fakeRuntime = path.join(os.tmpdir(), `dsh-budget-runtime-${process.pid}${process.platform === 'win32' ? '.exe' : ''}`);
  fs.writeFileSync(fakeRuntime, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  manager.setResolvedRuntime({
    executablePath: fakeRuntime,
    dshHome: os.tmpdir(),
    profileHome: path.join(os.tmpdir(), 'profiles', 'web'),
  });
  manager._killChild = async () => {};
  const registryFile = path.join(os.tmpdir(), `dsh-budget-${process.pid}-${Date.now()}.json`);
  t.after(() => {
    fs.rmSync(registryFile, { force: true });
    fs.rmSync(`${registryFile}.lock`, { force: true });
  });

  const startedAt = Date.now();
  await assert.rejects(
    manager._spawnAndWait('127.0.0.1', freePort, null, registryFile, manager._cancelGeneration, { readyTimeoutMs: 400 }),
    (err) => err.code === 'HEALTH_TIMEOUT',
    'the readiness deadline must surface HEALTH_TIMEOUT'
  );
  assert.ok(Date.now() - startedAt < 8000, `a 400ms budget must not wait the full cold budget (took ${Date.now() - startedAt}ms)`);
  assert.strictEqual(manager.hasOwnedChild(), false, 'the hung child is detached after the deadline kill');
});

test('ready registry entries carry the C1 owner identity (vscodePid + windowId)', (t) => {
  const file = path.join(os.tmpdir(), `dsh-owner-reg-${process.pid}-${Date.now()}.json`);
  t.after(() => fs.rmSync(file, { force: true }));
  const manager = new ServerManager();
  manager.setOwnerIdentity({ vscodePid: 123456, windowId: 'w-9' });
  manager._finalizeReady('127.0.0.1', 4322, '/ws', 98765, file, null);
  const entry = JSON.parse(fs.readFileSync(file, 'utf8'))[0];
  assert.strictEqual(entry.pid, 98765);
  assert.strictEqual(entry.port, 4322);
  assert.strictEqual(entry.host, '127.0.0.1');
  assert.strictEqual(entry.vscodePid, 123456, 'owner extension-host pid must be stamped');
  assert.strictEqual(entry.windowId, 'w-9', 'owner window id must be stamped');
});

test('ready entries without an owner identity stay legacy-compatible (null keys)', (t) => {
  const file = path.join(os.tmpdir(), `dsh-owner-null-${process.pid}-${Date.now()}.json`);
  t.after(() => fs.rmSync(file, { force: true }));
  const manager = new ServerManager(); // no setOwnerIdentity call
  manager._finalizeReady('127.0.0.1', 4323, null, 98766, file, null);
  const entry = JSON.parse(fs.readFileSync(file, 'utf8'))[0];
  assert.strictEqual(entry.vscodePid, null);
  assert.strictEqual(entry.windowId, null);
});

// ---------------------------------------------------------------------------
// Shared-instance mode (dsh.share.mode = "environment")
// ---------------------------------------------------------------------------

function createDshHttpServer() {
  return http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><script>window.__DSH_BOOT__={config:{}}</script>');
  });
}

class NoSpawnManager extends ServerManager {
  constructor() {
    super();
    this.spawnBranch = false;
  }

  async _spawnAndWait() {
    this.spawnBranch = true;
    throw new Error('spawn-branch-reached');
  }
}

test('shared environment mode adopts the DSH instance answering on the configured port', async (t) => {
  const dshServer = createDshHttpServer();
  await listen(dshServer);
  const port = dshServer.address().port;
  t.after(() => close(dshServer));

  const registryFile = path.join(os.tmpdir(), `dsh-shared-adopt-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(registryFile, '[]');
  t.after(() => fs.rmSync(registryFile, { force: true }));

  const manager = new NoSpawnManager();
  t.after(() => manager.stop());
  const handle = await manager.ensureServer({
    host: '127.0.0.1', port, autoStart: true, cwd: null, registryFile, shareMode: 'environment',
  });

  // A DSH answer on the configured port IS the shared instance — adopted,
  // never spawned past, regardless of which window started it.
  assert.deepStrictEqual(handle, {
    url: `http://127.0.0.1:${port}`,
    host: '127.0.0.1',
    port,
    pid: null,
    owned: false,
  });
  assert.strictEqual(manager.spawnBranch, false, 'the spawn path must never be reached');
});

test('shared environment mode discovers and adopts a DSH listener on another local port', async (t) => {
  const plainServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('hello');
  });
  const dshServer = createDshHttpServer();
  await listen(plainServer);
  await listen(dshServer);
  const plainPort = plainServer.address().port;
  const dshPort = dshServer.address().port;
  t.after(() => close(plainServer));
  t.after(() => close(dshServer));

  const registryFile = path.join(os.tmpdir(), `dsh-shared-disc-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(registryFile, '[]');
  t.after(() => fs.rmSync(registryFile, { force: true }));

  const manager = new NoSpawnManager();
  t.after(() => manager.stop());
  let discoveryCalls = 0;
  const handle = await manager.ensureServer({
    host: '127.0.0.1', port: plainPort, autoStart: true, cwd: null, registryFile, shareMode: 'environment',
    discoverDshWebPorts: async () => {
      discoveryCalls += 1;
      return [dshPort];
    },
  });

  assert.strictEqual(handle.port, dshPort, 'the discovered DSH listener is adopted');
  assert.strictEqual(handle.owned, false);
  assert.strictEqual(discoveryCalls, 1);
  assert.strictEqual(manager.spawnBranch, false);
});

test('shared environment mode spawns on the configured port when nothing answers', async (t) => {
  const temporaryServer = http.createServer();
  await listen(temporaryServer);
  const freePort = temporaryServer.address().port;
  await close(temporaryServer);

  const registryFile = path.join(os.tmpdir(), `dsh-shared-spawn-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(registryFile, '[]');
  t.after(() => fs.rmSync(registryFile, { force: true }));

  const manager = new NoSpawnManager();
  t.after(() => manager.stop());
  await assert.rejects(
    manager.ensureServer({
      host: '127.0.0.1', port: freePort, autoStart: true, cwd: null, registryFile, shareMode: 'environment',
      discoverDshWebPorts: async () => [],
    }),
    /spawn-branch-reached/
  );
  assert.strictEqual(manager.spawnBranch, true);
});

test('shared environment mode scans forward past a non-DSH occupant', async (t) => {
  const plainServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('hello');
  });
  await listen(plainServer);
  const plainPort = plainServer.address().port;
  t.after(() => close(plainServer));

  const registryFile = path.join(os.tmpdir(), `dsh-shared-scan-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(registryFile, '[]');
  t.after(() => fs.rmSync(registryFile, { force: true }));

  const manager = new NoSpawnManager();
  t.after(() => manager.stop());
  await assert.rejects(
    manager.ensureServer({
      host: '127.0.0.1', port: plainPort, autoStart: true, cwd: null, registryFile, shareMode: 'environment',
      discoverDshWebPorts: async () => [],
    }),
    /spawn-branch-reached/
  );
  assert.strictEqual(manager.spawnBranch, true, 'a non-DSH occupant is scanned past, not adopted');
});

test('shared environment mode keeps strict user-managed semantics for autoStart false', async (t) => {
  const temporaryServer = http.createServer();
  await listen(temporaryServer);
  const freePort = temporaryServer.address().port;
  await close(temporaryServer);

  const manager = new NoSpawnManager();
  t.after(() => manager.stop());
  await assert.rejects(
    manager.ensureServer({
      host: '127.0.0.1', port: freePort, autoStart: false, cwd: null, registryFile: null, shareMode: 'environment',
      discoverDshWebPorts: async () => [41999],
    }),
    (error) => error.code === 'AUTOSTART_DISABLED'
  );
  assert.strictEqual(manager.spawnBranch, false);
});

test('shared environment mode settles a spawn race with one adoption retry', async (t) => {
  const temporaryServer = http.createServer();
  await listen(temporaryServer);
  const configuredPort = temporaryServer.address().port;
  await close(temporaryServer);

  const registryFile = path.join(os.tmpdir(), `dsh-shared-race-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(registryFile, '[]');
  t.after(() => fs.rmSync(registryFile, { force: true }));

  class RaceLoserManager extends ServerManager {
    async _spawnAndWait(host, port) {
      // A sibling window won the race: its DSH now answers on the configured
      // port while our own child died of EADDRINUSE (simulated by throwing).
      this.sibling = createDshHttpServer();
      await new Promise((resolve) => this.sibling.listen(port, '127.0.0.1', resolve));
      throw new Error('simulated spawn race lost');
    }
  }

  const manager = new RaceLoserManager();
  t.after(async () => {
    await manager.stop();
    await close(manager.sibling);
  });
  const handle = await manager.ensureServer({
    host: '127.0.0.1', port: configuredPort, autoStart: true, cwd: null, registryFile, shareMode: 'environment',
  });

  assert.deepStrictEqual(handle, {
    url: `http://127.0.0.1:${configuredPort}`,
    host: '127.0.0.1',
    port: configuredPort,
    pid: null,
    owned: false,
  }, 'the race winner is adopted instead of surfacing the spawn error');
});

test('window-owned mode ignores discovery and never adopts an occupied port', async (t) => {
  const plainServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('hello');
  });
  const dshServer = createDshHttpServer();
  await listen(plainServer);
  await listen(dshServer);
  const plainPort = plainServer.address().port;
  const dshPort = dshServer.address().port;
  t.after(() => close(plainServer));
  t.after(() => close(dshServer));

  const registryFile = path.join(os.tmpdir(), `dsh-window-disc-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(registryFile, '[]');
  t.after(() => fs.rmSync(registryFile, { force: true }));

  // Default shareMode (window) and the explicit value must behave the same:
  // an occupied port belongs to somebody else — scan forward and spawn.
  for (const shareMode of [undefined, 'window']) {
    const manager = new NoSpawnManager();
    t.after(() => manager.stop());
    await assert.rejects(
      manager.ensureServer({
        host: '127.0.0.1', port: plainPort, autoStart: true, cwd: null, registryFile, shareMode,
        discoverDshWebPorts: async () => [dshPort],
      }),
      /spawn-branch-reached/
    );
    assert.strictEqual(manager.spawnBranch, true, `shareMode ${shareMode ?? '(default)'} must never adopt`);
  }
});

test('shared-mode adopter bookkeeping records, dedupes and removes attachers', (t) => {
  const file = path.join(os.tmpdir(), `dsh-adopters-${process.pid}-${Date.now()}.json`);
  t.after(() => fs.rmSync(file, { force: true }));
  fs.writeFileSync(file, JSON.stringify([
    { pid: process.pid, port: 32150, host: '127.0.0.1', cwd: null, vscodePid: 555000, at: 1 },
    { pid: 99999999, port: 32151, host: '127.0.0.1', cwd: null, vscodePid: 555001, at: 2 },
  ], null, 2));

  ServerManager._registerAdopter(file, { port: 32150, vscodePid: 777001, windowId: 'w-a' });
  ServerManager._registerAdopter(file, { port: 32150, vscodePid: 777001, windowId: 'w-a' }); // dedupe
  ServerManager._registerAdopter(file, { port: 32150, vscodePid: 777003, windowId: null });
  ServerManager._registerAdopter(file, { port: 32151, vscodePid: 777002, windowId: 'w-b' }); // dead child entry
  ServerManager._registerAdopter(file, { port: 32150, vscodePid: null, windowId: null }); // unusable identity

  let entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(entries[0].attachers, [
    { vscodePid: 777001, windowId: 'w-a' },
    { vscodePid: 777003, windowId: null },
  ], 'live entries gain the adopter exactly once');
  assert.strictEqual(entries[1].attachers, undefined, 'dead entries are never annotated');

  assert.strictEqual(
    ServerManager.entryHasLiveAdopters(entries[0], { isProcessAlive: (pid) => pid === 777001 }),
    true
  );
  assert.strictEqual(
    ServerManager.entryHasLiveAdopters(entries[0], { isProcessAlive: () => false }),
    false
  );
  // Self-exclusion: when the only attacher is the consulting window itself,
  // there is no OTHER live adopter left to protect the instance for.
  const selfOnly = { attachers: [{ vscodePid: 777001, windowId: 'w-a' }] };
  assert.strictEqual(
    ServerManager.entryHasLiveAdopters(selfOnly, { excludeVscodePid: 777001, isProcessAlive: () => true }),
    false
  );
  assert.strictEqual(
    ServerManager.entryHasLiveAdopters(selfOnly, { excludeVscodePid: 999999, isProcessAlive: () => true }),
    true
  );

  ServerManager.removeAdopterFromRegistry(file, { vscodePid: 777001 });
  entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(entries[0].attachers, [{ vscodePid: 777003, windowId: null }]);

  ServerManager.removeAdopterFromRegistry(file, { vscodePid: 777003 });
  entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(entries[0].attachers, [], 'the last attacher removal leaves an empty list');
});

test('ownedChildHasLiveAdopters reflects the registry for this manager child', async (t) => {
  const file = path.join(os.tmpdir(), `dsh-owned-adopt-${process.pid}-${Date.now()}.json`);
  t.after(() => fs.rmSync(file, { force: true }));
  fs.writeFileSync(file, JSON.stringify([
    {
      pid: process.pid, port: 32160, host: '127.0.0.1', cwd: null,
      vscodePid: 555010, windowId: 'w-owner', at: 1,
      // process.pid is really alive, so the default liveness check passes.
      attachers: [{ vscodePid: process.pid, windowId: 'w-live' }],
    },
  ], null, 2));

  const manager = new ServerManager();
  manager.setOwnerIdentity({ vscodePid: 555010, windowId: 'w-owner' });
  manager._child = { pid: process.pid };
  assert.strictEqual(
    await manager.ownedChildHasLiveAdopters(file),
    true,
    'a live attacher keeps the shared instance protected'
  );

  fs.writeFileSync(file, JSON.stringify([
    {
      pid: process.pid, port: 32160, host: '127.0.0.1', cwd: null,
      vscodePid: 555010, windowId: 'w-owner', at: 1,
      attachers: [{ vscodePid: 777102, windowId: 'w-dead' }],
    },
  ], null, 2));
  assert.strictEqual(
    await manager.ownedChildHasLiveAdopters(file),
    false,
    'a dead attacher no longer protects the instance'
  );

  manager._child = null;
  assert.strictEqual(await manager.ownedChildHasLiveAdopters(file), false, 'no owned child → no protection');
});

test('sweepDeadOwnerEntries keeps a dead-owner instance alive while attachers live', async (t) => {
  const file = path.join(os.tmpdir(), `dsh-sweep-adopt-${process.pid}-${Date.now()}.json`);
  t.after(() => fs.rmSync(file, { force: true }));
  fs.writeFileSync(file, JSON.stringify([
    {
      pid: 7001, port: 4030, host: '127.0.0.1', cwd: null, vscodePid: 8001, windowId: 'w-owner', at: 1,
      attachers: [
        { vscodePid: 8002, windowId: 'w-live' },
        { vscodePid: 8003, windowId: 'w-dead' },
      ],
    },
  ], null, 2));
  const terminated = [];

  // Owner 8001 is dead; attacher 8002 is alive, attacher 8003 is gone.
  const swept = await ServerManager.sweepDeadOwnerEntries(file, {
    terminate: async (pid) => { terminated.push(pid); },
    isProcessAlive: (pid) => pid === 8002,
    verify: () => null, // hermetic: skip the real process-identity check
    currentVscodePid: null,
  });

  assert.deepStrictEqual(swept, [], 'a live attacher protects the dead-owner instance');
  assert.deepStrictEqual(terminated, []);
  const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(kept.length, 1);
  assert.deepStrictEqual(kept[0].attachers, [{ vscodePid: 8002, windowId: 'w-live' }],
    'dead attacher pids are pruned in the same pass');

  // Once the last attacher is gone too, the orphan is reclaimed.
  const sweptLater = await ServerManager.sweepDeadOwnerEntries(file, {
    terminate: async (pid) => { terminated.push(pid); },
    isProcessAlive: () => false,
    verify: () => null, // hermetic: skip the real process-identity check
    currentVscodePid: null,
  });
  assert.deepStrictEqual(sweptLater.map((entry) => entry.pid), [7001]);
  assert.deepStrictEqual(terminated, [7001]);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), []);
});

test('adoptRunningDsh records the adopting window in the instance registry', async (t) => {
  const dshServer = createDshHttpServer();
  await listen(dshServer);
  const port = dshServer.address().port;
  t.after(() => close(dshServer));

  const file = path.join(os.tmpdir(), `dsh-adopt-reg-${process.pid}-${Date.now()}.json`);
  t.after(() => fs.rmSync(file, { force: true }));
  fs.writeFileSync(file, JSON.stringify([
    { pid: process.pid, port, host: '127.0.0.1', cwd: null, vscodePid: 424242, windowId: 'w-origin', at: Date.now() },
  ], null, 2));

  const manager = new ServerManager();
  manager.setOwnerIdentity({ vscodePid: process.pid, windowId: 'w-adopter' });
  t.after(() => manager.stop());
  const handle = await manager.adoptRunningDsh('127.0.0.1', port, { registryFile: file });

  assert.strictEqual(handle.owned, false);
  const entry = JSON.parse(fs.readFileSync(file, 'utf8'))[0];
  assert.deepStrictEqual(entry.attachers, [{ vscodePid: process.pid, windowId: 'w-adopter' }],
    'the adoption must be visible to the spawning window exit path and the sweep');
});

// ---------------------------------------------------------------------------
// dsh 0.1.2+ auth fence: token-aware probing, reuse and adoption
//
// dsh ≥ 0.1.2-rc.1 answers a tokenless GET / with 401 and fences every /api
// call behind a cookie minted from the launch token. A tokenless probe
// therefore classifies a HEALTHY fenced instance as not-DSH: ensureServer
// used to kill + respawn its own healthy child on every repeated ensure, and
// adopted handles carried no token so workspace binding 401'd.
// ---------------------------------------------------------------------------

/** Minimal stand-in for the dsh auth fence: 401 without token, 303 with. */
function createFencedDshServer(token) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://dsh.invalid');
    if (req.method === 'GET' && url.pathname === '/' && url.searchParams.get('token') === token) {
      res.writeHead(303, {
        'cache-control': 'no-store',
        location: '/',
        'set-cookie': `dsh-auth-test=signed; Path=/`,
      });
      res.end();
      return;
    }
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('dsh web authentication required; reopen the URL printed by dsh web.\n');
  });
}

test('probe recognizes a fenced dsh instance only when it carries the launch token', async (t) => {
  const fenced = createFencedDshServer('SECRET-TOKEN');
  await listen(fenced);
  const port = fenced.address().port;
  t.after(() => close(fenced));

  const manager = new ServerManager();
  assert.deepStrictEqual(
    await manager.probe('127.0.0.1', port),
    { reachable: true, isDsh: false },
    'the tokenless probe must not mistake the fence for a non-DSH service upgrade'
  );
  assert.deepStrictEqual(
    await manager.probe('127.0.0.1', port, { token: 'SECRET-TOKEN' }),
    { reachable: true, isDsh: true }
  );
  assert.deepStrictEqual(
    await manager.probe('127.0.0.1', port, { token: 'WRONG' }),
    { reachable: true, isDsh: false },
    'a rejected token must not classify as DSH'
  );
});

test('a repeated ensure keeps a healthy fenced owned child and returns the tokened handle', async (t) => {
  const fenced = createFencedDshServer('SECRET-TOKEN');
  await listen(fenced);
  const port = fenced.address().port;
  t.after(() => close(fenced));

  const manager = new ServerManager();
  let killed = false;
  manager._killChild = async () => { killed = true; }; // must never fire here
  manager._child = { pid: 4242 };
  manager._ownedServer = {
    url: `http://127.0.0.1:${port}`,
    host: '127.0.0.1',
    port,
    pid: 4242,
    owned: true,
    authToken: 'SECRET-TOKEN',
    authUrl: `http://127.0.0.1:${port}/?token=SECRET-TOKEN`,
  };
  t.after(() => manager.stop());

  const handle = await manager.ensureServer({
    host: '127.0.0.1', port, autoStart: true, cwd: null, shareMode: 'window',
  });

  assert.strictEqual(killed, false, 'the healthy fenced child must not be killed');
  assert.strictEqual(handle.owned, true);
  assert.strictEqual(handle.pid, 4242);
  assert.strictEqual(handle.authToken, 'SECRET-TOKEN',
    'the reuse handle must keep the launch token so the API stays authenticated');
  assert.strictEqual(handle.authUrl, `http://127.0.0.1:${port}/?token=SECRET-TOKEN`);
});

test('a repeated ensure still replaces a dead owned child', async (t) => {
  const manager = new ServerManager();
  let killed = false;
  manager._killChild = async () => { killed = true; };
  manager._child = { pid: 4243 };
  manager._ownedServer = {
    url: 'http://127.0.0.1:43099', host: '127.0.0.1', port: 43099, pid: 4243, owned: true,
  };
  t.after(() => manager.stop());

  // Port 43099 refuses connections: the child is gone → stop + respawn path.
  await assert.rejects(
    manager.ensureServer({ host: '127.0.0.1', port: 43099, autoStart: true, cwd: null, shareMode: 'window' }),
    () => true
  );
  assert.strictEqual(killed, true, 'a dead own child must be cleaned up before respawning');
});

test('adoptRunningDsh recovers the launch token from the registry spawn log', async (t) => {
  const fenced = createFencedDshServer('SECRET-TOKEN');
  await listen(fenced);
  const port = fenced.address().port;
  t.after(() => close(fenced));

  const logFile = path.join(os.tmpdir(), `dsh-fenced-log-${process.pid}-${Date.now()}.log`);
  fs.writeFileSync(logFile, [
    'some earlier output',
    `dsh web: http://127.0.0.1:${port}/?token=SECRET-TOKEN`,
    '',
  ].join('\n'));
  t.after(() => fs.rmSync(logFile, { force: true }));

  const file = path.join(os.tmpdir(), `dsh-fenced-reg-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify([
    { pid: process.pid, port, host: '127.0.0.1', cwd: null, at: Date.now(), log: logFile },
  ], null, 2));
  t.after(() => fs.rmSync(file, { force: true }));

  const manager = new ServerManager();
  t.after(() => manager.stop());
  const handle = await manager.adoptRunningDsh('127.0.0.1', port, { registryFile: file });

  assert.ok(handle, 'a fenced instance recorded in the registry must be adoptable');
  assert.strictEqual(handle.owned, false);
  assert.strictEqual(handle.authToken, 'SECRET-TOKEN',
    'the adopted handle must carry the recovered token so workspace binding can authenticate');
  assert.strictEqual(handle.authUrl, `http://127.0.0.1:${port}/?token=SECRET-TOKEN`);
});

test('adoptRunningDsh still refuses a fenced instance without a recoverable token', async (t) => {
  const fenced = createFencedDshServer('SECRET-TOKEN');
  await listen(fenced);
  const port = fenced.address().port;
  t.after(() => close(fenced));

  const manager = new ServerManager();
  t.after(() => manager.stop());
  assert.strictEqual(
    await manager.adoptRunningDsh('127.0.0.1', port, { registryFile: null }),
    null,
    'no registry entry → no token → the fenced instance stays unadoptable'
  );
});

// Live bug 2026-09-18 (multi-window sharing): Step A of shared-instance mode
// was gated on `isDsh`, which a tokenless probe of a HEALTHY fenced instance
// never reports — so a sibling window could not adopt the running shared
// instance and spawned a second one (3081 + 3082 in one WSL environment).

test('shared environment mode adopts a fenced shared instance through the registry token', async (t) => {
  const fenced = createFencedDshServer('SECRET-TOKEN');
  await listen(fenced);
  const port = fenced.address().port;
  t.after(() => close(fenced));

  const file = path.join(os.tmpdir(), `dsh-shared-fenced-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify([
    { pid: process.pid, port, host: '127.0.0.1', cwd: null, at: Date.now(), authToken: 'SECRET-TOKEN' },
  ], null, 2));
  t.after(() => fs.rmSync(file, { force: true }));

  const manager = new NoSpawnManager();
  t.after(() => manager.stop());
  const handle = await manager.ensureServer({
    host: '127.0.0.1', port, autoStart: true, cwd: null, registryFile: file, shareMode: 'environment',
    discoverDshWebPorts: async () => [],
  });

  assert.strictEqual(manager.spawnBranch, false, 'a reachable fenced instance must be adopted, not spawned past');
  assert.strictEqual(handle.owned, false);
  assert.strictEqual(handle.port, port);
  assert.strictEqual(handle.authToken, 'SECRET-TOKEN', 'the adopted handle must authenticate the API');
  assert.strictEqual(handle.managed, true,
    'an instance recorded by this extension is extension bookkeeping, not the user’s');
  assert.strictEqual(handle.pid, process.pid, 'the adopted handle carries the registry pid');
});

test('an adopted instance the registry does not know is not marked managed', async (t) => {
  const dshServer = createDshHttpServer();
  await listen(dshServer);
  const port = dshServer.address().port;
  t.after(() => close(dshServer));

  const file = path.join(os.tmpdir(), `dsh-shared-foreign-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(file, '[]');
  t.after(() => fs.rmSync(file, { force: true }));

  const manager = new NoSpawnManager();
  t.after(() => manager.stop());
  const handle = await manager.ensureServer({
    host: '127.0.0.1', port, autoStart: true, cwd: null, registryFile: file, shareMode: 'environment',
  });

  // A plain `dsh web` the user started themselves: adopted, but its workspace
  // registration still goes through the consent gate.
  assert.strictEqual(handle.managed, undefined);
  assert.strictEqual(handle.pid, null);
});

test('_launchTokenFromRegistry prefers the recorded token over the spawn log', (t) => {
  const logFile = path.join(os.tmpdir(), `dsh-pref-log-${process.pid}-${Date.now()}.log`);
  fs.writeFileSync(logFile, 'dsh web: http://127.0.0.1:3080/?token=LOG-TOKEN\n');
  t.after(() => fs.rmSync(logFile, { force: true }));

  const file = path.join(os.tmpdir(), `dsh-pref-reg-${process.pid}-${Date.now()}.json`);
  t.after(() => fs.rmSync(file, { force: true }));
  fs.writeFileSync(file, JSON.stringify([
    { pid: process.pid, port: 3080, host: '127.0.0.1', authToken: 'REGISTRY-TOKEN', log: logFile },
  ], null, 2));
  assert.strictEqual(ServerManager._launchTokenFromRegistry(file, '127.0.0.1', 3080), 'REGISTRY-TOKEN');

  // Legacy entry: no token field, the spawn log is the only source.
  fs.writeFileSync(file, JSON.stringify([
    { pid: process.pid, port: 3080, host: '127.0.0.1', log: logFile },
  ], null, 2));
  assert.strictEqual(ServerManager._launchTokenFromRegistry(file, '127.0.0.1', 3080), 'LOG-TOKEN');

  // Dead entry: another window's exited instance must never hand out a token.
  fs.writeFileSync(file, JSON.stringify([
    { pid: 2147483646, port: 3080, host: '127.0.0.1', authToken: 'REGISTRY-TOKEN', log: logFile },
  ], null, 2));
  assert.strictEqual(ServerManager._launchTokenFromRegistry(file, '127.0.0.1', 3080), null);
});

test('ready registry entries record the launch token and the file is private', (t) => {
  const file = path.join(os.tmpdir(), `dsh-token-reg-${process.pid}-${Date.now()}.json`);
  t.after(() => fs.rmSync(file, { force: true }));
  const manager = new ServerManager();
  manager._finalizeReady('127.0.0.1', 4324, '/ws', 98767, file, null, 'SECRET-TOKEN');
  const entry = JSON.parse(fs.readFileSync(file, 'utf8'))[0];
  assert.strictEqual(entry.authToken, 'SECRET-TOKEN',
    'a sibling window must be able to adopt this instance without reading the spawn log');
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600,
      'the registry carries a live credential and must stay owner-only');
  }

  // A tokenless runtime (dsh < 0.1.2) records no token key at all.
  const file2 = path.join(os.tmpdir(), `dsh-notoken-reg-${process.pid}-${Date.now()}.json`);
  t.after(() => fs.rmSync(file2, { force: true }));
  manager._finalizeReady('127.0.0.1', 4325, null, 98768, file2, null);
  assert.strictEqual('authToken' in JSON.parse(fs.readFileSync(file2, 'utf8'))[0], false);
});

test('launchTokenFromSpawnLog extracts the token and tolerates missing files', (t) => {
  const logFile = path.join(os.tmpdir(), `dsh-token-log-${process.pid}-${Date.now()}.log`);
  t.after(() => fs.rmSync(logFile, { force: true }));
  fs.writeFileSync(logFile, 'noise\ndsh web: http://127.0.0.1:3080/?token=AbC-123\nmore noise\n');
  assert.strictEqual(ServerManager.launchTokenFromSpawnLog(logFile), 'AbC-123');

  fs.writeFileSync(logFile, 'dsh web: http://127.0.0.1:3080\n'); // legacy: no token
  assert.strictEqual(ServerManager.launchTokenFromSpawnLog(logFile), null);

  assert.strictEqual(ServerManager.launchTokenFromSpawnLog(logFile + '.missing'), null);
  assert.strictEqual(ServerManager.launchTokenFromSpawnLog(null), null);
});

// ---------------------------------------------------------------------------
// Cross-environment isolation (live bug 2026-10-12).
//
// A WSL window whose PATH held only the Windows-side pnpm shim started a
// Windows-hosted DSH, and every window of that environment then adopted it:
// the instance sees only Windows paths, so each `workspace/create` answered
// `workspace/invalid-path` and the sidebar could not bind at all. The
// registry now stamps the environment an instance runs in and every adoption
// path refuses a differing one.
// ---------------------------------------------------------------------------

test('_adoptionFacts trusts a stamped environment and observes only pre-stamp entries', async (t) => {
  const file = path.join(os.tmpdir(), `dsh-facts-${process.pid}-${Date.now()}.json`);
  t.after(() => fs.rmSync(file, { force: true }));
  const entry = { pid: process.pid, port: 4460, host: '127.0.0.1', cwd: null, at: Date.now() };

  fs.writeFileSync(file, JSON.stringify([{ ...entry, runtimeEnvironment: 'windows' }]));
  assert.strictEqual(
    ServerManager._adoptionFacts(file, '127.0.0.1', 4460, 'wsl').foreign, true,
    'a Windows-stamped instance is foreign to a WSL window'
  );
  assert.strictEqual(
    ServerManager._adoptionFacts(file, '127.0.0.1', 4460, 'windows').foreign, false,
    'the same instance is native to a Windows window'
  );

  // Pre-stamp entry: the field is absent, so the process is asked — WSL
  // interop is observable in /proc, which is the only way to catch a child
  // an older version spawned from a /mnt/c shim.
  fs.writeFileSync(file, JSON.stringify([entry]));
  const observed = [];
  const deps = { detectProcessEnvironment: (pid) => { observed.push(pid); return 'windows'; } };
  assert.strictEqual(ServerManager._adoptionFacts(file, '127.0.0.1', 4460, 'wsl', deps).foreign, true);
  assert.deepStrictEqual(observed, [process.pid]);
  // An unobservable process is never foreign: adoption must stay intact on
  // every platform this side cannot inspect.
  assert.strictEqual(ServerManager._adoptionFacts(file, '127.0.0.1', 4460, 'wsl', {
    detectProcessEnvironment: () => 'unknown',
  }).foreign, false);

  // Port/host mismatch or a dead pid: no live entry, no verdict, no refusal.
  assert.deepStrictEqual(ServerManager._adoptionFacts(file, '127.0.0.1', 4461, 'wsl'), {
    entry: null, foreign: false,
  });
});

test('adoptRunningDsh refuses a foreign instance without probing it', async (t) => {
  const file = path.join(os.tmpdir(), `dsh-foreign-adopt-${process.pid}-${Date.now()}.json`);
  t.after(() => fs.rmSync(file, { force: true }));
  // Nothing listens on 4462: the refusal has to come from the registry
  // evidence alone, before any probe spends the settle budget on an instance
  // this window can never use.
  fs.writeFileSync(file, JSON.stringify([
    {
      pid: process.pid, port: 4462, host: '127.0.0.1', cwd: null,
      vscodePid: 424242, windowId: 'w-windows', at: Date.now(), runtimeEnvironment: 'windows',
    },
  ], null, 2));

  const statuses = [];
  const manager = new ServerManager({ onStatus: (status) => statuses.push(status) });
  manager.setOwnerIdentity({ vscodePid: process.pid, windowId: 'w-wsl', environment: 'wsl' });
  t.after(() => manager.stop());

  assert.strictEqual(
    await manager.adoptRunningDsh('127.0.0.1', 4462, { registryFile: file, settleMs: 500 }),
    null
  );
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(file, 'utf8')).map((e) => e.pid), [process.pid],
    'a SIBLING window’s instance is never killed or unregistered — only refused'
  );
  const refusals = statuses.filter((status) => status.state === 'selfheal');
  assert.strictEqual(refusals.length, 1, 'the refusal is reported once, not once per settle round');
  assert.match(refusals[0].message, /another OS environment/);
  assert.strictEqual(refusals[0].params.port, 4462);
  assert.ok(typeof refusals[0].params.environment === 'string' && refusals[0].params.environment.length > 0);
});

test('a foreign instance owned by this window is stopped and unregistered', async (t) => {
  // The window that spawned the foreign child itself (a spawn from before this
  // gate existed, or a stale entry): the activation sweep deliberately leaves
  // current-window entries alone, so nothing else would ever clean it up.
  // A detached child stands in for the DSH process and is its own process
  // group, so the tree-kill cannot reach anything but it.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  t.after(() => {
    try { process.kill(child.pid, 'SIGKILL'); } catch { /* already stopped */ }
  });

  const file = path.join(os.tmpdir(), `dsh-foreign-own-${process.pid}-${Date.now()}.json`);
  t.after(() => fs.rmSync(file, { force: true }));
  fs.writeFileSync(file, JSON.stringify([
    {
      pid: child.pid, port: 4463, host: '127.0.0.1', cwd: null,
      vscodePid: process.pid, windowId: 'w-owner', at: Date.now(), runtimeEnvironment: 'windows',
    },
  ], null, 2));

  const manager = new ServerManager();
  manager.setOwnerIdentity({ vscodePid: process.pid, windowId: 'w-owner', environment: 'wsl' });
  t.after(() => manager.stop());

  assert.strictEqual(await manager.adoptRunningDsh('127.0.0.1', 4463, { registryFile: file }), null);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [],
    'its registry entry is dropped so the next pass can start a native instance');

  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => {
      child.once('exit', resolve);
      setTimeout(resolve, 5000).unref();
    });
  }
  assert.ok(
    child.exitCode !== null || child.signalCode !== null,
    'the foreign child of this window must actually be stopped'
  );
});

test('an instance stamped with this window’s own environment is still adopted', async (t) => {
  const dshServer = createDshHttpServer();
  await listen(dshServer);
  const port = dshServer.address().port;
  t.after(() => close(dshServer));

  const file = path.join(os.tmpdir(), `dsh-native-adopt-${process.pid}-${Date.now()}.json`);
  t.after(() => fs.rmSync(file, { force: true }));
  fs.writeFileSync(file, JSON.stringify([
    {
      pid: process.pid, port, host: '127.0.0.1', cwd: null,
      vscodePid: 424242, windowId: 'w-origin', at: Date.now(), runtimeEnvironment: 'wsl',
    },
  ], null, 2));

  const manager = new ServerManager();
  manager.setOwnerIdentity({ vscodePid: process.pid, windowId: 'w-adopter', environment: 'wsl' });
  t.after(() => manager.stop());
  const handle = await manager.adoptRunningDsh('127.0.0.1', port, { registryFile: file });

  assert.ok(handle, 'the same environment’s instance stays adoptable');
  assert.strictEqual(handle.owned, false);
  assert.strictEqual(handle.managed, true);
  assert.strictEqual(handle.pid, process.pid);
});

class PortRecordingManager extends ServerManager {
  constructor() {
    super();
    this.spawnedPort = null;
  }

  async _spawnAndWait(host, port) {
    this.spawnedPort = port;
    throw new Error('spawn-branch-reached');
  }
}

test('shared mode scans past a foreign occupant instead of adopting or colliding', async (t) => {
  const dshServer = createDshHttpServer();
  await listen(dshServer);
  const port = dshServer.address().port;
  t.after(() => close(dshServer));

  const file = path.join(os.tmpdir(), `dsh-shared-foreign-occ-${process.pid}-${Date.now()}.json`);
  t.after(() => fs.rmSync(file, { force: true }));
  fs.writeFileSync(file, JSON.stringify([
    {
      pid: process.pid, port, host: '127.0.0.1', cwd: null,
      vscodePid: 424242, windowId: 'w-windows', at: Date.now(), runtimeEnvironment: 'windows',
    },
  ], null, 2));

  const manager = new PortRecordingManager();
  manager.setOwnerIdentity({ vscodePid: process.pid, windowId: 'w-wsl', environment: 'wsl' });
  t.after(() => manager.stop());
  await assert.rejects(
    manager.ensureServer({
      host: '127.0.0.1', port, autoStart: true, cwd: null, registryFile: file, shareMode: 'environment',
      discoverDshWebPorts: async () => [],
    }),
    /spawn-branch-reached/
  );
  assert.ok(
    manager.spawnedPort > port,
    `the foreign occupant keeps its port; this window spawns past it (got ${manager.spawnedPort})`
  );
});

test('the activation sweep treats a foreign entry like any other window’s child', async (t) => {
  // The sweep is about dead OWNERS, not about environments: a foreign entry of
  // a live window must survive untouched, and one whose owner died is cleaned
  // up by the same rules as a native child (nothing else would ever remove it).
  const file = path.join(os.tmpdir(), `dsh-sweep-foreign-${process.pid}-${Date.now()}.json`);
  t.after(() => fs.rmSync(file, { force: true }));
  fs.writeFileSync(file, JSON.stringify([
    { pid: 7101, port: 4470, host: '127.0.0.1', vscodePid: 9201, at: 1, runtimeEnvironment: 'windows' },
    { pid: 7102, port: 4471, host: '127.0.0.1', vscodePid: 9202, at: 2, runtimeEnvironment: 'windows' },
  ], null, 2));
  const terminated = [];

  const swept = await ServerManager.sweepDeadOwnerEntries(file, {
    terminate: async (pid) => { terminated.push(pid); },
    isProcessAlive: (pid) => pid === 9201, // 9201 alive, 9202 dead
    verify: () => null, // hermetic: skip the real process-identity check
    currentVscodePid: null,
  });

  assert.deepStrictEqual(swept.map((entry) => entry.pid), [7102]);
  assert.deepStrictEqual(terminated, [7102], 'a live window’s child is never touched');
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(file, 'utf8')).map((entry) => entry.pid), [7101]
  );
});

test('_finalizeReady stamps the environment the child runs in', (t) => {
  const file = path.join(os.tmpdir(), `dsh-env-stamp-${process.pid}-${Date.now()}.json`);
  t.after(() => fs.rmSync(file, { force: true }));

  // An observable process wins: /proc is the only witness for a child spawned
  // from a foreign shim, whose resolved runtime shape looks native.
  const observed = new ServerManager();
  observed.setOwnerIdentity({ vscodePid: 4242, windowId: 'w-1', environment: 'wsl' });
  observed.runtimeEnvironmentFor = () => 'wsl';
  observed._finalizeReady('127.0.0.1', 4472, null, 98771, file);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8'))[0].runtimeEnvironment, 'wsl');

  // Then the resolved runtime's own environment, then this host's.
  const dshHome = path.join(os.tmpdir(), `dsh-env-home-${process.pid}`);
  const declared = new ServerManager({
    resolvedRuntime: {
      executablePath: process.execPath,
      dshHome,
      profileHome: path.join(dshHome, 'profiles', 'web'),
      profileName: 'web',
      entrypointArgs: [],
    },
  });
  declared.setOwnerIdentity({ vscodePid: 4242, windowId: 'w-2', environment: 'linux' });
  declared._finalizeReady('127.0.0.1', 4473, null, 98772, file);
  assert.strictEqual(
    JSON.parse(fs.readFileSync(file, 'utf8'))[0].runtimeEnvironment,
    detectRuntimeEnvironment().id,
    'the resolved runtime carries the environment it was resolved FOR'
  );

  const host = new ServerManager();
  host.setOwnerIdentity({ vscodePid: 4242, windowId: 'w-3', environment: 'linux' });
  host._finalizeReady('127.0.0.1', 4474, null, 98773, file);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8'))[0].runtimeEnvironment, 'linux');
});

test('autoStart=false refuses a foreign instance on the configured port', async (t) => {
  // This path adopts anything reachable without a registry lookup, so it can
  // only be gated on registry EVIDENCE: an entry naming the other environment
  // is refused (and, being un-recoverable here, surfaced as an error), while
  // a hand-started `dsh web` with no entry stays adoptable.
  const dshServer = createDshHttpServer();
  await listen(dshServer);
  const port = dshServer.address().port;
  t.after(() => close(dshServer));

  const file = path.join(os.tmpdir(), `dsh-step3-foreign-${process.pid}-${Date.now()}.json`);
  t.after(() => fs.rmSync(file, { force: true }));
  fs.writeFileSync(file, JSON.stringify([
    {
      pid: process.pid, port, host: '127.0.0.1', cwd: null,
      vscodePid: 424242, windowId: 'w-windows', at: Date.now(), runtimeEnvironment: 'windows',
    },
  ], null, 2));

  const manager = new ServerManager();
  manager.setOwnerIdentity({ vscodePid: process.pid, windowId: 'w-wsl', environment: 'wsl' });
  t.after(() => manager.stop());
  await assert.rejects(
    manager.ensureServer({ host: '127.0.0.1', port, autoStart: false, cwd: null, registryFile: file }),
    (error) => error.code === 'RUNTIME_FOREIGN_INSTANCE'
      && error.params.port === port
      && typeof error.params.host === 'string'
  );

  // Same port, no entry: the user's own `dsh web` is still adopted.
  fs.writeFileSync(file, '[]');
  const handle = await manager.ensureServer({
    host: '127.0.0.1', port, autoStart: false, cwd: null, registryFile: file,
  });
  assert.strictEqual(handle.owned, false);
  assert.strictEqual(handle.port, port);
});
