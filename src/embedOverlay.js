'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * DSH plugin ids disabled by the VS Code embed overlay. The embedded webview
 * already provides the sidebar and the AION UI panel, so launching the managed
 * DSH server with these plugins active would duplicate both surfaces.
 * @type {readonly string[]}
 */
const EMBED_DISABLED_PLUGIN_IDS = Object.freeze([
  'better-sidebar',
  'ui-dsh-aionui-panel',
]);
const EMBED_INTEGRATION_PLUGIN_ID = 'vscode-integration';
const EMBED_INTEGRATION_PACKAGE = 'dsh-vscode-integration';
const CLEAN_OVERLAY_FILENAME = 'vscode-clean.overlay.yml';
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
/**
 * S3 mcp-bridge: DSH package that connects to one MCP server. Each bridged
 * VS Code-registered server becomes one insert row of this package, so DSH's
 * own MCP client (not the extension bridge) owns the connection.
 */
const MCP_BRIDGE_PLUGIN_PACKAGE = '@deepseek-ai/dsh-mcp-client';

/**
 * Comment lines describing the mcp-bridge rows. Emitted as list-item
 * indentation comments directly above the first bridged row so they stay
 * attached to the insert block they document.
 */
const MCP_BRIDGE_COMMENT_LINES = Object.freeze([
  '    # VS Code-registered MCP servers, bridged into the DSH native MCP client',
  '    # (dsh.features.mcp-bridge). Generated from vscode.lm.mcpServerDefinitions;',
  '    # changes take effect after the DSH service restarts.',
]);

/**
 * Render one normalized MCP server record (shape of `mcp/config.js`
 * `normalizeServer`) as the body of one `@deepseek-ai/dsh-mcp-client` patch
 * row. All interpolated values are emitted through `JSON.stringify` — JSON is
 * a strict YAML subset, so arbitrary strings/arrays/objects stay safe without
 * a YAML dependency. Empty collections are omitted (the DSH config schema
 * defaults `args` to `[]` and `env`/`headers` to `{}`).
 *
 * @param {object} server - Normalized stdio or http server record.
 * @returns {string[]} Row lines at the `- id:` indentation level.
 */
function renderMcpBridgeRow(server) {
  if (!server || typeof server !== 'object' || typeof server.name !== 'string' || server.name.length === 0) {
    throw new TypeError('renderMcpBridgeRow requires a server record with a name');
  }
  const lines = [
    `- id: vscode-mcp-${server.name}`,
    `  name: "${MCP_BRIDGE_PLUGIN_PACKAGE}"`,
    '  config:',
    `    serverName: ${JSON.stringify(server.name)}`,
  ];
  if (server.type === 'http' || server.type === 'sse') {
    lines.push(
      '    transport: "streamable-http"',
      `    url: ${JSON.stringify(String(server.url))}`
    );
    if (server.headers && Object.keys(server.headers).length > 0) {
      lines.push(`    headers: ${JSON.stringify(server.headers)}`);
    }
    return lines;
  }
  if (typeof server.command !== 'string' || server.command.length === 0) {
    throw new TypeError(`renderMcpBridgeRow: stdio server ${server.name} requires a command`);
  }
  lines.push('    transport: "stdio"');
  lines.push(`    command: ${JSON.stringify(server.command)}`);
  if (Array.isArray(server.args) && server.args.length > 0) {
    lines.push(`    args: ${JSON.stringify(server.args)}`);
  }
  if (server.env && Object.keys(server.env).length > 0) {
    lines.push(`    env: ${JSON.stringify(server.env)}`);
  }
  if (typeof server.cwd === 'string' && server.cwd.length > 0) {
    lines.push(`    cwd: ${JSON.stringify(server.cwd)}`);
  }
  return lines;
}

/**
 * Render the mcp-bridge rows for a single `- insert:` block of a patch
 * overlay: descriptive comments plus one dsh-mcp-client row per normalized
 * server, at the patch-loader's 4-space list indentation. Empty for no
 * servers. Used by the embed overlay (which owns the one `- insert:` block)
 * and exported for tests and a potential standalone `--patch` file.
 *
 * @param {object[]} servers - Normalized MCP server records.
 * @returns {string[]} Overlay lines (may be empty).
 */
function renderMcpBridgeOverlay(servers) {
  const rows = Array.isArray(servers) ? servers : [];
  if (rows.length === 0) return [];
  const lines = [...MCP_BRIDGE_COMMENT_LINES];
  for (const server of rows) {
    for (const line of renderMcpBridgeRow(server)) {
      lines.push('    ' + line);
    }
  }
  return lines;
}

/**
 * Render the embed overlay document consumed by `dsh --patch <path>`.
 * The disabled-plugin rows and the vscode-integration insert are built
 * exclusively from the frozen constants above; the mcp-bridge rows append
 * their JSON-quoted scalars into the SAME `- insert:` block (the patch loader
 * applies one insert list; every scalar is JSON-safe — see renderMcpBridgeRow).
 *
 * @param {object[]} [mcpServers] - Normalized VS Code-registered MCP servers
 *   to bridge into the DSH native MCP client (mcp-bridge feature). Empty or
 *   omitted keeps the historical embed-only overlay byte-identical.
 * @returns {string} overlay YAML terminated by a single `\n`.
 */
function renderEmbedOverlay(mcpServers = []) {
  const lines = [
    '# VS Code embed overlay, generated by dsh-vs-sidebar.',
    '# Disables DSH plugins that would duplicate the embedded VS Code sidebar/panel.',
  ];
  for (const id of EMBED_DISABLED_PLUGIN_IDS) {
    lines.push(`- id: ${id}`, '  disabled: true');
  }
  lines.push('- insert:');
  lines.push(...renderMcpBridgeOverlay(mcpServers));
  lines.push(
    `    - id: ${EMBED_INTEGRATION_PLUGIN_ID}`,
    `      name: ${EMBED_INTEGRATION_PACKAGE}`
  );
  return `${lines.join('\n')}\n`;
}

/**
 * Write the embed overlay file into `directory` and return its absolute path.
 * @param {string} dshHome non-empty absolute DSH home; the overlay lands in
 *   `<dshHome>/.integrations/vscode-sidebar/vscode-embed.overlay.yml`; created
 *   recursively when missing.
 * @param {{ mcpServers?: object[], writeFileSync?: typeof fs.writeFileSync, mkdirSync?: typeof fs.mkdirSync }} [options]
 *   `mcpServers` are the normalized VS Code-registered MCP servers to bridge
 *   (mcp-bridge feature); fs operations are injectable for tests.
 * @returns {string} absolute path of the written overlay file.
 */
function writeEmbedOverlay(dshHome, options = {}) {
  if (typeof dshHome !== 'string' || dshHome.length === 0 || !path.isAbsolute(dshHome)) {
    throw new Error('DSH home must be a non-empty absolute path');
  }
  const {
    mcpServers = [],
    writeFileSync = fs.writeFileSync,
    mkdirSync = fs.mkdirSync,
    renameSync = fs.renameSync,
    chmodSync = fs.chmodSync,
  } = options || {};
  const directory = path.join(dshHome, '.integrations', 'vscode-sidebar');
  mkdirSync(directory, { recursive: true });
  const overlayPath = path.join(directory, 'vscode-embed.overlay.yml');
  const temporaryPath = path.join(directory, `.vscode-embed.overlay.${process.pid}.tmp`);
  writeFileSync(temporaryPath, renderEmbedOverlay(mcpServers), { encoding: 'utf8', mode: 0o600 });
  renameSync(temporaryPath, overlayPath);
  try {
    chmodSync(overlayPath, 0o600);
  } catch {
    // Windows ACLs and some remote file systems do not expose POSIX modes.
  }
  return overlayPath;
}

/**
 * Official DSH plugin ids (loader entry ids / package names) that are treated
 * as core: a clean restart overlay never disables them.
 * @param {*} id
 * @returns {boolean}
 */
function isOfficialPluginId(id) {
  return typeof id === 'string' && /^@deepseek-ai\//.test(id);
}

/**
 * Plugin ids that belong to the VS Code embed line (injected by the regular
 * embed overlay). A clean overlay re-emits these rows instead of classifying
 * them as generic third-party entries to disable.
 * @param {*} id
 * @returns {boolean}
 */
function isEmbedPluginId(id) {
  return (
    EMBED_DISABLED_PLUGIN_IDS.includes(id)
    || id === EMBED_INTEGRATION_PLUGIN_ID
  );
}

/**
 * Extract the `- id: <value>` starter lines from a cordis.patch.yml document.
 * The clean overlay rebuilds entries by id only; comments, `disabled:` flags
 * and `insert:` blocks are consumed as raw text, not semantics.
 * @param {string} patchText
 * @returns {string[]} unique ids in first-appearance order.
 */
function extractPatchEntryIds(patchText) {
  const ids = [];
  const seen = new Set();
  for (const line of String(patchText || '').split(/\r?\n/)) {
    const match = /^\s*-\s+id:\s*(\S+)\s*$/.exec(line);
    if (!match) continue;
    const id = match[1];
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/**
 * Render the D1 clean-restart overlay consumed by `dsh --patch <path>`.
 *
 * It enumerates the active profile's cordis.patch.yml entries and forces
 * `disabled: true` on every non-core entry — anything outside the official
 * `@deepseek-ai/*` set and the VS Code embed rows — then appends the standard
 * embed lines (sidebar/AION disabled + vscode-integration inserted). The
 * official `@deepseek-ai/*` entries are intentionally untouched so the core
 * DSH surface stays fully functional.
 *
 * @param {string} [patchText] contents of the profile cordis.patch.yml; an
 *   empty or missing file degrades to the embed-only overlay (D1 conservative).
 * @returns {string} overlay YAML terminated by a single `\n`.
 */
function renderCleanOverlay(patchText) {
  const lines = [
    '# VS Code clean restart overlay, generated by dsh-vs-sidebar.',
    '# Disables every non-core (non-@deepseek-ai/*, non-embed) plugin in the active profile.',
  ];
  const emitted = new Set();
  for (const id of extractPatchEntryIds(patchText)) {
    if (isOfficialPluginId(id) || isEmbedPluginId(id)) continue;
    if (emitted.has(id)) continue;
    emitted.add(id);
    lines.push(`- id: ${id}`, '  disabled: true');
  }
  for (const id of EMBED_DISABLED_PLUGIN_IDS) {
    if (emitted.has(id)) continue;
    emitted.add(id);
    lines.push(`- id: ${id}`, '  disabled: true');
  }
  lines.push(
    '- insert:',
    `    - id: ${EMBED_INTEGRATION_PLUGIN_ID}`,
    `      name: ${EMBED_INTEGRATION_PACKAGE}`
  );
  return `${lines.join('\n')}\n`;
}

/**
 * Write the D1 clean-restart overlay into the active profile home
 * (`<profileHome>/vscode-clean.overlay.yml`) and return its absolute path.
 * The profile cordis.patch.yml is read for the entry enumeration; a missing
 * patch file degrades to an embed-only overlay.
 *
 * @param {string} dshHome non-empty absolute DSH home.
 * @param {string} [profileName] profile directory under the home (default 'web').
 * @param {{ readFileSync?: typeof fs.readFileSync, writeFileSync?: typeof fs.writeFileSync, mkdirSync?: typeof fs.mkdirSync, renameSync?: typeof fs.renameSync, chmodSync?: typeof fs.chmodSync }} [options]
 *   injectable fs operations for tests.
 * @returns {string} absolute path of the written clean overlay file.
 */
function writeCleanOverlay(dshHome, profileName = 'web', options = {}) {
  if (typeof dshHome !== 'string' || dshHome.length === 0 || !path.isAbsolute(dshHome)) {
    throw new Error('DSH home must be a non-empty absolute path');
  }
  if (typeof profileName !== 'string' || !PROFILE_NAME_PATTERN.test(profileName) || profileName === '.' || profileName === '..') {
    throw new Error('DSH profile name must match [A-Za-z0-9._-]{1,64} and not be "." or ".."');
  }
  const {
    readFileSync = fs.readFileSync,
    writeFileSync = fs.writeFileSync,
    mkdirSync = fs.mkdirSync,
    renameSync = fs.renameSync,
    chmodSync = fs.chmodSync,
  } = options || {};
  const profileHome = path.join(dshHome, 'profiles', profileName);
  mkdirSync(profileHome, { recursive: true });
  const patchPath = path.join(profileHome, 'cordis.patch.yml');
  let patchText = '';
  try {
    patchText = readFileSync(patchPath, 'utf8');
  } catch {
    // Missing/unreadable patch: D1 conservative embed-only overlay.
  }
  const overlayPath = path.join(profileHome, CLEAN_OVERLAY_FILENAME);
  const temporaryPath = path.join(profileHome, `.${CLEAN_OVERLAY_FILENAME}.${process.pid}.tmp`);
  writeFileSync(temporaryPath, renderCleanOverlay(patchText), { encoding: 'utf8', mode: 0o600 });
  renameSync(temporaryPath, overlayPath);
  try {
    chmodSync(overlayPath, 0o600);
  } catch {
    // Windows ACLs and some remote file systems do not expose POSIX modes.
  }
  return overlayPath;
}

module.exports = {
  CLEAN_OVERLAY_FILENAME,
  EMBED_DISABLED_PLUGIN_IDS,
  EMBED_INTEGRATION_PACKAGE,
  EMBED_INTEGRATION_PLUGIN_ID,
  MCP_BRIDGE_PLUGIN_PACKAGE,
  renderEmbedOverlay,
  renderMcpBridgeOverlay,
  renderMcpBridgeRow,
  writeEmbedOverlay,
  extractPatchEntryIds,
  isEmbedPluginId,
  isOfficialPluginId,
  renderCleanOverlay,
  writeCleanOverlay,
};
