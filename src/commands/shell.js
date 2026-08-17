'use strict';

/**
 * Thin command shell for the 0.6 command layer.
 *
 * Every command goes through the same gate: resolve the capability adapter
 * from the router, then execute. When the router reports the capability as
 * unavailable (NullAdapter / null / undefined) the shell surfaces a short
 * information message and never runs the command body.
 *
 * This module intentionally has zero npm dependencies and does not know any
 * concrete capability or adapter implementation.
 */

/** Sentinel returned by routers to mean "no adapter is available". */
const NullAdapter = Object.freeze({ id: 'null-adapter' });

function isUnavailable(adapter) {
  return adapter === NullAdapter || adapter === null || adapter === undefined;
}

/**
 * Create a command shell bound to one router.
 *
 * @param {{ get(capabilityId: string): unknown }} options - Router dependency.
 * @returns {{ register(vscode: object, commandId: string, capabilityId: string, run: Function): object }}
 */
function createCommandShell({ router } = {}) {
  if (!router || typeof router.get !== 'function') {
    throw new TypeError('createCommandShell requires a router with a get() method');
  }

  return {
    /**
     * Register one command through the shell.
     *
     * @param {object} vscode - VS Code facade with commands.registerCommand.
     * @param {string} commandId - Command id exposed to VS Code.
     * @param {string} capabilityId - Capability id passed to router.get().
     * @param {Function} run - Command body invoked after the adapter gate.
     * @returns {object} Disposable from vscode.commands.registerCommand.
     */
    register(vscode, commandId, capabilityId, run) {
      if (!vscode || !vscode.commands || typeof vscode.commands.registerCommand !== 'function') {
        throw new TypeError('vscode.commands.registerCommand is required');
      }
      if (typeof run !== 'function') {
        throw new TypeError('run must be a function');
      }
      return vscode.commands.registerCommand(commandId, async (...args) => {
        const adapter = router.get(capabilityId);
        if (isUnavailable(adapter)) {
          const message = typeof vscode.l10n?.t === 'function'
            ? vscode.l10n.t('Capability unavailable')
            : 'Capability unavailable';
          await vscode.window.showInformationMessage(message);
          return undefined;
        }
        return run(...args);
      });
    },
  };
}

module.exports = {
  NullAdapter,
  createCommandShell,
};
