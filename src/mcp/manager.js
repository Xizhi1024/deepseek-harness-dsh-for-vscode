'use strict';

const { mergeMcpSources, expandServer } = require('./config');
const { createStdioMcpClient } = require('./transportStdio');
const { createHttpMcpClient } = require('./transportHttp');

const MAX_RESULT_BYTES = 1 * 1024 * 1024;
const INPUT_TIMEOUT_MS = 120000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), ms);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }),
  ]);
}

/**
 * MCP consume aggregator (L0-safe: no UI registration, no spawn until the
 * first listTools/callTool). The bridge handlers and L2 commands share this
 * one instance.
 *
 * @param {object} options
 * @param {object} options.vscode - VS Code facade.
 * @param {object} [options.env] - process.env-like object.
 * @param {Function} options.getSources - async () => Array<{source, servers}>.
 * @param {object} options.consentGate - createConsentGate result.
 * @param {Function} options.spawn - child_process.spawn seam.
 * @param {Function} [options.fetchImpl] - fetch seam.
 * @param {Function} [options.logger]
 */
/**
 * C3: key names that look like credentials are prompted with password
 * masking. Checked case-insensitively against the usual substrings.
 */
function isSecretKeyName(key) {
  return typeof key === 'string' && /KEY|TOKEN|SECRET|PASSWORD/i.test(key);
}

function createMcpManager({
  vscode,
  env = process.env,
  getSources,
  consentGate,
  spawn,
  fetchImpl = null,
  logger = () => {},
  secretStorage = null,
} = {}) {
  if (!vscode || !vscode.window || typeof vscode.window.showInputBox !== 'function') {
    throw new TypeError('createMcpManager requires vscode.window.showInputBox');
  }
  if (typeof getSources !== 'function') throw new TypeError('createMcpManager requires getSources');
  if (!consentGate || typeof consentGate.ensureConsent !== 'function') {
    throw new TypeError('createMcpManager requires a consent gate');
  }
  if (typeof spawn !== 'function') throw new TypeError('createMcpManager requires a spawn function');

  const clients = new Map();
  const inputCaches = new Map();
  const toolCounts = new Map();
  let lastServers = [];
  let disposed = false;

  function cacheFor(serverName) {
    if (!inputCaches.has(serverName)) inputCaches.set(serverName, new Map());
    return inputCaches.get(serverName);
  }

  // C3 zero-typing: env keys are looked up in the VS Code secretStorage first
  // (same-name key, e.g. OPENAI_API_KEY) so a value entered once — here or by
  // another extension — never has to be retyped. Secret-looking key names are
  // prompted with password masking; every successful prompt is stored back.
  async function askInput(serverName, key) {
    if (secretStorage && typeof secretStorage.get === 'function') {
      try {
        const stored = await secretStorage.get(key);
        if (typeof stored === 'string' && stored.length > 0) return stored;
      } catch {
        // best-effort: a broken secret store degrades to the normal prompt
      }
    }
    const value = await withTimeout(
      vscode.window.showInputBox({
        prompt: `MCP server ${serverName} needs ${key}`,
        password: isSecretKeyName(key),
      }),
      INPUT_TIMEOUT_MS,
    );
    if (typeof value === 'string' && value.length > 0) {
      if (secretStorage && typeof secretStorage.set === 'function') {
        try {
          await secretStorage.set(key, value);
        } catch {
          // best-effort persistence only
        }
      }
      return value;
    }
    return undefined;
  }

  async function loadServers() {
    const sources = await getSources();
    const { servers, diagnostics } = mergeMcpSources(sources);
    for (const diagnostic of diagnostics) logger(`[mcp] ${diagnostic.source}: ${diagnostic.message}`);
    const expanded = [];
    for (const server of servers) {
      try {
        const result = await expandServer(server, {
          env,
          inputCache: cacheFor(server.name),
          askInput: (key) => askInput(server.name, key),
        });
        if (result.disabled) {
          expanded.push({ name: server.name, type: server.type, state: 'disabled', reason: result.reason });
        } else {
          const consented = consentGate.isConsented(server.name);
          expanded.push({
            ...result.server,
            state: consented ? 'ready' : 'consent-required',
            toolCount: toolCounts.has(server.name) ? toolCounts.get(server.name) : undefined,
          });
        }
      } catch (error) {
        expanded.push({
          name: server.name,
          type: server.type,
          state: 'error',
          reason: error && error.message ? error.message : String(error),
        });
      }
    }
    lastServers = expanded;
    return expanded;
  }

  function serverByName(name) {
    return lastServers.find((server) => server.name === name) || null;
  }

  async function ensureClient(server) {
    const existing = clients.get(server.name);
    if (existing) return existing;
    const client = server.type === 'stdio'
      ? createStdioMcpClient({ server, spawn, env, logger })
      : createHttpMcpClient({ server, fetchImpl });
    await client.start();
    clients.set(server.name, client);
    return client;
  }

  async function listServers() {
    if (disposed) return { servers: [] };
    const servers = await loadServers();
    return {
      servers: servers.map((server) => ({
        name: server.name,
        type: server.type,
        state: server.state,
        reason: server.reason,
        toolCount: server.toolCount,
      })),
    };
  }

  async function listTools(serverName) {
    if (disposed) return { server: serverName, tools: [], state: 'error', error: 'MCP manager disposed' };
    if (typeof serverName !== 'string' || serverName.length === 0) {
      return { server: serverName, tools: [], state: 'error', error: 'server name is required' };
    }
    await loadServers();
    const server = serverByName(serverName);
    if (!server) return { server: serverName, tools: [], state: 'error', error: 'MCP server not found' };
    if (server.state === 'disabled' || server.state === 'error') {
      return { server: serverName, tools: [], state: server.state, error: server.reason };
    }
    const consented = await consentGate.ensureConsent(serverName, { toolCount: toolCounts.get(serverName) || 0 });
    if (!consented) return { server: serverName, tools: [], state: 'consent-required', error: 'user did not consent' };
    try {
      const client = await ensureClient(server);
      const tools = [];
      let cursor;
      do {
        const page = await client.request('tools/list', cursor ? { cursor } : {}, { timeoutMs: 15000 });
        if (Array.isArray(page && page.tools)) tools.push(...page.tools);
        cursor = page && page.nextCursor;
      } while (cursor);
      toolCounts.set(serverName, tools.length);
      return { server: serverName, tools };
    } catch (error) {
      clients.get(serverName)?.dispose?.();
      clients.delete(serverName);
      return { server: serverName, tools: [], state: 'error', error: error && error.message ? error.message : String(error) };
    }
  }

  async function callTool(serverName, toolName, argumentsValue = {}) {
    if (disposed) throw new Error('MCP manager disposed');
    await loadServers();
    const server = serverByName(serverName);
    if (!server) throw new Error('MCP server not found: ' + serverName);
    if (server.state === 'disabled') throw new Error(server.reason || 'MCP server is disabled');
    const consented = await consentGate.ensureConsent(serverName, { toolCount: toolCounts.get(serverName) || 0 });
    if (!consented) {
      const error = new Error('User did not consent to MCP server ' + serverName);
      error.code = 'MCP_CONSENT_REQUIRED';
      throw error;
    }
    const client = await ensureClient(server);
    const raw = await client.request('tools/call', {
      name: toolName,
      arguments: argumentsValue && typeof argumentsValue === 'object' ? argumentsValue : {},
    }, { timeoutMs: 60000 });
    const payload = raw && typeof raw === 'object' ? raw : { content: [{ type: 'text', text: String(raw) }] };
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_RESULT_BYTES) {
      const truncated = serialized.slice(0, MAX_RESULT_BYTES);
      return { content: [{ type: 'text', text: truncated }], truncated: true, isError: Boolean(payload.isError) };
    }
    return payload;
  }

  function refresh() {
    for (const client of clients.values()) {
      try {
        client.dispose();
      } catch {
        // best-effort
      }
    }
    clients.clear();
    inputCaches.clear();
    toolCounts.clear();
    lastServers = [];
  }

  function dispose() {
    disposed = true;
    refresh();
  }

  return Object.freeze({
    callTool,
    dispose,
    listServers,
    listTools,
    refresh,
  });
}

module.exports = {
  MAX_RESULT_BYTES,
  createMcpManager,
  isSecretKeyName,
};
