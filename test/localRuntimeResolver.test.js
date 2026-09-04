'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { resolveLocalDshRuntime } = require('../src/localRuntimeResolver');

function fixture(t, packageName = '@deepseek-ai/dsh') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-local-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'package');
  const entrypoint = path.join(packageRoot, 'lib', 'bin.js');
  const nodePath = path.join(root, process.platform === 'win32' ? 'node.exe' : 'node');
  fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: packageName,
    version: '0.1.0-rc.6',
    bin: { dsh: 'lib/bin.js' },
  }));
  fs.writeFileSync(entrypoint, '#!/usr/bin/env node\n');
  fs.writeFileSync(nodePath, 'node fixture');
  return { root, packageRoot, entrypoint, nodePath };
}

test('local resolver verifies the official package and creates a persistent .dsh home', async (t) => {
  const value = fixture(t);
  const dshHome = path.join(value.root, 'global-storage', '.dsh');
  const runtime = await resolveLocalDshRuntime({
    dshHome,
    packageRoot: value.packageRoot,
    nodePath: value.nodePath,
  });

  assert.strictEqual(runtime.executablePath, fs.realpathSync(value.nodePath));
  assert.deepStrictEqual(runtime.entrypointArgs, [fs.realpathSync(value.entrypoint)]);
  assert.strictEqual(runtime.dshHome, path.resolve(dshHome));
  assert.strictEqual(runtime.profileHome, path.join(path.resolve(dshHome), 'profiles', 'vscode'));
  assert.strictEqual(runtime.profileName, 'vscode');
  assert.strictEqual(runtime.source, 'local-official-package');
  assert.strictEqual(runtime.dshVersion, '0.1.0-rc.6');
  assert.strictEqual(fs.statSync(dshHome).isDirectory(), true);
});

test('local resolver names a configured root that lacks the official package', async (t) => {
  const value = fixture(t, 'lookalike-dsh');
  const dshHome = path.join(value.root, '.dsh');
  await assert.rejects(
    resolveLocalDshRuntime({
      dshHome,
      packageRoot: value.packageRoot,
      nodePath: value.nodePath,
    }),
    /dsh\.local\.packageRoot does not contain the official @deepseek-ai\/dsh package/
  );
  assert.strictEqual(fs.statSync(dshHome).isDirectory(), true, '.dsh is created before install');
});

test('local resolver rejects relative user overrides', async () => {
  await assert.rejects(
    resolveLocalDshRuntime({ dshHome: path.resolve('.dsh'), packageRoot: 'relative' }),
    /packageRoot must be absolute/
  );
});

function writeOfficialPackage(dir) {
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh',
    version: '0.1.0-rc.6',
    bin: { dsh: 'lib/bin.js' },
  }));
  fs.writeFileSync(path.join(dir, 'lib', 'bin.js'), '#!/usr/bin/env node\n');
}

test('local resolver discovers an nvm-managed package and pairs its node binary', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-nvm-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const current = path.join(home, 'versions', 'node', 'v24.18.1');
  writeOfficialPackage(path.join(current, 'lib', 'node_modules', '@deepseek-ai', 'dsh'));
  fs.mkdirSync(path.join(current, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(current, 'bin', 'node'), 'node fixture');
  fs.mkdirSync(path.join(home, 'versions', 'node', 'v18.20.4'), { recursive: true });

  const runtime = await resolveLocalDshRuntime({
    dshHome: path.join(home, 'storage', '.dsh'),
    env: { HOME: home, NVM_DIR: home, PATH: '/usr/bin:/bin' },
    platform: 'darwin',
  });

  assert.strictEqual(runtime.dshVersion, '0.1.0-rc.6');
  assert.deepStrictEqual(
    runtime.entrypointArgs,
    [fs.realpathSync(path.join(current, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))]
  );
  assert.strictEqual(runtime.executablePath, fs.realpathSync(path.join(current, 'bin', 'node')));
});

test('local resolver derives a package prefix from PATH and pairs its node binary', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-path-home-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prefix = path.join(root, 'prefix');
  writeOfficialPackage(path.join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh'));
  fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(prefix, 'bin', 'node'), 'node fixture');

  const runtime = await resolveLocalDshRuntime({
    dshHome: path.join(root, 'storage', '.dsh'),
    env: {
      HOME: path.join(root, 'no-managers-home'),
      PATH: [path.join(prefix, 'bin'), '/usr/bin', '/bin'].join(path.delimiter),
    },
    platform: 'darwin',
  });

  assert.deepStrictEqual(
    runtime.entrypointArgs,
    [fs.realpathSync(path.join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))]
  );
  assert.strictEqual(runtime.executablePath, fs.realpathSync(path.join(prefix, 'bin', 'node')));
});

test('A9: an unreadable candidate manifest is skipped in favor of the next candidate', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-corrupt-manifest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const badPrefix = path.join(root, 'bad');
  const goodPrefix = path.join(root, 'good');
  writeOfficialPackage(path.join(badPrefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh'));
  fs.writeFileSync(
    path.join(badPrefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    '{ this is not json'
  );
  writeOfficialPackage(path.join(goodPrefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh'));
  fs.mkdirSync(path.join(goodPrefix, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(goodPrefix, 'bin', 'node'), 'node fixture');

  const runtime = await resolveLocalDshRuntime({
    dshHome: path.join(root, 'storage', '.dsh'),
    env: {
      HOME: path.join(root, 'no-managers-home'),
      PATH: [path.join(badPrefix, 'bin'), path.join(goodPrefix, 'bin')].join(path.delimiter),
    },
    platform: 'darwin',
  });

  assert.strictEqual(runtime.dshVersion, '0.1.0-rc.6', 'the corrupt first candidate is skipped, not fatal');
});

test('local resolver names a dead configured nodePath', async (t) => {
  const value = fixture(t);
  const dshHome = path.join(value.root, '.dsh');
  const deadNode = path.join(value.root, process.platform === 'win32' ? 'missing-node.exe' : 'missing-node');
  await assert.rejects(
    resolveLocalDshRuntime({ dshHome, packageRoot: value.packageRoot, nodePath: deadNode }),
    /dsh\.local\.nodePath is not a usable Node\.js executable/
  );
});

test('local resolver without a configured root explains the npm install command', { skip: process.platform !== 'win32' }, async (t) => {
  // On win32 the only automatic candidate derives from APPDATA; pointing it
  // at an empty directory makes the no-install branch deterministic without
  // touching a real npm prefix.
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-no-install-'));
  t.after(() => fs.rmSync(emptyRoot, { recursive: true, force: true }));
  const dshHome = path.join(emptyRoot, '.dsh');
  await assert.rejects(
    resolveLocalDshRuntime({ dshHome, env: { APPDATA: emptyRoot } }),
    /npm install -g @deepseek-ai\/dsh/
  );
});

function writeNodeExecutable(dir, executable) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, executable), 'node fixture');
}

test('local resolver discovers a Volta-managed package on win32', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-volta-win-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const localAppData = path.join(root, 'LocalAppData');
  const versionRoot = path.join(localAppData, '.volta', 'tools', 'image', 'node', 'v20.11.1');
  writeOfficialPackage(path.join(versionRoot, 'lib', 'node_modules', '@deepseek-ai', 'dsh'));
  writeNodeExecutable(path.join(versionRoot, 'bin'), 'node.exe');

  const runtime = await resolveLocalDshRuntime({
    dshHome: path.join(root, 'storage', '.dsh'),
    env: { LOCALAPPDATA: localAppData, APPDATA: path.join(root, 'AppData') },
    platform: 'win32',
  });

  assert.strictEqual(runtime.dshVersion, '0.1.0-rc.6');
  assert.strictEqual(runtime.executablePath, fs.realpathSync(path.join(versionRoot, 'bin', 'node.exe')));
});

test('local resolver discovers an fnm-windows-managed package on win32', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fnm-win-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appData = path.join(root, 'AppData');
  const versionRoot = path.join(appData, 'fnm', 'node-versions', 'v20.11.1');
  const installationRoot = path.join(versionRoot, 'installation');
  writeOfficialPackage(path.join(installationRoot, 'lib', 'node_modules', '@deepseek-ai', 'dsh'));
  writeNodeExecutable(installationRoot, 'node.exe');

  const runtime = await resolveLocalDshRuntime({
    dshHome: path.join(root, 'storage', '.dsh'),
    env: {
      LOCALAPPDATA: path.join(root, 'LocalAppData'),
      APPDATA: appData,
    },
    platform: 'win32',
  });

  assert.strictEqual(runtime.dshVersion, '0.1.0-rc.6');
  assert.strictEqual(runtime.executablePath, fs.realpathSync(path.join(installationRoot, 'node.exe')));
});

test('local resolver discovers an nvm-windows-managed package on win32', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-nvm-win-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appData = path.join(root, 'AppData');
  const nvmRoot = path.join(appData, 'nvm');
  const versionRoot = path.join(nvmRoot, 'v20.11.1');
  writeOfficialPackage(path.join(versionRoot, 'lib', 'node_modules', '@deepseek-ai', 'dsh'));
  writeNodeExecutable(versionRoot, 'node.exe');

  const runtime = await resolveLocalDshRuntime({
    dshHome: path.join(root, 'storage', '.dsh'),
    env: {
      LOCALAPPDATA: path.join(root, 'LocalAppData'),
      APPDATA: appData,
      NVM_HOME: nvmRoot,
      NVM_SYMLINK: versionRoot,
    },
    platform: 'win32',
  });

  assert.strictEqual(runtime.dshVersion, '0.1.0-rc.6');
  assert.strictEqual(runtime.executablePath, fs.realpathSync(path.join(versionRoot, 'node.exe')));
});

test('local resolver uses NVM_SYMLINK direct node_modules layout on win32', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-nvm-symlink-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appData = path.join(root, 'AppData');
  const nvmRoot = path.join(appData, 'nvm');
  const versionRoot = path.join(nvmRoot, 'v20.11.1');
  writeOfficialPackage(path.join(versionRoot, 'node_modules', '@deepseek-ai', 'dsh'));
  writeNodeExecutable(versionRoot, 'node.exe');

  const runtime = await resolveLocalDshRuntime({
    dshHome: path.join(root, 'storage', '.dsh'),
    env: {
      LOCALAPPDATA: path.join(root, 'LocalAppData'),
      APPDATA: appData,
      NVM_HOME: nvmRoot,
      NVM_SYMLINK: versionRoot,
    },
    platform: 'win32',
  });

  assert.strictEqual(runtime.dshVersion, '0.1.0-rc.6');
  assert.strictEqual(runtime.executablePath, fs.realpathSync(path.join(versionRoot, 'node.exe')));
});

test('local resolver rejects POSIX-style configured packageRoot on win32', async () => {
  await assert.rejects(
    resolveLocalDshRuntime({
      dshHome: path.resolve('.dsh'),
      packageRoot: '/Users/example/.nvm/versions/node/v20.11.1/lib/node_modules/@deepseek-ai/dsh',
      platform: 'win32',
    }),
    (err) => err.code === 'CONFIG_PACKAGE_ROOT_INVALID' && /packageRoot must be absolute/.test(err.message)
  );
});

test('local resolver rejects drive-relative configured nodePath on win32', async () => {
  await assert.rejects(
    resolveLocalDshRuntime({
      dshHome: path.resolve('.dsh'),
      nodePath: 'C:node.exe',
      platform: 'win32',
    }),
    (err) => err.code === 'CONFIG_NODE_PATH_INVALID' && /nodePath must be absolute/.test(err.message)
  );
});