'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createPluginDetector } = require('../../src/detection/pluginDetector');
const { probeResult } = require('../../src/detection/probeTypes');
const { buildPluginSummary } = require('../../src/diagnose/pluginSummary');

function makeCatalog(entries) {
  return {
    revision: 'summary-rev',
    categories: [],
    entries,
  };
}

test('buildPluginSummary counts active, disabled, absent, and unknown states', () => {
  const detector = createPluginDetector({
    catalog: makeCatalog([
      { id: 'active', packageIds: ['a'] },
      { id: 'disabled', packageIds: ['b'] },
      { id: 'absent', packageIds: ['c'] },
      { id: 'unknown', packageIds: [] },
    ]),
    probes: [
      ({ packageId }) => {
        if (packageId === 'a') return probeResult('inventory', 'active', 'active');
        if (packageId === 'b') return probeResult('profile', 'installed-disabled', 'disabled');
        return probeResult('profile', 'absent', 'absent');
      },
    ],
    home: 'C:\\dsh',
  });

  const summary = buildPluginSummary({ detector, home: 'C:\\dsh' });
  assert.strictEqual(summary.revision, 'summary-rev');
  assert.strictEqual(summary.scanned, 4);
  assert.deepStrictEqual(summary.states, { active: 1, disabled: 1, absent: 1, unknown: 1 });
});

test('buildPluginSummary uses the provided home override', () => {
  const seen = [];
  const detector = createPluginDetector({
    catalog: makeCatalog([{ id: 'at-file', packageIds: ['dsh-at-file'] }]),
    probes: [
      ({ dshHome }) => {
        seen.push(dshHome);
        return probeResult('profile', 'absent', 'absent');
      },
    ],
    home: 'C:\\detector-home',
  });

  const summary = buildPluginSummary({ detector, home: 'D:\\override-home' });
  assert.strictEqual(summary.scanned, 1);
  assert.deepStrictEqual(summary.states, { active: 0, disabled: 0, absent: 1, unknown: 0 });
  assert.deepStrictEqual(seen, ['D:\\override-home']);
});
