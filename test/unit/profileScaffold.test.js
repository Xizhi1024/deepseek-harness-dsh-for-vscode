'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ensureProfileScaffold,
  RUNTIME_TEMPLATE_PROFILES,
  SCAFFOLD_BUNDLES,
} = require('../../src/profileScaffold');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-profile-scaffold-'));
}

test('ensureProfileScaffold writes manifest, patch layer, and pnpm settings', () => {
  const home = tmpHome();
  const result = ensureProfileScaffold({ dshHome: home, profileName: 'vscode' });
  assert.deepStrictEqual(result, { profileName: 'vscode', created: ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml'], skipped: false });
  const manifest = JSON.parse(fs.readFileSync(path.join(home, 'profiles', 'vscode', 'package.json'), 'utf8'));
  assert.strictEqual(manifest.name, 'dsh-profile-vscode');
  assert.strictEqual(manifest.private, true);
  assert.deepStrictEqual(manifest.dsh.profile.bundles, [...SCAFFOLD_BUNDLES]);
  assert.strictEqual(manifest.dsh.profile.patchReload, 'live');
  const patch = fs.readFileSync(path.join(home, 'profiles', 'vscode', 'cordis.patch.yml'), 'utf8');
  assert.ok(patch.trimEnd().endsWith('[]'), 'patch template must be an empty YAML array');
  const workspace = fs.readFileSync(path.join(home, 'profiles', 'vscode', 'pnpm-workspace.yaml'), 'utf8');
  assert.match(workspace, /nodeLinker: hoisted/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('ensureProfileScaffold never touches an initialized profile', () => {
  const home = tmpHome();
  ensureProfileScaffold({ dshHome: home, profileName: 'custom' });
  const manifestPath = path.join(home, 'profiles', 'custom', 'package.json');
  const edited = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  edited.dependencies['some-plugin'] = '^1.0.0';
  fs.writeFileSync(manifestPath, JSON.stringify(edited, null, 2), 'utf8');
  const second = ensureProfileScaffold({ dshHome: home, profileName: 'custom' });
  assert.deepStrictEqual(second.created, []);
  assert.strictEqual(
    JSON.parse(fs.readFileSync(manifestPath, 'utf8')).dependencies['some-plugin'],
    '^1.0.0'
  );
  fs.rmSync(home, { recursive: true, force: true });
});

test('ensureProfileScaffold leaves runtime template profiles to the runtime', () => {
  const home = tmpHome();
  for (const name of RUNTIME_TEMPLATE_PROFILES) {
    const result = ensureProfileScaffold({ dshHome: home, profileName: name });
    assert.strictEqual(result.skipped, true, `${name} must be skipped`);
    assert.deepStrictEqual(result.created, []);
    assert.strictEqual(fs.existsSync(path.join(home, 'profiles', name)), false);
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test('ensureProfileScaffold rejects invalid names and relative homes', () => {
  const home = tmpHome();
  assert.throws(() => ensureProfileScaffold({ dshHome: home, profileName: 'not/valid' }), (err) => err.code === 'CONFIG_PROFILE_INVALID');
  assert.throws(() => ensureProfileScaffold({ dshHome: 'relative/path', profileName: 'vscode' }), /absolute dshHome/);
  fs.rmSync(home, { recursive: true, force: true });
});