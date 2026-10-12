'use strict';

/**
 * Manual reproduction: simultaneous multi-window startup race.
 *
 * Window A (the race winner) starts a "fenced DSH" TCP server on port P at
 * t=250ms and only writes its instance-registry entry (with the launch token)
 * at t=1500ms — mirroring a real dsh boot where the HTTP listener comes up
 * well before the extension's own health poll (700ms cadence) finalizes the
 * registry entry.
 *
 * Window B starts at t=0, finds P refused, spawns its own child (which dies of
 * EADDRINUSE as soon as A binds), and then gets exactly ONE adoption attempt.
 *
 * Expected today: B fails with SPAWN_EXITED_EARLY even though A becomes fully
 * adoptable ~1s later — the window shows "DeepSeek Harness unavailable" until
 * the user clicks Retry.
 *
 * Run: node test/manual/simultaneous-start-race.demo.js
 */

const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { ServerManager } = require('../../src/serverManager');

const TOKEN = 'demo-launch-token';

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

/** A fenced DSH stand-in: 401 tokenless, 303 with the token. */
function startFakeDsh(port) {
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
  return new Promise((resolve) => {
    setTimeout(() => { // dsh boots before it binds
      server.listen(port, '127.0.0.1', () => resolve(server));
    }, 250);
  });
}

async function main() {
  const port = await findFreePort();
  const registryFile = path.join(os.tmpdir(), `dsh-race-demo-${process.pid}.json`);
  fs.writeFileSync(registryFile, '[]\n');

  const t0 = Date.now();
  const at = () => `t+${String(Date.now() - t0).padStart(4)}ms`;

  // Window A: binds at 250ms, becomes fully adoptable (registry token) at 1.5s.
  const winnerServer = await startFakeDsh(port);
  setTimeout(() => {
    fs.writeFileSync(registryFile, JSON.stringify([{
      pid: process.pid, // alive, so adoption paths accept the entry
      port,
      host: '127.0.0.1',
      authToken: TOKEN,
      vscodePid: process.pid,
      windowId: 'w-winner',
      at: Date.now(),
    }], null, 2) + '\n');
    console.log(`${at()} [A] registry entry + token published`);
  }, 1500);

  // Window B: loses the port race — its own child exits early (EADDRINUSE).
  const fakeChild = new EventEmitter();
  fakeChild.pid = 424242;
  fakeChild.kill = () => {};
  fakeChild.exitCode = null;
  fakeChild.signalCode = null;
  setTimeout(() => fakeChild.emit('exit', 1, null), 50);

  // A plain regular executable file (assertLaunchableRuntime rejects symlinks).
  const fakeRuntime = path.join(os.tmpdir(), `dsh-race-demo-runtime-${process.pid}`);
  fs.writeFileSync(fakeRuntime, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const manager = new ServerManager({
    spawnFn: () => fakeChild,
  });
  manager.setResolvedRuntime({
    executablePath: fakeRuntime,
    dshHome: os.tmpdir(),
    profileHome: path.join(os.tmpdir(), 'profiles', 'web'),
  });
  manager.setOwnerIdentity({ vscodePid: process.pid, windowId: 'w-loser' });

  try {
    const handle = await manager.ensureServer({
      host: '127.0.0.1',
      port,
      autoStart: true,
      cwd: null,
      registryFile,
      shareMode: 'environment',
      discoverDshWebPorts: async () => [],
    });
    console.log(`${at()} [B] SUCCESS — adopted A's instance on port ${handle.port} (managed=${handle.managed === true})`);
  } catch (err) {
    console.log(`${at()} [B] FAILED — ${err.code || err.name}: ${err.message.split('\n')[0]}`);
    console.log('      (the user sees "DeepSeek Harness unavailable" + Retry, even though');
    console.log('       window A becomes adoptable moments later)');
  } finally {
    winnerServer.close();
    try { fs.unlinkSync(registryFile); } catch { /* cleanup */ }
  }
}

main();
