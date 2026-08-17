'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  AdapterState,
  CapabilityAdapter,
  NullAdapter,
  nullAdapter,
} = require('../../src/adapters/contract');

test('AdapterState is frozen with the four contract states', () => {
  assert.deepStrictEqual(AdapterState, {
    DETACHED: 'detached',
    ATTACHING: 'attaching',
    ATTACHED: 'attached',
    DEGRADED: 'degraded',
  });
  assert.ok(Object.isFrozen(AdapterState));
});

test('CapabilityAdapter.attach is idempotent', () => {
  const adapter = new CapabilityAdapter();
  const firstSurface = { name: 'first' };
  const secondSurface = { name: 'second' };
  adapter.attach(firstSurface);
  assert.strictEqual(adapter._attached, true);
  adapter.attach(secondSurface);
  assert.strictEqual(adapter._attached, true);
  assert.strictEqual(adapter._surface, firstSurface);
});

test('CapabilityAdapter.detach is idempotent and clears surface', () => {
  const adapter = new CapabilityAdapter();
  adapter.attach({});
  adapter.detach();
  assert.strictEqual(adapter._attached, false);
  assert.strictEqual(adapter._surface, null);
  adapter.detach();
  assert.strictEqual(adapter._attached, false);
});

test('CapabilityAdapter.probe returns the default ok result', () => {
  const adapter = new CapabilityAdapter();
  assert.deepStrictEqual(adapter.probe({}), { ok: true });
});

test('NullAdapter methods are no-ops and probe returns default result', () => {
  const adapter = nullAdapter('mcp.consume');
  assert.ok(adapter instanceof NullAdapter);
  assert.strictEqual(adapter.capabilityId, 'mcp.consume');
  assert.strictEqual(adapter._attached, false);
  adapter.attach({});
  adapter.detach();
  assert.deepStrictEqual(adapter.probe({}), {});
  assert.strictEqual(adapter._attached, false);
});

test('subclass static capabilityId is available on the instance capabilityId', () => {
  class FakeAdapter extends CapabilityAdapter {
    static capabilityId = 'fake.capability';
  }
  const adapter = new FakeAdapter();
  assert.strictEqual(adapter.capabilityId, 'fake.capability');
});
