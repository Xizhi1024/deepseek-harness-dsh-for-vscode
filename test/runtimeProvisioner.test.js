'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ensureManagedRuntime,
  parseRuntimeReleaseManifest,
  selectRuntimeArtifact,
} = require('../src/runtimeProvisioner');
const { createManifest } = require('./runtimeFixtures');

function manifest(version, builtAt) {
  const value = createManifest({
    archive: Buffer.from(`archive-${version}`),
    version,
    entryContent: `entry-${version}`,
  });
  value.builtAt = builtAt;
  return value;
}

test('runtime release manifest parses and selects the platform/arch/version artifact', () => {
  const win1 = manifest('1.0.0', '2026-08-15T00:00:00.000Z');
  const win2 = manifest('2.0.0', '2026-08-16T00:00:00.000Z');
  const linux = {
    ...manifest('2.0.0-linux', '2026-08-16T00:00:00.000Z'),
    platform: 'linux',
    arch: 'x64',
  };

  const release = parseRuntimeReleaseManifest({
    schemaVersion: 1,
    artifacts: [
      { platform: 'win32', arch: 'x64', url: 'https://example.test/dsh-1.tar.gz', manifest: win1 },
      { platform: 'win32', arch: 'x64', url: 'https://example.test/dsh-2.tar.gz', manifest: win2 },
      { platform: 'linux', arch: 'x64', url: 'https://example.test/dsh-linux.tar.gz', manifest: linux },
    ],
  });

  assert.strictEqual(release.artifacts.length, 3);
  assert.strictEqual(selectRuntimeArtifact(release, { platform: 'win32', arch: 'x64' }).manifest.dshVersion, '2.0.0');
  assert.strictEqual(
    selectRuntimeArtifact(release, { platform: 'win32', arch: 'x64', version: '1.0.0' }).manifest.dshVersion,
    '1.0.0'
  );
  assert.throws(
    () => selectRuntimeArtifact(release, { platform: 'win32', arch: 'x64', version: '9.9.9' }),
    /No managed DSH runtime artifact matches version 9\.9\.9/
  );
  assert.throws(
    () => selectRuntimeArtifact(release, { platform: 'darwin', arch: 'arm64' }),
    /No managed DSH runtime artifact matches darwin-arm64/
  );
});

test('runtime release manifest rejects non-HTTPS artifact URLs', () => {
  const value = manifest('1.0.0', '2026-08-15T00:00:00.000Z');
  assert.throws(
    () => parseRuntimeReleaseManifest({
      schemaVersion: 1,
      artifacts: [
        { platform: 'win32', arch: 'x64', url: 'http://example.test/dsh.tar.gz', manifest: value },
      ],
    }),
    /HTTPS URL/
  );
});

test('ensureManagedRuntime fails readably without a manifest URL and no installed runtime', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-provisioner-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));

  await assert.rejects(
    ensureManagedRuntime({ storageRoot, platform: 'win32', arch: 'x64' }),
    (error) => {
      assert.strictEqual(error.name, 'ServerError');
      assert.match(error.template, /Managed DSH runtime is not installed/);
      assert.match(error.message, /dsh\.runtime\.manifestUrl/);
      return true;
    }
  );
});
