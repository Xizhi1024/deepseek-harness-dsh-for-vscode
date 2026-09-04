'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ensureResolvableBundles,
  findUnresolvableBundles,
  resolveDshPackageRoot,
} = require('../../src/profileBundleGuard');

function makeLayout(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bundle-guard-'));
  const profileHome = path.join(root, 'profiles', 'web');
  fs.mkdirSync(profileHome, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, profileHome };
}

function writeManifest(profileHome, dependencies, bundles) {
  fs.writeFileSync(
    path.join(profileHome, 'package.json'),
    JSON.stringify({ name: 'dsh-profile-web', dependencies, dsh: { profile: { bundles } } }, null, 2) + '\n'
  );
}

function installFake(profileHome, name) {
  const dir = path.join(profileHome, 'node_modules', ...name.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }));
}

test('findUnresolvableBundles flags entries installed nowhere', (t) => {
  const { profileHome } = makeLayout(t);
  installFake(profileHome, '@dsh-external/dsh-mermaid');
  writeManifest(profileHome, {}, [
    '@deepseek-ai/dsh-base',
    '@dsh-external/dsh-mermaid',
    'dsh-mermaid',
  ]);
  const found = findUnresolvableBundles({ profileHome });
  assert.deepEqual(found.orphans, ['dsh-mermaid']);
});

test('findUnresolvableBundles accepts in-box packages via dshPackageRoot', (t) => {
  const { root, profileHome } = makeLayout(t);
  const dshRoot = path.join(root, 'install', 'node_modules', '@deepseek-ai', 'dsh');
  const inBox = path.join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-base');
  fs.mkdirSync(inBox, { recursive: true });
  fs.writeFileSync(path.join(inBox, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-base' }));
  writeManifest(profileHome, {}, ['@deepseek-ai/dsh-base']);
  const found = findUnresolvableBundles({ profileHome, dshPackageRoot: dshRoot });
  assert.deepEqual(found.orphans, []);
});

test('findUnresolvableBundles returns null without a bundle list', (t) => {
  const { profileHome } = makeLayout(t);
  fs.writeFileSync(path.join(profileHome, 'package.json'), JSON.stringify({ dependencies: {} }));
  assert.strictEqual(findUnresolvableBundles({ profileHome }), null);
});

test('findUnresolvableBundles returns null on corrupt manifest JSON', (t) => {
  const { profileHome } = makeLayout(t);
  fs.writeFileSync(path.join(profileHome, 'package.json'), '{ not json');
  assert.strictEqual(findUnresolvableBundles({ profileHome }), null);
});

test('ensureResolvableBundles strips orphans, keeps everything else, backs up once', (t) => {
  const { root, profileHome } = makeLayout(t);
  installFake(profileHome, '@dsh-external/dsh-mermaid');
  writeManifest(profileHome, { '@dsh-external/dsh-mermaid': 'github:x' }, [
    '@deepseek-ai/dsh-base',
    '@dsh-external/dsh-mermaid',
    'dsh-mermaid',
  ]);
  const result = ensureResolvableBundles({ dshHome: root, profileName: 'web' });
  assert.strictEqual(result.applied, true);
  assert.deepEqual(result.removed, ['dsh-mermaid']);
  const backup = JSON.parse(fs.readFileSync(result.backupPath, 'utf8'));
  assert.ok(backup.dsh.profile.bundles.includes('dsh-mermaid'), 'backup keeps the orphan');
  const after = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
  assert.deepEqual(after.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@dsh-external/dsh-mermaid']);
  assert.deepEqual(after.dependencies, { '@dsh-external/dsh-mermaid': 'github:x' });

  // Second run is a no-op and must not overwrite the backup.
  const again = ensureResolvableBundles({ dshHome: root, profileName: 'web' });
  assert.strictEqual(again.applied, false);
  assert.strictEqual(again.reason, 'clean');
});

test('ensureResolvableBundles is a no-op when the manifest is missing', (t) => {
  const { root } = makeLayout(t);
  const result = ensureResolvableBundles({ dshHome: root, profileName: 'web' });
  assert.strictEqual(result.applied, false);
  assert.strictEqual(result.reason, 'no-bundles');
});

test('resolveDshPackageRoot walks up to the @deepseek-ai/dsh manifest', (t) => {
  const { root } = makeLayout(t);
  const dshRoot = path.join(root, 'install', 'node_modules', '@deepseek-ai', 'dsh');
  fs.mkdirSync(path.join(dshRoot, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dshRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }));
  assert.strictEqual(resolveDshPackageRoot(path.join(dshRoot, 'lib', 'bin.js')), dshRoot);
  assert.strictEqual(resolveDshPackageRoot(path.join(root, 'nowhere', 'bin.js')), null);
});

test('non-string bundle entries are reported as unresolvable', (t) => {
  const { profileHome } = makeLayout(t);
  writeManifest(profileHome, {}, ['fine-pkg', 42, null]);
  installFake(profileHome, 'fine-pkg');
  const found = findUnresolvableBundles({ profileHome });
  assert.deepEqual(found.orphans, [42, null]);
});
