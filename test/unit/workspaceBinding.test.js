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

/**
 * Fetch mock speaking the 0.1.5 typert envelope.
 *
 * 0.1.5 has no workspace.list, so "already registered" is modelled by
 * `workspaces` (pre-registered paths). `workspace.create` returns
 * `created:false` for a registered path (adopt) and `created:true` otherwise
 * (fresh registration). Session negotiation is unchanged.
 *
 * @param {object} options
 * @param {Array<object>} [options.workspaces] - Pre-registered workspaces
 *   (path must match the bound cwd exactly to count as an adopt).
 * @param {Function} [options.createWorkspaceImpl] - Optional
 *   `(path) => { workspace, created }` override.
 * @param {Function} [options.deleteWorkspaceImpl] - Optional
 *   `(workspaceId) => { deleted }` override.
 * @param {Array<object>} [options.sessions] - session.list items.
 * @param {Function} [options.createSessionImpl] - Optional
 *   `(request) => request.workspaceId + '-session'` override.
 */
function createApi({
  workspaces = [],
  createWorkspaceImpl,
  deleteWorkspaceImpl,
  sessions = [],
  createSessionImpl,
} = {}) {
  const registered = workspaces.slice();
  const calls = {
    workspaceCreate: 0,
    workspaceDelete: 0,
    sessionList: 0,
    sessionCreate: 0,
  };
  const fetchImpl = async (_url, init) => {
    const request = JSON.parse(init.body);
    if (request.method === 'workspace/create') {
      calls.workspaceCreate += 1;
      if (createWorkspaceImpl) {
        return jsonResponse(200, {
          result: { ok: true, value: createWorkspaceImpl(request.payload.args.request.path) },
        });
      }
      const match = registered.find((w) => w.path === request.payload.args.request.path);
      if (match) {
        return jsonResponse(200, {
          result: { ok: true, value: { workspace: match, created: false } },
        });
      }
      const workspace = { workspaceId: 'w-new', path: request.payload.args.request.path, sessionIds: [] };
      registered.push(workspace);
      return jsonResponse(200, {
        result: { ok: true, value: { workspace, created: true } },
      });
    }
    if (request.method === 'workspace/delete') {
      calls.workspaceDelete += 1;
      const workspaceId = request.payload.args.request.workspaceId;
      if (deleteWorkspaceImpl) {
        return jsonResponse(200, {
          result: { ok: true, value: deleteWorkspaceImpl(workspaceId) },
        });
      }
      return jsonResponse(200, { result: { ok: true, value: { deleted: true } } });
    }
    if (request.method === 'session/list') {
      calls.sessionList += 1;
      return jsonResponse(200, { result: { ok: true, value: { items: sessions } } });
    }
    if (request.method === 'session/create') {
      calls.sessionCreate += 1;
      const args = request.payload.args.request;
      assert.deepStrictEqual(
        args,
        { workspaceId: args.workspaceId },
        'session.create must use workspaceId, never a bare cwd'
      );
      const sessionId = createSessionImpl
        ? createSessionImpl(args)
        : args.workspaceId + '-session';
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

test('owned + already registered (created:false) reuses blank root session from workspace.sessionIds', async () => {
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
    workspaceCreate: 1,
    workspaceDelete: 0,
    sessionList: 1,
    sessionCreate: 0,
  });
});

test('owned + workspace missing creates-or-adopts and creates session with workspaceId, no consent', async () => {
  const api = createApi({ workspaces: [], sessions: [] });
  const binding = makeBinding(api);
  const sessionId = await binding.resolve({ url: BASE_URL, owned: true }, 'D:\\new');

  assert.strictEqual(sessionId, 'w-new-session');
  assert.strictEqual(binding.state().state, BINDING_STATES.BOUND);
  assert.strictEqual(binding.state().workspaceId, 'w-new');
  assert.deepStrictEqual(api.calls, {
    workspaceCreate: 1,
    workspaceDelete: 0,
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
    workspaceCreate: 0,
    workspaceDelete: 0,
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
    workspaceCreate: 0,
    workspaceDelete: 0,
    sessionList: 0,
    sessionCreate: 0,
  });
});

test('reused + already registered (created:false) binds silently, no consent prompt', async () => {
  const api = createApi({
    workspaces: [
      { workspaceId: 'w1', path: 'D:\\work', sessionIds: ['s1'] },
    ],
    sessions: [
      { sessionId: 's1', blank: true },
    ],
  });
  let consentCalls = 0;
  const binding = makeBinding(api, {
    requestConsent: async () => { consentCalls += 1; return true; },
  });
  const sessionId = await binding.resolve({ url: BASE_URL, owned: false }, 'D:\\work');

  assert.strictEqual(consentCalls, 0, 'adopting an existing workspace must not prompt');
  assert.strictEqual(sessionId, 's1');
  assert.strictEqual(binding.state().state, BINDING_STATES.BOUND);
  assert.strictEqual(binding.state().owned, false);
  assert.strictEqual(binding.state().workspaceId, 'w1');
  assert.deepStrictEqual(api.calls, {
    workspaceCreate: 1,
    workspaceDelete: 0,
    sessionList: 1,
    sessionCreate: 0,
  });
});

test('reused + workspace missing creates (created:true), asks consent and proceeds when approved', async () => {
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
  assert.strictEqual(binding.state().workspaceId, 'w-new');
  assert.deepStrictEqual(api.calls, {
    workspaceCreate: 1,
    workspaceDelete: 0,
    sessionList: 1,
    sessionCreate: 1,
  });
});

test('reused + workspace missing when consent is declined rolls the creation back and stays unbound', async () => {
  const api = createApi({ workspaces: [], sessions: [] });
  const binding = makeBinding(api, {
    requestConsent: async () => false,
  });
  const sessionId = await binding.resolve({ url: BASE_URL, owned: false }, 'D:\\declined');

  assert.strictEqual(sessionId, null);
  assert.strictEqual(binding.state().state, BINDING_STATES.UNBOUND);
  assert.strictEqual(binding.state().workspaceId, null);
  assert.deepStrictEqual(api.calls, {
    workspaceCreate: 1,
    workspaceDelete: 1,
    sessionList: 0,
    sessionCreate: 0,
  });
});

test('adopted shared instance (managed) binds without consent, like an owned child', async () => {
  // Shared-instance mode: a sibling VS Code window of the same environment
  // spawned the DSH and this window adopted it (owned:false, managed:true).
  // Prompting here made shared instances effectively unbindable — a decline
  // rolled the registration back on every folder switch (live bug 2026-09-18).
  const api = createApi({ workspaces: [], sessions: [] });
  let consentCalls = 0;
  const binding = makeBinding(api, {
    requestConsent: async () => { consentCalls += 1; return true; },
  });
  const sessionId = await binding.resolve(
    { url: BASE_URL, owned: false, managed: true, pid: 4242 },
    'D:\\shared'
  );

  assert.strictEqual(consentCalls, 0, 'the extension’s own shared instance needs no consent');
  assert.strictEqual(sessionId, 'w-new-session');
  assert.strictEqual(binding.state().state, BINDING_STATES.BOUND);
  // `owned` keeps meaning "this window owns the child process".
  assert.strictEqual(binding.state().owned, false);
  assert.deepStrictEqual(api.calls, {
    workspaceCreate: 1,
    workspaceDelete: 0,
    sessionList: 1,
    sessionCreate: 1,
  });
});

test('a genuinely user-managed server still asks for consent', async () => {
  const api = createApi({ workspaces: [], sessions: [] });
  let consentCalls = 0;
  const binding = makeBinding(api, {
    requestConsent: async () => { consentCalls += 1; return false; },
  });
  // Adopted from a `dsh web` the user started: no registry entry, so no
  // managed marker and no pid.
  const sessionId = await binding.resolve({ url: BASE_URL, owned: false }, 'D:\\user-managed');

  assert.strictEqual(consentCalls, 1);
  assert.strictEqual(sessionId, null);
});

test('an adopted instance is identified by pid, so a replacement on the same port rebinds', async () => {
  const api = createApi({
    workspaces: [],
    sessions: [],
  });
  const binding = makeBinding(api);
  const s1 = await binding.resolve({ url: BASE_URL, owned: false, managed: true, pid: 111 }, 'D:\\work');
  assert.ok(s1);
  // The shared instance died and its replacement listens on the configured
  // port again: a url-only identity would serve the dead instance's session.
  const s2 = await binding.resolve({ url: BASE_URL, owned: false, managed: true, pid: 222 }, 'D:\\work');
  assert.ok(s2);
  assert.strictEqual(api.calls.workspaceCreate, 2, 'the cache must not answer for a new process');
});

test('reused + declined rollback failure still leaves the binding unbound', async () => {
  const api = createApi({
    workspaces: [],
    deleteWorkspaceImpl: () => {
      throw new Error('rollback failed');
    },
  });
  const binding = makeBinding(api, {
    requestConsent: async () => false,
  });
  const sessionId = await binding.resolve({ url: BASE_URL, owned: false }, 'D:\\declined');

  assert.strictEqual(sessionId, null);
  assert.strictEqual(binding.state().state, BINDING_STATES.UNBOUND);
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

test('a business failure keeps the DSH code and the server sentence for the status page', async () => {
  // What a DSH hosted by the OTHER OS answers when a WSL workspace is created:
  // the status page shows err.message and keys its hint off errorCode, so both
  // halves have to survive the binding layer.
  const fetchImpl = async () => jsonResponse(200, {
    result: {
      ok: false,
      error: {
        code: 'workspace/invalid-path',
        message: "Workspace path is not fully qualified: '/home/andy/workspace'",
      },
    },
  });
  const binding = createWorkspaceBinding({
    vscode: {},
    baseUrlProvider: () => BASE_URL,
    debounceMs: 0,
    fetchImpl,
  });
  const sessionId = await binding.resolve({ url: BASE_URL, owned: true }, '/home/andy/workspace');

  assert.strictEqual(sessionId, null);
  assert.strictEqual(binding.state().state, BINDING_STATES.ERROR);
  assert.strictEqual(binding.state().errorCode, 'workspace/invalid-path');
  assert.ok(
    binding.state().error.includes("Workspace path is not fully qualified: '/home/andy/workspace'"),
    binding.state().error
  );
});

test('debounce 250ms coalesces rapid resolve calls into one workspace.create', async () => {
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
  assert.strictEqual(api.calls.workspaceCreate, 1);
  assert.strictEqual(api.calls.sessionList, 1);
});

test('cache reuses bound mapping and refresh forces a new workspace.create', async () => {
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
  assert.strictEqual(api.calls.workspaceCreate, 1);

  assert.strictEqual(await binding.resolve(server, 'D:\\work'), 's1');
  assert.strictEqual(api.calls.workspaceCreate, 1, 'cached resolve must not re-probe');

  assert.strictEqual(await binding.refresh(), 's1');
  assert.strictEqual(api.calls.workspaceCreate, 2, 'refresh must force a new workspace.create');
});

// ---------------------------------------------------------------------------
// Run serialization (binding races: view-resolution connect / rebind /
// @dsh participant overlapping one in-flight pass)
// ---------------------------------------------------------------------------

/**
 * API mock like createApi, but with per-server durable state (each loopback
 * port is one independent DSH instance) and an optional gate: while armed,
 * the next `session/list` answers only when the test releases it —
 * stretching the in-flight window so a second resolve() would
 * (pre-serialization) start a concurrent pass inside it. With no gate armed
 * it answers immediately.
 */
function createGatedApi() {
  const calls = { workspaceCreate: 0, sessionList: 0, sessionCreate: 0 };
  const servers = new Map(); // port → { registered: Map<path, workspace> }
  let createdSessions = 0; // globally unique ids: two servers never collide
  let gateArmed = false;
  const gates = [];
  const serverFor = (url) => {
    const port = new URL(url).port;
    let state = servers.get(port);
    if (!state) {
      state = { registered: new Map() };
      servers.set(port, state);
    }
    return state;
  };
  const fetchImpl = async (url, init) => {
    const request = JSON.parse(init.body);
    const state = serverFor(url);
    if (request.method === 'workspace/create') {
      calls.workspaceCreate += 1;
      const workspacePath = request.payload.args.request.path;
      let workspace = state.registered.get(workspacePath);
      const created = !workspace;
      if (created) {
        workspace = { workspaceId: 'w-' + calls.workspaceCreate, path: workspacePath, sessionIds: [] };
        state.registered.set(workspacePath, workspace);
      }
      return jsonResponse(200, {
        result: { ok: true, value: { workspace, created } },
      });
    }
    if (request.method === 'session/list') {
      calls.sessionList += 1;
      if (gateArmed) {
        // Sticky: every list gates until release() disarms, so both
        // concurrent passes (pre-serialization) stall deterministically.
        await new Promise((resolve) => gates.push(resolve));
      }
      const items = [];
      for (const workspace of state.registered.values()) {
        for (const sessionId of workspace.sessionIds) items.push({ sessionId, cwd: workspace.path });
      }
      return jsonResponse(200, { result: { ok: true, value: { items } } });
    }
    if (request.method === 'session/create') {
      calls.sessionCreate += 1;
      const workspaceId = request.payload.args.request.workspaceId;
      const sessionId = 's-' + (++createdSessions);
      for (const workspace of state.registered.values()) {
        if (workspace.workspaceId === workspaceId) workspace.sessionIds.push(sessionId);
      }
      return jsonResponse(200, { result: { ok: true, value: { sessionId } } });
    }
    throw new Error('Unexpected API method: ' + request.method);
  };
  return {
    fetchImpl,
    calls,
    /** Arm the gate: every session/list stalls until release() disarms it. */
    armGate: () => { gateArmed = true; },
    /** Release every currently-gated session/list and disarm the gate. */
    release: () => {
      gateArmed = false;
      while (gates.length > 0) gates.shift()();
    },
  };
}

test('a resolve arriving during an in-flight pass is serialized, never double-creating sessions', async () => {
  const api = createGatedApi(); // fresh workspace: no session exists yet
  const binding = createWorkspaceBinding({
    vscode: {},
    debounceMs: 1,
    fetchImpl: api.fetchImpl,
  });
  const server = { url: BASE_URL, owned: true };

  api.armGate();
  const first = binding.resolve(server, 'D:\\fresh');
  // Let pass #1 enter the gated session/list, then resolve again mid-flight
  // and wait out its own debounce so (pre-serialization) pass #2 also enters
  // the gate concurrently.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(api.calls.sessionList >= 1, 'pass #1 must be inside session/list');
  const second = binding.resolve(server, 'D:\\fresh');
  await new Promise((resolve) => setTimeout(resolve, 10));
  api.release();
  const [s1, s2] = await Promise.all([first, second]);

  assert.strictEqual(s1, s2, 'both resolves must land on the same session');
  assert.strictEqual(api.calls.sessionCreate, 1, 'the fresh workspace must get exactly one session');
});

test('refresh during an in-flight pass is serialized and reuses the created session', async () => {
  const api = createGatedApi();
  const binding = createWorkspaceBinding({
    vscode: {},
    debounceMs: 1,
    fetchImpl: api.fetchImpl,
  });
  const server = { url: BASE_URL, owned: true };

  api.armGate();
  const first = binding.resolve(server, 'D:\\fresh');
  await new Promise((resolve) => setTimeout(resolve, 10));
  const refreshed = binding.refresh();
  api.release(); // pass #1's list finishes → session created
  const s1 = await first;
  api.release(); // pass #2 (force) lists again, now finds the root session
  assert.strictEqual(await refreshed, s1);
  assert.strictEqual(api.calls.sessionCreate, 1, 'serialization must not duplicate the root session');
});

// ---------------------------------------------------------------------------
// Server-scoped cache (bindings must never leak across server instances)
// ---------------------------------------------------------------------------

test('the cache never answers for a different server handle', async () => {
  const api = createGatedApi();
  const binding = createWorkspaceBinding({
    vscode: {},
    debounceMs: 0,
    fetchImpl: api.fetchImpl,
  });

  const s1 = await binding.resolve({ url: 'http://127.0.0.1:4001', owned: true }, 'D:\\work');
  const cached = await binding.resolve({ url: 'http://127.0.0.1:4001', owned: true }, 'D:\\work');
  assert.strictEqual(cached, s1, 'same server resolves from cache');
  assert.strictEqual(api.calls.workspaceCreate, 1);

  // Server 4002 keeps its own (empty) registry: binding there must re-probe
  // and create a session on THAT server instead of serving the stale cache.
  const s2 = await binding.resolve({ url: 'http://127.0.0.1:4002', owned: true }, 'D:\\work');
  assert.strictEqual(api.calls.workspaceCreate, 2, 'the other server is re-probed');
  assert.notStrictEqual(s2, s1, 'the other server gets its own session');

  // Switching back revalidates against 4001's registry and lands on its
  // session again — never on 4002's.
  const s3 = await binding.resolve({ url: 'http://127.0.0.1:4001', owned: true }, 'D:\\work');
  assert.strictEqual(api.calls.workspaceCreate, 3, 'switching back re-probes that server');
  assert.strictEqual(s3, s1, 'the binding returns to the session of the server it talks to');
});

test('an owned child restarting on the same port (new pid) invalidates the cache', async () => {
  const api = createGatedApi();
  const binding = createWorkspaceBinding({
    vscode: {},
    debounceMs: 0,
    fetchImpl: api.fetchImpl,
  });

  const s1 = await binding.resolve({ url: BASE_URL, owned: true, pid: 111 }, 'D:\\work');
  assert.strictEqual(api.calls.workspaceCreate, 1);
  const s2 = await binding.resolve({ url: BASE_URL, owned: true, pid: 222 }, 'D:\\work');
  assert.strictEqual(api.calls.workspaceCreate, 2, 'a new child process must re-validate, not cache-serve');
  assert.strictEqual(s2, s1, 'the durable registry still resolves to the same root session');
});