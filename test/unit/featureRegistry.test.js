'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createFeatureRegistry } = require('../../src/featureRegistry');

const NONE = () => undefined;
const NOOP = () => {};

/** Build a minimal valid feature descriptor with a spy setup. */
function feature(id, layer, { defaultEnabled = true, setup } = {}) {
  return {
    id,
    label: id,
    layer,
    defaultEnabled,
    core: layer === 'L0',
    setup: setup || (async () => {}),
  };
}

test('setupAll executes L0 → L1 → L2, registration order inside each layer', async () => {
  const order = [];
  const registry = createFeatureRegistry({ getFeatureSetting: NONE, onFeatureFailure: NOOP });
  registry.register(feature('l2-z', 'L2', { setup: async () => { order.push('l2-z'); } }));
  registry.register(feature('l0-b', 'L0', { setup: async () => { order.push('l0-b'); } }));
  registry.register(feature('l0-a', 'L0', { setup: async () => { order.push('l0-a'); } }));
  registry.register(feature('l1-c', 'L1', { setup: async () => { order.push('l1-c'); } }));

  const results = await registry.setupAll({ context: {}, services: {} });

  assert.deepStrictEqual(order, ['l0-b', 'l0-a', 'l1-c', 'l2-z']);
  assert.deepStrictEqual(results, [
    { id: 'l0-b', status: 'ok' },
    { id: 'l0-a', status: 'ok' },
    { id: 'l1-c', status: 'ok' },
    { id: 'l2-z', status: 'ok' },
  ]);
});

test('a throwing feature does not block later features and failures record {id, error, at}', async () => {
  const order = [];
  const observerCalls = [];
  const registry = createFeatureRegistry({
    getFeatureSetting: NONE,
    onFeatureFailure: (record) => observerCalls.push(record),
  });
  registry.register(feature('ok-1', 'L1', { setup: async () => { order.push('ok-1'); } }));
  const boom = new Error('synthetic failure');
  registry.register(feature('boom', 'L1', { setup: async () => { order.push('boom'); throw boom; } }));
  registry.register(feature('ok-2', 'L1', { setup: async () => { order.push('ok-2'); } }));

  const results = await registry.setupAll({ context: {}, services: {} });

  assert.deepStrictEqual(order, ['ok-1', 'boom', 'ok-2'], 'a failure must never block later features');
  assert.deepStrictEqual(results.map((r) => r.status), ['ok', 'failed', 'ok']);
  assert.strictEqual(results[0].status, 'ok');
  assert.strictEqual(results[2].status, 'ok');
  assert.strictEqual(registry.failures.length, 1);
  const record = registry.failures[0];
  assert.strictEqual(record.id, 'boom');
  assert.ok(record.error.includes('synthetic failure'), 'record.error must carry the real message: ' + record.error);
  assert.strictEqual(record.error, boom.stack.split('\n')[0], 'record.error must be the first stack line (real error)');
  assert.ok(!Number.isNaN(Date.parse(record.at)), 'record.at must be an ISO timestamp: ' + record.at);
  assert.strictEqual(results[1].status, 'failed');
  assert.strictEqual(results[1].detail, record.error);
  assert.strictEqual(observerCalls.length, 1, 'onFeatureFailure must be called once per failure');
  assert.deepStrictEqual(observerCalls[0], record);
});

test('L1/L2 skip when getFeatureSetting(id) is false; undefined falls back to defaultEnabled', async () => {
  const calls = [];
  const settings = { 'on-default': undefined, 'off-me': false, 'off-default': undefined };
  const registry = createFeatureRegistry({ getFeatureSetting: (id) => settings[id], onFeatureFailure: NOOP });
  registry.register(feature('on-default', 'L1', { defaultEnabled: true, setup: async () => { calls.push('on-default'); } }));
  registry.register(feature('off-me', 'L1', { defaultEnabled: true, setup: async () => { calls.push('off-me'); } }));
  registry.register(feature('off-default', 'L1', { defaultEnabled: false, setup: async () => { calls.push('off-default'); } }));

  const results = await registry.setupAll({ context: {}, services: {} });

  assert.deepStrictEqual(calls, ['on-default'], 'disabled features must not run their setup');
  assert.deepStrictEqual(results, [
    { id: 'on-default', status: 'ok' },
    { id: 'off-me', status: 'disabled' },
    { id: 'off-default', status: 'disabled' },
  ]);
});

test('L0 features ignore dsh.features.* settings entirely (never switchable)', async () => {
  let consulted = 0;
  let ran = 0;
  const registry = createFeatureRegistry({
    getFeatureSetting: (id) => { consulted += 1; return false; },
    onFeatureFailure: NOOP,
  });
  registry.register(feature('l0-core', 'L0', { setup: async () => { ran += 1; } }));

  const results = await registry.setupAll({ context: {}, services: {} });

  assert.strictEqual(ran, 1, 'an L0 feature must run even when the setting would be false');
  assert.strictEqual(consulted, 0, 'getFeatureSetting must never be consulted for L0 features');
  assert.deepStrictEqual(results, [{ id: 'l0-core', status: 'ok' }]);
});

test('deps carry context + shared services; dispose runs teardowns in reverse setup order', async () => {
  const order = [];
  const seen = [];
  const services = {};
  const context = { name: 'extension-context' };
  const registry = createFeatureRegistry({ getFeatureSetting: NONE, onFeatureFailure: NOOP });
  registry.register(feature('l0-a', 'L0', {
    setup: async (deps) => {
      seen.push(deps);
      services.manager = { name: 'manager' };
      order.push('l0-a');
      return () => order.push('teardown-l0-a');
    },
  }));
  registry.register(feature('l1-b', 'L1', {
    setup: async (deps) => {
      seen.push(deps);
      assert.strictEqual(deps.services.manager.name, 'manager', 'L1 must consume the L0-published handle');
      order.push('l1-b');
      return () => order.push('teardown-l1-b');
    },
  }));
  registry.register(feature('l1-off', 'L1', {
    defaultEnabled: false,
    setup: async () => {
      order.push('l1-off');
      return () => order.push('teardown-l1-off');
    },
  }));

  const results = await registry.setupAll({ context, services });
  assert.deepStrictEqual(results.map((r) => r.status), ['ok', 'ok', 'disabled']);
  assert.strictEqual(seen[0].context, context, 'deps.context must be the provided extension context');
  assert.strictEqual(seen[0].services, services, 'deps.services must be the provided shared services object');
  assert.strictEqual(seen[1].services, services, 'the same services object must flow to every feature');

  await registry.dispose();
  assert.deepStrictEqual(
    order,
    ['l0-a', 'l1-b', 'teardown-l1-b', 'teardown-l0-a'],
    'teardowns must run in reverse setup order and never include a disabled feature'
  );
});

test('dispose skips failed features (no teardown) and still tears down the rest', async () => {
  const order = [];
  const registry = createFeatureRegistry({ getFeatureSetting: NONE, onFeatureFailure: NOOP });
  registry.register(feature('a', 'L0', { setup: async () => { order.push('a'); return () => order.push('td-a'); } }));
  registry.register(feature('b', 'L0', { setup: async () => { order.push('b'); throw new Error('boom-b'); } }));
  registry.register(feature('c', 'L0', { setup: async () => { order.push('c'); return () => order.push('td-c'); } }));

  await registry.setupAll({ context: {}, services: {} });
  await registry.dispose();

  assert.deepStrictEqual(order, ['a', 'b', 'c', 'td-c', 'td-a'], 'a failed feature must have no teardown');
  assert.strictEqual(registry.failures.length, 1);
  assert.strictEqual(registry.failures[0].id, 'b');
});

test('register rejects malformed or duplicate feature descriptors', () => {
  const registry = createFeatureRegistry({});
  assert.throws(() => registry.register(null), /feature must be an object/);
  assert.throws(() => registry.register({ id: '', layer: 'L0' }), /non-empty string/);
  assert.throws(() => registry.register({ id: 'x', layer: 'L9' }), /one of L0\/L1\/L2/);
  assert.throws(() => registry.register({ id: 'x', layer: 'L1', setup: 'nope' }), /setup must be a function/);
  const ok = feature('x', 'L1');
  registry.register(ok);
  assert.throws(() => registry.register(ok), /already registered/);
});

test('a setup returning a non-function is treated as an ok feature without a teardown', async () => {
  const registry = createFeatureRegistry({ getFeatureSetting: NONE, onFeatureFailure: NOOP });
  registry.register(feature('no-teardown', 'L1', { setup: async () => 42 }));
  const results = await registry.setupAll({ context: {}, services: {} });
  assert.deepStrictEqual(results, [{ id: 'no-teardown', status: 'ok' }]);
  await registry.dispose(); // must not throw
});
