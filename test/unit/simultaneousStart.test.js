'use strict';

/**
 * Regression tests for the multi-window simultaneous-start race.
 *
 * Live bug 2026-09-18 (N windows starting at once, mixed Windows/WSL
 * projects): every window probes the shared port, one spawns and wins, the
 * losers' children die of EADDRINUSE — and the losers then had exactly ONE
 * adoption attempt, which expired long before the winner's instance became
 * adoptable (its launch token lands in the instance registry only after the
 * winner's own health poll finalizes the entry). The losing window showed
 * "DeepSeek Harness unavailable" until a manual Retry.
 *
 * The fix gives the shared-mode adoption paths a bounded settle loop that
 * re-probes and re-reads the registry until the booting sibling answers, and
 * guards the registry itself with atomic publishes plus an inter-process
 * lock (concurrent activations used to drop the winner's fresh entry, which
 * permanently un-adoptable'd that instance).
 */

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const { ServerManager } = require('../../src/serverManager');

const TOKEN = 'simultaneous-start-test-token';

function tempRegistryFile(label) {
  return path.join(os.tmpdir(), `dsh-simultaneous-${label}-${process.pid}-${Date.now()}.json`);
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * A fenced-DSH stand-in with a two-phase boot: after `bindDelayMs` it starts
 * answering (401 tokenless / 303 with the token); after `tokenDelayMs` the
 * "owning window" publishes the registry entry carrying that token — the
 * moment at which a sibling can adopt the instance at all.
 */
function startBootingFakedDsh({ port, bindDelayMs, tokenDelayMs, registryFile }) {
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      const firstLine = String(chunk).split('\r\n')[0] || '';
      if (firstLine.startsWith(`GET /?token=${TOKEN} `)) {
        socket.end('HTTP/1.1 303 Found\r\nLocation: /\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      } else {
        socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      }
    });
  });
  const bindTimer = setTimeout(() => server.listen(port, '127.0.0.1'), bindDelayMs);
  const tokenTimer = setTimeout(() => {
    fs.writeFileSync(registryFile, JSON.stringify([{
      pid: process.pid, // alive, so adoption paths accept the entry
      port,
      host: '127.0.0.1',
      authToken: TOKEN,
      vscodePid: process.pid,
      windowId: 'w-winner',
      at: Date.now(),
    }], null, 2) + '\n');
  }, tokenDelayMs);
  return {
    async close() {
      clearTimeout(bindTimer);
      clearTimeout(tokenTimer);
      await new Promise((resolve) => server.close(resolve));
      server.closeAllConnections?.();
    },
  };
}

/** A child that dies immediately, standing in for the EADDRINUSE loser. */
function exitingChild(exitCode = 1) {
  const child = new EventEmitter();
  child.pid = 424242;
  child.kill = () => {};
  child.exitCode = null;
  child.signalCode = null;
  setImmediate(() => child.emit('exit', exitCode, null));
  return child;
}

function newLoserManager({ registryFile }) {
  // A plain regular executable file (assertLaunchableRuntime rejects symlinks).
  // Windows additionally requires the .exe suffix (native entrypoint check).
  const fakeRuntime = path.join(os.tmpdir(), `dsh-simultaneous-runtime-${process.pid}${process.platform === 'win32' ? '.exe' : ''}`);
  fs.writeFileSync(fakeRuntime, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const manager = new ServerManager({ spawnFn: () => exitingChild(1) });
  manager.setResolvedRuntime({
    executablePath: fakeRuntime,
    dshHome: os.tmpdir(),
    profileHome: path.join(os.tmpdir(), 'profiles', 'web'),
  });
  manager.setOwnerIdentity({ vscodePid: process.pid, windowId: 'w-loser' });
  return manager;
}

test('simultaneous start: the race loser settles onto the winner once its token lands', async () => {
  const port = await findFreePort();
  const registryFile = tempRegistryFile('race');
  fs.writeFileSync(registryFile, '[]\n');
  const winner = startBootingFakedDsh({ port, bindDelayMs: 100, tokenDelayMs: 900, registryFile });
  try {
    const startedAt = Date.now();
    const handle = await newLoserManager({ registryFile }).ensureServer({
      host: '127.0.0.1',
      port,
      autoStart: true,
      cwd: null,
      registryFile,
      shareMode: 'environment',
      // The process scan sees the winner's `dsh … --port P` while it boots —
      // this is what tells the catch path a sibling actually exists.
      discoverDshWebPorts: async () => [port],
    });
    const elapsed = Date.now() - startedAt;
    assert.ok(handle, 'the loser must adopt instead of surfacing SPAWN_EXITED_EARLY');
    assert.equal(handle.owned, false, 'the adopted handle is not owned by this window');
    assert.equal(handle.managed, true, 'the adopted instance is extension-managed');
    assert.equal(handle.port, port, 'adoption lands on the configured port, not a scan-forward port');
    assert.ok(elapsed >= 900, `adoption waited for the winner's token (took ${elapsed}ms)`);
  } finally {
    await winner.close();
    fs.rmSync(registryFile, { force: true });
    fs.rmSync(`${registryFile}.lock`, { force: true });
  }
});

test('simultaneous start: a genuine spawn failure with no sibling still fails fast', async () => {
  const port = await findFreePort();
  const registryFile = tempRegistryFile('nosibling');
  fs.writeFileSync(registryFile, '[]\n');
  try {
    const startedAt = Date.now();
    await assert.rejects(
      newLoserManager({ registryFile }).ensureServer({
        host: '127.0.0.1',
        port,
        autoStart: true,
        cwd: null,
        registryFile,
        shareMode: 'environment',
        discoverDshWebPorts: async () => [],
      }),
      (err) => err.code === 'SPAWN_EXITED_EARLY',
      'a broken runtime with no sibling must surface the spawn error'
    );
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 8000, `the no-sibling path must fail fast, took ${elapsed}ms`);
  } finally {
    fs.rmSync(registryFile, { force: true });
    fs.rmSync(`${registryFile}.lock`, { force: true });
  }
});

test('simultaneous start: a slow-booting loser adopts the winner mid-wait and abandons its duplicate', async () => {
  const port = await findFreePort();
  const registryFile = tempRegistryFile('midwait');
  fs.writeFileSync(registryFile, '[]\n');
  try {
    // The loser's own child boots normally (stays alive, never becomes ready
    // within the test) — the pure "must die of EADDRINUSE" shape of the race
    // above is only half the story. Under a cold multi-window start every
    // window spawns a SLOW boot; the winner becomes adoptable while the
    // losers' children are still loading, and the losers must attach the
    // moment it is adoptable instead of idling out their readiness budget on
    // a child that is doomed to lose the port race anyway.
    const winner = startBootingFakedDsh({ port, bindDelayMs: 600, tokenDelayMs: 1200, registryFile });
    const fakeRuntime = path.join(os.tmpdir(), `dsh-midwait-runtime-${process.pid}${process.platform === 'win32' ? '.exe' : ''}`);
    fs.writeFileSync(fakeRuntime, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const manager = new ServerManager({ spawnFn: () => {
      const child = new EventEmitter();
      child.pid = 424242; // stays alive: never emits 'exit'
      child.kill = () => {};
      child.exitCode = null;
      child.signalCode = null;
      return child;
    } });
    manager.setResolvedRuntime({
      executablePath: fakeRuntime,
      dshHome: os.tmpdir(),
      profileHome: path.join(os.tmpdir(), 'profiles', 'web'),
    });
    manager.setOwnerIdentity({ vscodePid: process.pid, windowId: 'w-loser' });
    manager._killChild = async () => {}; // hermetic: never taskkill in tests

    const handle = await manager.ensureServer({
      host: '127.0.0.1',
      port,
      autoStart: true,
      cwd: null,
      registryFile,
      shareMode: 'environment',
      discoverDshWebPorts: async () => [],
    });

    assert.ok(handle, 'the loser must end up attached to the winner');
    assert.equal(handle.owned, false, 'the adopted handle is not owned by this window');
    assert.equal(handle.port, port, 'adoption lands on the configured port');
    assert.equal(manager.hasOwnedChild(), false, 'the duplicate boot is abandoned before its budget expires');
    await winner.close();
  } finally {
    fs.rmSync(registryFile, { force: true });
    fs.rmSync(`${registryFile}.lock`, { force: true });
  }
});

test('instance registry: concurrent cross-process writers never lose entries', async () => {
  const registryFile = tempRegistryFile('concurrent');
  fs.writeFileSync(registryFile, '[]\n');
  const workers = 4;
  const writesPerWorker = 8;
  const script = `
    const { ServerManager } = require(${JSON.stringify(path.resolve(__dirname, '../../src/serverManager'))});
    const registryFile = process.argv[1]; // node -e: argv[1] is the first extra arg
    const workerId = Number(process.argv[2]);
    const livePid = Number(process.argv[3]); // must stay alive: _mergeRegistry drops dead-pid entries
    for (let i = 0; i < ${writesPerWorker}; i++) {
      ServerManager._mergeRegistry(registryFile, {
        pid: livePid, port: 40000 + workerId * 100 + i, host: '127.0.0.1', at: Date.now(),
      });
    }
    console.log('done');
  `;
  const children = [];
  try {
    for (let w = 0; w < workers; w++) {
      children.push(await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', script, registryFile, String(w), String(process.pid)], { stdio: 'ignore' });
        child.on('exit', (code) => (code === 0 ? resolve(child) : reject(new Error(`worker ${w} exited ${code}`))));
        child.on('error', reject);
      }));
    }
    const entries = ServerManager._readRegistryRaw(registryFile);
    assert.equal(entries.length, workers * writesPerWorker,
      `every concurrent merge must survive: got ${entries.length} entries`);
    const ports = new Set(entries.map((e) => e.port));
    assert.equal(ports.size, workers * writesPerWorker, 'no entry was overwritten or dropped');
  } finally {
    for (const child of children) child.kill();
    fs.rmSync(registryFile, { force: true });
    fs.rmSync(`${registryFile}.lock`, { force: true });
  }
});

test('instance registry: concurrent cleanup never erases a freshly merged entry', async () => {
  const registryFile = tempRegistryFile('cleanup-race');
  fs.writeFileSync(registryFile, '[]\n');
  const livePid = process.pid;
  const script = `
    const { ServerManager } = require(${JSON.stringify(path.resolve(__dirname, '../../src/serverManager'))});
    const registryFile = process.argv[2];
    const end = Date.now() + 700;
    while (Date.now() < end) ServerManager.cleanupStaleRegistry(registryFile);
    console.log('done');
  `;
  const cleaner = spawn(process.execPath, ['-e', script, registryFile], { stdio: 'ignore' });
  try {
    // Merge while the cleaner prunes in a tight loop (what N simultaneous
    // activations do); the merged entry must never be erased.
    for (let i = 0; i < 12; i++) {
      ServerManager._mergeRegistry(registryFile, {
        pid: livePid, port: 41000 + i, host: '127.0.0.1', at: Date.now(),
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const entries = ServerManager._readRegistryRaw(registryFile).filter((e) => e && e.pid === livePid);
    assert.ok(entries.length >= 12, `every merged entry must survive the concurrent cleaner (got ${entries.length})`);
  } finally {
    cleaner.kill();
    fs.rmSync(registryFile, { force: true });
    fs.rmSync(`${registryFile}.lock`, { force: true });
  }
});

test('instance registry: writes publish atomically and leave no temp files behind', async () => {
  const registryFile = tempRegistryFile('atomic');
  fs.writeFileSync(registryFile, '[]\n');
  try {
    ServerManager._mergeRegistry(registryFile, { pid: process.pid, port: 42001, host: '127.0.0.1', at: Date.now() });
    ServerManager._registerAdopter(registryFile, { port: 42001, vscodePid: process.pid, windowId: 'w-a' });
    const parsed = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    assert.equal(parsed.length, 1);
    assert.deepEqual(parsed[0].attachers, [{ vscodePid: process.pid, windowId: 'w-a' }]);
    const leftovers = fs.readdirSync(path.dirname(registryFile))
      .filter((name) => name.startsWith(path.basename(registryFile)) && name.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], 'atomic publish must clean up its temp file');
  } finally {
    fs.rmSync(registryFile, { force: true });
    fs.rmSync(`${registryFile}.lock`, { force: true });
  }
});
