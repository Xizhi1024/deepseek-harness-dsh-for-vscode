'use strict';

/**
 * featureRegistry.js — R25 layered feature registry with fault isolation.
 *
 * Every feature component registers through one registry; setupAll() executes
 * features layer by layer (L0 → L1 → L2), in registration order inside a
 * layer, and isolates each setup behind its own try/catch:
 *
 *  - a throwing setup is recorded as { id, error, at } (error = stringified
 *    real error including the first stack line, at = ISO timestamp) and never
 *    bubbles to the caller — non-core components degrade only themselves;
 *  - L0 features are the lifeline: they ignore `dsh.features.<id>` entirely
 *    (never switchable) and are executed first with zero dependency on L1/L2
 *    output;
 *  - L1/L2 features are skipped when `getFeatureSetting(id)` returns false
 *    (status 'disabled'); an undefined setting falls back to
 *    `defaultEnabled`;
 *  - every successful setup may return a teardown; dispose() runs these in
 *    reverse setup order so shared resources are released LIFO.
 *
 * deps passed to setupAll/setup are `{ context, services }`: `context` is the
 * VS Code ExtensionContext, `services` a shared plain object that L0 features
 * publish handles into (e.g. the ServerManager) for L1/L2 consumers.
 */

const LAYERS = ['L0', 'L1', 'L2'];

/**
 * Stringify a caught error for the failures record without guessing: the real
 * Error message plus its first stack line when one is available; non-Error
 * throws degrade to String(value).
 * @param {unknown} error - Any thrown value.
 * @returns {string} Stable, human-readable representation.
 */
function stringifyError(error) {
  if (error instanceof Error) {
    const stack = typeof error.stack === 'string' && error.stack.length > 0
      ? error.stack.split('\n')[0]
      : '';
    return stack || (error.message ? error.message : String(error));
  }
  if (error && typeof error === 'object' && typeof error.message === 'string') {
    return error.message;
  }
  return String(error);
}

/**
 * Create one feature registry.
 *
 * @param {object} options
 * @param {(id: string) => boolean|undefined} [options.getFeatureSetting] -
 *   Reads `dsh.features.<id>`; false disables an L1/L2 feature, undefined
 *   falls back to its `defaultEnabled`. Never consulted for L0 features.
 * @param {(record: {id: string, error: string, at: string}) => void} [options.onFeatureFailure] -
 *   Observer called with each failure record (surfaced once as a warning).
 * @returns {object} { register, setupAll, dispose, failures }.
 */
function createFeatureRegistry({ getFeatureSetting, onFeatureFailure } = {}) {
  /** @type {Array<{feature: object, teardown: (() => unknown|Promise<unknown>)|null}>} */
  const registered = [];

  /** @type {Array<{id: string, error: string, at: string}>} */
  const failures = [];

  /**
   * Register one feature. The feature shape is frozen by the R25 contract:
   * { id, label, layer, defaultEnabled, core, setup }.
   * @param {object} feature - Feature descriptor.
   */
  function register(feature) {
    if (!feature || typeof feature !== 'object') {
      throw new TypeError('feature must be an object');
    }
    if (typeof feature.id !== 'string' || feature.id.length === 0) {
      throw new TypeError('feature.id must be a non-empty string');
    }
    if (!LAYERS.includes(feature.layer)) {
      throw new TypeError('feature.layer must be one of ' + LAYERS.join('/'));
    }
    if (typeof feature.setup !== 'function') {
      throw new TypeError('feature ' + feature.id + ': setup must be a function');
    }
    if (registered.some((entry) => entry.feature.id === feature.id)) {
      throw new Error('feature already registered: ' + feature.id);
    }
    registered.push({ feature, teardown: null });
  }

  /**
   * Run one feature setup, honoring the layer gating rules.
   * @param {{feature: object, teardown: (() => unknown)|null}} entry
   * @param {{context: object, services: object}} deps
   * @returns {Promise<{id: string, status: 'ok'|'disabled'}>}
   */
  async function runFeature(entry, deps) {
    const feature = entry.feature;
    if (feature.layer !== 'L0') {
      const setting = typeof getFeatureSetting === 'function' ? getFeatureSetting(feature.id) : undefined;
      const enabled = setting === undefined ? feature.defaultEnabled : Boolean(setting);
      if (!enabled) {
        return { id: feature.id, status: 'disabled' };
      }
    }
    const cleanup = await feature.setup(deps);
    if (typeof cleanup === 'function') {
      entry.teardown = cleanup;
    }
    return { id: feature.id, status: 'ok' };
  }

  /**
   * Execute all registered features: L0 → L1 → L2, registration order inside
   * each layer. A throwing setup never bubbles; it is recorded and reported
   * through onFeatureFailure while the remaining features keep running.
   *
   * @param {{context: object, services: object}} deps - Shared dependencies.
   * @returns {Promise<Array<{id: string, status: 'ok'|'disabled'|'failed', detail?: string}>>}
   *   One result per registered feature, in execution order.
   */
  async function setupAll(deps) {
    const results = [];
    for (const layer of LAYERS) {
      for (const entry of registered) {
        if (entry.feature.layer !== layer) {
          continue;
        }
        try {
          results.push(await runFeature(entry, deps));
        } catch (error) {
          const record = {
            id: entry.feature.id,
            error: stringifyError(error),
            at: new Date().toISOString(),
          };
          failures.push(record);
          if (typeof onFeatureFailure === 'function') {
            try {
              onFeatureFailure(record);
            } catch (_) {
              // an observer must never break the setupAll loop
            }
          }
          results.push({ id: entry.feature.id, status: 'failed', detail: record.error });
        }
      }
    }
    return results;
  }

  /**
   * Run every successful setup's teardown in reverse setup order (LIFO).
   * Per-teardown failures are contained so dispose() never throws and the
   * remaining teardowns still run.
   * @returns {Promise<void>}
   */
  async function dispose() {
    const withTeardown = registered.filter((entry) => typeof entry.teardown === 'function');
    for (let i = withTeardown.length - 1; i >= 0; i -= 1) {
      const entry = withTeardown[i];
      try {
        await entry.teardown();
      } catch (_) {
        // a failing teardown must not prevent the remaining ones from running
      }
      entry.teardown = null;
    }
  }

  return Object.freeze({
    register,
    setupAll,
    dispose,
    /** Live failures array (status reporting channel, e.g. for dsh.diagnose). */
    failures,
  });
}

module.exports = { createFeatureRegistry, stringifyError, LAYERS };
