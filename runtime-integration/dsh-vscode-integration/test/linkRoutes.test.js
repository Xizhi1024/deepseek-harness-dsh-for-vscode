'use strict';

// B3 (issue #6) host-side open-link route: payload validation, workspace
// resolution, selection routing (v3 vscode/editor/open vs the plain
// textDocumentBridge open), the editor-links mount gate, and the one-shot
// bridge client.

import assert from 'node:assert/strict';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';

import {
  LINKIFY_HEADER,
  OPEN_ROUTE_PATH,
  createLinkRoutes,
  editorOpenViaBridge,
  filePathToUri,
  parseOpenRequest,
  rangeFor,
  resolveAbsolutePath,
} from '../lib/linkRoutes.js';

const ENV = {
  DSH_VSCODE_OPEN_URL: 'http://127.0.0.1:9/open-text-document',
  DSH_VSCODE_OPEN_TOKEN: 'test-token',
};

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

function setup({ env = ENV, cwd = '/ws', editorOpenImpl = undefined, openImpl = undefined } = {}) {
  const webServer = fakeWebServer();
  const opens = [];
  const routes = createLinkRoutes({
    env,
    ctx: { webServer },
    cwd,
    pathMod: path.posix,
    openImpl: openImpl || (async (absolute) => { opens.push(absolute); }),
    editorOpenImpl,
  });
  return { webServer, routes, opens };
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

const OK_HEADERS = { 'content-type': 'application/json', [LINKIFY_HEADER]: '1' };

// ---------------------------------------------------------------------------
// parseOpenRequest
// ---------------------------------------------------------------------------

test('parseOpenRequest accepts path-only, line, and line+col payloads', () => {
  assert.deepStrictEqual(parseOpenRequest({ path: 'src/x.js' }), { path: 'src/x.js', line: undefined, col: undefined });
  assert.deepStrictEqual(parseOpenRequest({ path: 'a.js', line: 42 }), { path: 'a.js', line: 42, col: undefined });
  assert.deepStrictEqual(parseOpenRequest({ path: 'a.js', line: 3, col: 9 }), { path: 'a.js', line: 3, col: 9 });
});

test('parseOpenRequest rejects malformed payloads', () => {
  assert.strictEqual(parseOpenRequest(null), null);
  assert.strictEqual(parseOpenRequest([]), null);
  assert.strictEqual(parseOpenRequest({}), null);
  assert.strictEqual(parseOpenRequest({ path: '' }), null);
  assert.strictEqual(parseOpenRequest({ path: 'file:///D:/x.js' }), null, 'client must decode file URLs');
  assert.strictEqual(parseOpenRequest({ path: 'x'.repeat(4097) }), null);
  assert.strictEqual(parseOpenRequest({ path: 'a.js', line: 0 }), null);
  assert.strictEqual(parseOpenRequest({ path: 'a.js', line: 1.5 }), null);
  assert.strictEqual(parseOpenRequest({ path: 'a.js', col: 2 }), null, 'col without line');
  assert.strictEqual(parseOpenRequest({ path: 'a.js', line: '7' }), null, 'string line rejected');
});

// ---------------------------------------------------------------------------
// resolveAbsolutePath / filePathToUri / rangeFor
// ---------------------------------------------------------------------------

test('resolveAbsolutePath resolves relative paths against cwd and passes absolutes through', () => {
  assert.strictEqual(resolveAbsolutePath('src/x.js', { cwd: '/ws', pathMod: path.posix }), '/ws/src/x.js');
  assert.strictEqual(resolveAbsolutePath('/abs/a.js', { cwd: '/ws', pathMod: path.posix }), '/abs/a.js');
  assert.strictEqual(resolveAbsolutePath('src/x.js', { cwd: null, pathMod: path.posix }), null);
  assert.strictEqual(resolveAbsolutePath('D:/x.js', { cwd: '/ws', pathMod: path.win32 }), 'D:\\x.js');
});

test('filePathToUri encodes both platform forms', () => {
  // ':' percent-encodes on the drive segment (file URI spec);
  // vscode.Uri.parse decodes it back to D:/x y/a.js.
  assert.strictEqual(filePathToUri('D:\\x y\\a.js', path.win32), 'file:///D%3A/x%20y/a.js');
  assert.strictEqual(filePathToUri('/ws/my docs/a.js', path.posix), 'file:///ws/my%20docs/a.js');
});

test('rangeFor maps 1-based line/col to the 0-based wire range', () => {
  assert.deepStrictEqual(rangeFor(42), {
    start: { line: 41, character: 0 },
    end: { line: 41, character: 0 },
  });
  assert.deepStrictEqual(rangeFor(3, 9), {
    start: { line: 2, character: 8 },
    end: { line: 2, character: 8 },
  });
});

// ---------------------------------------------------------------------------
// createLinkRoutes
// ---------------------------------------------------------------------------

test('createLinkRoutes requires ctx.webServer.register and an openImpl', () => {
  assert.throws(() => createLinkRoutes({ env: ENV, ctx: {} }), TypeError);
  assert.throws(() => createLinkRoutes({ env: ENV, ctx: { webServer: fakeWebServer() } }), TypeError);
});

test('no route mounts when the editor-links env is absent (feature gate)', () => {
  const webServer = fakeWebServer();
  const routes = createLinkRoutes({
    env: {},
    ctx: { webServer },
    openImpl: async () => {},
  });
  assert.strictEqual(routes.running, false);
  assert.strictEqual(routes.reason, 'editor-links-disabled');
  assert.strictEqual(webServer.registered.length, 0);
});

test('route answers 405 for GET and 403 without the linkify header', async () => {
  const { webServer } = setup();
  const handler = webServer.registered[0].handler;
  assert.strictEqual(webServer.registered[0].path, OPEN_ROUTE_PATH);
  assert.deepStrictEqual((await call(handler, 'GET', OK_HEADERS)).status, 405);
  assert.deepStrictEqual((await call(handler, 'POST', { 'content-type': 'application/json' }, '{}')).status, 403);
});

test('route rejects bad JSON and invalid payloads with 400', async () => {
  const { webServer } = setup();
  const handler = webServer.registered[0].handler;
  assert.strictEqual((await call(handler, 'POST', OK_HEADERS, '{oops')).status, 400);
  assert.strictEqual((await call(handler, 'POST', OK_HEADERS, JSON.stringify({ path: 'file:///D:/x.js' }))).status, 400);
});

test('relative path without a workspace cwd is a 400', async () => {
  const { webServer } = setup({ cwd: null });
  const result = await call(webServer.registered[0].handler, 'POST', OK_HEADERS, JSON.stringify({ path: 'src/x.js' }));
  assert.strictEqual(result.status, 400);
  assert.strictEqual(result.json.error, 'bad-request');
});

test('plain open resolves against cwd and calls the textDocumentBridge opener', async () => {
  const { webServer, opens } = setup();
  const result = await call(
    webServer.registered[0].handler,
    'POST',
    OK_HEADERS,
    JSON.stringify({ path: 'src/x.js' }),
  );
  assert.strictEqual(result.status, 200);
  assert.deepStrictEqual(result.json, { opened: true });
  assert.deepStrictEqual(opens, ['/ws/src/x.js']);
});

test('absolute path from a file:/// click passes through untouched', async () => {
  const { webServer, opens } = setup();
  const result = await call(
    webServer.registered[0].handler,
    'POST',
    OK_HEADERS,
    JSON.stringify({ path: '/home/u/my docs/a.py', line: 7 }),
  );
  assert.strictEqual(result.status, 200);
  assert.deepStrictEqual(opens, ['/home/u/my docs/a.py']);
});

test('a line number routes through the selection-aware opener with a wire range', async () => {
  const seen = [];
  const { webServer } = setup({
    editorOpenImpl: async ({ params }) => { seen.push(params); },
  });
  const result = await call(
    webServer.registered[0].handler,
    'POST',
    OK_HEADERS,
    JSON.stringify({ path: 'src/x.js', line: 42, col: 9 }),
  );
  assert.strictEqual(result.status, 200);
  assert.deepStrictEqual(result.json, { opened: true, selection: true });
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].document.uri, 'file:///ws/src/x.js');
  assert.deepStrictEqual(seen[0].range, rangeFor(42, 9));
});

test('selection opener failure falls back to the plain open', async () => {
  const opens = [];
  const { webServer } = setup({
    editorOpenImpl: async () => { throw new Error('outside workspace'); },
    openImpl: async (absolute) => { opens.push(absolute); },
  });
  const result = await call(
    webServer.registered[0].handler,
    'POST',
    OK_HEADERS,
    JSON.stringify({ path: 'other/pkg.js', line: 5 }),
  );
  assert.strictEqual(result.status, 200);
  assert.deepStrictEqual(result.json, { opened: true });
  assert.deepStrictEqual(opens, ['/ws/other/pkg.js']);
});

test('opener failure surfaces as a contained 500', async () => {
  const { webServer } = setup({ openImpl: async () => { throw new Error('boom'); } });
  const result = await call(
    webServer.registered[0].handler,
    'POST',
    OK_HEADERS,
    JSON.stringify({ path: 'src/x.js' }),
  );
  assert.strictEqual(result.status, 500);
  assert.strictEqual(result.json.error, 'open-failed');
  assert.strictEqual(result.json.message, 'boom');
});

test('dispose unregisters the mounted route', () => {
  const { webServer, routes } = setup();
  assert.strictEqual(webServer.registered.length, 1);
  routes.dispose();
  assert.strictEqual(webServer.registered[0].disposed, true);
});

// ---------------------------------------------------------------------------
// editorOpenViaBridge (one-shot v3 client)
// ---------------------------------------------------------------------------

function fakeSocket() {
  const socket = new EventEmitter();
  socket.frames = [];
  socket.destroyed = false;
  socket.write = (line) => { socket.frames.push(JSON.parse(line)); };
  socket.destroy = () => { socket.destroyed = true; };
  return socket;
}

test('editorOpenViaBridge authenticates, sends vscode/editor/open, and resolves', async () => {
  const socket = fakeSocket();
  const net = { connect: () => socket };
  const pending = editorOpenViaBridge({
    net,
    bridgeState: { ok: true, host: '127.0.0.1', port: 1234, token: 'tok' },
    params: { document: { uri: 'file:///ws/a.js' }, range: rangeFor(2) },
  });
  await new Promise((resolve) => setImmediate(resolve));
  socket.emit('data', JSON.stringify({ jsonrpc: '2.0', id: 1, result: { methods: ['vscode/editor/open'] } }) + '\n');
  await new Promise((resolve) => setImmediate(resolve));
  socket.emit('data', JSON.stringify({ jsonrpc: '2.0', id: 2, result: { opened: true } }) + '\n');
  const result = await pending;
  assert.deepStrictEqual(result, { opened: true });
  assert.strictEqual(socket.frames[0].method, 'initialize');
  assert.strictEqual(socket.frames[0].params.token, 'tok');
  assert.strictEqual(socket.frames[1].method, 'vscode/editor/open');
  assert.strictEqual(socket.frames[1].params.document.uri, 'file:///ws/a.js');
  assert.ok(socket.destroyed, 'one-shot socket must be destroyed');
});

test('editorOpenViaBridge rejects on socket error', async () => {
  const socket = fakeSocket();
  const net = { connect: () => socket };
  const pending = editorOpenViaBridge({
    net,
    bridgeState: { ok: true, host: '127.0.0.1', port: 1234, token: 'tok' },
    params: { document: { uri: 'file:///ws/a.js' } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  socket.emit('error', new Error('ECONNREFUSED'));
  await assert.rejects(pending, /ECONNREFUSED/);
});

test('editorOpenViaBridge rejects without a usable bridge env', async () => {
  await assert.rejects(
    editorOpenViaBridge({ net: {}, bridgeState: { ok: false } , params: {} }),
    /unavailable/,
  );
  await assert.rejects(
    editorOpenViaBridge({ net: null, bridgeState: { ok: true, port: 1, token: 't' }, params: {} }),
    /node:net/,
  );
});
