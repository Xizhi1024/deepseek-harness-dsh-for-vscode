'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createNotifier } = require('../../src/ch1/notifier');

test('notifier push after dispose is a no-op, keeps counters and pending unchanged', () => {
  const calls = [];
  const notifier = createNotifier({
    windowMs: 1000,
    send(method, params) {
      calls.push({ method, params });
    },
  });

  notifier.push('vscode/editor/selectionChanged', { uri: 'file:///a.ts', version: 1, attachmentIds: [] });
  notifier.dispose();
  const before = notifier.stats;

  assert.doesNotThrow(() => {
    notifier.push('vscode/editor/selectionChanged', { uri: 'file:///b.ts', version: 2, attachmentIds: [] });
    notifier.flush();
  });
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(notifier.pendingCount, 0);
  assert.deepStrictEqual(notifier.stats, before);
  assert.deepStrictEqual(notifier.stats, {
    sent: 0,
    sendFailures: 0,
    flushCount: 0,
    dropped: 1,
  });
});

test('notifier same method+uri last write wins and flush clears the pending map', () => {
  const calls = [];
  const notifier = createNotifier({
    windowMs: 1000,
    send(method, params) {
      calls.push({ method, params });
    },
  });

  notifier.push('vscode/editor/selectionChanged', {
    uri: 'file:///a.ts',
    version: 1,
    attachmentIds: ['old-1'],
  });
  notifier.push('vscode/editor/selectionChanged', {
    uri: 'file:///a.ts',
    version: 2,
    attachmentIds: ['new-1', 'new-2'],
  });
  notifier.push('vscode/diagnosticsChanged', {
    uri: 'file:///a.ts',
    attachmentIds: ['old-2'],
  });
  notifier.push('vscode/diagnosticsChanged', {
    uri: 'file:///a.ts',
    attachmentIds: ['new-3'],
  });
  notifier.flush();

  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(calls.find((call) => call.method === 'vscode/editor/selectionChanged').params, {
    uri: 'file:///a.ts',
    version: 2,
    attachmentIds: ['new-1', 'new-2'],
  });
  assert.deepStrictEqual(calls.find((call) => call.method === 'vscode/diagnosticsChanged').params, {
    uri: 'file:///a.ts',
    attachmentIds: ['new-3'],
  });
  assert.strictEqual(notifier.pendingCount, 0);
  notifier.dispose();
});

test(
  'notifier rejects content-bearing v2 payloads via schema (QA finding B3-02)',
  () => {
    const notifier = createNotifier({ windowMs: 1000, send() {} });
    assert.throws(() => {
      notifier.push('vscode/editor/selectionChanged', {
        uri: 'file:///a.ts',
        version: 1,
        attachmentIds: ['ctx-1'],
        content: 'body should be rejected',
      });
    }, /schema|content/);
    notifier.dispose();
  }
);