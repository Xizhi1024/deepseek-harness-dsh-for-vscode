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

const {
  deriveRuntimeIssues,
  deriveRuntimeAdapter,
  SUPPORTED_DSH_MIN,
  PROJECTION_CACHE_MIN,
  MODULE_HMR_OPTIN_MIN,
  SESSION_CONTROLLER_MIN,
} = require('../../src/dshCompat');

test('deriveRuntimeIssues reports unknown for missing or unparseable versions', () => {
  for (const bad of [null, undefined, '', 'garbage', '1.2', '0.1.x']) {
    assert.deepStrictEqual(deriveRuntimeIssues(bad), {
      known: false, supported: false, exportDoublePrefix: false,
      sparseProjectionTitles: false, moduleHmrWindowCrash: false,
    }, 'expected unknown runtime issues for ' + JSON.stringify(bad));
  }
});

test('deriveRuntimeIssues gates the three upstream defects by runtime version', () => {
  // Floor install 0.1.1-rc.2: sparse titles + HMR window crash exposure.
  assert.deepStrictEqual(deriveRuntimeIssues('0.1.1-rc.2'), {
    known: true, supported: true, exportDoublePrefix: true,
    sparseProjectionTitles: true, moduleHmrWindowCrash: true,
  });
  // 0.1.2-alpha.1+ carries the projection cache and module-HMR opt-in.
  assert.deepStrictEqual(deriveRuntimeIssues('0.1.2-alpha.1'), {
    known: true, supported: true, exportDoublePrefix: true,
    sparseProjectionTitles: false, moduleHmrWindowCrash: false,
  });
  assert.deepStrictEqual(deriveRuntimeIssues('0.1.2-alpha.5'), deriveRuntimeIssues('0.1.2-alpha.1'));
  // The double-prefix export naming is unfixed in every released runtime.
  assert.strictEqual(deriveRuntimeIssues('99.0.0').exportDoublePrefix, true);
});

test('deriveRuntimeIssues flags runtimes below the supported floor', () => {
  assert.strictEqual(deriveRuntimeIssues('0.1.0-rc.6').supported, false);
  assert.strictEqual(deriveRuntimeIssues('0.1.0-rc.7').supported, true);
  assert.strictEqual(SUPPORTED_DSH_MIN, '0.1.0-rc.7');
  assert.strictEqual(PROJECTION_CACHE_MIN, '0.1.2-alpha.1');
  assert.strictEqual(MODULE_HMR_OPTIN_MIN, '0.1.2-alpha.1');
});

test('deriveRuntimeAdapter selects the expected old/new host service line', () => {
  assert.deepStrictEqual(deriveRuntimeAdapter('0.1.1-rc.2'), {
    known: true,
    line: 'legacy-apiproxy',
    openPathService: 'apiProxy',
    sessionRoutes: 'native',
  });
  assert.deepStrictEqual(deriveRuntimeAdapter('0.1.2-alpha.5'), {
    known: true,
    line: 'legacy-apiproxy',
    openPathService: 'apiProxy',
    sessionRoutes: 'native',
  });
  assert.deepStrictEqual(deriveRuntimeAdapter('0.1.2-rc.1'), {
    known: true,
    line: 'session-controller',
    openPathService: 'sessionController',
    sessionRoutes: 'compat',
  });
  assert.deepStrictEqual(deriveRuntimeAdapter('0.1.2'), deriveRuntimeAdapter('0.1.2-rc.1'));
  assert.strictEqual(SESSION_CONTROLLER_MIN, '0.1.2-rc.1');
});

test('deriveRuntimeAdapter leaves unknown/fork version labels on capability negotiation', () => {
  for (const version of [null, '', 'master', 'v0.1.2']) {
    assert.deepStrictEqual(deriveRuntimeAdapter(version), {
      known: false,
      line: 'negotiate',
      openPathService: 'apiProxy|sessionController',
      sessionRoutes: 'negotiate',
    });
  }
});
