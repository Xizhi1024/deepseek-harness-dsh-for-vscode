'use strict';

const { MANAGED_PROFILE } = require('./managedRuntimeLaunch');
const { DEFAULT_HOST, DEFAULT_PORT } = require('./types');
const { normalizeClosePolicy, ServerManager } = require('./serverManager');

// Isolated dev hosts move here when no DSH_VSCODE_PORT pin is present: 3200
// sits beyond the installed windows' forward scan window (DEFAULT_PORT ..
// DEFAULT_PORT+49) under any default; equals the DSH_VSCODE_PORT pin in
// launch.json so both isolation paths land on 3200.
const ISOLATED_DEFAULT_PORT = DEFAULT_PORT + 120;

/**
 * Effective dsh.port. dsh.port is registered in package.json with default
 * 3080, so real `settings.get('port', fallback)` ALWAYS returns 3080 — the
 * fallback is dead code there. inspect() distinguishes an explicit user value
 * (any of the workspace-folder/workspace/user layers) from the registered
 * default, so the host-derived defaultPort only applies when nothing was
 * explicitly configured. Facades without inspect() keep the plain get().
 *
 * @param {object} settings - Configuration section (VS Code API shape).
 * @param {number} fallbackPort - Host-derived default port.
 * @returns {number}
 */
function portSetting(settings, fallbackPort) {
  const layers = typeof settings.inspect === 'function' ? settings.inspect('port') : null;
  if (!layers) return settings.get('port', fallbackPort);
  return layers.workspaceFolderValue ?? layers.workspaceValue ?? layers.globalValue ?? fallbackPort;
}

/**
 * Default port for this host. DSH_VSCODE_PORT when the dev launch pins one;
 * otherwise any host that redirected its extension storage (DSH_VSCODE_STORAGE_ROOT)
 * is an isolated dev host and moves to DSH_VSCODE_ISOLATED_PORT so it can never
 * share the scan window of the installed windows' default port — even when the
 * running host inherited a launch-env snapshot from before DSH_VSCODE_PORT
 * existed (window reload, restarted debug session). Invalid pins throw so a
 * typo'd launch env can never silently fall back to sharing the default port.
 *
 * @param {object} [env] Environment to read (defaults to process.env).
 * @returns {number} Port used only when the user has no dsh.port setting.
 */
function resolveDefaultPort(env = process.env) {
  const configured = String(env.DSH_VSCODE_PORT ?? '').trim();
  if (configured) {
    if (!/^\d{1,5}$/.test(configured) || Number(configured) < 1 || Number(configured) > 65535) {
      throw new Error('DSH_VSCODE_PORT must be an integer between 1 and 65535');
    }
    return Number(configured);
  }
  if (String(env.DSH_VSCODE_STORAGE_ROOT ?? '').trim()) return ISOLATED_DEFAULT_PORT;
  return DEFAULT_PORT;
}

/**
 * Bind workspace and configuration reads to one VS Code extension context.
 *
 * @param {object} vscode - VS Code facade.
 * @param {object} extensionContext - Active ExtensionContext.
 * @param {number} [defaultPort] - Setting fallback port (activation-resolved
 *   DSH_VSCODE_PORT, else DEFAULT_PORT); an explicit dsh.port still wins.
 * @returns {object} Read-only workspace helpers.
 */
function createWorkspaceContext(vscode, extensionContext, globalStorageUri = extensionContext.globalStorageUri, defaultPort = DEFAULT_PORT) {
  return Object.freeze({
    config() {
      const settings = vscode.workspace.getConfiguration('dsh');
      return {
        host: settings.get('host', DEFAULT_HOST),
        port: portSetting(settings, defaultPort),
        autoStart: settings.get('autoStart', true),
        profile: String(settings.get('profile', MANAGED_PROFILE) || MANAGED_PROFILE),
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
      return vscode.Uri.joinPath(globalStorageUri, 'dsh-instances.json').fsPath;
    },

    sameRoot(a, b) {
      if (a === b) return true;
      if (a === null || b === null) return false;
      return ServerManager.samePath(a, b);
    },
  });
}

module.exports = { createWorkspaceContext, resolveDefaultPort, portSetting, ISOLATED_DEFAULT_PORT };
