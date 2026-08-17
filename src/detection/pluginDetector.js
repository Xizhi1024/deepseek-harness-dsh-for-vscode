'use strict';

const { probeResult } = require('./probeTypes');
const { profileProbe } = require('./profileProbe');

/**
 * Plugin detector for the 0.6 catalog.
 *
 * This module is the detection seam required by the synchronous diagnostic
 * consumer: `buildPluginSummary` and the existing `providerDetector`
 * `diagnosticSnapshot` are synchronous, so the factory also exports
 * `detectSync`. `detect()` remains the contract's primary async interface and
 * is implemented as `Promise.resolve(detectSync(entryId))`.
 *
 * Detected state machine:
 * - `active` only when at least one inventory/behavior probe reports active;
 *   effective is true only in this state.
 * - otherwise `installed-disabled` if any evidence says installed-disabled.
 * - otherwise `absent` if any evidence says absent.
 * - otherwise `unknown` (never effective).
 * - a throwing probe makes the entry `failed` (never effective).
 *
 * Cache key is `dshHome + '\0' + catalogRevision`. The same entry id uses one
 * in-flight Promise so concurrent `detect()` calls share work.
 */

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

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

/**
 * Create a plugin detector.
 *
 * The factory accepts either a catalog object or a zero-argument catalog
 * snapshot function for callers that pass `catalog: catalogSnapshot`.
 *
 * @param {object} options - Detector options.
 * @param {object|Function} options.catalog - Plugin catalog object or catalogSnapshot() function.
 * @param {Function[]} [options.probes] - Probe functions; defaults to [profileProbe].
 * @param {Function} [options.now] - Timestamp provider for invalidate().
 * @param {string} [options.home] - DSH home path used by profile probes.
 * @returns {object} Detector handle.
 */
function createPluginDetector({
  catalog,
  probes = [profileProbe],
  now = () => new Date().toISOString(),
  home = '',
} = {}) {
  const sourceCatalog = typeof catalog === 'function' ? catalog() : catalog;
  const resolvedCatalog = isRecord(sourceCatalog) && Array.isArray(sourceCatalog.entries) ? sourceCatalog : {
    revision: '',
    categories: [],
    entries: [],
  };
  const revision = typeof resolvedCatalog.revision === 'string' ? resolvedCatalog.revision : '';
  let dshHome = typeof home === 'string' ? home : '';

  const cache = new Map();
  const inflight = new Map();
  let lastInvalidation = null;

  function cacheKeyFor(homePath) {
    return `${homePath}\u0000${revision}`;
  }

  /**
   * Detect one entry synchronously.
   *
   * @param {string} entryId - Catalog entry id.
   * @param {string} [homeOverride] - Optional home override; defaults to detector home.
   * @returns {object} Frozen Detected result.
   */
  function detectSync(entryId, homeOverride) {
    const effectiveHome = typeof homeOverride === 'string' ? homeOverride : dshHome;
    const currentKey = cacheKeyFor(effectiveHome);
    const cached = cache.get(entryId);
    if (cached && cached.key === currentKey) {
      return cached.detected;
    }

    const entry = resolvedCatalog.entries.find((candidate) => candidate.id === entryId);
    if (!entry) {
      const detected = deepFreeze({
        entryId,
        state: 'unknown',
        evidence: [],
        effective: false,
      });
      cache.set(entryId, { key: currentKey, detected });
      return detected;
    }

    const evidence = [];
    let probeError = null;

    for (const packageId of entry.packageIds) {
      for (const probe of probes) {
        try {
          const result = probe({ dshHome: effectiveHome, packageId });
          if (result && typeof result === 'object') {
            evidence.push(result);
          }
        } catch (error) {
          probeError = error;
          evidence.push(
            probeResult(
              'profile',
              'unknown',
              `probe error: ${error && error.message ? error.message : String(error)}`
            )
          );
        }
      }
    }

    let state = 'unknown';
    let effective = false;
    if (probeError) {
      state = 'failed';
    } else if (evidence.some((item) => (item.source === 'inventory' || item.source === 'behavior') && item.state === 'active')) {
      state = 'active';
      effective = true;
    } else if (evidence.some((item) => item.state === 'installed-disabled')) {
      state = 'installed-disabled';
    } else if (evidence.some((item) => item.state === 'absent')) {
      state = 'absent';
    }

    const detected = deepFreeze({
      entryId,
      state,
      evidence,
      effective,
    });
    cache.set(entryId, { key: currentKey, detected });
    return detected;
  }

  /**
   * Detect one entry asynchronously.
   *
   * @param {string} entryId - Catalog entry id.
   * @param {{signal?: AbortSignal}} [options] - Optional options.
   * @returns {Promise<object>} Promise resolving to a frozen Detected result.
   */
  function detect(entryId, { signal } = {}) {
    if (signal && signal.aborted) {
      return Promise.resolve(
        deepFreeze({ entryId, state: 'unknown', evidence: [], effective: false })
      );
    }
    if (inflight.has(entryId)) return inflight.get(entryId);
    const promise = Promise.resolve()
      .then(() => detectSync(entryId))
      .finally(() => inflight.delete(entryId));
    inflight.set(entryId, promise);
    return promise;
  }

  /**
   * Invalidate the detector cache.
   *
   * @param {string} reason - Reason for invalidation.
   * @returns {void}
   */
  function invalidate(reason) {
    cache.clear();
    inflight.clear();
    lastInvalidation = { reason, at: now() };
  }

  /**
   * Build a deep-frozen snapshot of every catalog entry's detected state.
   *
   * @returns {object} Snapshot object.
   */
  function snapshot() {
    return deepFreeze({
      dshHome,
      revision,
      entries: resolvedCatalog.entries.map((entry) => detectSync(entry.id)),
    });
  }

  return {
    catalog: resolvedCatalog,
    detect,
    detectSync,
    invalidate,
    get lastInvalidation() {
      return lastInvalidation;
    },
    snapshot,
  };
}

module.exports = {
  createPluginDetector,
};
