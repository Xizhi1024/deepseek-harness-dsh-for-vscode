'use strict';

/**
 * Ctrl+K edit command (D8 verdict: no default keybinding).
 *
 * Select code -> ask for an instruction -> send both as a DSH conversation
 * draft through the thread-attachment coordinator. The end-to-end value
 * (agent applies edits -> changes/push approval -> diff review) depends on the
 * S2a changes-review feature; this command itself only delivers the draft.
 */

const CTRLK_TIMEOUT_MS = 120000;

function isNonEmptySelection(selection) {
  return Boolean(
    selection
    && typeof selection === 'object'
    && selection.start
    && selection.end
    && !(selection.start.line === selection.end.line && selection.start.character === selection.end.character)
  );
}

/**
 * @param {object} deps
 * @param {object} deps.vscode - VS Code facade.
 * @param {object} deps.editorContext - Editor context (attachActiveSelection).
 * @param {object} deps.coordinator - ThreadAttachmentCoordinator.
 * @param {Function} deps.formatSelectionAttachment - Attachment formatter.
 * @param {Function} deps.waitForResolvedView - Resolves the sidebar view.
 * @param {Function} deps.ensureConnected - Returns true when DSH is reachable.
 * @param {Function} deps.loc - Localization function.
 * @param {Function} [deps.focusedComposerWebview] - Best-effort focused DSH surface.
 * @returns {Function} The command handler.
 */
function createCtrlKEditCommand({
  vscode,
  editorContext,
  coordinator,
  formatSelectionAttachment,
  waitForResolvedView,
  ensureConnected,
  loc,
  focusedComposerWebview = null,
  useSessionBridge = () => false,
  insertTargetAttachment = null,
}) {
  if (!vscode || !vscode.window) throw new TypeError('createCtrlKEditCommand requires vscode.window');
  if (!editorContext || typeof editorContext.attachActiveSelection !== 'function') {
    throw new TypeError('createCtrlKEditCommand requires editorContext.attachActiveSelection');
  }
  if (!coordinator || typeof coordinator.request !== 'function') {
    throw new TypeError('createCtrlKEditCommand requires a thread attachment coordinator');
  }
  if (typeof formatSelectionAttachment !== 'function') {
    throw new TypeError('createCtrlKEditCommand requires formatSelectionAttachment');
  }
  if (typeof waitForResolvedView !== 'function') {
    throw new TypeError('createCtrlKEditCommand requires waitForResolvedView');
  }
  if (typeof ensureConnected !== 'function') {
    throw new TypeError('createCtrlKEditCommand requires ensureConnected');
  }
  if (typeof loc !== 'function') {
    throw new TypeError('createCtrlKEditCommand requires loc');
  }

  return async function ctrlKEditCommand() {
    const editor = vscode.window.activeTextEditor;
    const selection = editor && editor.selection;
    if (!editor || !isNonEmptySelection(selection)) {
      await vscode.window.showInformationMessage(loc('Ctrl+K: select code first, then run the command.'));
      return;
    }

    const attachment = editorContext.attachActiveSelection();
    if (useSessionBridge()) {
      try {
        if (typeof insertTargetAttachment !== 'function') throw new Error('Browser attachment bridge is unavailable');
        await insertTargetAttachment(async (signal) => {
          if (signal.aborted) throw Object.assign(new Error('Attachment cancelled'), { code: 'CANCELLED' });
          // VS Code accepts the structural CancellationToken; tie the prompt to
          // the captured surface lifetime without introducing a second owner.
          const token = {
            get isCancellationRequested() { return signal.aborted; },
            onCancellationRequested(listener) {
              const callback = () => listener();
              signal.addEventListener('abort', callback);
              return { dispose: () => signal.removeEventListener('abort', callback) };
            },
          };
          let timer;
          let onAbort;
          let instruction;
          try {
            instruction = await Promise.race([
              vscode.window.showInputBox({ prompt: loc('Ctrl+K instruction'), ignoreFocusOut: false }, token),
              new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), CTRLK_TIMEOUT_MS); if (timer.unref) timer.unref(); }),
              new Promise((resolve) => { onAbort = () => resolve(undefined); signal.addEventListener('abort', onAbort, { once: true }); }),
            ]);
          } finally {
            clearTimeout(timer);
            if (onAbort) signal.removeEventListener('abort', onAbort);
          }
          if (signal.aborted || typeof instruction !== 'string' || instruction.trim().length === 0) throw Object.assign(new Error('Attachment cancelled'), { code: 'CANCELLED' });
          const contextText = formatSelectionAttachment(attachment, attachment.document.uri);
          return `指令:\n${instruction}\n\n上下文:\n${contextText}`;
        });
        await vscode.window.showInformationMessage(loc('Ctrl+K draft sent to the DSH conversation'));
      } catch (error) {
        if (error && error.code === 'CANCELLED') return;
        throw error;
      }
      return;
    }
    const instruction = await Promise.race([
      vscode.window.showInputBox({ prompt: loc('Ctrl+K instruction'), ignoreFocusOut: false }),
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(undefined), CTRLK_TIMEOUT_MS);
        if (timer && typeof timer.unref === 'function') timer.unref();
      }),
    ]);
    if (typeof instruction !== 'string' || instruction.trim().length === 0) {
      return; // cancelled or timed out: never send a draft
    }

    const connected = await ensureConnected();
    if (!connected) {
      await vscode.window.showErrorMessage(loc('DSH: unavailable'));
      return;
    }

    const contextText = formatSelectionAttachment(attachment, attachment.document.uri);
    const draft = `指令:\n${instruction}\n\n上下文:\n${contextText}`;

    let targetWebview = typeof focusedComposerWebview === 'function' ? focusedComposerWebview() : null;
    if (!targetWebview) {
      await vscode.commands.executeCommand('dsh.focusSidebar');
      const view = await waitForResolvedView();
      if (!view || !view.webview || typeof view.webview.postMessage !== 'function') {
        throw new Error(loc('DSH sidebar is unavailable'));
      }
      targetWebview = view.webview;
    }

    await coordinator.request(targetWebview, draft);
    await vscode.window.showInformationMessage(loc('Ctrl+K draft sent to the DSH conversation'));
  };
}

module.exports = { createCtrlKEditCommand, CTRLK_TIMEOUT_MS, isNonEmptySelection };
