'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CHANNEL,
  VERSION,
  ThreadAttachmentCoordinator,
  formatFileAttachment,
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
