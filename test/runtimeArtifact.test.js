'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  hashFileManifest,
  isValidDshVersion,
  parseRuntimeArtifactManifest,
  verifyRuntimeDirectory,
} = require('../src/runtimeArtifact');

function digest(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function validManifest() {
  const files = [
    { path: 'bin/node.exe', sha256: digest('node'), size: 4, executable: true },
    { path: 'bin/dsh.js', sha256: digest('entry'), size: 5, executable: false },
    { path: 'LICENSE', sha256: digest('license'), size: 7, executable: false },
  ];
  return {
    schemaVersion: 1,
    dshVersion: '0.1.0-rc.5',
    bridgeProtocolVersion: 1,
    nodeVersion: '24.11.1',
    platform: 'win32',
    arch: 'x64',
    archiveSha256: 'a'.repeat(64),
    unpackedSha256: hashFileManifest(files),
    sourceCommit: 'b'.repeat(40),
    licenseFiles: ['LICENSE'],
    builtAt: '2026-08-15T00:00:00.000Z',
    entrypoint: 'bin/node.exe',
    entryScript: 'bin/dsh.js',
    files,
  };
}

test('runtime manifest validates identity, hashes, licenses, and safe paths', () => {
  const parsed = parseRuntimeArtifactManifest(validManifest());
  assert.strictEqual(parsed.entrypoint, 'bin/node.exe');
  assert.strictEqual(parsed.entryScript, 'bin/dsh.js');
  assert.strictEqual(parsed.files.length, 3);
  assert.ok(Object.isFrozen(parsed));

  for (const unsafe of ['../escape', '/absolute', 'C:\\absolute', 'dir//file', './file']) {
    const manifest = validManifest();
    manifest.files[1].path = unsafe;
    assert.throws(() => parseRuntimeArtifactManifest(manifest), /safe relative path/);
  }

  const wrongListHash = validManifest();
  wrongListHash.unpackedSha256 = 'c'.repeat(64);
  assert.throws(() => parseRuntimeArtifactManifest(wrongListHash), /canonical file list/);

  const missingLicense = validManifest();
  missingLicense.licenseFiles = ['THIRD_PARTY_NOTICES'];
  assert.throws(() => parseRuntimeArtifactManifest(missingLicense), /not listed/);

  const missingScript = validManifest();
  missingScript.entryScript = 'bin/missing.js';
  assert.throws(() => parseRuntimeArtifactManifest(missingScript), /entryScript must be listed/);
});

test('runtime manifest rejects unsafe dshVersion values', () => {
  assert.strictEqual(isValidDshVersion('0.1.0-rc.5'), true);
  assert.strictEqual(isValidDshVersion('1.0.0'), true);
  assert.strictEqual(isValidDshVersion('2026.08.15+build.1'), true);
  for (const bad of ['../..', 'has space', '', '..', 'a/b', '-leading']) {
    assert.strictEqual(isValidDshVersion(bad), false, `expected invalid: ${JSON.stringify(bad)}`);
    const manifest = validManifest();
    manifest.dshVersion = bad;
    assert.throws(() => parseRuntimeArtifactManifest(manifest), /dshVersion/);
  }
});

test('runtime directory verification rejects corruption and unknown files', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-artifact-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'node.exe'), 'node');
  fs.writeFileSync(path.join(root, 'bin', 'dsh.js'), 'entry');
  fs.writeFileSync(path.join(root, 'LICENSE'), 'license');
  if (process.platform !== 'win32') fs.chmodSync(path.join(root, 'bin', 'node.exe'), 0o755);
  const manifest = parseRuntimeArtifactManifest(validManifest());
  await verifyRuntimeDirectory(root, manifest);

  fs.writeFileSync(path.join(root, 'bin', 'dsh.js'), 'wrong');
  await assert.rejects(verifyRuntimeDirectory(root, manifest), /hash mismatch|size mismatch/);
  fs.writeFileSync(path.join(root, 'bin', 'dsh.js'), 'entry');
  fs.writeFileSync(path.join(root, 'unexpected.exe'), 'unknown');
  await assert.rejects(verifyRuntimeDirectory(root, manifest), /file list mismatch/);
});
