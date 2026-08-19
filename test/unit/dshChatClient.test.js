'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createDshChatClient } = require('../../src/dshChatClient');

const BASE_URL = 'http://127.0.0.1:3080';
const PROMPT_URL = `${BASE_URL}/api/session.prompt`;
const MUX_URL = `${BASE_URL}/api/events.mux`;

function jsonResponse(status, body) {
  return {
    status,
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

function isDshError(code) {
  return (err) => Boolean(err) && err.name === 'DshSessionError' && err.code === code;
}

function textChunkEvent(text) {
  return {
    type: 'assistant/chunk',
    seq: 1,
    time: Date.now(),
    data: {
      turn: 0,
      step: 0,
      chunk: { type: 'text-delta', index: 0, text },
    },
  };
}

function sessionEventFrame(sessionId, event) {
  return { type: 'session/event', sessionId, event };
}

function sseFrameFor(frame) {
  return `data: ${JSON.stringify({
    type: 'server-request',
    rpcId: 'rpc-1',
    method: frame.type,
    payload: frame,
  })}\n\n`;
}

function sseResponse(chunks, { close = true } = {}) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      }
      if (close) controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function hangingSseResponse() {
  return new Response(new ReadableStream({ start() {} }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// prompt
// ---------------------------------------------------------------------------

test('prompt posts a client-request envelope and returns {accepted:true, sessionId}', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, envelope: JSON.parse(init.body) });
    return jsonResponse(200, {
      type: 'server-response',
      rpcId: JSON.parse(init.body).rpcId,
      result: { ok: true, value: { accepted: true } },
    });
  };
  const client = createDshChatClient({ fetchImpl, baseUrlProvider: () => BASE_URL });

  const result = await client.prompt({ sessionId: 's1', content: 'hi' });

  assert.deepStrictEqual(result, { accepted: true, sessionId: 's1' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, PROMPT_URL);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.equal(calls[0].envelope.type, 'client-request');
  assert.equal(calls[0].envelope.method, 'session.prompt');
  assert.ok(typeof calls[0].envelope.rpcId === 'string' && calls[0].envelope.rpcId.length > 0);
  assert.deepStrictEqual(calls[0].envelope.payload, {
    sessionId: 's1',
    mode: 'queue',
    content: [{ type: 'text', text: 'hi' }],
  });
});

test('prompt forwards mode and array content verbatim', async () => {
  let seen;
  const fetchImpl = async (_url, init) => {
    seen = JSON.parse(init.body);
    return jsonResponse(200, {
      type: 'server-response',
      rpcId: seen.rpcId,
      result: { ok: true, value: { accepted: true } },
    });
  };
  const client = createDshChatClient({ fetchImpl, baseUrlProvider: () => BASE_URL });

  await client.prompt({
    sessionId: 's2',
    content: [{ type: 'text', text: 'part' }],
    mode: 'steer',
  });

  assert.deepStrictEqual(seen.payload, {
    sessionId: 's2',
    mode: 'steer',
    content: [{ type: 'text', text: 'part' }],
  });
});

test('prompt rejects non-200 with DSH_SESSION_API_UNAVAILABLE', async () => {
  const fetchImpl = async () => ({ status: 502, async text() { return 'bad gateway'; } });
  const client = createDshChatClient({ fetchImpl, baseUrlProvider: () => BASE_URL });

  await assert.rejects(
    client.prompt({ sessionId: 's1', content: 'hi' }),
    isDshError('DSH_SESSION_API_UNAVAILABLE')
  );
});

test('prompt rejects non-JSON body with DSH_SESSION_API_INVALID_RESPONSE', async () => {
  const fetchImpl = async () => ({ status: 200, async text() { return 'not-json'; } });
  const client = createDshChatClient({ fetchImpl, baseUrlProvider: () => BASE_URL });

  await assert.rejects(
    client.prompt({ sessionId: 's1', content: 'hi' }),
    isDshError('DSH_SESSION_API_INVALID_RESPONSE')
  );
});

test('prompt validates the server-response envelope', async () => {
  const bodies = [
    { body: null, code: 'DSH_SESSION_API_INVALID_RESPONSE' },
    { body: { result: { ok: true } }, code: 'DSH_SESSION_API_INVALID_RESPONSE' },
    { body: { result: { ok: false, error: { code: 'session-not-found', message: 'x', details: { sessionId: 's1' } } } }, code: 'DSH_SESSION_API_BUSINESS_ERROR' },
    { body: { result: { ok: true, value: { accepted: false } } }, code: 'DSH_SESSION_API_INVALID_RESPONSE' },
    { body: { result: { ok: true, value: {} } }, code: 'DSH_SESSION_API_INVALID_RESPONSE' },
  ];

  for (const { body, code } of bodies) {
    const fetchImpl = async () => ({ status: 200, async text() { return JSON.stringify(body); } });
    const client = createDshChatClient({ fetchImpl, baseUrlProvider: () => BASE_URL });
    await assert.rejects(
      client.prompt({ sessionId: 's1', content: 'hi' }),
      (err) => {
        assert.equal(err && err.name, 'DshSessionError');
        assert.equal(err && err.code, code);
        if (code === 'DSH_SESSION_API_BUSINESS_ERROR') {
          assert.equal(err.businessCode, 'session-not-found');
        }
        return true;
      }
    );
  }
});

test('prompt rejects a non-loopback base URL without fetching', async () => {
  let fetched = false;
  const fetchImpl = async () => {
    fetched = true;
    throw new Error('must not be called');
  };
  const client = createDshChatClient({
    fetchImpl,
    baseUrlProvider: () => 'http://evil.example.com:3080',
  });

  await assert.rejects(
    client.prompt({ sessionId: 's1', content: 'hi' }),
    isDshError('DSH_SESSION_API_UNAVAILABLE')
  );
  assert.equal(fetched, false);
});

test('prompt forwards caller signal cancellation as AbortError', async () => {
  let receivedSignal;
  const fetchImpl = async (_url, init) => {
    receivedSignal = init.signal;
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  };
  const client = createDshChatClient({ fetchImpl, baseUrlProvider: () => BASE_URL });
  const controller = new AbortController();

  const pending = client.prompt({ sessionId: 's1', content: 'hi', signal: controller.signal });
  await flushMicrotasks();
  assert.ok(receivedSignal, 'fetch must receive an abort signal');
  assert.equal(receivedSignal.aborted, false);
  controller.abort();

  await assert.rejects(pending, (err) => Boolean(err) && err.name === 'AbortError');
});

test('prompt times out after 10s with DSH_SESSION_API_UNAVAILABLE', async (t) => {
  // node:test mock timers auto-reset when this test finishes (Node 24 has no
  // disable(); enable/tick/reset is the MockTimers surface).
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fetchImpl = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });
  const client = createDshChatClient({ fetchImpl, baseUrlProvider: () => BASE_URL });

  const pending = client.prompt({ sessionId: 's1', content: 'hi' });
  await flushMicrotasks();
  t.mock.timers.tick(10000);

  await assert.rejects(pending, isDshError('DSH_SESSION_API_UNAVAILABLE'));
});

// ---------------------------------------------------------------------------
// streamSession
// ---------------------------------------------------------------------------

test('streamSession forwards only matching text deltas and ends on EOF', async () => {
  const chunks = [
    ': connected\n\n',
    sseFrameFor(sessionEventFrame('other', textChunkEvent('nope'))),
    sseFrameFor(sessionEventFrame('s1', textChunkEvent('Hello'))),
    sseFrameFor(sessionEventFrame('s1', textChunkEvent(' world'))),
    sseFrameFor({ type: 'session/subscribed', sessionId: 's1', lastSeq: 0 }),
    sseFrameFor({ type: 'session/projection', sessionId: 's1', key: 'k', value: {}, seq: 0 }),
  ];
  const fetchImpl = async () => sseResponse(chunks);
  const client = createDshChatClient({ fetchImpl, baseUrlProvider: () => BASE_URL });

  const texts = [];
  let done;
  const result = await client.streamSession({
    sessionId: 's1',
    onText: (text) => texts.push(text),
    onDone: (d) => { done = d; },
  });

  assert.deepStrictEqual(texts, ['Hello', ' world']);
  assert.deepStrictEqual(done, { reason: 'stream-end' });
  assert.deepStrictEqual(result, { reason: 'stream-end' });
});

test('streamSession disconnects with INVALID_RESPONSE when a frame exceeds 1 MiB', async () => {
  const bigText = 'x'.repeat(1024 * 1024 + 16);
  const fetchImpl = async () => sseResponse([
    sseFrameFor(sessionEventFrame('s1', textChunkEvent(bigText))),
  ]);
  const client = createDshChatClient({ fetchImpl, baseUrlProvider: () => BASE_URL });

  const texts = [];
  let done;
  const result = await client.streamSession({
    sessionId: 's1',
    onText: (text) => texts.push(text),
    onDone: (d) => { done = d; },
  });

  assert.deepStrictEqual(texts, []);
  assert.deepStrictEqual(done, { reason: 'DSH_SESSION_API_INVALID_RESPONSE' });
  assert.deepStrictEqual(result, { reason: 'DSH_SESSION_API_INVALID_RESPONSE' });
});

test('streamSession fails closed after 15s without a data frame', async (t) => {
  // node:test mock timers auto-reset when this test finishes (Node 24 has no
  // disable(); enable/tick/reset is the MockTimers surface).
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fetchImpl = async () => hangingSseResponse();
  const client = createDshChatClient({ fetchImpl, baseUrlProvider: () => BASE_URL });

  let done;
  const pending = client.streamSession({
    sessionId: 's1',
    onText: () => {},
    onDone: (d) => { done = d; },
  });
  await flushMicrotasks();
  t.mock.timers.tick(15000);

  const result = await pending;
  assert.deepStrictEqual(done, { reason: 'DSH_SESSION_STREAM_STALLED' });
  assert.deepStrictEqual(result, { reason: 'DSH_SESSION_STREAM_STALLED' });
});

test('streamSession forwards caller signal cancellation as an aborted stream end', async () => {
  let receivedSignal;
  const fetchImpl = async (_url, init) => {
    receivedSignal = init.signal;
    return hangingSseResponse();
  };
  const client = createDshChatClient({ fetchImpl, baseUrlProvider: () => BASE_URL });
  const controller = new AbortController();

  let done;
  const pending = client.streamSession({
    sessionId: 's1',
    onText: () => {},
    onDone: (d) => { done = d; },
    signal: controller.signal,
  });
  await flushMicrotasks();
  assert.ok(receivedSignal, 'fetch must receive an abort signal');
  assert.equal(receivedSignal.aborted, false);
  controller.abort();

  const result = await pending;
  assert.deepStrictEqual(done, { reason: 'aborted' });
  assert.deepStrictEqual(result, { reason: 'aborted' });
});

test('streamSession rejects a non-loopback base URL without fetching', async () => {
  let fetched = false;
  const fetchImpl = async () => {
    fetched = true;
    throw new Error('must not be called');
  };
  const client = createDshChatClient({
    fetchImpl,
    baseUrlProvider: () => 'http://evil.example.com:3080',
  });

  await assert.rejects(
    client.streamSession({ sessionId: 's1', onText: () => {}, onDone: () => {} }),
    isDshError('DSH_SESSION_API_UNAVAILABLE')
  );
  assert.equal(fetched, false);
});

test('streamSession reports fetch failures through onDone and resolves', async () => {
  const fetchImpl = async () => {
    throw new Error('connection refused');
  };
  const client = createDshChatClient({ fetchImpl, baseUrlProvider: () => BASE_URL });

  let done;
  const result = await client.streamSession({
    sessionId: 's1',
    onText: () => {},
    onDone: (d) => { done = d; },
  });

  assert.deepStrictEqual(done, { reason: 'DSH_SESSION_API_UNAVAILABLE' });
  assert.deepStrictEqual(result, { reason: 'DSH_SESSION_API_UNAVAILABLE' });
});

test('streamSession reports non-200 through onDone and resolves', async () => {
  const fetchImpl = async () => ({ status: 503, body: null, async text() { return ''; } });
  const client = createDshChatClient({ fetchImpl, baseUrlProvider: () => BASE_URL });

  let done;
  const result = await client.streamSession({
    sessionId: 's1',
    onText: () => {},
    onDone: (d) => { done = d; },
  });

  assert.deepStrictEqual(done, { reason: 'DSH_SESSION_API_UNAVAILABLE' });
  assert.deepStrictEqual(result, { reason: 'DSH_SESSION_API_UNAVAILABLE' });
});

test('streamSession routes malformed SSE data to INVALID_RESPONSE', async () => {
  const fetchImpl = async () => sseResponse(['data: {not-json}\n\n']);
  const client = createDshChatClient({ fetchImpl, baseUrlProvider: () => BASE_URL });

  let done;
  const result = await client.streamSession({
    sessionId: 's1',
    onText: () => {},
    onDone: (d) => { done = d; },
  });

  assert.deepStrictEqual(done, { reason: 'DSH_SESSION_API_INVALID_RESPONSE' });
  assert.deepStrictEqual(result, { reason: 'DSH_SESSION_API_INVALID_RESPONSE' });
});

test('streamSession routes onText failures to onDone consumer-error without rejecting', async () => {
  const chunks = [
    sseFrameFor(sessionEventFrame('s1', textChunkEvent('boom'))),
  ];
  const fetchImpl = async () => sseResponse(chunks);
  const client = createDshChatClient({ fetchImpl, baseUrlProvider: () => BASE_URL });

  let done;
  const result = await client.streamSession({
    sessionId: 's1',
    onText: () => { throw new Error('consumer boom'); },
    onDone: (d) => { done = d; },
  });

  assert.deepStrictEqual(done, { reason: 'consumer-error' });
  assert.deepStrictEqual(result, { reason: 'consumer-error' });
});

// ---------------------------------------------------------------------------
// rejection hygiene
// ---------------------------------------------------------------------------

test('error paths leave no unhandled rejections', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    // prompt non-JSON
    {
      const client = createDshChatClient({
        fetchImpl: async () => ({ status: 200, async text() { return 'bad'; } }),
        baseUrlProvider: () => BASE_URL,
      });
      await assert.rejects(
        client.prompt({ sessionId: 's1', content: 'hi' }),
        isDshError('DSH_SESSION_API_INVALID_RESPONSE')
      );
    }

    // prompt aborted by caller
    {
      const controller = new AbortController();
      const fetchImpl = async (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
      const client = createDshChatClient({ fetchImpl, baseUrlProvider: () => BASE_URL });
      const pending = client.prompt({ sessionId: 's1', content: 'hi', signal: controller.signal });
      await flushMicrotasks();
      controller.abort();
      await assert.rejects(pending, (err) => err && err.name === 'AbortError');
    }

    // stream oversize
    {
      const client = createDshChatClient({
        fetchImpl: async () => sseResponse([
          sseFrameFor(sessionEventFrame('s1', textChunkEvent('x'.repeat(1024 * 1024 + 16)))),
        ]),
        baseUrlProvider: () => BASE_URL,
      });
      await client.streamSession({ sessionId: 's1', onText: () => {}, onDone: () => {} });
    }

    // stream fetch failure
    {
      const client = createDshChatClient({
        fetchImpl: async () => { throw new Error('down'); },
        baseUrlProvider: () => BASE_URL,
      });
      await client.streamSession({ sessionId: 's1', onText: () => {}, onDone: () => {} });
    }

    // stream aborted by caller
    {
      const controller = new AbortController();
      const client = createDshChatClient({
        fetchImpl: async () => hangingSseResponse(),
        baseUrlProvider: () => BASE_URL,
      });
      const pending = client.streamSession({
        sessionId: 's1',
        onText: () => {},
        onDone: () => {},
        signal: controller.signal,
      });
      await flushMicrotasks();
      controller.abort();
      await pending;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepStrictEqual(unhandled, []);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});
