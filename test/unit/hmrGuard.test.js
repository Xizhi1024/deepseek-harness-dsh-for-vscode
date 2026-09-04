'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureHmrDisabled, HMR_ENTRY } = require('../../src/hmrGuard');

// Regression tests for the 2026-09-03/04 tool-channel outage: runtimes below
// 0.1.2-alpha.1 break every in-flight tool call during a module HMR reload.
function makeHome() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hmr-')));
}

function patchPath(home) {
  return path.join(home, 'profiles', 'web', 'cordis.patch.yml');
}

test('creates the patch file (with entry) when the profile has none', () => {
  const home = makeHome();
  const result = ensureHmrDisabled({ dshHome: home, profileName: 'web', dshVersion: '0.1.1-rc.2' });
  assert.equal(result.applied, true);
  assert.equal(result.created, true);
  assert.equal(result.dshVersion, '0.1.1-rc.2');
  const text = fs.readFileSync(patchPath(home), 'utf8');
  assert.match(text, /- id: hmr/);
  assert.match(text, /disabled: true/);
});

test('appends to an existing patch file, keeps content, writes one backup', () => {
  const home = makeHome();
  fs.mkdirSync(path.dirname(patchPath(home)), { recursive: true });
  fs.writeFileSync(patchPath(home), '# existing\n- id: pet\n  disabled: true\n', 'utf8');
  const before = fs.readFileSync(patchPath(home), 'utf8');
  const result = ensureHmrDisabled({ dshHome: home, profileName: 'web' });
  assert.equal(result.applied, true);
  assert.equal(result.created, false);
  const after = fs.readFileSync(patchPath(home), 'utf8');
  assert.ok(after.startsWith(before));
  assert.match(after, /- id: hmr[\s\S]*disabled: true/);
  assert.equal(fs.readFileSync(patchPath(home) + '.bak-dshext', 'utf8'), before);
});

test('replaces a scaffolded empty sequence instead of creating invalid YAML', () => {
  const home = makeHome();
  fs.mkdirSync(path.dirname(patchPath(home)), { recursive: true });
  const scaffold = [
    '# Your patch layer for this dsh profile.',
    '[]',
    '',
  ].join('\n');
  fs.writeFileSync(patchPath(home), scaffold, 'utf8');
  const result = ensureHmrDisabled({ dshHome: home, profileName: 'web' });
  assert.equal(result.applied, true);
  const after = fs.readFileSync(patchPath(home), 'utf8');
  assert.doesNotMatch(after, /^\s*\[\]\s*$/m);
  assert.match(after, /- id: hmr[\s\S]*disabled: true/);
  assert.equal(fs.readFileSync(patchPath(home) + '.bak-dshext', 'utf8'), scaffold);
});

test('never appends a duplicate hmr entry (duplicate loader ids crash dsh)', () => {
  const home = makeHome();
  fs.mkdirSync(path.dirname(patchPath(home)), { recursive: true });
  const existing = '- id: hmr\n  name: "@deepseek-ai/cordis-plugin-hmr"\n  disabled: true\n';
  fs.writeFileSync(patchPath(home), '# existing\n' + existing, 'utf8');
  const before = fs.readFileSync(patchPath(home), 'utf8');
  const result = ensureHmrDisabled({ dshHome: home, profileName: 'web' });
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'already-present');
  assert.equal(fs.readFileSync(patchPath(home), 'utf8'), before); // byte-identical
  assert.equal(fs.existsSync(patchPath(home) + '.bak-dshext'), false);
});

test('a name-only hmr reference also counts as already present', () => {
  const home = makeHome();
  fs.mkdirSync(path.dirname(patchPath(home)), { recursive: true });
  fs.writeFileSync(
    patchPath(home),
    '- id: custom-hmr\n  name: "@deepseek-ai/cordis-plugin-hmr"\n  disabled: true\n',
    'utf8'
  );
  const before = fs.readFileSync(patchPath(home), 'utf8');
  const result = ensureHmrDisabled({ dshHome: home, profileName: 'web' });
  assert.equal(result.applied, false);
  assert.equal(fs.readFileSync(patchPath(home), 'utf8'), before);
});

test('second run on a guarded file is a no-op (idempotent)', () => {
  const home = makeHome();
  ensureHmrDisabled({ dshHome: home, profileName: 'web' });
  const first = fs.readFileSync(patchPath(home), 'utf8');
  const result = ensureHmrDisabled({ dshHome: home, profileName: 'web' });
  assert.equal(result.applied, false);
  assert.equal(fs.readFileSync(patchPath(home), 'utf8'), first);
  assert.equal(first.split('- id: hmr').length - 1, 1); // exactly one entry
});

test('invalid arguments throw TypeError', () => {
  assert.throws(() => ensureHmrDisabled({}), TypeError);
  assert.throws(() => ensureHmrDisabled({ dshHome: 'C:/x' }), TypeError);
  assert.throws(() => ensureHmrDisabled({ profileName: 'web' }), TypeError);
});

test('HMR_ENTRY payload disables the vendored plugin by id and name', () => {
  assert.match(HMR_ENTRY, /- id: hmr/);
  assert.match(HMR_ENTRY, /name: "@deepseek-ai\/cordis-plugin-hmr"/);
  assert.match(HMR_ENTRY, /disabled: true/);
});
