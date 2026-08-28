'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { createWorkspaceContext } = require('../src/workspaceContext');

function createHost({ folders = [], activeUri = null, activeFolder = null, values = {} } = {}) {
  return {
    Uri: {
      joinPath(base, child) { return { fsPath: path.join(base.fsPath, child) }; },
    },
    window: {
      activeTextEditor: activeUri ? { document: { uri: activeUri } } : null,
    },
    workspace: {
      workspaceFolders: folders,
      getConfiguration() {
        return { get: (key, fallback) => values[key] ?? fallback };
      },
      getWorkspaceFolder(uri) {
        return uri === activeUri ? activeFolder : undefined;
      },
    },
  };
}

test('workspace context reads normalized settings and stable storage path', () => {
  const vscode = createHost({
    values: { port: 4100, autoStart: false, closePolicy: 'never' },
  });
  const context = createWorkspaceContext(vscode, { globalStorageUri: { fsPath: 'D:\\state' } });
  assert.deepStrictEqual(context.config(), {
    host: '127.0.0.1',
    port: 4100,
    autoStart: false,
    profile: 'web',
    closePolicy: 'never',
    runtimeManifestUrl: '',
    executablePath: '',
    launchMethod: 'auto',
    launchCommand: 'dsh',
    extraArgs: [],
    runtimeVersion: '',
    localPackageRoot: '',
    localNodePath: '',
    homeMode: 'shared',
    homePath: '',
  });
  assert.strictEqual(context.registryFilePath(), path.join('D:\\state', 'dsh-instances.json'));
});

test('workspace context reads a custom window-scoped profile', () => {
  const vscode = createHost({ values: { profile: 'dev' } });
  const context = createWorkspaceContext(vscode, { globalStorageUri: { fsPath: 'D:\\state' } });
  assert.strictEqual(context.config().profile, 'dev');
});

test('workspace context prefers the active editor root and falls back safely', () => {
  const first = { uri: { fsPath: 'D:\\first' } };
  const second = { uri: { fsPath: 'D:\\second' } };
  const activeUri = { scheme: 'file', path: '/second/file.js' };
  const active = createWorkspaceContext(createHost({
    folders: [first, second], activeUri, activeFolder: second,
  }), { globalStorageUri: { fsPath: 'D:\\state' } });
  assert.strictEqual(active.workspaceCwd(), 'D:\\second');

  const fallback = createWorkspaceContext(createHost({ folders: [first, second] }), {
    globalStorageUri: { fsPath: 'D:\\state' },
  });
  assert.strictEqual(fallback.workspaceCwd(), 'D:\\first');

  const empty = createWorkspaceContext(createHost(), {
    globalStorageUri: { fsPath: 'D:\\state' },
  });
  assert.strictEqual(empty.workspaceCwd(), null);
  assert.strictEqual(empty.sameRoot(null, null), true);
  assert.strictEqual(empty.sameRoot(null, 'D:\\first'), false);
});
