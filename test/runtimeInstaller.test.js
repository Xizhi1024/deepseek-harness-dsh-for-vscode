'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { RuntimeInstaller } = require('../src/runtimeInstaller');
const { RuntimeResolver } = require('../src/runtimeResolver');
const { createManifest, createTarGz } = require('./runtimeFixtures');

function runtimeArchive(entryContent = 'entry', extraEntries = []) {
  return createTarGz([
    { name: 'bin/', type: '5' },
    { name: 'bin/dsh.cmd', content: entryContent },
    { name: 'LICENSE', content: 'license' },
    ...extraEntries,
  ]);
}

function writeArchive(root, name, content) {
  const archivePath = path.join(root, name);
  fs.writeFileSync(archivePath, content);
  return archivePath;
}

test('RuntimeInstaller verifies, installs, promotes, and rolls back atomically', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-installer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storageRoot = path.join(root, 'storage');
  const installer = new RuntimeInstaller({ storageRoot, platform: 'win32', arch: 'x64' });
  const resolver = new RuntimeResolver({ storageRoot, platform: 'win32', arch: 'x64' });

  const archive1 = runtimeArchive('entry-v1');
  const manifest1 = createManifest({ archive: archive1, version: '1.0.0', entryContent: 'entry-v1' });
  const candidate1 = await installer.installFromArchive({
    manifest: manifest1,
    archivePath: writeArchive(root, 'runtime-1.tar.gz', archive1),
  });
  assert.strictEqual(fs.existsSync(path.join(storageRoot, 'state', 'current.json')), false);
  await installer.promote(candidate1);
  assert.strictEqual((await resolver.resolveCurrent()).manifest.dshVersion, '1.0.0');

  const archive2 = runtimeArchive('entry-v2');
  const manifest2 = createManifest({ archive: archive2, version: '2.0.0', entryContent: 'entry-v2' });
  const candidate2 = await installer.installFromArchive({
    manifest: manifest2,
    archivePath: writeArchive(root, 'runtime-2.tar.gz', archive2),
  });
  await installer.promote(candidate2);
  assert.strictEqual((await resolver.resolveCurrent()).manifest.dshVersion, '2.0.0');
  assert.strictEqual((await resolver.resolveLastGood()).manifest.dshVersion, '1.0.0');

  await installer.rollback();
  assert.strictEqual((await resolver.resolveCurrent()).manifest.dshVersion, '1.0.0');

  const archive3 = runtimeArchive('entry-v3');
  const candidate3 = await installer.installFromArchive({
    manifest: createManifest({ archive: archive3, version: '3.0.0', entryContent: 'entry-v3' }),
    archivePath: writeArchive(root, 'runtime-3.tar.gz', archive3),
  });
  assert.deepStrictEqual(await installer.cleanup({ activeRuntimeRoots: [candidate3.runtimeRoot] }), [
    candidate2.runtimeRoot,
  ]);
  assert.strictEqual(fs.existsSync(candidate1.runtimeRoot), true);
  assert.strictEqual(fs.existsSync(candidate3.runtimeRoot), true);
  assert.deepStrictEqual(await installer.cleanup(), [candidate3.runtimeRoot]);
  assert.strictEqual(fs.existsSync(candidate3.runtimeRoot), false);
});

test('RuntimeInstaller.rollback without last-good removes the current pointer without throwing', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-rollback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storageRoot = path.join(root, 'storage');
  const installer = new RuntimeInstaller({ storageRoot, platform: 'win32', arch: 'x64' });
  const stateRoot = path.join(storageRoot, 'state');
  fs.mkdirSync(stateRoot, { recursive: true });
  const currentPath = path.join(stateRoot, 'current.json');
  fs.writeFileSync(currentPath, JSON.stringify({ dshVersion: '1.0.0', platform: 'win32', arch: 'x64' }));

  await installer.rollback();

  assert.strictEqual(fs.existsSync(currentPath), false);
  assert.strictEqual(fs.existsSync(path.join(stateRoot, 'last-good.json')), false);
});

test('RuntimeInstaller.rollback ignores a mismatched expected pointer', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-rollback-mismatch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storageRoot = path.join(root, 'storage');
  const installer = new RuntimeInstaller({ storageRoot, platform: 'win32', arch: 'x64' });
  const stateRoot = path.join(storageRoot, 'state');
  fs.mkdirSync(stateRoot, { recursive: true });
  const currentPath = path.join(stateRoot, 'current.json');
  const current = { dshVersion: '1.0.0', platform: 'win32', arch: 'x64' };
  fs.writeFileSync(currentPath, JSON.stringify(current));

  await installer.rollback({ dshVersion: '2.0.0', platform: 'win32', arch: 'x64' });

  assert.deepStrictEqual(JSON.parse(fs.readFileSync(currentPath, 'utf8')), current);
});

test('RuntimeInstaller.rollback with corrupt last-good removes current and throws', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-rollback-corrupt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storageRoot = path.join(root, 'storage');
  const installer = new RuntimeInstaller({ storageRoot, platform: 'win32', arch: 'x64' });
  const stateRoot = path.join(storageRoot, 'state');
  fs.mkdirSync(stateRoot, { recursive: true });
  const currentPath = path.join(stateRoot, 'current.json');
  fs.writeFileSync(currentPath, JSON.stringify({ dshVersion: '1.0.0', platform: 'win32', arch: 'x64' }));
  fs.writeFileSync(path.join(stateRoot, 'last-good.json'), '{bad json');

  await assert.rejects(
    installer.rollback({ dshVersion: '1.0.0', platform: 'win32', arch: 'x64' }),
    /Expected property name|Unexpected token/
  );
  assert.strictEqual(fs.existsSync(currentPath), false, 'corrupt last-good must not leave the bad current in place');
});

test('RuntimeInstaller.cleanup rejects invalid pointer versions', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-cleanup-version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storageRoot = path.join(root, 'storage');
  const installer = new RuntimeInstaller({ storageRoot, platform: 'win32', arch: 'x64' });
  fs.mkdirSync(path.join(storageRoot, 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(storageRoot, 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(storageRoot, 'state', 'current.json'),
    JSON.stringify({ dshVersion: '../..', platform: 'win32', arch: 'x64' })
  );

  await assert.rejects(
    installer.cleanup(),
    /Cannot clean runtimes with an invalid current\.json pointer/
  );
});

test('RuntimeInstaller fails closed for archive corruption, traversal, links, and cancellation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-reject-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storageRoot = path.join(root, 'storage');
  const installer = new RuntimeInstaller({ storageRoot, platform: 'win32', arch: 'x64' });

  const goodArchive = runtimeArchive();
  const goodManifest = createManifest({ archive: goodArchive });
  const corruptPath = writeArchive(root, 'corrupt.tar.gz', Buffer.from('not-an-archive'));
  await assert.rejects(
    installer.installFromArchive({ manifest: goodManifest, archivePath: corruptPath }),
    /archive hash mismatch/
  );

  const traversalArchive = runtimeArchive('entry', [{ name: '../escape', content: 'bad' }]);
  await assert.rejects(
    installer.installFromArchive({
      manifest: createManifest({ archive: traversalArchive }),
      archivePath: writeArchive(root, 'traversal.tar.gz', traversalArchive),
    }),
    /safe relative path/
  );
  assert.strictEqual(fs.existsSync(path.join(root, 'escape')), false);

  const linkArchive = runtimeArchive('entry', [{ name: 'bin/link', type: '2' }]);
  await assert.rejects(
    installer.installFromArchive({
      manifest: createManifest({ archive: linkArchive }),
      archivePath: writeArchive(root, 'link.tar.gz', linkArchive),
    }),
    /entry type is not allowed/
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    installer.installFromArchive({
      manifest: goodManifest,
      archivePath: writeArchive(root, 'cancelled.tar.gz', goodArchive),
      signal: controller.signal,
    }),
    { name: 'AbortError' }
  );
});
