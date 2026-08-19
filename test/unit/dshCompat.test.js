'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { deriveFeatureFlags } = require('../../src/dshCompat');

test('deriveFeatureFlags reports unknown for missing or unparseable versions', () => {
  for (const bad of [null, undefined, '', 'garbage', '1.2', '1.2.x', 'v1.2.3']) {
    assert.deepStrictEqual(deriveFeatureFlags(bad), {
      known: false, patchOverlay: false, themeParam: false, toolsV3: false,
    }, 'expected unknown flags for ' + JSON.stringify(bad));
  }
});

test('deriveFeatureFlags flags versions at or above each capability floor', () => {
  assert.deepStrictEqual(deriveFeatureFlags('0.0.9'), {
    known: true, patchOverlay: false, themeParam: false, toolsV3: false,
  });
  assert.deepStrictEqual(deriveFeatureFlags('0.1.0'), {
    known: true, patchOverlay: true, themeParam: true, toolsV3: true,
  });
});

test('deriveFeatureFlags ignores pre-release and build suffixes', () => {
  assert.deepStrictEqual(deriveFeatureFlags('0.1.0-rc.7'), deriveFeatureFlags('0.1.0'));
  assert.deepStrictEqual(deriveFeatureFlags('1.2.3+build.9'), deriveFeatureFlags('1.2.3'));
});

test('deriveFeatureFlags compares numerically, not lexically', () => {
  assert.strictEqual(deriveFeatureFlags('0.10.0').toolsV3, true);
  assert.strictEqual(deriveFeatureFlags('9.9.9').toolsV3, true);
});
