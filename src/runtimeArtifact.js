'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RUNTIME_MANIFEST_SCHEMA_VERSION = 1;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PLATFORM_VALUES = new Set(['win32', 'linux', 'darwin']);
const ARCH_VALUES = new Set(['x64', 'arm64']);

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Runtime manifest field ${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Validate a path stored in a runtime manifest.
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function validateArtifactPath(value, field) {
  const candidate = requireString(value, field).replace(/\\/g, '/');
  if (
    candidate.includes('\0')
    || candidate.startsWith('/')
    || /^[A-Za-z]:/.test(candidate)
    || candidate.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`Runtime manifest field ${field} must be a safe relative path`);
  }
  return candidate;
}

function requireSha256(value, field) {
  const candidate = requireString(value, field).toLowerCase();
  if (!SHA256_PATTERN.test(candidate)) {
    throw new Error(`Runtime manifest field ${field} must be a lowercase SHA-256 digest`);
  }
  return candidate;
}

/**
 * Canonical hash of the unpacked file manifest.
 * @param {ReadonlyArray<object>} files
 * @returns {string}
 */
function hashFileManifest(files) {
  const canonical = files
    .map((file) => `${file.path}\0${file.sha256}\0${file.size}\0${file.executable ? '1' : '0'}\n`)
    .sort()
    .join('');
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Parse and normalize a RuntimeArtifactManifest.
 * @param {unknown} input
 * @returns {object}
 */
function parseRuntimeArtifactManifest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Runtime manifest must be a JSON object');
  }
  if (input.schemaVersion !== RUNTIME_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Unsupported runtime manifest schemaVersion: ${String(input.schemaVersion)}`);
  }
  if (!Number.isInteger(input.bridgeProtocolVersion) || input.bridgeProtocolVersion < 1) {
    throw new Error('Runtime manifest bridgeProtocolVersion must be a positive integer');
  }
  if (!PLATFORM_VALUES.has(input.platform)) {
    throw new Error(`Unsupported runtime platform: ${String(input.platform)}`);
  }
  if (!ARCH_VALUES.has(input.arch)) {
    throw new Error(`Unsupported runtime architecture: ${String(input.arch)}`);
  }
  const builtAt = requireString(input.builtAt, 'builtAt');
  if (!Number.isFinite(Date.parse(builtAt))) {
    throw new Error('Runtime manifest builtAt must be an ISO timestamp');
  }
  const sourceCommit = requireString(input.sourceCommit, 'sourceCommit').toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) {
    throw new Error('Runtime manifest sourceCommit must be a 40-character Git commit');
  }
  if (!Array.isArray(input.files) || input.files.length === 0) {
    throw new Error('Runtime manifest files must be a non-empty array');
  }

  const seen = new Set();
  const files = input.files.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Runtime manifest files[${index}] must be an object`);
    }
    const filePath = validateArtifactPath(entry.path, `files[${index}].path`);
    if (seen.has(filePath)) throw new Error(`Runtime manifest contains duplicate file path: ${filePath}`);
    seen.add(filePath);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new Error(`Runtime manifest files[${index}].size must be a non-negative integer`);
    }
    if (typeof entry.executable !== 'boolean') {
      throw new Error(`Runtime manifest files[${index}].executable must be boolean`);
    }
    return Object.freeze({
      path: filePath,
      sha256: requireSha256(entry.sha256, `files[${index}].sha256`),
      size: entry.size,
      executable: entry.executable,
    });
  });

  const entrypoint = validateArtifactPath(input.entrypoint, 'entrypoint');
  if (!seen.has(entrypoint)) throw new Error('Runtime manifest entrypoint must be listed in files');
  const entryScript = input.entryScript === undefined || input.entryScript === null
    ? null
    : validateArtifactPath(input.entryScript, 'entryScript');
  if (entryScript !== null && !seen.has(entryScript)) {
    throw new Error('Runtime manifest entryScript must be listed in files');
  }
  if (!Array.isArray(input.licenseFiles) || input.licenseFiles.length === 0) {
    throw new Error('Runtime manifest licenseFiles must be a non-empty array');
  }
  const licenseFiles = input.licenseFiles.map((value, index) => {
    const licensePath = validateArtifactPath(value, `licenseFiles[${index}]`);
    if (!seen.has(licensePath)) {
      throw new Error(`Runtime license file is not listed in files: ${licensePath}`);
    }
    return licensePath;
  });
  const unpackedSha256 = requireSha256(input.unpackedSha256, 'unpackedSha256');
  if (hashFileManifest(files) !== unpackedSha256) {
    throw new Error('Runtime manifest unpackedSha256 does not match its canonical file list');
  }

  return Object.freeze({
    schemaVersion: RUNTIME_MANIFEST_SCHEMA_VERSION,
    dshVersion: requireString(input.dshVersion, 'dshVersion'),
    bridgeProtocolVersion: input.bridgeProtocolVersion,
    nodeVersion: requireString(input.nodeVersion, 'nodeVersion'),
    platform: input.platform,
    arch: input.arch,
    archiveSha256: requireSha256(input.archiveSha256, 'archiveSha256'),
    unpackedSha256,
    sourceCommit,
    licenseFiles: Object.freeze(licenseFiles),
    builtAt,
    entrypoint,
    entryScript,
    files: Object.freeze(files),
  });
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

async function listRuntimeFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Runtime contains a symbolic link: ${absolute}`);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join('/'));
      else throw new Error(`Runtime contains an unsupported filesystem entry: ${absolute}`);
    }
  }
  await visit(root);
  return files.sort();
}

/**
 * Verify an unpacked runtime directory against its manifest.
 * @param {string} root
 * @param {object} manifest
 */
async function verifyRuntimeDirectory(root, manifest) {
  const expected = manifest.files.map((file) => file.path).sort();
  const actual = await listRuntimeFiles(root);
  assertSameFiles(actual, expected);
  for (const file of manifest.files) {
    const absolute = path.resolve(root, ...file.path.split('/'));
    const relative = path.relative(path.resolve(root), absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Runtime file escapes its root: ${file.path}`);
    }
    const stat = await fs.promises.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Runtime entry is not a regular file: ${file.path}`);
    }
    if (process.platform !== 'win32') {
      const isExecutable = (stat.mode & 0o111) !== 0;
      if (isExecutable !== file.executable) {
        throw new Error(`Runtime executable mode mismatch: ${file.path}`);
      }
    }
    if (stat.size !== file.size) throw new Error(`Runtime file size mismatch: ${file.path}`);
    if (await sha256File(absolute) !== file.sha256) {
      throw new Error(`Runtime file hash mismatch: ${file.path}`);
    }
  }
}

function assertSameFiles(actual, expected) {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    const extras = actual.filter((value) => !expected.includes(value));
    const missing = expected.filter((value) => !actual.includes(value));
    throw new Error(`Runtime file list mismatch; extra=[${extras.join(',')}], missing=[${missing.join(',')}]`);
  }
}

module.exports = {
  RUNTIME_MANIFEST_SCHEMA_VERSION,
  hashFileManifest,
  parseRuntimeArtifactManifest,
  sha256File,
  validateArtifactPath,
  verifyRuntimeDirectory,
};
