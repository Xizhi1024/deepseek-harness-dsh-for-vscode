'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const { createStdioMcpClient } = require('../../src/mcp/transportStdio');
const { createHttpMcpClient, parseSsePayload } = require('../../src/mcp/transportHttp');
const { createMcpManager } = require('../../src/mcp/manager');
const { createConsentGate } = require('../../src/mcp/consent');

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = { destroyed: false, written: '', write(line) { this.written += line; } };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.emit('exit', 0, 'SIGTERM');
  };
  return child;
}

function writeLineToChild(child, message) {
  child.stdout.emit('data', Buffer.from(JSON.stringify(message) + '\n'));
}

function lastRequest(child) {
  const lines = child.stdin.written.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

function respondToLast(child, result) {
  const request = lastRequest(child);
  writeLineToChild(child, { jsonrpc: '2.0', id: request.id, result });
}

test('stdio transport initializes, notifies initialized and round-trips requests', async () => {
  const child = fakeChild();
  const client = createStdioMcpClient({
    server: { name: 's1', type: 'stdio', command: 'node', args: ['server.js'] },
    spawn: () => child,
    env: {},
  });
  const starting = client.start();
  await new Promise((resolve) => setImmediate(resolve));
  respondToLast(child, { protocolVersion: '2024-11-05', capabilities: { tools: {} } });
  const init = await starting;
  assert.strictEqual(init.protocolVersion, '2024-11-05');
  assert.ok(child.stdin.written.includes('notifications/initialized'));

  const pending = client.request('tools/list', {});
  await new Promise((resolve) => setImmediate(resolve));
  respondToLast(child, { tools: [{ name: 'tool-a' }] });
  const page = await pending;
  assert.deepStrictEqual(page.tools, [{ name: 'tool-a' }]);

  client.dispose();
  assert.strictEqual(child.killed, true);
});

test('http transport parses JSON and SSE responses and preserves the session header', async () => {
  const server = { name: 's2', type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { 'X-Test': 'yes' } };
  let calls = 0;
  const client = createHttpMcpClient({
    server,
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.strictEqual(options.headers['X-Test'], 'yes');
      if (calls === 1) {
        return {
          ok: true,
          headers: { get: (key) => (key === 'mcp-session-id' ? 'sess-1' : 'application/json') },
          async json() {
            return { jsonrpc: '2.0', id: JSON.parse(options.body).id, result: { protocolVersion: '2024-11-05' } };
          },
        };
      }
      return {
        ok: true,
        headers: { get: (key) => (key === 'mcp-session-id' ? null : 'text/event-stream') },
        async text() {
          const id = JSON.parse(options.body).id;
          return `data: ${JSON.stringify({ jsonrpc: '2.0', id, result: { tools: [{ name: 'http-tool' }] } })}\n\n`;
        },
      };
    },
  });
  await client.start();
  const page = await client.request('tools/list', {});
  assert.deepStrictEqual(page.tools, [{ name: 'http-tool' }]);
  client.dispose();
  assert.deepStrictEqual(parseSsePayload('data: {"a":1}\n\n'), [{ a: 1 }]);
});

function fakeVscode() {
  return {
    window: {
      async showInputBox() { return 'typed'; },
    },
  };
}

function consentingGate() {
  return {
    isConsented() { return true; },
    async ensureConsent() { return true; },
    forget() {},
  };
}

function managerSpawn(servers = []) {
  return (command, args, options) => {
    const child = fakeChild();
    const server = { child };
    servers.push(server);
    return child;
  };
}

test('mcp manager listServers/listTools/callTool drives a stdio server', async () => {
  const children = [];
  const manager = createMcpManager({
    vscode: fakeVscode(),
    env: { TOKEN: 'tok' },
    getSources: async () => [{
      source: 'user',
      servers: [{ name: 'demo', type: 'stdio', command: 'node', args: ['server.js'], env: { TOKEN: '${env:TOKEN}' } }],
    }],
    consentGate: consentingGate(),
    spawn: (command, args, options) => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
  });

  const list = await manager.listServers();
  assert.strictEqual(list.servers[0].name, 'demo');
  assert.strictEqual(list.servers[0].state, 'ready');

  const toolsPromise = manager.listTools('demo');
  await new Promise((resolve) => setImmediate(resolve));
  const child = children[0];
  respondToLast(child, { protocolVersion: '2024-11-05', capabilities: { tools: {} } });
  await new Promise((resolve) => setImmediate(resolve));
  respondToLast(child, { tools: [{ name: 'echo' }], nextCursor: 'page-2' });
  await new Promise((resolve) => setImmediate(resolve));
  respondToLast(child, { tools: [{ name: 'late' }] });
  const tools = await toolsPromise;
  assert.deepStrictEqual(tools.tools.map((tool) => tool.name), ['echo', 'late']);

  const callPromise = manager.callTool('demo', 'echo', { text: 'hi' });
  await new Promise((resolve) => setImmediate(resolve));
  respondToLast(child, { content: [{ type: 'text', text: 'hi back' }], isError: false });
  const call = await callPromise;
  assert.strictEqual(call.content[0].text, 'hi back');

  manager.dispose();
  assert.strictEqual(child.killed, true);
});

test('mcp manager truncates oversized callTool results to 1 MiB', async () => {
  const children = [];
  const manager = createMcpManager({
    vscode: fakeVscode(),
    env: {},
    getSources: async () => [{
      source: 'user',
      servers: [{ name: 'big', type: 'stdio', command: 'node', args: [] }],
    }],
    consentGate: consentingGate(),
    spawn: (command, args, options) => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
  });
  await manager.listServers();
  const callPromise = manager.callTool('big', 'huge', {});
  await new Promise((resolve) => setImmediate(resolve));
  const child = children[0];
  respondToLast(child, { protocolVersion: '2024-11-05', capabilities: {} });
  await new Promise((resolve) => setImmediate(resolve));
  respondToLast(child, { content: [{ type: 'text', text: 'x'.repeat(1024 * 1024 + 500) }] });
  const result = await callPromise;
  assert.strictEqual(result.truncated, true);
  assert.ok(JSON.stringify(result).length <= 1024 * 1024 + 200);
  manager.dispose();
});

// ---- C3: MCP env keys resolve from secretStorage first (zero typing) -------

function memorySecrets(initial = {}) {
  const store = { ...initial };
  return {
    store,
    async get(key) { return store[key]; },
    async set(key, value) { store[key] = value; },
    async delete(key) { delete store[key]; },
  };
}

function serverNeedingKey(key) {
  return [{
    source: 'user',
    servers: [{ name: 'demo', type: 'stdio', command: 'node', args: [], env: { [key]: '${input:' + key + '}' } }],
  }];
}

const { isSecretKeyName } = require('../../src/mcp/manager');

test('C3: a same-name secretStorage hit skips the prompt entirely', async () => {
  const prompts = [];
  const fake = { window: { async showInputBox(options) { prompts.push(options); return 'typed'; } } };
  const secrets = memorySecrets({ OPENAI_API_KEY: 'stored-key' });
  const manager = createMcpManager({
    vscode: fake,
    env: {},
    getSources: async () => serverNeedingKey('OPENAI_API_KEY'),
    consentGate: consentingGate(),
    spawn: () => fakeChild(),
    secretStorage: secrets,
  });
  const list = await manager.listServers();
  assert.strictEqual(list.servers[0].state, 'ready', 'env expanded from secretStorage');
  assert.strictEqual(prompts.length, 0, 'no prompt when the secret store already knows the key');
  manager.dispose();
});

test('C3: a miss prompts password-masked for KEY/TOKEN/SECRET names and stores back', async () => {
  const prompts = [];
  const fake = { window: { async showInputBox(options) { prompts.push(options); return 'typed-once'; } } };
  const secrets = memorySecrets();
  const manager = createMcpManager({
    vscode: fake,
    env: {},
    getSources: async () => serverNeedingKey('GITHUB_TOKEN'),
    consentGate: consentingGate(),
    spawn: () => fakeChild(),
    secretStorage: secrets,
  });
  const list = await manager.listServers();
  assert.strictEqual(list.servers[0].state, 'ready');
  assert.strictEqual(prompts.length, 1);
  assert.strictEqual(prompts[0].password, true, 'credential-looking keys prompt masked');
  assert.strictEqual(secrets.store.GITHUB_TOKEN, 'typed-once', 'the answered value is persisted for next time');
  manager.dispose();
});

test('C3: non-secret key names prompt unmasked; isSecretKeyName covers the usual substrings', async () => {
  const prompts = [];
  const fake = { window: { async showInputBox(options) { prompts.push(options); return 'v'; } } };
  const manager = createMcpManager({
    vscode: fake,
    env: {},
    getSources: async () => serverNeedingKey('REGION'),
    consentGate: consentingGate(),
    spawn: () => fakeChild(),
    secretStorage: memorySecrets(),
  });
  const list = await manager.listServers();
  assert.strictEqual(list.servers[0].state, 'ready');
  assert.strictEqual(prompts[0].password, false, 'REGION is not masked');
  manager.dispose();

  assert.strictEqual(isSecretKeyName('OPENAI_API_KEY'), true);
  assert.strictEqual(isSecretKeyName('github-token'), true);
  assert.strictEqual(isSecretKeyName('Client_Secret'), true);
  assert.strictEqual(isSecretKeyName('DB_PASSWORD'), true);
  assert.strictEqual(isSecretKeyName('region'), false);
  assert.strictEqual(isSecretKeyName(''), false);
});
