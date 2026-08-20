'use strict';

const {
  CHANNELS,
  MESSAGE_TYPES,
  REQUEST_ID,
  VERSIONS,
  isBridgeRequest,
} = require('./protocol/webview');

const CHANNEL = CHANNELS.INTERACTION;
const VERSION = VERSIONS.INTERACTION;
const MAX_COPY_BYTES = 1024 * 1024;
const ATTACHMENT_ID = /^ctx-[1-9][0-9]*$/;

function parseInteractionRequest(message) {
  if (!isBridgeRequest(message)) return null;
  if (!REQUEST_ID.test(message.requestId)) return null;
  if (!message.params || typeof message.params !== 'object') return null;
  if (message.method === 'clipboard/writeText') {
    if (typeof message.params.text !== 'string') return null;
    if (Buffer.byteLength(message.params.text, 'utf8') > MAX_COPY_BYTES) return null;
    return { requestId: message.requestId, method: message.method, text: message.params.text };
  }
  if (message.method === 'clipboard/readText') {
    // No params: the read payload rides the bridge result back to the caller.
    return { requestId: message.requestId, method: message.method };
  }
  if (message.method === 'link/open') {
    if (typeof message.params.url !== 'string') return null;
    let parsed;
    try { parsed = new URL(message.params.url); } catch { return null; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return { requestId: message.requestId, method: message.method, url: parsed.toString() };
  }
  if (message.method === 'attachment/open') {
    if (typeof message.params.attachmentId !== 'string' || !ATTACHMENT_ID.test(message.params.attachmentId)) return null;
    return { requestId: message.requestId, method: message.method, attachmentId: message.params.attachmentId };
  }
  return null;
}

function resultMessage(requestId, ok, error = undefined, data = undefined) {
  return {
    type: MESSAGE_TYPES.BRIDGE_RESULT,
    channel: CHANNEL,
    version: VERSION,
    requestId,
    ok,
    ...(ok || !error ? {} : { error: String(error).slice(0, 500) }),
    ...(ok && data !== undefined ? { data } : {}),
  };
}

async function handleInteractionRequest({ vscode, webview, message, openAttachment = undefined, onReadError = undefined }) {
  const request = parseInteractionRequest(message);
  if (!request) return false;
  try {
    let data;
    if (request.method === 'clipboard/writeText') {
      await vscode.env.clipboard.writeText(request.text);
    } else if (request.method === 'clipboard/readText') {
      const text = await vscode.env.clipboard.readText();
      // Cap the paste payload at the same budget as writes; byte-approximate
      // truncation keeps one bad clipboard from flooding the iframe.
      let bounded = text;
      while (bounded.length > 0 && Buffer.byteLength(bounded, 'utf8') > MAX_COPY_BYTES) {
        bounded = bounded.slice(0, Math.floor(bounded.length / 2));
      }
      data = { text: bounded };
    } else if (request.method === 'link/open') {
      await vscode.commands.executeCommand('simpleBrowser.show', request.url);
    } else {
      if (typeof openAttachment !== 'function') throw new Error('Editor attachment opener is unavailable');
      await openAttachment(request.attachmentId);
    }
    await webview.postMessage(resultMessage(request.requestId, true, undefined, data));
  } catch (error) {
    // Optional host hook so a failed paste read can surface a UI notice
    // (gated by dsh.bridge.ui in extension.js) without this pure module
    // touching vscode.window.
    if (request.method === 'clipboard/readText' && typeof onReadError === 'function') {
      try { await onReadError(error); } catch { /* host notice is best-effort */ }
    }
    await webview.postMessage(resultMessage(
      request.requestId,
      false,
      error && error.message ? error.message : error
    ));
  }
  return true;
}

module.exports = {
  CHANNEL,
  MAX_COPY_BYTES,
  VERSION,
  handleInteractionRequest,
  parseInteractionRequest,
  resultMessage,
};
