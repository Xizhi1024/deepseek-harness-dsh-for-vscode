'use strict';

/**
 * Create the fixed message router used by the status-page Webview.
 * Unknown and malformed messages are deliberately ignored.
 *
 * @param {object} handlers
 * @param {Function} handlers.openBrowser
 * @param {Function} handlers.retry
 * @returns {(message: unknown) => boolean} true when a known message was routed.
 */
function createWebviewMessageHandler({ openBrowser, retry, interaction = undefined }) {
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
    if (message.type === 'dshBridge' && typeof interaction === 'function') {
      interaction(message);
      return true;
    }
    return false;
  };
}

module.exports = { createWebviewMessageHandler };
