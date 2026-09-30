'use strict';

const { validateSessionMessage, validateVisibleTarget, createPortError } = require('../protocol/runtime');

/** Extension-host implementation of the browser port; the shell owns the origin-checked handshake. */
function createBrowserSessionProxy({ surfaceIdentity, postMessage, subscribeMessages, clock = Date, timers = globalThis }) {
  const identity = Object.freeze({ surfaceId: surfaceIdentity.surfaceId, surfaceEpoch: surfaceIdentity.surfaceEpoch });
  let target = Object.freeze({ ...identity, selectionGeneration: 0, state: 'unknown', reason: 'Browser handshake is pending' });
  let ready = false;
  let handshakeFailed = false;
  let disposed = false;
  let sequence = 0;
  const listeners = new Set();
  const requests = new Map();
  const envelope = (type) => ({ channel: 'dsh-vscode-session', version: 1, ...identity, type });
  const matches = (value) => value && value.surfaceId === identity.surfaceId && value.surfaceEpoch === identity.surfaceEpoch;
  const fail = (code, message, effect = 'none') => createPortError(code, message, { effect });

  function publish(next) {
    target = Object.freeze({ ...next });
    for (const listener of [...listeners]) {
      try { listener(target); } catch { listeners.delete(listener); }
    }
  }
  function cancelRemote(requestId) {
    if (!ready || disposed) return;
    try {
      Promise.resolve(postMessage({ ...envelope('request'), requestId: `cancel_${(++sequence).toString(36)}`,
        method: 'request.cancel', params: { targetRequestId: requestId } })).catch(() => {});
    } catch { /* cancellation is best effort; the receiver also owns deadlines */ }
  }
  function finish(entry, error, value) {
    if (requests.get(entry.message.requestId) !== entry) return;
    requests.delete(entry.message.requestId);
    timers.clearTimeout(entry.timer);
    if (entry.signal) entry.signal.removeEventListener('abort', entry.abort);
    if (error) entry.reject(error); else entry.resolve(value);
  }
  function send(entry) {
    if (!ready || entry.sent || disposed) return;
    entry.sent = true;
    try {
      Promise.resolve(postMessage(entry.message)).then((accepted) => {
        if (accepted === false) finish(entry, fail('TRANSPORT_LOST', 'Browser message was not accepted'));
      }, () => finish(entry, fail('TRANSPORT_LOST', 'Browser message delivery failed', entry.mutating ? 'unknown' : 'none')));
    } catch { finish(entry, fail('TRANSPORT_LOST', 'Browser message delivery failed', entry.mutating ? 'unknown' : 'none')); }
  }
  const handshakeTimer = timers.setTimeout(() => {
    if (ready || disposed) return;
    handshakeFailed = true;
    publish({ ...identity, selectionGeneration: 0, state: 'unknown', reason: 'Browser handshake timed out' });
    for (const entry of [...requests.values()]) finish(entry, fail('NOT_READY', 'Browser handshake timed out'));
  }, 5000);

  const unsubscribe = subscribeMessages((message) => {
    if (disposed || !matches(message) || message.channel !== 'dsh-vscode-session') return;
    if (message.type === 'result') {
      const entry = requests.get(message.requestId);
      if (!entry || !ready) return;
      if (!validateSessionMessage(message, { method: entry.message.method })) {
        finish(entry, fail('PROTOCOL_MISMATCH', 'Invalid browser response', entry.sent && entry.mutating ? 'unknown' : 'none'));
        return;
      }
      if (message.ok) finish(entry, null, message.value);
      else finish(entry, createPortError(message.error.code, message.error.message, message.error));
      return;
    }
    if (!validateSessionMessage(message)) return;
    if (message.type === 'hello-ack') {
      if (handshakeFailed) return;
      if (message.runtimeVersion !== '0.2.0-rc.1' || message.adapterId !== 'dsh-0.2.0-rc.1') return;
      ready = true;
      timers.clearTimeout(handshakeTimer);
      for (const entry of requests.values()) send(entry);
      return;
    }
    if (message.type === 'targetChanged' && ready && matches(message.target) && validateVisibleTarget(message.target)
      && message.target.selectionGeneration >= target.selectionGeneration) {
      const next = message.target;
      if (next.selectionGeneration === target.selectionGeneration && target.state !== 'unknown'
        && (next.state !== target.state || next.sessionId !== target.sessionId)) return;
      publish(next);
    }
  });

  function request(method, params, op = {}) {
    if (disposed) return Promise.reject(fail('NOT_READY', 'Browser surface is disposed'));
    if (handshakeFailed) return Promise.reject(fail('NOT_READY', 'Browser handshake timed out'));
    if (op.signal && op.signal.aborted) return Promise.reject(fail('CANCELLED', 'Operation cancelled'));
    const message = { ...envelope('request'), requestId: op.requestId || `browser_${(++sequence).toString(36)}`, method, params };
    if (!validateSessionMessage(message)) return Promise.reject(fail('INVALID_ARGUMENT', 'Invalid browser operation'));
    const existing = requests.get(message.requestId);
    if (existing) return JSON.stringify(existing.message) === JSON.stringify(message)
      ? existing.promise : Promise.reject(fail('CONFLICT', 'Request identity was reused'));
    if (requests.size >= 256) return Promise.reject(fail('BACKPRESSURE', 'Browser request capacity is full'));
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const entry = { message, promise, resolve, reject, signal: op.signal, timer: undefined, sent: false,
      mutating: method === 'insertion.commit' || method === 'session.navigate', abort: undefined, startedAt: clock.now() };
    const stop = (code, detail) => {
      cancelRemote(message.requestId);
      const unknown = entry.sent && entry.mutating;
      finish(entry, fail(unknown ? 'OUTCOME_UNKNOWN' : code, detail, unknown ? 'unknown' : 'none'));
    };
    entry.abort = () => stop('CANCELLED', 'Browser operation wait cancelled');
    entry.timer = timers.setTimeout(() => stop('TIMEOUT', 'Browser operation timed out'), Math.max(1, Math.min(30000, Number(op.timeoutMs) || 30000)));
    requests.set(message.requestId, entry);
    if (op.signal) op.signal.addEventListener('abort', entry.abort, { once: true });
    send(entry);
    return promise;
  }

  return Object.freeze({
    getTarget: () => target,
    observeTarget(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    navigate: (sessionId, op) => request('session.navigate', { sessionId }, op),
    captureInsertion: (expected, op) => request('insertion.capture', { expected }, op),
    commitInsertion: (ticketId, text, op) => request('insertion.commit', { ticketId, text }, op),
    cancelInsertion(ticketId) { void request('insertion.cancel', { ticketId }).catch(() => {}); },
    dispose() {
      if (disposed) return;
      for (const entry of [...requests.values()]) {
        cancelRemote(entry.message.requestId);
        finish(entry, fail(entry.sent && entry.mutating ? 'OUTCOME_UNKNOWN' : 'CANCELLED', 'Browser surface was disposed', entry.sent && entry.mutating ? 'unknown' : 'none'));
      }
      disposed = true;
      timers.clearTimeout(handshakeTimer);
      unsubscribe(); listeners.clear();
    },
    getDiagnostics: () => Object.freeze({ pendingRequests: requests.size, ready, disposed }),
  });
}

module.exports = { createBrowserSessionProxy };
