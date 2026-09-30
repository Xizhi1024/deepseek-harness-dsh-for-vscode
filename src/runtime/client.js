"use strict";

const { validateRpcRequest, validateRpcResponse, validateSessionUpdate, validateCapabilityReport,
  validatePortError, createPortError, LIMITS } = require('../protocol/runtime');
const { assertLoopbackBaseUrl } = require('../sessionNavigation');
const { loopbackFetch } = require('../loopbackAuth');

const RESPONSE_MAX = LIMITS.responseBytes;
const FRAME_MAX = LIMITS.frameBytes;
const MUTATIONS = new Set(['workspace.ensure', 'session.create', 'session.rename', 'session.prompt', 'session.cancel']);

function createDshRuntimeClient({ endpoint, tokenProvider, expectedInstanceId, fetch: fetchImpl = globalThis.fetch,
  clock = { now: Date.now }, timers = { setTimeout, clearTimeout } }) {
  assertLoopbackBaseUrl(endpoint);
  if (typeof tokenProvider !== 'function' || !expectedInstanceId) throw createPortError('INVALID_ARGUMENT', 'Runtime credentials and identity are required');
  const base = new URL(endpoint).origin;
  const request = (url, init) => loopbackFetch(endpoint, url, init, fetchImpl);
  function lifetime(op, timeout) {
    const controller = new AbortController();
    let timer = null;
    let timedOut = false;
    const cancel = () => controller.abort(op.signal.reason);
    if (op.signal?.aborted) cancel();
    else op.signal?.addEventListener('abort', cancel, { once: true });
    function arm(ms) {
      if (timer !== null) timers.clearTimeout(timer);
      timer = timers.setTimeout(() => { timedOut = true; controller.abort(); }, ms);
    }
    arm(Math.min(timeout, op.timeoutMs > 0 ? op.timeoutMs : timeout));
    return { controller, arm, get timedOut() { return timedOut; }, clearDeadline() {
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
    }, dispose() {
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      op.signal?.removeEventListener('abort', cancel);
    } };
  }
  function failed(error, life, mutation, dispatched) {
    if (validatePortError(error)) return error;
    if (mutation && dispatched) return createPortError('OUTCOME_UNKNOWN', 'Runtime mutation outcome is unknown', { effect: 'unknown' });
    if (life.controller.signal.aborted) return createPortError(life.timedOut ? 'TIMEOUT' : 'CANCELLED', life.timedOut ? 'Runtime operation timed out' : 'Runtime operation cancelled', { retryable: life.timedOut });
    return createPortError('TRANSPORT_LOST', 'Runtime connection was lost', { retryable: true });
  }
  async function headers() {
    const token = await tokenProvider();
    if (typeof token !== 'string' || !token) throw createPortError('UNAUTHENTICATED', 'Runtime credential is unavailable');
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  }
  async function json(response) {
    if (!response.body?.getReader) throw createPortError('PROTOCOL_MISMATCH', 'Runtime response body is unavailable');
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > RESPONSE_MAX) throw createPortError('BACKPRESSURE', 'Runtime response exceeds its size limit');
        chunks.push(Buffer.from(chunk.value));
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw createPortError('PROTOCOL_MISMATCH', 'Runtime returned invalid JSON'); }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  async function rpc(method, params, op) {
    const envelope = { protocolVersion: 1, requestId: op.requestId, method, params };
    if (!validateRpcRequest(envelope)) throw createPortError('INVALID_ARGUMENT', 'Invalid runtime request');
    const body = JSON.stringify(envelope);
    if (Buffer.byteLength(body) > FRAME_MAX) throw createPortError('INVALID_ARGUMENT', 'Runtime request is too large');
    const life = lifetime(op, LIMITS.rpcTimeoutMs);
    let dispatched = false;
    try {
      const requestHeaders = await headers();
      life.controller.signal.throwIfAborted();
      dispatched = true;
      const response = await request(`${base}/api/vscode/v1/rpc`, {
        method: 'POST', headers: requestHeaders, body, signal: life.controller.signal, redirect: 'error',
      });
      const result = await json(response);
      if (!validateRpcResponse(result, { method, requestId: op.requestId })) {
        throw MUTATIONS.has(method)
          ? createPortError('OUTCOME_UNKNOWN', 'Runtime mutation returned an invalid response', { effect: 'unknown' })
          : createPortError('PROTOCOL_MISMATCH', 'Runtime returned an invalid response');
      }
      if (!result.ok) throw Object.assign(new Error(result.error.message), result.error);
      return result.value;
    } catch (error) { throw failed(error, life, MUTATIONS.has(method), dispatched); }
    finally { life.dispose(); }
  }
  async function capabilities(op) {
    const life = lifetime(op, LIMITS.capabilityTimeoutMs);
    try {
      const response = await request(`${base}/api/vscode/v1/capabilities`, {
        headers: await headers(), signal: life.controller.signal, redirect: 'error',
      });
      const result = await json(response);
      if (!response.ok || !validateCapabilityReport(result) || result.runtimeInstanceId !== expectedInstanceId) {
        throw createPortError('PROTOCOL_MISMATCH', 'Runtime capability identity does not match');
      }
      return Object.freeze(result);
    } catch (error) { throw failed(error, life, false, false); }
    finally { life.dispose(); }
  }
  async function openFeed(sessionId, op) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 512) throw createPortError('INVALID_ARGUMENT', 'Invalid session identity');
    const life = lifetime(op, LIMITS.rpcTimeoutMs);
    let reader;
    let closed = false;
    let lastAlive = clock.now();
    const decoder = new TextDecoder();
    let buffer = '';
    let acquired = false;
    async function close() {
      if (closed) return;
      closed = true;
      life.dispose();
      life.controller.abort();
      if (reader) await reader.cancel().catch(() => {});
    }
    async function* readUpdates() {
      try {
        while (!closed) {
          const chunk = await reader.read();
          if (chunk.done) throw createPortError('TRANSPORT_LOST', 'Session feed ended', { retryable: true });
          lastAlive = clock.now();
          // Bytes, including comment heartbeats, maintain stream liveness.
          if (acquired) life.arm(LIMITS.stallMs);
          buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, '\n');
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (Buffer.byteLength(frame) > FRAME_MAX) throw createPortError('BACKPRESSURE', 'Session frame exceeds its size limit');
            let event = '';
            const data = [];
            for (const line of frame.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim();
              if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
            }
            if (!data.length) continue;
            let value;
            try { value = JSON.parse(data.join('\n')); }
            catch { throw createPortError('PROTOCOL_MISMATCH', 'Invalid session frame JSON'); }
            if (event === 'error' && validatePortError(value)) throw Object.assign(new Error(value.message), value);
            if (event !== 'update' || !validateSessionUpdate(value) || value.runtimeInstanceId !== expectedInstanceId || value.sessionId !== sessionId) {
              throw createPortError('PROTOCOL_MISMATCH', 'Invalid session frame identity or payload');
            }
            yield value;
          }
          if (Buffer.byteLength(buffer) > FRAME_MAX) throw createPortError('BACKPRESSURE', 'Session frame exceeds its size limit');
        }
      } catch (error) {
        if (!closed) throw failed(error, life, false, false);
      } finally { await close(); }
    }
    try {
      const response = await request(`${base}/api/vscode/v1/events?sessionId=${encodeURIComponent(sessionId)}`, {
        headers: { ...await headers(), Accept: 'text/event-stream' }, signal: life.controller.signal, redirect: 'error',
      });
      if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream')) {
        const error = await json(response);
        if (validatePortError(error.error)) throw Object.assign(new Error(error.error.message), error.error);
        throw createPortError('PROTOCOL_MISMATCH', 'Runtime did not open a session stream');
      }
      reader = response.body.getReader();
      const iterator = readUpdates();
      const first = await iterator.next();
      if (first.done || first.value.kind !== 'snapshot' || first.value.deliverySeq !== 1) throw createPortError('PROTOCOL_MISMATCH', 'Session stream lacks an opening snapshot');
      acquired = true;
      life.clearDeadline();
      life.arm(Math.max(1, LIMITS.stallMs - (clock.now() - lastAlive)));
      let iterated = false;
      return Object.freeze({ close, events: { [Symbol.asyncIterator]() {
        if (iterated) throw createPortError('CONFLICT', 'Session feeds have one consumer');
        iterated = true;
        return (async function* () {
          try { yield first.value; yield* iterator; }
          finally { await close(); await iterator.return(); }
        })();
      } } });
    } catch (error) {
      const mapped = failed(error, life, false, false);
      await close();
      throw mapped;
    }
  }
  return Object.freeze({ capabilities, openFeed,
    listWorkspaces: (op) => rpc('workspace.list', {}, op),
    ensureWorkspace: (rootPath, op) => rpc('workspace.ensure', { rootPath }, op),
    listSessions: (workspaceId, op) => rpc('session.list', { workspaceId }, op),
    createSession: (workspaceId, op) => rpc('session.create', { workspaceId }, op),
    renameSession: (sessionId, title, op) => rpc('session.rename', { sessionId, title }, op),
    submitPrompt: (input, op) => rpc('session.prompt', input, op),
    cancelSession: (sessionId, op) => rpc('session.cancel', { sessionId }, op),
  });
}

module.exports = { createDshRuntimeClient };
