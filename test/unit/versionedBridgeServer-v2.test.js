'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');

const {
  VersionedBridgeServer,
} = require('../../src/versionedBridgeServer');

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
    frames,
    send(frame) { socket.write(`${JSON.stringify(frame)}\n`); },
    async next() {
      while (frames.length === 0) await new Promise((resolve) => waiters.push(resolve));
      return frames.shift();
    },
    close() { socket.destroy(); },
  };
}

function initializeFrame(server, id = 1, protocolVersion = 1) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      token: server.token,
      protocolVersion,
      clientInfo: { name: 'dsh', version: '0.1.0' },
    },
  };
}

test('CH1 v2 server serves v1 and v2 clients on one instance with trimmed capabilities', async (t) => {
  const server = await new VersionedBridgeServer({
    workspace: { windowId: 'w', trusted: true, kind: 'local', folders: [] },
    handlers: {
      'vscode/editor/getContext': async () => ({ revision: 1, attachments: [] }),
      'vscode/extensions/openDetails': async () => ({ opened: true }),
    },
  }).start();
  t.after(() => server.close());

  const v1 = client(server.port);
  t.after(() => v1.close());
  v1.send(initializeFrame(server, 1, 1));
  const v1Init = await v1.next();
  assert.strictEqual(v1Init.result.protocolVersion, 1);
  assert.strictEqual(v1Init.result.acceptedProtocolVersion, undefined, 'v1 wire payload stays unchanged');
  assert.deepStrictEqual(v1Init.result.methods, [
    'vscode/editor/getContext',
    'vscode/extensions/openDetails',
  ]);
  assert.deepStrictEqual(v1Init.result.notifications, [
    'vscode/contextChanged',
    'vscode/providerStatesChanged',
    'vscode/workspaceChanged',
  ]);

  const v2 = client(server.port);
  t.after(() => v2.close());
  v2.send(initializeFrame(server, 2, 2));
  const v2Init = await v2.next();
  assert.strictEqual(v2Init.result.protocolVersion, 2);
  assert.strictEqual(v2Init.result.acceptedProtocolVersion, 2);
  assert.deepStrictEqual(v2Init.result.methods, [
    'vscode/editor/getContext',
    'vscode/extensions/openDetails',
  ]);
  assert.deepStrictEqual(v2Init.result.notifications, [
    'vscode/contextChanged',
    'vscode/providerStatesChanged',
    'vscode/workspaceChanged',
    'vscode/editor/selectionChanged',
    'vscode/editor/activeEditorChanged',
    'vscode/diagnosticsChanged',
  ]);

  assert.strictEqual(server.hasProtocolVersion(1), true);
  assert.strictEqual(server.hasProtocolVersion(2), true);
  assert.strictEqual(server.hasV2Clients(), true);

  server.notify('vscode/editor/selectionChanged', {
    uri: 'file:///a.ts',
    version: 3,
    attachmentIds: ['ctx-1'],
  });
  assert.deepStrictEqual((await v2.next()).method, 'vscode/editor/selectionChanged');
  assert.strictEqual(v1.frames.length, 0, 'v1 clients must not receive v2-only notifications');

  server.notify('vscode/contextChanged', { revision: 2, attachmentIds: [] });
  assert.deepStrictEqual((await v1.next()).method, 'vscode/contextChanged');
  assert.deepStrictEqual((await v2.next()).method, 'vscode/contextChanged');
});

test('CH1 v2 server rejects protocol versions outside the host set', async (t) => {
  const server = await new VersionedBridgeServer({ protocolVersions: [1] }).start();
  t.after(() => server.close());

  const peer = client(server.port);
  t.after(() => peer.close());
  peer.send(initializeFrame(server, 1, 2));
  assert.strictEqual((await peer.next()).error.data.code, 'VSCODE_PROTOCOL_MISMATCH');
});

test('CH1 v2 server rejects an empty protocolVersions set at construction', () => {
  assert.throws(
    () => new VersionedBridgeServer({ protocolVersions: [] }),
    /non-empty/
  );
});
