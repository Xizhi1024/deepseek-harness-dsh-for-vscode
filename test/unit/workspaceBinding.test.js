'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  BINDING_STATES,
  createWorkspaceBinding,
} = require('../../src/context/workspaceBinding');

const BASE_URL = 'http://127.0.0.1:3080';

function jsonResponse(status, body) {
  return {
    status,
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

function createApi({
  workspaces = [],
  createWorkspaceImpl,
  sessions = [],
  createSessionImpl,
} = {}) {
  const calls = {
    workspaceList: 0,
    workspaceCreate: 0,
    sessionList: 0,
    sessionCreate: 0,
  };
  const fetchImpl = async (_url, init) => {
    const request = JSON.parse(init.body);
    if (request.method === 'workspace.list') {
      calls.workspaceList += 1;
      return jsonResponse(200, { result: { ok: true, value: { items: workspaces } } });
    }
    if (request.method === 'workspace.create') {
      calls.workspaceCreate += 1;
      const workspace = createWorkspaceImpl
        ? createWorkspaceImpl(request.payload.path)
        : { workspaceId: 'w-new', path: request.payload.path, sessionIds: [] };
      return jsonResponse(200, {
        result: { ok: true, value: { workspace, created: true } },
      });
    }
    if (request.method === 'session.list') {
      calls.sessionList += 1;
      return jsonResponse(200, { result: { ok: true, value: { items: sessions } } });
    }
    if (request.method === 'session.create') {
      calls.sessionCreate += 1;
      assert.deepStrictEqual(
        request.payload,
        { workspaceId: request.payload.workspaceId },
        'session.create must use workspaceId, never a bare cwd'
      );
      const sessionId = createSessionImpl
        ? createSessionImpl(request.payload)
        : request.payload.workspaceId + '-session';
      return jsonResponse(200, { result: { ok: true, value: { sessionId } } });
    }
    throw new Error('Unexpected API method: ' + request.method);
  };
  return { fetchImpl, calls };
}

function makeBinding(api, options = {}) {
  return createWorkspaceBinding({
    vscode: {},
    baseUrlProvider: () => BASE_URL,
    debounceMs: 0,
    fetchImpl: api.fetchImpl,
    ...options,
  });
}

test('owned + workspace exists reuses blank root session from workspace.sessionIds', async () => {
  const api = createApi({
    workspaces: [
      { workspaceId: 'w1', path: 'D:\\work', sessionIds: ['s1'], title: 'Work' },
    ],
    sessions: [
      { sessionId: 's1', blank: true, cwd: 'D:\\work' },
    ],
  });
  const binding = makeBinding(api);
  const sessionId = await binding.resolve({ url: BASE_URL, owned: true }, 'D:\\work');

  assert.strictEqual(sessionId, 's1');
  assert.strictEqual(binding.state().state, BINDING_STATES.BOUND);
  assert.strictEqual(binding.state().workspaceId, 'w1');
  assert.deepStrictEqual(api.calls, {
    workspaceList: 1,
    workspaceCreate: 0,
    sessionList: 1,
    sessionCreate: 0,
  });
});

test('owned + workspace missing creates workspace and session with workspaceId', async () => {
  const api = createApi({ workspaces: [], sessions: [] });
  const binding = makeBinding(api);
  const sessionId = await binding.resolve({ url: BASE_URL, owned: true }, 'D:\\new');

  assert.strictEqual(sessionId, 'w-new-session');
  assert.strictEqual(binding.state().state, BINDING_STATES.BOUND);
  assert.strictEqual(binding.state().workspaceId, 'w-new');
  assert.deepStrictEqual(api.calls, {
    workspaceList: 1,
    workspaceCreate: 1,
    sessionList: 1,
    sessionCreate: 1,
  });
});

test('owned + no folder stays unbound and makes no API calls', async () => {
  const api = createApi({});
  const binding = makeBinding(api);
  const sessionId = await binding.resolve({ url: BASE_URL, owned: true }, null);

  assert.strictEqual(sessionId, null);
  assert.strictEqual(binding.state().state, BINDING_STATES.UNBOUND);
  assert.deepStrictEqual(api.calls, {
    workspaceList: 0,
    workspaceCreate: 0,
    sessionList: 0,
    sessionCreate: 0,
  });
});

test('reused + no folder stays unbound and makes no API calls', async () => {
  const api = createApi({});
  const binding = makeBinding(api);
  const sessionId = await binding.resolve({ url: BASE_URL, owned: false }, null);

  assert.strictEqual(sessionId, null);
  assert.strictEqual(binding.state().state, BINDING_STATES.UNBOUND);
  assert.deepStrictEqual(api.calls, {
    workspaceList: 0,
    workspaceCreate: 0,
    sessionList: 0,
    sessionCreate: 0,
  });
});

test('reused + workspace exists binds through registry without creating', async () => {
  const api = createApi({
    workspaces: [
      { workspaceId: 'w1', path: 'D:\\work', sessionIds: ['s1'] },
    ],
    sessions: [
      { sessionId: 's1', blank: true },
    ],
  });
  const binding = makeBinding(api);
  const sessionId = await binding.resolve({ url: BASE_URL, owned: false }, 'D:\\work');

  assert.strictEqual(sessionId, 's1');
  assert.strictEqual(binding.state().state, BINDING_STATES.BOUND);
  assert.strictEqual(binding.state().owned, false);
  assert.deepStrictEqual(api.calls, {
    workspaceList: 1,
    workspaceCreate: 0,
    sessionList: 1,
    sessionCreate: 0,
  });
});

test('reused + workspace missing asks consent and creates when approved', async () => {
  const api = createApi({ workspaces: [], sessions: [] });
  let consentCwd = null;
  const binding = makeBinding(api, {
    requestConsent: async (cwd) => {
      consentCwd = cwd;
      return true;
    },
  });
  const sessionId = await binding.resolve({ url: BASE_URL, owned: false }, 'D:\\consent');

  assert.strictEqual(consentCwd, 'D:\\consent');
  assert.strictEqual(sessionId, 'w-new-session');
  assert.strictEqual(binding.state().state, BINDING_STATES.BOUND);
  assert.deepStrictEqual(api.calls, {
    workspaceList: 1,
    workspaceCreate: 1,
    sessionList: 1,
    sessionCreate: 1,
  });
});

test('reused + workspace missing returns unbound when consent is declined', async () => {
  const api = createApi({ workspaces: [], sessions: [] });
  const binding = makeBinding(api, {
    requestConsent: async () => false,
  });
  const sessionId = await binding.resolve({ url: BASE_URL, owned: false }, 'D:\\declined');

  assert.strictEqual(sessionId, null);
  assert.strictEqual(binding.state().state, BINDING_STATES.UNBOUND);
  assert.deepStrictEqual(api.calls, {
    workspaceList: 1,
    workspaceCreate: 0,
    sessionList: 0,
    sessionCreate: 0,
  });
});

test('API failure moves state to ERROR and returns null without throwing', async () => {
  const fetchImpl = async () => {
    throw new Error('ECONNREFUSED');
  };
  const binding = createWorkspaceBinding({
    vscode: {},
    baseUrlProvider: () => BASE_URL,
    debounceMs: 0,
    fetchImpl,
  });
  const sessionId = await binding.resolve({ url: BASE_URL, owned: true }, 'D:\\fail');

  assert.strictEqual(sessionId, null);
  assert.strictEqual(binding.state().state, BINDING_STATES.ERROR);
  assert.ok(binding.state().error.includes('ECONNREFUSED'), binding.state().error);
});

test('debounce 250ms coalesces rapid resolve calls into one workspace.list', async () => {
  const api = createApi({
    workspaces: [
      { workspaceId: 'w1', path: 'D:\\work', sessionIds: ['s1'] },
    ],
    sessions: [
      { sessionId: 's1', blank: true },
    ],
  });
  const binding = createWorkspaceBinding({
    vscode: {},
    baseUrlProvider: () => BASE_URL,
    debounceMs: 250,
    fetchImpl: api.fetchImpl,
  });
  const server = { url: BASE_URL, owned: true };
  const [first, second] = await Promise.all([
    binding.resolve(server, 'D:\\work'),
    binding.resolve(server, 'D:\\work'),
  ]);

  assert.strictEqual(first, 's1');
  assert.strictEqual(second, 's1');
  assert.strictEqual(api.calls.workspaceList, 1);
  assert.strictEqual(api.calls.sessionList, 1);
});

test('cache reuses bound mapping and refresh forces a new workspace.list', async () => {
  const api = createApi({
    workspaces: [
      { workspaceId: 'w1', path: 'D:\\work', sessionIds: ['s1'] },
    ],
    sessions: [
      { sessionId: 's1', blank: true },
    ],
  });
  const binding = makeBinding(api);
  const server = { url: BASE_URL, owned: true };

  assert.strictEqual(await binding.resolve(server, 'D:\\work'), 's1');
  assert.strictEqual(api.calls.workspaceList, 1);

  assert.strictEqual(await binding.resolve(server, 'D:\\work'), 's1');
  assert.strictEqual(api.calls.workspaceList, 1, 'cached resolve must not re-list');

  assert.strictEqual(await binding.refresh(), 's1');
  assert.strictEqual(api.calls.workspaceList, 2, 'refresh must force a new workspace.list');
});
