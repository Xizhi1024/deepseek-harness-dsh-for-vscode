'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { createChangeWatcher } = require('../../src/changeWatcher');

function fixture({ record, isFile = true, extensions } = {}) {
  const root = path.resolve('watcher-fixture');
  const storageRoot = path.join(root, '.storage');
  const events = {};
  const entries = [];
  const timeouts = new Map();
  const intervals = new Map();
  let now = 20_000;
  let id = 0;
  let statCalls = 0;
  let detached = 0;
  const tracker = {
    list: () => entries,
    record: record || (async (payload) => {
      const entry = { ...payload, id: String(entries.length), at: new Date(now).toISOString() };
      entries.push(entry);
      return entry;
    }),
  };
  const watcher = createChangeWatcher({
    vscode: {
      extensions,
      workspace: {
        workspaceFolders: [{ uri: { fsPath: root } }],
        getConfiguration: () => ({ get: () => ({ '**/generated/**': true }) }),
        createFileSystemWatcher: () => ({
          onDidChange: (fn) => { events.change = fn; },
          onDidCreate: (fn) => { events.create = fn; },
          onDidDelete: (fn) => { events.delete = fn; },
          dispose: () => { detached += 1; },
        }),
      },
    },
    tracker,
    storageUri: { fsPath: storageRoot },
    nowMs: () => now,
    timers: {
      setTimeout: (fn) => { timeouts.set(++id, fn); return id; },
      clearTimeout: (key) => timeouts.delete(key),
      setInterval: (fn) => { intervals.set(++id, fn); return id; },
      clearInterval: (key) => intervals.delete(key),
    },
    fsOps: {
      statSync: () => { statCalls += 1; return { mtimeMs: now, size: 0, isFile: () => isFile }; },
    },
  });
  function change(relative) {
    const fsPath = path.join(root, relative);
    events.change({ fsPath, toString: () => `file://${fsPath}` });
  }
  return {
    watcher, change, entries, timeouts, intervals, root, storageRoot,
    advance: (ms) => { now += ms; },
    get statCalls() { return statCalls; },
    get detached() { return detached; },
  };
}

test('excluded event storms do not queue disk work or trip the watcher breaker', async (t) => {
  const f = fixture();
  t.after(() => f.watcher.dispose());
  for (let i = 0; i < 2_000; i += 1) {
    f.change(`.git/objects/${i}`);
    f.change(`.storage/changes/${i}`);
    f.change(`generated/${i}`);
    f.advance(5);
  }
  await f.watcher.flush();
  assert.equal(f.watcher.state(), 'watching');
  assert.equal(f.timeouts.size, 0);
  assert.equal(f.intervals.size, 0);
  assert.equal(f.statCalls, 0);
  assert.equal(f.entries.length, 0);
  f.change('source.js');
  await f.watcher.flush();
  assert.equal(f.entries.length, 1);
});

test('a large distinct-file burst degrades before its unbounded queue reaches disk', async (t) => {
  const f = fixture();
  t.after(() => f.watcher.dispose());
  for (let i = 0; i < 10_000; i += 1) f.change(`source/${i}.js`);
  assert.equal(f.watcher.state(), 'git-polling');
  assert.equal(f.detached, 1);
  assert.equal(f.intervals.size, 1);
  assert.equal(f.timeouts.size, 0);
  await f.watcher.flush();
  assert.equal(f.statCalls, 0);
  assert.equal(f.entries.length, 0);
});

test('sustained repeated-file events still trip the rate breaker', (t) => {
  const f = fixture();
  t.after(() => f.watcher.dispose());
  for (let i = 0; i < 160; i += 1) {
    f.change('busy.js');
    f.advance(40);
  }
  assert.equal(f.watcher.state(), 'git-polling');
  assert.equal(f.intervals.size, 1);
});

test('overlapping flush requests serialize recording and deduplicate repeated events', async (t) => {
  let finishRecord;
  let calls = 0;
  const f = fixture({
    record: async (payload) => {
      calls += 1;
      await new Promise((resolve) => { finishRecord = resolve; });
      const entry = { ...payload, at: new Date(20_000).toISOString() };
      f.entries.push(entry);
      return entry;
    },
  });
  t.after(() => f.watcher.dispose());
  f.change('slow.js');
  const first = f.watcher.flush();
  f.change('slow.js');
  const second = f.watcher.flush();
  assert.equal(first, second);
  assert.equal(calls, 1);
  finishRecord();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});

test('directory events are not journaled as changed files', async (t) => {
  const f = fixture({ isFile: false });
  t.after(() => f.watcher.dispose());
  f.change('source');
  await f.watcher.flush();
  assert.equal(f.entries.length, 0);
});

test('breaker fallback reads repositories through the real vscode.git getAPI contract', async (t) => {
  const repositories = [];
  const f = fixture({
    extensions: {
      getExtension: (id) => {
        assert.equal(id, 'vscode.git');
        return {
          isActive: true,
          exports: {
            getAPI: (version) => {
              assert.equal(version, 1);
              return { repositories };
            },
          },
        };
      },
    },
  });
  t.after(() => f.watcher.dispose());
  const fsPath = path.join(f.root, 'source.js');
  repositories.push({
    state: { workingTreeChanges: [{ uri: { fsPath, toString: () => `file://${fsPath}` } }] },
  });
  for (let i = 0; i < 300; i += 1) f.change(`build/${i}`);
  assert.equal(f.watcher.state(), 'git-polling');
  assert.equal(await f.watcher.pollOnce(), 1);
  assert.equal(f.entries[0].path, fsPath);
  assert.equal(await f.watcher.pollOnce(), 0);
});
