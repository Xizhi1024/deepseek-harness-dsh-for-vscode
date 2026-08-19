import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  collectModels,
  createLmRoutes,
  mapModel,
  readBearerToken,
  safeTokenEqual,
} from '../lib/lmRoute.js';

function fakeCtx(models, stream) {
  const routes = [];
  const disposers = [];
  return {
    routes,
    disposers,
    webServer: {
      register(route) {
        routes.push(route);
        const disposer = () => disposers.push(route.path);
        return disposer;
      },
    },
    llm: {
      listModels() {
        return models;
      },
      stream,
    },
  };
}

function bodyRequest(body, { method = 'POST', authorization = 'Bearer tok' } = {}) {
  const request = new EventEmitter();
  request.method = method;
  request.headers = { authorization };
  queueMicrotask(() => {
    request.emit('data', Buffer.from(body));
    request.emit('end');
  });
  return request;
}

function fakeResponse() {
  const writes = [];
  const response = {
    statusCode: 0,
    headers: {},
    writes,
    ended: false,
    writeHead(status, headers) {
      response.statusCode = status;
      response.headers = headers;
    },
    write(chunk) {
      writes.push(String(chunk));
      return true;
    },
    end(body) {
      if (body !== undefined) writes.push(String(body));
      response.ended = true;
    },
    once() {},
  };
  return response;
}

test('safeTokenEqual and readBearerToken enforce constant-time bearer auth', () => {
  assert.strictEqual(safeTokenEqual('abc', 'abc'), true);
  assert.strictEqual(safeTokenEqual('abc', 'abd'), false);
  assert.strictEqual(safeTokenEqual('abc', 'abcd'), false);
  assert.strictEqual(readBearerToken({ headers: { authorization: 'Bearer tok-123' } }), 'tok-123');
  assert.strictEqual(readBearerToken({ headers: {} }), '');
});

test('collectModels and mapModel flatten provider model lists', () => {
  const models = collectModels({
    llm: {
      listModels() {
        return [
          { provider: 'p1', models: [{ id: 'm1', name: 'M1' }] },
          { id: 'm2', provider: 'p2', maxInputTokens: 64000 },
        ];
      },
    },
  });
  assert.strictEqual(models.length, 2);
  assert.deepStrictEqual(mapModel(models[0]), {
    id: 'm1',
    name: 'M1',
    family: 'dsh',
    version: '1.0.0',
    maxInputTokens: 128000,
    maxOutputTokens: 8192,
    provider: 'p1',
    imageInput: false,
    toolCalling: false,
  });
});

test('GET /api/lm/models returns mapped DSH models behind the bridge token', () => {
  const ctx = fakeCtx([{ id: 'm1', provider: 'p1' }], async function* () {});
  const routes = createLmRoutes({ env: { DSH_LM_BRIDGE_TOKEN: 'tok' }, ctx });
  const modelsRoute = ctx.routes.find((route) => route.path === '/api/lm/models');
  const response = fakeResponse();
  modelsRoute.handler({ method: 'GET', headers: { authorization: 'Bearer tok' } }, response);
  const payload = JSON.parse(response.writes[0]);
  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(payload.models[0].id, 'm1');
  routes.dispose();
  assert.deepStrictEqual(ctx.disposers.sort(), ['/api/lm/chat', '/api/lm/models']);
});

test('unauthorized /api/lm/models request is rejected with 401', () => {
  const ctx = fakeCtx([], async function* () {});
  const routes = createLmRoutes({ env: { DSH_LM_BRIDGE_TOKEN: 'tok' }, ctx });
  const modelsRoute = ctx.routes.find((route) => route.path === '/api/lm/models');
  const response = fakeResponse();
  modelsRoute.handler({ method: 'GET', headers: { authorization: 'Bearer wrong' } }, response);
  assert.strictEqual(response.statusCode, 401);
  assert.strictEqual(response.ended, true);
  routes.dispose();
});

test('POST /api/lm/chat streams SSE text deltas from ctx.llm.stream', async () => {
  async function* stream() {
    yield { text: 'hel' };
    yield { delta: 'lo' };
  }
  const ctx = fakeCtx([], stream);
  const routes = createLmRoutes({ env: { DSH_LM_BRIDGE_TOKEN: 'tok' }, ctx });
  const chatRoute = ctx.routes.find((route) => route.path === '/api/lm/chat');
  const response = fakeResponse();
  const request = bodyRequest(JSON.stringify({
    provider: 'p1',
    model: 'm1',
    messages: [{ role: 'user', content: 'hi' }],
  }));
  await chatRoute.handler(request, response);
  assert.strictEqual(response.statusCode, 200);
  assert.ok(response.writes.some((chunk) => chunk.includes('{"text":"hel"}')), 'first delta must be streamed');
  assert.ok(response.writes.some((chunk) => chunk.includes('{"text":"lo"}')), 'second delta must be streamed');
  assert.ok(response.writes.some((chunk) => chunk.includes('[DONE]')), 'SSE stream must end with [DONE]');
  assert.strictEqual(response.ended, true);
  routes.dispose();
});

test('POST /api/lm/chat rejects malformed JSON with 400', async () => {
  const ctx = fakeCtx([], async function* () {});
  const routes = createLmRoutes({ env: { DSH_LM_BRIDGE_TOKEN: 'tok' }, ctx });
  const chatRoute = ctx.routes.find((route) => route.path === '/api/lm/chat');
  const response = fakeResponse();
  await chatRoute.handler(bodyRequest('not-json'), response);
  assert.strictEqual(response.statusCode, 400);
  assert.strictEqual(response.ended, true);
  routes.dispose();
});
test('/api/lm/models contains a throwing listModels: 500 llm-unavailable, nothing escapes', async () => {
  // F5 smoke round 4 regression: the real dsh-llm listModels() throws
  // LlmError for providers without a registered adapter; the pre-fix
  // handler let it escape and the whole DSH process died.
  const ctx = fakeCtx([], null);
  ctx.llm.listModels = () => { throw new Error('no adapter registered for provider "undefined"'); };
  createLmRoutes({ env: { DSH_LM_BRIDGE_TOKEN: 'tok' }, ctx });
  const registered = ctx.routes.find((entry) => entry.path === '/api/lm/models');
  assert.ok(registered, 'models route is registered');
  const request = bodyRequest('', { method: 'GET' });
  const response = fakeResponse();
  await registered.handler(request, response); // must resolve, never throw
  assert.strictEqual(response.statusCode, 500);
  const payload = JSON.parse(response.writes[response.writes.length - 1]);
  assert.strictEqual(payload.error, 'llm-unavailable');
  assert.ok(payload.message.includes('no adapter registered'), payload.message);
});

test('/api/lm/models skips provider-less catalog entries', async () => {
  const ctx = fakeCtx([{ id: 'm1', provider: 'p1' }, { id: 'm2' }], null);
  createLmRoutes({ env: { DSH_LM_BRIDGE_TOKEN: 'tok' }, ctx });
  const registered = ctx.routes.find((entry) => entry.path === '/api/lm/models');
  const request = bodyRequest('', { method: 'GET' });
  const response = fakeResponse();
  await registered.handler(request, response);
  assert.strictEqual(response.statusCode, 200);
  const payload = JSON.parse(response.writes[response.writes.length - 1]);
  assert.deepStrictEqual(payload.models.map((model) => model.id), ['m1'],
    'provider-less entries cannot be routed and must not be advertised');
});

test('/api/lm/chat contains a throwing ctx.llm access: 500, not a crash', async () => {
  // Simulates the cordis "inactive context" proxy throw on property access.
  const routes = [];
  const ctx = {
    webServer: {
      register(route) { routes.push(route); return () => {}; },
    },
    get llm() { throw new Error('cannot get required service "llm" in inactive context'); },
  };
  createLmRoutes({ env: { DSH_LM_BRIDGE_TOKEN: 'tok' }, ctx });
  const registered = routes.find((entry) => entry.path === '/api/lm/chat');
  assert.ok(registered, 'chat route is registered');
  const request = bodyRequest(JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] }));
  const response = fakeResponse();
  await registered.handler(request, response); // must resolve, never throw
  assert.strictEqual(response.statusCode, 500);
  const payload = JSON.parse(response.writes[response.writes.length - 1]);
  assert.strictEqual(payload.error, 'llm-unavailable');
});
