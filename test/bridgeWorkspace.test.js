'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createBridgeWorkspaceIdentity, workspaceKind } = require('../src/bridgeWorkspace');

test('bridge workspace preserves URIs and classifies local and remote hosts', () => {
  assert.strictEqual(workspaceKind('wsl', []), 'wsl');
  assert.strictEqual(workspaceKind('ssh-remote', []), 'remote-ssh');
  assert.strictEqual(workspaceKind(undefined, [{ uri: { scheme: 'memfs' } }]), 'virtual');
  assert.strictEqual(workspaceKind(undefined, [{ uri: { scheme: 'file' } }]), 'local');

  const vscode = {
    env: { remoteName: 'ssh-remote' },
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ name: 'remote', uri: { scheme: 'vscode-remote', toString: () => 'vscode-remote://ssh-remote+host/work' } }],
    },
  };
  const identity = createBridgeWorkspaceIdentity(vscode, {
    globalStorageUri: { fsPath: 'D:\\storage' },
  });
  assert.strictEqual(identity.kind, 'remote-ssh');
  assert.strictEqual(identity.trusted, true);
  assert.deepStrictEqual(identity.folders, [{
    name: 'remote',
    uri: 'vscode-remote://ssh-remote+host/work',
  }]);
  assert.match(identity.windowId, /^[a-f0-9]{32}$/);
});
