'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ServerManager,
  CLOSE_POLICIES,
  normalizeClosePolicy,
  shouldStopOnViewClose,
  shouldStopOwnedServer,
  sameEndpoint,
  reconcileConfigChange,
} = require('../src/serverManager');

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
    await manager.probe('127.0.0.1', closedPort),
    { reachable: false }
  );
  assert.strictEqual(await manager.healthCheck(`http://127.0.0.1:${dshPort}/`), true);
  assert.strictEqual(await manager.healthCheck(`http://127.0.0.1:${plainPort}/`), false);

  const freePort = await manager._findFreePort('127.0.0.1', plainPort);
  assert.ok(
    freePort > plainPort && freePort <= plainPort + SELF_TEST_PORT_SCAN_LIMIT,
    `free=${freePort}`
  );
  assert.strictEqual((await manager.probe('127.0.0.1', freePort)).reachable, false);

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
    { reachable: false }
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
    profileHome: path.join(root, 'profiles', 'vscode'),
    profileName: 'vscode',
    entrypointArgs: [],
  };

  const manager = new ServerManager({ resolvedRuntime: runtime, embedPatchPath: overlay });
  const launch = manager._buildLaunchSpec('127.0.0.1', 4321);
  assert.strictEqual(launch.command, executable);
  assert.deepStrictEqual(launch.args, [
    '--patch', overlay, '--profile', 'vscode', '--host', '127.0.0.1', '--port', '4321',
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
      this.probeWithRetry = async () => ({ reachable: false });
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
