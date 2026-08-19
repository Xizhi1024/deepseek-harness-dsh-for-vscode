'use strict';

/**
 * S2b-0 spike: verify a zero-dependency, newline-delimited JSON-RPC stdio MCP
 * client is sufficient for the bridge surface (initialize, tools/list with
 * pagination, tools/call). This test is protocol-only and runs in-process —
 * the sandbox forbids spawning npm/npx child processes, so no real MCP server
 * is launched here.
 *
 * Verdict: PASS. The protocol surface MCP consume needs is exactly three
 * JSON-RPC methods; the framing below is ~40 lines and needs no SDK.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const MCP_VERSION = '2024-11-05';

function rpcRequest(id, method, params = {}) {
  return { jsonrpc: '2.0', id, method, params };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function encodeFrame(message) {
  return JSON.stringify(message) + '\n';
}

function decodeFrame(line) {
  if (typeof line !== 'string' || line.trim().length === 0) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

class FakeStdioServer {
  constructor(handlers) {
    this.emitter = new EventEmitter();
    this.handlers = handlers;
  }

  send(message) {
    this.emitter.emit('data', Buffer.from(encodeFrame(message)));
  }

  receive(frame) {
    const handler = this.handlers[frame.method];
    if (handler) handler(frame, this);
  }
}

class MinimalMcpClient {
  constructor(server) {
    this.server = server;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    server.emitter.on('data', (chunk) => this.handleData(chunk));
  }

  send(message) {
    this.server.receive(message);
  }

  handleData(chunk) {
    this.buffer += String(chunk);
    const newline = this.buffer.indexOf('\n');
    if (newline === -1) return;
    const frame = decodeFrame(this.buffer.slice(0, newline));
    this.buffer = this.buffer.slice(newline + 1);
    if (!frame || frame.id === undefined) return;
    const waiter = this.pending.get(frame.id);
    if (!waiter) return;
    this.pending.delete(frame.id);
    if (frame.error) waiter.reject(new Error(frame.error.message || JSON.stringify(frame.error)));
    else waiter.resolve(frame.result);
  }

  request(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send(rpcRequest(id, method, params));
    });
  }
}

test('S2b-0 spike: initialize negotiates the MCP protocol version', async () => {
  const server = new FakeStdioServer({
    initialize(frame, server) {
      const params = frame.params || {};
      assert.strictEqual(params.protocolVersion, MCP_VERSION);
      server.send(rpcResult(frame.id, {
        protocolVersion: MCP_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp', version: '0.0.1' },
      }));
    },
  });
  const client = new MinimalMcpClient(server);
  const result = await client.request('initialize', {
    protocolVersion: MCP_VERSION,
    capabilities: {},
    clientInfo: { name: 'dsh-vs-sidebar-spike', version: '0.0.1' },
  });
  assert.strictEqual(result.protocolVersion, MCP_VERSION);
  assert.strictEqual(result.serverInfo.name, 'fake-mcp');
});

test('S2b-0 spike: tools/list pagination is a plain cursor loop', async () => {
  let calls = 0;
  const server = new FakeStdioServer({
    initialize(frame, server) {
      server.send(rpcResult(frame.id, { protocolVersion: MCP_VERSION, capabilities: { tools: {} } }));
    },
    'tools/list'(frame, server) {
      calls += 1;
      if (calls === 1) {
        server.send(rpcResult(frame.id, {
          tools: [{ name: 'tool-a' }],
          nextCursor: 'page-2',
        }));
      } else {
        server.send(rpcResult(frame.id, {
          tools: [{ name: 'tool-b' }],
        }));
      }
    },
  });
  const client = new MinimalMcpClient(server);
  await client.request('initialize', { protocolVersion: MCP_VERSION, capabilities: {} });
  const tools = [];
  let cursor;
  do {
    const page = await client.request('tools/list', cursor ? { cursor } : {});
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepStrictEqual(tools.map((tool) => tool.name), ['tool-a', 'tool-b']);
  assert.strictEqual(calls, 2);
});

test('S2b-0 spike: tools/call returns result and surfaces JSON-RPC errors', async () => {
  const server = new FakeStdioServer({
    initialize(frame, server) {
      server.send(rpcResult(frame.id, { protocolVersion: MCP_VERSION, capabilities: { tools: {} } }));
    },
    'tools/call'(frame, server) {
      if (frame.params.name === 'boom') {
        server.send(rpcError(frame.id, -32000, 'tool exploded'));
        return;
      }
      server.send(rpcResult(frame.id, {
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      }));
    },
  });
  const client = new MinimalMcpClient(server);
  await client.request('initialize', { protocolVersion: MCP_VERSION, capabilities: {} });
  const ok = await client.request('tools/call', { name: 'echo', arguments: { value: 1 } });
  assert.deepStrictEqual(ok.content, [{ type: 'text', text: 'ok' }]);
  await assert.rejects(client.request('tools/call', { name: 'boom', arguments: {} }), /tool exploded/);
});
