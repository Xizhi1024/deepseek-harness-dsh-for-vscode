'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createPluginDetector } = require('../../src/detection/pluginDetector');
const { probeResult } = require('../../src/detection/probeTypes');

function makeCatalog(entries) {
  return {
    revision: 'test-revision',
    categories: [],
    entries,
  };
}

function inventoryProbe(state) {
  return ({ packageId }) => probeResult('inventory', state, `inventory:${packageId}`);
}

test('detectSync reports absent from an absent profile probe', () => {
  const detector = createPluginDetector({
    catalog: makeCatalog([{ id: 'at-file', packageIds: ['dsh-at-file'] }]),
    probes: [inventoryProbe('absent')],
    home: 'C:\\dsh',
  });
  const detected = detector.detectSync('at-file');
  assert.strictEqual(detected.state, 'absent');
  assert.strictEqual(detected.effective, false);
  assert.ok(Object.isFrozen(detected));
});

test('inventory active evidence produces active and effective', () => {
  const detector = createPluginDetector({
    catalog: makeCatalog([{ id: 'mcp-manager', packageIds: ['dsh-mcp-manager'] }]),
    probes: [inventoryProbe('active')],
    home: 'C:\\dsh',
  });
  const detected = detector.detectSync('mcp-manager');
  assert.strictEqual(detected.state, 'active');
  assert.strictEqual(detected.effective, true);
});

test('installed-disabled dominates absent evidence', () => {
  const detector = createPluginDetector({
    catalog: makeCatalog([{ id: 'plugin-marketplace', packageIds: ['dshmarket'] }]),
    probes: [
      ({ packageId }) => probeResult('profile', 'installed-disabled', `disabled:${packageId}`),
      ({ packageId }) => probeResult('profile', 'absent', `absent:${packageId}`),
    ],
    home: 'C:\\dsh',
  });
  const detected = detector.detectSync('plugin-marketplace');
  assert.strictEqual(detected.state, 'installed-disabled');
  assert.strictEqual(detected.effective, false);
});

test('unknown evidence never becomes effective', () => {
  const detector = createPluginDetector({
    catalog: makeCatalog([{ id: 'git', packageIds: [] }]),
    probes: [],
    home: 'C:\\dsh',
  });
  const detected = detector.detectSync('git');
  assert.strictEqual(detected.state, 'unknown');
  assert.strictEqual(detected.effective, false);
});

test('throwing probe produces failed state with error detail', () => {
  const detector = createPluginDetector({
    catalog: makeCatalog([{ id: 'test', packageIds: ['@deepseek-ai/dsh-agent-loop-testkit'] }]),
    probes: [
      () => {
        throw new Error('boom');
      },
    ],
    home: 'C:\\dsh',
  });
  const detected = detector.detectSync('test');
  assert.strictEqual(detected.state, 'failed');
  assert.strictEqual(detected.effective, false);
  assert.match(detected.evidence[0].detail, /boom/);
});

test('invalidate clears cache and records reason', () => {
  const probeState = { value: 'absent' };
  const detector = createPluginDetector({
    catalog: makeCatalog([{ id: 'at-file', packageIds: ['dsh-at-file'] }]),
    probes: [({ packageId }) => probeResult('inventory', probeState.value, `inventory:${packageId}`)],
    home: 'C:\\dsh',
    now: () => '2026-01-01T00:00:00.000Z',
  });
  assert.strictEqual(detector.detectSync('at-file').state, 'absent');
  probeState.value = 'active';
  // Cache still returns the old result.
  assert.strictEqual(detector.detectSync('at-file').state, 'absent');
  detector.invalidate('profile changed');
  assert.strictEqual(detector.detectSync('at-file').state, 'active');
});

test('concurrent detect calls share the same in-flight promise', async () => {
  const detector = createPluginDetector({
    catalog: makeCatalog([{ id: 'mcp-manager', packageIds: ['dsh-mcp-manager'] }]),
    probes: [inventoryProbe('active')],
    home: 'C:\\dsh',
  });
  const first = detector.detect('mcp-manager');
  const second = detector.detect('mcp-manager');
  assert.strictEqual(first, second);
  const detected = await first;
  assert.strictEqual(detected.state, 'active');
});

test('snapshot returns a deep-frozen full snapshot', () => {
  const detector = createPluginDetector({
    catalog: makeCatalog([
      { id: 'mcp-manager', packageIds: ['dsh-mcp-manager'] },
      { id: 'git', packageIds: [] },
    ]),
    probes: [inventoryProbe('absent')],
    home: 'C:\\dsh',
  });
  const snapshot = detector.snapshot();
  assert.strictEqual(snapshot.dshHome, 'C:\\dsh');
  assert.strictEqual(snapshot.revision, 'test-revision');
  assert.strictEqual(snapshot.entries.length, 2);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.entries));
  assert.ok(Object.isFrozen(snapshot.entries[0]));
});
