'use strict';

// C2: receive-side routing of the vscode/dshEditObserved client→server
// notification in VersionedBridgeServer. The DSH plugin fires it (metadata
// only) after observing an edit/write tool pre-execute; the extension's
// recordToolEdit sink is injected as the onDshEditObserved constructor arg.

const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');

const {
  VersionedBridgeServer,
  isValidDshEditObservedParams,
} = require('../src/versionedBridgeServer');
const { NOTIFICATIONS_BY_VERSION } = require('../src/protocol/ch1');

function client(port) {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  socket.setEncoding('utf8');
  const frames = [];
  const waiters = [];
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      frames.push(JSON.parse(line));
      while (waiters.length > 0) waiters.shift()();
    }
  });
  return {
    socket,
    send(frame) { socket.write(JSON.stringify(frame) + '\n'); },
    frames,
    async next() {
      while (frames.length === 0) await new Promise((resolve) => waiters.push(resolve));
      return frames.shift();
    },
    close() { socket.destroy(); },
  };
}

function initializeFrame(server, id = 1, protocolVersion = 3) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      token: server.token,
      protocolVersion,
      clientInfo: { name: 'dsh-vscode-integration', version: '0.7.0' },
    },
  };
}

const VALID_PAYLOAD = Object.freeze({
  tool: 'edit',
  path: 'D:\\workspace\\repo\\lib\\a.js',
  sessionId: 'sess-1',
  size: 128,
  truncated: false,
});

async function connectedPeer(t, server, protocolVersion = 3) {
  const peer = client(server.port);
  t.after(() => peer.close());
  peer.send(initializeFrame(server, 1, protocolVersion));
  await peer.next();
  return peer;
}

test('isValidDshEditObservedParams enforces the C2 contract', () => {
  assert.strictEqual(isValidDshEditObservedParams(VALID_PAYLOAD), true);
  assert.strictEqual(isValidDshEditObservedParams({ ...VALID_PAYLOAD, tool: 'write' }), true);
  assert.strictEqual(isValidDshEditObservedParams(null), false);
  assert.strictEqual(isValidDshEditObservedParams('edit'), false);
  assert.strictEqual(isValidDshEditObservedParams({ ...VALID_PAYLOAD, tool: 'read' }), false);
  assert.strictEqual(isValidDshEditObservedParams({ ...VALID_PAYLOAD, tool: 7 }), false);
  assert.strictEqual(isValidDshEditObservedParams({ ...VALID_PAYLOAD, path: '' }), false);
  assert.strictEqual(isValidDshEditObservedParams({ ...VALID_PAYLOAD, path: 42 }), false);
  assert.strictEqual(isValidDshEditObservedParams({ ...VALID_PAYLOAD, sessionId: 7 }), false);
  assert.strictEqual(isValidDshEditObservedParams({ ...VALID_PAYLOAD, size: '128' }), false);
  assert.strictEqual(isValidDshEditObservedParams({ ...VALID_PAYLOAD, size: -1 }), false);
  assert.strictEqual(isValidDshEditObservedParams({ ...VALID_PAYLOAD, size: Number.NaN }), false);
  assert.strictEqual(isValidDshEditObservedParams({ ...VALID_PAYLOAD, truncated: 'no' }), false);
});

test('valid dshEditObserved notification from a v3 client reaches the sink untouched', async (t) => {
  const observed = [];
  const server = await new VersionedBridgeServer({
    handlers: {},
    onDshEditObserved: (payload) => observed.push(payload),
  }).start();
  t.after(() => server.close());
  const peer = await connectedPeer(t, server, 3);
  peer.send({ jsonrpc: '2.0', method: 'vscode/dshEditObserved', params: VALID_PAYLOAD });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepStrictEqual(observed, [VALID_PAYLOAD]);
  assert.strictEqual(peer.frames.length, 0, 'notifications are never answered');
});

test('malformed dshEditObserved params are rejected without touching the sink', async (t) => {
  const observed = [];
  const server = await new VersionedBridgeServer({
    handlers: {},
    onDshEditObserved: (payload) => observed.push(payload),
  }).start();
  t.after(() => server.close());
  const peer = await connectedPeer(t, server, 3);
  const bad = [
    null,
    ['edit'],
    { tool: 'read', path: '/a', sessionId: '', size: 1, truncated: false },
    { tool: 'edit', path: '', sessionId: '', size: 1, truncated: false },
    { tool: 'edit', sessionId: '', size: 1, truncated: false },
    { tool: 'edit', path: '/a', size: 1, truncated: false },
    { tool: 'edit', path: '/a', sessionId: '', truncated: false },
    { tool: 'edit', path: '/a', sessionId: '', size: 'big', truncated: false },
    { tool: 'edit', path: '/a', sessionId: '', size: 1, truncated: 'maybe' },
  ];
  for (const params of bad) {
    peer.send({ jsonrpc: '2.0', method: 'vscode/dshEditObserved', params });
  }
  peer.send({ jsonrpc: '2.0', method: 'vscode/dshEditObserved' }); // no params at all
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.strictEqual(observed.length, 0);
});

test('unknown id-less notifications stay ignored and the connection stays usable', async (t) => {
  const observed = [];
  const server = await new VersionedBridgeServer({
    handlers: { 'vscode/editor/getContext': async () => ({ ok: true }) },
    onDshEditObserved: (payload) => observed.push(payload),
  }).start();
  t.after(() => server.close());
  const peer = await connectedPeer(t, server, 3);
  peer.send({ jsonrpc: '2.0', method: 'vscode/somethingElse', params: {} });
  peer.send({ jsonrpc: '2.0', method: '$/dummy', params: {} });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.strictEqual(observed.length, 0);
  assert.strictEqual(peer.frames.length, 0);
  // the same socket still round-trips requests afterwards
  peer.send({ jsonrpc: '2.0', id: 2, method: 'vscode/editor/getContext', params: {} });
  assert.deepStrictEqual((await peer.next()).result, { ok: true });
});

test('a dshEditObserved REQUEST (with id) must not ride the notification branch', async (t) => {
  const observed = [];
  const server = await new VersionedBridgeServer({
    handlers: {},
    onDshEditObserved: (payload) => observed.push(payload),
  }).start();
  t.after(() => server.close());
  const peer = await connectedPeer(t, server, 3);
  peer.send({ jsonrpc: '2.0', id: 9, method: 'vscode/dshEditObserved', params: VALID_PAYLOAD });
  const reply = await peer.next();
  assert.strictEqual(reply.id, 9);
  assert.strictEqual(reply.error.data.code, 'VSCODE_METHOD_NOT_ALLOWED');
  assert.strictEqual(observed.length, 0, 'request-shaped frames never reach the sink');
});

test('v1/v2 clients and pre-init sockets cannot deliver dshEditObserved', async (t) => {
  const observed = [];
  const server = await new VersionedBridgeServer({
    handlers: {},
    onDshEditObserved: (payload) => observed.push(payload),
  }).start();
  t.after(() => server.close());
  // pre-init socket
  const raw = client(server.port);
  t.after(() => raw.close());
  raw.send({ jsonrpc: '2.0', method: 'vscode/dshEditObserved', params: VALID_PAYLOAD });
  // v2 client (initialized)
  const v2 = await connectedPeer(t, server, 2);
  assert.strictEqual(NOTIFICATIONS_BY_VERSION[2].includes('vscode/dshEditObserved'), false);
  v2.send({ jsonrpc: '2.0', method: 'vscode/dshEditObserved', params: VALID_PAYLOAD });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.strictEqual(observed.length, 0);
});

test('missing or throwing sink is a safe no-op for the connection', async (t) => {
  const plain = await new VersionedBridgeServer({ handlers: {} }).start();
  t.after(() => plain.close());
  const peerA = await connectedPeer(t, plain, 3);
  peerA.send({ jsonrpc: '2.0', method: 'vscode/dshEditObserved', params: VALID_PAYLOAD });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.strictEqual(peerA.frames.length, 0);

  const exploding = await new VersionedBridgeServer({
    handlers: {},
    onDshEditObserved: () => { throw new Error('journal down'); },
  }).start();
  t.after(() => exploding.close());
  const peerB = await connectedPeer(t, exploding, 3);
  peerB.send({ jsonrpc: '2.0', method: 'vscode/dshEditObserved', params: VALID_PAYLOAD });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.strictEqual(peerB.frames.length, 0, 'a throwing sink never errors the socket');
});

test('constructor rejects a non-function onDshEditObserved', async () => {
  assert.throws(
    () => new VersionedBridgeServer({ onDshEditObserved: 'record' }),
    /onDshEditObserved must be a function/,
  );
});
