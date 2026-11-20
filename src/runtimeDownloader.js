'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

const { sha256File } = require('./runtimeArtifact');

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function abortError() {
  const error = new Error('Runtime download cancelled');
  error.name = 'AbortError';
  return error;
}

function defaultOpenResponse(url, signal, redirects = 3) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { signal, headers: { 'user-agent': 'dsh-vs-sidebar-runtime' } }, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.destroy();
        if (redirects === 0) return reject(new Error('Runtime download exceeded redirect limit'));
        const redirected = URL.parse(response.headers.location, url);
        if (redirected?.protocol !== 'https:') {
          return reject(new Error('Runtime download redirect must use HTTPS'));
        }
        defaultOpenResponse(redirected, signal, redirects - 1).then(resolve, reject);
        return;
      }
      resolve({ statusCode: status, headers: response.headers, body: response });
    });
    request.setTimeout(30_000, () => request.destroy(new Error('Runtime download stalled')));
    request.on('error', reject);
  });
}

class RuntimeDownloader {
  /**
   * @param {object} options
   * @param {string} options.storageRoot
   * @param {number} [options.maxBytes]
   * @param {Function} [options.openResponse]
   */
  constructor({ storageRoot, maxBytes = 1024 * 1024 * 1024, openResponse = defaultOpenResponse }) {
    if (!path.isAbsolute(storageRoot)) throw new Error('Runtime storageRoot must be absolute');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Runtime maxBytes must be positive');
    this.storageRoot = path.resolve(storageRoot);
    this.maxBytes = maxBytes;
    this.openResponse = openResponse;
  }

  /** Download one immutable archive, enforcing HTTPS, size, cancellation, and hash. */
  async download({ url, sha256, signal, onProgress = () => {} }) {
    const source = new URL(url);
    if (source.protocol !== 'https:') throw new Error('Runtime download URL must use HTTPS');
    const expected = String(sha256 || '').toLowerCase();
    if (!SHA256_PATTERN.test(expected)) throw new Error('Runtime download requires a SHA-256 digest');

    const downloads = path.join(this.storageRoot, 'downloads');
    const finalPath = path.join(downloads, `${expected}.tar.gz`);
    await fs.promises.mkdir(downloads, { recursive: true });
    if (await exists(finalPath)) {
      if (await sha256File(finalPath) !== expected) {
        throw new Error('Cached runtime download hash mismatch');
      }
      return finalPath;
    }

    const temporary = path.join(downloads, `.${expected}.${crypto.randomUUID()}.part`);
    let handle = null;
    let body;
    try {
      if (signal?.aborted) throw abortError();
      const response = await this.openResponse(source, signal);
      body = response.body;
      if (response.statusCode !== 200) {
        throw new Error(`Runtime download returned HTTP ${response.statusCode}`);
      }
      const declared = Number(response.headers?.['content-length']);
      if (Number.isFinite(declared) && declared > this.maxBytes) {
        throw new Error('Runtime download exceeds the configured size limit');
      }

      handle = await fs.promises.open(temporary, 'wx');
      const hash = crypto.createHash('sha256');
      let received = 0;
      for await (const chunk of body) {
        if (signal?.aborted) throw abortError();
        received += chunk.length;
        if (received > this.maxBytes) throw new Error('Runtime download exceeds the configured size limit');
        hash.update(chunk);
        await handle.write(chunk);
        onProgress({ receivedBytes: received, totalBytes: Number.isFinite(declared) ? declared : null });
      }
      await handle.close();
      handle = null;
      if (hash.digest('hex') !== expected) throw new Error('Runtime download hash mismatch');
      await fs.promises.rename(temporary, finalPath);
      return finalPath;
    } finally {
      body?.destroy?.();
      if (handle) await handle.close().catch(() => {});
      await fs.promises.rm(temporary, { force: true });
    }
  }
}

async function exists(filePath) {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

module.exports = { RuntimeDownloader, defaultOpenResponse };
