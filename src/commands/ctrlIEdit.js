'use strict';

/**
 * Ctrl+I edit command (core layer).
 *
 * Pick one to eight workspace files in a multi-select QuickPick, attach them
 * through editorContext.attachFiles, format a multi-file context block and
 * hand it to the thread attachment coordinator. The command does not register
 * itself; the asm layer owns registration via registerFeatureCommands.
 */

/**
 * Workspace file picker is bounded like the v3 bridge findFiles handler
 * (see MAX_FIND_FILES in src/bridge/v3.js): at most 500 items are shown.
 * @type {number}
 */
const CTRLI_MAX_FILES = 500;

/**
 * QuickPick fail-closed timeout, mirroring CONFIRM_TIMEOUT_MS in
 * src/bridge/v3.js: when the picker is left open for 120s it is dismissed
 * without sending anything.
 * @type {number}
 */
const CTRLI_TIMEOUT_MS = 120000;

/**
 * Frozen contract limit for attachFiles: 1-8 files per Ctrl+I request.
 * @type {number}
 */
const CTRLI_MAX_PICKED_FILES = 8;

/**
 * Minimal l10n fallback for tests and non-localized hosts.
 */
function defaultLoc(template, params = {}) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? `{${key}}`));
}

function uriText(uri) {
  return uri && typeof uri.toString === 'function' ? uri.toString() : String(uri);
}

/**
 * Best-effort file name for a QuickPick item label. Prefers URL path parsing
 * so `file:///...` URIs decode to a bare file name; falls back to the last
 * `/` segment of the stringified URI.
 *
 * @param {object} uri - VS Code URI object.
 * @returns {string} File name.
 */
function fileNameOf(uri) {
  const text = uriText(uri);
  try {
    const pathname = new URL(text).pathname;
    const name = decodeURIComponent(pathname.slice(pathname.lastIndexOf('/') + 1));
    if (name) return name;
  } catch { /* keep the stringified fallback below */ }
  const index = text.lastIndexOf('/');
  return index >= 0 ? text.slice(index + 1) : text;
}

/**
 * Best-effort workspace-relative path for a QuickPick item description.
 * Uses workspace.getWorkspaceFolder when available and falls back to the
 * stringified URI otherwise.
 *
 * @param {object} uri - VS Code URI object.
 * @param {object} vscode - VS Code facade.
 * @returns {string} Workspace-relative path.
 */
function relativePathOf(uri, vscode) {
  const text = uriText(uri);
  const workspace = vscode && vscode.workspace;
  if (workspace && typeof workspace.getWorkspaceFolder === 'function') {
    const folder = workspace.getWorkspaceFolder(uri);
    const folderText = folder && folder.uri ? uriText(folder.uri) : '';
    if (folderText) {
      if (text === folderText) return '';
      if (text.startsWith(`${folderText}/`)) return text.slice(folderText.length + 1);
    }
  }
  return text;
}

/**
 * Build the `dsh.ctrlIEdit` command body.
 *
 * @param {object} deps - Injected dependencies.
 * @param {object} deps.vscode - VS Code facade (window.createQuickPick,
 *   window.show*Message, workspace.findFiles).
 * @param {object} deps.editorContext - Editor context with attachFiles().
 * @param {object} deps.coordinator - ThreadAttachmentCoordinator with request().
 * @param {Function} deps.formatFileAttachment - Formats one file attachment.
 * @param {Function} deps.waitForResolvedView - Resolves the current sidebar view.
 * @param {Function} deps.ensureConnected - Ensures a DSH server is connected.
 * @param {Function} [deps.loc] - Localization helper.
 * @param {Function} [deps.focusedComposerWebview] - Best-effort focused DSH surface.
 * @returns {Function} Async command body.
 */
function createCtrlIEditCommand({
  vscode,
  editorContext,
  coordinator,
  formatFileAttachment,
  waitForResolvedView,
  ensureConnected,
  loc = defaultLoc,
  focusedComposerWebview = null,
}) {
  if (!vscode || !vscode.window || typeof vscode.window.createQuickPick !== 'function') {
    throw new TypeError('createCtrlIEditCommand requires vscode.window.createQuickPick');
  }
  if (typeof vscode.window.showWarningMessage !== 'function') {
    throw new TypeError('createCtrlIEditCommand requires vscode.window.showWarningMessage');
  }
  if (typeof vscode.window.showErrorMessage !== 'function') {
    throw new TypeError('createCtrlIEditCommand requires vscode.window.showErrorMessage');
  }
  if (typeof vscode.window.showInformationMessage !== 'function') {
    throw new TypeError('createCtrlIEditCommand requires vscode.window.showInformationMessage');
  }
  if (!vscode.workspace || typeof vscode.workspace.findFiles !== 'function') {
    throw new TypeError('createCtrlIEditCommand requires vscode.workspace.findFiles');
  }
  if (!editorContext || typeof editorContext.attachFiles !== 'function') {
    throw new TypeError('createCtrlIEditCommand requires editorContext.attachFiles');
  }
  if (!coordinator || typeof coordinator.request !== 'function') {
    throw new TypeError('createCtrlIEditCommand requires a thread attachment coordinator');
  }
  if (typeof formatFileAttachment !== 'function') {
    throw new TypeError('createCtrlIEditCommand requires formatFileAttachment');
  }
  if (typeof waitForResolvedView !== 'function') {
    throw new TypeError('createCtrlIEditCommand requires waitForResolvedView');
  }
  if (typeof ensureConnected !== 'function') {
    throw new TypeError('createCtrlIEditCommand requires ensureConnected');
  }
  if (typeof loc !== 'function') {
    throw new TypeError('createCtrlIEditCommand requires loc');
  }

  /**
   * Open the bounded workspace file QuickPick.
   *
   * @returns {Promise<object[]|null>} Picked QuickPick items, or null when
   *   cancelled, hidden, or timed out.
   */
  function pickWorkspaceFiles() {
    return new Promise((resolve, reject) => {
      let settled = false;
      let picker = null;
      let timer = null;
      const finish = (result, error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (picker && typeof picker.dispose === 'function') picker.dispose();
        if (error) reject(error);
        else resolve(result);
      };

      Promise.resolve(vscode.workspace.findFiles('**/*', undefined, CTRLI_MAX_FILES)).then(
        (uris) => {
          if (settled) return;
          const files = Array.isArray(uris) ? uris : [];
          picker = vscode.window.createQuickPick();
          picker.canPickMany = true;
          picker.title = loc('DSH: editing context');
          picker.placeholder = loc('Select files to send to the DSH conversation');
          picker.items = files.map((uri) => ({
            label: fileNameOf(uri),
            description: relativePathOf(uri, vscode),
            uri,
          }));
          picker.onDidAccept(() => finish([...(picker.selectedItems || [])]));
          picker.onDidHide(() => finish(null));
          timer = setTimeout(() => finish(null), CTRLI_TIMEOUT_MS);
          if (timer && typeof timer.unref === 'function') timer.unref();
          picker.show();
        },
        (error) => finish(null, error)
      );
    });
  }

  return async function ctrlIEditCommand() {
    try {
      const picked = await pickWorkspaceFiles();
      // Cancelled (Esc/hide) or timed out: fail closed, never send a draft and
      // never spam a message.
      if (!picked) return;
      if (picked.length === 0) return;

      if (picked.length > CTRLI_MAX_PICKED_FILES) {
        await vscode.window.showWarningMessage(loc(
          'DSH: editing context supports up to {max} files',
          { max: String(CTRLI_MAX_PICKED_FILES) }
        ));
        return;
      }

      const uris = picked.map((item) => item.uri);
      const attachments = await editorContext.attachFiles(uris);
      const blocks = attachments.map((attachment, index) => formatFileAttachment(attachment, uris[index]));
      const text = [
        loc('DSH: editing context ({count} files)', { count: String(attachments.length) }),
        ...blocks,
      ].join('\n');

      let targetWebview = typeof focusedComposerWebview === 'function' ? focusedComposerWebview() : null;
      if (!targetWebview) {
        const view = await waitForResolvedView();
        if (!view || !view.webview || typeof view.webview.postMessage !== 'function') {
          await vscode.window.showErrorMessage(loc('DSH sidebar is unavailable'));
          return;
        }
        targetWebview = view.webview;
      }

      if (!(await ensureConnected())) {
        await vscode.window.showErrorMessage(loc('DSH: unavailable'));
        return;
      }

      await coordinator.request(targetWebview, text);
      await vscode.window.showInformationMessage(loc('DSH: editing context sent to the DSH conversation'));
    } catch (err) {
      await vscode.window.showErrorMessage(loc('DSH: editing context failed: {message}', {
        message: err && err.message ? err.message : String(err),
      }));
    }
  };
}

module.exports = {
  createCtrlIEditCommand,
  CTRLI_MAX_FILES,
  CTRLI_MAX_PICKED_FILES,
  CTRLI_TIMEOUT_MS,
};
