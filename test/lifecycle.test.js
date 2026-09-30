'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { LifecycleQueue } = require('../src/lifecycle');

test('lifecycle work is serialized in enqueue order', async () => {
  const queue = new LifecycleQueue();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = queue.enqueue('first', async () => {
    events.push('first:start');
    await firstGate;
    events.push('first:end');
  });
  const second = queue.enqueue('second', () => events.push('second'));

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(events, ['first:start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepStrictEqual(events, ['first:start', 'first:end', 'second']);
});

test('a failed operation is reported without poisoning later work', async () => {
  const errors = [];
  const queue = new LifecycleQueue({ onError: (label, error) => errors.push({ label, error }) });
  const failure = queue.enqueue('broken', () => { throw new Error('boom'); });
  await assert.rejects(failure, /boom/);
  let completed = false;
  await queue.enqueue('next', () => { completed = true; });
  assert.strictEqual(completed, true);
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].label, 'broken');
});

test('shutdown skips queued and future work but waits for running work', async () => {
  const queue = new LifecycleQueue();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const events = [];
  const running = queue.enqueue('running', async () => {
    events.push('running');
    await gate;
  });
  const queued = queue.enqueue('queued', () => events.push('queued'));
  await new Promise((resolve) => setImmediate(resolve));
  queue.stopAccepting();
  assert.strictEqual(queue.stopped, true);
  await queue.enqueue('future', () => events.push('future'));
  release();
  await Promise.all([running, queued, queue.wait()]);
  assert.deepStrictEqual(events, ['running']);
});

test('latest work coalesces bursts and preserves a single successor during execution', async () => {
  const queue = new LifecycleQueue();
  const events = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let pending;
  for (let i = 0; i < 10000; i += 1) {
    const next = queue.enqueueLatest('rebind', async () => {
      events.push(i);
      await gate;
    });
    if (pending) assert.strictEqual(next, pending);
    pending = next;
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(events, [9999]);
  const ordinary = queue.enqueue('command', () => events.push('command'));
  let successor;
  for (let i = 10000; i < 20000; i += 1) {
    const next = queue.enqueueLatest('rebind', () => events.push(i));
    if (successor) assert.strictEqual(next, successor);
    successor = next;
  }
  assert.notStrictEqual(successor, pending);
  release();
  await Promise.all([pending, ordinary, successor]);
  assert.deepStrictEqual(events, [9999, 'command', 19999]);
});

test('latest work recovers after failure and skips queued successors during shutdown', async () => {
  const errors = [];
  const queue = new LifecycleQueue({ onError: (label) => errors.push(label) });
  await assert.rejects(queue.enqueueLatest('rebind', () => { throw new Error('failed'); }), /failed/);
  let completed = 0;
  await queue.enqueueLatest('rebind', () => completed++);
  const skipped = queue.enqueueLatest('rebind', () => completed++);
  queue.stopAccepting();
  await skipped;
  await queue.enqueueLatest('rebind', () => completed++);
  assert.strictEqual(completed, 1);
  assert.deepStrictEqual(errors, ['rebind']);
});
