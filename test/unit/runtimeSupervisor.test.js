'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { createRuntimeIdentity, createRuntimeIdentityFromResolved, identityToResolvedRuntime, runtimeIdentityKey } = require('../../src/runtime/identity');
const { supportsTargetNode, verifyNodeRuntime } = require('../../src/runtime/compatibility');
const { createRuntimeSupervisor } = require('../../src/runtime/supervisor');

const identity = (profile = 'vscode') => createRuntimeIdentity({
  runtimeVersion: '0.2.0-rc.1', integrationVersion: '0.10.0', adapterId: 'dsh-0.2.0-rc.1',
  executablePath: process.execPath, packageRoot: path.resolve('runtime'), entrypoint: path.resolve('runtime/lib/bin.js'),
  home: path.resolve('test-home'), profile, source: 'local', secret: 'must not leak',
});
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const op = () => ({ requestId: 'test', signal: new AbortController().signal });

function harness(overrides = {}) {
  const calls = { start: 0, stop: 0, prepare: 0, verify: 0, detach: 0, env: {}, options: [] };
  let owned = false;
  let count = 0;
  let now = 0;
  const manager = {
    setResolvedRuntime(value) { calls.runtime = value; },
    setEmbedPatchPath(value) { calls.patch = value; },
    setSpawnEnv(value) { calls.env = { ...calls.env, ...value }; },
    cancelPending() {},
    hasOwnedChild() { return owned; },
    async ensureServer(options) { calls.start++; calls.options.push(options); owned = options.autoStart !== false; return { owned, url: 'http://127.0.0.1:12345/?token=private' }; },
    async stop() { calls.stop++; owned = false; },
    detach() { calls.detach++; owned = false; },
  };
  const supervisor = createRuntimeSupervisor({
    resolver: async (selection) => ({ runtime: identityToResolvedRuntime(selection), serverOptions: { host: '127.0.0.1', port: 12345, autoStart: true } }),
    prepareIntegration: async () => { calls.prepare++; return { embedPatchPath: '/overlay.yml' }; },
    verifyNode: async () => { calls.verify++; return 'v24.11.1'; },
    serverManager: manager, clock: { now: () => now },
    createInstanceId: () => `instance-${++count}`, createToken: () => 'private'.repeat(8),
    createClient: (args) => {
      calls.client = args;
      return { capabilities: async () => ({ protocolVersion: 1, runtimeInstanceId: args.expectedInstanceId,
        runtimeVersion: '0.2.0-rc.1', integrationVersion: '0.10.0', adapterId: 'dsh-0.2.0-rc.1', reconnectMode: 'snapshot-reconcile',
        features: Object.fromEntries(['workspaces', 'sessions', 'prompt', 'follow', 'cancelSession'].map((name) => [name, { state: 'available' }])) }) };
    },
    ...overrides,
  });
  return { supervisor, calls, manager, advance: (ms) => { now += ms; } };
}

test('runtime identity is frozen, exact, secret-free and rejects escaped entrypoints', () => {
  const value = identity();
  assert.equal(Object.isFrozen(value), true);
  assert.equal(value.secret, undefined);
  assert.equal(runtimeIdentityKey(value), runtimeIdentityKey({ ...value }));
  assert.throws(() => createRuntimeIdentity({ ...value, runtimeVersion: 'latest' }), { code: 'UNSUPPORTED_RUNTIME' });
  assert.throws(() => createRuntimeIdentity({ ...value, entrypoint: path.resolve('outside.js') }), { code: 'INVALID_ARGUMENT' });
});

test('target Node engines exclude Node 23 and outdated Node 22', async () => {
  for (const version of ['22.19.0', 'v22.99.0', '24.0.0', '25.0.0']) assert.equal(supportsTargetNode(version), true);
  for (const version of ['22.18.0', '23.11.0', '20.20.0', '24.0.0-rc.1', 'unknown']) assert.equal(supportsTargetNode(version), false);
  let executable;
  await assert.rejects(verifyNodeRuntime('/selected/node', { execFileFn: (file, args, options, done) => {
    executable = file; assert.deepEqual(args, ['--version']); assert.equal(options.windowsHide, true); done(null, 'v23.1.0');
  } }), { code: 'UNSUPPORTED_RUNTIME' });
  assert.equal(executable, '/selected/node');
});

test('resolved identity verifies the real package root and rejects manifest version drift', async () => {
  const expected = identity();
  const resolved = { ...identityToResolvedRuntime(expected) };
  delete resolved.packageRoot;
  const readFile = async (file) => {
    if (file !== path.join(expected.packageRoot, 'package.json')) throw new Error('missing');
    return JSON.stringify({ name: '@deepseek-ai/dsh', version: expected.runtimeVersion });
  };
  assert.deepEqual(await createRuntimeIdentityFromResolved(resolved, { integrationVersion: '0.10.0', readFile }), expected);
  await assert.rejects(createRuntimeIdentityFromResolved({ ...resolved, dshVersion: '0.1.2-rc.1' }, { integrationVersion: '0.10.0', readFile }), { code: 'CONFLICT' });
  await assert.rejects(createRuntimeIdentityFromResolved({ ...resolved, entrypointArgs: [] }, { integrationVersion: '0.10.0', readFile }), { code: 'UNSUPPORTED_RUNTIME' });
});

test('concurrent ensures share startup; cancellation belongs to one caller only', async () => {
  const gate = deferred();
  const h = harness({ prepareIntegration: () => gate.promise });
  const abort = new AbortController();
  const first = h.supervisor.ensure(identity(), { requestId: 'first', signal: abort.signal });
  const second = h.supervisor.ensure(identity(), op());
  abort.abort();
  await assert.rejects(first, { code: 'CANCELLED' });
  gate.resolve({});
  const lease = await second;
  assert.equal(h.calls.start, 1);
  assert.equal(lease, await h.supervisor.ensure(identity(), op()));
  assert.equal(JSON.stringify(lease).includes('private'), false);
  assert.equal(h.calls.env.DSH_VSCODE_RUNTIME_VERSION, '0.2.0-rc.1');
  await h.supervisor.dispose();
  assert.equal(h.calls.stop, 1);
});

test('different identities serialize a stop and create a fresh instance', async () => {
  const h = harness();
  const first = await h.supervisor.ensure(identity(), op());
  const second = await h.supervisor.ensure(identity('another'), op());
  assert.notEqual(first.instanceId, second.instanceId);
  assert.equal(h.calls.start, 2);
  assert.equal(h.calls.stop, 1);
  await h.supervisor.dispose();
});

test('stop invalidates in-flight prepare so late completion cannot resurrect a child', async () => {
  const gate = deferred();
  const entered = deferred();
  const h = harness({ prepareIntegration: () => { entered.resolve(); return gate.promise; } });
  const starting = h.supervisor.ensure(identity(), op());
  await entered.promise;
  const rejected = assert.rejects(starting, { code: 'CANCELLED' });
  await h.supervisor.stop(op());
  gate.resolve({});
  await rejected;
  assert.equal(h.calls.start, 0);
  await h.supervisor.dispose();
});

test('mismatched facade identity fails closed, stops owned child, and applies cooldown', async () => {
  const h = harness({ createClient: () => ({ capabilities: async () => ({ protocolVersion: 1, runtimeInstanceId: 'foreign' }) }) });
  await assert.rejects(h.supervisor.ensure(identity(), op()), { code: 'PROTOCOL_MISMATCH' });
  assert.equal(h.calls.stop, 1);
  await assert.rejects(h.supervisor.ensure(identity(), op()), { code: 'NOT_READY' });
  assert.equal(h.calls.start, 1);
  await assert.rejects(h.supervisor.restart(op()), { code: 'PROTOCOL_MISMATCH' });
  assert.equal(h.calls.start, 2);
  await h.supervisor.dispose();
});

test('borrowed instances require trusted credentials and are never prepared, restarted or stopped', async () => {
  const selection = identity();
  const h = harness({ resolver: async () => ({ serverOptions: { autoStart: false }, borrowedCredentials: { token: 't'.repeat(32), instanceId: 'borrowed' } }) });
  const lease = await h.supervisor.ensure(selection, op());
  assert.equal(lease.owned, false);
  assert.equal(h.calls.prepare, 0);
  assert.equal(h.calls.verify, 0);
  await assert.rejects(h.supervisor.restart(op()), { code: 'FORBIDDEN' });
  await h.supervisor.stop(op());
  await h.supervisor.dispose();
  assert.equal(h.calls.stop, 0);
  const noTrust = harness({ resolver: async () => ({ serverOptions: { autoStart: false } }) });
  await assert.rejects(noTrust.supervisor.ensure(selection, op()), { code: 'CAPABILITY_UNAVAILABLE' });
  assert.equal(noTrust.calls.start, 0);
  await noTrust.supervisor.dispose();
});

test('never closePolicy detaches local watchers without stopping the ready child', async () => {
  const h = harness({ resolver: async (selection) => ({ runtime: identityToResolvedRuntime(selection), serverOptions: { autoStart: true }, closePolicy: 'never' }) });
  await h.supervisor.ensure(identity(), op());
  await h.supervisor.dispose();
  await h.supervisor.dispose();
  assert.equal(h.calls.stop, 0);
  assert.equal(h.calls.detach, 1);
  await assert.rejects(h.supervisor.ensure(identity(), op()), { code: 'CANCELLED' });
});

test('idle target supervisor never stops a legacy child on the shared manager', async () => {
  const h = harness();
  await h.manager.ensureServer({ autoStart: true });
  await assert.rejects(h.supervisor.ensure(identity(), op()), { code: 'CONFLICT' });
  assert.equal(h.calls.stop, 0);
  await h.supervisor.dispose();
  assert.equal(h.calls.stop, 0);
  assert.equal(h.manager.hasOwnedChild(), true);
});

test('dispose reads the latest close policy without requiring a restart', async () => {
  let policy = 'never';
  const h = harness({ getClosePolicy: () => policy });
  await h.supervisor.ensure(identity(), op());
  policy = 'onVscodeExit';
  await h.supervisor.dispose();
  assert.equal(h.calls.stop, 1);
  const next = harness({ getClosePolicy: () => 'never' });
  await next.supervisor.ensure(identity(), op());
  await next.supervisor.dispose();
  assert.equal(next.calls.stop, 0);
  assert.equal(next.calls.detach, 1);
});
