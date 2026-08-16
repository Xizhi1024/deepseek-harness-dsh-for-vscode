'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const {
  listWorkspaces,
  createWorkspace,
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

test('listWorkspaces posts workspace.list and returns validated workspace items', async () => {
  let capturedUrl;
  let capturedInit;
  const items = [
    { workspaceId: 'w1', path: 'D:\\work', title: 'Work', sessionIds: ['s1'], createdAt: 1, updatedAt: 2 },
    { workspaceId: 'w2', path: '/home/me', title: 'Home', sessionIds: [], createdAt: 3, updatedAt: 4 },
  ];

  const result = await listWorkspaces(BASE_URL, {
    fetchImpl: async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      const request = JSON.parse(init.body);
      return jsonResponse(200, {
        result: { ok: true, value: { items } },
      });
    },
  });

  assert.strictEqual(capturedUrl, BASE_URL + '/api/workspace.list');
  assert.strictEqual(capturedInit.method, 'POST');
  assert.strictEqual(capturedInit.headers['content-type'], 'application/json');
  const request = JSON.parse(capturedInit.body);
  assert.strictEqual(request.method, 'workspace.list');
  assert.deepStrictEqual(request.payload, {});
  assert.strictEqual(result.length, 2);
  assert.deepStrictEqual(result[0], items[0]);
  assert.notStrictEqual(result, items);
});

test('listWorkspaces validates workspaceId/path/sessionIds item types', async () => {
  const badItems = [
    { workspaceId: '', path: 'D:\\work', sessionIds: [] },
    { workspaceId: 'w1', path: 42, sessionIds: [] },
    { workspaceId: 'w1', path: 'D:\\work', sessionIds: 's1' },
    { workspaceId: 'w1', path: 'D:\\work', sessionIds: [42] },
    null,
  ];
  for (const bad of badItems) {
    await assert.rejects(
      listWorkspaces(BASE_URL, {
        fetchImpl: async () => jsonResponse(200, {
          result: { ok: true, value: { items: [bad] } },
        }),
      }),
      (err) => err instanceof DshSessionError && err.code === 'DSH_SESSION_API_INVALID_RESPONSE'
    );
  }
});

test('listWorkspaces validates result.value.items array', async () => {
  await assert.rejects(
    listWorkspaces(BASE_URL, {
      fetchImpl: async () => jsonResponse(200, {
        result: { ok: true, value: { items: 'nope' } },
      }),
    }),
    (err) => err instanceof DshSessionError && err.code === 'DSH_SESSION_API_INVALID_RESPONSE'
  );
});

test('createWorkspace posts workspace.create with path and returns workspace/created', async () => {
  let capturedBody;
  const workspace = { workspaceId: 'w-new', path: 'D:\\project', title: 'Project', sessionIds: [] };
  const result = await createWorkspace(BASE_URL, 'D:\\project', {
    fetchImpl: async (url, init) => {
      capturedBody = JSON.parse(init.body);
      return jsonResponse(200, {
        result: { ok: true, value: { workspace, created: true } },
      });
    },
  });

  assert.strictEqual(capturedBody.method, 'workspace.create');
  assert.deepStrictEqual(capturedBody.payload, { path: 'D:\\project' });
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
