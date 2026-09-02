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

test('INTEGRATION_FILES covers every runtime plugin lib file (missing-file crash guard)', () => {
  // Three production incidents (fimRoutes 1.0.2, linkRoutes gate session,
  // editObserver C2) all shared one shape: index.js gained a static import of
  // a new lib file that was never added to the sync manifest, so the synced
  // plugin crashed the DSH server at startup with exit 1. This test fails the
  // build the moment a new lib/*.js exists without its manifest entry.
  const pluginRoot = path.resolve(__dirname, '..', 'runtime-integration', 'dsh-vscode-integration');
  const onDisk = fs.readdirSync(path.join(pluginRoot, 'lib'), { recursive: false })
    .filter((name) => name.endsWith('.js'))
    .map((name) => 'lib/' + name)
    .sort();
  const listed = [...INTEGRATION_FILES].filter((relative) => relative.startsWith('lib/')).sort();
  assert.deepStrictEqual(listed, onDisk,
    'every runtime-integration/dsh-vscode-integration/lib/*.js must appear in INTEGRATION_FILES');
});

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
