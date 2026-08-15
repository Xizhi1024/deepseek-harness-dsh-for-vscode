'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const { validateArtifactPath } = require('./runtimeArtifact');

const TAR_BLOCK_SIZE = 512;

function abortIfRequested(signal) {
  if (!signal?.aborted) return;
  const error = new Error('Runtime installation cancelled');
  error.name = 'AbortError';
  throw error;
}

function tarString(block, start, length) {
  const end = block.indexOf(0, start);
  return block.subarray(start, end >= start && end < start + length ? end : start + length)
    .toString('utf8')
    .trim();
}

function tarOctal(block, start, length, field) {
  const text = tarString(block, start, length).trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error(`Runtime tar ${field} is not octal`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Runtime tar ${field} is out of range`);
  }
  return value;
}

function verifyTarChecksum(block) {
  const expected = tarOctal(block, 148, 8, 'checksum');
  let actual = 0;
  for (let index = 0; index < TAR_BLOCK_SIZE; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : block[index];
  }
  if (actual !== expected) throw new Error('Runtime tar header checksum mismatch');
}

function parseTarHeader(block) {
  verifyTarChecksum(block);
  const name = tarString(block, 0, 100);
  const prefix = tarString(block, 345, 155);
  const combined = prefix ? `${prefix}/${name}` : name;
  const rawType = block[156];
  const type = rawType === 0 ? '0' : String.fromCharCode(rawType);
  const size = tarOctal(block, 124, 12, 'size');
  return { path: combined, type, size };
}

function allowedDirectory(directory, expectedPaths) {
  const prefix = `${directory}/`;
  return expectedPaths.some((candidate) => candidate.startsWith(prefix));
}

/**
 * Extract the controlled USTAR subset used by managed runtime artifacts.
 * @param {string} archivePath
 * @param {string} destination
 * @param {object} manifest
 * @param {{signal?: AbortSignal}} [options]
 */
async function extractRuntimeTarGz(archivePath, destination, manifest, { signal } = {}) {
  abortIfRequested(signal);
  await fs.promises.mkdir(destination, { recursive: true });
  const expected = new Map(manifest.files.map((file) => [file.path, file]));
  const expectedPaths = [...expected.keys()];
  const seen = new Set();
  const gunzip = fs.createReadStream(archivePath).pipe(zlib.createGunzip());
  let buffer = Buffer.alloc(0);
  let current = null;
  let zeroBlocks = 0;
  let ended = false;

  try {
    for await (const chunk of gunzip) {
      abortIfRequested(signal);
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      while (buffer.length > 0) {
        abortIfRequested(signal);
        if (ended) {
          if (buffer.some((value) => value !== 0)) {
            throw new Error('Runtime tar contains data after its end marker');
          }
          buffer = Buffer.alloc(0);
          break;
        }

        if (current) {
          if (current.remaining > 0) {
            if (buffer.length === 0) break;
            const length = Math.min(buffer.length, current.remaining);
            await current.handle.write(buffer.subarray(0, length));
            buffer = buffer.subarray(length);
            current.remaining -= length;
            continue;
          }
          if (!current.closed) {
            await current.handle.close();
            current.closed = true;
          }
          if (current.padding > 0) {
            if (buffer.length < current.padding) break;
            buffer = buffer.subarray(current.padding);
          }
          current = null;
          continue;
        }

        if (buffer.length < TAR_BLOCK_SIZE) break;
        const header = buffer.subarray(0, TAR_BLOCK_SIZE);
        buffer = buffer.subarray(TAR_BLOCK_SIZE);
        if (header.every((value) => value === 0)) {
          zeroBlocks += 1;
          if (zeroBlocks === 2) ended = true;
          continue;
        }
        if (zeroBlocks !== 0) throw new Error('Runtime tar has an incomplete end marker');

        const entry = parseTarHeader(header);
        const directoryPath = entry.path.endsWith('/') ? entry.path.slice(0, -1) : entry.path;
        const safePath = validateArtifactPath(
          entry.type === '5' ? directoryPath : entry.path,
          `tar entry ${JSON.stringify(entry.path)}`
        );
        if (entry.type === '5') {
          if (entry.size !== 0) throw new Error(`Runtime tar directory has data: ${safePath}`);
          if (!allowedDirectory(safePath, expectedPaths)) {
            throw new Error(`Runtime tar contains an unknown directory: ${safePath}`);
          }
          await fs.promises.mkdir(path.join(destination, ...safePath.split('/')), { recursive: true });
          continue;
        }
        if (entry.type !== '0') {
          throw new Error(`Runtime tar entry type is not allowed: ${entry.type} (${safePath})`);
        }
        const file = expected.get(safePath);
        if (!file) throw new Error(`Runtime tar contains an unknown file: ${safePath}`);
        if (seen.has(safePath)) throw new Error(`Runtime tar contains a duplicate file: ${safePath}`);
        if (entry.size !== file.size) throw new Error(`Runtime tar file size mismatch: ${safePath}`);
        seen.add(safePath);
        const absolute = path.join(destination, ...safePath.split('/'));
        await fs.promises.mkdir(path.dirname(absolute), { recursive: true });
        const handle = await fs.promises.open(absolute, 'wx', file.executable ? 0o755 : 0o644);
        current = {
          handle,
          closed: false,
          remaining: entry.size,
          padding: (TAR_BLOCK_SIZE - (entry.size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE,
        };
      }
    }
  } finally {
    if (current && !current.closed) await current.handle.close().catch(() => {});
  }

  if (current || !ended || buffer.length !== 0) {
    throw new Error('Runtime tar ended before a complete two-block end marker');
  }
  const missing = expectedPaths.filter((file) => !seen.has(file));
  if (missing.length > 0) throw new Error(`Runtime tar is missing files: ${missing.join(',')}`);
}

module.exports = { extractRuntimeTarGz };
