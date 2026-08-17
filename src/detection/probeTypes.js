'use strict';

/**
 * Probe type constants for the 0.6 detection layer.
 *
 * ProbeSource is the strategy that produced a result:
 *   'inventory' | 'settings' | 'profile' | 'behavior'
 *
 * ProbeResult is the frozen result object:
 *   { source, state: 'active'|'installed-disabled'|'absent'|'unknown', detail: string }
 */

const PROBE_SOURCES = Object.freeze(['inventory', 'settings', 'profile', 'behavior']);
const PROBE_STATES = Object.freeze(['active', 'installed-disabled', 'absent', 'unknown']);

/**
 * Create a frozen ProbeResult.
 *
 * @param {string} source - One of PROBE_SOURCES.
 * @param {string} state - One of PROBE_STATES.
 * @param {string} detail - Human-readable detail.
 * @returns {object} Frozen ProbeResult.
 */
function probeResult(source, state, detail) {
  if (!PROBE_SOURCES.includes(source)) {
    throw new TypeError(`probe source must be one of: ${PROBE_SOURCES.join(', ')}`);
  }
  if (!PROBE_STATES.includes(state)) {
    throw new TypeError(`probe state must be one of: ${PROBE_STATES.join(', ')}`);
  }
  if (typeof detail !== 'string') {
    throw new TypeError('probe detail must be a string');
  }
  return Object.freeze({ source, state, detail });
}

module.exports = {
  PROBE_SOURCES,
  PROBE_STATES,
  probeResult,
};
