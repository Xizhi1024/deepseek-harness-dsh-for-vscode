'use strict';

const crypto = require('node:crypto');

const CHANNEL = 'dsh-vscode-thread';
const VERSION = 1;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,100}$/;

function formatSelectionAttachment(attachment, label) {
  if (!attachment || attachment.kind !== 'selection' || typeof attachment.content !== 'string') {
    throw new TypeError('A selection attachment is required');
  }
  if (typeof attachment.id !== 'string' || !/^ctx-[1-9][0-9]*$/.test(attachment.id)) {
    throw new TypeError('A valid selection attachment id is required');
  }
  const start = attachment.range && attachment.range.start ? attachment.range.start.line + 1 : null;
  const end = attachment.range && attachment.range.end ? attachment.range.end.line + 1 : null;
  let fileName = String(label || 'selection');
  try {
    const pathname = new URL(fileName).pathname;
    fileName = decodeURIComponent(pathname.slice(pathname.lastIndexOf('/') + 1)) || fileName;
  } catch { /* keep the supplied label */ }
  const linkLabel = `${fileName}${start === null || end === null ? '' : `:${start}-${end}`}`
    .replace(/([\\\[\]])/g, '\\$1');
  const target = `https://dsh-vscode.invalid/attachment/${encodeURIComponent(attachment.id)}`;
  return `[${linkLabel}](${target})`;
}

function parseThreadResult(message) {
  if (!message || typeof message !== 'object' || message.type !== 'dshThreadAttachResult') return null;
  if (message.channel !== CHANNEL || message.version !== VERSION) return null;
  if (typeof message.requestId !== 'string' || !REQUEST_ID.test(message.requestId)) return null;
  if (typeof message.ok !== 'boolean') return null;
  return {
    requestId: message.requestId,
    ok: message.ok,
    error: typeof message.error === 'string' ? message.error.slice(0, 500) : undefined,
  };
}

class ThreadAttachmentCoordinator {
  constructor({ timeoutMs = 10000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
  }

  async request(webview, text) {
    if (!webview || typeof webview.postMessage !== 'function') throw new TypeError('Webview is unavailable');
    if (typeof text !== 'string' || text.length === 0) throw new TypeError('Thread attachment text is required');
    const requestId = crypto.randomUUID().replace(/-/g, '_');
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('DSH did not accept the selection before the timeout'));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
    });
    const delivered = await webview.postMessage({
      type: 'dshThreadAttach', channel: CHANNEL, version: VERSION, requestId, text,
    });
    if (!delivered) {
      const waiter = this.pending.get(requestId);
      if (waiter) {
        this.pending.delete(requestId);
        clearTimeout(waiter.timer);
        waiter.reject(new Error('DSH sidebar Webview is unavailable'));
      }
    }
    return result;
  }

  handleResult(message) {
    const result = parseThreadResult(message);
    if (!result) return false;
    const waiter = this.pending.get(result.requestId);
    if (!waiter) return true;
    this.pending.delete(result.requestId);
    clearTimeout(waiter.timer);
    if (result.ok) waiter.resolve();
    else waiter.reject(new Error(result.error || 'DSH rejected the selection'));
    return true;
  }

  dispose() {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('DSH thread attachment bridge disposed'));
    }
    this.pending.clear();
  }
}

module.exports = {
  CHANNEL,
  VERSION,
  ThreadAttachmentCoordinator,
  formatSelectionAttachment,
  parseThreadResult,
};
