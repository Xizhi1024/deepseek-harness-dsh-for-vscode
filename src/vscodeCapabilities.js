'use strict';

/**
 * VS Code host capability derivation.
 *
 * This module maps a VS Code version string to a small set of capability
 * booleans used only for display and diagnostics. It intentionally never
 * gates behavior: the extension keeps its `engines.vscode` floor and treats
 * every API surface as present at runtime. These flags exist so the UI and
 * diagnose output can describe what the host can do without probing for
 * optional APIs or catching missing-symbol errors.
 *
 * Capability thresholds (semver inclusive):
 * - `chatParticipant`        — VS Code 1.90+ (`createChatParticipant`)
 * - `lmProvider`             — VS Code 1.104+ (`registerLanguageModelChatProvider`)
 * - `mcpServerDefinitions`   — VS Code 1.105+ (MCP server definition support)
 *
 * @module vscodeCapabilities
 */

/**
 * Parse the numeric core of a VS Code version string.
 *
 * Accepts `1.106`, `1.106.0`, and build suffixes such as
 * `1.106.0-insider`. Invalid or missing input returns null so callers can
 * degrade to all-false without throwing.
 *
 * @param {unknown} version - Raw `vscode.version` value.
 * @returns {number[]|null} `[major, minor, patch]` or null when unparsable.
 */
function parseVersion(version) {
  if (typeof version !== 'string') return null;
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version.trim());
  if (!match) return null;
  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3] || 0),
  ];
}

/**
 * Compare two parsed `[major, minor, patch]` tuples.
 *
 * @param {number[]} a - Parsed version tuple.
 * @param {number[]} b - Parsed version tuple.
 * @returns {boolean} True when `a` is greater than or equal to `b`.
 */
function gte(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

/**
 * Derive the VS Code capability set for a host version string.
 *
 * The returned object is a plain frozen record with three booleans. Every
 * field is false for invalid/unknown versions; the function never throws.
 *
 * @param {string} version - VS Code version, e.g. `"1.106.0"`.
 * @returns {{ chatParticipant: boolean, lmProvider: boolean, mcpServerDefinitions: boolean }}
 *   Frozen capability snapshot.
 */
function deriveVscodeCapabilities(version) {
  const parsed = parseVersion(version);
  return Object.freeze({
    chatParticipant: parsed !== null && gte(parsed, [1, 90, 0]),
    lmProvider: parsed !== null && gte(parsed, [1, 104, 0]),
    mcpServerDefinitions: parsed !== null && gte(parsed, [1, 105, 0]),
  });
}

module.exports = {
  deriveVscodeCapabilities,
};
