import { timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// POST /api/vscode/configure — the runtime reconfiguration channel for the
// plugin's bridge routes (2026-09-19, known-issue #1 fix).
//
// The extension pushes its live bridge feature config here (FIM tokens +
// upstream endpoint, LM bearer tokens, editor-links bridge endpoint) so a
// RUNNING dsh instance picks up feature changes without a restart — the
// spawn-env bootstrap (runtimeConfig.js) can never see a later toggle, and
// adopted/shared instances can never be re-spawned by the enabling window.
//
// Auth: Authorization: Bearer <DSH_VSCODE_CONFIGURE_TOKEN>, injected into the
// DSH spawn env by the extension. The extension records the same token in its
// instance registry next to the launch token, so an adopting window can push
// its own config to a shared instance it did not spawn. An empty token
// (instance spawned by an older extension build) mounts the route but always
// answers 401 — no caller can authenticate, which keeps the surface honest
// without regressing anything for old spawns.
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 64 * 1024;

function safeTokenEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    let diff = 0;
    for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
    return diff === 0;
  }
}

function readBearerToken(request) {
  const header = request && request.headers
    ? (request.headers.authorization || request.headers.Authorization || '')
    : '';
  const prefix = 'Bearer ';
  return header.startsWith(prefix) ? header.slice(prefix.length) : '';
}

function writeJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
  });
  response.end(body);
}

// Fault-contained error reply: a throw escaping a WebRoute handler can
// escalate to a boot-level fatal that kills the whole DSH process (see
// lmRoute.js).
function respondWithError(response, status, code, error) {
  const message = error && error.message ? error.message : String(error);
  try {
    writeJson(response, status, { error: code, message });
  } catch {
    // response already closed or destroyed
  }
}

function readRequestBody(request, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    request.on('data', (chunk) => {
      total += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), 'utf-8');
      if (total > maxBytes) {
        reject(new Error('request body exceeds the 64 KiB limit'));
        return;
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf-8'));
    });
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      try {
        resolve(body.length === 0 ? {} : JSON.parse(body));
      } catch {
        reject(new Error('request body must be valid JSON'));
      }
    });
    request.on('error', reject);
  });
}

/**
 * Mount POST /api/vscode/configure.
 *
 * @param {object} deps
 * @param {object} deps.ctx - DSH plugin context ({ webServer }).
 * @param {object} deps.config - runtimeConfig store (applyConfigure + configureToken).
 * @param {Function} [deps.log] - optional logger for applied patches.
 * @returns {{running: boolean, route: string, dispose: Function}}
 */
export function createConfigureRoute({ ctx = null, config = null, log = () => {} } = {}) {
  if (!ctx || !ctx.webServer || typeof ctx.webServer.register !== 'function') {
    throw new TypeError('createConfigureRoute requires ctx.webServer.register');
  }
  if (!config || typeof config.applyConfigure !== 'function') {
    throw new TypeError('createConfigureRoute requires a runtimeConfig store');
  }
  const configureToken = typeof config.configureToken === 'string' ? config.configureToken : '';
  const disposers = [];
  const disposer = ctx.webServer.register({
    kind: 'exact',
    path: '/api/vscode/configure',
    handler: async (request, response) => {
      try {
        // An empty configure token (instance spawned by an older extension)
        // can never authenticate: always 401, never apply.
        if (configureToken.length === 0 || !safeTokenEqual(readBearerToken(request), configureToken)) {
          writeJson(response, 401, { error: 'unauthorized', message: 'DSH configure token required' });
          return;
        }
        if (request.method !== 'POST') {
          writeJson(response, 405, { error: 'method-not-allowed' });
          return;
        }
        let body;
        try {
          body = await readRequestBody(request);
        } catch (error) {
          writeJson(response, 400, { error: 'bad-request', message: error && error.message ? error.message : String(error) });
          return;
        }
        let result;
        try {
          result = config.applyConfigure(body);
        } catch (error) {
          writeJson(response, 400, { error: 'bad-request', message: error && error.message ? error.message : String(error) });
          return;
        }
        try {
          log(`configure applied: ${JSON.stringify(result.applied)}`);
        } catch {
          // logging must never break the response
        }
        writeJson(response, 200, result);
      } catch (error) {
        respondWithError(response, 500, 'configure-failed', error);
      }
    },
  });
  if (typeof disposer === 'function') disposers.push(disposer);
  else if (disposer && typeof disposer.dispose === 'function') disposers.push(() => disposer.dispose());
  return {
    running: true,
    route: '/api/vscode/configure',
    dispose() {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // best-effort cleanup
        }
      }
      disposers.length = 0;
    },
  };
}

export { MAX_BODY_BYTES, readBearerToken, safeTokenEqual };
