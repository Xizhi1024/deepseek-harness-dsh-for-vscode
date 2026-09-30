'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { inflateRawSync } = require('node:zlib');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
function assertWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Path must stay inside the isolated run');
}

/** Read regular non-ZIP64 VSIX entries in memory; never extract archive paths. */
function readVsix(file) {
  const bytes = fs.readFileSync(file);
  assert.ok(bytes.length < 1024 * 1024 * 1024, 'VSIX exceeds test artifact limit');
  let end = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) {
    if (bytes.readUInt32LE(p) === 0x06054b50 && p + 22 + bytes.readUInt16LE(p + 20) === bytes.length) { end = p; break; }
  }
  assert.ok(end >= 0, 'VSIX central directory is missing');
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  assert.ok(count < 65535 && offset !== 0xffffffff, 'ZIP64 is unsupported by this bounded test reader');
  const entries = new Map();
  const seenNames = new Set();
  let expanded = 0;
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24);
    const nameSize = bytes.readUInt16LE(offset + 28), extraSize = bytes.readUInt16LE(offset + 30), commentSize = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameSize).toString('utf8');
    offset += 46 + nameSize + extraSize + commentSize;
    assert.ok(!(flags & 1) && [0, 8].includes(method), 'Unsupported VSIX compression/encryption');
    assert.ok(!name.startsWith('/') && !name.includes('\\') && !name.includes(':') && !name.split('/').includes('..'), 'Unsafe VSIX path');
    assert.ok(!seenNames.has(name), 'Duplicate VSIX entry');
    seenNames.add(name);
    if (name.endsWith('/')) continue;
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    const dataOffset = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    assert.ok(dataOffset + compressed <= bytes.length && size <= 32 * 1024 * 1024, 'Invalid VSIX entry bounds');
    expanded += size; assert.ok(expanded <= 256 * 1024 * 1024, 'VSIX expanded size exceeds limit');
    const encoded = bytes.subarray(dataOffset, dataOffset + compressed);
    const data = method === 0 ? encoded : inflateRawSync(encoded, { maxOutputLength: size || 1 });
    assert.equal(data.length, size);
    entries.set(name, data);
  }
  return { entries, sha256: sha256(bytes) };
}

function candidateManifest(vsixPath, extensionVersion = '1.2.1', integrationVersion = '0.11.0') {
  const archive = readVsix(vsixPath);
  const manifest = JSON.parse(archive.entries.get('extension/package.json'));
  const integration = JSON.parse(archive.entries.get('extension/runtime-integration/dsh-vscode-integration/package.json'));
  assert.equal(manifest.publisher.toLowerCase() + '.' + manifest.name, 'xizhi1024.dsh-vs-sidebar');
  assert.equal(manifest.version, extensionVersion);
  assert.equal(integration.version, integrationVersion);
  const files = {};
  for (const [name, data] of archive.entries) {
    if (!name.startsWith('extension/')) continue;
    const relative = name.slice('extension/'.length);
    if (relative !== 'package.json') files[relative] = sha256(data);
  }
  for (const required of ['src/extension.js', 'src/session/browserProxy.js', 'runtime-integration/dsh-vscode-integration/lib/client.dsh020rc1.js',
    'runtime-integration/dsh-vscode-integration/lib/client.sessionBridge.js', 'runtime-integration/dsh-vscode-integration/contracts/session-bridge-v1.json']) assert.ok(files[required], `Candidate omitted ${required}`);
  return { extensionId: manifest.publisher + '.' + manifest.name, extensionVersion, integrationVersion, vsixSha256: archive.sha256, manifest, files };
}

function verifyInstalled(directory, expected) {
  const installed = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  delete installed.__metadata;
  assert.deepEqual(installed, expected.manifest, 'Installed manifest differs from VSIX beyond VS Code metadata');
  for (const [relative, hash] of Object.entries(expected.files)) {
    const file = path.join(directory, relative); assertWithin(directory, file);
    assert.equal(sha256(fs.readFileSync(file)), hash, `Installed artifact differs: ${relative}`);
  }
  return Object.keys(expected.files).length;
}

function codePaths(executable) {
  const directory = path.dirname(executable);
  const candidates = [directory, ...fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(directory, entry.name))];
  const resource = candidates.map((candidate) => path.join(candidate, 'resources', 'app')).find((candidate) => fs.existsSync(path.join(candidate, 'out', 'cli.js')));
  assert.ok(resource, 'VS Code CLI resource directory was not found');
  return { cli: path.join(resource, 'out', 'cli.js'), version: JSON.parse(fs.readFileSync(path.join(resource, 'package.json'), 'utf8')).version };
}
module.exports = { assertWithin, candidateManifest, verifyInstalled, codePaths, readVsix, sha256 };
