import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { MAX_MCP_BODY_BYTES, createMcpRoute } from '../lib/mcpRoute.js';

function fakeRequest(method, headers, body) {
  const stream = Readable.from(body === undefined ? [] : [body]);
  stream.method = method;
  stream.headers = headers;
  return stream;
}

function fakeResponse() {
  const response = {
    status: null,
    body: '',
    headers: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers || null;
    },
    end(payload) {
      this.body = payload === undefined ? '' : String(payload);
      if (this._done) this._done();
    },
  };
  response.finished = new Promise((resolve) => { response._done = resolve; });
  return response;
}

function fakeWebServer() {
  const registered = [];
  return {
    registered,
    register({ path: routePath, handler }) {
      const entry = { path: routePath, handler, disposed: false };
      registered.push(entry);
      return () => { entry.disposed = true; };
    },
  };
}

async function call(handler, method, headers, body) {
  const response = fakeResponse();
  await handler(fakeRequest(method, headers, body), response);
  await Promise.race([
    response.finished,
    new Promise((resolve) => setTimeout(resolve, 500)),
  ]);
  let json = null;
  try { json = response.body ? JSON.parse(response.body) : null; } catch { /* non-JSON */ }
  return { status: response.status, json };
}

function authed(token) {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

function fakeBridge(result = { mounted: [], removed: [], rejected: [], active: 0 }) {
  const calls = [];
  return {
    calls,
    async apply(servers) {
      calls.push(servers);
      return result;
    },
  };
}

test('createMcpRoute requires ctx.webServer.register and a bridge', () => {
  assert.throws(() => createMcpRoute({ ctx: {} }), TypeError);
  assert.throws(() => createMcpRoute({ ctx: { webServer: fakeWebServer() } }), TypeError);
});

test('mounts exactly one exact route at /api/vscode/mcp', () => {
  const webServer = fakeWebServer();
  const route = createMcpRoute({ ctx: { webServer }, token: 'cfg', bridge: fakeBridge() });
  assert.strictEqual(route.running, true);
  assert.strictEqual(webServer.registered.length, 1);
  assert.strictEqual(webServer.registered[0].path, '/api/vscode/mcp');
});

test('an instance without a configure token always answers 401', async () => {
  const webServer = fakeWebServer();
  createMcpRoute({ ctx: { webServer }, token: '', bridge: fakeBridge() });
  const result = await call(webServer.registered[0].handler, 'POST', authed('anything'), '{}');
  assert.strictEqual(result.status, 401);
});

test('wrong bearer is 401; GET is 405; bad JSON is 400; unknown fields are 400', async () => {
  const webServer = fakeWebServer();
  createMcpRoute({ ctx: { webServer }, token: 'cfg', bridge: fakeBridge() });
  const handler = webServer.registered[0].handler;
  assert.strictEqual((await call(handler, 'POST', authed('wrong'), '{}')).status, 401);
  assert.strictEqual((await call(handler, 'GET', authed('cfg'), undefined)).status, 405);
  assert.strictEqual((await call(handler, 'POST', authed('cfg'), '{oops')).status, 400);
  assert.strictEqual((await call(handler, 'POST', authed('cfg'), JSON.stringify({ nope: [] }))).status, 400);
  assert.strictEqual((await call(handler, 'POST', authed('cfg'), JSON.stringify({ servers: 'nope' }))).status, 400);
});

test('an authorized push hands the servers to the bridge and answers the result', async () => {
  const webServer = fakeWebServer();
  const bridge = fakeBridge({ mounted: ['a'], removed: [], rejected: [], active: 1 });
  createMcpRoute({ ctx: { webServer }, token: 'cfg', bridge });
  const servers = [{ name: 'a', type: 'stdio', command: 'node' }];
  const result = await call(webServer.registered[0].handler, 'POST', authed('cfg'), JSON.stringify({ servers }));
  assert.strictEqual(result.status, 200);
  assert.deepStrictEqual(result.json.applied, { mounted: ['a'], removed: [], rejected: [], active: 1, sources: 1 });
  assert.deepStrictEqual(bridge.calls, [servers]);
});

test('shared instances merge per-window sources and let a disabled window keep others', async () => {
  const webServer = fakeWebServer();
  const bridge = fakeBridge();
  createMcpRoute({
    ctx: { webServer },
    token: 'cfg',
    bridge,
    initialServers: [{ name: 'boot', type: 'stdio', command: 'node' }],
  });
  const handler = webServer.registered[0].handler;
  const push = (body) => call(handler, 'POST', authed('cfg'), JSON.stringify(body));

  // A disabled window never clears the boot baseline.
  let result = await push({ windowId: 'w1', enabled: false, servers: [] });
  assert.strictEqual(result.status, 200);
  assert.deepStrictEqual(bridge.calls.at(-1).map((server) => server.name), ['boot']);

  // The first enabled window replaces the boot baseline with its snapshot.
  await push({ windowId: 'w2', enabled: true, servers: [{ name: 'b', type: 'stdio', command: 'node' }] });
  assert.deepStrictEqual(bridge.calls.at(-1).map((server) => server.name), ['b']);

  // Another window contributes its own server; both are mounted.
  await push({ windowId: 'w3', enabled: true, servers: [{ name: 'c', type: 'http', url: 'http://127.0.0.1:1/mcp' }] });
  assert.deepStrictEqual(bridge.calls.at(-1).map((server) => server.name).sort(), ['b', 'c']);

  // Disabling one window removes only its own contribution.
  result = await push({ windowId: 'w3', enabled: false, servers: [] });
  assert.deepStrictEqual(bridge.calls.at(-1).map((server) => server.name), ['b']);
  assert.strictEqual(result.json.applied.sources, 3);
});

test('the boot snapshot is only replaced by its owner window', async () => {
  const webServer = fakeWebServer();
  const bridge = fakeBridge();
  createMcpRoute({
    ctx: { webServer },
    token: 'cfg',
    bridge,
    initialServers: [{ name: 'boot', type: 'stdio', command: 'node' }],
    initialWindowId: 'owner',
  });
  const handler = webServer.registered[0].handler;
  const push = (body) => call(handler, 'POST', authed('cfg'), JSON.stringify(body));

  // A different window adds its own server; the boot row survives.
  await push({ windowId: 'other', enabled: true, servers: [{ name: 'two', type: 'stdio', command: 'node' }] });
  assert.deepStrictEqual(bridge.calls.at(-1).map((server) => server.name).sort(), ['boot', 'two']);

  // The owner's fresh snapshot replaces the baseline.
  await push({ windowId: 'owner', enabled: true, servers: [{ name: 'boot2', type: 'stdio', command: 'node' }] });
  assert.deepStrictEqual(bridge.calls.at(-1).map((server) => server.name).sort(), ['boot2', 'two']);

  // The owner disabling withdraws its contribution; the other window stays.
  await push({ windowId: 'owner', enabled: false, servers: [] });
  assert.deepStrictEqual(bridge.calls.at(-1).map((server) => server.name), ['two']);
});

test('a malformed record is rejected before it can shadow a source', async () => {
  const webServer = fakeWebServer();
  const bridge = fakeBridge();
  createMcpRoute({ ctx: { webServer }, token: 'cfg', bridge });
  const result = await call(
    webServer.registered[0].handler,
    'POST',
    authed('cfg'),
    JSON.stringify({ windowId: 'w1', enabled: true, servers: [{ name: 'bad name', type: 'stdio', command: 'node' }] }),
  );
  assert.strictEqual(result.status, 400);
  assert.deepStrictEqual(bridge.calls, []);
});

test('a bridge TypeError is a 400; other bridge failures are a 500', async () => {
  const webServer = fakeWebServer();
  const bad = {
    async apply() { throw new TypeError('servers must be an array'); },
  };
  createMcpRoute({ ctx: { webServer }, token: 'cfg', bridge: bad });
  const result = await call(webServer.registered[0].handler, 'POST', authed('cfg'), JSON.stringify({ servers: [] }));
  assert.strictEqual(result.status, 400);

  const crashing = {
    async apply() { throw new Error('boom'); },
  };
  const other = fakeWebServer();
  createMcpRoute({ ctx: { webServer: other }, token: 'cfg', bridge: crashing });
  const failed = await call(other.registered[0].handler, 'POST', authed('cfg'), JSON.stringify({ servers: [] }));
  assert.strictEqual(failed.status, 500);
  assert.strictEqual(failed.json.error, 'mcp-apply-failed');
});

test('dispose unregisters the route and the body limit is bounded', () => {
  const webServer = fakeWebServer();
  const route = createMcpRoute({ ctx: { webServer }, token: 'cfg', bridge: fakeBridge() });
  route.dispose();
  assert.strictEqual(webServer.registered[0].disposed, true);
  assert.strictEqual(MAX_MCP_BODY_BYTES, 256 * 1024);
});