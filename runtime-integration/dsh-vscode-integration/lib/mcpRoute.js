import {
  readBearerToken,
  readRequestBody,
  respondWithError,
  safeTokenEqual,
  writeJson,
} from './configureRoute.js';
import { normalizeServers } from './mcpBridge.js';

// ---------------------------------------------------------------------------
// POST /api/vscode/mcp — push one VS Code window's MCP server snapshot into a
// RUNNING DSH instance.
//
// Same authority as /api/vscode/configure (the per-window configure token in
// the spawn env / instance registry), but a separate route on purpose:
// instances spawned by an older extension build only know the configure route
// and reject unknown fields there, so multiplexing `mcpServers` into it would
// break FIM/LM reconfiguration on those instances. A missing route (404) is
// unambiguous: the integration plugin predates hot MCP mounting, and only a
// restart can pick the new plugin up.
//
// Shared instances (dsh.share.mode = "environment") serve several VS Code
// windows, each with its own workspace-scoped MCP definitions. The route keeps
// one source per `windowId` and reconciles the UNION, so a window without a
// workspace server (or with the feature disabled) cannot wipe another window's
// servers. The boot snapshot from the overlay is the baseline until the first
// enabled push replaces it; a `enabled:false` push only clears that window's
// source.
// ---------------------------------------------------------------------------

const MAX_MCP_BODY_BYTES = 256 * 1024;
const MAX_WINDOW_ID_LENGTH = 128;

function validWindowId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_WINDOW_ID_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function mergeSources(baseline, sources) {
  const byName = new Map();
  const lists = [];
  if (Array.isArray(baseline)) lists.push(baseline);
  for (const servers of sources.values()) lists.push(servers);
  for (const list of lists) {
    for (const server of list) {
      if (!server || typeof server.name !== 'string') continue;
      byName.set(server.name, server);
    }
  }
  return [...byName.values()];
}

/**
 * Mount POST /api/vscode/mcp.
 *
 * @param {object} deps
 * @param {object} deps.ctx - DSH plugin context ({ webServer }).
 * @param {string} [deps.token] - configure-token authority.
 * @param {object} deps.bridge - createMcpBridge result ({ apply }).
 * @param {object[]} [deps.initialServers] - boot snapshot from the overlay.
 * @param {string} [deps.initialWindowId] - window that produced the boot snapshot.
 * @param {Function} [deps.log] - optional logger.
 * @returns {{running: boolean, route: string, dispose: Function}}
 */
function createMcpRoute({
  ctx = null,
  token = '',
  bridge = null,
  initialServers = [],
  initialWindowId = null,
  log = () => {},
} = {}) {
  if (!ctx || !ctx.webServer || typeof ctx.webServer.register !== 'function') {
    throw new TypeError('createMcpRoute requires ctx.webServer.register');
  }
  if (!bridge || typeof bridge.apply !== 'function') {
    throw new TypeError('createMcpRoute requires an MCP bridge with apply()');
  }
  const configureToken = typeof token === 'string' ? token : '';
  const sources = new Map();
  let baseline = Array.isArray(initialServers) ? initialServers : [];
  let baselineWindowId = typeof initialWindowId === 'string' && initialWindowId.length > 0
    ? initialWindowId
    : null;
  const disposers = [];
  const disposer = ctx.webServer.register({
    kind: 'exact',
    path: '/api/vscode/mcp',
    handler: async (request, response) => {
      try {
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
          body = await readRequestBody(request, MAX_MCP_BODY_BYTES);
        } catch (error) {
          writeJson(response, 400, { error: 'bad-request', message: error && error.message ? error.message : String(error) });
          return;
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          writeJson(response, 400, { error: 'bad-request', message: 'body must be an object' });
          return;
        }
        for (const key of Object.keys(body)) {
          if (key !== 'servers' && key !== 'windowId' && key !== 'enabled') {
            throw new TypeError(`unknown mcp field: ${key}`);
          }
        }
        if (!Array.isArray(body.servers)) throw new TypeError('servers must be an array');
        const windowId = body.windowId === undefined ? 'default' : body.windowId;
        if (!validWindowId(windowId)) throw new TypeError('windowId must be a non-empty string (max 128 chars)');
        if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
          throw new TypeError('enabled must be a boolean');
        }
        // Validate names/transports before they join the union, so a malformed
        // record cannot shadow a healthy source under the same name.
        const validated = normalizeServers(body.servers);
        if (validated.rejected.length > 0) {
          throw new TypeError(`invalid MCP server: ${validated.rejected[0].error}`);
        }
        const enabled = body.enabled !== false;
        // The boot snapshot belongs to the window that wrote the overlay
        // (`config.windowId`). Its first push — enabled with a fresh list, or
        // disabled withdrawing it — replaces the baseline. Other windows only
        // add/remove their own source; an old overlay without an owner keeps
        // the legacy "first enabled push replaces it" behavior.
        if (baselineWindowId === null) {
          if (enabled) baseline = null;
        } else if (windowId === baselineWindowId) {
          baseline = null;
          baselineWindowId = null;
        }
        // A disabled window contributes nothing, even if it sent a list.
        sources.set(windowId, enabled ? body.servers : []);

        let result;
        try {
          result = await bridge.apply(mergeSources(baseline, sources));
        } catch (error) {
          if (error instanceof TypeError) throw error;
          respondWithError(response, 500, 'mcp-apply-failed', error);
          return;
        }
        try {
          log(`mcp applied: ${JSON.stringify({ ...result, sources: sources.size })}`);
        } catch {
          // logging must never break the response
        }
        writeJson(response, 200, { applied: { ...result, sources: sources.size } });
      } catch (error) {
        if (error instanceof TypeError) {
          try {
            writeJson(response, 400, { error: 'bad-request', message: error.message });
          } catch {
            // response already closed
          }
          return;
        }
        respondWithError(response, 500, 'mcp-route-failed', error);
      }
    },
  });
  if (typeof disposer === 'function') disposers.push(disposer);
  else if (disposer && typeof disposer.dispose === 'function') disposers.push(() => disposer.dispose());
  return {
    running: true,
    route: '/api/vscode/mcp',
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

export { MAX_MCP_BODY_BYTES, createMcpRoute, mergeSources };