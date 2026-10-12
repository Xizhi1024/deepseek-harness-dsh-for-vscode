'use strict';

// /api/vscode/configure — the runtime reconfiguration route (known-issue #1
// fix): bearer auth, method gate, body validation, merge application.

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { createConfigureRoute, readBearerToken } from '../lib/configureRoute.js';
import { createRuntimeConfig } from '../lib/runtimeConfig.js';

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

test('createConfigureRoute requires ctx.webServer.register and a store', () => {
  assert.throws(() => createConfigureRoute({ ctx: {} }), TypeError);
  assert.throws(() => createConfigureRoute({ ctx: { webServer: fakeWebServer() } }), TypeError);
});

test('mounts exactly one exact route at /api/vscode/configure', () => {
  const webServer = fakeWebServer();
  const config = createRuntimeConfig({ env: { DSH_VSCODE_CONFIGURE_TOKEN: 'cfg' } });
  const route = createConfigureRoute({ ctx: { webServer }, config });
  assert.strictEqual(route.running, true);
  assert.strictEqual(webServer.registered.length, 1);
  assert.strictEqual(webServer.registered[0].path, '/api/vscode/configure');
});

test('an instance without a configure token always answers 401 (older spawns)', async () => {
  const webServer = fakeWebServer();
  const config = createRuntimeConfig({ env: {} });
  createConfigureRoute({ ctx: { webServer }, config });
  const result = await call(webServer.registered[0].handler, 'POST', authed('anything'), '{}');
  assert.strictEqual(result.status, 401);
  assert.strictEqual(result.json.error, 'unauthorized');
});

test('wrong bearer is 401; GET is 405; bad JSON is 400; bad patch is 400', async () => {
  const webServer = fakeWebServer();
  const config = createRuntimeConfig({ env: { DSH_VSCODE_CONFIGURE_TOKEN: 'cfg' } });
  createConfigureRoute({ ctx: { webServer }, config });
  const handler = webServer.registered[0].handler;
  assert.strictEqual((await call(handler, 'POST', authed('wrong'), '{}')).status, 401);
  assert.strictEqual((await call(handler, 'GET', authed('cfg'), undefined)).status, 405);
  assert.strictEqual((await call(handler, 'POST', authed('cfg'), '{oops')).status, 400);
  assert.strictEqual((await call(handler, 'POST', authed('cfg'), JSON.stringify({ nope: 1 }))).status, 400);
  assert.strictEqual((await call(handler, 'POST', authed('cfg'), JSON.stringify({ fim: { addTokens: [''] } }))).status, 400);
});

test('an authorized push applies the patch and answers the applied summary', async () => {
  const webServer = fakeWebServer();
  const config = createRuntimeConfig({ env: { DSH_VSCODE_CONFIGURE_TOKEN: 'cfg' } });
  createConfigureRoute({ ctx: { webServer }, config });
  const result = await call(
    webServer.registered[0].handler,
    'POST',
    authed('cfg'),
    JSON.stringify({ fim: { addTokens: ['fim-1'], baseUrl: 'https://x/y' }, lm: { addTokens: ['lm-1'] } }),
  );
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.json.applied.fim.tokens, 1);
  assert.strictEqual(result.json.applied.lm.tokens, 1);
  assert.ok(config.fim.tokens.has('fim-1'));
  assert.ok(config.lm.tokens.has('lm-1'));
  assert.strictEqual(config.fim.baseUrl, 'https://x/y');
});

test('dispose unregisters the route', () => {
  const webServer = fakeWebServer();
  const config = createRuntimeConfig({ env: { DSH_VSCODE_CONFIGURE_TOKEN: 'cfg' } });
  const route = createConfigureRoute({ ctx: { webServer }, config });
  route.dispose();
  assert.strictEqual(webServer.registered[0].disposed, true);
});

test('readBearerToken parses the Authorization header', () => {
  assert.strictEqual(readBearerToken({ headers: { authorization: 'Bearer abc' } }), 'abc');
  assert.strictEqual(readBearerToken({ headers: {} }), '');
  assert.strictEqual(readBearerToken(null), '');
});
