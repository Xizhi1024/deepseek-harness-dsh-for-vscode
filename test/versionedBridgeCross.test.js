'use strict';

// Cross-pairing regression: the REAL VersionedBridgeServer against the REAL
// integration-package bridge client (tools.js). Both sides were previously
// only tested against fakes, which is exactly how the v3 initialize crash
// shipped: the server threw on the notifications table, the void-ed async
// dispatch swallowed it, and the client hung waiting for a reply.

const assert = require('node:assert/strict');
const test = require('node:test');

const { VersionedBridgeServer } = require('../src/versionedBridgeServer');
const { NOTIFICATIONS_BY_VERSION } = require('../src/protocol/ch1');

test('notification tables cover every advertised protocol version', () => {
  for (const version of [1, 2, 3]) {
    assert.ok(
      Array.isArray(NOTIFICATIONS_BY_VERSION[version]),
      'NOTIFICATIONS_BY_VERSION must cover protocol v' + version,
    );
  }
  assert.deepStrictEqual(
    NOTIFICATIONS_BY_VERSION[3],
    [...NOTIFICATIONS_BY_VERSION[2], 'vscode/dshEditObserved'],
    'v3 carries the v2 push set plus the C2 edit-observation notification',
  );
});

test('real server x real integration client: initialize answers and tools register', async () => {
  const handlers = {
    'vscode/editor/getContext': async () => ({ ok: true }),
    'vscode/workspace/findFiles': async () => ({ files: [] }),
  };
  const server = new VersionedBridgeServer({ handlers, serverVersion: 'cross-test' });
  await server.start();
  const [{ createBridgeTools }, net] = await Promise.all([
    import('../runtime-integration/dsh-vscode-integration/lib/tools.js'),
    import('node:net'),
  ]);

  const registered = [];
  const ctx = {
    tools: {
      register(tool) { registered.push(tool); return () => {}; },
    },
  };
  const client = createBridgeTools({
    env: { ...server.env },
    ctx,
    net,
    version: 'cross-test',
    backoffMs: [50, 50, 50],
    log: () => {},
  });
  const handle = client.start();
  assert.strictEqual(handle.running, true);

  try {
    const deadline = Date.now() + 5000;
    while (registered.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const names = registered.map((tool) => tool && tool.name).sort();
    assert.deepStrictEqual(names, ['vscode_editor_get_context', 'vscode_workspace_find_files']);

    // Round-trip one real request through the real pair.
    const tool = registered.find((entry) => entry && entry.name === 'vscode_editor_get_context');
    const result = await tool.execute({}, {});
    assert.deepStrictEqual(result, { ok: true });
  } finally {
    handle.stop();
    await server.close();
  }
});

test('a crash inside frame dispatch still answers with a JSON-RPC error (no silent hang)', async () => {
  class ExplodingServer extends VersionedBridgeServer {
    _initialize() { throw new Error('boom'); }
  }
  const server = new ExplodingServer({ handlers: {}, serverVersion: 'cross-test' });
  await server.start();
  const net = await import('node:net');

  const socket = net.connect(server.port, '127.0.0.1');
  await new Promise((resolve) => socket.once('connect', resolve));
  try {
    socket.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'initialize', params: {} }) + '\n');

    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no reply within 3s')), 3000);
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += String(chunk);
        const newline = buffer.indexOf('\n');
        if (newline >= 0) {
          clearTimeout(timer);
          resolve(JSON.parse(buffer.slice(0, newline)));
        }
      });
    });
    assert.strictEqual(reply.id, 7, 'the error frame answers the request id');
    assert.strictEqual(reply.error.data.code, 'VSCODE_INTERNAL_ERROR');
  } finally {
    socket.destroy();
    await server.close();
  }
});
