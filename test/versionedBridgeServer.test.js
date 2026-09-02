'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');

const {
  VSCODE_MAX_FRAME_BYTES,
  VersionedBridgeServer,
} = require('../src/versionedBridgeServer');
const { METHODS_BY_VERSION } = require('../src/protocol/ch1');

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
    send(frame) { socket.write(`${JSON.stringify(frame)}\n`); },
    sendRaw(value) { socket.write(value); },
    async next() {
      while (frames.length === 0) await new Promise((resolve) => waiters.push(resolve));
      return frames.shift();
    },
    close() { socket.destroy(); },
  };
}

function initializeFrame(server, id = 1, overrides = {}) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      token: server.token,
      protocolVersion: 1,
      clientInfo: { name: 'dsh', version: '0.1.0' },
      ...overrides,
    },
  };
}

test('protocol v3 advertises the frozen 35-method table including extensions/callExport', () => {
  assert.strictEqual(METHODS_BY_VERSION[3].length, 35);
  assert.ok(METHODS_BY_VERSION[3].includes('vscode/extensions/callExport'));
});

test('VersionedBridgeServer authenticates, negotiates, and dispatches only allowed methods', async (t) => {
  const server = await new VersionedBridgeServer({
    serverVersion: '0.3.1',
    workspace: { windowId: 'w1', trusted: true, kind: 'local', folders: [] },
    handlers: {
      'vscode/editor/getContext': async (params) => ({ revision: 2, attachments: [], echo: params }),
    },
  }).start();
  t.after(() => server.close());
  const peer = client(server.port);
  t.after(() => peer.close());

  peer.send(initializeFrame(server));
  const initialized = await peer.next();
  assert.strictEqual(initialized.result.protocolVersion, 1);
  assert.strictEqual(initialized.result.serverInfo.version, '0.3.1');
  assert.deepStrictEqual(initialized.result.methods, ['vscode/editor/getContext']);
  await server.waitForInitialized(100);

  peer.send({ jsonrpc: '2.0', id: 2, method: 'vscode/editor/getContext', params: { attachmentIds: ['a'] } });
  assert.deepStrictEqual((await peer.next()).result.echo, { attachmentIds: ['a'] });

  peer.send({ jsonrpc: '2.0', id: 3, method: 'vscode/command/execute', params: {} });
  assert.strictEqual((await peer.next()).error.data.code, 'VSCODE_METHOD_NOT_ALLOWED');
});

test('VersionedBridgeServer rejects pre-init, wrong token, and incompatible version', async (t) => {
  const server = await new VersionedBridgeServer().start();
  t.after(() => server.close());

  const preinit = client(server.port);
  t.after(() => preinit.close());
  preinit.send({ jsonrpc: '2.0', id: 1, method: 'vscode/editor/getContext', params: {} });
  assert.strictEqual((await preinit.next()).error.data.code, 'VSCODE_NOT_INITIALIZED');

  const badToken = client(server.port);
  t.after(() => badToken.close());
  badToken.send(initializeFrame(server, 2, { token: 'wrong' }));
  assert.strictEqual((await badToken.next()).error.data.code, 'VSCODE_AUTH_FAILED');

  const badVersion = client(server.port);
  t.after(() => badVersion.close());
  badVersion.send(initializeFrame(server, 3, { protocolVersion: 99 }));
  assert.strictEqual((await badVersion.next()).error.data.code, 'VSCODE_PROTOCOL_MISMATCH');
});

test('VersionedBridgeServer enforces frame bytes and per-request cancellation', async (t) => {
  let aborted = false;
  const server = await new VersionedBridgeServer({
    requestTimeoutMs: 5000,
    handlers: {
      'vscode/editor/getContext': async (_params, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(signal.reason);
        }, { once: true });
      }),
    },
  }).start();
  t.after(() => server.close());

  const peer = client(server.port);
  t.after(() => peer.close());
  peer.send(initializeFrame(server));
  await peer.next();
  peer.send({ jsonrpc: '2.0', id: 'slow', method: 'vscode/editor/getContext', params: {} });
  peer.send({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 'slow' } });
  const cancelled = await peer.next();
  assert.strictEqual(cancelled.error.data.code, 'VSCODE_REQUEST_CANCELLED');
  assert.strictEqual(aborted, true);

  const oversized = client(server.port);
  t.after(() => oversized.close());
  oversized.sendRaw('x'.repeat(VSCODE_MAX_FRAME_BYTES + 1));
  assert.strictEqual((await oversized.next()).error.data.code, 'VSCODE_FRAME_TOO_LARGE');
});

test('VersionedBridgeServer isolates window tokens and closes waiters and sockets', async (t) => {
  const first = await new VersionedBridgeServer({ token: 'a'.repeat(64) }).start();
  const second = await new VersionedBridgeServer({ token: 'b'.repeat(64) }).start();
  t.after(() => Promise.all([first.close(), second.close()]));
  const peer = client(first.port);
  t.after(() => peer.close());
  peer.send(initializeFrame(first, 1, { token: second.token }));
  assert.strictEqual((await peer.next()).error.data.code, 'VSCODE_AUTH_FAILED');

  const waiting = second.waitForInitialized(5000);
  await second.close();
  await assert.rejects(waiting, /closed/);
  assert.strictEqual(second.sockets.size, 0);
  assert.strictEqual(second.connections.size, 0);
});
