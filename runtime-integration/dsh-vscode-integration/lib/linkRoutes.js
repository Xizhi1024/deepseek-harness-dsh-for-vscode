import path from 'node:path';

// ---------------------------------------------------------------------------
// B3 (issue #6): DSH-side open-link route. The client plugin linkifies
// file:/// URLs and workspace-relative paths inside rendered replies; a click
// POSTs { path, line, col } to this same-origin WebRoute, which resolves the
// path against the DSH child's cwd (the VS Code workspace root) and opens it
// through channels that already exist:
//   - plain open  -> openThroughBridge (the textDocumentBridge mounted by the
//     extension's L1 editor-links feature; its env is only present when the
//     feature is on, so a disabled feature mounts no route at all), and
//   - :line/:col  -> the versioned v3 bridge's vscode/editor/open method
//     (workspace-gated, selection-aware) when a line was requested.
// Cross-origin abuse is blocked by requiring a custom request header: a
// cross-origin fetch with custom headers needs a CORS preflight this route
// never approves, so only same-origin page script can reach it.
// ---------------------------------------------------------------------------

const OPEN_ROUTE_PATH = '/api/vscode/open-link';
const LINKIFY_HEADER = 'x-dsh-vscode-linkify';
const MAX_OPEN_BODY_BYTES = 4096;
const MAX_PATH_LENGTH = 4096;
const MAX_POSITION = 10_000_000;

function writeJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
  });
  response.end(body);
}

// Never let a throw escape a WebRoute handler: escapes travel through the
// cordis context proxy and can escalate to a boot-level fatal (see lmRoute).
function respondWithError(response, status, code, error) {
  const message = error && error.message ? error.message : String(error);
  try {
    writeJson(response, status, { error: code, message });
  } catch {
    // response already closed or destroyed — nothing more to do
  }
}

async function readRequestBody(request, maxBytes = MAX_OPEN_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    request.on('data', (chunk) => {
      total += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), 'utf8');
      if (total > maxBytes) {
        reject(new Error('request body exceeds the 4 KiB limit'));
        return;
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
    });
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
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
 * Validate the click payload. The client already decoded file:/// URLs and
 * stripped :line:col suffixes, so the wire only carries a plain path plus
 * optional 1-based positions.
 *
 * @param {object} body - Parsed request body.
 * @returns {{path: string, line?: number, col?: number}|null}
 */
function parseOpenRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const rawPath = typeof body.path === 'string' ? body.path.trim() : '';
  if (rawPath.length === 0 || rawPath.length > MAX_PATH_LENGTH) return null;
  if (rawPath.includes('\u0000')) return null;
  if (rawPath.startsWith('file:')) return null; // file URLs are decoded client-side
  const optionalPosition = (value) => {
    if (value === undefined || value === null) return undefined;
    if (!Number.isInteger(value) || value < 1 || value > MAX_POSITION) return null;
    return value;
  };
  const line = optionalPosition(body.line);
  if (line === null) return null;
  const col = optionalPosition(body.col);
  if (col === null) return null;
  if (col !== undefined && line === undefined) return null;
  return { path: rawPath, line, col };
}

/**
 * Resolve a client path to an absolute path. Absolute paths pass through
 * (normalized); relative paths resolve against the supplied cwd — the DSH
 * child is spawned with the VS Code workspace root as its cwd, so this is the
 * workspace-relative form of issue #6. A relative path with no cwd is
 * rejected (null).
 *
 * @param {string} rawPath
 * @param {object} [options]
 * @param {string|null} [options.cwd]
 * @param {object} [options.pathMod] - node:path or a platform variant (tests).
 * @returns {string|null}
 */
function resolveAbsolutePath(rawPath, { cwd = null, pathMod = path } = {}) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return null;
  if (rawPath.includes('\u0000')) return null;
  if (pathMod.isAbsolute(rawPath)) return pathMod.resolve(rawPath);
  if (typeof cwd !== 'string' || cwd.length === 0) return null;
  return pathMod.resolve(cwd, rawPath);
}

/**
 * Build the wire range for vscode/editor/open: 1-based line/col in the reply
 * text become the 0-based Position the VS Code API expects. The selection is
 * empty (start === end): showTextDocument scrolls to and reveals the position
 * without painting an arbitrary highlight.
 *
 * @param {number} line - 1-based line.
 * @param {number} [col] - 1-based character.
 * @returns {{start: {line: number, character: number}, end: {line: number, character: number}}}
 */
function rangeFor(line, col = undefined) {
  const wireLine = Math.max(0, Math.floor(line) - 1);
  const character = col === undefined ? 0 : Math.max(0, Math.floor(col) - 1);
  return { start: { line: wireLine, character }, end: { line: wireLine, character } };
}

/**
 * Encode an absolute local path as a file URI the v3 bridge accepts.
 * Windows drive paths become file:///D:/... (':' percent-encoded per the
 * file URI spec; vscode.Uri.parse decodes it back).
 *
 * @param {string} absolutePath
 * @param {object} [pathMod]
 * @returns {string}
 */
function filePathToUri(absolutePath, pathMod = path) {
  const encoded = String(absolutePath)
    .split(pathMod.sep)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return pathMod.sep === '\\' ? 'file:///' + encoded : 'file://' + encoded;
}

/**
 * One-shot vscode/editor/open call over the versioned v3 loopback bridge.
 * Connects, authenticates with the spawn-env token, sends the method, and
 * destroys the socket. Used only when the click carried a line number.
 *
 * @param {object} deps
 * @param {object} deps.env - env source (DSH_VSCODE_BRIDGE_* keys).
 * @param {object} deps.net - node:net module (or a test seam).
 * @param {object} deps.params - vscode/editor/open params (document/range).
 * @param {number} [deps.timeoutMs]
 * @param {object} [deps.bridgeState] - precomputed bridgeEnv() result (tests).
 * @returns {Promise<object>} the method result.
 */
function editorOpenViaBridge({ env = process.env, net = null, params, timeoutMs = 5000, bridgeState = null } = {}) {
  if (!net) return Promise.reject(new Error('node:net module is required'));
  const state = bridgeState;
  const ok = state && state.ok === true
    && Number.isInteger(state.port) && state.port > 0
    && typeof state.token === 'string' && state.token.length > 0;
  if (!ok) return Promise.reject(new Error('VS Code versioned bridge is unavailable'));
  return new Promise((resolve, reject) => {
    const socket = net.connect(state.port, state.host || '127.0.0.1');
    let buffer = '';
    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { socket.destroy(); } catch { /* already gone */ }
      fn(value);
    };
    timer = setTimeout(() => finish(reject, new Error('VS Code editor open timed out')), timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    const send = (id, method, payload) => {
      socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: payload }) + '\n');
    };
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (line.length === 0) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (!message || message.jsonrpc !== '2.0' || message.id === undefined) continue;
        if (message.id === 1) {
          if (message.error) {
            finish(reject, new Error(message.error.message || 'bridge initialize failed'));
            return;
          }
          send(2, 'vscode/editor/open', params);
        } else if (message.id === 2) {
          if (message.error) finish(reject, new Error(message.error.message || 'editor open failed'));
          else finish(resolve, message.result === undefined ? { opened: true } : message.result);
        }
      }
    });
    socket.on('error', (error) => finish(reject, error));
    socket.on('close', () => finish(reject, new Error('VS Code bridge socket closed before the editor open finished')));
    send(1, 'initialize', {
      token: state.token,
      protocolVersion: 3,
      clientInfo: { name: 'dsh-vscode-integration', version: 'linkify' },
    });
  });
}

/**
 * Mount the open-link WebRoute.
 *
 * The route is mounted ONLY when the textDocumentBridge env is present: that
 * env is injected by the extension's L1 editor-links feature (default on), so
 * dsh.features.editor-links=false removes both the opener and this route —
 * linkified clicks then 404 instead of bypassing the gate.
 *
 * @param {object} deps
 * @param {object} deps.env - env source (DSH_VSCODE_OPEN_URL/TOKEN).
 * @param {object} deps.ctx - DSH plugin context ({ webServer }).
 * @param {string|null} [deps.cwd] - workspace root for relative paths.
 * @param {Function} deps.openImpl - absolute-path opener (openThroughBridge).
 * @param {Function} [deps.editorOpenImpl] - selection-aware opener (tests).
 * @param {object} [deps.pathMod] - node:path or platform variant (tests).
 * @returns {{running: boolean, reason?: string, routes: Array<{path: string}>, dispose: Function}}
 */
function createLinkRoutes({
  env = process.env,
  ctx = null,
  cwd = process.cwd(),
  openImpl = null,
  editorOpenImpl = undefined,
  pathMod = path,
} = {}) {
  if (!ctx || !ctx.webServer || typeof ctx.webServer.register !== 'function') {
    throw new TypeError('createLinkRoutes requires ctx.webServer.register');
  }
  if (typeof openImpl !== 'function') {
    throw new TypeError('createLinkRoutes requires an openImpl function');
  }
  const openUrl = env && typeof env.DSH_VSCODE_OPEN_URL === 'string' ? env.DSH_VSCODE_OPEN_URL : '';
  const openToken = env && typeof env.DSH_VSCODE_OPEN_TOKEN === 'string' ? env.DSH_VSCODE_OPEN_TOKEN : ''; // allow-secret-scan (env read; ternary default '' false-matches the literal pattern)
  if (openUrl.length === 0 || openToken.length === 0) {
    return {
      running: false,
      reason: 'editor-links-disabled',
      routes: [],
      dispose() {},
    };
  }
  const openWithSelection = editorOpenImpl === undefined ? null : editorOpenImpl;
  const disposers = [];

  function registerRoute(routePath, handler) {
    const disposer = ctx.webServer.register({ kind: 'exact', path: routePath, handler });
    if (typeof disposer === 'function') disposers.push(disposer);
    else if (disposer && typeof disposer.dispose === 'function') disposers.push(() => disposer.dispose());
  }

  registerRoute(OPEN_ROUTE_PATH, async (request, response) => {
    try {
      if (request.method !== 'POST') {
        writeJson(response, 405, { error: 'method-not-allowed' });
        return;
      }
      const headers = request.headers || {};
      const marker = String(headers[LINKIFY_HEADER] || headers['X-DSH-VSCode-Linkify'] || '');
      if (marker !== '1') {
        writeJson(response, 403, { error: 'forbidden', message: 'linkify header required' });
        return;
      }
      let body;
      try {
        body = await readRequestBody(request);
      } catch (error) {
        writeJson(response, 400, { error: 'bad-request', message: error && error.message ? error.message : String(error) });
        return;
      }
      const parsed = parseOpenRequest(body);
      if (!parsed) {
        writeJson(response, 400, {
          error: 'bad-request',
          message: 'path is required (string, max 4096 chars); line/col are positive integers',
        });
        return;
      }
      const absolute = resolveAbsolutePath(parsed.path, { cwd, pathMod });
      if (!absolute) {
        writeJson(response, 400, { error: 'bad-request', message: 'relative path requires a workspace cwd' });
        return;
      }
      if (parsed.line !== undefined && typeof openWithSelection === 'function') {
        try {
          await openWithSelection({
            params: {
              document: { uri: filePathToUri(absolute, pathMod) },
              range: rangeFor(parsed.line, parsed.col),
            },
          });
          writeJson(response, 200, { opened: true, selection: true });
          return;
        } catch {
          // Outside the workspace (or bridge down): fall through to the plain
          // textDocumentBridge open without a selection.
        }
      }
      await openImpl(absolute);
      writeJson(response, 200, { opened: true });
    } catch (error) {
      respondWithError(response, 500, 'open-failed', error);
    }
  });

  return {
    running: true,
    routes: [{ path: OPEN_ROUTE_PATH }],
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

export {
  LINKIFY_HEADER,
  MAX_OPEN_BODY_BYTES,
  OPEN_ROUTE_PATH,
  createLinkRoutes,
  editorOpenViaBridge,
  filePathToUri,
  parseOpenRequest,
  rangeFor,
  resolveAbsolutePath,
};
