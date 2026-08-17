'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { hasDisabledPatchEntry, profileProbe } = require('../../src/detection/profileProbe');

function makeProfileDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-profile-probe-'));
  const web = path.join(dir, 'profiles', 'web');
  fs.mkdirSync(web, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { root: dir, web };
}

function writePackageJson(web, dependencies) {
  fs.writeFileSync(path.join(web, 'package.json'), JSON.stringify({ dependencies }));
}

function writePatch(web, text) {
  fs.writeFileSync(path.join(web, 'cordis.patch.yml'), text);
}

test('profileProbe reports unknown when dependency is declared without a disabled patch', (t) => {
  const { root, web } = makeProfileDir(t);
  writePackageJson(web, { 'dsh-mcp-manager': '0.1.0' });
  writePatch(web, '- id: other-plugin\n  disabled: false\n');
  const result = profileProbe({ dshHome: root, packageId: 'dsh-mcp-manager' });
  assert.strictEqual(result.source, 'profile');
  assert.strictEqual(result.state, 'unknown');
  assert.match(result.detail, /declared in dependencies/);
  assert.ok(Object.isFrozen(result));
});

test('profileProbe reports installed-disabled when patch marks the package disabled', (t) => {
  const { root, web } = makeProfileDir(t);
  writePackageJson(web, { 'dsh-plugin-marketplace': '0.1.0' });
  writePatch(web, '- id: dsh-plugin-marketplace\n  disabled: true\n');
  const result = profileProbe({ dshHome: root, packageId: 'dsh-plugin-marketplace' });
  assert.strictEqual(result.state, 'installed-disabled');
  assert.match(result.detail, /disabled in cordis\.patch\.yml/);
});

test('profileProbe reports absent when both files exist with no declaration', (t) => {
  const { root, web } = makeProfileDir(t);
  writePackageJson(web, { 'other-package': '0.1.0' });
  writePatch(web, '- id: other-plugin\n  disabled: false\n');
  const result = profileProbe({ dshHome: root, packageId: 'dsh-at-file' });
  assert.strictEqual(result.state, 'absent');
});

test('profileProbe reports unknown when the profile directory is missing', () => {
  const missing = path.join(os.tmpdir(), `dsh-missing-${Date.now()}-${Math.random()}`);
  const result = profileProbe({ dshHome: missing, packageId: 'dsh-at-file' });
  assert.strictEqual(result.state, 'unknown');
  assert.match(result.detail, /profile probe error/);
});

test('profileProbe reports unknown when patch file is missing', (t) => {
  const { root, web } = makeProfileDir(t);
  writePackageJson(web, { 'dsh-at-file': '0.1.0' });
  const result = profileProbe({ dshHome: root, packageId: 'dsh-at-file' });
  assert.strictEqual(result.state, 'unknown');
  assert.match(result.detail, /profile probe error/);
});

test('profileProbe reports unknown for malformed package.json', (t) => {
  const { root, web } = makeProfileDir(t);
  fs.writeFileSync(path.join(web, 'package.json'), '{ not json');
  writePatch(web, '- id: dsh-at-file\n  disabled: false\n');
  const result = profileProbe({ dshHome: root, packageId: 'dsh-at-file' });
  assert.strictEqual(result.state, 'unknown');
});

test('hasDisabledPatchEntry parses entry-level id and disabled flag', () => {
  const patch = [
    '- id: dsh-mcp-manager',
    '  disabled: false',
    '- id: dsh-plugin-marketplace',
    '  disabled: true',
    '',
  ].join('\n');
  assert.strictEqual(hasDisabledPatchEntry(patch, 'dsh-mcp-manager'), false);
  assert.strictEqual(hasDisabledPatchEntry(patch, 'dsh-plugin-marketplace'), true);
  assert.strictEqual(hasDisabledPatchEntry(patch, 'missing'), false);
});
