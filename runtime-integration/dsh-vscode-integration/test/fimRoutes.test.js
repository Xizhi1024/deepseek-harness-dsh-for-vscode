'use strict';

// POST /api/fim — always mounted (known-issue #1 fix): 503 when the instance
// has no FIM token at all, 401 on bearer mismatch, 503 guidance when the
// upstream is unconfigured, and the token set is live-configurable.

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { createFimRoutes } from '../lib/fimRoutes.js';
import { createRuntimeConfig } from '../lib/runtimeConfig.js';

function fakeRequest(method, headers, body) {
  const stream = Readable.from(body === undefined ? [] : [body]);
  stream.method = method;
  stream.headers = headers;
  const listeners = new Map();
  stream.on = (event, fn) => {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(fn);
    return stream;
  };
  stream.emit = (event, ...args) => {
    for (const fn of listeners.get(event) || []) fn(...args);
  };
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
    write(payload) {
      this.body += String(payload);
      return true;
    },
    end(payload) {
      if (payload !== undefined) this.body += String(payload);
      if (this._done) this._done();
    },
    once() { return response; },
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
  const request = fakeRequest(method, headers, body);
  const done = handler(request, response);
  // Deliver the body once the handler's readRequestBody listeners are on.
  setTimeout(() => {
    if (body !== undefined) request.emit('data', body);
    request.emit('end');
  }, 10);
  await done;
  await Promise.race([
    response.finished,
    new Promise((resolve) => setTimeout(resolve, 500)),
  ]);
  let json = null;
  try { json = response.body.startsWith('{') ? JSON.parse(response.body.split('\n')[0]) : null; } catch { /* SSE body */ }
  return { status: response.status, json, body: response.body };
}

function sseUpstream(fragments) {
  const encoder = new TextEncoder();
  return async () => ({
    ok: true,
    status: 200,
    body: (async function* generate() {
      for (const fragment of fragments) {
        yield encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: fragment } }] })}\n\n`);
      }
      yield encoder.encode('data: [DONE]\n\n');
    })(),
  });
}

test('the FIM route ALWAYS mounts, even with an empty token env', () => {
  const webServer = fakeWebServer();
  const fim = createFimRoutes({ env: {}, ctx: { webServer } });
  assert.strictEqual(fim.routes.length, 1);
  assert.strictEqual(fim.routes[0].path, '/api/fim');
});

test('no FIM token anywhere answers 503 fim-not-configured (not the old fallthrough 404)', async () => {
  const webServer = fakeWebServer();
  createFimRoutes({ env: {}, ctx: { webServer } });
  const result = await call(webServer.registered[0].handler, 'POST', { authorization: 'Bearer whatever' }, '{}'); // allow-secret-scan (test fixture)
  assert.strictEqual(result.status, 503);
  assert.strictEqual(result.json.error, 'fim-not-configured');
});

test('a wrong bearer is 401; a bootstrap token passes auth to the config gate', async () => {
  const webServer = fakeWebServer();
  createFimRoutes({ env: { DSH_FIM_BRIDGE_TOKEN: 'tok-a' }, ctx: { webServer } });
  const handler = webServer.registered[0].handler;
  const unauthorized = await call(handler, 'POST', { authorization: 'Bearer tok-wrong' }, '{}'); // allow-secret-scan (test fixture)
  assert.strictEqual(unauthorized.status, 401);
  // Authenticated but no upstream configured: 503 with the guidance message.
  const unconfigured = await call(handler, 'POST', { authorization: 'Bearer tok-a' }, '{}');
  assert.strictEqual(unconfigured.status, 503);
  assert.strictEqual(unconfigured.json.error, 'fim-not-configured');
});

test('a token added via a configure push authenticates immediately', async () => {
  const webServer = fakeWebServer();
  const config = createRuntimeConfig({ env: {} });
  const seen = [];
  createFimRoutes({ env: {}, config, ctx: { webServer }, fetchImpl: sseUpstream(['hi']) });
  const handler = webServer.registered[0].handler;
  assert.strictEqual((await call(handler, 'POST', { authorization: 'Bearer tok-late' }, '{}')).status, 503); // allow-secret-scan (test fixture)
  config.applyConfigure({ fim: { addTokens: ['tok-late'], baseUrl: 'https://upstream.example/completions', apiKey: 'sk' } });
  const result = await call(
    handler,
    'POST',
    { authorization: 'Bearer tok-late' }, // allow-secret-scan (test fixture)
    JSON.stringify({ model: 'm', prefix: 'P', suffix: 'S' }),
  );
  assert.strictEqual(result.status, 200);
  assert.ok(result.body.includes('"text":"hi"'));
  assert.ok(result.body.includes('[DONE]'));
});

test('the upstream request carries the configured endpoint, key and prompt', async () => {
  const webServer = fakeWebServer();
  const config = createRuntimeConfig({ env: {} });
  let captured = null;
  createFimRoutes({
    env: {},
    config,
    ctx: { webServer },
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return sseUpstream(['x'])();
    },
  });
  config.applyConfigure({ fim: { addTokens: ['t'], baseUrl: 'https://up.example/completions', apiKey: 'sk-live' } });
  await call(
    webServer.registered[0].handler,
    'POST',
    { authorization: 'Bearer t' },
    JSON.stringify({ model: 'deepseek-fim', prefix: 'PRE', suffix: 'SUF' }),
  );
  assert.strictEqual(captured.url, 'https://up.example/completions');
  assert.strictEqual(captured.init.headers.Authorization, 'Bearer sk-live');
  const body = JSON.parse(captured.init.body);
  assert.strictEqual(body.model, 'deepseek-fim');
  assert.ok(body.prompt.includes('PRE') && body.prompt.includes('SUF'));
});

test('missing model with valid auth is a 400', async () => {
  const webServer = fakeWebServer();
  const config = createRuntimeConfig({ env: {} });
  createFimRoutes({ env: {}, config, ctx: { webServer }, fetchImpl: sseUpstream(['x']) });
  config.applyConfigure({ fim: { addTokens: ['t'], baseUrl: 'https://up.example/completions', apiKey: 'sk' } });
  const result = await call(webServer.registered[0].handler, 'POST', { authorization: 'Bearer t' }, '{}');
  assert.strictEqual(result.status, 400);
  assert.strictEqual(result.json.error, 'invalid-request');
});
