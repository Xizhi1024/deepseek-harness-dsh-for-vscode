'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createDshChatClient } = require('../../src/dshChatClient');

const BASE_URL = 'http://127.0.0.1:3080';
const PROMPT_URL = `${BASE_URL}/api/session/prompt`;

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

// ---------------------------------------------------------------------------
// stubbed session/follow transport
// ---------------------------------------------------------------------------

/**
 * Controllable `createStream` stub: records the open call, captures the
 * stream's `onValue`/`signal`, and lets the test push item values or settle
 * `done`. Mirrors the transport contract (`{streamId, cancel, done}`) and the
 * real abort behaviour (abort settles `done` with `{reason:'aborted'}`).
 */
let lastStream = null;
function createStreamStub() {
  lastStream = null;
  return async function stubCreateStream(opts) {
    const stream = {
      baseUrl: opts.baseUrl,
      endpoint: opts.endpoint,
      args: opts.args,
      signal: opts.signal,
      onValue: opts.onValue,
      streamId: 'stream-1',
      canceled: 0,
      resolveDone: null,
      done: null,
    };
    stream.done = new Promise((resolve) => {
      stream.resolveDone = resolve;
    });
    if (opts.signal) {
      if (opts.signal.aborted) {
        stream.resolveDone({ reason: 'aborted' });
      } else {
        opts.signal.addEventListener(
          'abort',
          () => stream.resolveDone({ reason: 'aborted' }),
          { once: true }
        );
      }
    }
    stream.cancel = () => {
      stream.canceled += 1;
    };
    lastStream = stream;
    return stream;
  };
}

function snapshotValue(records = []) {
  return { type: 'snapshot', header: {}, cursor: 0, records, hasMore: false, projections: {} };
}

function liveChunkValue(text, index) {
  return {
    type: 'event',
    event: {
      type: 'assistant/live-chunk',
      seq: 1,
      time: Date.now(),
      data: { turn: 0, step: 0, chunk: { type: 'text-delta', index, text } },
    },
  };
}

function toolCallValue(name) {
  return {
    type: 'event',
    event: {
      type: 'tool/call',
      seq: 2,
      time: Date.now(),
      data: { name, arguments: { file_path: '/a/b.ts' } },
    },
  };
}

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

function promptArgs(envelope) {
  return envelope.payload.args.request;
}

// ---------------------------------------------------------------------------
// prompt
// ---------------------------------------------------------------------------

test('prompt posts a typert envelope with client-minted requestId and returns {accepted:true, sessionId}', async () => {
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
  assert.equal(calls[0].envelope.method, 'session/prompt');
  assert.ok(typeof calls[0].envelope.rpcId === 'string' && calls[0].envelope.rpcId.length > 0);

  const args = promptArgs(calls[0].envelope);
  assert.equal(args.sessionId, 's1');
  assert.equal(args.mode, 'queue');
  assert.deepStrictEqual(args.content, [{ type: 'text', text: 'hi' }]);
  assert.ok(typeof args.requestId === 'string' && args.requestId.length > 0, 'requestId must be client-minted');
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

  const args = promptArgs(seen);
  assert.equal(args.sessionId, 's2');
  assert.equal(args.mode, 'steer');
  assert.deepStrictEqual(args.content, [{ type: 'text', text: 'part' }]);
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
// openFollow
// ---------------------------------------------------------------------------

test('openFollow sends session/follow with a session address and resolves ready with the snapshot', async () => {
  const client = createDshChatClient({
    createStream: createStreamStub(),
    baseUrlProvider: () => BASE_URL,
  });

  const handle = await client.openFollow({ sessionId: 's1', onValue: () => {} });

  assert.ok(lastStream, 'createStream must be called');
  assert.strictEqual(lastStream.baseUrl, BASE_URL + '/');
  assert.strictEqual(lastStream.endpoint, 'session/follow');
  assert.deepStrictEqual(lastStream.args, {
    request: { address: { kind: 'session', sessionId: 's1' } },
  });

  lastStream.onValue(snapshotValue());
  assert.strictEqual((await handle.ready).type, 'snapshot');
  handle.cancel();
  assert.strictEqual(lastStream.canceled, 1);
});

test('openFollow forwards maxMessages and assistantStream when requested', async () => {
  const client = createDshChatClient({
    createStream: createStreamStub(),
    baseUrlProvider: () => BASE_URL,
  });

  const handle = await client.openFollow({ sessionId: 's1', onValue: () => {}, maxMessages: 300, assistantStream: true });
  assert.deepStrictEqual(lastStream.args, {
    request: { address: { kind: 'session', sessionId: 's1' }, maxMessages: 300, assistantStream: true },
  });
  handle.cancel();
});

test('openFollow resolves ready with null when the stream dies before the snapshot', async () => {
  const client = createDshChatClient({
    createStream: createStreamStub(),
    baseUrlProvider: () => BASE_URL,
  });

  const handle = await client.openFollow({ sessionId: 's1', onValue: () => {} });
  lastStream.resolveDone({ reason: 'error', error: { code: 'nope', message: 'x' } });

  assert.strictEqual(await handle.ready, null);
});

test('openFollow wraps transport open failures as DSH_SESSION_API_UNAVAILABLE', async () => {
  const client = createDshChatClient({
    createStream: async () => { throw new Error('connection refused'); },
    baseUrlProvider: () => BASE_URL,
  });

  await assert.rejects(
    client.openFollow({ sessionId: 's1', onValue: () => {} }),
    isDshError('DSH_SESSION_API_UNAVAILABLE')
  );
});

test('openFollow propagates transport failures unchanged when the caller signal already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  let attempted = 0;
  const client = createDshChatClient({
    createStream: async () => { attempted += 1; throw new Error('must not open'); },
    baseUrlProvider: () => BASE_URL,
  });

  await assert.rejects(
    client.openFollow({ sessionId: 's1', onValue: () => {}, signal: controller.signal }),
    (err) => Boolean(err) && err.message === 'must not open'
  );
  assert.strictEqual(attempted, 1);
});

// ---------------------------------------------------------------------------
// streamSession
// ---------------------------------------------------------------------------

test('streamSession opens session/follow with assistantStream and forwards live text deltas in order', async () => {
  const client = createDshChatClient({
    createStream: createStreamStub(),
    baseUrlProvider: () => BASE_URL,
  });
  const texts = [];
  const events = [];
  let ready = null;
  let done;
  const pending = client.streamSession({
    sessionId: 's1',
    onText: (text) => texts.push(text),
    onEvent: (event) => events.push(event),
    onReady: (snapshot) => { ready = snapshot; },
    onDone: (d) => { done = d; },
  });

  await flushMicrotasks();
  assert.ok(lastStream, 'streamSession must open a stream');
  assert.strictEqual(lastStream.baseUrl, BASE_URL + '/');
  assert.strictEqual(lastStream.endpoint, 'session/follow');
  assert.deepStrictEqual(lastStream.args, {
    request: { address: { kind: 'session', sessionId: 's1' }, assistantStream: true },
  });

  lastStream.onValue(snapshotValue());
  lastStream.onValue(liveChunkValue('Hello', 0));
  lastStream.onValue(toolCallValue('edit'));
  lastStream.onValue(liveChunkValue(' world', 1));
  await flushMicrotasks();

  assert.deepStrictEqual(texts, ['Hello', ' world']);
  assert.strictEqual(events.length, 3, 'every live event must reach onEvent before the text filter');
  assert.deepStrictEqual(events.map((e) => e.type), ['assistant/live-chunk', 'tool/call', 'assistant/live-chunk']);
  assert.strictEqual(ready.type, 'snapshot', 'onReady must receive the snapshot');

  lastStream.resolveDone({ reason: 'end' });
  const result = await pending;
  assert.deepStrictEqual(done, { reason: 'stream-end' });
  assert.deepStrictEqual(result, { reason: 'stream-end' });
});

test('streamSession maps an aborted stream end to aborted', async () => {
  const client = createDshChatClient({
    createStream: createStreamStub(),
    baseUrlProvider: () => BASE_URL,
  });
  let done;
  const pending = client.streamSession({
    sessionId: 's1',
    onText: () => {},
    onDone: (d) => { done = d; },
  });
  await flushMicrotasks();
  lastStream.resolveDone({ reason: 'aborted' });

  const result = await pending;
  assert.deepStrictEqual(done, { reason: 'aborted' });
  assert.deepStrictEqual(result, { reason: 'aborted' });
});

test('streamSession maps an error end to DSH_SESSION_API_UNAVAILABLE', async () => {
  const client = createDshChatClient({
    createStream: createStreamStub(),
    baseUrlProvider: () => BASE_URL,
  });
  let done;
  const pending = client.streamSession({
    sessionId: 's1',
    onText: () => {},
    onDone: (d) => { done = d; },
  });
  await flushMicrotasks();
  lastStream.resolveDone({ reason: 'error', error: { code: 'boom', message: 'x' } });

  const result = await pending;
  assert.deepStrictEqual(done, { reason: 'DSH_SESSION_API_UNAVAILABLE' });
  assert.deepStrictEqual(result, { reason: 'DSH_SESSION_API_UNAVAILABLE' });
});

test('streamSession cancels the stream when the caller signal aborts', async () => {
  const controller = new AbortController();
  const client = createDshChatClient({
    createStream: createStreamStub(),
    baseUrlProvider: () => BASE_URL,
  });
  let done;
  const pending = client.streamSession({
    sessionId: 's1',
    onText: () => {},
    onDone: (d) => { done = d; },
    signal: controller.signal,
  });
  await flushMicrotasks();
  assert.ok(lastStream, 'stream must be open');
  assert.strictEqual(lastStream.signal, controller.signal);
  assert.equal(lastStream.signal.aborted, false);

  controller.abort();
  const result = await pending;
  assert.deepStrictEqual(done, { reason: 'aborted' });
  assert.deepStrictEqual(result, { reason: 'aborted' });
  assert.ok(lastStream.canceled >= 1, 'abort must cancel the stream');
});

test('streamSession returns aborted immediately for an already-aborted signal', async () => {
  const controller = new AbortController();
  controller.abort();
  let createCalls = 0;
  const client = createDshChatClient({
    createStream: async () => { createCalls += 1; throw new Error('must not open'); },
    baseUrlProvider: () => BASE_URL,
  });
  let done;
  const result = await client.streamSession({
    sessionId: 's1',
    onText: () => {},
    onDone: (d) => { done = d; },
    signal: controller.signal,
  });

  assert.strictEqual(createCalls, 0);
  assert.deepStrictEqual(done, { reason: 'aborted' });
  assert.deepStrictEqual(result, { reason: 'aborted' });
});

test('streamSession rejects a non-loopback base URL without opening a stream', async () => {
  const client = createDshChatClient({
    createStream: createStreamStub(),
    baseUrlProvider: () => 'http://evil.example.com:3080',
  });

  await assert.rejects(
    client.streamSession({ sessionId: 's1', onText: () => {}, onDone: () => {} }),
    isDshError('DSH_SESSION_API_UNAVAILABLE')
  );
  assert.strictEqual(lastStream, null, 'no stream must be opened');
});

test('streamSession rejects when the transport fails to open', async () => {
  const client = createDshChatClient({
    createStream: async () => { throw new Error('connection refused'); },
    baseUrlProvider: () => BASE_URL,
  });

  await assert.rejects(
    client.streamSession({ sessionId: 's1', onText: () => {}, onDone: () => {} }),
    isDshError('DSH_SESSION_API_UNAVAILABLE')
  );
});

test('streamSession routes onText failures to consumer-error and cancels', async () => {
  const client = createDshChatClient({
    createStream: createStreamStub(),
    baseUrlProvider: () => BASE_URL,
  });
  let done;
  const pending = client.streamSession({
    sessionId: 's1',
    onText: () => { throw new Error('consumer boom'); },
    onDone: (d) => { done = d; },
  });
  await flushMicrotasks();
  lastStream.onValue(liveChunkValue('x', 0));
  await flushMicrotasks();

  assert.deepStrictEqual(done, { reason: 'consumer-error' });
  assert.ok(lastStream.canceled >= 1, 'consumer error must cancel the stream');

  lastStream.resolveDone({ reason: 'closed' });
  const result = await pending;
  assert.deepStrictEqual(result, { reason: 'consumer-error' });
});

test('streamSession routes onReady failures to consumer-error', async () => {
  const client = createDshChatClient({
    createStream: createStreamStub(),
    baseUrlProvider: () => BASE_URL,
  });
  let done;
  const pending = client.streamSession({
    sessionId: 's1',
    onText: () => {},
    onReady: () => { throw new Error('ready boom'); },
    onDone: (d) => { done = d; },
  });
  await flushMicrotasks();
  lastStream.onValue(snapshotValue());
  await flushMicrotasks();

  assert.deepStrictEqual(done, { reason: 'consumer-error' });

  lastStream.resolveDone({ reason: 'end' });
  const result = await pending;
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

    // stream transport open failure
    {
      const client = createDshChatClient({
        createStream: async () => { throw new Error('down'); },
        baseUrlProvider: () => BASE_URL,
      });
      await assert.rejects(
        client.streamSession({ sessionId: 's1', onText: () => {}, onDone: () => {} }),
        isDshError('DSH_SESSION_API_UNAVAILABLE')
      );
    }

    // stream consumer error
    {
      const client = createDshChatClient({
        createStream: createStreamStub(),
        baseUrlProvider: () => BASE_URL,
      });
      const pending = client.streamSession({
        sessionId: 's1',
        onText: () => { throw new Error('boom'); },
        onDone: () => {},
      });
      await flushMicrotasks();
      lastStream.onValue(liveChunkValue('x', 0));
      await flushMicrotasks();
      lastStream.resolveDone({ reason: 'closed' });
      await pending;
    }

    // stream aborted by caller
    {
      const controller = new AbortController();
      const client = createDshChatClient({
        createStream: createStreamStub(),
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