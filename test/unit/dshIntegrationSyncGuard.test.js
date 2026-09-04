'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  installDshIntegration,
  INTEGRATION_FILES,
  INTEGRATION_PACKAGE_NAME,
  SYNC_MARKER_NAME,
} = require('../../src/dshIntegration');

// Regression tests for the 2026-09-04 incident: several extension versions
// (installed 0.9.x/1.0.x + dev builds) share one DSH home, and each used to
// overwrite only its own file list inside the same package directory,
// leaving mixed-version bytes that crashed the runtime tool layer.

const DEV_FILES = [
  'package.json',
  'lib/index.js',
  'lib/client.js',
  'lib/tools.js',
  'lib/lmRoute.js',
  'lib/fimRoutes.js',
  'lib/linkRoutes.js',
  'lib/compatSessionRoutes.js',
  'lib/editObserver.js',
];
const OLD_FILES = DEV_FILES.slice(0, 5); // 0.9.x/1.0.x shipped exactly these

function makeExtensionRoot(version, files, payload) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ext-')));
  const packageRoot = path.join(root, 'runtime-integration', INTEGRATION_PACKAGE_NAME);
  for (const relative of files) {
    const full = path.join(packageRoot, ...relative.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, payload + ':' + relative, 'utf8');
  }
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }), 'utf8');
  return root;
}

function makeHome() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-')));
}

function profilePackage(home) {
  return path.join(home, 'profiles', 'web', 'node_modules', INTEGRATION_PACKAGE_NAME);
}

test('fresh install copies all files and writes the sync marker', () => {
  const home = makeHome();
  const ext = makeExtensionRoot('1.1.1', DEV_FILES, 'dev');
  const result = installDshIntegration(home, ext, { profileName: 'web' });
  assert.equal(result.copied, DEV_FILES.length);
  assert.equal(result.skipped, 0);
  assert.equal(result.versionChanged, false);
  assert.deepEqual(result.foreignRemoved, []);
  const marker = JSON.parse(fs.readFileSync(path.join(profilePackage(home), SYNC_MARKER_NAME), 'utf8'));
  assert.equal(marker.syncedBy, '1.1.1');
});

test('same-version re-sync skips byte-identical files', () => {
  const home = makeHome();
  const ext = makeExtensionRoot('1.1.1', DEV_FILES, 'dev');
  installDshIntegration(home, ext, { profileName: 'web' });
  const again = installDshIntegration(home, ext, { profileName: 'web' });
  assert.equal(again.copied, 0);
  assert.equal(again.skipped, DEV_FILES.length);
  assert.equal(again.versionChanged, false);
});

test('a different extension version owning the directory triggers a full re-own', () => {
  const home = makeHome();
  const dev = makeExtensionRoot('1.1.1', DEV_FILES, 'dev');
  installDshIntegration(home, dev, { profileName: 'web' });

  // Simulate what an installed 0.9.x/1.0.x activation left behind: its own
  // (old) bytes in the 5 files it knew, its marker version, the dev-only
  // extras untouched, plus one foreign file from another version's list.
  const pkg = profilePackage(home);
  for (const relative of OLD_FILES) {
    fs.writeFileSync(path.join(pkg, ...relative.split('/')), 'old:' + relative, 'utf8');
  }
  fs.writeFileSync(path.join(pkg, 'lib', 'watchdog.js'), 'foreign', 'utf8');
  fs.writeFileSync(path.join(pkg, SYNC_MARKER_NAME), JSON.stringify({ syncedBy: '0.9.3' }), 'utf8');

  // The current version takes ownership back: foreign file swept, every
  // mixed-version byte restored, marker re-stamped.
  const result = installDshIntegration(home, dev, { profileName: 'web' });
  assert.equal(result.versionChanged, true);
  assert.deepEqual([...result.foreignRemoved].sort(), ['lib/watchdog.js']);
  assert.equal(result.copied, OLD_FILES.length); // the 5 old-byte files
  assert.equal(result.skipped, DEV_FILES.length - OLD_FILES.length); // extras were still dev bytes
  const marker = JSON.parse(fs.readFileSync(path.join(pkg, SYNC_MARKER_NAME), 'utf8'));
  assert.equal(marker.syncedBy, '1.1.1');
  for (const relative of DEV_FILES) {
    const text = fs.readFileSync(path.join(pkg, ...relative.split('/')), 'utf8');
    assert.equal(text, 'dev:' + relative);
  }
  assert.equal(fs.existsSync(path.join(pkg, 'lib', 'watchdog.js')), false);
});

test('missing marker with existing package counts as a foreign owner', () => {
  const home = makeHome();
  const ext = makeExtensionRoot('1.1.1', DEV_FILES, 'dev');
  installDshIntegration(home, ext, { profileName: 'web' });
  fs.rmSync(path.join(profilePackage(home), SYNC_MARKER_NAME));
  const result = installDshIntegration(home, ext, { profileName: 'web' });
  assert.equal(result.versionChanged, true);
  assert.deepEqual(result.foreignRemoved, []);
  assert.equal(result.skipped, DEV_FILES.length); // bytes identical: copy skipped
});

test('unreadable extension version keeps the legacy incremental behavior', () => {
  const home = makeHome();
  const ext = makeExtensionRoot('1.1.1', DEV_FILES, 'dev');
  installDshIntegration(home, ext, { profileName: 'web' });
  fs.rmSync(path.join(ext, 'package.json')); // version can no longer be read
  const result = installDshIntegration(home, ext, { profileName: 'web' });
  assert.equal(result.versionChanged, false);
  assert.equal(result.skipped, DEV_FILES.length);
  assert.equal(fs.existsSync(path.join(profilePackage(home), SYNC_MARKER_NAME)), true); // earlier marker stays
});

test('INTEGRATION_FILES allow-list matches the shipped file set', () => {
  assert.deepEqual([...INTEGRATION_FILES], DEV_FILES);
});
