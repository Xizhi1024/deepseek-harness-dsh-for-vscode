'use strict';

const { VIEW_ID, CONTAINER_ID } = require('../types');

/**
 * Minimal l10n fallback for tests and non-localized hosts.
 */
function defaultLoc(template, params = {}) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? `{${key}}`));
}

/**
 * Build the `dsh.addFileToThread` command body.
 *
 * Flow:
 *  1. Attach the active file to the editor context pool.
 *  2. Reveal and focus the DSH sidebar so the draft is visible.
 *  3. Format a clickable file link (no line range) and hand it to the
 *     thread attachment coordinator.
 *
 * The command intentionally does not promise DSH-side @mention rendering;
 * this batch only guarantees the draft contains a file link that opens in
 * the current VS Code window.
 *
 * @param {object} deps - Injected dependencies.
 * @param {object} deps.vscode - VS Code facade.
 * @param {object} deps.editorContext - Editor context with attachActiveFile().
 * @param {object} deps.coordinator - ThreadAttachmentCoordinator with request().
 * @param {Function} deps.formatFileAttachment - Formats an active-file attachment.
 * @param {Function} deps.waitForResolvedView - Resolves the current sidebar view.
 * @param {Function} deps.ensureConnected - Ensures a DSH server is connected.
 * @param {Function} [deps.loc] - Localization helper.
 * @returns {Function} Async command body.
 */
function createAddFileToThreadCommand({
  vscode,
  editorContext,
  coordinator,
  formatFileAttachment,
  waitForResolvedView,
  ensureConnected,
  loc = defaultLoc,
}) {
  if (!vscode || !vscode.commands || typeof vscode.commands.executeCommand !== 'function') {
    throw new TypeError('vscode.commands.executeCommand is required');
  }
  if (!editorContext || typeof editorContext.attachActiveFile !== 'function') {
    throw new TypeError('editorContext.attachActiveFile is required');
  }
  if (!coordinator || typeof coordinator.request !== 'function') {
    throw new TypeError('coordinator.request is required');
  }
  if (typeof formatFileAttachment !== 'function') {
    throw new TypeError('formatFileAttachment must be a function');
  }
  if (typeof waitForResolvedView !== 'function') {
    throw new TypeError('waitForResolvedView must be a function');
  }
  if (typeof ensureConnected !== 'function') {
    throw new TypeError('ensureConnected must be a function');
  }

  return async function addFileToThread() {
    try {
      // Explicit user action: allow a trusted file:// URI from outside the
      // open workspace folders. Implicit Add Active File / Selection /
      // Problems commands keep the workspace-only gate.
      const attachment = editorContext.attachActiveFile({ allowOutsideWorkspace: true });
      await vscode.commands.executeCommand('workbench.view.extension.' + CONTAINER_ID);
      await vscode.commands.executeCommand(VIEW_ID + '.focus');
      const view = await waitForResolvedView();
      if (!view) throw new Error(loc('DSH sidebar is unavailable'));
      if (!(await ensureConnected())) throw new Error(loc('DSH: unavailable'));
      const text = formatFileAttachment(attachment, attachment.document.uri);
      await coordinator.request(view.webview, text);
      await vscode.window.showInformationMessage(loc('File added to the DSH conversation'));
    } catch (err) {
      await vscode.window.showErrorMessage(loc('Add to DSH conversation failed: {message}', {
        message: err && err.message ? err.message : String(err),
      }));
    }
  };
}

/**
 * Build the `dsh.addFolderToThread` command body.
 *
 * Flow mirrors `dsh.addFileToThread` but for an Explorer folder resource:
 *  1. Attach a bounded directory listing (relative paths only — never file
 *     contents) to the editor context pool. The listing is the value DSH
 *     reads back; the draft receives only a compact clickable folder link.
 *  2. Reveal and focus the DSH sidebar so the draft is visible.
 *  3. Hand the clickable folder link to the thread attachment coordinator.
 *
 * VS Code passes the Explorer folder's `Uri` as the first command argument
 * when invoked from the `explorer/context` menu.
 *
 * @param {object} deps - Injected dependencies.
 * @param {object} deps.vscode - VS Code facade.
 * @param {object} deps.editorContext - Editor context with attachFolder().
 * @param {object} deps.coordinator - ThreadAttachmentCoordinator with request().
 * @param {Function} deps.formatFolderAttachment - Formats a folder attachment.
 * @param {Function} deps.waitForResolvedView - Resolves the current sidebar view.
 * @param {Function} deps.ensureConnected - Ensures a DSH server is connected.
 * @param {Function} [deps.loc] - Localization helper.
 * @returns {Function} Async command body taking the folder URI argument.
 */
function createAddFolderToThreadCommand({
  vscode,
  editorContext,
  coordinator,
  formatFolderAttachment,
  waitForResolvedView,
  ensureConnected,
  loc = defaultLoc,
}) {
  if (!vscode || !vscode.commands || typeof vscode.commands.executeCommand !== 'function') {
    throw new TypeError('vscode.commands.executeCommand is required');
  }
  if (!editorContext || typeof editorContext.attachFolder !== 'function') {
    throw new TypeError('editorContext.attachFolder is required');
  }
  if (!coordinator || typeof coordinator.request !== 'function') {
    throw new TypeError('coordinator.request is required');
  }
  if (typeof formatFolderAttachment !== 'function') {
    throw new TypeError('formatFolderAttachment must be a function');
  }
  if (typeof waitForResolvedView !== 'function') {
    throw new TypeError('waitForResolvedView must be a function');
  }
  if (typeof ensureConnected !== 'function') {
    throw new TypeError('ensureConnected must be a function');
  }

  return async function addFolderToThread(uri) {
    try {
      if (!uri || typeof uri !== 'object') {
        throw new Error(loc('A folder URI is required'));
      }
      // Explicit reader action: like Add File to DSH Thread, a trusted
      // file:// folder outside the open workspace folders may be listed.
      const attachment = editorContext.attachFolder(uri, { allowOutsideWorkspace: true });
      await vscode.commands.executeCommand('workbench.view.extension.' + CONTAINER_ID);
      await vscode.commands.executeCommand(VIEW_ID + '.focus');
      const view = await waitForResolvedView();
      if (!view) throw new Error(loc('DSH sidebar is unavailable'));
      if (!(await ensureConnected())) throw new Error(loc('DSH: unavailable'));
      const text = formatFolderAttachment(attachment, attachment.document.uri);
      await coordinator.request(view.webview, text);
      await vscode.window.showInformationMessage(loc('Folder added to the DSH conversation'));
    } catch (err) {
      await vscode.window.showErrorMessage(loc('Add to DSH conversation failed: {message}', {
        message: err && err.message ? err.message : String(err),
      }));
    }
  };
}

module.exports = {
  createAddFileToThreadCommand,
  createAddFolderToThreadCommand,
};
