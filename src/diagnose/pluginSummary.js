'use strict';

/**
 * Synchronous diagnostic summary over the plugin catalog.
 *
 * `buildPluginSummary` walks every catalog entry through the detector's
 * synchronous `detectSync` seam and counts the resulting states. This is a
 * pure function with respect to the detector: all I/O is encapsulated in the
 * injected detector/probes.
 */

/**
 * Build a summary of plugin detection states.
 *
 * @param {object} options - Summary options.
 * @param {object} options.detector - Detector returned by createPluginDetector.
 * @param {string} [options.home] - DSH home path; empty/undefined makes profile probes report unknown.
 * @returns {object} Summary object with revision, scanned count, and state counts.
 */
function buildPluginSummary({ detector, home }) {
  const catalogEntries =
    detector && detector.catalog && Array.isArray(detector.catalog.entries)
      ? detector.catalog.entries
      : [];
  const homePath = typeof home === 'string' ? home : '';

  const states = {
    active: 0,
    disabled: 0,
    absent: 0,
    unknown: 0,
  };

  for (const entry of catalogEntries) {
    const detected = detector.detectSync(entry.id, homePath);
    switch (detected.state) {
      case 'active':
        states.active += 1;
        break;
      case 'installed-disabled':
        states.disabled += 1;
        break;
      case 'absent':
        states.absent += 1;
        break;
      default:
        states.unknown += 1;
        break;
    }
  }

  return {
    revision: detector && detector.catalog ? detector.catalog.revision : '',
    scanned: catalogEntries.length,
    states,
  };
}

module.exports = {
  buildPluginSummary,
};
