'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');

const {
  VSCODE_MAX_FRAME_BYTES,
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
    sendRaw(value) { socket.write(value); },
    async next() {
      while (frames.length === 0) await new Promise((resolve) => waiters.push(resolve));
      return frames.shift();
    },
    close() { socket.destroy(); },
  };
}

function initializeFrame(server, id = 1, protocolVersion = 1, overrides = {}) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      token: server.token,
      protocolVersion,
      clientInfo: { name: 'dsh', version: '0.1.0' },
      ...overrides,
    },
  };
}

function frameOfByteLength(length) {
  const frame = {
    jsonrpc: '2.0',
    id: 'frame-qa',
    method: 'vscode/editor/getContext',
    params: { attachmentIds: [], padding: '' },
  };
  const empty = JSON.stringify(frame);
  const paddingLength = length - Buffer.byteLength(empty, 'utf8');
  if (paddingLength < 0) {
    throw new Error(`frame target ${length} is too small for base request`);
  }
  frame.params.padding = 'x'.repeat(paddingLength);
  const result = JSON.stringify(frame);
  const actual = Buffer.byteLength(result, 'utf8');
  if (actual !== length) {
    throw new Error(`frame construction produced ${actual} bytes, expected ${length}`);
  }
  return result;
}

test('CH1 v2 QA rejects initialize without a token through the existing auth path', async (t) => {
  const server = await new VersionedBridgeServer().start();
  t.after(() => server.close());

  const peer = client(server.port);
  t.after(() => peer.close());
  peer.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: 2,
      clientInfo: { name: 'dsh', version: '0.1.0' },
    },
  });
  const response = await peer.next();
  assert.strictEqual(response.error.data.code, 'VSCODE_AUTH_FAILED');
});

test('CH1 v2 QA rejects initialize without protocolVersion using the same mismatch path', async (t) => {
  const server = await new VersionedBridgeServer().start();
  t.after(() => server.close());

  const peer = client(server.port);
  t.after(() => peer.close());
  peer.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      token: server.token,
      clientInfo: { name: 'dsh', version: '0.1.0' },
    },
  });
  const response = await peer.next();
  assert.strictEqual(response.error.data.code, 'VSCODE_PROTOCOL_MISMATCH');
});

test('CH1 v2 QA rejects non-integer and string protocolVersion values', async (t) => {
  const server = await new VersionedBridgeServer().start();
  t.after(() => server.close());

  for (const protocolVersion of [1.5, '2']) {
    const peer = client(server.port);
    t.after(() => peer.close());
    peer.send(initializeFrame(server, 2, protocolVersion));
    const response = await peer.next();
    assert.strictEqual(
      response.error.data.code,
      'VSCODE_PROTOCOL_MISMATCH',
      `protocolVersion ${String(protocolVersion)} must be rejected`
    );
  }
});

test('CH1 v2 QA enforces the 1MiB frame boundary identically for v1 and v2 requests', async (t) => {
  const server = await new VersionedBridgeServer({
    handlers: {
      'vscode/editor/getContext': async () => ({ ok: true }),
    },
  }).start();
  t.after(() => server.close());

  const v1 = client(server.port);
  t.after(() => v1.close());
  v1.send(initializeFrame(server, 1, 1));
  await v1.next();

  const v2 = client(server.port);
  t.after(() => v2.close());
  v2.send(initializeFrame(server, 2, 2));
  await v2.next();

  const exact = frameOfByteLength(VSCODE_MAX_FRAME_BYTES);
  v1.sendRaw(`${exact}\n`);
  const exactV1 = await v1.next();
  assert.deepStrictEqual(exactV1.result, { ok: true }, 'v1 accepts an exactly max-size request frame');

  v2.sendRaw(`${exact}\n`);
  const exactV2 = await v2.next();
  assert.deepStrictEqual(exactV2.result, { ok: true }, 'v2 accepts an exactly max-size request frame');

  const plusOne = frameOfByteLength(VSCODE_MAX_FRAME_BYTES + 1);
  v1.sendRaw(`${plusOne}\n`);
  const oversizedV1 = await v1.next();
  assert.strictEqual(oversizedV1.error.data.code, 'VSCODE_FRAME_TOO_LARGE');

  v2.sendRaw(`${plusOne}\n`);
  const oversizedV2 = await v2.next();
  assert.strictEqual(oversizedV2.error.data.code, 'VSCODE_FRAME_TOO_LARGE');
});

test('CH1 v2 QA routes only v2 clients to all three metadata notifications in a mixed stream', async (t) => {
  const server = await new VersionedBridgeServer().start();
  t.after(() => server.close());

  const v1 = client(server.port);
  t.after(() => v1.close());
  v1.send(initializeFrame(server, 1, 1));
  await v1.next();

  const v2 = client(server.port);
  t.after(() => v2.close());
  v2.send(initializeFrame(server, 2, 2));
  await v2.next();

  const v2Only = [
    ['vscode/editor/selectionChanged', { uri: 'file:///a.ts', version: 1, attachmentIds: ['ctx-1'] }],
    ['vscode/editor/activeEditorChanged', { uri: 'file:///b.ts' }],
    ['vscode/diagnosticsChanged', { uri: 'file:///c.ts', attachmentIds: ['ctx-2'] }],
  ];
  for (const [method, params] of v2Only) {
    server.notify(method, params);
    const frame = await v2.next();
    assert.strictEqual(frame.method, method);
  }
  assert.strictEqual(v1.frames.length, 0, 'v1 clients must never receive v2-only notifications');

  server.notify('vscode/contextChanged', { revision: 2, attachmentIds: [] });
  assert.strictEqual((await v1.next()).method, 'vscode/contextChanged');
  assert.strictEqual((await v2.next()).method, 'vscode/contextChanged');
});

test(
  'CH1 v2 QA rejects content-bearing v2 notification payloads via schema (QA finding B3-01)',
  async (t) => {
    const server = await new VersionedBridgeServer().start();
    t.after(() => server.close());

    const v2 = client(server.port);
    t.after(() => v2.close());
    v2.send(initializeFrame(server, 1, 2));
    await v2.next();

    const payloads = [
      {
        method: 'vscode/editor/selectionChanged',
        params: { uri: 'file:///a.ts', version: 1, attachmentIds: ['ctx-1'], content: 'selection body should be rejected' },
      },
      {
        method: 'vscode/editor/activeEditorChanged',
        params: { uri: 'file:///b.ts', body: 'editor body should be rejected' },
      },
      {
        method: 'vscode/diagnosticsChanged',
        params: { uri: 'file:///c.ts', attachmentIds: ['ctx-2'], content: 'diagnostics body should be rejected' },
      },
    ];
    for (const { method, params } of payloads) {
      const before = v2.frames.length;
      assert.throws(() => server.notify(method, params), /schema|content|body/);
      assert.strictEqual(v2.frames.length, before, `no content payload should reach v2 for ${method}`);
    }
  }
);