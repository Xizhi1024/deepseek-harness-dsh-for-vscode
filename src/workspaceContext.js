'use strict';

const { DEFAULT_HOST, DEFAULT_PORT } = require('./types');
const { normalizeClosePolicy, ServerManager } = require('./serverManager');
const { SHARE_MODES, normalizeShareMode } = require('./runtimeEnvironment');
const { hasExplicitSetting } = require('./dshHome');

/**
 * Bind workspace and configuration reads to one VS Code extension context.
 *
 * @param {object} vscode - VS Code facade.
 * @param {object} extensionContext - Active ExtensionContext.
 * @returns {object} Read-only workspace helpers.
 */
function createWorkspaceContext(vscode, extensionContext) {
  return Object.freeze({
    config() {
      const settings = vscode.workspace.getConfiguration('dsh');
      return {
        host: settings.get('host', DEFAULT_HOST),
        port: settings.get('port', DEFAULT_PORT),
        // True when dsh.port is explicitly set at any configuration scope.
        // The environment-shared mode shifts the default port for WSL
        // extension hosts only when the user has NOT pinned the port; an
        // explicit port is always honored verbatim.
        portExplicitlySet: hasExplicitSetting(settings, 'port'),
        // Extension default is environment-shared (all windows of one OS
        // environment — Windows vs WSL — converge on one DSH instance);
        // unknown values fall back to that default too. The ServerManager
        // API-level default stays 'window' for standalone consumers.
        shareMode: normalizeShareMode(settings.get('share.mode'), SHARE_MODES.ENVIRONMENT),
        autoStart: settings.get('autoStart', true),
        profile: String(settings.get('profile', 'web') || 'web'),
        closePolicy: normalizeClosePolicy(settings.get('closePolicy')),
        runtimeManifestUrl: String(settings.get('runtime.manifestUrl', '') || ''),
        runtimeVersion: String(settings.get('runtime.version', '') || ''),
        localPackageRoot: String(settings.get('local.packageRoot', '') || ''),
        localNodePath: String(settings.get('local.nodePath', '') || ''),
        executablePath: String(settings.get('executablePath', '') || ''),
        launchMethod: String(settings.get('launch.method', 'auto') || 'auto'),
        launchCommand: String(settings.get('launch.command', 'dsh') || 'dsh'),
        extraArgs: Array.isArray(settings.get('extraArgs', []))
          ? settings.get('extraArgs', []).filter((value) => typeof value === 'string')
          : [],
        homeMode: String(settings.get('home.mode', 'shared') || 'shared'),
        homePath: String(settings.get('home.path', '') || ''),
      };
    },

    workspaceCwd() {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) return null;
      try {
        const active = vscode.window.activeTextEditor;
        if (active && active.document && active.document.uri) {
          const folder = vscode.workspace.getWorkspaceFolder(active.document.uri);
          if (folder) return folder.uri.fsPath;
        }
      } catch {
        // Active-editor lookup is advisory; the first workspace is authoritative fallback.
      }
      return folders[0].uri.fsPath;
    },

    registryFilePath() {
      return vscode.Uri.joinPath(extensionContext.globalStorageUri, 'dsh-instances.json').fsPath;
    },

    sameRoot(a, b) {
      if (a === b) return true;
      if (a === null || b === null) return false;
      return ServerManager.samePath(a, b);
    },
  });
}

module.exports = { createWorkspaceContext };
