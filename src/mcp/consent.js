'use strict';

/**
 * S2b-1: per-server first-use consent gate. Approved server names are
 * persisted in `context.globalState` under `dsh.mcp.consentedServers`. The
 * prompt is fail-closed (120s timeout = reject) and can be revoked with the
 * `dsh.mcp.forgetConsent` command.
 */

const CONSENT_STORAGE_KEY = 'dsh.mcp.consentedServers';
const CONSENT_TIMEOUT_MS = 120000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), ms);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }),
  ]);
}

/**
 * @param {object} options
 * @param {object} options.globalState - VS Code Memento-like globalState.
 * @param {object} options.vscode - VS Code facade.
 * @param {Function} [options.loc] - Localization function.
 * @param {number} [options.timeoutMs]
 * @returns {object} Consent gate API.
 */
function createConsentGate({ globalState, vscode, loc = (value) => value, timeoutMs = CONSENT_TIMEOUT_MS } = {}) {
  if (!globalState || typeof globalState.get !== 'function' || typeof globalState.update !== 'function') {
    throw new TypeError('createConsentGate requires a globalState with get/update');
  }
  if (!vscode || !vscode.window) {
    throw new TypeError('createConsentGate requires a vscode facade');
  }

  function read() {
    const value = globalState.get(CONSENT_STORAGE_KEY);
    return Array.isArray(value) ? value : [];
  }

  function write(names) {
    globalState.update(CONSENT_STORAGE_KEY, [...new Set(names)].sort());
  }

  function isConsented(serverName) {
    return read().includes(serverName);
  }

  /**
   * Consented server names (sorted copy) — the QuickPick source for the
   * forget-consent command so the user always picks an exact stored name.
   */
  function list() {
    return read().slice();
  }

  function forget(serverName) {
    const target = typeof serverName === 'string' ? serverName.trim() : '';
    const previous = read();
    const next = previous.filter((name) => name !== target);
    write(next);
    return next.length !== previous.length;
  }

  /**
   * @param {string} serverName - Server name.
   * @param {object} [options]
   * @param {number} [options.toolCount] - Tool count shown in the prompt.
   * @returns {Promise<boolean>} True when consented (already or now).
   */
  async function ensureConsent(serverName, { toolCount = 0 } = {}) {
    if (isConsented(serverName)) return true;
    const detail = Number.isInteger(toolCount) && toolCount > 0
      ? `${serverName} (${toolCount} tool(s))`
      : serverName;
    const choice = await withTimeout(
      vscode.window.showWarningMessage(
        loc('DSH wants to use the MCP server {server}. Allow it to list and call its tools?', { server: detail }),
        { modal: true },
        'Allow',
        'Reject',
      ),
      timeoutMs,
    );
    if (choice !== 'Allow') return false;
    const next = read();
    next.push(serverName);
    write(next);
    return true;
  }

  return Object.freeze({
    ensureConsent,
    forget,
    isConsented,
    list,
  });
}

module.exports = {
  CONSENT_STORAGE_KEY,
  CONSENT_TIMEOUT_MS,
  createConsentGate,
};
