'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  buildManagedLaunchSpec,
  compareDshVersions,
  isNoOpenStderr,
  supportsNoOpenFlag,
} = require('../../src/managedRuntimeLaunch');

function runtime(overrides = {}) {
  return {
    executablePath: process.execPath,
    entrypointArgs: [path.resolve(__dirname, 'fixture-entry.js')],
    dshHome: path.resolve('/tmp/dsh-home'),
    profileHome: path.resolve('/tmp/dsh-home/profiles/web'),
    profileName: 'web',
    dshVersion: null,
    ...overrides,
  };
}

test('compareDshVersions orders cores, rc tags, and releases', () => {
  assert.strictEqual(compareDshVersions('0.1.0-rc.6', '0.1.0-rc.7') < 0, true);
  assert.strictEqual(compareDshVersions('0.1.0-rc.7', '0.1.0-rc.7'), 0);
  assert.strictEqual(compareDshVersions('0.1.0-rc.8', '0.1.0-rc.7') > 0, true);
  assert.strictEqual(compareDshVersions('0.1.0-rc.99', '0.1.0') < 0, true, 'rc sorts below its release');
  assert.strictEqual(compareDshVersions('0.1.1-rc.1', '0.1.0') > 0, true);
  assert.strictEqual(compareDshVersions('0.2.0', '0.1.9') > 0, true);
  assert.strictEqual(compareDshVersions('garbage', '0.1.0'), null);
  assert.strictEqual(compareDshVersions('', '0.1.0'), null);
});

test('supportsNoOpenFlag gates on 0.1.0-rc.7 and stays optimistic on unknown versions', () => {
  assert.strictEqual(supportsNoOpenFlag('0.1.0-rc.6'), false);
  assert.strictEqual(supportsNoOpenFlag('0.1.0-rc.5'), false);
  assert.strictEqual(supportsNoOpenFlag('0.1.0-rc.7'), true);
  assert.strictEqual(supportsNoOpenFlag('0.1.0-rc.8'), true);
  assert.strictEqual(supportsNoOpenFlag('0.1.0'), true);
  assert.strictEqual(supportsNoOpenFlag('0.1.1-rc.1'), true);
  assert.strictEqual(supportsNoOpenFlag(null), true, 'unknown versions keep the flag and rely on the self-heal');
  assert.strictEqual(supportsNoOpenFlag('not-a-version'), true);
});

test('isNoOpenStderr matches only the Commander unknown-option rejection', () => {
  assert.strictEqual(isNoOpenStderr("error: unknown option '--no-open'"), true);
  assert.strictEqual(isNoOpenStderr('error: unknown option \u001b[31m--no-open\u001b[39m\n'), true);
  assert.strictEqual(isNoOpenStderr('error: unknown option --profile'), false);
  assert.strictEqual(isNoOpenStderr('EADDRINUSE --no-open port in use'), false);
  assert.strictEqual(isNoOpenStderr(''), false);
  assert.strictEqual(isNoOpenStderr(null), false);
});

test('buildManagedLaunchSpec keeps --no-open by default and drops it on request', () => {
  const spec = buildManagedLaunchSpec(runtime({ dshVersion: '0.1.1-rc.1' }), '127.0.0.1', 3080, process.platform, {});
  assert.ok(spec.args.includes('--no-open'));
  assert.ok(spec.args.includes('--profile'));
  assert.ok(spec.args.includes('3080'));

  const suppressed = buildManagedLaunchSpec(
    runtime({ dshVersion: '0.1.0-rc.6' }),
    '127.0.0.1',
    3080,
    process.platform,
    { noOpen: false }
  );
  assert.strictEqual(suppressed.args.includes('--no-open'), false);
  assert.strictEqual(suppressed.args.includes('--profile'), true);
});
