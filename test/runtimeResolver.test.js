'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { hashFileManifest } = require('../src/runtimeArtifact');
const { RuntimeResolver } = require('../src/runtimeResolver');

function digest(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function writeRuntimeFixture(storageRoot) {
  const version = '0.1.0-rc.5';
  const runtimeRoot = path.join(storageRoot, 'runtime', version, 'win32-x64');
  const payloadRoot = path.join(runtimeRoot, 'payload');
  fs.mkdirSync(path.join(payloadRoot, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(storageRoot, 'state'), { recursive: true });
  fs.writeFileSync(path.join(payloadRoot, 'bin', 'dsh.cmd'), 'entry');
  fs.writeFileSync(path.join(payloadRoot, 'bin', 'dsh.js'), 'script');
  fs.writeFileSync(path.join(payloadRoot, 'LICENSE'), 'license');
  const files = [
    { path: 'bin/dsh.cmd', sha256: digest('entry'), size: 5, executable: true },
    { path: 'bin/dsh.js', sha256: digest('script'), size: 6, executable: false },
    { path: 'LICENSE', sha256: digest('license'), size: 7, executable: false },
  ];
  const manifest = {
    schemaVersion: 1,
    dshVersion: version,
    bridgeProtocolVersion: 1,
    nodeVersion: '24.11.1',
    platform: 'win32',
    arch: 'x64',
    archiveSha256: 'a'.repeat(64),
    unpackedSha256: hashFileManifest(files),
    sourceCommit: 'b'.repeat(40),
    licenseFiles: ['LICENSE'],
    builtAt: '2026-08-15T00:00:00.000Z',
    entrypoint: 'bin/dsh.cmd',
    entryScript: 'bin/dsh.js',
    files,
  };
  fs.writeFileSync(path.join(runtimeRoot, 'manifest.json'), JSON.stringify(manifest));
  const pointer = { dshVersion: version, platform: 'win32', arch: 'x64' };
  fs.writeFileSync(path.join(storageRoot, 'state', 'current.json'), JSON.stringify(pointer));
  fs.writeFileSync(path.join(storageRoot, 'state', 'last-good.json'), JSON.stringify(pointer));
  return { payloadRoot };
}

test('RuntimeResolver returns only a fully verified current or last-good runtime', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-resolver-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const { payloadRoot } = writeRuntimeFixture(storageRoot);
  const resolver = new RuntimeResolver({ storageRoot, platform: 'win32', arch: 'x64' });

  const current = await resolver.resolveCurrent();
  assert.strictEqual(current.executablePath, path.join(payloadRoot, 'bin', 'dsh.cmd'));
  assert.deepStrictEqual(current.entrypointArgs, [path.join(payloadRoot, 'bin', 'dsh.js')]);
  assert.strictEqual(current.profileHome, path.join(storageRoot, 'profiles', 'web'));
  assert.strictEqual(current.dshHome, storageRoot);
  assert.strictEqual((await resolver.resolveLastGood()).manifest.dshVersion, '0.1.0-rc.5');

  fs.writeFileSync(path.join(payloadRoot, 'bin', 'dsh.cmd'), 'tampered');
  await assert.rejects(resolver.resolveCurrent(), /hash mismatch|size mismatch/);
});

test('RuntimeResolver fails closed on pointer platform drift', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-platform-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  writeRuntimeFixture(storageRoot);
  const resolver = new RuntimeResolver({ storageRoot, platform: 'linux', arch: 'x64' });
  await assert.rejects(resolver.resolveCurrent(), /platform mismatch/);
});

test('RuntimeResolver rejects unsafe dshVersion pointers before path resolution', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-version-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  writeRuntimeFixture(storageRoot);
  const resolver = new RuntimeResolver({ storageRoot, platform: 'win32', arch: 'x64' });

  for (const bad of ['../..', 'has space', '..', 'a/b', '']) {
    fs.writeFileSync(
      path.join(storageRoot, 'state', 'current.json'),
      JSON.stringify({ dshVersion: bad, platform: 'win32', arch: 'x64' })
    );
    await assert.rejects(resolver.resolveCurrent(), /dshVersion/);
  }

  fs.writeFileSync(
    path.join(storageRoot, 'state', 'last-good.json'),
    JSON.stringify({ dshVersion: '../../escape', platform: 'win32', arch: 'x64' })
  );
  await assert.rejects(resolver.resolveLastGood(), /invalid dshVersion/);
});
