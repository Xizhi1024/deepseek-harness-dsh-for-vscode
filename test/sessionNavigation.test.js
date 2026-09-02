'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DshSessionError,
  listSessions,
  createSession,
  renameSession,
  ensureWorkspaceSession,
  rootSessionItems,
  reuseBlankSession,
  buildQuickPickItems,
  sessionIdFromValue,
} = require('../src/sessionNavigation');

const BASE_URL = 'http://127.0.0.1:3080';

function jsonResponse(status, body) {
  return {
    status,
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

test('listSessions posts the JSON-RPC envelope, sorts by updatedAt desc and returns a new array', async () => {
  let capturedUrl;
  let capturedInit;
  const input = [
    { sessionId: 'older', updatedAt: 10 },
    { sessionId: 'newer', updatedAt: 30 },
    { sessionId: 'middle', updatedAt: 20, extra: 'passes-through' },
  ];

  const result = await listSessions(BASE_URL, {
    fetchImpl: async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      const request = JSON.parse(init.body);
      return jsonResponse(200, {
        type: 'server-response',
        rpcId: request.rpcId,
        result: { ok: true, value: { items: input } },
      });
    },
  });

  assert.strictEqual(capturedUrl, BASE_URL + '/api/session.list');
  assert.strictEqual(capturedInit.method, 'POST');
  assert.strictEqual(capturedInit.headers['content-type'], 'application/json');
  const request = JSON.parse(capturedInit.body);
  assert.strictEqual(request.type, 'client-request');
  assert.strictEqual(request.method, 'session.list');
  assert.deepStrictEqual(request.payload, {});
  assert.ok(typeof request.rpcId === 'string' && request.rpcId.length > 0, 'rpcId must be a non-empty string');

  assert.deepStrictEqual(result.map((item) => item.sessionId), ['newer', 'middle', 'older']);
  assert.notStrictEqual(result, input, 'listSessions must not mutate or return the input array');
  assert.deepStrictEqual(input[0], { sessionId: 'older', updatedAt: 10 });
});

test('listSessions accepts localhost loopback base URLs', async () => {
  const result = await listSessions('http://localhost:3080', {
    fetchImpl: async () => jsonResponse(200, {
      result: { ok: true, value: { items: [{ sessionId: 'local', updatedAt: 1 }] } },
    }),
  });
  assert.strictEqual(result[0].sessionId, 'local');
});

test('listSessions wraps non-200 responses as DSH_SESSION_API_UNAVAILABLE', async () => {
  await assert.rejects(
    listSessions(BASE_URL, {
      fetchImpl: async () => jsonResponse(503, 'unavailable'),
    }),
    (err) => err instanceof DshSessionError && err.code === 'DSH_SESSION_API_UNAVAILABLE'
  );
});

test('listSessions wraps malformed JSON as DSH_SESSION_API_INVALID_RESPONSE', async () => {
  await assert.rejects(
    listSessions(BASE_URL, {
      fetchImpl: async () => jsonResponse(200, '{this is not json'),
    }),
    (err) => err instanceof DshSessionError && err.code === 'DSH_SESSION_API_INVALID_RESPONSE'
  );
});

test('listSessions validates the response result shape', async () => {
  await assert.rejects(
    listSessions(BASE_URL, {
      fetchImpl: async () => jsonResponse(200, { result: { ok: true, value: {} } }),
    }),
    (err) => err instanceof DshSessionError && err.code === 'DSH_SESSION_API_INVALID_RESPONSE'
  );
  await assert.rejects(
    listSessions(BASE_URL, {
      fetchImpl: async () => jsonResponse(200, { result: { ok: true, value: { items: [{ sessionId: '' }] } } }),
    }),
    (err) => err instanceof DshSessionError && err.code === 'DSH_SESSION_API_INVALID_RESPONSE'
  );
});

test('listSessions wraps business failures and carries error.code', async () => {
  await assert.rejects(
    listSessions(BASE_URL, {
      fetchImpl: async () => jsonResponse(200, {
        result: { ok: false, error: { code: 'NO_SESSION', message: 'boom' } },
      }),
    }),
    (err) => err instanceof DshSessionError
      && err.code === 'DSH_SESSION_API_BUSINESS_ERROR'
      && err.businessCode === 'NO_SESSION'
      && /NO_SESSION/.test(err.message)
  );
});

test('listSessions rejects non-loopback base URLs', async () => {
  for (const bad of [
    'http://example.com:3080',
    'https://127.0.0.1:3080',
    'http://127.0.0.1',
    'not a url',
    '',
  ]) {
    await assert.rejects(
      listSessions(bad, { fetchImpl: async () => jsonResponse(200, {}) }),
      (err) => err instanceof DshSessionError && err.code === 'DSH_SESSION_API_UNAVAILABLE'
    );
  }
});

test('listSessions requires a fetch implementation', async () => {
  await assert.rejects(
    listSessions(BASE_URL, { fetchImpl: 42 }),
    (err) => err instanceof DshSessionError && err.code === 'DSH_SESSION_API_UNAVAILABLE'
  );
});

test('listSessions wraps network failures as DSH_SESSION_API_UNAVAILABLE', async () => {
  await assert.rejects(
    listSessions(BASE_URL, {
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    }),
    (err) => err instanceof DshSessionError && err.code === 'DSH_SESSION_API_UNAVAILABLE'
  );
});

test('listSessions rethrows AbortError unchanged', async () => {
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  await assert.rejects(
    listSessions(BASE_URL, {
      fetchImpl: async () => { throw abort; },
    }),
    (err) => err === abort
  );
});

test('createSession posts session.create, returns sessionId and includes cwd when non-empty', async () => {
  let capturedUrl;
  let capturedBody;
  const sessionId = await createSession(BASE_URL, {
    cwd: 'D:\\workspace',
    fetchImpl: async (url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body);
      return jsonResponse(200, { result: { ok: true, value: { sessionId: 's1' } } });
    },
  });

  assert.strictEqual(sessionId, 's1');
  assert.strictEqual(capturedUrl, BASE_URL + '/api/session.create');
  assert.strictEqual(capturedBody.method, 'session.create');
  assert.deepStrictEqual(capturedBody.payload, { cwd: 'D:\\workspace' });
});

test('createSession posts workspaceId when provided and never mixes in cwd', async () => {
  let capturedBody;
  const sessionId = await createSession(BASE_URL, {
    workspaceId: 'w-1',
    cwd: 'D:\\ignored',
    fetchImpl: async (url, init) => {
      capturedBody = JSON.parse(init.body);
      return jsonResponse(200, { result: { ok: true, value: { sessionId: 's-ws' } } });
    },
  });

  assert.strictEqual(sessionId, 's-ws');
  assert.strictEqual(capturedBody.method, 'session.create');
  assert.deepStrictEqual(capturedBody.payload, { workspaceId: 'w-1' });
});

test('createSession omits cwd from the payload when it is empty or not a string', async () => {
  for (const cwd of [undefined, '', null, 42]) {
    let capturedBody;
    const sessionId = await createSession(BASE_URL, {
      cwd,
      fetchImpl: async (url, init) => {
        capturedBody = JSON.parse(init.body);
        return jsonResponse(200, { result: { ok: true, value: { sessionId: 's2' } } });
      },
    });
    assert.strictEqual(sessionId, 's2');
    assert.deepStrictEqual(capturedBody.payload, {});
  }
});

test('createSession validates result.value.sessionId', async () => {
  await assert.rejects(
    createSession(BASE_URL, {
      fetchImpl: async () => jsonResponse(200, { result: { ok: true, value: {} } }),
    }),
    (err) => err instanceof DshSessionError && err.code === 'DSH_SESSION_API_INVALID_RESPONSE'
  );
});

test('createSession wraps business failures with the same error mapping', async () => {
  await assert.rejects(
    createSession(BASE_URL, {
      fetchImpl: async () => jsonResponse(200, {
        result: { ok: false, error: { code: 'CREATE_DENIED', message: 'no' } },
      }),
    }),
    (err) => err instanceof DshSessionError
      && err.code === 'DSH_SESSION_API_BUSINESS_ERROR'
      && err.businessCode === 'CREATE_DENIED'
  );
});

test('ensureWorkspaceSession reuses a blank root session for the same cwd', async () => {
  const calls = [];
  const sessionId = await ensureWorkspaceSession(BASE_URL, 'D:\\workspace', {
    fetchImpl: async (url, init) => {
      calls.push({ url, method: JSON.parse(init.body).method });
      return jsonResponse(200, {
        result: {
          ok: true,
          value: {
            items: [
              { sessionId: 'blank-1', cwd: 'D:\\workspace', blank: true, updatedAt: 1 },
              { sessionId: 'other', cwd: 'D:\\other', blank: true, updatedAt: 2 },
            ],
          },
        },
      });
    },
  });

  assert.strictEqual(sessionId, 'blank-1');
  assert.deepStrictEqual(calls, [
    { url: BASE_URL + '/api/session.list', method: 'session.list' },
  ]);
});

test('ensureWorkspaceSession creates a session when no blank root session matches', async () => {
  const calls = [];
  const sessionId = await ensureWorkspaceSession(BASE_URL, '/home/me/project', {
    fetchImpl: async (url, init) => {
      const request = JSON.parse(init.body);
      calls.push(request.method);
      if (request.method === 'session.list') {
        return jsonResponse(200, {
          result: {
            ok: true,
            value: { items: [{ sessionId: 'other', cwd: '/tmp', blank: true, updatedAt: 1 }] },
          },
        });
      }
      return jsonResponse(200, { result: { ok: true, value: { sessionId: 'created-1' } } });
    },
  });

  assert.strictEqual(sessionId, 'created-1');
  assert.deepStrictEqual(calls, ['session.list', 'session.create']);
});

test('ensureWorkspaceSession returns null for empty or non-string cwd', async () => {
  let called = false;
  for (const cwd of ['', null, undefined, 42, false]) {
    assert.strictEqual(
      await ensureWorkspaceSession(BASE_URL, cwd, {
        fetchImpl: async () => { called = true; },
      }),
      null
    );
  }
  assert.strictEqual(called, false);
});

test('ensureWorkspaceSession propagates AbortError unchanged', async () => {
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  await assert.rejects(
    ensureWorkspaceSession(BASE_URL, '/ws', {
      fetchImpl: async () => { throw abort; },
    }),
    (err) => err === abort
  );
});

test('rootSessionItems filters subagent/child rows and maps title fallback', () => {
  const items = [
    { sessionId: 'root1', cwd: '/a', updatedAt: 1, running: true, blank: false, projections: { values: { sessionTitle: { title: 'Root One' } } } },
    { sessionId: 'root2', cwd: '/b', updatedAt: 2, running: false, blank: true },
    { sessionId: 'child1', parentSessionId: 'root1', updatedAt: 3 },
    { sessionId: 'agent1', origin: 'subagent', updatedAt: 4 },
    { sessionId: 'root3', cwd: '/c', updatedAt: 5, projections: { values: { sessionTitle: { title: '' } } } },
  ];

  assert.deepStrictEqual(rootSessionItems(items), [
    { sessionId: 'root1', title: 'Root One', cwd: '/a', updatedAt: 1, running: true, blank: false },
    { sessionId: 'root2', title: 'root2', cwd: '/b', updatedAt: 2, running: false, blank: true },
    { sessionId: 'root3', title: 'root3', cwd: '/c', updatedAt: 5, running: undefined, blank: undefined },
  ]);
});

test('reuseBlankSession matches blank sessions by platform-normalized cwd', () => {
  const items = [
    { sessionId: 'blank-win', blank: true, cwd: 'C:\\Work\\App' },
    { sessionId: 'blank-posix', blank: true, cwd: '/home/me/project' },
    { sessionId: 'not-blank', blank: false, cwd: process.platform === 'win32' ? 'C:\\Work\\App' : '/home/me/project' },
  ];

  if (process.platform === 'win32') {
    assert.strictEqual(reuseBlankSession(items, 'c:\\work\\app\\'), 'blank-win');
    assert.strictEqual(reuseBlankSession(items, 'C:\\Work\\Other'), null);
  } else {
    assert.strictEqual(reuseBlankSession(items, '/home/me/project/'), 'blank-posix');
    assert.strictEqual(reuseBlankSession(items, '/HOME/ME/PROJECT'), null);
  }
  assert.strictEqual(reuseBlankSession(items, ''), null);
  assert.strictEqual(reuseBlankSession(items, null), null);
});

test('buildQuickPickItems maps rows and formats en/zh details', () => {
  const now = Date.now();
  const rows = [
    { sessionId: 's1', title: 'Alpha', cwd: '/a', updatedAt: now - 30_000, running: false, blank: false },
    { sessionId: 's2', title: 'Beta', cwd: '/b', updatedAt: now - 5 * 60_000, running: true, blank: false },
    { sessionId: 's3', title: 'Gamma', cwd: undefined, updatedAt: now - 2 * 3600_000, running: false, blank: true },
    { sessionId: 's4', title: 'Delta', cwd: '/d', updatedAt: now - 25 * 3600_000, running: false, blank: false },
    { sessionId: 's5', title: 'Both', cwd: '/e', updatedAt: now - 10_000, running: true, blank: true },
    { sessionId: 's6', title: 'Min', cwd: '/f', updatedAt: now - 5 * 60_000, running: false, blank: false },
    { sessionId: 's7', title: 'Hour', cwd: '/g', updatedAt: now - 2 * 3600_000, running: false, blank: false },
  ];

  const en = buildQuickPickItems(rows, { locale: 'en', now });
  assert.deepStrictEqual(en.map((item) => item.label), ['Alpha', 'Beta', 'Gamma', 'Delta', 'Both', 'Min', 'Hour']);
  assert.deepStrictEqual(en.map((item) => item.description), ['/a', '/b', 's3', '/d', '/e', '/f', '/g']);
  assert.strictEqual(en[0].detail, 'updated just now');
  assert.strictEqual(en[1].detail, 'running');
  assert.strictEqual(en[2].detail, 'new');
  assert.strictEqual(en[3].detail, 'updated ' + new Date(now - 25 * 3600_000).toISOString());
  assert.strictEqual(en[4].detail, 'running · new');
  assert.strictEqual(en[5].detail, 'updated 5 min ago');
  assert.strictEqual(en[6].detail, 'updated 2 h ago');
  assert.ok(!en[0].label.includes('/a'), 'label must not contain cwd');

  const zh = buildQuickPickItems(rows, { locale: 'zh', now });
  assert.strictEqual(zh[0].detail, '更新于 刚刚');
  assert.strictEqual(zh[1].detail, '运行中');
  assert.strictEqual(zh[2].detail, '新会话');
  assert.strictEqual(zh[3].detail, '更新于 ' + new Date(now - 25 * 3600_000).toISOString());
  assert.strictEqual(zh[4].detail, '运行中 · 新会话');
  assert.strictEqual(zh[5].detail, '更新于 5 分钟前');
  assert.strictEqual(zh[6].detail, '更新于 2 小时前');
});

test('sessionIdFromValue accepts non-empty strings ≤ 200 without NUL', () => {
  assert.strictEqual(sessionIdFromValue('abc-123'), 'abc-123');
  assert.strictEqual(sessionIdFromValue('a'.repeat(200)), 'a'.repeat(200));
  for (const bad of ['', null, undefined, 42, {}, 'a'.repeat(201), 'bad\0id']) {
    assert.throws(
      () => sessionIdFromValue(bad),
      (err) => err instanceof DshSessionError && err.code === 'DSH_SESSION_INVALID_SESSION_ID'
    );
  }
});

// ---------------------------------------------------------------------------
// renameSession (B2 readable titles)
// ---------------------------------------------------------------------------

test('renameSession posts the session.rename envelope and returns the normalized title', async () => {
  let capturedUrl;
  let capturedInit;
  const result = await renameSession(BASE_URL, {
    sessionId: 'session-1',
    title: 'Fix the login bug',
    fetchImpl: async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      const request = JSON.parse(init.body);
      return jsonResponse(200, {
        type: 'server-response',
        rpcId: request.rpcId,
        result: { ok: true, value: { title: 'Fix the login bug', seq: 3 } },
      });
    },
  });

  assert.strictEqual(capturedUrl, BASE_URL + '/api/session.rename');
  const request = JSON.parse(capturedInit.body);
  assert.strictEqual(request.method, 'session.rename');
  assert.deepStrictEqual(request.payload, { sessionId: 'session-1', title: 'Fix the login bug' });
  assert.deepStrictEqual(result, { title: 'Fix the login bug', seq: 3 });
});

test('renameSession rejects missing sessionId/title before any fetch', async () => {
  let fetched = false;
  const fetchImpl = async () => {
    fetched = true;
    return jsonResponse(200, { result: { ok: true, value: { title: 'x', seq: 0 } } });
  };
  await assert.rejects(renameSession(BASE_URL, { title: 'x', fetchImpl }), TypeError);
  await assert.rejects(renameSession(BASE_URL, { sessionId: 's', fetchImpl }), TypeError);
  assert.strictEqual(fetched, false);
});

test('renameSession wraps an invalid value shape as DSH_SESSION_API_INVALID_RESPONSE', async () => {
  await assert.rejects(
    renameSession(BASE_URL, {
      sessionId: 's',
      title: 't',
      fetchImpl: async () => jsonResponse(200, { result: { ok: true, value: { title: 'x' } } }),
    }),
    (err) => err instanceof DshSessionError && err.code === 'DSH_SESSION_API_INVALID_RESPONSE'
  );
});

test('renameSession surfaces business errors (title-invalid)', async () => {
  await assert.rejects(
    renameSession(BASE_URL, {
      sessionId: 's',
      title: 't',
      fetchImpl: async () => jsonResponse(200, { result: { ok: false, error: { code: 'title-invalid' } } }),
    }),
    (err) => err instanceof DshSessionError && err.code === 'DSH_SESSION_API_BUSINESS_ERROR' && err.businessCode === 'title-invalid'
  );
});

test('renameSession propagates AbortError unchanged', async () => {
  const abortError = new Error('aborted');
  abortError.name = 'AbortError';
  await assert.rejects(
    renameSession(BASE_URL, {
      sessionId: 's',
      title: 't',
      fetchImpl: async () => {
        throw abortError;
      },
    }),
    (err) => err === abortError
  );
});
