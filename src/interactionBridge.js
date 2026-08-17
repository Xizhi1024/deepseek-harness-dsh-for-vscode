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

function resultMessage(requestId, ok, error = undefined) {
  return {
    type: MESSAGE_TYPES.BRIDGE_RESULT,
    channel: CHANNEL,
    version: VERSION,
    requestId,
    ok,
    ...(ok || !error ? {} : { error: String(error).slice(0, 500) }),
  };
}

async function handleInteractionRequest({ vscode, webview, message, openAttachment = undefined }) {
  const request = parseInteractionRequest(message);
  if (!request) return false;
  try {
    if (request.method === 'clipboard/writeText') {
      await vscode.env.clipboard.writeText(request.text);
    } else if (request.method === 'link/open') {
      await vscode.commands.executeCommand('simpleBrowser.show', request.url);
    } else {
      if (typeof openAttachment !== 'function') throw new Error('Editor attachment opener is unavailable');
      await openAttachment(request.attachmentId);
    }
    await webview.postMessage(resultMessage(request.requestId, true));
  } catch (error) {
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
