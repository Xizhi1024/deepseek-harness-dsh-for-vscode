'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createInlineCompletionProvider,
  resetFimUnavailableNotification,
} = require('../../src/inlineCompletion.js');

const flush = () => new Promise((resolve) => setImmediate(resolve));

class FakeTimers {
  constructor() {
    this.now = 0;
    this._nextId = 1;
    this._timers = new Map();
    this.clears = 0;
  }

  setTimeout(fn, delay = 0) {
    const id = this._nextId;
    this._nextId += 1;
    this._timers.set(id, { fn, due: this.now + delay });
    return id;
  }

  clearTimeout(id) {
    if (this._timers.delete(id)) this.clears += 1;
  }

  pendingCount() {
    return this._timers.size;
  }

  advance(ms) {
    const target = this.now + ms;
    for (;;) {
      const dueEntries = [...this._timers.entries()]
        .filter(([, timer]) => timer.due <= target)
        .sort((a, b) => a[1].due - b[1].due || a[0] - b[0]);
      if (dueEntries.length === 0) break;
      const [id, timer] = dueEntries[0];
      this._timers.delete(id);
      this.now = timer.due;
      timer.fn();
    }
    this.now = target;
  }
}

function makeDoc(text) {
  return { getText: () => text };
}

function makePos(line, character) {
  return { line, character };
}

function sseResponse(text, { status = 200, ok = true, contentType = 'text/event-stream' } = {}) {
  return {
    ok,
    status,
    headers: {
      get(name) {
        return name.toLowerCase() === 'content-type' ? contentType : null;
      },
    },
    text: async () => text,
  };
}

function makeHarness(overrides = {}) {
  const timers = new FakeTimers();
  const fetchCalls = [];
  const logs = [];
  const customFetch = overrides.fetchImpl;

  const deps = {
    getServerUrl: () => 'http://127.0.0.1:3080',
    tokenProvider: () => 'bridge-token',
    getModel: () => 'fim-model',
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      return sseResponse('data: {"text":"ok"}\n\ndata: [DONE]\n\n');
    },
    log: (...args) => {
      logs.push(args);
    },
    setTimeout: (fn, ms) => timers.setTimeout(fn, ms),
    clearTimeout: (id) => timers.clearTimeout(id),
    now: () => timers.now,
    ...overrides,
  };

  if (customFetch) {
    deps.fetchImpl = async (url, options) => {
      fetchCalls.push({ url, options });
      return customFetch(url, options);
    };
  }

  const api = createInlineCompletionProvider(deps);
  return { api, timers, fetchCalls, logs, deps };
}

function parseBody(call) {
  return JSON.parse(call.options.body);
}

test('createInlineCompletionProvider returns a frozen {provider, dispose} handle', () => {
  const h = makeHarness();
  assert.ok(Object.isFrozen(h.api));
  assert.ok(Object.isFrozen(h.api.provider));
  assert.equal(typeof h.api.dispose, 'function');
  assert.equal(typeof h.api.provider.provideInlineCompletionItems, 'function');
});

test('debounce: calls within 150ms collapse to exactly one fetch and the last call wins', async () => {
  const h = makeHarness({
    fetchImpl: async () => sseResponse('data: {"text":"X"}\n\ndata: [DONE]\n\n'),
  });

  let text = 'alpha\nbeta\ngamma';
  const doc = { getText: () => text };
  const pos = makePos(2, 3);

  const p1 = h.api.provider.provideInlineCompletionItems(doc, pos, {}, {});
  h.timers.advance(100);

  text = 'alpha\nbeta\nchanged';
  const p2 = h.api.provider.provideInlineCompletionItems(doc, pos, {}, {});
  h.timers.advance(100);

  const p3 = h.api.provider.provideInlineCompletionItems(doc, pos, {}, {});
  assert.equal(h.timers.clears, 2, 'two superseded debounce timers are cleared');
  h.timers.advance(149);

  assert.equal(h.fetchCalls.length, 0, 'no fetch before the debounce timer fires');

  h.timers.advance(1);
  await flush();

  assert.equal(h.fetchCalls.length, 1, 'exactly one fetch after the window');
  const body = parseBody(h.fetchCalls[0]);
  assert.equal(body.model, 'fim-model');
  assert.equal(body.prefix, 'alpha\nbeta\ncha', 'prefix comes from the last call');
  assert.equal(body.suffix, 'nged', 'suffix comes from the last call');

  const results = await Promise.all([p1, p2, p3]);
  assert.deepEqual(results[0], [], 'superseded first call resolves to []');
  assert.deepEqual(results[1], [], 'superseded second call resolves to []');
  assert.equal(results[2].length, 1);
  assert.equal(results[2][0].insertText, 'X');
  assert.ok(h.timers.clears >= 3, 'timeout timer is cleared after the request');
});

test('single-flight: a new call during an in-flight request returns [] and does not interrupt it', async () => {
  let resolveFetch;
  const pending = new Promise((resolve) => {
    resolveFetch = resolve;
  });

  const h = makeHarness({ fetchImpl: () => pending });

  const doc = makeDoc('one\ntwo\nthree');
  const pos = makePos(2, 3);

  const p1 = h.api.provider.provideInlineCompletionItems(doc, pos, {}, {});
  h.timers.advance(150);
  assert.equal(h.fetchCalls.length, 1, 'first request is in flight');

  const second = h.api.provider.provideInlineCompletionItems(doc, pos, {}, {});
  assert.deepEqual(second, [], 'single-flight returns [] immediately');

  resolveFetch(sseResponse('data: {"text":"ok"}\n\ndata: [DONE]\n\n'));
  const firstResult = await p1;
  assert.equal(firstResult.length, 1, 'in-flight request is not interrupted');
  assert.equal(firstResult[0].insertText, 'ok');
  assert.equal(h.fetchCalls.length, 1, 'no second request was queued');
});

test('timeout: the request survives a slow (1-3s) LLM round trip and aborts only at 5000ms (F-j)', async () => {
  let aborted = false;
  let resolveFetch;
  const h = makeHarness({
    fetchImpl: (url, options) => new Promise((resolve, reject) => {
      resolveFetch = resolve;
      options.signal.addEventListener('abort', () => {
        aborted = true;
        const error = new Error('Aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
  });

  const p = h.api.provider.provideInlineCompletionItems(
    makeDoc('one\ntwo'),
    makePos(1, 2),
    {},
    {},
  );
  h.timers.advance(150);
  assert.equal(h.fetchCalls.length, 1);

  // The old 800ms budget killed every real upstream LLM response in flight;
  // a typical 3s round trip must now complete normally.
  h.timers.advance(800);
  assert.equal(aborted, false, '800ms must no longer abort the request');
  h.timers.advance(2200); // t = 3000ms since request start
  assert.equal(aborted, false, 'a 3s LLM round trip must still be in flight');
  resolveFetch(sseResponse('data: {"text":"late"}\n\ndata: [DONE]\n\n'));
  const result = await p;
  assert.equal(result.length, 1, 'slow-but-successful response yields a completion');
  assert.equal(result[0].insertText, 'late');
});

test('timeout: 5000ms total budget still aborts a hung request and returns [] (F-j)', async () => {
  const h = makeHarness({
    fetchImpl: (url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('Aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
  });

  const p = h.api.provider.provideInlineCompletionItems(
    makeDoc('one\ntwo'),
    makePos(1, 2),
    {},
    {},
  );
  h.timers.advance(150);
  assert.equal(h.fetchCalls.length, 1);

  h.timers.advance(4999);
  h.timers.advance(1);

  assert.deepEqual(await p, []);
  assert.equal(h.fetchCalls.length, 1);
});

test('503: guidance message is extracted and onFimUnavailable fires exactly once per session (F-e)', async () => {
  resetFimUnavailableNotification();
  const unavailableCalls = [];
  const guidance = 'Tab completion is not configured: set dsh.fim.baseUrl and store the DSH FIM API key';
  const make503Harness = () => makeHarness({
    onFimUnavailable: (text) => unavailableCalls.push(text),
    fetchImpl: async () => sseResponse(JSON.stringify({ error: 'fim-not-configured', message: guidance }), {
      status: 503,
      ok: false,
      contentType: 'application/json',
    }),
  });

  const h1 = make503Harness();
  const p1 = h1.api.provider.provideInlineCompletionItems(makeDoc('one\ntwo'), makePos(1, 2), {}, {});
  h1.timers.advance(150);
  assert.deepEqual(await p1, [], '503 still fails quiet for the completion itself');

  // A second request — and even a brand-new provider instance — must not
  // re-notify: the flag is module-level (one prompt per session).
  const h2 = make503Harness();
  const p2 = h2.api.provider.provideInlineCompletionItems(makeDoc('one\ntwo'), makePos(1, 2), {}, {});
  h2.timers.advance(150);
  assert.deepEqual(await p2, []);

  assert.deepEqual(unavailableCalls, [guidance], 'guidance surfaced exactly once');
  resetFimUnavailableNotification();
});

test('503 with a non-JSON body still notifies once with the raw text (F-e)', async () => {
  resetFimUnavailableNotification();
  const unavailableCalls = [];
  const h = makeHarness({
    onFimUnavailable: (text) => unavailableCalls.push(text),
    fetchImpl: async () => sseResponse('plain guidance body', { status: 503, ok: false }),
  });

  const p = h.api.provider.provideInlineCompletionItems(makeDoc('one\ntwo'), makePos(1, 2), {}, {});
  h.timers.advance(150);
  assert.deepEqual(await p, []);
  assert.deepEqual(unavailableCalls, ['plain guidance body']);
  resetFimUnavailableNotification();
});

test('non-503 failures never trigger onFimUnavailable (F-e)', async () => {
  resetFimUnavailableNotification();
  const unavailableCalls = [];
  const h = makeHarness({
    onFimUnavailable: (text) => unavailableCalls.push(text),
    fetchImpl: async () => sseResponse('boom', { status: 500, ok: false }),
  });

  const p = h.api.provider.provideInlineCompletionItems(makeDoc('one\ntwo'), makePos(1, 2), {}, {});
  h.timers.advance(150);
  assert.deepEqual(await p, []);
  assert.deepEqual(unavailableCalls, [], '500 is not the not-configured signal');
  resetFimUnavailableNotification();
});

test('SSE: multiple data frames are concatenated and [DONE] stops the parse', async () => {
  const h = makeHarness({
    fetchImpl: async () => sseResponse(
      'data: {"text":"hel"}\n\ndata: {"text":"lo"}\n\ndata: [DONE]\n\ndata: {"text":"ignored"}\n\n',
    ),
  });

  const p = h.api.provider.provideInlineCompletionItems(
    makeDoc('one\ntwo'),
    makePos(1, 2),
    {},
    {},
  );
  h.timers.advance(150);
  const result = await p;

  assert.equal(result.length, 1);
  assert.equal(result[0].insertText, 'hello');
  assert.equal(h.timers.pendingCount(), 0);
});

test('SSE: a normally closed stream without [DONE] finalizes with accumulated text', async () => {
  const h = makeHarness({
    fetchImpl: async () => sseResponse('data: {"text":"foo"}\n\ndata: {"text":"bar"}\n\n'),
  });

  const p = h.api.provider.provideInlineCompletionItems(
    makeDoc('one\ntwo'),
    makePos(1, 2),
    {},
    {},
  );
  h.timers.advance(150);
  const result = await p;

  assert.equal(result.length, 1);
  assert.equal(result[0].insertText, 'foobar');
});

test('SSE failures are fail-quiet: non-200, event:error, and malformed JSON all return []', async () => {
  const cases = [
    {
      name: 'non-200',
      response: sseResponse('ignored', { status: 500, ok: false }),
    },
    {
      name: 'event:error frame',
      response: sseResponse('event: error\ndata: {"text":"x"}\n\n'),
    },
    {
      name: 'malformed JSON data line',
      response: sseResponse('data: {"text":\n\n'),
    },
  ];

  for (const item of cases) {
    const h = makeHarness({ fetchImpl: async () => item.response });
    const p = h.api.provider.provideInlineCompletionItems(
      makeDoc('one\ntwo'),
      makePos(1, 2),
      {},
      {},
    );
    h.timers.advance(150);
    const result = await p;
    assert.deepEqual(result, [], item.name + ' should return []');
    assert.ok(h.logs.length >= 1, item.name + ' should log');
  }
});

test('candidate shape: one item, pure suffix insertText, range covers line start to cursor', async () => {
  const h = makeHarness({
    fetchImpl: async () => sseResponse('data: {"text":"world"}\n\ndata: [DONE]\n\n'),
  });

  const p = h.api.provider.provideInlineCompletionItems(
    makeDoc('one\ntwo\nthree'),
    makePos(2, 3),
    {},
    {},
  );
  h.timers.advance(150);
  const result = await p;

  assert.equal(result.length, 1);
  assert.equal(result[0].insertText, 'world');
  assert.ok(!result[0].insertText.includes('thr'), 'insertText must not repeat cursor prefix');
  assert.deepEqual(result[0].range, {
    start: { line: 2, character: 0 },
    end: { line: 2, character: 3 },
  });

  const body = parseBody(h.fetchCalls[0]);
  assert.equal(body.prefix, 'one\ntwo\nthr');
  assert.equal(body.suffix, 'ee');
  assert.equal(h.fetchCalls[0].url, 'http://127.0.0.1:3080/api/fim');
  assert.equal(h.fetchCalls[0].options.method, 'POST');
  assert.equal(h.fetchCalls[0].options.headers.Authorization, 'Bearer bridge-token');
  assert.equal(h.fetchCalls[0].options.headers['Content-Type'], 'application/json');
});

test('empty accumulated SSE text returns []', async () => {
  const h = makeHarness({ fetchImpl: async () => sseResponse('data: [DONE]\n\n') });

  const p = h.api.provider.provideInlineCompletionItems(
    makeDoc('one\ntwo'),
    makePos(1, 2),
    {},
    {},
  );
  h.timers.advance(150);
  const result = await p;

  assert.deepEqual(result, []);
});

test('context window keeps at most 64 previous lines and 32 following lines', async () => {
  const lines = [];
  for (let i = 0; i < 200; i += 1) {
    lines.push('L' + String(i).padStart(3, '0'));
  }
  const h = makeHarness({
    fetchImpl: async () => sseResponse('data: {"text":"ok"}\n\ndata: [DONE]\n\n'),
  });

  const p = h.api.provider.provideInlineCompletionItems(
    makeDoc(lines.join('\n')),
    makePos(100, 2),
    {},
    {},
  );
  h.timers.advance(150);
  const result = await p;
  assert.equal(result.length, 1);

  const body = parseBody(h.fetchCalls[0]);
  assert.ok(body.prefix.startsWith('L036\n'), 'prefix starts at line 36 (64 lines back)');
  assert.ok(!body.prefix.includes('L035'), 'prefix excludes line 35');
  assert.ok(body.prefix.endsWith('L1'), 'prefix ends with the cursor-line prefix');
  assert.ok(body.suffix.startsWith('00\nL101'), 'suffix starts with cursor-line suffix then line 101');
  assert.ok(body.suffix.endsWith('L132'), 'suffix ends at line 132 (32 lines ahead)');
  assert.ok(!body.suffix.includes('L133'), 'suffix excludes line 133');
});

test('128 KiB window truncates prefix top first, then suffix bottom', async () => {
  const longLine = (i) => 'L' + String(i).padStart(4, '0') + ':' + 'x'.repeat(3994);
  const lines = [];
  for (let i = 0; i < 200; i += 1) {
    lines.push(longLine(i));
  }

  const h = makeHarness({
    fetchImpl: async () => sseResponse('data: {"text":"ok"}\n\ndata: [DONE]\n\n'),
  });

  const p = h.api.provider.provideInlineCompletionItems(
    makeDoc(lines.join('\n')),
    makePos(100, 2),
    {},
    {},
  );
  h.timers.advance(150);
  const result = await p;
  assert.equal(result.length, 1);

  const body = parseBody(h.fetchCalls[0]);
  assert.equal(body.prefix, 'L0', 'all 64 previous lines were dropped before suffix was touched');
  assert.ok(body.suffix.includes('L0131:'), 'suffix keeps following line 131');
  assert.ok(!body.suffix.includes('L0132:'), 'suffix dropped newest following line 132');
  assert.ok(
    Buffer.byteLength(body.prefix + body.suffix, 'utf8') <= 128 * 1024,
    'final context fits in 128 KiB',
  );
});

test('missing serverUrl, token, or model returns [] with zero requests and zero timers', async () => {
  const cases = [
    { getServerUrl: () => null },
    { getServerUrl: () => '' },
    { tokenProvider: () => null },
    { tokenProvider: () => '' },
    { getModel: () => '' },
  ];

  for (const overrides of cases) {
    const h = makeHarness(overrides);
    const result = h.api.provider.provideInlineCompletionItems(
      makeDoc('one\ntwo'),
      makePos(1, 2),
      {},
      {},
    );
    assert.deepEqual(result, []);
    assert.equal(h.fetchCalls.length, 0);
    assert.equal(h.timers.pendingCount(), 0);
  }
});

test('fewer than 2 chars before the cursor returns [] with zero requests and zero timers', async () => {
  const h = makeHarness();
  const result = h.api.provider.provideInlineCompletionItems(
    makeDoc('a\nbc'),
    makePos(1, 1),
    {},
    {},
  );
  assert.deepEqual(result, []);
  assert.equal(h.fetchCalls.length, 0);
  assert.equal(h.timers.pendingCount(), 0);
});

test('cancellation token aborts the in-flight request and returns []', async () => {
  let cancelCallback;
  const h = makeHarness({
    fetchImpl: (url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('Aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
  });

  const token = {
    onCancellationRequested(callback) {
      cancelCallback = callback;
      return { dispose() {} };
    },
  };

  const p = h.api.provider.provideInlineCompletionItems(
    makeDoc('one\ntwo'),
    makePos(1, 2),
    {},
    token,
  );
  h.timers.advance(150);
  assert.equal(h.fetchCalls.length, 1);

  cancelCallback();
  assert.deepEqual(await p, []);
  assert.equal(h.fetchCalls.length, 1);
});

test('a fake token without onCancellationRequested is tolerated', async () => {
  const h = makeHarness();

  const p = h.api.provider.provideInlineCompletionItems(
    makeDoc('one\ntwo'),
    makePos(1, 2),
    {},
    {},
  );
  h.timers.advance(150);
  const result = await p;

  assert.equal(result.length, 1);
  assert.equal(h.timers.pendingCount(), 0);
  assert.ok(h.timers.clears >= 1, 'timeout timer is cleared');
});

test('dispose clears pending debounce, blocks future calls, and is idempotent', async () => {
  const h = makeHarness();

  const p = h.api.provider.provideInlineCompletionItems(
    makeDoc('one\ntwo'),
    makePos(1, 2),
    {},
    {},
  );
  assert.equal(h.timers.pendingCount(), 1, 'debounce timer is pending');

  h.api.dispose();
  h.api.dispose();

  assert.deepEqual(await p, [], 'pending debounce is resolved with [] on dispose');
  assert.equal(h.timers.pendingCount(), 0, 'debounce timer is cleared');
  assert.equal(h.fetchCalls.length, 0, 'cleared debounce never fetches');

  const later = h.api.provider.provideInlineCompletionItems(
    makeDoc('one\ntwo'),
    makePos(1, 2),
    {},
    {},
  );
  assert.deepEqual(later, [], 'calls after dispose return []');
  assert.equal(h.fetchCalls.length, 0);
});

test('dispose aborts an in-flight request', async () => {
  let aborted = false;
  const h = makeHarness({
    fetchImpl: (url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        aborted = true;
        const error = new Error('Aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
  });

  const p = h.api.provider.provideInlineCompletionItems(
    makeDoc('one\ntwo'),
    makePos(1, 2),
    {},
    {},
  );
  h.timers.advance(150);
  assert.equal(h.fetchCalls.length, 1);

  h.api.dispose();
  assert.equal(aborted, true, 'dispose aborts the in-flight controller');
  assert.deepEqual(await p, []);
});

test('timer hygiene: successful request leaves no pending timers and clears the timeout timer', async () => {
  const h = makeHarness();

  const p = h.api.provider.provideInlineCompletionItems(
    makeDoc('one\ntwo'),
    makePos(1, 2),
    {},
    {},
  );
  h.timers.advance(150);
  const result = await p;

  assert.equal(result.length, 1);
  assert.equal(h.timers.pendingCount(), 0);
  assert.ok(h.timers.clears >= 1, '800ms timeout timer is cleared after the response');
});
