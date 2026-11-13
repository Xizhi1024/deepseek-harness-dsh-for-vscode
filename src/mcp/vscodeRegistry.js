'use strict';

/**
 * S3 mcp-bridge: discovery of MCP servers registered with VS Code by other
 * extensions (`vscode.lm.mcpServerDefinitions`, proposed API
 * `mcpServerDefinitions`).
 *
 * Two consumers share the discovered, normalized server records:
 *
 *  1. The MCP consume aggregator (`mcp/manager.js`): the records are merged in
 *     as the lowest-priority source, so VS Code-registered servers are
 *     listable/callable through the consent-gated `vscode/mcp/*` bridge.
 *  2. The embed overlay (`embedOverlay.js`): the records are rendered as
 *     `@deepseek-ai/dsh-mcp-client` insert rows, so DSH's own MCP client
 *     connects to these servers natively (`mcp__<serverName>__<tool>` tools).
 *
 * This module is pure: it never requires `vscode`, it only consumes an
 * `lm`-shaped facade. Every access to the gated `mcpServerDefinitions` getter
 * is wrapped — VS Code *throws* (instead of returning undefined) when the
 * proposal is not enabled for this extension, and every failure degrades to
 * `{ available: false }` instead of propagating.
 *
 * Known limits, by design:
 *  - Definitions surfaced by `mcpServerDefinitions` are the *unresolved* ones
 *    a provider returned. When a provider injects credentials only inside
 *    `resolveMcpServerDefinition`, the passthrough cannot see them; such
 *    servers are bridged as-is and may fail to connect.
 *  - Definitions that require a VS Code authentication provider
 *    (`authentication.providerId`) are skipped: DSH cannot perform the
 *    editor-side OAuth dance.
 */

const DSH_MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client';

/**
 * DSH `serverName` contract (dsh-mcp-client config schema): `[A-Za-z0-9_-]{1,32}`.
 */
const SERVER_NAME_MAX = 32;
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Normalize a VS Code definition label into a DSH-valid `serverName` /
 * entry-name slug and keep a caller-supplied uniqueness set in sync.
 *
 * Lossy normalization: non-`[a-z0-9_-]` runs collapse into `-`; an empty
 * result falls back to `server`; collisions get `-2`, `-3`, … suffixes that
 * respect the 32-character budget.
 *
 * @param {unknown} label - Raw label (usually the definition's `label`).
 * @param {Set<string>} [taken] - Mutable set of already-used names.
 * @returns {string} Name matching `[a-z0-9_-]{1,32}`.
 */
function slugifyServerName(label, taken = new Set()) {
  const raw = typeof label === 'string' ? label : String(label == null ? '' : label);
  let base = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, SERVER_NAME_MAX);
  if (base.length === 0) base = 'server';
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  for (let suffix = 2; ; suffix += 1) {
    const suffixText = '-' + suffix;
    const candidate = base.slice(0, SERVER_NAME_MAX - suffixText.length) + suffixText;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

/** Keep only string values of a record (VS Code env/headers are string maps). */
function stringRecord(value) {
  const result = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return result;
}

/** Loose transport signature used for duplicate detection against file sources. */
function transportSignature(server) {
  if (!server || typeof server !== 'object') return null;
  if (typeof server.command === 'string' && server.command.length > 0) {
    const args = Array.isArray(server.args) ? server.args.filter((arg) => typeof arg === 'string').join('\u0000') : '';
    return 'stdio\u0000' + server.command + '\u0000' + args;
  }
  if (typeof server.url === 'string' && server.url.length > 0) return 'http\u0000' + server.url;
  return null;
}

/**
 * Convert one VS Code MCP server definition into the normalized server record
 * shape used by `mcp/config.js` (`normalizeServer`) and the overlay renderer.
 *
 * @param {object} definition - `McpStdioServerDefinition` / `McpHttpServerDefinition`.
 * @param {Set<string>} takenNames - Mutable uniqueness set for server names.
 * @returns {{ server?: object, skip?: string }} The mapped record or a skip reason.
 */
function vscodeDefinitionToServer(definition, takenNames) {
  if (!definition || typeof definition !== 'object') return { skip: 'unsupported-definition: not an object' };
  const label = typeof definition.label === 'string' && definition.label.length > 0
    ? definition.label
    : 'server';
  const auth = definition.authentication;
  if (auth && typeof auth === 'object' && typeof auth.providerId === 'string' && auth.providerId.length > 0) {
    return { skip: 'auth-required: VS Code authentication provider "' + auth.providerId + '" cannot be bridged' };
  }
  const name = slugifyServerName(label, takenNames);
  if (typeof definition.command === 'string' && definition.command.trim().length > 0) {
    const server = {
      name,
      type: 'stdio',
      command: definition.command,
      args: Array.isArray(definition.args) ? definition.args.filter((arg) => typeof arg === 'string') : [],
      env: stringRecord(definition.env),
    };
    if (typeof definition.cwd === 'string' && definition.cwd.length > 0) server.cwd = definition.cwd;
    return { server };
  }
  const uri = definition.uri;
  const url = typeof uri === 'string'
    ? uri
    : uri && typeof uri.toString === 'function'
      ? uri.toString()
      : '';
  if (typeof url === 'string' && url.length > 0) {
    return {
      server: {
        name,
        type: 'http',
        url,
        headers: stringRecord(definition.headers),
      },
    };
  }
  return { skip: 'unsupported-definition: no command and no uri on "' + label + '"' };
}

/**
 * Convert a batch of VS Code MCP server definitions.
 *
 * @param {unknown[]} definitions - Raw `vscode.lm.mcpServerDefinitions` array.
 * @param {{ takenNames?: Set<string> }} [options]
 * @returns {{ servers: object[], diagnostics: Array<{server: string, message: string}> }}
 */
function definitionsToServers(definitions, { takenNames = new Set() } = {}) {
  const servers = [];
  const diagnostics = [];
  for (const definition of Array.isArray(definitions) ? definitions : []) {
    const label = definition && typeof definition.label === 'string' ? definition.label : 'server';
    try {
      const mapped = vscodeDefinitionToServer(definition, takenNames);
      if (mapped.server) servers.push(mapped.server);
      else diagnostics.push({ server: label, message: mapped.skip || 'unsupported-definition' });
    } catch (error) {
      diagnostics.push({
        server: label,
        message: 'mapping failed: ' + (error && error.message ? error.message : String(error)),
      });
    }
  }
  return { servers, diagnostics };
}

/**
 * Drop registered servers that duplicate an explicit file/settings source
 * (same name, or same transport signature). The file sources always win —
 * they are the user's own written configuration.
 *
 * @param {object[]} registeredServers - Output of definitionsToServers.
 * @param {Array<{source: string, servers: object[]|object}>} fileSources - readMcpSources output.
 * @returns {{ servers: object[], dropped: Array<{server: string, reason: string}> }}
 */
function dedupeAgainstFileSources(registeredServers, fileSources) {
  const fileNames = new Set();
  const fileSignatures = new Set();
  for (const source of Array.isArray(fileSources) ? fileSources : []) {
    const servers = Array.isArray(source && source.servers)
      ? source.servers
      : source && source.servers && typeof source.servers === 'object'
        ? Object.entries(source.servers).map(([name, record]) => ({ name, ...(record || {}) }))
        : [];
    for (const record of servers) {
      if (!record || typeof record !== 'object') continue;
      if (typeof record.name === 'string' && record.name.length > 0) fileNames.add(record.name);
      const signature = transportSignature(record);
      if (signature) fileSignatures.add(signature);
    }
  }
  const servers = [];
  const dropped = [];
  for (const server of Array.isArray(registeredServers) ? registeredServers : []) {
    if (typeof server.name === 'string' && fileNames.has(server.name)) {
      dropped.push({ server: server.name, reason: 'a server with this name is already configured in settings/mcp.json' });
      continue;
    }
    const signature = transportSignature(server);
    if (signature && fileSignatures.has(signature)) {
      dropped.push({ server: server.name, reason: 'the same transport is already configured in settings/mcp.json' });
      continue;
    }
    servers.push(server);
  }
  return { servers, dropped };
}

/**
 * Read the MCP server definitions VS Code currently knows about.
 *
 * @param {object|null} lm - The `vscode.lm` namespace (or a test facade).
 * @returns {{ available: boolean, servers: object[], diagnostics: Array<{server: string, message: string}> }}
 *   `available` is false when the API surface is missing or the
 *   `mcpServerDefinitions` proposal is not enabled (getter access throws).
 */
function readRegisteredMcpServers(lm) {
  if (!lm || typeof lm !== 'object') return { available: false, servers: [], diagnostics: [] };
  let definitions;
  try {
    definitions = lm.mcpServerDefinitions;
  } catch (error) {
    return {
      available: false,
      servers: [],
      diagnostics: [{
        server: 'vscode.lm',
        message: 'mcpServerDefinitions unavailable (' + (error && error.message ? error.message : String(error)) + ')',
      }],
    };
  }
  if (!Array.isArray(definitions)) return { available: false, servers: [], diagnostics: [] };
  const mapped = definitionsToServers(definitions);
  return { available: true, servers: mapped.servers, diagnostics: mapped.diagnostics };
}

module.exports = {
  DSH_MCP_CLIENT_PACKAGE,
  SERVER_NAME_MAX,
  SERVER_NAME_PATTERN,
  definitionsToServers,
  dedupeAgainstFileSources,
  readRegisteredMcpServers,
  slugifyServerName,
  transportSignature,
  vscodeDefinitionToServer,
};
