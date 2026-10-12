'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  nodeCandidates,
  packageCandidates,
  resolveLocalDshRuntime,
} = require('../src/localRuntimeResolver');

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
  assert.strictEqual(runtime.profileHome, path.join(path.resolve(dshHome), 'profiles', 'web'));
  assert.strictEqual(runtime.profileName, 'web');
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

// Regression: a pnpm-global install used to report "Official DSH is not
// installed". pnpm's store path is a content hash (no static guess can hit
// it) and its Windows shims reference `%~dp0\..` with NO closing `%`, which
// the original `%~dp0%` pattern rejected — so every discovery layer missed.
// The win32 layers join with path.win32, so these need a win32 host fs.
const PNPM_STORE_TAIL = ['global', '5', '.pnpm', '@deepseek-ai+dsh@0.1.7-rc.1_4a0342b4',
  'node_modules', '@deepseek-ai', 'dsh'];
for (const [label, shimName, shimContent] of [
  ['%~dp0 dsh.cmd shim', 'dsh.cmd', (rel) => 'node  "%~dp0' + rel + '" %*'],
  ['$basedir extensionless sh shim', 'dsh', (rel) => 'exec node  "$basedir/' + rel.replace(/\\/g, '/') + '" "$@"'],
]) {
  test('local resolver finds a pnpm-global install via its ' + label, { skip: process.platform !== 'win32' }, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pnpm-win-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const localAppData = path.join(root, 'LocalAppData');
    const binDir = path.join(localAppData, 'pnpm', 'bin');
    const storeDir = path.join(localAppData, 'pnpm', ...PNPM_STORE_TAIL);
    writeOfficialPackage(storeDir);
    const nodeDir = path.join(root, 'nodejs');
    writeNodeExecutable(nodeDir, 'node.exe');
    fs.mkdirSync(binDir, { recursive: true });
    const rel = ['..', ...PNPM_STORE_TAIL, 'lib', 'bin.js'].join('\\');
    fs.writeFileSync(path.join(binDir, shimName), shimContent(rel));

    const runtime = await resolveLocalDshRuntime({
      dshHome: path.join(root, 'storage', '.dsh'),
      env: { LOCALAPPDATA: localAppData, Path: [binDir, nodeDir].join(';') },
      platform: 'win32',
    });

    assert.strictEqual(runtime.source, 'local-official-package');
    assert.strictEqual(runtime.dshVersion, '0.1.0-rc.6');
    assert.deepStrictEqual(
      runtime.entrypointArgs,
      [fs.realpathSync(path.join(storeDir, 'lib', 'bin.js'))]
    );
    assert.strictEqual(runtime.executablePath, fs.realpathSync(path.join(nodeDir, 'node.exe')));
  });
}

test('local resolver finds a pnpm-global install with NO shim on PATH', { skip: process.platform !== 'win32' }, async (t) => {
  // pnpm 10+ keeps the package under global/<major>/<hash>/node_modules; the
  // shim may be absent from VS Code's PATH entirely, so the enumerated store
  // is the only layer that can find it.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pnpm-noshim-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const localAppData = path.join(root, 'LocalAppData');
  const storeDir = path.join(localAppData, 'pnpm', 'global', 'v11', 'c7c8447f',
    'node_modules', '@deepseek-ai', 'dsh');
  writeOfficialPackage(storeDir);
  const nodeDir = path.join(root, 'nodejs');
  writeNodeExecutable(nodeDir, 'node.exe');

  const runtime = await resolveLocalDshRuntime({
    dshHome: path.join(root, 'storage', '.dsh'),
    env: { LOCALAPPDATA: localAppData, Path: nodeDir },
    platform: 'win32',
  });

  assert.strictEqual(runtime.dshVersion, '0.1.0-rc.6');
  assert.deepStrictEqual(
    runtime.entrypointArgs,
    [fs.realpathSync(path.join(storeDir, 'lib', 'bin.js'))]
  );
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

// ---------------------------------------------------------------------------
// POSIX hosts (Remote-WSL / Remote-SSH).
//
// A Remote-WSL extension host is started by wsl.exe WITHOUT the user's shell
// rc: ~/.local/share/pnpm/bin and ~/.nvm/.../bin are absent from PATH while
// the Windows interop PATH is not. Discovery therefore has to reach the pnpm
// global store and the version-managed node by itself, and must never pick a
// candidate that lives on a Windows mount.
const POSIX_HASH = 'c7c8447fc30badd8e10ff1ece58d6ef3660f5f1cfbaf2f6c51a6d8a725822bde';
const POSIX_STORE_DIR = '20b3-18d959c9da0c67be-0';

test('local resolver finds a POSIX pnpm-global install through a symlinked store group', { skip: process.platform === 'win32' }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pnpm-posix-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const storeRoot = path.join(home, '.local', 'share', 'pnpm', 'global', 'v11');
  // The real Linux layout: a `<rand>-<hash>` directory holding the package, an
  // older group with no dsh in it, a stray pnpm-workspace.yaml, and the
  // hash-named SYMLINK pnpm points at the group — filtering on isDirectory()
  // would hide the only usable install.
  const groupDir = path.join(storeRoot, POSIX_STORE_DIR);
  writeOfficialPackage(path.join(groupDir, 'node_modules', '@deepseek-ai', 'dsh'));
  fs.mkdirSync(path.join(storeRoot, '540-1a0d15d65b7-fed25e4ff1987d6f'), { recursive: true });
  fs.writeFileSync(path.join(storeRoot, 'pnpm-workspace.yaml'), 'packages: []\n');
  fs.symlinkSync(POSIX_STORE_DIR, path.join(storeRoot, POSIX_HASH), 'dir');
  // The pnpm bin directory holds shims and NOTHING else — no node. That is
  // exactly why spawning the shim under WSL ends in node.exe.
  const pnpmBin = path.join(home, '.local', 'share', 'pnpm', 'bin');
  fs.mkdirSync(pnpmBin, { recursive: true });
  fs.writeFileSync(path.join(pnpmBin, 'dsh'),
    '#!/bin/sh\nexec node "$basedir/../global/v11/' + POSIX_HASH
    + '/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"\n');
  const nvmBin = path.join(home, '.nvm', 'versions', 'node', 'v24.18.0', 'bin');
  writeNodeExecutable(nvmBin, 'node');

  const runtime = await resolveLocalDshRuntime({
    dshHome: path.join(home, 'storage', '.dsh'),
    env: { HOME: home, PATH: path.join(home, 'no-shell-path') },
    platform: 'linux',
  });

  assert.strictEqual(runtime.source, 'local-official-package');
  assert.strictEqual(runtime.dshVersion, '0.1.0-rc.6');
  assert.deepStrictEqual(
    runtime.entrypointArgs,
    [fs.realpathSync(path.join(groupDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))]
  );
  assert.strictEqual(runtime.executablePath, fs.realpathSync(path.join(nvmBin, 'node')));
  assert.ok(!runtime.executablePath.includes('/mnt/c'), 'never a Windows-mounted node');
});

test('local resolver honors XDG_DATA_HOME for the POSIX pnpm store', { skip: process.platform === 'win32' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pnpm-xdg-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataHome = path.join(root, 'xdg');
  const storeDir = path.join(dataHome, 'pnpm', 'global', 'v11', POSIX_STORE_DIR,
    'node_modules', '@deepseek-ai', 'dsh');
  writeOfficialPackage(storeDir);
  const home = path.join(root, 'home');
  writeNodeExecutable(path.join(home, '.nvm', 'versions', 'node', 'v22.14.0', 'bin'), 'node');

  const runtime = await resolveLocalDshRuntime({
    dshHome: path.join(root, 'storage', '.dsh'),
    // HOME holds no store at all: only $XDG_DATA_HOME can supply the package.
    env: { HOME: home, XDG_DATA_HOME: dataHome, PATH: path.join(root, 'no-shell-path') },
    platform: 'linux',
  });

  assert.strictEqual(runtime.dshVersion, '0.1.0-rc.6');
  assert.deepStrictEqual(runtime.entrypointArgs, [fs.realpathSync(path.join(storeDir, 'lib', 'bin.js'))]);
});

test('POSIX node discovery prefers the version-managed node over a PATH node', { skip: process.platform === 'win32' }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-node-order-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const nvmBin = path.join(home, '.nvm', 'versions', 'node', 'v24.18.0', 'bin');
  writeNodeExecutable(nvmBin, 'node');
  const pathBin = path.join(home, 'path-bin');
  writeNodeExecutable(pathBin, 'node');
  writeOfficialPackage(path.join(pathBin, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh'));

  const runtime = await resolveLocalDshRuntime({
    dshHome: path.join(home, 'storage', '.dsh'),
    env: { HOME: home, PATH: pathBin },
    platform: 'linux',
  });

  // A GUI-launched extension host carries whatever node the desktop session
  // happened to export; the version manager that owns the install is the
  // pairing that actually matches it.
  assert.strictEqual(runtime.executablePath, fs.realpathSync(path.join(nvmBin, 'node')));
});

test('POSIX candidates under a Windows mount are never enumerated', { skip: process.platform === 'win32' }, () => {
  // The extension host's PATH under Remote-WSL is the Windows PATH, so the
  // only hits it offers are /mnt/c ones. mountRoots is injected so the
  // assertion holds whether or not the test host really has a /mnt/c.
  const env = {
    HOME: '/home/u',
    PATH: ['/mnt/c/Program Files/nodejs', '/mnt/c/Users/u/AppData/Local/pnpm', '/usr/local/bin', '/usr/bin']
      .join(path.posix.delimiter),
  };
  const packages = packageCandidates(env, 'linux', { mountRoots: ['/mnt/c'] });
  const nodes = nodeCandidates(env, 'linux', { mountRoots: ['/mnt/c'] });

  assert.ok(packages.includes('/usr/lib/node_modules/@deepseek-ai/dsh'), packages.join(','));
  assert.ok(nodes.includes('/usr/bin/node'), nodes.join(','));
  assert.ok(!packages.some((candidate) => candidate.startsWith('/mnt/c')), packages.join(','));
  assert.ok(!nodes.some((candidate) => candidate.startsWith('/mnt/c')), nodes.join(','));

  // Muting the mount list brings the Windows candidates back: it is the
  // foreign filter, not the enumeration, that removed them.
  assert.ok(nodeCandidates(env, 'linux', { mountRoots: [] })
    .some((candidate) => candidate === '/mnt/c/Program Files/nodejs/node'));
  assert.ok(packageCandidates(env, 'linux', { mountRoots: [] })
    .some((candidate) => candidate.startsWith('/mnt/c/')));
});