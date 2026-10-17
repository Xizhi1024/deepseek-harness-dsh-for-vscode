import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

function loadChunk(name) {
  let exported;
  vm.runInNewContext(fs.readFileSync(new URL(`../lib/${name}`, import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: (entry) => { exported = entry.factory(); } } },
    AbortController, TextEncoder, setTimeout, clearTimeout,
  });
  return exported;
}
const { createBrowserSessionAdapter } = loadChunk('client.dsh020.js');
const { createSessionBridge, validateSessionMessage } = loadChunk('client.sessionBridge.js');
const identity = { surfaceId: 'sidebar', surfaceEpoch: 2 };
const base = { channel: 'dsh-vscode-session', version: 1, ...identity };
const op = (requestId = 'test', extras = {}) => ({ requestId, signal: new AbortController().signal, ...extras });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function store(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    getSnapshot: () => value,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    set(next) { value = next; for (const fn of [...listeners]) fn(); },
    get count() { return listeners.size; },
  };
}

function fixture() {
  const models = new Map();
  let retains = 0;
  let releases = 0;
  function model(id) {
    if (!models.has(id)) {
      const state = { text: 'draft', rev: 0, inserts: 0, binding: { sessionId: id } };
      state.actions = {
        captureInsertion: () => ({ rev: state.rev }),
        insertText(text, span) { if (state.rev !== span.rev) return false; state.text += text; state.rev++; state.inserts++; return true; },
        setDraft() { throw new Error('Whole draft writes are forbidden'); },
      };
      models.set(id, state);
    }
    return models.get(id);
  }
  const projection = (id) => id ? { key: id, props: { sessionId: id, inputActions: model(id).actions } } : { key: undefined, props: { sessionId: undefined, inputActions: undefined } };
  const current = store(projection('A'));
  const panel = store({ activePanelId: null });
  const ctx = {
    get: () => undefined,
    uiSession: { adapter: { current }, bindingSource: (reference) => ({ getSnapshot: () => projection(reference.sessionId) }) },
    layout: { panelInfo: panel },
    sidebarRight: { isExpanded: () => false },
    uiWorkspace: { openSession: (id) => { current.set(projection(id)); panel.set({ activePanelId: null }); } },
    sessions: {
      binding: (id) => model(id).binding,
      retain(id) { retains++; let released = false; return { sessionId: id, binding: model(id).binding, release() { assert.equal(released, false); released = true; releases++; } }; },
    },
  };
  return { ctx, current, panel, model, select: (id) => current.set(projection(id)), counts: () => ({ retains, releases }) };
}

test('browser validator and canonical fixture corpus agree', () => {
  const fixtures = JSON.parse(fs.readFileSync(new URL('../../../test/fixtures/session-bridge-v1.json', import.meta.url), 'utf8'));
  for (const entry of fixtures) assert.equal(validateSessionMessage(entry.message, entry.options), entry.valid, entry.name);
});

test('initial navigation waits for public list readiness and supersedes startup restoration', async () => {
  const f = fixture();
  const list = store({ phase: 'loading' });
  f.ctx.sessions.list = list;
  const actions = [];
  const original = f.ctx.uiWorkspace.openSession;
  f.ctx.layout.beginNavigation = () => actions.push('supersede');
  f.ctx.uiWorkspace.openSession = (id) => { actions.push(id); original(id); };
  const adapter = createBrowserSessionAdapter({ ctx: f.ctx, surfaceIdentity: identity });
  const navigation = adapter.navigate('B', op());
  assert.deepEqual(actions, []);
  list.set({ phase: 'ready' });
  assert.equal((await navigation).sessionId, 'B');
  assert.deepEqual(actions, ['supersede', 'B']);
  assert.equal(list.count, 0);
  adapter.dispose();
});

test('public binding observation tracks A-B-A and invalidates a captured retain once', async () => {
  const f = fixture();
  const adapter = createBrowserSessionAdapter({ ctx: f.ctx, surfaceIdentity: identity });
  const initial = adapter.getTarget();
  const ticket = await adapter.captureInsertion(initial, op());
  f.select('B'); f.select('A');
  assert.ok(adapter.getTarget().selectionGeneration > initial.selectionGeneration);
  await assert.rejects(adapter.commitInsertion(ticket.ticketId, 'attachment', op()), { code: 'STALE_TARGET' });
  assert.equal(f.model('A').text, 'draft');
  assert.deepEqual(f.counts(), { retains: 1, releases: 1 });
  adapter.dispose(); adapter.dispose();
  assert.equal(f.current.count, 0); assert.equal(f.panel.count, 0);
});

test('revision guard preserves edits made while preparing an attachment', async () => {
  const f = fixture();
  const adapter = createBrowserSessionAdapter({ ctx: f.ctx, surfaceIdentity: identity });
  const ticket = await adapter.captureInsertion(adapter.getTarget(), op());
  f.model('A').text += ' user typed'; f.model('A').rev++;
  await assert.rejects(adapter.commitInsertion(ticket.ticketId, 'attachment', op()), { code: 'CONFLICT' });
  assert.equal(f.model('A').text, 'draft user typed');
  assert.deepEqual(f.counts(), { retains: 1, releases: 1 });
  adapter.dispose();
});

test('right-sidebar expansion refuses main-conversation insertion and releases capture', async () => {
  const f = fixture();
  let expanded = false;
  f.ctx.sidebarRight = { isExpanded: () => expanded, toggleExpanded: () => { expanded = false; } };
  const adapter = createBrowserSessionAdapter({ ctx: f.ctx, surfaceIdentity: identity });
  const target = adapter.getTarget();
  const ticket = await adapter.captureInsertion(target, op());
  expanded = true;
  assert.equal(adapter.getTarget().state, 'unknown');
  assert.equal(adapter.getCapabilities().insertion.state, 'unavailable');
  await assert.rejects(adapter.captureInsertion(target, op()), { code: 'CAPABILITY_UNAVAILABLE' });
  await assert.rejects(adapter.commitInsertion(ticket.ticketId, 'wrong target', op()), { code: 'STALE_TARGET' });
  assert.equal(f.model('A').text, 'draft');
  assert.deepEqual(f.counts(), { retains: 1, releases: 1 });
  assert.equal((await adapter.navigate('B', op())).sessionId, 'B');
  assert.equal(expanded, false);
  f.ctx.sidebarRight.focusedTarget = () => ({ sessionId: 'B', host: 'float' });
  assert.equal(adapter.getTarget().state, 'unknown');
  assert.match(adapter.getTarget().reason, /floating/);
  adapter.dispose();
});

test('successful ticket replay is idempotent and rejects changed payload', async () => {
  const f = fixture();
  const adapter = createBrowserSessionAdapter({ ctx: f.ctx, surfaceIdentity: identity });
  const ticket = await adapter.captureInsertion(adapter.getTarget(), op());
  assert.equal((await adapter.commitInsertion(ticket.ticketId, ' +file', op())).inserted, true);
  assert.equal((await adapter.commitInsertion(ticket.ticketId, ' +file', op())).inserted, true);
  await assert.rejects(adapter.commitInsertion(ticket.ticketId, 'other', op()), { code: 'CONFLICT' });
  assert.equal(f.model('A').inserts, 1);
  assert.deepEqual(f.counts(), { retains: 1, releases: 1 });
  adapter.dispose();
});

test('retained target is not writable while settings is visible and navigation requires observed target', async () => {
  const f = fixture();
  const adapter = createBrowserSessionAdapter({ ctx: f.ctx, surfaceIdentity: identity });
  f.panel.set({ activePanelId: 'settings' });
  assert.equal(adapter.getTarget().state, 'none');
  await assert.rejects(adapter.captureInsertion(adapter.getTarget(), op()), { code: 'NOT_READY' });
  assert.equal((await adapter.navigate('B', op())).sessionId, 'B');
  f.ctx.uiWorkspace.openSession = () => {};
  await assert.rejects(adapter.navigate('A', op('nav', { timeoutMs: 2 })), { code: 'TIMEOUT', effect: 'unknown' });
  adapter.dispose();
});

test('ticket limit is enforced and disposal releases every reference', async () => {
  const f = fixture();
  const adapter = createBrowserSessionAdapter({ ctx: f.ctx, surfaceIdentity: identity });
  for (let i = 0; i < 32; i++) await adapter.captureInsertion(adapter.getTarget(), op(`c${i}`));
  await assert.rejects(adapter.captureInsertion(adapter.getTarget(), op()), { code: 'BACKPRESSURE' });
  adapter.dispose();
  assert.deepEqual(f.counts(), { retains: 32, releases: 32 });
});

test('missing public observation fails closed', async () => {
  const f = fixture(); delete f.ctx.uiSession.adapter;
  const adapter = createBrowserSessionAdapter({ ctx: f.ctx, surfaceIdentity: identity });
  assert.equal(adapter.getTarget().state, 'unknown');
  await assert.rejects(adapter.captureInsertion(adapter.getTarget(), op()), { code: 'CAPABILITY_UNAVAILABLE' });
  adapter.dispose();
});

function bridgeFixture() {
  const f = fixture();
  const sent = [];
  let receive;
  const win = {
    parent: { postMessage: (message) => sent.push(message) },
    addEventListener: (_, fn) => { receive = fn; }, removeEventListener() {},
  };
  const bridge = createSessionBridge({ ctx: f.ctx, createBrowserSessionAdapter, window: win,
    runtimeIdentity: { runtimeVersion: '0.2.0-rc.1', adapterId: 'dsh-0.2.0-rc.1' }, nonce: 'a'.repeat(32) });
  const emit = (message, overrides = {}) => receive({ source: win.parent, origin: 'null', data: message, ...overrides });
  const hello = { ...base, type: 'hello-init', nonce: 'a'.repeat(32) };
  const request = (requestId, method, params) => ({ ...base, type: 'request', requestId, method, params });
  return { ...f, sent, bridge, emit, hello, request, win };
}

test('nonce, source, origin, and epoch checks precede adapter requests', async () => {
  const f = bridgeFixture();
  f.emit({ ...f.hello, nonce: 'b'.repeat(32) });
  f.emit(f.hello, { source: {} });
  assert.equal(f.sent.length, 0);
  f.emit(f.hello);
  assert.equal(f.sent[0].type, 'hello-ack');
  f.emit(f.request('wrong_origin', 'session.navigate', { sessionId: 'B' }), { origin: 'https://attacker.invalid' });
  f.emit({ ...f.request('wrong_epoch', 'session.navigate', { sessionId: 'B' }), surfaceEpoch: 1 });
  await tick();
  assert.equal(f.current.getSnapshot().key, 'A');
  f.bridge.dispose();
});

test('bridge shares same-id capture and cancels retained result before delivery', async () => {
  const f = bridgeFixture(); f.emit(f.hello);
  const target = f.sent.find((item) => item.type === 'targetChanged').target;
  const capture = f.request('capture', 'insertion.capture', { expected: target });
  f.emit(capture); f.emit(capture);
  await tick();
  assert.deepEqual(f.counts(), { retains: 1, releases: 0 });
  const replies = f.sent.filter((item) => item.requestId === 'capture');
  assert.equal(replies.length, 2); assert.equal(replies[0].value.ticketId, replies[1].value.ticketId);
  f.emit(f.request('capture', 'target.get', {})); await tick();
  assert.equal(f.sent.at(-1).error.code, 'CONFLICT');
  f.bridge.dispose();
  assert.deepEqual(f.counts(), { retains: 1, releases: 1 });

  const g = bridgeFixture(); g.emit(g.hello);
  const expected = g.sent.find((item) => item.type === 'targetChanged').target;
  g.emit(g.request('pending', 'insertion.capture', { expected }));
  g.emit(g.request('cancel', 'request.cancel', { targetRequestId: 'pending' }));
  await tick();
  assert.equal(g.sent.find((item) => item.requestId === 'pending').error.code, 'CANCELLED');
  assert.deepEqual(g.counts(), { retains: 1, releases: 1 });
  g.bridge.dispose();
});

for (const runtimeVersion of ['0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-rc.1', '0.2.1-rc.2']) {
test(`target entry uses chunks and never touches legacy current/open or the DOM observer (${runtimeVersion})`, async () => {
  const f = fixture();
  const listeners = new Set();
  const cleanups = [];
  const chunks = [];
  let client;
  const win = {
    location: { search: `?dsh_embed=vscode&dsh_runtime=${runtimeVersion}&dsh_bridge_nonce=` + 'a'.repeat(32) },
    addEventListener: (type, fn) => { if (type === 'message') listeners.add(fn); },
    removeEventListener: (type, fn) => { if (type === 'message') listeners.delete(fn); },
    getSelection: () => ({ toString: () => '' }),
    MutationObserver: class { constructor() { throw new Error('Target must not create legacy DOM observers'); } },
    __ModuleLoader__: { load(entry) { client = entry.factory({ async: async (name) => { chunks.push(name); return loadChunk(name.slice(2)); } }); } },
  };
  win.parent = { postMessage(message) {
    if (message.type === 'dshWebviewHello') queueMicrotask(() => {
      for (const fn of listeners) fn({ source: win.parent, data: { type: 'dshWebviewReady', channel: message.channel, version: 1 } });
    });
  } };
  Object.defineProperty(f.ctx.sessions, 'list', { get() { throw new Error('Target must not read legacy list.current'); } });
  Object.defineProperty(f.ctx.sessions, 'open', { get() { throw new Error('Target must not call legacy sessions.open'); } });
  const document = { addEventListener() {}, removeEventListener() {}, execCommand: () => true };
  vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window: win, navigator: { platform: 'Linux' }, document, URLSearchParams, TextEncoder, setTimeout, clearTimeout,
  });
  client.apply({ ...f.ctx, effect: (fn) => { const cleanup = fn(); cleanups.push(cleanup); },
    inject: (_, fn) => { const cleanup = fn(f.ctx); return { dispose: cleanup }; } });
  await tick();
  assert.deepEqual(chunks.sort(), ['./client.dsh020.js', './client.sessionBridge.js']);
  for (const cleanup of cleanups) cleanup();
  assert.equal(listeners.size, 0);
});
}
