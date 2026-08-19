import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import {
  bridgeEnv,
  bridgeTimeoutMs,
  createBridgeTools,
  jsonRpcError,
  toolNameFor,
} from '../lib/tools.js';

function fakeCtx() {
  const registered = [];
  const ctx = {
    tools: {
      register(tool) {
        const record = {
          name: tool && tool.name,
          tool,
          disposed: false,
          dispose() {
            record.disposed = true;
          },
        };
        registered.push(record);
        return () => record.dispose();
      },
      defineTool(tool) {
        return { ...tool, defined: true };
      },
    },
    _registered: registered,
  };
  return ctx;
}

function waitFor(check, timeoutMs = 2000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let value;
      try {
        value = check();
      } catch (error) {
        reject(error);
        return;
      }
      if (value) {
        resolve(value);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('waitFor timeout'));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

/**
 * Start a small newline-delimited JSON-RPC bridge fake. `onMessage` may write
 * responses by returning them; it may also be async.
 */
async function startBridgeServer(t, onMessage) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          newline = buffer.indexOf('\n');
          continue;
        }
        const reply = onMessage(message, socket);
        if (reply !== undefined && reply !== null) {
          socket.write(JSON.stringify(reply) + '\n');
        }
        newline = buffer.indexOf('\n');
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return server;
}

function initializeReply(message, methods) {
  if (message.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: { protocolVersion: 3, methods },
    };
  }
  return undefined;
}

test('bridgeEnv: missing or invalid env disables the bridge', () => {
  assert.deepStrictEqual(bridgeEnv({}), { ok: false, reason: 'env-missing' });
  assert.deepStrictEqual(bridgeEnv({ DSH_VSCODE_BRIDGE_PORT: '1' }), { ok: false, reason: 'env-missing' });
  assert.deepStrictEqual(bridgeEnv({ DSH_VSCODE_BRIDGE_TOKEN: 't' }), { ok: false, reason: 'env-missing' });
  assert.deepStrictEqual(bridgeEnv({ DSH_VSCODE_BRIDGE_PORT: '0', DSH_VSCODE_BRIDGE_TOKEN: 't' }), { ok: false, reason: 'env-missing' });
  assert.deepStrictEqual(bridgeEnv({ DSH_VSCODE_BRIDGE_HOST: 'example.com', DSH_VSCODE_BRIDGE_PORT: '1', DSH_VSCODE_BRIDGE_TOKEN: 't' }), { ok: false, reason: 'env-invalid-host' });
  assert.deepStrictEqual(bridgeEnv({ DSH_VSCODE_BRIDGE_PORT: '3080', DSH_VSCODE_BRIDGE_TOKEN: 't' }), {
    ok: true,
    host: '127.0.0.1',
    port: 3080,
    token: 't',
    protocol: '3',
  });
});

test('toolNameFor: derives snake_case DSH tool names from advertised bridge methods', () => {
  assert.strictEqual(toolNameFor('vscode/terminal/create'), 'vscode_terminal_create');
  assert.strictEqual(toolNameFor('vscode/confirm/ask'), 'vscode_confirm_ask');
  assert.strictEqual(toolNameFor('vscode/mcp/listServers'), 'vscode_mcp_list_servers');
  assert.strictEqual(toolNameFor('vscode/mcp/listTools'), 'vscode_mcp_list_tools');
  assert.strictEqual(toolNameFor('vscode/mcp/callTool'), 'vscode_mcp_call_tool');
  assert.strictEqual(toolNameFor('vscode/editor/getContext'), 'vscode_editor_get_context');
  assert.strictEqual(toolNameFor('vscode/editor/openDiff'), 'vscode_editor_open_diff');
});

test('bridgeTimeoutMs: confirm/ask, changes/push and mcp/callTool get the 120s fail-closed timeout', () => {
  assert.strictEqual(bridgeTimeoutMs('vscode/confirm/ask'), 120000);
  assert.strictEqual(bridgeTimeoutMs('vscode/changes/push'), 120000);
  assert.strictEqual(bridgeTimeoutMs('vscode/mcp/callTool'), 120000);
  assert.strictEqual(bridgeTimeoutMs('vscode/tasks/list'), 15000);
});

test('createBridgeTools: env missing => running:false, zero registration, zero errors', () => {
  const ctx = fakeCtx();
  const bridge = createBridgeTools({ env: {}, ctx, net });
  const started = bridge.start();
  assert.deepStrictEqual(started, { running: false, reason: 'env-missing' });
  assert.strictEqual(ctx._registered.length, 0);
});

test('createBridgeTools: initialize negotiates v3 and registers only advertised methods', async (t) => {
  const server = await startBridgeServer(t, (message) => initializeReply(
    message,
    ['vscode/tasks/list', 'vscode/confirm/ask'],
  ));
  const ctx = fakeCtx();
  const bridge = createBridgeTools({
    env: { DSH_VSCODE_BRIDGE_PORT: String(server.address().port), DSH_VSCODE_BRIDGE_TOKEN: 'secret' },
    ctx,
    net,
    backoffMs: [5, 5, 5, 5],
  });
  const started = bridge.start();
  assert.strictEqual(started.running, true);
  const records = await waitFor(() => (ctx._registered.length >= 2 ? ctx._registered : null));
  const names = records.map((record) => record.name).sort();
  assert.deepStrictEqual(names, ['vscode_confirm_ask', 'vscode_tasks_list']);
  started.stop();
});

test('createBridgeTools: request/response round trip and error mapping', async (t) => {
  const server = await startBridgeServer(t, (message) => {
    const init = initializeReply(message, ['vscode/tasks/list']);
    if (init) return init;
    if (message.method === 'vscode/tasks/list' && message.id !== undefined) {
      return { jsonrpc: '2.0', id: message.id, result: { tasks: [{ name: 'build' }] } };
    }
    return undefined;
  });
  const ctx = fakeCtx();
  const bridge = createBridgeTools({
    env: { DSH_VSCODE_BRIDGE_PORT: String(server.address().port), DSH_VSCODE_BRIDGE_TOKEN: 'secret' },
    ctx,
    net,
    backoffMs: [5, 5, 5, 5],
  });
  const started = bridge.start();
  const records = await waitFor(() => (ctx._registered.length >= 1 ? ctx._registered : null));
  const result = await records[0].tool.execute({ name: 'build' });
  assert.deepStrictEqual(result, { tasks: [{ name: 'build' }] });
  started.stop();
});

test('createBridgeTools: bridge errors surface as {code, message} to the model', async (t) => {
  const server = await startBridgeServer(t, (message) => {
    const init = initializeReply(message, ['vscode/tasks/list']);
    if (init) return init;
    if (message.method === 'vscode/tasks/list' && message.id !== undefined) {
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: 'VSCODE_TASK_NOT_FOUND', message: 'Workspace task not found: build' },
      };
    }
    return undefined;
  });
  const ctx = fakeCtx();
  const bridge = createBridgeTools({
    env: { DSH_VSCODE_BRIDGE_PORT: String(server.address().port), DSH_VSCODE_BRIDGE_TOKEN: 'secret' },
    ctx,
    net,
    backoffMs: [5, 5, 5, 5],
  });
  const started = bridge.start();
  const records = await waitFor(() => (ctx._registered.length >= 1 ? ctx._registered : null));
  await assert.rejects(
    records[0].tool.execute({ name: 'build' }),
    (error) => error && error.code === 'VSCODE_TASK_NOT_FOUND' && /build/.test(error.message),
  );
  started.stop();
});

test('createBridgeTools: AbortSignal forwards $/cancelRequest and rejects with VSCODE_ABORTED', async (t) => {
  const cancels = [];
  const server = await startBridgeServer(t, (message) => {
    const init = initializeReply(message, ['vscode/tasks/list']);
    if (init) return init;
    if (message.method === '$/cancelRequest') {
      cancels.push(message.params.id);
      return undefined;
    }
    if (message.method === 'vscode/tasks/list' && message.id !== undefined) {
      // Deliberately never answer; the abort path must settle it.
      return undefined;
    }
    return undefined;
  });
  const ctx = fakeCtx();
  const bridge = createBridgeTools({
    env: { DSH_VSCODE_BRIDGE_PORT: String(server.address().port), DSH_VSCODE_BRIDGE_TOKEN: 'secret' },
    ctx,
    net,
    backoffMs: [5, 5, 5, 5],
  });
  const started = bridge.start();
  const records = await waitFor(() => (ctx._registered.length >= 1 ? ctx._registered : null));
  const controller = new AbortController();
  const pending = records[0].tool.execute({ name: 'build' }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error && error.code === 'VSCODE_ABORTED');
  await waitFor(() => (cancels.length >= 1 ? cancels : null));
  started.stop();
});

test('createBridgeTools: reconnect re-initializes and swaps the tool generation', async (t) => {
  let firstConnection = true;
  let firstSocket = null;
  const server = await startBridgeServer(t, (message, socket) => {
    const init = initializeReply(
      message,
      firstConnection ? ['vscode/tasks/list'] : ['vscode/tasks/list', 'vscode/git/getStatus'],
    );
    if (init) {
      if (firstConnection) firstSocket = socket;
      firstConnection = false;
      return init;
    }
    return undefined;
  });
  const ctx = fakeCtx();
  const bridge = createBridgeTools({
    env: { DSH_VSCODE_BRIDGE_PORT: String(server.address().port), DSH_VSCODE_BRIDGE_TOKEN: 'secret' },
    ctx,
    net,
    backoffMs: [5, 5, 5, 5],
  });
  const started = bridge.start();
  const firstRecords = await waitFor(() => (ctx._registered.length >= 1 ? ctx._registered : null));
  assert.deepStrictEqual(firstRecords.map((record) => record.name), ['vscode_tasks_list']);
  firstSocket.destroy();
  await waitFor(() => (ctx._registered.length >= 3 ? ctx._registered : null));
  const names = ctx._registered.map((record) => record.name).sort();
  assert.deepStrictEqual(names, ['vscode_git_get_status', 'vscode_tasks_list', 'vscode_tasks_list']);
  assert.strictEqual(ctx._registered[0].disposed, true, 'old generation must be disposed after the swap');
  assert.strictEqual(ctx._registered[1].disposed, false);
  assert.strictEqual(ctx._registered[2].disposed, false);
  started.stop();
});

test('jsonRpcError carries a machine-readable code', () => {
  const error = jsonRpcError('VSCODE_TIMEOUT', 'too slow');
  assert.strictEqual(error.code, 'VSCODE_TIMEOUT');
  assert.strictEqual(error.message, 'too slow');
});
