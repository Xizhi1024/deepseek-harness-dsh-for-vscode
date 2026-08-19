"use strict";

/**
 * DSH version compatibility flags (plan §4 single source of truth).
 *
 * The resolver reports the installed DSH version; these flags describe which
 * optional integration surfaces that version understands. Negotiation still
 * rules at runtime (bridge initialize.methods, URL params ignored silently);
 * flags only inform diagnostics and documentation, never gate behavior
 * switches (D11 verdict).
 */

/** Minimum DSH version that accepts --patch overlay startup. @type {string} */
const PATCH_OVERLAY_MIN = "0.1.0";

/** Minimum DSH version that reads the dsh_theme URL parameter. @type {string} */
const THEME_PARAM_MIN = "0.1.0";

/** Minimum DSH version whose bridge advertises v3 tool methods. @type {string} */
const TOOLS_V3_MIN = "0.1.0";

/**
 * Parse a semver-ish string ("1.2.3", "0.1.0-rc.7") into comparable parts.
 * Pre-release/build suffixes are ignored; each core part must be numeric.
 *
 * @param {string} version - Raw version string.
 * @returns {{major: number, minor: number, patch: number}|null} Null when not parseable.
 */
function parseVersionParts(version) {
  if (typeof version !== "string") return null;
  const core = version.trim().split("-")[0].split("+")[0];
  const parts = core.split(".");
  if (parts.length !== 3) return null;
  const numeric = [];
  for (const part of parts) {
    if (part.length === 0 || !/^[0-9]+$/.test(part)) return null;
    numeric.push(Number(part));
  }
  return { major: numeric[0], minor: numeric[1], patch: numeric[2] };
}

/**
 * Compare two version strings by numeric parts only (suffixes ignored).
 *
 * @param {string} left - Left version.
 * @param {string} right - Right version.
 * @returns {number} Negative when left < right, 0 when equal, positive when left > right; NaN when either is unparseable.
 */
function compareVersions(left, right) {
  const a = parseVersionParts(left);
  const b = parseVersionParts(right);
  if (a === null || b === null) return Number.NaN;
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * Derive integration capability flags from an installed DSH version.
 *
 * @param {string|null|undefined} dshVersion - Version reported by the runtime resolver (may be null when unknown).
 * @returns {{known: boolean, patchOverlay: boolean, themeParam: boolean, toolsV3: boolean}}
 *   All flags false with known=false when the version is missing or unparseable.
 */
function deriveFeatureFlags(dshVersion) {
  if (parseVersionParts(dshVersion) === null) {
    return { known: false, patchOverlay: false, themeParam: false, toolsV3: false };
  }
  const atLeast = (min) => compareVersions(dshVersion, min) >= 0;
  return {
    known: true,
    patchOverlay: atLeast(PATCH_OVERLAY_MIN),
    themeParam: atLeast(THEME_PARAM_MIN),
    toolsV3: atLeast(TOOLS_V3_MIN),
  };
}

module.exports = { deriveFeatureFlags };
