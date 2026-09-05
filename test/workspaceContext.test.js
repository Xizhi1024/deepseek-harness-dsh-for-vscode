'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { createWorkspaceContext, resolveDefaultPort, ISOLATED_DEFAULT_PORT } = require('../src/workspaceContext');

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
        return {
          get: (key, fallback) => values[key] ?? fallback,
          // Real VS Code: dsh.port is registered with default 3080, so get()
          // would return it even without an explicit value. Mirror that by
          // reporting the registered default in inspect() unless explicit
          // layers exist (tests pass them via `layers`).
          inspect: (key) => ({
            key: `dsh.${key}`,
            defaultValue: key === 'port' ? 3080 : undefined,
            globalValue: values[key],
            workspaceValue: undefined,
            workspaceFolderValue: undefined,
          }),
        };
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
    profile: 'vscode',
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

test('resolveDefaultPort maps DSH_VSCODE_PORT onto the setting fallback', () => {
  assert.strictEqual(resolveDefaultPort({}), 3080);
  assert.strictEqual(resolveDefaultPort({ DSH_VSCODE_PORT: '' }), 3080);
  assert.strictEqual(resolveDefaultPort({ DSH_VSCODE_PORT: '3200' }), 3200);
  assert.strictEqual(resolveDefaultPort({ DSH_VSCODE_PORT: ' 3200 ' }), 3200);
  // An isolated-storage host without a port pin still moves off the shared
  // default (covers dev hosts relaunched with a pre-DSH_VSCODE_PORT env).
  assert.strictEqual(
    resolveDefaultPort({ DSH_VSCODE_STORAGE_ROOT: 'D:\\isolated' }),
    ISOLATED_DEFAULT_PORT,
  );
  assert.strictEqual(resolveDefaultPort({ DSH_VSCODE_STORAGE_ROOT: '  ' }), 3080);
  for (const bad of ['0', '65536', '99999', '3080.5', 'abc', '-1']) {
    assert.throws(() => resolveDefaultPort({ DSH_VSCODE_PORT: bad }), { message: /DSH_VSCODE_PORT/ }, bad);
  }
});

test('workspace context uses the pinned default port only without an explicit setting', () => {
  const vscode = createHost({ values: {} });
  const context = createWorkspaceContext(vscode, { globalStorageUri: { fsPath: 'D:\\state' } }, undefined, 3200);
  assert.strictEqual(context.config().port, 3200);

  const explicit = createHost({ values: { port: 4100 } });
  const explicitContext = createWorkspaceContext(explicit, { globalStorageUri: { fsPath: 'D:\\state' } }, undefined, 3200);
  assert.strictEqual(explicitContext.config().port, 4100);
});

test('registered dsh.port default never masks the host default port', () => {
  // package.json registers dsh.port default 3080; real settings.get('port',
  // fallback) returns 3080 and the fallback is dead code. The context must
  // fall through to the host-derived default when nothing is explicit.
  const vscode = createHost({ values: {} });
  const context = createWorkspaceContext(vscode, { globalStorageUri: { fsPath: 'D:\\state' } }, undefined, 3200);
  assert.strictEqual(context.config().port, 3200);

  const plain = createWorkspaceContext(vscode, { globalStorageUri: { fsPath: 'D:\\state' } });
  assert.strictEqual(plain.config().port, 3080);
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
