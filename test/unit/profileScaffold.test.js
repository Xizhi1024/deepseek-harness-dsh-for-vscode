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
  assert.deepStrictEqual(result, { profileName: 'vscode', created: ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml'], skipped: false, inheritedFrom: null });
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

test('ensureProfileScaffold inherits the web donor profile config on fresh creation', () => {
  const home = tmpHome();
  const webDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(webDir, { recursive: true });
  fs.writeFileSync(path.join(webDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {
      'dsh-better-sidebar': '^0.14.0',
      'dsh-vscode-integration': 'link:D:/somewhere', // extension-managed: must be dropped
    },
    dsh: { profile: { bundles: [
      '@deepseek-ai/dsh-base',
      'dsh-better-sidebar',
      'dsh-vscode-integration', // extension-managed: must be dropped
      '@omdsh-dev/dsh-genui',
    ] } },
  }), 'utf8');
  fs.writeFileSync(path.join(webDir, 'cordis.patch.yml'), '- id: pet\n  disabled: true\n', 'utf8');
  const result = ensureProfileScaffold({ dshHome: home, profileName: 'vscode' });
  assert.strictEqual(result.inheritedFrom, 'web');
  const manifest = JSON.parse(fs.readFileSync(path.join(home, 'profiles', 'vscode', 'package.json'), 'utf8'));
  assert.deepStrictEqual(manifest.dependencies, { 'dsh-better-sidebar': '^0.14.0' });
  assert.deepStrictEqual(manifest.dsh.profile.bundles, [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    'dsh-better-sidebar',
    '@omdsh-dev/dsh-genui',
  ]);
  const patch = fs.readFileSync(path.join(home, 'profiles', 'vscode', 'cordis.patch.yml'), 'utf8');
  assert.strictEqual(patch, '- id: pet\n  disabled: true\n');
  fs.rmSync(home, { recursive: true, force: true });
});

test('ensureProfileScaffold never re-inherits an initialized profile', () => {
  const home = tmpHome();
  const webDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(webDir, { recursive: true });
  fs.writeFileSync(path.join(webDir, 'package.json'), JSON.stringify({
    dependencies: { 'dsh-mermaid': 'github:AKS1st/dsh-mermaid' },
    dsh: { profile: { bundles: ['dsh-mermaid'] } },
  }), 'utf8');
  ensureProfileScaffold({ dshHome: home, profileName: 'custom' });
  // Donor appears AFTER the custom profile was created: the existing
  // manifest must stay untouched (no re-inheritance).
  const manifestPath = path.join(home, 'profiles', 'custom', 'package.json');
  const before = fs.readFileSync(manifestPath, 'utf8');
  fs.writeFileSync(path.join(webDir, 'cordis.patch.yml'), '- id: late\n  disabled: true\n', 'utf8');
  const second = ensureProfileScaffold({ dshHome: home, profileName: 'custom' });
  assert.deepStrictEqual(second.created, []);
  assert.strictEqual(second.inheritedFrom, null);
  assert.strictEqual(fs.readFileSync(manifestPath, 'utf8'), before);
  assert.ok(!fs.existsSync(path.join(home, 'profiles', 'custom', 'cordis.patch.yml.bak')));
  fs.rmSync(home, { recursive: true, force: true });
});

test('ensureProfileScaffold tolerates a malformed donor manifest', () => {
  const home = tmpHome();
  const webDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(webDir, { recursive: true });
  fs.writeFileSync(path.join(webDir, 'package.json'), '{ not json', 'utf8');
  const result = ensureProfileScaffold({ dshHome: home, profileName: 'vscode' });
  assert.strictEqual(result.inheritedFrom, null);
  const manifest = JSON.parse(fs.readFileSync(path.join(home, 'profiles', 'vscode', 'package.json'), 'utf8'));
  assert.deepStrictEqual(manifest.dependencies, {});
  assert.deepStrictEqual(manifest.dsh.profile.bundles, [...SCAFFOLD_BUNDLES]);
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