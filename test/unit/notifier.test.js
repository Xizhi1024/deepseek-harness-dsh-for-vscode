'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createNotifier } = require('../../src/ch1/notifier');

function collect() {
  const calls = [];
  return {
    calls,
    send(method, params) {
      calls.push({ method, params });
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('notifier coalesces rapid same method+uri pushes into one send', async () => {
  const sink = collect();
  const notifier = createNotifier({ send: sink.send, windowMs: 30, maxPending: 64 });
  const params = { uri: 'file:///a.ts', version: 1, attachmentIds: ['ctx-1'] };
  for (let i = 0; i < 20; i += 1) {
    notifier.push('vscode/editor/selectionChanged', { ...params, version: i });
  }
  await sleep(60);
  assert.strictEqual(sink.calls.length, 1);
  assert.strictEqual(sink.calls[0].method, 'vscode/editor/selectionChanged');
  assert.strictEqual(sink.calls[0].params.version, 19, 'last push wins');
  notifier.dispose();
});

test('notifier keeps different uri buckets and flushes them all', () => {
  const sink = collect();
  const notifier = createNotifier({ send: sink.send, windowMs: 1000, maxPending: 64 });
  notifier.push('vscode/editor/selectionChanged', { uri: 'file:///a.ts', attachmentIds: ['a'] });
  notifier.push('vscode/editor/selectionChanged', { uri: 'file:///b.ts', attachmentIds: ['b'] });
  notifier.flush();
  assert.strictEqual(sink.calls.length, 2);
  assert.deepStrictEqual(sink.calls.map((call) => call.params.uri), [
    'file:///a.ts',
    'file:///b.ts',
  ]);
  notifier.dispose();
});

test('notifier flush is idempotent', () => {
  const sink = collect();
  const notifier = createNotifier({ send: sink.send, windowMs: 1000, maxPending: 64 });
  notifier.push('vscode/editor/selectionChanged', { uri: 'file:///a.ts' });
  notifier.flush();
  notifier.flush();
  notifier.flush();
  assert.strictEqual(sink.calls.length, 1);
  notifier.dispose();
});

test('notifier flushes immediately when maxPending distinct buckets are reached', () => {
  const sink = collect();
  const notifier = createNotifier({ send: sink.send, windowMs: 1000, maxPending: 2 });
  notifier.push('vscode/editor/selectionChanged', { uri: 'file:///a.ts' });
  notifier.push('vscode/editor/selectionChanged', { uri: 'file:///b.ts' });
  assert.strictEqual(sink.calls.length, 2, 'maxPending must trigger an immediate flush');
  assert.strictEqual(notifier.pendingCount, 0);
  notifier.dispose();
});

test('notifier swallows send failures and exposes the failure count', () => {
  const notifier = createNotifier({
    windowMs: 1000,
    send() {
      throw new Error('send failed');
    },
  });
  notifier.push('vscode/editor/selectionChanged', { uri: 'file:///a.ts' });
  notifier.flush();
  assert.strictEqual(notifier.stats.sendFailures, 1);
  assert.strictEqual(notifier.stats.flushCount, 1);
  notifier.dispose();
});

test('notifier dispose clears pending without sending', () => {
  const sink = collect();
  const notifier = createNotifier({ send: sink.send, windowMs: 1000, maxPending: 64 });
  notifier.push('vscode/editor/selectionChanged', { uri: 'file:///a.ts' });
  notifier.dispose();
  notifier.flush();
  assert.strictEqual(sink.calls.length, 0);
  assert.strictEqual(notifier.pendingCount, 0);
});
