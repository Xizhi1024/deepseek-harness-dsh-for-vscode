import { timingSafeEqual, randomUUID } from 'node:crypto';
import contract from '../contracts/validate.cjs';

const { validateRpcRequest, validateRpcResponse, validateSessionUpdate, validateCapabilityReport,
  validatePortError, createPortError, LIMITS } = contract;
const MAX_BODY = LIMITS.bodyBytes;
const MAX_RESPONSE = LIMITS.responseBytes;
const MUTATIONS = new Set(['workspace.ensure', 'session.create', 'session.rename', 'session.prompt', 'session.cancel']);
const STATUS = { INVALID_ARGUMENT: 400, UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404,
  CONFLICT: 409, BACKPRESSURE: 429, NOT_READY: 503, TIMEOUT: 504, CAPABILITY_UNAVAILABLE: 503 };

function safeError(error, mutation = false) {
  if (validatePortError(error)) return { code: error.code, message: error.message, retryable: error.retryable, effect: error.effect };
  const code = error?.code;
  if (typeof code === 'string' && /not-found$/.test(code)) return safeError(createPortError('NOT_FOUND', 'The runtime entity was not found'));
  if (code === 'gateway/bad-request') return safeError(createPortError('INVALID_ARGUMENT', 'The runtime rejected the request'));
  if (code === 'gateway/cancelled') return safeError(createPortError('CANCELLED', 'The runtime request was cancelled', { effect: mutation ? 'unknown' : 'none' }));
  return safeError(createPortError(mutation ? 'OUTCOME_UNKNOWN' : 'INTERNAL', mutation ? 'The runtime mutation outcome is unknown' : 'The runtime operation failed', { effect: mutation ? 'unknown' : 'none' }));
}

function json(response, status, value) {
  if (response.destroyed || response.writableEnded) return;
  let body = JSON.stringify(value);
  if (Buffer.byteLength(body) > MAX_RESPONSE) {
    status = 413;
    body = JSON.stringify({ protocolVersion: 1, requestId: null, ok: false, error: safeError(createPortError('BACKPRESSURE', 'Runtime response exceeds its limit')) });
  }
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  response.end(body);
}

function readBody(request, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => { request.off('data', data); request.off('end', end); request.off('error', error); signal.removeEventListener('abort', abort); };
    const error = (cause) => { cleanup(); reject(cause); };
    const abort = () => error(createPortError('TIMEOUT', 'Runtime request timed out'));
    const data = (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { error(createPortError('INVALID_ARGUMENT', 'Runtime request exceeds its limit')); request.resume(); return; }
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(createPortError('INVALID_ARGUMENT', 'Invalid runtime request JSON')); }
    };
    request.on('data', data); request.on('end', end); request.on('error', error);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Plugin-owned authenticated routes. Every async handler contains its own failures. */
export function installRuntimeFacade({ ctx, adapter, token, runtimeInstanceId,
  timers = { setTimeout, clearTimeout, setInterval, clearInterval } }) {
  if (typeof token !== 'string' || token.length < 32 || !runtimeInstanceId) throw createPortError('UNAUTHENTICATED', 'Facade credentials are missing');
  const tokenBytes = Buffer.from(token);
  const active = new Set();
  const disposers = [];
  let disposed = false;
  function authorize(request) {
    if (request.headers.origin !== undefined) throw createPortError('FORBIDDEN', 'Browser requests are not permitted');
    const header = request.headers.authorization;
    const candidate = Buffer.from(typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '');
    if (candidate.length !== tokenBytes.length || !timingSafeEqual(candidate, tokenBytes)) throw createPortError('UNAUTHENTICATED', 'Runtime authentication failed');
    if (disposed) throw createPortError('NOT_READY', 'Runtime facade is stopping');
  }
  function mount(route, verb, handler) {
    disposers.push(ctx.webServer.register({ kind: 'exact', path: route, handler: async (request, response) => {
      try {
        authorize(request);
        if (request.method !== verb) throw createPortError('INVALID_ARGUMENT', 'Unsupported runtime HTTP method');
        await handler(request, response);
      } catch (error) {
        const normalized = safeError(error);
        try { json(response, STATUS[normalized.code] || 500, { protocolVersion: 1, requestId: null, ok: false, error: normalized }); } catch { response.destroy(); }
      }
    } }));
  }
  function lifetime(response, ms) {
    const controller = new AbortController();
    let timer = timers.setTimeout(() => controller.abort(), ms);
    const abort = () => controller.abort();
    response.on('close', abort);
    active.add(abort);
    return { controller, signal: controller.signal, ready() { timers.clearTimeout(timer); timer = null; }, dispose() {
      if (timer !== null) timers.clearTimeout(timer);
      response.off('close', abort);
      active.delete(abort);
      controller.abort();
    } };
  }
  function bounded(task, life, mutation, releaseLate) {
    return new Promise((resolve, reject) => {
      let cancelled = false;
      const abort = () => { cancelled = true; reject(createPortError(mutation ? 'OUTCOME_UNKNOWN' : 'TIMEOUT', mutation ? 'Runtime mutation outcome is unknown' : 'Runtime request timed out', { effect: mutation ? 'unknown' : 'none' })); };
      life.signal.addEventListener('abort', abort, { once: true });
      if (life.signal.aborted) abort();
      Promise.resolve(task).then((value) => {
        if (cancelled && releaseLate) Promise.resolve(releaseLate(value)).catch(() => {});
        else resolve(value);
      }, reject).finally(() => life.signal.removeEventListener('abort', abort));
    });
  }
  mount('/api/vscode/v1/capabilities', 'GET', async (_request, response) => {
    const life = lifetime(response, LIMITS.capabilityTimeoutMs);
    try {
      const report = await bounded(adapter.capabilities({ requestId: randomUUID(), signal: life.signal }), life, false);
      if (!validateCapabilityReport(report) || report.runtimeInstanceId !== runtimeInstanceId) throw createPortError('PROTOCOL_MISMATCH', 'Invalid runtime capability report');
      json(response, 200, report);
    } finally { life.dispose(); }
  });
  mount('/api/vscode/v1/rpc', 'POST', async (request, response) => {
    const life = lifetime(response, LIMITS.rpcTimeoutMs);
    let requestId = null;
    let mutation = false;
    try {
      const envelope = await readBody(request, life.signal);
      if (!validateRpcRequest(envelope)) throw createPortError('INVALID_ARGUMENT', 'Invalid runtime RPC envelope');
      requestId = envelope.requestId;
      const op = { requestId, signal: life.signal };
      const p = envelope.params;
      const methods = {
        'workspace.list': () => adapter.listWorkspaces(op),
        'workspace.ensure': () => adapter.ensureWorkspace(p.rootPath, op),
        'session.list': () => adapter.listSessions(p.workspaceId, op),
        'session.create': () => adapter.createSession(p.workspaceId, op),
        'session.rename': () => adapter.renameSession(p.sessionId, p.title, op),
        'session.prompt': () => adapter.submitPrompt(p, op),
        'session.cancel': () => adapter.cancelSession(p.sessionId, op),
      };
      mutation = MUTATIONS.has(envelope.method);
      const value = await bounded(methods[envelope.method](), life, mutation);
      const result = { protocolVersion: 1, requestId, ok: true, value: value === undefined ? null : value };
      if (!validateRpcResponse(result, { method: envelope.method, requestId })) throw createPortError(mutation ? 'OUTCOME_UNKNOWN' : 'PROTOCOL_MISMATCH', 'Runtime result does not satisfy the contract', { effect: mutation ? 'unknown' : 'none' });
      json(response, 200, result);
    } catch (error) {
      const normalized = safeError(error, mutation);
      json(response, STATUS[normalized.code] || 500, { protocolVersion: 1, requestId, ok: false, error: normalized });
    } finally { life.dispose(); }
  });
  mount('/api/vscode/v1/events', 'GET', async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const values = [...url.searchParams.keys()];
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId || sessionId.length > 512 || values.length !== 1 || values[0] !== 'sessionId') throw createPortError('INVALID_ARGUMENT', 'A single sessionId is required');
    const life = lifetime(response, LIMITS.rpcTimeoutMs);
    let feed;
    let heartbeat = null;
    let opened = false;
    let queuedFrames = 0;
    const drained = () => { queuedFrames = 0; };
    const write = (frame) => {
      if (life.signal.aborted || response.destroyed) throw createPortError('CANCELLED', 'Session stream closed');
      if (Buffer.byteLength(frame) > LIMITS.frameBytes || response.writableLength + Buffer.byteLength(frame) > LIMITS.feedBytes || queuedFrames >= LIMITS.feedFrames) {
        throw createPortError('BACKPRESSURE', 'Session stream queue exceeded its limit');
      }
      if (!response.write(frame)) queuedFrames++;
    };
    response.on('drain', drained);
    try {
      feed = await bounded(adapter.openFeed(sessionId, { requestId: randomUUID(), signal: life.signal }), life, false, (late) => late.close());
      const iterator = feed.events[Symbol.asyncIterator]();
      const first = await bounded(iterator.next(), life, false);
      if (first.done || first.value.kind !== 'snapshot' || !validateSessionUpdate(first.value)) throw createPortError('PROTOCOL_MISMATCH', 'Session opening snapshot is invalid');
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      opened = true;
      write(`event: update\ndata: ${JSON.stringify(first.value)}\n\n`);
      life.ready();
      heartbeat = timers.setInterval(() => {
        try { write(': heartbeat\n\n'); } catch { life.controller.abort(); response.destroy(); }
      }, LIMITS.heartbeatMs);
      heartbeat?.unref?.();
      while (!life.signal.aborted) {
        const next = await iterator.next();
        if (next.done) break;
        if (!validateSessionUpdate(next.value)) throw createPortError('PROTOCOL_MISMATCH', 'Invalid normalized session event');
        write(`event: update\ndata: ${JSON.stringify(next.value)}\n\n`);
      }
    } catch (error) {
      if (!opened) throw error;
      if (!response.destroyed && !life.signal.aborted) {
        try { response.write(`event: error\ndata: ${JSON.stringify(safeError(error))}\n\n`); } catch { /* disconnected */ }
      }
    } finally {
      if (heartbeat !== null) timers.clearInterval(heartbeat);
      response.off('drain', drained);
      life.dispose();
      try { await feed?.close(); } catch { /* release all paths */ }
      if (opened && !response.destroyed) response.end();
    }
  });
  return Object.freeze({ dispose() {
    if (disposed) return;
    disposed = true;
    for (const abort of active) abort();
    for (const dispose of disposers) dispose();
  }, get activeRequests() { return active.size; } });
}
