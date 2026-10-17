'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { createBrowserSessionProxy } = require('../../src/session/browserProxy');
const { framePage } = require('../../src/webviewHtml');
const { validateSessionMessage } = require('../../src/protocol/runtime');
const identity = { surfaceId: 'sidebar', surfaceEpoch: 7 };
const base = { channel: 'dsh-vscode-session', version: 1, ...identity };
const available = { state: 'available' };
const runtimePairs = {
  '0.2.0-rc.1': 'dsh-0.2.0-rc.1',
  '0.2.0-rc.2': 'dsh-0.2.0-rc.2',
  '0.2.1-rc.1': 'dsh-0.2.1-rc.1',
  '0.2.1-rc.2': 'dsh-0.2.1-rc.2',
};
const ackFor = (version) => ({ ...base, type: 'hello-ack', runtimeVersion: version, adapterId: runtimePairs[version],
  capabilities: { navigation: available, targetObservation: available, insertion: available, theme: available, clipboard: available } });
const hello = ackFor('0.2.0-rc.1');
const target = { ...identity, selectionGeneration: 1, state: 'known', sessionId: 'A' };

function fixture(expectedIdentity = { runtimeVersion: '0.2.0-rc.1', adapterId: 'dsh-0.2.0-rc.1' }) {
  let receive;
  let unsubscribed = false;
  const sent = [];
  const proxy = createBrowserSessionProxy({ surfaceIdentity: identity, expectedIdentity,
    postMessage: (message) => { sent.push(message); return true; },
    subscribeMessages: (callback) => { receive = callback; return () => { unsubscribed = true; }; },
  });
  return { proxy, sent, receive: (message) => receive(message), unsubscribed: () => unsubscribed };
}

test('proxy queues until matching handshake and rejects stale or malformed results', async () => {
  const f = fixture();
  const work = f.proxy.navigate('A', { requestId: 'nav' });
  assert.equal(f.sent.length, 0);
  f.receive({ ...hello, surfaceEpoch: 6 }); assert.equal(f.sent.length, 0);
  f.receive(hello); assert.equal(f.sent.length, 1);
  f.receive({ ...base, type: 'result', requestId: 'nav', ok: true, value: target, surfaceEpoch: 6 });
  f.receive({ ...base, type: 'result', requestId: 'nav', ok: true, value: true });
  await assert.rejects(work, { code: 'PROTOCOL_MISMATCH', effect: 'unknown' });
  f.proxy.dispose(); assert.equal(f.unsubscribed(), true);
});

test('proxy accepts observed target, captures ticket and rejects generation regression', async () => {
  const f = fixture(); f.receive(hello);
  f.receive({ ...base, type: 'targetChanged', target });
  assert.equal(f.proxy.getTarget().sessionId, 'A');
  f.receive({ ...base, type: 'targetChanged', target: { ...target, selectionGeneration: 0, sessionId: 'old' } });
  assert.equal(f.proxy.getTarget().sessionId, 'A');
  const work = f.proxy.captureInsertion(target, { requestId: 'capture' });
  const ticket = { ...identity, selectionGeneration: 1, sessionId: 'A', ticketId: 'ticket', expiresAt: Date.now() + 30000 };
  f.receive({ ...base, type: 'result', requestId: 'capture', ok: true, value: ticket });
  assert.deepEqual(await work, ticket);
  f.proxy.dispose();
});

test('proxy cancellation sends request.cancel and commit outcome remains unknown', async () => {
  const f = fixture(); f.receive(hello);
  const controller = new AbortController();
  const work = f.proxy.commitInsertion('ticket', 'text', { requestId: 'commit', signal: controller.signal });
  controller.abort();
  await assert.rejects(work, { code: 'OUTCOME_UNKNOWN', effect: 'unknown' });
  assert.equal(f.sent.at(-1).method, 'request.cancel');
  assert.equal(f.sent.at(-1).params.targetRequestId, 'commit');
  assert.ok(f.sent.every((message) => message.method !== 'session.cancel'));
  f.proxy.dispose();
});

test('proxy same-id requests share work and dispose clears their lifetime', async () => {
  const f = fixture(); f.receive(hello);
  const a = f.proxy.navigate('A', { requestId: 'same' });
  const b = f.proxy.navigate('A', { requestId: 'same' });
  assert.equal(a, b); assert.equal(f.sent.length, 1);
  await assert.rejects(f.proxy.navigate('B', { requestId: 'same' }), { code: 'CONFLICT' });
  f.proxy.dispose(); f.proxy.dispose();
  await assert.rejects(a, { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.proxy.getDiagnostics().pendingRequests, 0);
});

test('proxy handshakes on the rc.2 pair and rejects a mismatched runtime identity', async () => {
  const f = fixture({ runtimeVersion: '0.2.0-rc.2', adapterId: 'dsh-0.2.0-rc.2' });
  const work = f.proxy.navigate('A', { requestId: 'nav' });
  assert.equal(validateSessionMessage(ackFor('0.2.0-rc.2')), true, 'contract accepts the rc.2 ack');
  f.receive(hello); assert.equal(f.sent.length, 0, 'an rc.1 ack never readies an rc.2 lease');
  f.receive({ ...ackFor('0.2.0-rc.2'), adapterId: 'dsh-0.2.0-rc.1' }); assert.equal(f.sent.length, 0, 'mixed pairs are rejected');
  f.receive(ackFor('0.2.0-rc.2')); assert.equal(f.sent.length, 1, 'the real rc.2 pair readies the proxy');
  f.receive({ ...base, type: 'result', requestId: 'nav', ok: true, value: target });
  assert.equal((await work).sessionId, 'A');
  f.proxy.dispose();
});

test('proxy construction fails closed without an expected runtime identity', () => {
  assert.throws(() => createBrowserSessionProxy({ surfaceIdentity: identity,
    postMessage: () => true, subscribeMessages: () => () => {} }), { code: 'INVALID_ARGUMENT' });
});

function shell(version = '0.2.0-rc.1') {
  const html = framePage({ url: 'http://127.0.0.1:3999', runtimeVersion: version, surfaceIdentity: identity });
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const frameListeners = {};
  const windowListeners = {};
  const host = [];
  const child = [];
  const timers = new Map(); let timerId = 0;
  const frame = { contentWindow: { postMessage: (message, origin) => child.push({ message, origin }) },
    addEventListener: (type, listener) => { frameListeners[type] = listener; }, remove() {} };
  vm.runInNewContext(script, {
    acquireVsCodeApi: () => ({ postMessage: (message) => host.push(message) }),
    document: { getElementById: (id) => id === 'frame' ? frame : id === 'fallback' ? { classList: { add() {} } } : { addEventListener() {} } },
    window: { addEventListener: (type, listener) => { windowListeners[type] = listener; } },
    location: { reload() { throw new Error('No automatic frame reload'); } },
    setTimeout: (callback) => { timers.set(++timerId, callback); return timerId; }, clearTimeout: (id) => timers.delete(id),
  });
  return { html, host, child, frame, frameListeners, windowListeners, timers };
}

for (const version of Object.keys(runtimePairs)) {
test(`target shell issues bounded host-first hello with nonce and isolates iframe generations (${version})`, () => {
  const s = shell(version); s.frameListeners.load();
  const init = s.host[0];
  assert.equal(init.type, 'hello-init'); assert.equal(init.surfaceEpoch, 7);
  assert.equal(validateSessionMessage(init), true);
  assert.ok(s.html.includes('dsh_bridge_nonce=' + init.nonce));
  assert.ok(s.html.includes(`dsh_runtime=${encodeURIComponent(version)}`), 'the frame URL stamps the selected runtime');
  const ack = ackFor(version);
  const emit = (message, origin = 'http://127.0.0.1:3999') => s.windowListeners.message({ source: s.frame.contentWindow, origin, data: message });
  emit(ackFor(version === '0.2.0-rc.1' ? '0.2.0-rc.2' : '0.2.0-rc.1')); assert.equal(s.host.length, 1, 'a foreign runtime ack never readies the shell');
  emit(ack, 'https://wrong.invalid'); assert.equal(s.host.length, 1);
  emit(ack); assert.equal(s.host.at(-1).type, 'hello-ack');
  emit({ ...base, type: 'targetChanged', target }); assert.equal(s.host.at(-1).type, 'targetChanged');
  s.frameListeners.load(); assert.equal(s.host.at(-1).surfaceEpoch, 8);
  const count = s.host.length;
  emit({ ...base, type: 'targetChanged', target }); assert.equal(s.host.length, count);
  s.windowListeners.beforeunload();
});
}
