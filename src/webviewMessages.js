'use strict';

const { CHANNELS, MESSAGE_TYPES, VERSIONS } = require('./protocol/webview');

/**
 * Extension-host → Webview shell theme synchronization message type.
 * The shell forwards a message with this type to the DSH iframe via
 * postMessage; old DSH clients ignore the extra message and degrade silently.
 */
const DSH_THEME_CHANGED = 'dshThemeChanged';

/**
 * Create the fixed message router used by the status-page Webview.
 * Unknown and malformed messages are deliberately ignored.
 *
 * @param {object} handlers
 * @param {Function} handlers.openBrowser
 * @param {Function} handlers.retry
 * @param {Function} [handlers.interaction]
 * @param {Function} [handlers.threadResult]
 * @param {Function} [handlers.handshakeError]
 * @param {Function} [handlers.sessionChanged] - Receives the sessionId of an
 *   in-iframe conversation switch (dshSessionChanged relay).
 * @returns {(message: unknown) => boolean} true when a known message was routed.
 */
function createWebviewMessageHandler({
  openBrowser,
  retry,
  interaction = undefined,
  threadResult = undefined,
  handshakeError = undefined,
  sessionChanged = undefined,
}) {
  if (typeof openBrowser !== 'function' || typeof retry !== 'function') {
    throw new TypeError('Webview message handlers must be functions');
  }
  return (message) => {
    if (!message || typeof message !== 'object') return false;
    if (message.type === 'openBrowser') {
      openBrowser();
      return true;
    }
    if (message.type === 'retry') {
      retry();
      return true;
    }
    if (message.type === MESSAGE_TYPES.HELLO && typeof handshakeError === 'function') {
      handshakeError(message);
      return true;
    }
    if (message.type === MESSAGE_TYPES.BRIDGE && typeof interaction === 'function') {
      interaction(message);
      return true;
    }
    if (message.type === MESSAGE_TYPES.THREAD_ATTACH_RESULT && typeof threadResult === 'function') {
      threadResult(message);
      return true;
    }
    if (message.type === 'dshSessionChanged' && typeof sessionChanged === 'function') {
      sessionChanged(message.sessionId);
      return true;
    }
    return false;
  };
}

module.exports = {
  CHANNELS,
  DSH_THEME_CHANGED,
  MESSAGE_TYPES,
  VERSIONS,
  createWebviewMessageHandler,
};
