'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createChangeWatcher } = require('../../src/changeWatcher');

/**
 * Manual timer harness: the debounce schedule and the breaker's git-poll
 * interval run only when the test fires them, so the rate-breaker state
 * machine is driven deterministically through nowMs + event injection.
 */
function manualTimers() {
  let seq = 0;
  const timeouts = new Map();
  const intervals = new Map();
  return {
    setTimeout(fn) { const id = ++seq; timeouts.set(id, fn); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval(fn) { const id = ++seq; intervals.set(id, fn); return id; },
    clearInterval(id) { intervals.delete(id); },
    runTimeouts() { const fns = [...timeouts.values()]; timeouts.clear(); for (const fn of fns) fn(); },
    timeoutCount: () => timeouts.size,
    intervalCount: () => intervals.size,
  };
}

function fakeVscodeWorkspace({ folders = ['/ws'] } = {}) {
  const uriOf = (p) => ({ scheme: 'file', fsPath: p, toString: () => 'file://' + p });
  const watchers = [];
  return {
    watchers,
    uriOf,
    workspace: {
      workspaceFolders: folders.map((f) => ({ uri: uriOf(f) })),
      getConfiguration: () => ({ get: () => ({}) }),
      createFileSystemWatcher() {
        const w = {
          disposed: false,
          handlers: { change: [], create: [], delete: [] },
          onDidChange(fn) { w.handlers.change.push(fn); },
          onDidCreate(fn) { w.handlers.create.push(fn); },
          onDidDelete(fn) { w.handlers.delete.push(fn); },
          dispose() { w.disposed = true; },
        };
        watchers.push(w);
        return w;
      },
    },
    extensions: {},
  };
}

/** Tracker double that records every batch call for storm assertions. */
function fakeTracker(existing = []) {
  const calls = { recordBatch: [], record: [], applyEntryPatches: [], updateEntry: [] };
  const journal = [...existing];
  let counter = 0;
  return {
    calls,
    journal,
    list: () => journal.map((entry) => JSON.parse(JSON.stringify(entry))),
    peekEntries: () => journal,
    async record(payload) {
      counter += 1;
      const entry = { id: 'chg-' + counter, at: new Date(1700000000000).toISOString(), ...payload };
      calls.record.push(payload);
      journal.push(entry);
      return entry;
    },
    async recordBatch(payloads) {
      calls.recordBatch.push([...payloads]);
      const created = payloads.map((payload) => {
        counter += 1;
        const entry = { id: 'chg-' + counter, at: new Date(1700000000000).toISOString(), ...payload };
        journal.push(entry);
        return entry;
      });
      return created;
    },
    applyEntryPatches(patches) {
      calls.applyEntryPatches.push([...patches]);
      for (const { id, patch } of patches) {
        const entry = journal.find((candidate) => candidate.id === id);
        if (entry) Object.assign(entry, patch);
      }
      return patches.length;
    },
    async updateEntry(id, patch) {
      calls.updateEntry.push({ id, patch });
      const entry = journal.find((candidate) => candidate.id === id);
      if (entry) Object.assign(entry, patch);
      return entry || null;
    },
  };
}

function fakeFsOps(files) {
  return {
    statSync: (p) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error('ENOENT');
      return { mtimeMs: 1700000000000, size: (files[p] || '').length };
    },
    readFileSync: (p) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error('ENOENT');
      return files[p];
    },
    writeFileSync: () => {},
    mkdirSync: () => {},
  };
}

function makeWatcher({ tracker, files = {}, nowMs = () => 1700000000000 } = {}) {
  const timers = manualTimers();
  const vscode = fakeVscodeWorkspace();
  const watcher = createChangeWatcher({
    vscode,
    tracker,
    storageUri: { fsPath: '/storage' },
    nowMs,
    timers,
    fsOps: fakeFsOps(files),
  });
  return { watcher, timers, vscode };
}

test('flush records a slice through recordBatch with ONE call and attaches snapshots in ONE patch write', async () => {
  const tracker = fakeTracker();
  const { watcher, timers, vscode } = makeWatcher({
    tracker,
    files: { '/ws/a.js': 'AAA', '/ws/b.js': 'BBB', '/ws/c.js': '' },
  });
  const w = vscode.watchers[0];
  for (const name of ['a.js', 'b.js', 'c.js']) w.handlers.change[0](vscode.uriOf('/ws/' + name));
  assert.strictEqual(timers.timeoutCount(), 1, 'one debounce timer armed');
  // Drive the flush through the public API so the async cycle settles here.
  await watcher.flush();

  assert.strictEqual(tracker.calls.recordBatch.length, 1, 'one recordBatch per slice');
  assert.strictEqual(tracker.calls.recordBatch[0].length, 3, 'all three files in the batch');
  // empty files produce no snapshot; the two with content share ONE patch write
  assert.strictEqual(tracker.calls.applyEntryPatches.length, 1);
  assert.strictEqual(tracker.calls.applyEntryPatches[0].length, 2);
  assert.strictEqual(tracker.calls.record.length, 0, 'single-record path untouched');
  watcher.dispose();
});

test('flush splits oversized batches into bounded slices (storm guard)', async () => {
  const tracker = fakeTracker();
  const files = {};
  const paths = [];
  for (let i = 0; i < 1200; i += 1) {
    const p = '/ws/f' + i + '.js';
    files[p] = '';
    paths.push(p);
  }
  const { watcher, vscode } = makeWatcher({ tracker, files });
  const w = vscode.watchers[0];
  for (const p of paths) w.handlers.change[0](vscode.uriOf(p));
  await watcher.flush();

  // 1200 pending paths -> ceil(1200/500) = 3 slices
  assert.strictEqual(tracker.calls.recordBatch.length, 3, 'one recordBatch per 500-file slice');
  for (const batch of tracker.calls.recordBatch) {
    assert.ok(batch.length <= 500, 'slice size bounded at 500');
  }
  assert.strictEqual(tracker.calls.recordBatch.reduce((n, b) => n + b.length, 0), 1200);
  watcher.dispose();
});

test('(path, mtime ±1s) dedup: entries already attributed are never re-recorded', async () => {
  const tracker = fakeTracker([{
    id: 'chg-1',
    source: 'tool-intercept',
    path: '/ws/a.js',
    at: new Date(1700000000000).toISOString(),
    status: 'accepted',
  }]);
  const { watcher, vscode } = makeWatcher({ tracker, files: { '/ws/a.js': 'AAA', '/ws/b.js': 'BBB' } });
  const w = vscode.watchers[0];
  w.handlers.change[0](vscode.uriOf('/ws/a.js'));
  w.handlers.change[0](vscode.uriOf('/ws/b.js'));
  await watcher.flush();

  assert.strictEqual(tracker.calls.recordBatch.length, 1);
  const recordedPaths = tracker.calls.recordBatch[0].map((payload) => payload.path);
  assert.deepStrictEqual(recordedPaths, ['/ws/b.js'], 'the tool-attributed file is deduped away');
  watcher.dispose();
});

test('rate breaker: >20 events/s sustained trips within ~6s, drops pending, degrades to git polling', async () => {
  const tracker = fakeTracker();
  let clock = 1700000000000;
  const timers = manualTimers();
  const vscode = fakeVscodeWorkspace();
  const diagnostics = [];
  const watcher = createChangeWatcher({
    vscode,
    tracker,
    storageUri: { fsPath: '/storage' },
    nowMs: () => clock,
    timers,
    onDiagnostic: (line) => diagnostics.push(line),
    fsOps: fakeFsOps({}),
  });
  const w = vscode.watchers[0];

  // 25 events per second — above the 20/s limit but far from instant death;
  // the OLD per-event check could never trip on this pattern.
  let trippedAt = -1;
  for (let second = 0; second < 10; second += 1) {
    clock += 1000;
    for (let i = 0; i < 25; i += 1) {
      w.handlers.change[0](vscode.uriOf('/ws/s' + second + '-' + i + '.js'));
    }
    if (w.disposed) { trippedAt = second; break; }
  }
  assert.ok(trippedAt >= 0, 'breaker trips on a sustained >20/s storm');
  assert.ok(trippedAt <= 6, 'trips within the 5s sustain window (+1s settle): ' + trippedAt);
  assert.strictEqual(watcher.state(), 'git-polling', 'degraded to git polling');
  assert.ok(timers.intervalCount() >= 1, 'git poll interval armed');
  assert.ok(diagnostics.some((line) => line.includes('breaker tripped')));

  // Pending paths queued before the trip are dropped, never journaled.
  timers.runTimeouts();
  await watcher.flush();
  assert.strictEqual(tracker.calls.recordBatch.length, 0, 'no journal writes for a tripped breaker');
  watcher.dispose();
});

test('rate breaker: calm traffic (≤20 events/s) never trips', async () => {
  const tracker = fakeTracker();
  let clock = 1700000000000;
  const timers = manualTimers();
  const vscode = fakeVscodeWorkspace();
  const watcher = createChangeWatcher({
    vscode,
    tracker,
    storageUri: { fsPath: '/storage' },
    nowMs: () => clock,
    timers,
    fsOps: fakeFsOps({}),
  });
  const w = vscode.watchers[0];
  for (let second = 0; second < 30; second += 1) {
    clock += 1000;
    for (let i = 0; i < 5; i += 1) {
      w.handlers.change[0](vscode.uriOf('/ws/c' + second + '-' + i + '.js'));
    }
  }
  assert.strictEqual(watcher.state(), 'watching', 'calm traffic keeps watching');
  assert.strictEqual(w.disposed, false);
  watcher.dispose();
});
