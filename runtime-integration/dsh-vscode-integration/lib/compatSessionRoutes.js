import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Cross-version session REST bridge (0.9.0). Upstream 0.1.2-rc.1 removed the
// dsh-host-apiproxy REST surface (`POST /api/session.list|create|rename|
// prompt`, `GET /api/events.mux`) in favor of the Typert remote protocol;
// the VS Code extension's frozen wire client still speaks the REST envelope
// `{type:'client-request', rpcId, method, payload}` / `{result:{ok,value}}`.
// On runtimes that expose the sessionController service this module mounts
// the old routes on the web server and translates them to the new host
// methods. Old runtimes never reach here (the caller claims this surface via
// ctx.inject on sessionController, which only exists on the new line) —
// their native apiproxy routes keep serving.
//
// Fault containment rule (shared with lmRoute): a WebRoute handler must
// never let a throw escape — the cordis context proxy escalates it to a
// boot-level fatal that kills the whole DSH process.
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 1024 * 1024;

// The extension's SSE reader arms a 15s stall deadline that ONLY data frames
// reset (comments do not), so an idle stream still needs a periodic benign
// data frame. 8s keeps two missed intervals inside the deadline.
const KEEPALIVE_INTERVAL_MS = 8000;

const SESSION_COMMANDS = new Map([
  ['session.list', { service: 'controller', method: 'list' }],
  ['session.create', { service: 'commands', method: 'create' }],
  ['session.rename', { service: 'commands', method: 'rename' }],
  ['session.prompt', { service: 'commands', method: 'prompt' }],
]);

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body exceeds ' + MAX_BODY_BYTES + ' bytes'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function writeJson(response, status, payload) {
  if (response.writableEnded || response.destroyed) return;
  const body = JSON.stringify(payload);
  try {
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body, 'utf8'),
    });
    response.end(body);
  } catch {
    // response already closed — nothing more to do
  }
}

/**
 * Translate one host-method rejection into the old wire business-error
 * result. Host methods throw RemoteError-shaped values ({code, message});
 * anything else collapses to a generic internal error.
 */
export function remoteErrorToResult(error) {
  const message = error && error.message ? String(error.message) : String(error);
  const code = error && typeof error.code === 'string' && error.code.length > 0
    ? error.code
    : 'internal';
  return { ok: false, error: { code, message } };
}

/**
 * Fill the prompt request fields the extension never sends but the new host
 * method accepts or expects: a caller-owned requestId (echoed into the
 * user-message source) — clientTimeZone stays absent unless provided, which
 * the host treats as valid.
 */
export function normalizePromptPayload(payload) {
  return {
    ...payload,
    requestId: typeof payload.requestId === 'string' && payload.requestId.length > 0
      ? payload.requestId
      : randomUUID(),
  };
}

/**
 * Build one `data:` SSE line carrying the full ServerRequest envelope whose
 * payload is the mux frame — the exact shape the extension's frozen parser
 * accepts (`parseMuxFrame`: type 'server-request' + object payload).
 */
export function buildMuxDataLine(frame) {
  const full = { type: 'server-request', rpcId: randomUUID(), method: frame.type, payload: frame };
  return 'data: ' + JSON.stringify(full) + '\n\n';
}

function createSessionCommandHandler(sessionController) {
  return async (request, response) => {
    let envelope;
    try {
      envelope = JSON.parse(await readRequestBody(request));
    } catch {
      writeJson(response, 400, { error: 'invalid-json' });
      return;
    }
    const command = envelope && typeof envelope === 'object'
      ? SESSION_COMMANDS.get(envelope.method)
      : undefined;
    if (!command) {
      writeJson(response, 404, { error: 'unknown-method' });
      return;
    }
    let payload = envelope.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) payload = {};
    if (envelope.method === 'session.prompt') payload = normalizePromptPayload(payload);
    try {
      const target = command.service === 'commands'
        ? sessionController.commands
        : sessionController;
      const value = await target[command.method](payload);
      writeJson(response, 200, { result: { ok: true, value } });
    } catch (error) {
      writeJson(response, 200, { result: remoteErrorToResult(error) });
    }
  };
}

function createEventsMuxHandler(ctx, deps = {}) {
  const setIntervalFn = deps.setIntervalFn || setInterval;
  const clearIntervalFn = deps.clearIntervalFn || clearInterval;
  return (request, response) => {
    let closed = false;
    const disposeListener = ctx.on('session/event', (session, event) => {
      if (closed) return;
      const sessionId = session && typeof session.id === 'string' ? session.id : null;
      if (!sessionId) return;
      try {
        response.write(buildMuxDataLine({ type: 'session/event', sessionId, event }));
      } catch {
        close();
      }
    });
    let keepalive = null;
    const close = () => {
      if (closed) return;
      closed = true;
      if (keepalive !== null) clearIntervalFn(keepalive);
      try {
        if (typeof disposeListener === 'function') disposeListener();
        else ctx.off('session/event');
      } catch {
        // best-effort disposal
      }
    };
    response.on?.('close', close);
    request.on('close', close);
    try {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      // The extension treats the acquired reader as the ready signal; the
      // listener above was subscribed before headers were written, so no
      // live session/event can be missed from this point.
      response.write(': connected\n\n');
      keepalive = setIntervalFn(() => {
        if (closed) return;
        try {
          response.write(buildMuxDataLine({ type: 'keepalive' }));
        } catch {
          close();
        }
      }, KEEPALIVE_INTERVAL_MS);
      if (keepalive && typeof keepalive.unref === 'function') keepalive.unref();
    } catch {
      close();
    }
  };
}

/**
 * Mount the old REST session surface on the new runtime's web server.
 * @param {object} ctx plugin scope exposing `sessionController` and
 *   `webServer.register({kind:'exact', path, handler})`.
 * @returns {{dispose: Function, routes: string[]}}
 */
export function installCompatSessionRoutes(ctx, deps = {}) {
  if (!ctx || !ctx.sessionController || !ctx.webServer || typeof ctx.webServer.register !== 'function') {
    throw new TypeError('installCompatSessionRoutes requires ctx.sessionController and ctx.webServer.register');
  }
  const disposers = [];
  const mount = (path, handler) => {
    disposers.push(ctx.webServer.register({ kind: 'exact', path, handler }));
  };
  mount('/api/session.list', createSessionCommandHandler(ctx.sessionController));
  mount('/api/session.create', createSessionCommandHandler(ctx.sessionController));
  mount('/api/session.rename', createSessionCommandHandler(ctx.sessionController));
  mount('/api/session.prompt', createSessionCommandHandler(ctx.sessionController));
  mount('/api/events.mux', createEventsMuxHandler(ctx, deps));
  return {
    routes: ['/api/session.list', '/api/session.create', '/api/session.rename', '/api/session.prompt', '/api/events.mux'],
    dispose() {
      for (const dispose of disposers) {
        try {
          if (typeof dispose === 'function') dispose();
        } catch {
          // best-effort unmount
        }
      }
    },
  };
}