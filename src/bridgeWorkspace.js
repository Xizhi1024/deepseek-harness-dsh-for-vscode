'use strict';

const crypto = require('node:crypto');

function workspaceKind(remoteName, folders) {
  if (remoteName === 'wsl') return 'wsl';
  if (remoteName === 'ssh-remote') return 'remote-ssh';
  if (folders.some((folder) => folder.uri && folder.uri.scheme && folder.uri.scheme !== 'file')) {
    return 'virtual';
  }
  return 'local';
}

function createBridgeWorkspaceIdentity(vscode, context) {
  const folders = (vscode.workspace.workspaceFolders || []).map((folder) => ({
    name: folder.name,
    uri: folder.uri.toString(),
  }));
  const seed = `${context.globalStorageUri.fsPath}\0${process.pid}`;
  return Object.freeze({
    windowId: crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32),
    trusted: vscode.workspace.isTrusted === true,
    kind: workspaceKind(vscode.env.remoteName, vscode.workspace.workspaceFolders || []),
    folders,
  });
}

module.exports = { createBridgeWorkspaceIdentity, workspaceKind };
