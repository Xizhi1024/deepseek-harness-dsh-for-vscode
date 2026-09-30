'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { deriveFeatureFlags, deriveRuntimeIssues, deriveRuntimeAdapter, compareDshVersions } = require('../../src/dshCompat');

test('compatibility diagnostics never extrapolate adapters across releases or forks', () => {
  for (const value of [null, undefined, '', 'garbage', '0.1.0-rc.7', '0.1.2', '0.2.0-rc.2', '0.2.0', '99.0.0', 'v0.2.0-rc.1', '0.2.0-rc.1+fork']) {
    assert.equal(deriveFeatureFlags(value).known, false, String(value));
    assert.equal(deriveRuntimeIssues(value).supported, false, String(value));
    assert.equal(deriveRuntimeAdapter(value).known, false, String(value));
    assert.equal(deriveRuntimeAdapter(value).line, 'negotiate');
  }
});

test('exact supported lines choose distinct transport contracts', () => {
  assert.deepEqual(deriveRuntimeAdapter('0.1.2-rc.1'), {
    known: true, line: 'session-controller', openPathService: 'sessionController', sessionRoutes: 'compat',
  });
  assert.deepEqual(deriveRuntimeAdapter('0.2.0-rc.1'), {
    known: true, line: 'dsh-0.2.0-rc.1', openPathService: 'sessionController', sessionRoutes: 'vscode-facade-v1',
  });
  for (const value of ['0.1.2-rc.1', '0.2.0-rc.1']) {
    assert.deepEqual(deriveFeatureFlags(value), { known: true, patchOverlay: true, themeParam: true, toolsV3: true });
    assert.equal(deriveRuntimeIssues(value).supported, true);
  }
  assert.equal(deriveRuntimeIssues('0.2.0-rc.1').exportDoublePrefix, false);
});

test('launch floor comparison preserves semver prerelease ordering independently of adapter certification', () => {
  assert.ok(compareDshVersions('0.1.0-rc.6', '0.1.0-rc.7') < 0);
  assert.ok(compareDshVersions('0.2.0', '0.2.0-rc.1') > 0);
  assert.ok(compareDshVersions('0.2.0-alpha.1', '0.2.0-rc.1') < 0);
  assert.equal(compareDshVersions('unknown', '0.2.0-rc.1'), null);
});
