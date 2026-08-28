'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const NL = String.fromCharCode(10);

// The plugin package is ESM ("type": "module"); load via dynamic import.
async function loadEsm() {
  return import('../../runtime-integration/dsh-vscode-integration/lib/fimRoutes.js');
}

function makeCtx() {
  const registered = [];
  return {
    registered,
    webServer: {
      register(entry) {
        registered.push(entry);
        return () => {
          const i = registered.indexOf(entry);
          if (i >= 0) registered.splice(i, 1);
        };
      },
    },
  };
}

function makeRequest({ method = 'POST', token = 'tok', body = null } = {}) {
  const listeners = {};
  const req = {
    method,
    headers: token === null ? {} : { authorization: 'Bearer ' + token },
    on(event, fn) { listeners[event] = fn; },
  };
  queueMicrotask(() => {
    if (body !== null) listeners.data?.(typeof body === 'string' ? Buffer.from(body) : body);
    listeners.end?.();
  });
  return req;
}

function makeResponse() {
  const chunks = [];
  const res = {
    statusCode: null,
    headers: null,
    ended: false,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    write(chunk) { chunks.push(String(chunk)); return true; },
    end(chunk) { if (chunk !== undefined) chunks.push(String(chunk)); this.ended = true; },
    body() { return chunks.join(''); },
  };
  return res;
}

function sseUpstream(deltas) {
  const body = deltas.map((t) => 'data: ' + JSON.stringify({ choices: [{ text: t }] }) + NL + NL).join('') + 'data: [DONE]' + NL + NL;
  return {
    ok: true,
    status: 200,
    body: (async function* () { yield body; })(),
  };
}

const ENV = {
  DSH_FIM_BRIDGE_TOKEN: 'tok',
  DSH_FIM_BASE_URL: 'https://fim.example/completions',
  DSH_FIM_API_KEY: 'up-key',
};

async function esm() {
  const mod = await loadEsm();
  return mod.createFimRoutes;
}

test('createFimRoutes mounts nothing without a bridge token', async () => {
  const create = await esm();
  const ctx = makeCtx();
  const routes = create({ env: { DSH_FIM_BRIDGE_TOKEN: '' }, ctx, fetchImpl: async () => { throw new Error('never'); } });
  assert.equal(routes.routes.length, 0);
  assert.equal(ctx.registered.length, 0);
  routes.dispose();
});

test('unauthorized requests are rejected with 401', async () => {
  const create = await esm();
  const ctx = makeCtx();
  const routes = create({ env: ENV, ctx, fetchImpl: async () => { throw new Error('never'); } });
  const handler = ctx.registered[0].handler;
  const res = makeResponse();
  await handler(makeRequest({ token: 'wrong' }), res);
  assert.equal(res.statusCode, 401);
  routes.dispose();
});

test('GET is rejected with 405', async () => {
  const create = await esm();
  const ctx = makeCtx();
  const routes = create({ env: ENV, ctx, fetchImpl: async () => { throw new Error('never'); } });
  const handler = ctx.registered[0].handler;
  const res = makeResponse();
  await handler(makeRequest({ method: 'GET' }), res);
  assert.equal(res.statusCode, 405);
  routes.dispose();
});

test('missing upstream config answers 503 fim-not-configured', async () => {
  const create = await esm();
  const ctx = makeCtx();
  const routes = create({ env: { DSH_FIM_BRIDGE_TOKEN: 'tok' }, ctx, fetchImpl: async () => { throw new Error('never'); } });
  const handler = ctx.registered[0].handler;
  const res = makeResponse();
  await handler(makeRequest({ body: JSON.stringify({ model: 'm', prefix: 'a', suffix: 'b' }) }), res);
  assert.equal(res.statusCode, 503);
  assert.ok(res.body().includes('fim-not-configured'));
  routes.dispose();
});

test('happy path: upstream deltas re-emitted as {"text": ...} frames + [DONE]', async () => {
  const create = await esm();
  const ctx = makeCtx();
  let seenInit = null;
  const routes = create({
    env: ENV,
    ctx,
    fetchImpl: async (url, init) => {
      seenInit = { url, init };
      return sseUpstream(['hello', ' world']);
    },
  });
  const handler = ctx.registered[0].handler;
  const res = makeResponse();
  await handler(makeRequest({ body: JSON.stringify({ model: 'deepseek-coder', prefix: 'const a = ', suffix: NL }) }), res);
  assert.equal(seenInit.url, 'https://fim.example/completions');
  const sent = JSON.parse(seenInit.init.body);
  assert.equal(sent.model, 'deepseek-coder');
  assert.equal(sent.stream, true);
  assert.ok(sent.prompt.includes('const a = '));
  assert.ok(sent.prompt.includes(NL));
  assert.equal(res.statusCode, 200);
  const body = res.body();
  assert.ok(body.includes('data: {"text":"hello"}'));
  assert.ok(body.includes('data: {"text":" world"}'));
  assert.ok(body.trimEnd().endsWith('data: [DONE]'));
  assert.ok(res.ended);
  routes.dispose();
});

test('upstream failure answers 502 without throwing', async () => {
  const create = await esm();
  const ctx = makeCtx();
  const routes = create({ env: ENV, ctx, fetchImpl: async () => ({ ok: false, status: 500 }) });
  const handler = ctx.registered[0].handler;
  const res = makeResponse();
  await handler(makeRequest({ body: JSON.stringify({ model: 'm', prefix: '', suffix: '' }) }), res);
  assert.equal(res.statusCode, 502);
  assert.ok(res.body().includes('fim-upstream-error'));
  routes.dispose();
});

test('invalid JSON body answers 400/500 level, never throws', async () => {
  const create = await esm();
  const ctx = makeCtx();
  const routes = create({ env: ENV, ctx, fetchImpl: async () => { throw new Error('never'); } });
  const handler = ctx.registered[0].handler;
  const res = makeResponse();
  await handler(makeRequest({ body: '{not json' }), res);
  assert.ok(res.statusCode >= 400);
  routes.dispose();
});

test('dispose removes the mounted route', async () => {
  const create = await esm();
  const ctx = makeCtx();
  const routes = create({ env: ENV, ctx, fetchImpl: async () => { throw new Error('never'); } });
  assert.equal(ctx.registered.length, 1);
  routes.dispose();
  assert.equal(ctx.registered.length, 0);
});
