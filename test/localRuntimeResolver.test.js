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
  assert.strictEqual(runtime.profileHome, path.join(path.resolve(dshHome), 'profiles', 'web'));
  assert.strictEqual(runtime.profileName, 'web');
  assert.strictEqual(runtime.source, 'local-official-package');
  assert.strictEqual(runtime.dshVersion, '0.1.0-rc.6');
  assert.strictEqual(fs.statSync(dshHome).isDirectory(), true);
});

test('local resolver rejects a non-official package and explains installation', async (t) => {
  const value = fixture(t, 'lookalike-dsh');
  const dshHome = path.join(value.root, '.dsh');
  await assert.rejects(
    resolveLocalDshRuntime({
      dshHome,
      packageRoot: value.packageRoot,
      nodePath: value.nodePath,
    }),
    /npm install -g @deepseek-ai\/dsh/
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
