'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { INTEGRATION_FILES, installDshIntegration } = require('../src/dshIntegration');

function createSourceTree(root) {
  const extension = path.join(root, 'extension');
  const source = path.join(extension, 'runtime-integration', 'dsh-vscode-integration');
  for (const relative of INTEGRATION_FILES) {
    const file = path.join(source, ...relative.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, relative);
  }
  return { extension, source };
}

test('DSH integration installs its fixed package files inside the selected home', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vscode-integration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { extension } = createSourceTree(root);
  const installed = installDshIntegration(path.join(root, 'home'), extension);
  for (const relative of INTEGRATION_FILES) {
    assert.strictEqual(fs.readFileSync(path.join(installed.packageRoot, ...relative.split('/')), 'utf8'), relative);
  }
  assert.strictEqual(installed.nodeModulesPath, path.join(root, 'home', 'profiles', 'web', 'node_modules'));
});

test('DSH integration installs into the selected custom profile', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vscode-integration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { extension } = createSourceTree(root);
  const installed = installDshIntegration(path.join(root, 'home'), extension, { profileName: 'dev' });
  for (const relative of INTEGRATION_FILES) {
    assert.strictEqual(fs.readFileSync(path.join(installed.packageRoot, ...relative.split('/')), 'utf8'), relative);
  }
  assert.strictEqual(installed.nodeModulesPath, path.join(root, 'home', 'profiles', 'dev', 'node_modules'));
});

test('DSH integration removes retired files when the asset list changes within a version', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vscode-integration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { extension } = createSourceTree(root);
  const dshHome = path.join(root, 'home');
  const version = '1.1.3';
  fs.writeFileSync(path.join(extension, 'package.json'), JSON.stringify({ version }));
  const { packageRoot } = installDshIntegration(dshHome, extension);
  const retired = 'lib/retired.js';
  fs.writeFileSync(path.join(packageRoot, retired), '');
  fs.writeFileSync(path.join(packageRoot, '.vscode-sync.json'), JSON.stringify({
    syncedBy: version, files: [...INTEGRATION_FILES, retired],
  }));

  const synced = installDshIntegration(dshHome, extension);
  assert.deepEqual(synced.foreignRemoved, [retired]);
  assert.equal(synced.versionChanged, false);
  assert.equal(fs.existsSync(path.join(packageRoot, retired)), false);
});

test('DSH integration rejects invalid profile names with CONFIG_PROFILE_INVALID', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vscode-integration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { extension } = createSourceTree(root);
  for (const bad of ['', 'x'.repeat(65), 'bad/name', 'bad\\name', 'bad name', '中文']) {
    assert.throws(
      () => installDshIntegration(path.join(root, 'home'), extension, { profileName: bad }),
      (error) => error && error.code === 'CONFIG_PROFILE_INVALID' && /profile name must match/.test(error.message)
    );
  }
});
