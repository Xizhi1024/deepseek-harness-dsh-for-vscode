'use strict';

const crypto = require('node:crypto');

/**
 * Controlled W4 capability catalog.
 *
 * The catalog is the extension-side source of truth for which providers the
 * DSH sidebar may inspect and link to. It is intentionally tiny this round:
 * four framework entries only. No entry is marked `integrated` because none
 * of the candidate interfaces has passed the G3 audit yet.
 */

/**
 * Allowed `detailsUri` values are either an official `https://` page or a
 * controlled VS Code extension detail URI of the form
 * `vscode:extension/<publisher>.<name>`. Any other URI scheme or shape is
 * rejected so a bridge caller can never make the extension open an arbitrary
 * link or command.
 *
 * @param {string} value - Candidate details URI.
 * @returns {boolean} True when the URI is allowed by the catalog whitelist.
 */
function isAllowedDetailsUri(value) {
  if (typeof value !== 'string') return false;
  if (value.startsWith('https://')) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname.length > 0;
    } catch {
      return false;
    }
  }
  const prefix = 'vscode:extension/';
  if (!value.startsWith(prefix)) return false;
  const id = value.slice(prefix.length);
  if (id.length === 0 || /[/?#]/.test(id)) return false;
  const [publisher, name] = id.split('.');
  if (!publisher || !name) return false;
  const identifier = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
  return identifier.test(publisher) && identifier.test(name);
}

/**
 * Validate a single catalog entry and fail loudly when the controlled shape
 * is violated. The catalog is loaded at extension activation, so a malformed
 * entry is a build-time/startup error rather than a runtime surprise.
 *
 * @param {object} entry - Provider catalog entry.
 * @param {number} index - Position in the catalog, for error messages.
 * @returns {void}
 */
function assertCatalogEntry(entry, index) {
  const label = `PROVIDER_CATALOG[${index}]`;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new TypeError(`${label} must be an object`);
  }
  for (const field of [
    'providerId',
    'displayName',
    'publisher',
    'detailsUri',
    'capabilityIds',
    'providerKind',
    'integrationMode',
  ]) {
    if (entry[field] === undefined) {
      throw new TypeError(`${label} is missing required field: ${field}`);
    }
  }
  if (typeof entry.providerId !== 'string' || entry.providerId.length === 0) {
    throw new TypeError(`${label} providerId must be a non-empty string`);
  }
  if (typeof entry.displayName !== 'string' || entry.displayName.length === 0) {
    throw new TypeError(`${label} displayName must be a non-empty string`);
  }
  if (typeof entry.publisher !== 'string' || entry.publisher.length === 0) {
    throw new TypeError(`${label} publisher must be a non-empty string`);
  }
  if (!Array.isArray(entry.capabilityIds) || entry.capabilityIds.length === 0) {
    throw new TypeError(`${label} capabilityIds must be a non-empty array`);
  }
  for (const capabilityId of entry.capabilityIds) {
    if (typeof capabilityId !== 'string' || capabilityId.length === 0) {
      throw new TypeError(`${label} capabilityIds must contain only non-empty strings`);
    }
  }
  if (typeof entry.providerKind !== 'string' || entry.providerKind.length === 0) {
    throw new TypeError(`${label} providerKind must be a non-empty string`);
  }
  if (typeof entry.integrationMode !== 'string') {
    throw new TypeError(`${label} integrationMode must be a string`);
  }
  if (!isAllowedDetailsUri(entry.detailsUri)) {
    throw new TypeError(
      `${label} detailsUri must be an https:// URL or vscode:extension/<publisher>.<name>`
    );
  }
}

const PROVIDER_CATALOG = Object.freeze([
  Object.freeze({
    providerId: 'ms-vscode-remote.remote-wsl',
    displayName: 'Remote - WSL',
    publisher: 'ms-vscode-remote',
    detailsUri: 'vscode:extension/ms-vscode-remote.remote-wsl',
    capabilityIds: Object.freeze(['remote.workspace']),
    providerKind: 'extension',
    integrationMode: 'manual-assist',
    compatibility: 'unknown',
    reason: 'interface audit pending (G3)',
  }),
  Object.freeze({
    providerId: 'ms-vscode-remote.remote-ssh',
    displayName: 'Remote - SSH',
    publisher: 'ms-vscode-remote',
    detailsUri: 'vscode:extension/ms-vscode-remote.remote-ssh',
    capabilityIds: Object.freeze(['remote.workspace']),
    providerKind: 'extension',
    integrationMode: 'manual-assist',
    compatibility: 'unknown',
    reason: 'interface audit pending (G3)',
  }),
  Object.freeze({
    providerId: 'GitHub.vscode-pull-request-github',
    displayName: 'GitHub Pull Requests and Issues',
    publisher: 'GitHub',
    detailsUri: 'vscode:extension/GitHub.vscode-pull-request-github',
    capabilityIds: Object.freeze(['sourceControl.pullRequest', 'issue.tracker']),
    providerKind: 'extension',
    integrationMode: 'manual-assist',
    compatibility: 'unknown',
    reason: 'interface audit pending (G3)',
  }),
  Object.freeze({
    providerId: 'browser-provider-placeholder',
    displayName: 'Browser Provider (placeholder)',
    publisher: 'community',
    detailsUri: 'https://playwright.dev/docs/',
    capabilityIds: Object.freeze([
      'browser.navigate',
      'browser.inspect',
      'browser.interact',
      'browser.capture',
    ]),
    providerKind: 'browser',
    integrationMode: 'manual-assist',
    compatibility: 'unknown',
    reason: 'interface audit pending (G3)',
  }),
]);

for (let index = 0; index < PROVIDER_CATALOG.length; index += 1) {
  assertCatalogEntry(PROVIDER_CATALOG[index], index);
}

/**
 * Deep-copy one catalog entry for callers. `capabilityIds` is copied and
 * frozen so callers can never mutate catalog state through a snapshot.
 *
 * @param {object} entry - Provider catalog entry.
 * @returns {object} Frozen copy of the entry.
 */
function cloneEntry(entry) {
  return Object.freeze({
    ...entry,
    capabilityIds: Object.freeze([...entry.capabilityIds]),
  });
}

/**
 * @returns {object[]} A frozen, defensive copy of the full catalog.
 */
function catalogSnapshot() {
  return Object.freeze(PROVIDER_CATALOG.map((entry) => cloneEntry(entry)));
}

/**
 * @param {string} providerId - Candidate provider id.
 * @returns {object|null} Frozen copy of the catalog entry, or null when unknown.
 */
function resolveProvider(providerId) {
  if (typeof providerId !== 'string') return null;
  const entry = PROVIDER_CATALOG.find((candidate) => candidate.providerId === providerId);
  return entry ? cloneEntry(entry) : null;
}

/**
 * Stable revision for the catalog content. The value only changes when the
 * catalog content changes, so DSH can use it in compatibility checks and the
 * diagnostic summary without branch names or timestamps.
 *
 * @returns {string} Hexadecimal SHA-256 over the canonical catalog JSON.
 */
function catalogRevision() {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(PROVIDER_CATALOG))
    .digest('hex');
}

module.exports = {
  PROVIDER_CATALOG,
  catalogRevision,
  catalogSnapshot,
  isAllowedDetailsUri,
  resolveProvider,
};
