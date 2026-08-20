'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CHANNEL,
  VERSION,
  DEFAULT_MAX_FOLDER_DEPTH,
  DEFAULT_MAX_FOLDER_ENTRIES,
  ThreadAttachmentCoordinator,
  buildFolderListing,
  formatFileAttachment,
  formatFolderAttachment,
  formatFolderListing,
  formatSelectionAttachment,
  parseThreadResult,
} = require('../src/threadAttachment');

test('selection attachment becomes a compact clickable Markdown reference', () => {
  const text = formatSelectionAttachment({
    id: 'ctx-7',
    kind: 'selection',
    document: { languageId: 'javascript' },
    range: { start: { line: 4 }, end: { line: 7 } },
    content: 'const value = `safe`;',
  }, 'file:///D:/work/app.js');
  assert.strictEqual(text, '[app.js:5-8](https://dsh-vscode.invalid/attachment/ctx-7)');
  assert.doesNotMatch(text, /const value/);
});

test('file-kind attachment from attachFiles formats like an active-file link', () => {
  const text = formatFileAttachment({
    id: 'ctx-12',
    kind: 'file',
    document: { languageId: 'plaintext' },
    content: 'multi-pick file body',
  }, 'file:///D:/work/notes.txt');
  assert.strictEqual(text, '[notes.txt](https://dsh-vscode.invalid/attachment/ctx-12)');
  assert.doesNotMatch(text, /multi-pick file body/);
});

test('file attachment becomes a compact clickable Markdown reference without a line range', () => {
  const text = formatFileAttachment({
    id: 'ctx-7',
    kind: 'active-file',
    document: { languageId: 'javascript' },
    content: 'full file text',
  }, 'file:///D:/work/app.js');
  assert.strictEqual(text, '[app.js](https://dsh-vscode.invalid/attachment/ctx-7)');
  assert.doesNotMatch(text, /full file text/);
});

test('file attachment formatter rejects non-active-file attachments', () => {
  assert.throws(
    () => formatFileAttachment({ id: 'ctx-1', kind: 'selection', content: 'x' }, 'file:///a.js'),
    TypeError
  );
  assert.throws(
    () => formatFileAttachment({ id: 'ctx-1', kind: 'active-file' }, 'file:///a.js'),
    TypeError
  );
  assert.throws(
    () => formatFileAttachment({ id: 'bad', kind: 'active-file', content: 'x' }, 'file:///a.js'),
    TypeError
  );
});

test('thread coordinator posts one versioned request and resolves its acknowledgement', async () => {
  const sent = [];
  const coordinator = new ThreadAttachmentCoordinator({ timeoutMs: 1000 });
  const pending = coordinator.request({
    async postMessage(message) { sent.push(message); return true; },
  }, 'selected code');
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].channel, CHANNEL);
  assert.strictEqual(sent[0].version, VERSION);
  assert.strictEqual(coordinator.handleResult({
    type: 'dshThreadAttachResult', channel: CHANNEL, version: VERSION,
    requestId: sent[0].requestId, ok: true,
  }), true);
  await pending;
  coordinator.dispose();
});

test('thread result parser rejects malformed messages', () => {
  assert.strictEqual(parseThreadResult({ type: 'dshThreadAttachResult', requestId: 'x', ok: true }), null);
  assert.deepStrictEqual(parseThreadResult({
    type: 'dshThreadAttachResult', channel: CHANNEL, version: VERSION,
    requestId: 'request_1', ok: false, error: 'no session',
  }), { requestId: 'request_1', ok: false, error: 'no session' });
});

test('folder attachment becomes a compact clickable Markdown reference', () => {
  const text = formatFolderAttachment({
    id: 'ctx-9',
    kind: 'folder',
    document: { uri: 'file:///D:/work/src' },
    content: 'folder: 1 entry (depth <= 2)\napp.js',
  }, 'file:///D:/work/src');
  assert.strictEqual(text, '[src](https://dsh-vscode.invalid/attachment/ctx-9)');
});

test('folder attachment formatter rejects non-folder attachments', () => {
  assert.throws(
    () => formatFolderAttachment({ id: 'ctx-1', kind: 'selection', content: 'x' }, 'file:///a'),
    TypeError
  );
  assert.throws(
    () => formatFolderAttachment({ id: 'ctx-1', kind: 'folder' }, 'file:///a'),
    TypeError
  );
  assert.throws(
    () => formatFolderAttachment({ id: 'bad', kind: 'folder', content: 'x' }, 'file:///a'),
    TypeError
  );
});

test('folder listing defaults bound depth to 2 and entries to 500', () => {
  assert.strictEqual(DEFAULT_MAX_FOLDER_DEPTH, 2);
  assert.strictEqual(DEFAULT_MAX_FOLDER_ENTRIES, 500);
});

test('buildFolderListing lists relative paths bounded by depth and skips vcs/hidden entries', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-listing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'lib', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, '.cache'));
  fs.writeFileSync(path.join(root, 'a.ts'), 'a');
  fs.writeFileSync(path.join(root, 'b.ts'), 'b');
  fs.writeFileSync(path.join(root, 'lib', 'c.ts'), 'c');
  fs.writeFileSync(path.join(root, 'lib', 'deep', 'd.ts'), 'd');
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'x');
  fs.writeFileSync(path.join(root, '.env'), 'SECRET');

  const listing = buildFolderListing(root);

  assert.strictEqual(listing.rootIsDirectory, true);
  assert.strictEqual(listing.truncated, false);
  assert.deepStrictEqual(listing.entries, [
    { relPath: 'lib', kind: 'dir' },
    { relPath: 'lib/deep', kind: 'dir' },
    { relPath: 'a.ts', kind: 'file' },
    { relPath: 'b.ts', kind: 'file' },
    { relPath: 'lib/c.ts', kind: 'file' },
  ]);
  // The deep grandchild (depth 3) and every skipped entry stay out of the list.
  assert.ok(listing.entries.every((entry) => !/node_modules|\.git|\.cache|\.env|d\.ts/.test(entry.relPath)));
});

test('formatFolderListing renders a header plus flat relative paths', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-listing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'a.ts'), 'a');
  fs.mkdirSync(path.join(root, 'lib'));
  fs.writeFileSync(path.join(root, 'lib', 'b.ts'), 'b');

  const text = formatFolderListing(buildFolderListing(root));
  assert.strictEqual(text, 'folder: 3 entries (depth <= 2)\nlib/\na.ts\nlib/b.ts');
});

test('buildFolderListing truncates at maxEntries', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-listing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (let i = 0; i < 6; i += 1) fs.writeFileSync(path.join(root, `f${i}.ts`), 'x');

  const truncated = buildFolderListing(root, { maxEntries: 3 });
  assert.strictEqual(truncated.entries.length, 3);
  assert.strictEqual(truncated.truncated, true);
  assert.match(formatFolderListing(truncated), new RegExp('depth <= 2, truncated'));
});

test('buildFolderListing reports a non-directory root', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-listing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'plain.ts');
  fs.writeFileSync(file, 'x');

  const listing = buildFolderListing(file);
  assert.strictEqual(listing.rootIsDirectory, false);
  assert.deepStrictEqual(listing.entries, []);
});

test('buildFolderListing survives an unreadable subdirectory through an injected fs facade', () => {
  const stat = (isDirectory) => ({ isDirectory() { return isDirectory; } });
  const ROOT = path.join('ws', 'src');
  const fsApi = {
    readdirSync(fsPath) {
      if (fsPath === ROOT) return ['a.ts', 'x'];
      throw new Error('EACCES'); // the x subdirectory itself is unreadable
    },
    statSync(fsPath) {
      if (fsPath === ROOT) return stat(true);
      return fsPath.endsWith('x') ? stat(true) : stat(false);
    },
  };

  const listing = buildFolderListing(ROOT, { fsApi, depth: 2, maxEntries: 10 });
  // x is listed as a directory but its unreadable contents are skipped.
  assert.deepStrictEqual(listing.entries, [
    { relPath: 'x', kind: 'dir' },
    { relPath: 'a.ts', kind: 'file' },
  ]);
});
