'use strict';

/**
 * Adapter contract for the 0.6 capability layer.
 *
 * A CapabilityAdapter owns the integration for one capability id. The base
 * class is intentionally minimal: attach/detach are idempotent and probe has
 * a safe default. Concrete adapters override `capabilityId` and may override
 * `probe`/`attach`/`detach`.
 */

const AdapterState = Object.freeze({
  DETACHED: 'detached',
  ATTACHING: 'attaching',
  ATTACHED: 'attached',
  DEGRADED: 'degraded',
});

class CapabilityAdapter {
  /**
   * Capability id handled by this adapter. Subclasses must override.
   *
   * @type {string|null}
   */
  static capabilityId = null;

  constructor() {
    this._attached = false;
    this._surface = null;
    this.capabilityId = this.constructor.capabilityId || null;
  }

  /**
   * Attach the adapter to a surface. Idempotent: a second attach is a no-op.
   *
   * @param {object} surface - Host surface supplied by the integration layer.
   * @returns {void}
   */
  attach(surface) {
    if (this._attached) return;
    this._surface = surface;
    this._attached = true;
  }

  /**
   * Detach the adapter. Idempotent.
   *
   * @returns {void}
   */
  detach() {
    this._attached = false;
    this._surface = null;
  }

  /**
   * Probe the adapter's readiness against a surface.
   *
   * @param {object} [_surface] - Surface to probe.
   * @returns {{ok: boolean}} Default result; concrete adapters may enrich it.
   */
  probe(_surface) {
    return { ok: true };
  }
}

class NullAdapter extends CapabilityAdapter {
  /**
   * @type {string|null}
   */
  static capabilityId = null;

  /**
   * @param {string} capabilityId - Capability id this null adapter stands in for.
   */
  constructor(capabilityId) {
    super();
    this.capabilityId = capabilityId;
  }

  attach() {
    // No-op by contract.
  }

  detach() {
    // No-op by contract.
  }

  probe() {
    return {};
  }
}

/**
 * Create a NullAdapter for a capability id. All methods are no-ops or return
 * empty/default results.
 *
 * @param {string} capabilityId - Capability id.
 * @returns {NullAdapter} Null adapter instance.
 */
function nullAdapter(capabilityId) {
  return new NullAdapter(capabilityId);
}

module.exports = {
  AdapterState,
  CapabilityAdapter,
  NullAdapter,
  nullAdapter,
};
