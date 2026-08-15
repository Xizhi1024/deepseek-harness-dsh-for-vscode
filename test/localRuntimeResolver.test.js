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
