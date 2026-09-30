'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { deflateRawSync } = require('node:zlib');
const { candidateManifest, readVsix, verifyInstalled } = require('../extension-host/installedAcceptance');

const requiredFiles = [
  'src/extension.js',
  'src/session/browserProxy.js',
  'runtime-integration/dsh-vscode-integration/lib/client.dsh020rc1.js',
  'runtime-integration/dsh-vscode-integration/lib/client.sessionBridge.js',
  'runtime-integration/dsh-vscode-integration/contracts/session-bridge-v1.json',
];
const integrationManifest = 'runtime-integration/dsh-vscode-integration/package.json';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

// Small, ordinary ZIP records keep these fixtures independent of packaging tools.
function zip(entries) {
  const localRecords = [], directoryRecords = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data || '');
    const method = entry.method || 0;
    const encoded = method === 8 ? deflateRawSync(data) : data;
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags || 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(encoded.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(entry.flags || 0, 8);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(encoded.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    localRecords.push(local, name, encoded);
    directoryRecords.push(directory, name);
    offset += local.length + name.length + encoded.length;
  }
  const directory = Buffer.concat(directoryRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localRecords, directory, end]);
}

function fixture(t) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'dsh-installed-acceptance-'));
  t.after(() => {
    const relative = path.relative(temporaryRoot, path.resolve(directory));
    assert.ok(relative.startsWith('dsh-installed-acceptance-') && !relative.includes(path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    write(bytes) {
      const file = path.join(directory, 'candidate.vsix');
      fs.writeFileSync(file, bytes);
      return file;
    },
  };
}

function candidateEntries({ manifest = {}, integrationVersion = '0.11.0' } = {}) {
  return [
    { name: 'extension/package.json', data: JSON.stringify({ publisher: 'Xizhi1024', name: 'dsh-vs-sidebar', version: '1.2.1', ...manifest }) },
    { name: `extension/${integrationManifest}`, data: JSON.stringify({ name: 'dsh-vscode-integration', version: integrationVersion }) },
    ...requiredFiles.map((name, index) => ({ name: `extension/${name}`, data: `fixture artifact ${index}\n`, method: index % 2 ? 8 : 0 })),
    { name: '[Content_Types].xml', data: '<Types />' },
  ];
}

function installFixture(directory, entries, metadata = true) {
  const installed = path.join(directory, 'installed');
  for (const entry of entries) {
    if (!entry.name.startsWith('extension/') || entry.name.endsWith('/')) continue;
    const file = path.join(installed, entry.name.slice('extension/'.length));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const data = metadata && entry.name === 'extension/package.json'
      ? JSON.stringify({ ...JSON.parse(entry.data), __metadata: { installedTimestamp: 123, source: 'vsix' } })
      : entry.data;
    fs.writeFileSync(file, data);
  }
  return installed;
}

test('candidate records versions and hashes the exact VSIX and every extension artifact', (t) => {
  const run = fixture(t), entries = candidateEntries(), bytes = zip(entries);
  const expected = candidateManifest(run.write(bytes));
  assert.equal(expected.extensionId, 'Xizhi1024.dsh-vs-sidebar');
  assert.equal(expected.extensionVersion, '1.2.1');
  assert.equal(expected.integrationVersion, '0.11.0');
  assert.equal(expected.vsixSha256, digest(bytes));
  assert.equal(Object.keys(expected.files).length, requiredFiles.length + 1);
  assert.equal(expected.files['package.json'], undefined);
  assert.equal(expected.files['[Content_Types].xml'], undefined);
  for (const entry of entries.filter((item) => item.name.startsWith('extension/') && item.name !== 'extension/package.json')) {
    assert.equal(expected.files[entry.name.slice('extension/'.length)], digest(Buffer.from(entry.data)));
  }
  assert.equal(verifyInstalled(installFixture(run.directory, entries), expected), requiredFiles.length + 1);
});

test('candidate rejects a different extension identity or either package version', async (t) => {
  for (const [name, overrides] of [
    ['publisher', { manifest: { publisher: 'Other' } }],
    ['extension name', { manifest: { name: 'other-extension' } }],
    ['extension version', { manifest: { version: '1.1.9' } }],
    ['integration version', { integrationVersion: '0.9.0' }],
  ]) {
    await t.test(name, (child) => {
      const run = fixture(child);
      assert.throws(() => candidateManifest(run.write(zip(candidateEntries(overrides)))), { code: 'ERR_ASSERTION' });
    });
  }
});

test('candidate requires both package manifests and every runtime chunk', async (t) => {
  for (const missing of ['package.json', integrationManifest, ...requiredFiles]) {
    await t.test(missing, (child) => {
      const run = fixture(child);
      const entries = candidateEntries().filter((entry) => entry.name !== `extension/${missing}`);
      assert.throws(() => candidateManifest(run.write(zip(entries))));
    });
  }
});

test('installed verification rejects mutated and missing artifacts', async (t) => {
  for (const mutation of ['changed chunk', 'missing chunk', 'changed manifest']) {
    await t.test(mutation, (child) => {
      const run = fixture(child), entries = candidateEntries();
      const expected = candidateManifest(run.write(zip(entries)));
      const installed = installFixture(run.directory, entries);
      const chunk = path.join(installed, requiredFiles[2]);
      if (mutation === 'changed chunk') fs.appendFileSync(chunk, '\nchanged');
      else if (mutation === 'missing chunk') fs.unlinkSync(chunk);
      else fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify({ ...expected.manifest, version: '1.1.9' }));
      assert.throws(() => verifyInstalled(installed, expected), mutation === 'missing chunk'
        ? { code: 'ENOENT' }
        : { code: 'ERR_ASSERTION' });
    });
  }
});

test('VSIX reader rejects unsafe paths before returning archive contents', async (t) => {
  for (const name of ['/absolute/file', '../escape', 'extension/../escape', 'extension\\file', 'C:/escape', 'extension/file:stream']) {
    await t.test(name, (child) => {
      const run = fixture(child);
      assert.throws(() => readVsix(run.write(zip([{ name, data: 'fixture' }]))), /Unsafe VSIX path/);
    });
  }
});

test('VSIX reader rejects duplicate files and duplicate directories', async (t) => {
  for (const name of ['extension/file.js', 'extension/']) {
    await t.test(name, (child) => {
      const run = fixture(child);
      assert.throws(() => readVsix(run.write(zip([{ name }, { name }]))), /Duplicate VSIX entry/);
    });
  }
});

test('VSIX reader rejects malformed records, unsupported encoding, and invalid bounds', async (t) => {
  const ordinary = () => zip([{ name: 'extension/file.js', data: 'fixture' }]);
  const cases = [
    ['missing directory', () => Buffer.from('not a ZIP file')],
    ['truncated end record', () => ordinary().subarray(0, -1)],
    ['invalid central header', () => { const bytes = ordinary(); bytes.writeUInt32LE(0, bytes.readUInt32LE(bytes.length - 6)); return bytes; }],
    ['invalid local header', () => { const bytes = ordinary(); bytes.writeUInt32LE(0, 0); return bytes; }],
    ['encrypted file', () => zip([{ name: 'extension/file.js', data: 'fixture', flags: 1 }])],
    ['unsupported method', () => zip([{ name: 'extension/file.js', data: 'fixture', method: 12 }])],
    ['out of bounds compressed data', () => { const bytes = ordinary(); bytes.writeUInt32LE(bytes.length, bytes.readUInt32LE(bytes.length - 6) + 20); return bytes; }],
    ['incorrect expanded size', () => { const bytes = ordinary(); bytes.writeUInt32LE(8, bytes.readUInt32LE(bytes.length - 6) + 24); return bytes; }],
    ['oversized entry', () => { const bytes = ordinary(); bytes.writeUInt32LE(32 * 1024 * 1024 + 1, bytes.readUInt32LE(bytes.length - 6) + 24); return bytes; }],
  ];
  for (const [name, build] of cases) {
    await t.test(name, (child) => {
      const run = fixture(child);
      assert.throws(() => readVsix(run.write(build())));
    });
  }
});
