'use strict';

/**
 * S2b-1: MCP configuration aggregation and variable expansion.
 *
 * Merge order (later wins): user settings -> remote settings -> workspace
 * settings -> `.vscode/mcp.json`. The settings key is `mcp.servers` and the
 * workspace file shape is `{ "servers": { ... } }` (VS Code MCP shape).
 * `${env:NAME}` is expanded silently; a missing env var disables the server.
 * `${input:name}` is asked once per (server, name) through the injected
 * showInputBox seam (120s fail-closed) and cached in memory for the session.
 */

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function serverFields(server) {
  const fields = [];
  const add = (key, value) => {
    if (typeof value === 'string') fields.push([key, value]);
  };
  add('command', server.command);
  add('url', server.url);
  add('cwd', server.cwd);
  if (Array.isArray(server.args)) {
    server.args.forEach((value, index) => add('args.' + index, value));
  }
  if (isRecord(server.env)) {
    for (const [key, value] of Object.entries(server.env)) add('env.' + key, value);
  }
  if (isRecord(server.headers)) {
    for (const [key, value] of Object.entries(server.headers)) add('headers.' + key, value);
  }
  return fields;
}

function inputKeys(value) {
  const keys = [];
  let search = 0;
  const marker = '${input:';
  while (search < value.length) {
    const start = value.indexOf(marker, search);
    if (start === -1) break;
    const end = value.indexOf('}', start + marker.length);
    if (end === -1) break;
    const key = value.slice(start + marker.length, end);
    if (key.length > 0 && !keys.includes(key)) keys.push(key);
    search = end + 1;
  }
  return keys;
}

function envKeys(value) {
  const keys = [];
  let search = 0;
  const marker = '${env:';
  while (search < value.length) {
    const start = value.indexOf(marker, search);
    if (start === -1) break;
    const end = value.indexOf('}', start + marker.length);
    if (end === -1) break;
    const key = value.slice(start + marker.length, end);
    if (key.length > 0 && !keys.includes(key)) keys.push(key);
    search = end + 1;
  }
  return keys;
}

function replaceVariables(value, replacements) {
  let result = value;
  for (const [key, replacement] of replacements) {
    const marker = '${' + key + '}';
    result = result.split(marker).join(replacement);
  }
  return result;
}

function expandEnv(value, env) {
  const missing = [];
  const replacements = [];
  for (const key of envKeys(value)) {
    const replacement = env && typeof env[key] === 'string' ? env[key] : null;
    if (replacement === null) missing.push(key);
    else replacements.push(['env:' + key, replacement]);
  }
  return { value: replaceVariables(value, replacements), missing };
}

function expandInput(value, inputs) {
  const missing = [];
  const replacements = [];
  for (const key of inputKeys(value)) {
    const replacement = inputs && typeof inputs[key] === 'string' ? inputs[key] : null;
    if (replacement === null) missing.push(key);
    else replacements.push(['input:' + key, replacement]);
  }
  return { value: replaceVariables(value, replacements), missing };
}

function normalizeServer(name, record) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('MCP server name must be a non-empty string');
  }
  if (!isRecord(record)) {
    throw new TypeError(`MCP server ${name} must be an object`);
  }
  const type = record.type === 'sse' || record.type === 'http' ? record.type : 'stdio';
  const normalized = { name, type };
  if (type === 'stdio') {
    if (typeof record.command !== 'string' || record.command.length === 0) {
      throw new TypeError(`MCP stdio server ${name} requires a command`);
    }
    normalized.command = record.command;
    normalized.args = Array.isArray(record.args) ? record.args.slice() : [];
    normalized.cwd = typeof record.cwd === 'string' && record.cwd.length > 0 ? record.cwd : undefined;
    normalized.env = isRecord(record.env) ? { ...record.env } : {};
  } else {
    if (typeof record.url !== 'string' || record.url.length === 0) {
      throw new TypeError(`MCP ${type} server ${name} requires a url`);
    }
    normalized.url = record.url;
    normalized.headers = isRecord(record.headers) ? { ...record.headers } : {};
  }
  return normalized;
}

/**
 * Merge ordered MCP server sources. Later sources override earlier ones with
 * the same server name; each override emits a diagnostic.
 *
 * @param {Array<{source: string, servers: object|Array<object>}>} sources
 * @returns {{servers: Array<object>, diagnostics: Array<{source: string, message: string}>}}
 */
function mergeMcpSources(sources) {
  const merged = new Map();
  const diagnostics = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    if (!source || typeof source !== 'object') continue;
    const servers = Array.isArray(source.servers)
      ? source.servers
      : isRecord(source.servers)
        ? Object.entries(source.servers).map(([name, record]) => ({ name, ...record }))
        : [];
    for (const entry of servers) {
      if (!isRecord(entry) || typeof entry.name !== 'string') continue;
      const name = entry.name;
      try {
        const record = { ...entry };
        delete record.name;
        if (merged.has(name)) {
          diagnostics.push({ source: source.source || 'unknown', message: `MCP server ${name} overrides an earlier definition` });
        }
        merged.set(name, normalizeServer(name, record));
      } catch (error) {
        diagnostics.push({ source: source.source || 'unknown', message: error && error.message ? error.message : String(error) });
      }
    }
  }
  return { servers: [...merged.values()], diagnostics };
}

/**
 * Expand a normalized server record. Returns either a server with fully
 * expanded string fields, or a disabled entry with a concrete reason.
 *
 * @param {object} server - Normalized server from mergeMcpSources.
 * @param {object} options
 * @param {object} options.env - process.env-like object for `${env:...}`.
 * @param {Map<string, string>} options.inputCache - session input cache.
 * @param {Function} options.askInput - async (key) => string|undefined.
 * @returns {Promise<{server?: object, disabled?: boolean, reason?: string}>}
 */
async function expandServer(server, { env = {}, inputCache = new Map(), askInput = async () => undefined } = {}) {
  const fields = serverFields(server);
  const missingEnv = [];
  const inputKeysSeen = new Set();
  for (const [key, value] of fields) {
    const envResult = expandEnv(value, env);
    if (envResult.missing.length > 0) {
      for (const missing of envResult.missing) missingEnv.push(missing);
      continue;
    }
    const inputResult = expandInput(envResult.value, {});
    for (const inputKey of inputKeys(envResult.value)) {
      if (!inputKeysSeen.has(inputKey)) inputKeysSeen.add(inputKey);
    }
  }
  if (missingEnv.length > 0) {
    return { disabled: true, reason: 'env-missing: ' + [...new Set(missingEnv)].join(', ') };
  }
  const resolvedInputs = {};
  for (const key of inputKeysSeen) {
    let value = inputCache.get(key);
    if (typeof value !== 'string') {
      value = await askInput(key);
      if (typeof value !== 'string' || value.length === 0) {
        return { disabled: true, reason: 'input-missing: ' + key };
      }
      inputCache.set(key, value);
    }
    resolvedInputs[key] = value;
  }
  const expanded = { ...server };
  for (const key of Object.keys(expanded)) {
    if (typeof expanded[key] === 'string') {
      const envResult = expandEnv(expanded[key], env);
      expanded[key] = expandInput(envResult.value, resolvedInputs).value;
    } else if (Array.isArray(expanded[key])) {
      expanded[key] = expanded[key].map((value) => {
        if (typeof value !== 'string') return value;
        const envResult = expandEnv(value, env);
        return expandInput(envResult.value, resolvedInputs).value;
      });
    } else if (isRecord(expanded[key])) {
      const next = {};
      for (const [subKey, value] of Object.entries(expanded[key])) {
        if (typeof value !== 'string') {
          next[subKey] = value;
          continue;
        }
        const envResult = expandEnv(value, env);
        next[subKey] = expandInput(envResult.value, resolvedInputs).value;
      }
      expanded[key] = next;
    }
  }
  return { server: expanded };
}

module.exports = {
  envKeys,
  expandEnv,
  expandInput,
  expandServer,
  inputKeys,
  mergeMcpSources,
  normalizeServer,
  serverFields,
};
