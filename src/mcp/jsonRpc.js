'use strict';

/**
 * Shared newline-delimited JSON-RPC 2.0 client core for MCP stdio and
 * streamable HTTP transports. Keeps request matching, cancellation and
 * timeout handling in one place; transports only supply the write sink.
 */

const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

class McpRpcError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'McpRpcError';
    this.code = code;
  }
}

class McpJsonRpcClient {
  /**
   * @param {object} options
   * @param {Function} options.write - (line: string) => void write sink.
   * @param {Function} [options.onError] - Optional transport-level error logger.
   */
  constructor({ write, onError = null }) {
    if (typeof write !== 'function') throw new TypeError('McpJsonRpcClient requires a write sink');
    this.write = write;
    this.onError = typeof onError === 'function' ? onError : () => {};
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
  }

  notify(method, params = {}) {
    this._writeFrame({ jsonrpc: '2.0', method, params });
  }

  request(method, params = {}, { signal = null, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
    if (this.closed) {
      return Promise.reject(new McpRpcError('MCP_DISCONNECTED', 'The MCP transport is closed'));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpRpcError('MCP_TIMEOUT', `MCP request timed out: ${method}`));
      }, timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();

      const onAbort = () => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        clearTimeout(timer);
        try {
          this._writeFrame({
            jsonrpc: '2.0',
            method: 'notifications/cancelled',
            params: { requestId: id, reason: 'cancelled' },
          });
        } catch {
          // best-effort cancellation
        }
        reject(new McpRpcError('MCP_ABORTED', `MCP request cancelled: ${method}`));
      };
      if (signal && typeof signal.addEventListener === 'function') {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.pending.set(id, { resolve, reject, timer, signal, onAbort, method });
      try {
        this._writeFrame({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    });
  }

  _writeFrame(message) {
    this.write(JSON.stringify(message));
  }

  handleData(chunk) {
    if (this.closed) return;
    this.buffer += String(chunk);
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) this._handleLine(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  _handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.onError(new Error('MCP transport emitted a non-JSON line'));
      return;
    }
    if (!message || message.jsonrpc !== '2.0') return;
    if (message.id === undefined || message.id === null) return;
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (waiter.signal && typeof waiter.signal.removeEventListener === 'function') {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    if (message.error) {
      waiter.reject(new McpRpcError(message.error.code || 'MCP_ERROR', message.error.message || 'MCP error'));
    } else {
      waiter.resolve(message.result);
    }
  }

  close(error) {
    if (this.closed) return;
    this.closed = true;
    const reason = error || new McpRpcError('MCP_DISCONNECTED', 'The MCP transport closed');
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      if (waiter.signal && typeof waiter.signal.removeEventListener === 'function') {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      waiter.reject(reason);
    }
    this.pending.clear();
  }
}

module.exports = {
  DEFAULT_REQUEST_TIMEOUT_MS,
  McpJsonRpcClient,
  McpRpcError,
};
