'use strict';

const { assertCatalog, catalogRevision: schemaCatalogRevision } = require('./catalogSchema');

/**
 * Controlled 0.6 plugin classification catalog.
 *
 * This is the extension-side source of truth for which DSH plugins the
 * sidebar can classify and detect. Entries are intentionally conservative:
 * `packageIds` only contains package names from the verified evidence in the
 * B0 task card. Empty arrays are marked `// unverified` and mean no real DSH
 * package name is known yet.
 *
 * The `adapter` field names the CapabilityAdapter contract id for routing;
 * the `fallback` field is left empty until a concrete fallback adapter is
 * assigned in a later slice.
 */

const CATEGORIES = [
  { id: 'core', label: 'Core', hard: true },
  { id: 'ai-cap', label: 'AI Capabilities', hard: false },
  { id: 'editor', label: 'Editor', hard: false },
  { id: 'context', label: 'Context', hard: false },
  { id: 'security', label: 'Security', hard: false },
  { id: 'ops-ui', label: 'Ops & UI', hard: false },
  { id: 'external', label: 'External', hard: false },
];

const ENTRIES = [
  {
    id: 'mcp-manager',
    category: 'ai-cap',
    packageIds: ['dsh-mcp-manager'],
    capabilities: ['mcp.consume', 'mcp.serve'],
    required: false,
    adapter: 'mcp-manager',
    fallback: '',
    probe: { inventory: true },
    integrationMode: 'manual-assist',
    compatibility: 'unknown',
    reason: 'interface audit pending (G3)',
  },
  {
    id: 'skill-manager',
    category: 'ai-cap',
    packageIds: ['dsh-skill-manager'],
    capabilities: ['skill.manage', 'skill.run'],
    required: false,
    adapter: 'skill-manager',
    fallback: '',
    probe: { inventory: true },
    integrationMode: 'manual-assist',
    compatibility: 'unknown',
    reason: 'interface audit pending (G3)',
  },
  {
    id: 'plugin-marketplace',
    category: 'ops-ui',
    // dsh-plugin-marketplace is disabled in cordis.patch.yml; the installed
    // package name from the verified profile is dshmarket.
    packageIds: ['dshmarket'],
    capabilities: ['plugin.browse', 'plugin.install'],
    required: false,
    adapter: 'plugin-marketplace',
    fallback: '',
    probe: { inventory: true },
    integrationMode: 'manual-assist',
    compatibility: 'unknown',
    reason: 'interface audit pending (G3)',
  },
  {
    id: 'at-file',
    category: 'context',
    packageIds: ['dsh-at-file'],
    capabilities: ['context.file'],
    required: false,
    adapter: 'at-file',
    fallback: '',
    probe: { inventory: true },
    integrationMode: 'manual-assist',
    compatibility: 'unknown',
    reason: 'interface audit pending (G3)',
  },
  {
    id: 'git',
    category: 'editor',
    packageIds: [], // unverified: D-side has no standalone git plugin package in the verified list.
    capabilities: ['git.status', 'git.diff'],
    required: false,
    adapter: 'git',
    fallback: '',
    probe: { inventory: false },
    integrationMode: 'manual-assist',
    compatibility: 'unknown',
    reason: 'interface audit pending (G3)',
  },
  {
    id: 'test',
    category: 'editor',
    packageIds: ['@deepseek-ai/dsh-agent-loop-testkit'],
    capabilities: ['test.run', 'test.observe'],
    required: false,
    adapter: 'test',
    fallback: '',
    probe: { inventory: true },
    integrationMode: 'manual-assist',
    compatibility: 'unknown',
    reason: 'interface audit pending (G3)',
  },
  {
    id: 'checkpoint',
    category: 'context',
    packageIds: ['@deepseek-ai/dsh-session-checkpoint-policy'],
    capabilities: ['session.checkpoint'],
    required: false,
    adapter: 'checkpoint',
    fallback: '',
    probe: { inventory: true },
    integrationMode: 'manual-assist',
    compatibility: 'unknown',
    reason: 'interface audit pending (G3)',
  },
];

function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
  }
  return value;
}

function freezeCatalog(catalog) {
  return deepFreeze(catalog);
}

const CATALOG_CONTENT = {
  categories: CATEGORIES,
  entries: ENTRIES,
};

const PLUGIN_CATALOG = freezeCatalog({
  revision: schemaCatalogRevision(CATALOG_CONTENT),
  ...CATALOG_CONTENT,
});

// The internal catalog must satisfy the schema before it is exposed.
assertCatalog(PLUGIN_CATALOG);

function cloneEntry(entry) {
  return Object.freeze({
    ...entry,
    packageIds: Object.freeze([...entry.packageIds]),
    capabilities: Object.freeze([...entry.capabilities]),
    probe: Object.freeze({ ...entry.probe }),
  });
}

/**
 * Return a deep-frozen defensive copy of the plugin catalog.
 *
 * @returns {object} Frozen catalog object.
 */
function catalogSnapshot() {
  return Object.freeze({
    revision: PLUGIN_CATALOG.revision,
    categories: Object.freeze(PLUGIN_CATALOG.categories.map((category) => Object.freeze({ ...category }))),
    entries: Object.freeze(PLUGIN_CATALOG.entries.map((entry) => cloneEntry(entry))),
  });
}

/**
 * Find entries that provide a capability id.
 *
 * @param {string} capabilityId - Capability id, e.g. `mcp.consume`.
 * @returns {object[]} Frozen entry copies that provide the capability.
 */
function byCapability(capabilityId) {
  if (typeof capabilityId !== 'string') return [];
  return catalogSnapshot().entries.filter((entry) => entry.capabilities.includes(capabilityId));
}

/**
 * Find entries whose packageIds include the given package id.
 *
 * @param {string} packageId - DSH package id, e.g. `dsh-mcp-manager`.
 * @returns {object[]} Frozen entry copies that reference the package.
 */
function byPackage(packageId) {
  if (typeof packageId !== 'string') return [];
  return catalogSnapshot().entries.filter((entry) => entry.packageIds.includes(packageId));
}

/**
 * Find all entries in a category.
 *
 * @param {string} categoryId - Category id, e.g. `ai-cap`.
 * @returns {object[]} Frozen entry copies in the category.
 */
function entriesForCategory(categoryId) {
  if (typeof categoryId !== 'string') return [];
  return catalogSnapshot().entries.filter((entry) => entry.category === categoryId);
}

/**
 * Stable revision of the plugin catalog content.
 *
 * @returns {string} Lowercase hexadecimal SHA-256.
 */
function catalogRevision() {
  return PLUGIN_CATALOG.revision;
}

module.exports = {
  PLUGIN_CATALOG,
  byCapability,
  byPackage,
  catalogRevision,
  catalogSnapshot,
  entriesForCategory,
};
