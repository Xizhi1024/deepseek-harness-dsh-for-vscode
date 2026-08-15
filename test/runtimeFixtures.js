'use strict';

const crypto = require('node:crypto');
const zlib = require('node:zlib');

const { hashFileManifest } = require('../src/runtimeArtifact');

function digest(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function writeString(block, offset, length, value) {
  Buffer.from(value, 'utf8').copy(block, offset, 0, length);
}

function writeOctal(block, offset, length, value) {
  writeString(block, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`);
}

function tarHeader({ name, content, type = '0' }) {
  const block = Buffer.alloc(512, 0);
  writeString(block, 0, 100, name);
  writeOctal(block, 100, 8, type === '5' ? 0o755 : 0o644);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, content.length);
  writeOctal(block, 136, 12, 0);
  block.fill(0x20, 148, 156);
  block[156] = type.charCodeAt(0);
  writeString(block, 257, 6, 'ustar\0');
  writeString(block, 263, 2, '00');
  let checksum = 0;
  for (const value of block) checksum += value;
  writeString(block, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return block;
}

function createTarGz(entries) {
  const chunks = [];
  for (const input of entries) {
    const content = Buffer.isBuffer(input.content)
      ? input.content
      : Buffer.from(input.content || '', 'utf8');
    const entry = { ...input, content };
    chunks.push(tarHeader(entry));
    chunks.push(content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(chunks));
}

function createManifest({ archive, version = '0.1.0-rc.5', entryContent = 'entry' }) {
  const files = [
    { path: 'bin/dsh.cmd', sha256: digest(entryContent), size: Buffer.byteLength(entryContent), executable: true },
    { path: 'LICENSE', sha256: digest('license'), size: 7, executable: false },
  ];
  return {
    schemaVersion: 1,
    dshVersion: version,
    bridgeProtocolVersion: 1,
    nodeVersion: '24.11.1',
    platform: 'win32',
    arch: 'x64',
    archiveSha256: digest(archive),
    unpackedSha256: hashFileManifest(files),
    sourceCommit: 'b'.repeat(40),
    licenseFiles: ['LICENSE'],
    builtAt: '2026-08-15T00:00:00.000Z',
    entrypoint: 'bin/dsh.cmd',
    files,
  };
}

module.exports = { createManifest, createTarGz };
