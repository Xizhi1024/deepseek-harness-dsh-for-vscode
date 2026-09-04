import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  buildMuxDataLine,
  installCompatSessionRoutes,
  normalizePromptPayload,
  remoteErrorToResult,
} from '../lib/compatSessionRoutes.js';

function makeController(overrides = {}) {
  const calls = [];
  const record = (name) => async (payload) => {
    calls.push({ name, payload });
    if (overrides[name]) return overrides[name](payload);
    return { ok: true };
  };
  return {
    calls,
    list: record('list'),
    commands: {
      create: record('create'),
      rename: record('rename'),
      prompt: record('prompt'),
    },
  };
}

function makeWebServer() {
  const routes = new Map();
  return {
    routes,
    register({ kind, path, handler }) {
      routes.set(path, { kind, handler });
      return () => routes.delete(path);
    },
  };
}

function makePost(bodyText) {
  const request = new EventEmitter();
  process.nextTick(() => {
    request.emit('data', Buffer.from(bodyText));
    request.emit('end');
  });
  return request;
}

function makeResponse() {
  return {
    status: null,
    body: null,
    ended: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
      this.ended = true;
    },
    write() {},
    on() {},
  };
}

function envelope(method, payload) {
  return JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method, payload });
}

test('installCompatSessionRoutes mounts the five frozen routes and disposes them', () => {
  const controller = makeController();
  const webServer = makeWebServer();
  const routes = installCompatSessionRoutes({ sessionController: controller, webServer });
  assert.deepStrictEqual(
    [...webServer.routes.keys()].sort(),
    ['/api/events.mux', '/api/session.create', '/api/session.list', '/api/session.prompt', '/api/session.rename']
  );
  routes.dispose();
  assert.strictEqual(webServer.routes.size, 0);
});

test('session.list maps the client-request envelope to result.ok/value', async () => {
  const controller = makeController({ list: () => ({ items: [{ sessionId: 'session-1', updatedAt: 5 }], hasMore: false }) });
  const webServer = makeWebServer();
  installCompatSessionRoutes({ sessionController: controller, webServer });
  const response = makeResponse();
  await webServer.routes.get('/api/session.list').handler(makePost(envelope('session.list', {})), response);
  assert.strictEqual(response.status, 200);
  const body = JSON.parse(response.body);
  assert.strictEqual(body.result.ok, true);
  assert.strictEqual(body.result.value.items[0].sessionId, 'session-1');
  assert.strictEqual(controller.calls[0].name, 'list');
});

test('session.prompt fills requestId and maps the accepted value', async () => {
  const controller = makeController({ prompt: () => ({ accepted: true }) });
  const webServer = makeWebServer();
  installCompatSessionRoutes({ sessionController: controller, webServer });
  const response = makeResponse();
  const payload = { sessionId: 'session-2', content: [{ type: 'text', text: 'hi' }], mode: 'queue' };
  await webServer.routes.get('/api/session.prompt').handler(makePost(envelope('session.prompt', payload)), response);
  const body = JSON.parse(response.body);
  assert.strictEqual(body.result.value.accepted, true);
  const forwarded = controller.calls[0].payload;
  assert.strictEqual(forwarded.sessionId, 'session-2');
  assert.strictEqual(forwarded.mode, 'queue');
  assert.match(forwarded.requestId, /^[0-9a-f-]{36}$/i);
});

test('session.create and session.rename forward payloads untouched', async () => {
  const controller = makeController();
  const webServer = makeWebServer();
  installCompatSessionRoutes({ sessionController: controller, webServer });
  const create = makeResponse();
  await webServer.routes.get('/api/session.create').handler(
    makePost(envelope('session.create', { cwd: 'D:/w' })),
    create
  );
  const rename = makeResponse();
  await webServer.routes.get('/api/session.rename').handler(
    makePost(envelope('session.rename', { sessionId: 'session-3', title: 't' })),
    rename
  );
  assert.deepStrictEqual(controller.calls[0].payload, { cwd: 'D:/w' });
  assert.deepStrictEqual(controller.calls[1].payload, { sessionId: 'session-3', title: 't' });
});

test('host RemoteError rejections become the wire business error', async () => {
  const controller = makeController({
    prompt: () => {
      const error = new Error('no adapter serves provider "x"');
      error.code = 'session/model-unavailable';
      throw error;
    },
  });
  const webServer = makeWebServer();
  installCompatSessionRoutes({ sessionController: controller, webServer });
  const response = makeResponse();
  await webServer.routes.get('/api/session.prompt').handler(makePost(envelope('session.prompt', { sessionId: 's' })), response);
  assert.strictEqual(response.status, 200);
  const body = JSON.parse(response.body);
  assert.strictEqual(body.result.ok, false);
  assert.strictEqual(body.result.error.code, 'session/model-unavailable');
});

test('unknown methods answer 404 and invalid JSON answers 400', async () => {
  const webServer = makeWebServer();
  installCompatSessionRoutes({ sessionController: makeController(), webServer });
  const missing = makeResponse();
  await webServer.routes.get('/api/session.list').handler(makePost(envelope('session.nope', {})), missing);
  assert.strictEqual(missing.status, 404);
  const garbage = makeResponse();
  await webServer.routes.get('/api/session.list').handler(makePost('not json'), garbage);
  assert.strictEqual(garbage.status, 400);
});

test('events.mux writes the connected comment then session/event frames in the mux envelope', () => {
  const listeners = {};
  const ctx = {
    on(event, fn) {
      (listeners[event] ??= []).push(fn);
      return () => {
        listeners[event] = listeners[event].filter((f) => fn !== f);
      };
    },
    off() {},
  };
  const controller = makeController();
  const webServer = makeWebServer();
  installCompatSessionRoutes({ sessionController: controller, webServer }, { ctxDeps: ctx });
  const handler = webServer.routes.get('/api/events.mux').handler;
  // installCompatSessionRoutes does not thread a ctx for events; re-mount
  // through the exported handler path is covered by the integration below.
  // Direct unit: exercise the frame builder instead.
  const line = buildMuxDataLine({ type: 'session/event', sessionId: 'session-9', event: { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'hey' } } } });
  assert.ok(line.startsWith('data: '));
  assert.ok(line.endsWith('\n\n'));
  const full = JSON.parse(line.slice(6));
  assert.strictEqual(full.type, 'server-request');
  assert.strictEqual(typeof full.rpcId, 'string');
  assert.strictEqual(full.payload.type, 'session/event');
  assert.strictEqual(full.payload.sessionId, 'session-9');
  assert.strictEqual(full.payload.event.data.chunk.text, 'hey');
});

test('events.mux handler streams live events and clears keepalive on close', () => {
  const listeners = {};
  const ctx = {
    on(event, fn) {
      (listeners[event] ??= []).push(fn);
      return () => {
        listeners[event] = listeners[event].filter((f) => fn !== f);
      };
    },
    off() {},
  };
  const intervals = [];
  const controller = makeController();
  const webServer = makeWebServer();
  // The handler mounts through installCompatSessionRoutes' ctx; simulate it
  // by calling the internal wiring through the public surface with a ctx.
  const routes = installCompatSessionRoutes(
    { sessionController: controller, webServer, on: ctx.on, off: ctx.off },
    { setIntervalFn: (fn) => { intervals.push(fn); return { unref() {} }; }, clearIntervalFn: () => { intervals.length = 0; } }
  );
  const handler = webServer.routes.get('/api/events.mux').handler;
  const chunks = [];
  const response = {
    writeHead() {},
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    on() {},
  };
  const request = new EventEmitter();
  handler(request, response);
  assert.strictEqual(chunks[0], ': connected\n\n');
  listeners['session/event'][0]({ id: 'session-7' }, { type: 'user/message', seq: 3, time: 4, data: {} });
  assert.strictEqual(chunks.length, 2);
  const full = JSON.parse(chunks[1].slice(6));
  assert.strictEqual(full.payload.type, 'session/event');
  assert.strictEqual(full.payload.sessionId, 'session-7');
  intervals[0](); // fire one keepalive tick
  const keepalive = JSON.parse(chunks[2].slice(6));
  assert.strictEqual(keepalive.payload.type, 'keepalive');
  request.emit('close');
  assert.strictEqual(listeners['session/event'].length, 0, 'close must unsubscribe the session bus');
  const before = chunks.length;
  intervals.forEach((fn) => fn()); // cleared interval no longer writes
  assert.strictEqual(chunks.length, before);
  routes.dispose();
});

test('normalizePromptPayload keeps a provided requestId and generates one otherwise', () => {
  const kept = normalizePromptPayload({ requestId: 'mine', sessionId: 's' });
  assert.strictEqual(kept.requestId, 'mine');
  const generated = normalizePromptPayload({ sessionId: 's' });
  assert.match(generated.requestId, /^[0-9a-f-]{36}$/i);
});

test('remoteErrorToResult collapses unknown rejections to internal', () => {
  const result = remoteErrorToResult(new Error('boom'));
  assert.deepStrictEqual(result, { ok: false, error: { code: 'internal', message: 'boom' } });
});