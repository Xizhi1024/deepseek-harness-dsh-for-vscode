import { isDeepStrictEqual } from 'node:util';

// ---------------------------------------------------------------------------
// VS Code-registered MCP servers, mounted into the RUNNING DSH tool runtime.
//
// The embed overlay used to insert one `@deepseek-ai/dsh-mcp-client` loader row
// per VS Code MCP server. Those rows are composed at boot, so a server another
// extension registered later (or a refreshed token) only reached DSH after the
// whole service restarted — the live complaint "other plugins' MCP servers are
// not connectable until DSH restarts".
//
// This module owns the runtime side of the fix: the extension ships the current
// `vscode.lm.mcpServerDefinitions` snapshot (boot: the integration row's
// `config.mcpServers`; later: POST /api/vscode/mcp) and the plugin mounts one
// mcp-client child per server with `ctx.plugin(...)`. Reconciliation is
// incremental — unchanged servers keep their connection, changed ones are
// disposed and re-mounted, removed ones are disposed — so no process restart
// is involved.
//
// Scope: the child plugins are mounted under the integration plugin, which is a
// root loader entry; their tools therefore land in the global ToolRuntime under
// the same `mcp__<serverName>__<tool>` names the boot rows used.
// ---------------------------------------------------------------------------

const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client';

/** Same contract as dsh-mcp-client's `serverName` schema. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_SERVERS = 64;
const MOUNT_TIMEOUT_MS = 15_000;

function isPlainRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStringRecord(value) {
  if (!isPlainRecord(value)) return false;
  return Object.values(value).every((entry) => typeof entry === 'string');
}

function withTimeout(promise, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP client mount timed out after ${ms}ms`)), ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Normalize one bridged server record (shape of `src/mcp/config.js`
 * `normalizeServer` in the extension) into a dsh-mcp-client config.
 *
 * @param {unknown} server - Raw record from the extension.
 * @param {number} index - Position, used only in the error message.
 * @returns {{name: string, config: object}|{error: string}}
 */
function normalizeServer(server, index) {
  if (!isPlainRecord(server)) return { error: `servers[${index}] must be an object` };
  const name = server.name;
  if (typeof name !== 'string' || !SERVER_NAME_PATTERN.test(name)) {
    return { error: `servers[${index}].name must match ${SERVER_NAME_PATTERN}` };
  }
  if (server.type === 'stdio') {
    if (typeof server.command !== 'string' || server.command.trim().length === 0) {
      return { error: `servers[${index}].command must be a non-empty string` };
    }
    const args = server.args === undefined ? [] : server.args;
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
      return { error: `servers[${index}].args must be an array of strings` };
    }
    const env = server.env === undefined ? {} : server.env;
    if (!isStringRecord(env)) {
      return { error: `servers[${index}].env must be an object of strings` };
    }
    const cwd = server.cwd === undefined ? '' : server.cwd;
    if (typeof cwd !== 'string') {
      return { error: `servers[${index}].cwd must be a string` };
    }
    return {
      name,
      config: {
        transport: 'stdio',
        serverName: name,
        command: server.command,
        args,
        env,
        cwd,
      },
    };
  }
  if (server.type === 'http') {
    if (typeof server.url !== 'string' || !/^https?:\/\//i.test(server.url)) {
      return { error: `servers[${index}].url must be an absolute HTTP(S) URL` };
    }
    const headers = server.headers === undefined ? {} : server.headers;
    if (!isStringRecord(headers)) {
      return { error: `servers[${index}].headers must be an object of strings` };
    }
    return {
      name,
      config: {
        transport: 'streamable-http',
        serverName: name,
        url: server.url,
        headers,
      },
    };
  }
  return { error: `servers[${index}].type must be "stdio" or "http"` };
}

/**
 * Validate and deduplicate a server batch.
 *
 * @param {unknown} servers - Array pushed by the extension.
 * @returns {{entries: Array<{name: string, config: object}>, rejected: Array<{server: string, error: string}>}}
 * @throws {TypeError} when the batch itself is malformed (route answers 400).
 */
function normalizeServers(servers) {
  if (!Array.isArray(servers)) throw new TypeError('mcpServers must be an array');
  if (servers.length > MAX_SERVERS) {
    throw new TypeError(`mcpServers exceeds the ${MAX_SERVERS} server limit`);
  }
  const entries = [];
  const rejected = [];
  const names = new Set();
  for (let index = 0; index < servers.length; index += 1) {
    const normalized = normalizeServer(servers[index], index);
    if (normalized.error) {
      rejected.push({ server: `servers[${index}]`, error: normalized.error });
      continue;
    }
    if (names.has(normalized.name)) {
      rejected.push({ server: normalized.name, error: `duplicate serverName "${normalized.name}"` });
      continue;
    }
    names.add(normalized.name);
    entries.push(normalized);
  }
  return { entries, rejected };
}

/** `serverName`s already owned by loader rows (the user's own profile config). */
function existingLoaderServerNames(loader) {
  const names = new Set();
  if (!loader || typeof loader.entries !== 'function') return names;
  for (const entry of loader.entries()) {
    if (!entry || !entry.options || entry.options.name !== MCP_CLIENT_PACKAGE) continue;
    const config = entry.options.config;
    if (config && typeof config.serverName === 'string') names.add(config.serverName);
  }
  return names;
}

/**
 * Mount/reconcile VS Code MCP servers on a running DSH plugin context.
 *
 * @param {object} deps
 * @param {object} deps.ctx - DSH plugin context (needs `plugin()` and `get()`).
 * @param {Function} [deps.log] - Diagnostic sink.
 * @param {number} [deps.mountTimeoutMs] - Per-server activation budget.
 * @param {string} [deps.packageName] - MCP client package specifier.
 * @returns {{apply: Function, dispose: Function, activeNames: string[]}}
 */
function createMcpBridge({
  ctx = null,
  log = () => {},
  mountTimeoutMs = MOUNT_TIMEOUT_MS,
  packageName = MCP_CLIENT_PACKAGE,
} = {}) {
  if (!ctx || typeof ctx.plugin !== 'function') {
    throw new TypeError('createMcpBridge requires a DSH ctx with plugin()');
  }

  const mounted = new Map(); // serverName -> { config, child }
  let modulePromise = null;
  let queue = Promise.resolve();
  let disposed = false;

  function loaderService() {
    if (typeof ctx.get === 'function') return ctx.get('loader');
    return ctx.loader;
  }

  function loadModule() {
    if (!modulePromise) {
      modulePromise = (async () => {
        const loader = loaderService();
        if (!loader || typeof loader.import !== 'function') {
          throw new Error('the DSH loader service is unavailable; cannot import ' + packageName);
        }
        return loader.import(packageName);
      })();
      modulePromise = modulePromise.catch((error) => {
        // Do not cache a transient resolution failure forever.
        modulePromise = null;
        throw error;
      });
    }
    return modulePromise;
  }

  async function disposeChild(child) {
    if (!child) return;
    const target = typeof child.dispose === 'function' ? child : child.fiber;
    if (!target || typeof target.dispose !== 'function') return;
    try {
      await target.dispose();
    } catch (error) {
      log(`mcp bridge: disposing a client failed: ${error && error.message ? error.message : String(error)}`);
    }
  }

  async function mount(entry) {
    const namespace = await loadModule();
    const child = ctx.plugin(namespace, entry.config);
    try {
      await withTimeout(Promise.resolve(child), mountTimeoutMs);
    } catch (error) {
      await disposeChild(child);
      throw error;
    }
    return { child };
  }

  async function reconcile(servers) {
    if (disposed) {
      return { mounted: [], removed: [], rejected: [], active: mounted.size, disposed: true };
    }
    const { entries, rejected } = normalizeServers(servers);
    const configured = existingLoaderServerNames(loaderService());
    const desired = new Map();
    for (const entry of entries) {
      if (configured.has(entry.name)) {
        rejected.push({
          server: entry.name,
          error: 'a DSH MCP server with this serverName is already configured; the configured entry wins',
        });
        continue;
      }
      desired.set(entry.name, entry);
    }

    const mountedNames = [];
    const removed = [];
    for (const [name, current] of [...mounted]) {
      const next = desired.get(name);
      if (next && isDeepStrictEqual(current.config, next.config)) continue;
      await disposeChild(current.child);
      mounted.delete(name);
      removed.push(name);
    }
    for (const [name, entry] of desired) {
      if (mounted.has(name)) continue;
      try {
        const mountedClient = await mount(entry);
        mounted.set(name, { config: entry.config, child: mountedClient.child });
        mountedNames.push(name);
      } catch (error) {
        rejected.push({
          server: name,
          error: error && error.message ? error.message : String(error),
        });
      }
    }
    if (mountedNames.length > 0 || removed.length > 0) {
      log(`mcp bridge: mounted [${mountedNames.join(', ')}], removed [${removed.join(', ')}] (${mounted.size} active)`);
    }
    return { mounted: mountedNames, removed, rejected, active: mounted.size };
  }

  return {
    apply(servers) {
      const run = queue.then(() => reconcile(servers));
      queue = run.catch(() => {});
      return run;
    },
    async dispose() {
      disposed = true;
      await queue.catch(() => {});
      for (const [name, current] of [...mounted]) {
        await disposeChild(current.child);
        mounted.delete(name);
      }
    },
    get activeNames() {
      return [...mounted.keys()];
    },
  };
}

export {
  MAX_SERVERS,
  MCP_CLIENT_PACKAGE,
  MOUNT_TIMEOUT_MS,
  SERVER_NAME_PATTERN,
  createMcpBridge,
  existingLoaderServerNames,
  normalizeServer,
  normalizeServers,
};