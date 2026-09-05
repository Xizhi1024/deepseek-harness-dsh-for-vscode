'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { StartupGate } = require('../../src/startupGate');
const { LifecycleQueue } = require('../../src/lifecycle');
const { ServerManager } = require('../../src/serverManager');

test('duplicate connection requests share one operation; later explicit retry works', async () => {
  const queue = new LifecycleQueue();
  let calls = 0;
  const operation = async () => { calls++; return 42; };
  const values = await Promise.all(Array.from({ length: 20 }, () => queue.enqueueOnce('connect', operation)));
  assert.equal(calls, 1);
  assert.ok(values.every((value) => value === 42));
  await queue.enqueueOnce('connect', operation);
  assert.equal(calls, 2);
});

test('failed automatic startups cool down, explicit retries bypass, success clears cooldown', async () => {
  let now = 0;
  let calls = 0;
  const gate = new StartupGate({ now: () => now, cooldownMs: 30 });
  const fail = async () => { calls++; return false; };
  await gate.run(fail);
  for (let i = 0; i < 20; i++) await gate.run(fail);
  assert.equal(calls, 1);
  await gate.run(fail, { force: true });
  assert.equal(calls, 2);
  now = 31;
  await gate.run(fail);
  assert.equal(calls, 3);
  await gate.run(async () => true, { force: true });
  await gate.run(fail);
  assert.equal(calls, 4);
});

test('authenticated owned server is reused without stopping or replacing it', async () => {
  const manager = new ServerManager();
  manager._child = { pid: 12345 };
  const own = { host: '127.0.0.1', port: 3080, pid: 12345, url: 'http://127.0.0.1:3080/?token=synthetic' }; // allow-secret-scan
  manager._ownedServer = own;
  manager.probe = async (_host, _port, target) => ({ reachable: true, isDsh: target === '/?token=synthetic' }); // allow-secret-scan
  manager.stop = async () => assert.fail('must not stop a healthy owned child');
  manager._spawnAndWait = async () => assert.fail('must not replace a healthy owned child');
  const reused = await manager.ensureServer({ autoStart: true });
  assert.equal(reused.url, own.url);
  assert.equal(reused.owned, true);
});
