'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');

const { RuntimeDownloader } = require('../src/runtimeDownloader');

function digest(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function response(chunks, headers = {}) {
  return {
    statusCode: 200,
    headers,
    body: Readable.from(chunks.map((chunk) => Buffer.from(chunk))),
  };
}

test('RuntimeDownloader writes one verified immutable archive', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-download-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const content = 'runtime-archive';
  const progress = [];
  let requests = 0;
  const downloader = new RuntimeDownloader({
    storageRoot,
    openResponse: async () => {
      requests += 1;
      return response(['runtime-', 'archive'], { 'content-length': String(content.length) });
    },
  });
  const archivePath = await downloader.download({
    url: 'https://downloads.example/runtime.tar.gz',
    sha256: digest(content),
    onProgress: (event) => progress.push(event),
  });
  assert.strictEqual(fs.readFileSync(archivePath, 'utf8'), content);
  assert.strictEqual(progress.at(-1).receivedBytes, content.length);
  assert.strictEqual(await downloader.download({
    url: 'https://downloads.example/runtime.tar.gz',
    sha256: digest(content),
  }), archivePath);
  assert.strictEqual(requests, 1, 'a verified cached archive must not be downloaded again');
});

test('RuntimeDownloader cleans partial files on hash, size, and cancellation failures', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-download-fail-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const downloads = path.join(storageRoot, 'downloads');

  const wrongHash = new RuntimeDownloader({
    storageRoot,
    openResponse: async () => response(['wrong']),
  });
  await assert.rejects(wrongHash.download({
    url: 'https://downloads.example/runtime.tar.gz',
    sha256: digest('expected'),
  }), /hash mismatch/);

  const oversized = new RuntimeDownloader({
    storageRoot,
    maxBytes: 3,
    openResponse: async () => response(['four']),
  });
  await assert.rejects(oversized.download({
    url: 'https://downloads.example/runtime.tar.gz',
    sha256: digest('four'),
  }), /size limit/);

  const controller = new AbortController();
  const cancelled = new RuntimeDownloader({
    storageRoot,
    openResponse: async () => response(['first', 'second']),
  });
  await assert.rejects(cancelled.download({
    url: 'https://downloads.example/runtime.tar.gz',
    sha256: digest('firstsecond'),
    signal: controller.signal,
    onProgress: () => controller.abort(),
  }), { name: 'AbortError' });

  assert.deepStrictEqual(
    fs.existsSync(downloads) ? fs.readdirSync(downloads) : [],
    [],
    'failed downloads must leave no partial or final archive'
  );
});

test('RuntimeDownloader rejects non-HTTPS sources before transport', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-download-url-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const downloader = new RuntimeDownloader({
    storageRoot,
    openResponse: async () => { throw new Error('transport must not run'); },
  });
  await assert.rejects(downloader.download({
    url: 'http://downloads.example/runtime.tar.gz',
    sha256: 'a'.repeat(64),
  }), /must use HTTPS/);
});
