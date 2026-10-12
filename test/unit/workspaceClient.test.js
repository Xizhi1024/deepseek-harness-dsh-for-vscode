'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createWorkspace,
  deleteWorkspace,
  findWorkspaceByPath,
} = require('../../src/ch2/workspaceClient');
const { DshSessionError } = require('../../src/sessionNavigation');

const BASE_URL = 'http://127.0.0.1:3080';

function jsonResponse(status, body) {
  return {
    status,
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

test('createWorkspace posts workspace/create with path and returns workspace/created', async () => {
  let capturedUrl;
  let capturedBody;
  const workspace = { workspaceId: 'w-new', path: 'D:\\project', title: 'Project', sessionIds: [] };
  const result = await createWorkspace(BASE_URL, 'D:\\project', {
    fetchImpl: async (url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body);
      return jsonResponse(200, {
        result: { ok: true, value: { workspace, created: true } },
      });
    },
  });

  assert.strictEqual(capturedUrl, BASE_URL + '/api/workspace/create');
  assert.strictEqual(capturedBody.method, 'workspace/create');
  assert.deepStrictEqual(capturedBody.payload, { args: { request: { path: 'D:\\project' } } });
  assert.deepStrictEqual(result, { workspace, created: true });
});

test('createWorkspace validates workspace and created fields', async () => {
  await assert.rejects(
    createWorkspace(BASE_URL, 'D:\\project', {
      fetchImpl: async () => jsonResponse(200, {
        result: { ok: true, value: { workspace: { workspaceId: 'w' }, created: true } },
      }),
    }),
    (err) => err instanceof DshSessionError && err.code === 'DSH_SESSION_API_INVALID_RESPONSE'
  );
  await assert.rejects(
    createWorkspace(BASE_URL, 'D:\\project', {
      fetchImpl: async () => jsonResponse(200, {
        result: { ok: true, value: { workspace: { workspaceId: 'w', path: 'D:\\p', sessionIds: [] }, created: 'yes' } },
      }),
    }),
    (err) => err instanceof DshSessionError && err.code === 'DSH_SESSION_API_INVALID_RESPONSE'
  );
});

test('deleteWorkspace posts workspace/delete and returns {deleted:true}', async () => {
  let capturedUrl;
  let capturedBody;
  const result = await deleteWorkspace(BASE_URL, { workspaceId: 'w-1' }, {
    fetchImpl: async (url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body);
      return jsonResponse(200, {
        result: { ok: true, value: { deleted: true } },
      });
    },
  });

  assert.strictEqual(capturedUrl, BASE_URL + '/api/workspace/delete');
  assert.strictEqual(capturedBody.method, 'workspace/delete');
  assert.deepStrictEqual(capturedBody.payload, { args: { request: { workspaceId: 'w-1' } } });
  assert.deepStrictEqual(result, { deleted: true });
});

test('deleteWorkspace requires a non-empty workspaceId', async () => {
  const fetchImpl = async () => { throw new Error('must not be called'); };
  for (const bad of [undefined, null, '', 42, {}, { workspaceId: '' }]) {
    await assert.rejects(
      deleteWorkspace(BASE_URL, bad, { fetchImpl }),
      (err) => err instanceof TypeError
    );
  }
});

test('deleteWorkspace validates result.value.deleted === true', async () => {
  for (const value of [{}, { deleted: false }, { deleted: 'yes' }, null]) {
    await assert.rejects(
      deleteWorkspace(BASE_URL, { workspaceId: 'w-1' }, {
        fetchImpl: async () => jsonResponse(200, { result: { ok: true, value } }),
      }),
      (err) => err instanceof DshSessionError && err.code === 'DSH_SESSION_API_INVALID_RESPONSE'
    );
  }
});

test('deleteWorkspace wraps business failures with the same error mapping', async () => {
  await assert.rejects(
    deleteWorkspace(BASE_URL, { workspaceId: 'w-1' }, {
      fetchImpl: async () => jsonResponse(200, {
        result: { ok: false, error: { code: 'NOT_FOUND', message: 'no such workspace' } },
      }),
    }),
    (err) => err instanceof DshSessionError
      && err.code === 'DSH_SESSION_API_BUSINESS_ERROR'
      && err.businessCode === 'NOT_FOUND'
      && err.message === 'DSH session API business error: NOT_FOUND: no such workspace'
  );
});

test('deleteWorkspace surfaces the server message of a rejected workspace path', async () => {
  // What a DSH hosted by the OTHER OS answers a workspace operation with; the
  // binding page shows err.message, so the sentence has to survive the wrap.
  await assert.rejects(
    deleteWorkspace(BASE_URL, { workspaceId: 'w-1' }, {
      fetchImpl: async () => jsonResponse(200, {
        result: {
          ok: false,
          error: {
            code: 'workspace/invalid-path',
            message: "Workspace path is not fully qualified: '/home/andy/workspace'",
          },
        },
      }),
    }),
    (err) => err.businessCode === 'workspace/invalid-path'
      && err.message.includes("Workspace path is not fully qualified: '/home/andy/workspace'")
  );
});

test('findWorkspaceByPath normalizes Windows case and trailing separators', () => {
  const items = [
    { workspaceId: 'w1', path: 'C:\\Work\\App', sessionIds: [] },
    { workspaceId: 'w2', path: '/home/me/project', sessionIds: [] },
  ];

  if (process.platform === 'win32') {
    assert.strictEqual(findWorkspaceByPath(items, 'c:\\work\\app\\', 'win32').workspaceId, 'w1');
    assert.strictEqual(findWorkspaceByPath(items, 'C:\\Work\\Other', 'win32'), null);
  } else {
    assert.strictEqual(findWorkspaceByPath(items, '/home/me/project/', 'linux').workspaceId, 'w2');
    assert.strictEqual(findWorkspaceByPath(items, '/HOME/ME/PROJECT', 'linux'), null);
  }
  assert.strictEqual(findWorkspaceByPath(items, '', process.platform), null);
  assert.strictEqual(findWorkspaceByPath([], '/a', process.platform), null);
});

test('findWorkspaceByPath uses path.resolve equality on POSIX and ignores case', () => {
  assert.strictEqual(
    findWorkspaceByPath(
      [{ workspaceId: 'w', path: '/home/me/project', sessionIds: [] }],
      '/home/me/project/',
      'linux'
    ).workspaceId,
    'w'
  );
  assert.strictEqual(
    findWorkspaceByPath(
      [{ workspaceId: 'w', path: '/home/me/project', sessionIds: [] }],
      '/HOME/ME/PROJECT',
      'linux'
    ),
    null
  );
});