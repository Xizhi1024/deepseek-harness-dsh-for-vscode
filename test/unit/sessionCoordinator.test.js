'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionCoordinator } = require('../../src/session/coordinator');
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture() {
  const calls = [];
  let listener;
  const target = { surfaceId: 'sidebar', surfaceEpoch: 1, selectionGeneration: 1, state: 'known', sessionId: 'A' };
  const browser = {
    getTarget: () => target, observeTarget: (callback) => { listener = callback; return () => calls.push('unobserve'); },
    captureInsertion: async (expected) => { calls.push('capture'); return { ...expected, state: undefined }; },
    commitInsertion: async () => { calls.push('commit'); return { inserted: true }; },
    cancelInsertion: () => calls.push('cancel'), dispose: () => calls.push('dispose'),
    navigate: async (id) => ({ ...target, sessionId: id }),
  };
  browser.captureInsertion = async () => { calls.push('capture'); return { ticketId: 'ticket-1', surfaceId: 'sidebar', surfaceEpoch: 1,
    selectionGeneration: 1, sessionId: 'A', expiresAt: Date.now() + 30000 }; };
  const api = { ensureWorkspace: async () => ({ id: 'w', rootPath: '/work', name: null }),
    listSessions: async () => [{ id: 'A', workspaceId: 'w' }], createSession: () => calls.push('create') };
  const coordinator = createSessionCoordinator();
  const unregister = coordinator.registerSurface({ surfaceId: 'sidebar', surfaceEpoch: 1, lease: { instanceId: 'i', api }, browser });
  return { coordinator, calls, browser, api, unregister, emit: (value) => listener(value), target };
}

for (const sessionId of ['C', 'B']) {
  test(`navigation rejects a stale reply after a newer selection of ${sessionId}`, async () => {
    const f = fixture(); const reply = deferred();
    f.api.listSessions = async () => [{ id: 'B', workspaceId: 'w' }];
    f.browser.navigate = () => reply.promise;
    try {
      await f.coordinator.bindWorkspace('sidebar', '/work');
      const pending = f.coordinator.navigate('sidebar', 'B');
      await tick();
      const latest = { ...f.target, sessionId, selectionGeneration: 2 };
      f.emit(latest);
      reply.resolve({ ...f.target, sessionId: 'B' });
      await assert.rejects(pending, { code: 'STALE_TARGET' });
      assert.deepEqual(f.coordinator.getTarget('sidebar'), latest);
    } finally {
      await f.coordinator.dispose();
    }
  });
}

test('navigation accepts a reply matching the observed current selection', async () => {
  const f = fixture();
  const selected = { ...f.target, sessionId: 'B', selectionGeneration: 2 };
  f.api.listSessions = async () => [{ id: 'B', workspaceId: 'w' }];
  f.browser.navigate = async () => { f.emit(selected); return selected; };
  try {
    await f.coordinator.bindWorkspace('sidebar', '/work');
    assert.deepEqual(await f.coordinator.navigate('sidebar', 'B'), selected);
  } finally {
    await f.coordinator.dispose();
  }
});

test('capture precedes async attachment work and A-B-A invalidates its ticket', async () => {
  const f = fixture(); const prepared = deferred();
  const pending = f.coordinator.insertAttachment('sidebar', () => { f.calls.push('prepare'); return prepared.promise; });
  await tick();
  assert.deepEqual(f.calls, ['capture', 'prepare']);
  f.emit({ ...f.target, sessionId: 'B', selectionGeneration: 2 });
  f.emit({ ...f.target, selectionGeneration: 3 });
  prepared.resolve('text');
  await assert.rejects(pending, { code: 'STALE_TARGET' });
  assert.equal(f.calls.includes('commit'), false);
  assert.equal(f.calls.includes('cancel'), true);
  await f.coordinator.dispose();
});

test('focus workspace binding does not create or navigate a session', async () => {
  const f = fixture();
  await f.coordinator.bindWorkspace('sidebar', '/work');
  assert.deepEqual(f.calls, []);
  assert.equal(f.coordinator.getTarget('sidebar').sessionId, 'A');
  await f.coordinator.dispose();
});

test('unavailable input surface preserves its actionable reason and never prepares an attachment', async () => {
  const f = fixture();
  const reason = 'Close the DSH right sidebar before adding content to the main conversation';
  f.emit({ surfaceId: 'sidebar', surfaceEpoch: 1, selectionGeneration: 2, state: 'unknown', reason });
  await assert.rejects(f.coordinator.insertAttachment('sidebar', () => { f.calls.push('prepare'); return 'text'; }),
    { code: 'CAPABILITY_UNAVAILABLE', message: reason, effect: 'none' });
  assert.deepEqual(f.calls, []);
  await f.coordinator.dispose();
});

test('unregister cancels waiting preparation and releases the browser exactly once', async () => {
  const f = fixture(); const prepared = deferred();
  const pending = f.coordinator.insertAttachment('sidebar', () => prepared.promise);
  await tick();
  f.unregister(); f.unregister();
  await assert.rejects(pending, { code: 'CANCELLED' });
  assert.equal(f.calls.filter((x) => x === 'dispose').length, 1);
  assert.equal(f.calls.includes('cancel'), true);
  prepared.resolve('late'); await tick();
  assert.equal(f.calls.includes('commit'), false);
  await f.coordinator.dispose();
});

test('deadline after commit dispatch reports unknown outcome and does not retry', async () => {
  const f = fixture(); const result = deferred();
  f.browser.commitInsertion = () => { f.calls.push('commit'); return result.promise; };
  await assert.rejects(f.coordinator.insertAttachment('sidebar', async () => 'text', { timeoutMs: 20 }), { code: 'OUTCOME_UNKNOWN', effect: 'unknown' });
  assert.equal(f.calls.filter((x) => x === 'commit').length, 1);
  result.resolve({ inserted: true }); await tick();
  await f.coordinator.dispose();
});
