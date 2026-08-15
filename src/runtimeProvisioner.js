'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { parseRuntimeArtifactManifest } = require('./runtimeArtifact');
const { RuntimeDownloader, defaultOpenResponse } = require('./runtimeDownloader');
const { RuntimeInstaller } = require('./runtimeInstaller');
const { RuntimeResolver } = require('./runtimeResolver');
const { ServerError } = require('./serverManager');

const RUNTIME_RELEASE_SCHEMA_VERSION = 1;
const MAX_RELEASE_MANIFEST_BYTES = 1024 * 1024;
const PLATFORM_VALUES = new Set(['win32', 'linux', 'darwin']);
const ARCH_VALUES = new Set(['x64', 'arm64']);

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function requireHttpsUrl(value, field) {
  const candidate = requireString(value, field);
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`${field} must be an HTTPS URL`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`${field} must be an HTTPS URL`);
  return parsed.toString();
}

/**
 * Parse and normalize a runtime release manifest:
 *   { schemaVersion: 1, artifacts: [{ platform, arch, url, manifest }] }
 * Each artifact embeds a full RuntimeArtifactManifest and a download URL.
 */
function parseRuntimeReleaseManifest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Runtime release manifest must be a JSON object');
  }
  if (input.schemaVersion !== RUNTIME_RELEASE_SCHEMA_VERSION) {
    throw new Error(`Unsupported runtime release manifest schemaVersion: ${String(input.schemaVersion)}`);
  }
  if (!Array.isArray(input.artifacts) || input.artifacts.length === 0) {
    throw new Error('Runtime release manifest artifacts must be a non-empty array');
  }

  const seen = new Set();
  const artifacts = input.artifacts.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Runtime release manifest artifacts[${index}] must be an object`);
    }
    const platform = requireString(entry.platform, `artifacts[${index}].platform`);
    const arch = requireString(entry.arch, `artifacts[${index}].arch`);
    if (!PLATFORM_VALUES.has(platform)) {
      throw new Error(`Runtime release manifest artifacts[${index}] has unsupported platform: ${platform}`);
    }
    if (!ARCH_VALUES.has(arch)) {
      throw new Error(`Runtime release manifest artifacts[${index}] has unsupported arch: ${arch}`);
    }
    const url = requireHttpsUrl(entry.url, `artifacts[${index}].url`);
    const manifest = parseRuntimeArtifactManifest(entry.manifest);
    if (manifest.platform !== platform || manifest.arch !== arch) {
      throw new Error(`Runtime release manifest artifacts[${index}] platform/arch does not match its runtime manifest`);
    }
    const key = `${platform}-${arch}-${manifest.dshVersion}`;
    if (seen.has(key)) {
      throw new Error(`Runtime release manifest contains duplicate artifact: ${key}`);
    }
    seen.add(key);
    return Object.freeze({ platform, arch, url, manifest });
  });

  return Object.freeze({
    schemaVersion: RUNTIME_RELEASE_SCHEMA_VERSION,
    artifacts: Object.freeze(artifacts),
  });
}

/**
 * Select the runtime artifact for the current platform/arch and optional
 * version pin. The newest builtAt wins when several match and no version is
 * pinned; the release manifest order remains the tie-breaker.
 */
function selectRuntimeArtifact(release, { platform = process.platform, arch = process.arch, version = '' } = {}) {
  const pinnedVersion = String(version || '').trim();
  const candidates = release.artifacts.filter((artifact) => (
    artifact.platform === platform
    && artifact.arch === arch
    && (pinnedVersion === '' || artifact.manifest.dshVersion === pinnedVersion)
  ));

  if (candidates.length === 0) {
    if (pinnedVersion !== '') {
      throw new ServerError(
        'No managed DSH runtime artifact matches version {version} for {platform}-{arch}',
        { version: pinnedVersion, platform, arch }
      );
    }
    throw new ServerError(
      'No managed DSH runtime artifact matches {platform}-{arch}',
      { platform, arch }
    );
  }

  candidates.sort((a, b) => (
    Date.parse(b.manifest.builtAt) - Date.parse(a.manifest.builtAt)
  ));
  return candidates[0];
}

async function exists(filePath) {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readResponseBody(stream, maxBytes) {
  const chunks = [];
  let received = 0;
  for await (const chunk of stream) {
    received += chunk.length;
    if (received > maxBytes) {
      throw new Error(`Runtime release manifest exceeds ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Download and parse a runtime release manifest from an HTTPS URL.
 * Reuses the downloader's openResponse seam for HTTPS-only, redirect-limit,
 * cancellation, and user-agent behavior.
 */
async function fetchRuntimeReleaseManifest(manifestUrl, { signal, openResponse = defaultOpenResponse } = {}) {
  let source;
  try {
    source = new URL(manifestUrl);
  } catch {
    throw new ServerError('dsh.runtime.manifestUrl must be an HTTPS URL');
  }
  if (source.protocol !== 'https:') {
    throw new ServerError('dsh.runtime.manifestUrl must be an HTTPS URL');
  }
  const response = await openResponse(source, signal);
  if (response.statusCode !== 200) {
    response.body?.resume?.();
    throw new ServerError('Runtime manifest download returned HTTP {status}', {
      status: String(response.statusCode),
    });
  }
  let text;
  try {
    text = await readResponseBody(response.body, MAX_RELEASE_MANIFEST_BYTES);
  } catch (error) {
    throw new ServerError('Runtime release manifest is invalid: {reason}', {
      reason: error.message,
    });
  }
  try {
    return parseRuntimeReleaseManifest(JSON.parse(text));
  } catch (error) {
    throw new ServerError('Runtime release manifest is invalid: {reason}', {
      reason: error.message,
    });
  }
}

/**
 * Ensure a fully verified managed runtime exists for the current platform.
 *
 *  - Always resolves through RuntimeResolver (pointer + manifest + payload
 *    hash verification). Never falls back to a `dsh` executable on PATH.
 *  - With no `dsh.runtime.manifestUrl`, a missing runtime is a readable
 *    ServerError; an installed-but-corrupt runtime also fails closed.
 *  - With a manifest URL, a missing runtime (or a version pin that does not
 *    match the installed current) is provisioned through RuntimeDownloader +
 *    RuntimeInstaller and then re-resolved through RuntimeResolver.
 */
async function ensureManagedRuntime({
  storageRoot,
  platform = process.platform,
  arch = process.arch,
  manifestUrl = '',
  version = '',
  signal,
  onProgress = () => {},
  openResponse = defaultOpenResponse,
} = {}) {
  const resolver = new RuntimeResolver({ storageRoot, platform, arch });
  const trimmedManifestUrl = String(manifestUrl || '').trim();
  const trimmedVersion = String(version || '').trim();

  let currentError = null;
  let current = null;
  try {
    current = await resolver.resolveCurrent();
  } catch (error) {
    currentError = error;
  }

  if (current) {
    if (trimmedVersion === '' || current.manifest.dshVersion === trimmedVersion) {
      return current;
    }
    if (trimmedManifestUrl === '') {
      throw new ServerError(
        'Managed DSH runtime {version} is not installed; set dsh.runtime.manifestUrl to provision it',
        { version: trimmedVersion }
      );
    }
  } else {
    const pointerMissing = !(await exists(path.join(storageRoot, 'state', 'current.json')));
    if (trimmedManifestUrl === '') {
      if (pointerMissing) {
        throw new ServerError(
          'Managed DSH runtime is not installed; set dsh.runtime.manifestUrl to provision it'
        );
      }
      throw new ServerError('Managed DSH runtime could not be verified: {reason}', {
        reason: currentError.message,
      });
    }
    if (!pointerMissing) {
      throw new ServerError('Managed DSH runtime could not be verified: {reason}', {
        reason: currentError.message,
      });
    }
  }

  const release = await fetchRuntimeReleaseManifest(trimmedManifestUrl, { signal, openResponse });
  const artifact = selectRuntimeArtifact(release, {
    platform,
    arch,
    version: trimmedVersion,
  });
  const installer = new RuntimeInstaller({ storageRoot, platform, arch });
  const downloader = new RuntimeDownloader({ storageRoot });
  const archivePath = await downloader.download({
    url: artifact.url,
    sha256: artifact.manifest.archiveSha256,
    signal,
    onProgress,
  });
  const candidate = await installer.installFromArchive({
    manifest: artifact.manifest,
    archivePath,
    signal,
  });
  await installer.promote(candidate);
  return resolver.resolveCurrent();
}

module.exports = {
  RUNTIME_RELEASE_SCHEMA_VERSION,
  MAX_RELEASE_MANIFEST_BYTES,
  ensureManagedRuntime,
  fetchRuntimeReleaseManifest,
  parseRuntimeReleaseManifest,
  selectRuntimeArtifact,
};
