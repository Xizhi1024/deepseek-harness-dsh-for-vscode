'use strict';

const crypto = require('node:crypto');
const net = require('node:net');

const {
  METHODS_BY_VERSION,
  NOTIFICATIONS_BY_VERSION,
  PROTOCOL_VERSIONS,
  V2_NOTIFICATION_SCHEMA,
  validateV2NotificationParams,
} = require('./protocol/ch1');

const VSCODE_PROTOCOL_VERSION = 1;
const VSCODE_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const REQUEST_METHODS = Object.freeze([...new Set(Object.values(METHODS_BY_VERSION).flat())]);
const NOTIFICATION_METHODS = Object.freeze([...new Set(Object.values(NOTIFICATIONS_BY_VERSION).flat())]);

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function tokenMatches(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(actual, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// C2 contract for vscode/dshEditObserved params:
// { tool: 'edit'|'write', path: string, sessionId: string, size: number,
//   truncated: boolean, beforeText?: string } — beforeText (2026-09-04) is
// the optional pre-execute file content (≤1 MiB) for true before diffs;
// oversized or metadata-only notifications omit it.
const EDIT_OBSERVED_MAX_BEFORE_TEXT_BYTES = 1024 * 1024;
function isValidDshEditObservedParams(params) {
  if (!isRecord(params)) return false;
  if (params.tool !== 'edit' && params.tool !== 'write') return false;
  if (typeof params.path !== 'string' || params.path.length === 0) return false;
  if (typeof params.sessionId !== 'string') return false;
  if (typeof params.size !== 'number' || !Number.isFinite(params.size) || params.size < 0) return false;
  if (typeof params.truncated !== 'boolean') return false;
  if (params.beforeText !== undefined) {
    if (typeof params.beforeText !== 'string') return false;
    if (Buffer.byteLength(params.beforeText, 'utf8') > EDIT_OBSERVED_MAX_BEFORE_TEXT_BYTES) return false;
  }
  return true;
}

function bridgeError(code, message) {
  const error = new Error(message);
  error.bridgeCode = code;
  return error;
}

function normalizeProtocolVersions(protocolVersions) {
  if (!Array.isArray(protocolVersions) || protocolVersions.length === 0) {
    throw new Error('VersionedBridgeServer protocolVersions must be a non-empty array');
  }
  const normalized = [];
  for (const version of protocolVersions) {
    if (!Number.isInteger(version) || version < 1) {
      throw new Error('VersionedBridgeServer protocolVersions must contain positive integers');
    }
    if (!normalized.includes(version)) normalized.push(version);
  }
  return Object.freeze(normalized.sort((a, b) => a - b));
}

class VersionedBridgeServer {
  constructor({
    handlers = {},
    workspace,
    serverVersion = '0.0.0',
    token = crypto.randomBytes(32).toString('hex'),
    protocolVersion,
    protocolVersions,
    maxFrameBytes = VSCODE_MAX_FRAME_BYTES,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    onDshEditObserved = null,
  } = {}) {
    if (!isRecord(handlers)) throw new Error('VersionedBridgeServer handlers must be an object');
    if (protocolVersions === undefined) {
      protocolVersions = protocolVersion === undefined ? PROTOCOL_VERSIONS : [protocolVersion];
    }
    this.protocolVersions = normalizeProtocolVersions(protocolVersions);
    this.protocolVersion = this.protocolVersions[this.protocolVersions.length - 1];
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 256) {
      throw new Error('VersionedBridgeServer maxFrameBytes must be at least 256');
    }
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
      throw new Error('VersionedBridgeServer requestTimeoutMs must be positive');
    }
    for (const name of Object.keys(handlers)) {
      if (!REQUEST_METHODS.includes(name)) throw new Error(`Unsupported VS Code bridge handler: ${name}`);
      if (typeof handlers[name] !== 'function') throw new Error(`VS Code bridge handler must be a function: ${name}`);
    }
    if (onDshEditObserved !== null && typeof onDshEditObserved !== 'function') {
      throw new Error('VersionedBridgeServer onDshEditObserved must be a function');
    }
    this.onDshEditObserved = onDshEditObserved;
    this.handlers = Object.freeze({ ...handlers });
    this.workspace = workspace || {
      windowId: crypto.randomUUID(),
      trusted: false,
      kind: 'local',
      folders: [],
    };
    this.serverVersion = String(serverVersion);
    this.token = token;
    this.maxFrameBytes = maxFrameBytes;
    this.requestTimeoutMs = requestTimeoutMs;
    this.server = null;
    this.sockets = new Set();
    this.connections = new Set();
    this.initializedWaiters = new Set();
    this.port = null;
    this.closed = false;
  }

  async start() {
    if (this.server) return this;
    if (this.closed) throw new Error('VersionedBridgeServer is closed');
    const server = net.createServer((socket) => this._accept(socket));
    this.server = server;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('VersionedBridgeServer has no TCP address');
    this.port = address.port;
    server.unref();
    return this;
  }

  get env() {
    if (this.port === null) throw new Error('VersionedBridgeServer has not started');
    return Object.freeze({
      DSH_VSCODE_BRIDGE_HOST: '127.0.0.1',
      DSH_VSCODE_BRIDGE_PORT: String(this.port),
      DSH_VSCODE_BRIDGE_TOKEN: this.token,
      DSH_VSCODE_BRIDGE_PROTOCOL: String(this.protocolVersion),
    });
  }

  waitForInitialized(timeoutMs = this.requestTimeoutMs) {
    if ([...this.connections].some((connection) => connection.initialized)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.initializedWaiters.delete(waiter);
        reject(bridgeError('VSCODE_REQUEST_TIMEOUT', 'VS Code bridge initialization timed out'));
      }, timeoutMs);
      waiter.timer.unref?.();
      this.initializedWaiters.add(waiter);
    });
  }

  notify(method, params) {
    const supported = Object.values(NOTIFICATIONS_BY_VERSION).some((methods) => methods.includes(method));
    if (!supported) throw new Error(`Unsupported VS Code bridge notification: ${method}`);
    if (V2_NOTIFICATION_SCHEMA[method]) {
      validateV2NotificationParams(method, params);
    }
    for (const connection of this.connections) {
      if (!connection.initialized || connection.socket.destroyed) continue;
      const methods = NOTIFICATIONS_BY_VERSION[connection.protocolVersion];
      if (!methods || !methods.includes(method)) continue;
      this._write(connection.socket, { jsonrpc: '2.0', method, params });
    }
  }

  hasProtocolVersion(protocolVersion) {
    return [...this.connections].some((connection) => (
      connection.initialized
      && connection.protocolVersion === protocolVersion
      && !connection.socket.destroyed
    ));
  }

  hasV2Clients() {
    return this.hasProtocolVersion(2);
  }

  _accept(socket) {
    if (socket.remoteAddress !== '127.0.0.1' && socket.remoteAddress !== '::ffff:127.0.0.1') {
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    socket.unref();
    const connection = {
      socket,
      buffer: Buffer.alloc(0),
      initialized: false,
      protocolVersion: null,
      pending: new Map(),
    };
    this.sockets.add(socket);
    this.connections.add(connection);
    socket.on('data', (chunk) => this._onData(connection, chunk));
    socket.once('close', () => this._release(connection));
    socket.once('error', () => this._release(connection));
  }

  _onData(connection, chunk) {
    if (connection.socket.destroyed) return;
    connection.buffer = connection.buffer.length === 0
      ? Buffer.from(chunk)
      : Buffer.concat([connection.buffer, chunk]);
    for (;;) {
      const newline = connection.buffer.indexOf(0x0a);
      if (newline < 0) {
        if (connection.buffer.length > this.maxFrameBytes) this._rejectOversized(connection);
        return;
      }
      if (newline > this.maxFrameBytes) {
        this._rejectOversized(connection);
        return;
      }
      const frame = connection.buffer.subarray(0, newline);
      connection.buffer = connection.buffer.subarray(newline + 1);
      if (frame.length === 0) continue;
      void this._handleFrame(connection, frame);
    }
  }

  _rejectOversized(connection) {
    this._writeError(connection.socket, null, -32010, 'VSCODE_FRAME_TOO_LARGE', 'VS Code bridge frame exceeds byte limit');
    connection.socket.end();
  }

  async _handleFrame(connection, bytes) {
    let frame;
    try {
      frame = JSON.parse(bytes.toString('utf8'));
    } catch {
      this._writeError(connection.socket, null, -32700, 'VSCODE_INVALID_PARAMS', 'Invalid JSON frame');
      return;
    }
    if (!isRecord(frame) || frame.jsonrpc !== '2.0' || typeof frame.method !== 'string') {
      this._writeError(connection.socket, isRecord(frame) ? frame.id ?? null : null, -32600, 'VSCODE_INVALID_PARAMS', 'Invalid JSON-RPC request');
      return;
    }
    try {
      await this._dispatchFrame(connection, frame);
    } catch (error) {
      // Last-resort guard: _onData fires this as a void-ed promise, so an
      // uncaught throw anywhere in dispatch would leave the request
      // unanswered and the client hanging until its own timeout (F5 smoke
      // round 2 root cause: initialize crashed on the notifications table
      // and the socket just sat there accepting bytes).
      const id = typeof frame.id === 'string' || typeof frame.id === 'number' ? frame.id : null;
      this._writeError(connection.socket, id, -32603, 'VSCODE_INTERNAL_ERROR', error instanceof Error ? error.message : String(error));
    }
  }

  async _dispatchFrame(connection, frame) {
    if (frame.method === '$/cancelRequest' && frame.id === undefined) {
      const targetId = isRecord(frame.params) ? frame.params.id : undefined;
      const controller = connection.pending.get(targetId);
      controller?.abort(bridgeError('VSCODE_REQUEST_CANCELLED', 'VS Code bridge request cancelled'));
      return;
    }
    if (frame.id === undefined) {
      // C2: the only client→server notification the bridge understands.
      // Any other id-less frame stays ignored (pre-existing behavior).
      if (frame.method === 'vscode/dshEditObserved') {
        this._handleDshEditObserved(connection, frame);
      }
      return;
    }
    const id = frame.id;
    if (typeof id !== 'string' && typeof id !== 'number') {
      this._writeError(connection.socket, null, -32600, 'VSCODE_INVALID_PARAMS', 'JSON-RPC id must be a string or number');
      return;
    }
    const params = isRecord(frame.params) ? frame.params : {};
    if (!connection.initialized) {
      if (frame.method !== 'initialize') {
        this._writeError(connection.socket, id, -32001, 'VSCODE_NOT_INITIALIZED', 'VS Code bridge is not initialized');
        return;
      }
      this._initialize(connection, id, params);
      return;
    }
    if (frame.method === 'initialize') {
      this._writeError(connection.socket, id, -32600, 'VSCODE_INVALID_PARAMS', 'VS Code bridge is already initialized');
      return;
    }
    const handler = this.handlers[frame.method];
    const versionMethods = METHODS_BY_VERSION[connection.protocolVersion] || [];
    if (!REQUEST_METHODS.includes(frame.method) || !versionMethods.includes(frame.method) || typeof handler !== 'function') {
      this._writeError(connection.socket, id, -32601, 'VSCODE_METHOD_NOT_ALLOWED', `Method not allowed: ${frame.method}`);
      return;
    }
    const controller = new AbortController();
    connection.pending.set(id, controller);
    const timer = setTimeout(() => {
      controller.abort(bridgeError('VSCODE_REQUEST_TIMEOUT', `VS Code bridge request timed out: ${frame.method}`));
    }, this.requestTimeoutMs);
    timer.unref?.();
    try {
      const result = await Promise.race([
        Promise.resolve(handler(params, { signal: controller.signal, method: frame.method })),
        new Promise((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(
            controller.signal.reason instanceof Error
              ? controller.signal.reason
              : bridgeError('VSCODE_REQUEST_CANCELLED', 'VS Code bridge request cancelled')
          ), { once: true });
        }),
      ]);
      if (!connection.socket.destroyed) this._write(connection.socket, { jsonrpc: '2.0', id, result });
    } catch (error) {
      if (!connection.socket.destroyed) {
        const code = error && error.bridgeCode
          ? error.bridgeCode
          : 'VSCODE_INVALID_PARAMS';
        this._writeError(connection.socket, id, -32603, code, error instanceof Error ? error.message : String(error));
      }
    } finally {
      clearTimeout(timer);
      connection.pending.delete(id);
    }
  }

  // C2: receive side of the edit-observation notification. Parameters are
  // validated against the C2 contract; anything invalid is dropped silently
  // (a notification has no id, so there is nobody to answer). A missing or
  // throwing sink never disturbs the connection.
  _handleDshEditObserved(connection, frame) {
    if (!connection.initialized) return;
    const methods = NOTIFICATIONS_BY_VERSION[connection.protocolVersion] || [];
    if (!methods.includes('vscode/dshEditObserved')) return; // v3+ only
    if (!isValidDshEditObservedParams(frame.params)) return;
    if (typeof this.onDshEditObserved !== 'function') return;
    try {
      this.onDshEditObserved(frame.params);
    } catch {
      // observation sink failure must never disturb the bridge
    }
  }

  _initialize(connection, id, params) {
    if (!tokenMatches(params.token, this.token)) {
      this._writeError(connection.socket, id, -32002, 'VSCODE_AUTH_FAILED', 'VS Code bridge authentication failed');
      connection.socket.end();
      return;
    }
    const requestedProtocolVersion = params.protocolVersion;
    const acceptedProtocolVersion = Number.isInteger(requestedProtocolVersion)
      && this.protocolVersions.includes(requestedProtocolVersion)
      ? requestedProtocolVersion
      : null;
    if (acceptedProtocolVersion === null) {
      this._writeError(connection.socket, id, -32003, 'VSCODE_PROTOCOL_MISMATCH', `VS Code bridge requires protocol ${this.protocolVersions.join(' or ')}`);
      connection.socket.end();
      return;
    }
    if (!isRecord(params.clientInfo) || typeof params.clientInfo.name !== 'string' || typeof params.clientInfo.version !== 'string') {
      this._writeError(connection.socket, id, -32602, 'VSCODE_INVALID_PARAMS', 'VS Code bridge initialize requires clientInfo');
      return;
    }
    connection.initialized = true;
    connection.protocolVersion = acceptedProtocolVersion;
    const result = {
      protocolVersion: acceptedProtocolVersion,
      serverInfo: { name: 'dsh-vs-sidebar', version: this.serverVersion },
      workspace: this.workspace,
      methods: METHODS_BY_VERSION[acceptedProtocolVersion].filter((method) => typeof this.handlers[method] === 'function'),
      notifications: [...NOTIFICATIONS_BY_VERSION[acceptedProtocolVersion]],
      maxFrameBytes: this.maxFrameBytes,
    };
    if (acceptedProtocolVersion > 1) {
      result.acceptedProtocolVersion = acceptedProtocolVersion;
    }
    this._write(connection.socket, {
      jsonrpc: '2.0',
      id,
      result,
    });
    const waiters = [...this.initializedWaiters];
    this.initializedWaiters.clear();
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  _writeError(socket, id, rpcCode, bridgeCode, message) {
    this._write(socket, {
      jsonrpc: '2.0',
      id,
      error: { code: rpcCode, message, data: { code: bridgeCode } },
    });
  }

  _write(socket, frame) {
    if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`);
  }

  _release(connection) {
    if (!this.connections.delete(connection)) return;
    this.sockets.delete(connection.socket);
    for (const controller of connection.pending.values()) {
      controller.abort(bridgeError('VSCODE_REQUEST_CANCELLED', 'VS Code bridge connection closed'));
    }
    connection.pending.clear();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const waiters = [...this.initializedWaiters];
    this.initializedWaiters.clear();
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(bridgeError('VSCODE_REQUEST_CANCELLED', 'VS Code bridge closed'));
    }
    for (const socket of this.sockets) socket.destroy();
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
    this.port = null;
  }
}

module.exports = {
  DEFAULT_REQUEST_TIMEOUT_MS,
  METHODS_BY_VERSION,
  NOTIFICATION_METHODS,
  NOTIFICATIONS_BY_VERSION,
  PROTOCOL_VERSIONS,
  REQUEST_METHODS,
  V2_NOTIFICATION_SCHEMA,
  VSCODE_MAX_FRAME_BYTES,
  VSCODE_PROTOCOL_VERSION,
  VersionedBridgeServer,
  bridgeError,
  isValidDshEditObservedParams,
  tokenMatches,
};
