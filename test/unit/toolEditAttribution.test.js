'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeToolEditPath } = require('../../src/changeTracker');
const { sameFsPath } = require('../../src/changeWatcher');

// 2026-09-04 incident follow-up: DSH tool arguments carry session-cwd-relative
// paths while the journal/watcher/diff/undo key on absolute host paths; the
// shape mismatch double-journaled every agent edit (tool-intercept relative +
// external absolute) and broke dedup, openDiff and undo targets.

test('normalizeToolEditPath resolves a relative path against the root where it exists', () => {
  const rootA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-na-')));
  const rootB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-nb-')));
  const file = path.join(rootB, 'src', 'hello.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x', 'utf8');
  const result = normalizeToolEditPath(
    { tool: 'edit', path: 'src/hello.js', sessionId: 's-1' },
    [rootA, rootB]
  );
  assert.strictEqual(result.path, file);
  assert.strictEqual(result.sessionId, 's-1'); // other fields preserved
});

test('normalizeToolEditPath falls back to the first root when nothing exists', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-nc-')));
  const result = normalizeToolEditPath({ tool: 'write', path: 'gone.js' }, [root]);
  assert.strictEqual(result.path, path.resolve(root, 'gone.js'));
});

test('normalizeToolEditPath is a no-op for absolute, file:// and missing paths', () => {
  const payload = { tool: 'edit', path: 'C:\\ws\\abs.js' };
  assert.strictEqual(normalizeToolEditPath(payload, ['C:\\other']), payload);
  const uriPayload = { tool: 'edit', path: 'file:///C:/ws/a.js' };
  assert.strictEqual(normalizeToolEditPath(uriPayload, ['C:\\other']), uriPayload);
  assert.deepStrictEqual(normalizeToolEditPath({ tool: 'edit' }, ['C:\\ws']), { tool: 'edit' });
  assert.deepStrictEqual(normalizeToolEditPath({ tool: 'edit', path: 'rel.js' }, []), { tool: 'edit', path: 'rel.js' });
});

test('sameFsPath matches across case, separators and relative shapes (win32)', () => {
  assert.equal(sameFsPath('D:\\Coding\\DSH\\repo\\a.js', 'd:/coding/dsh/repo/a.js', 'win32'), true);
  assert.equal(sameFsPath('repo\\a.js', 'D:\\ws\\repo\\a.js', 'win32'), false);
  assert.equal(sameFsPath('d:\\x\\y.js', 'd:\\x\\z.js', 'win32'), false);
  assert.equal(sameFsPath('', 'd:\\x', 'win32'), false);
  assert.equal(sameFsPath('/tmp/a.js', '/TMP/A.JS', 'linux'), false); // POSIX is case-sensitive
  assert.equal(sameFsPath('d:\\x\\y.js', 'd:/x/y.js', 'win32'), true); // separator-insensitive
});
