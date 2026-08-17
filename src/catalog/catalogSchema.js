'use strict';

const crypto = require('node:crypto');

const { isAllowedDetailsUri } = require('../capabilityCatalog');

/**
 * Catalog schema for the 0.6 plugin classification catalog.
 *
 * The authoritative catalog object is:
 *   {
 *     revision: string,
 *     categories: [{ id, label, hard }],
 *     entries: [{
 *       id,
 *       category,
 *       packageIds: string[],
 *       capabilities: string[],
 *       required: boolean,
 *       adapter: string,
 *       fallback: string,
 *       probe: { inventory: boolean, settingsNamespace?: string, behavior?: string },
 *       integrationMode: 'manual-assist',
 *       compatibility: 'unknown',
 *       reason: 'interface audit pending (G3)'
 *     }]
 *   }
 *
 * `detailsUri` is intentionally optional in this catalog. When present it must
 * pass the same whitelist used by `capabilityCatalog` (https:// or a controlled
 * vscode:extension/<publisher>.<name> URI); when absent it is allowed so this
 * schema can describe plugin entries that have no external details page yet.
 */

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

/**
 * Validate one catalog category object.
 *
 * @param {unknown} category - Candidate category.
 * @param {number} index - Category index for error messages.
 * @param {Set<string>} ids - Set to collect category ids.
 * @returns {void}
 */
function assertCategory(category, index, ids) {
  const label = `CATALOG.categories[${index}]`;
  if (!isRecord(category)) throw new TypeError(`${label} must be an object`);
  assertNonEmptyString(category.id, `${label}.id`);
  assertNonEmptyString(category.label, `${label}.label`);
  if (typeof category.hard !== 'boolean') {
    throw new TypeError(`${label}.hard must be a boolean`);
  }
  if (category.id === 'core' && category.hard !== true) {
    throw new TypeError(`${label}.hard must be true for the core category`);
  }
  if (category.id !== 'core' && category.hard !== false) {
    throw new TypeError(`${label}.hard must be false for non-core categories`);
  }
  if (ids.has(category.id)) {
    throw new TypeError(`${label}.id must be unique: ${category.id}`);
  }
  ids.add(category.id);
}

/**
 * Validate one catalog entry object.
 *
 * @param {unknown} entry - Candidate entry.
 * @param {number} index - Entry index for error messages.
 * @param {Set<string>} categoryIds - Valid category ids.
 * @returns {void}
 */
function assertEntry(entry, index, categoryIds) {
  const label = `CATALOG.entries[${index}]`;
  if (!isRecord(entry)) throw new TypeError(`${label} must be an object`);

  assertNonEmptyString(entry.id, `${label}.id`);
  assertNonEmptyString(entry.category, `${label}.category`);
  if (!categoryIds.has(entry.category)) {
    throw new TypeError(`${label}.category references unknown category: ${entry.category}`);
  }

  if (!Array.isArray(entry.packageIds)) {
    throw new TypeError(`${label}.packageIds must be an array`);
  }
  for (const packageId of entry.packageIds) {
    if (typeof packageId !== 'string' || packageId.length === 0) {
      throw new TypeError(`${label}.packageIds must contain only non-empty strings`);
    }
  }

  if (!Array.isArray(entry.capabilities) || entry.capabilities.length === 0) {
    throw new TypeError(`${label}.capabilities must be a non-empty array`);
  }
  for (const capability of entry.capabilities) {
    if (typeof capability !== 'string' || capability.length === 0) {
      throw new TypeError(`${label}.capabilities must contain only non-empty strings`);
    }
  }

  if (typeof entry.required !== 'boolean') {
    throw new TypeError(`${label}.required must be a boolean`);
  }
  assertNonEmptyString(entry.adapter, `${label}.adapter`);
  if (typeof entry.fallback !== 'string') {
    throw new TypeError(`${label}.fallback must be a string`);
  }

  if (!isRecord(entry.probe)) {
    throw new TypeError(`${label}.probe must be an object`);
  }
  if (typeof entry.probe.inventory !== 'boolean') {
    throw new TypeError(`${label}.probe.inventory must be a boolean`);
  }
  if (
    entry.probe.settingsNamespace !== undefined &&
    (typeof entry.probe.settingsNamespace !== 'string' || entry.probe.settingsNamespace.length === 0)
  ) {
    throw new TypeError(`${label}.probe.settingsNamespace must be a non-empty string when present`);
  }
  if (
    entry.probe.behavior !== undefined &&
    (typeof entry.probe.behavior !== 'string' || entry.probe.behavior.length === 0)
  ) {
    throw new TypeError(`${label}.probe.behavior must be a non-empty string when present`);
  }

  if (entry.integrationMode !== 'manual-assist') {
    throw new TypeError(`${label}.integrationMode must be 'manual-assist'`);
  }
  if (entry.compatibility !== 'unknown') {
    throw new TypeError(`${label}.compatibility must be 'unknown'`);
  }
  assertNonEmptyString(entry.reason, `${label}.reason`);

  if (entry.detailsUri !== undefined && !isAllowedDetailsUri(entry.detailsUri)) {
    throw new TypeError(
      `${label}.detailsUri must be an https:// URL or vscode:extension/<publisher>.<name> when present`
    );
  }
}

/**
 * Validate a full catalog object. Throws TypeError on the first invalid field.
 *
 * @param {unknown} input - Candidate catalog.
 * @returns {void}
 */
function assertCatalog(input) {
  if (!isRecord(input)) throw new TypeError('catalog must be an object');
  assertNonEmptyString(input.revision, 'catalog.revision');

  if (!Array.isArray(input.categories) || input.categories.length === 0) {
    throw new TypeError('catalog.categories must be a non-empty array');
  }
  const categoryIds = new Set();
  for (let index = 0; index < input.categories.length; index += 1) {
    assertCategory(input.categories[index], index, categoryIds);
  }

  if (!Array.isArray(input.entries)) {
    throw new TypeError('catalog.entries must be an array');
  }
  for (let index = 0; index < input.entries.length; index += 1) {
    assertEntry(input.entries[index], index, categoryIds);
  }
}

/**
 * Compute the stable revision of a catalog object.
 *
 * @param {object} catalog - Catalog object.
 * @returns {string} Lowercase hexadecimal SHA-256 of JSON.stringify(catalog).
 */
function catalogRevision(catalog) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(catalog))
    .digest('hex');
}

module.exports = {
  assertCatalog,
  catalogRevision,
};
