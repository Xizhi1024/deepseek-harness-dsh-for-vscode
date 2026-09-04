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
 * Oldest DSH runtime this extension supports (the --no-open spawn floor;
 * older runtimes exit before the health probe runs). @type {string}
 */
const SUPPORTED_DSH_MIN = "0.1.0-rc.7";

/**
 * First DSH runtime whose per-session projection cache seeds cold
 * session.list rows (upstream cdb4cc3c68..49df707c86, shipped in
 * 0.1.2-alpha.1). Below it, cold rows may serve without the projections
 * column and titles fall back to bare session ids until an explicit
 * session.rename lands. @type {string}
 */
const PROJECTION_CACHE_MIN = "0.1.2-alpha.1";

/**
 * First DSH runtime with server module HMR opt-in — no shipped profile
 * reloads source modules (upstream fd814589fb, shipped in 0.1.2-alpha.1).
 * Below it, overwriting plugin files under the profile's node_modules
 * while a window runtime is live can break every tool call in that window
 * ("Cannot read properties of undefined (reading 'kind')") until restart;
 * the extension's content-aware integration sync is the guard.
 * @type {string}
 */
const MODULE_HMR_OPTIN_MIN = "0.1.2-alpha.1";

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

/** Prerelease rank: alpha < beta < rc (semver); a plain release outranks all. */
const PRERELEASE_RANK = { alpha: 0, beta: 1, rc: 2 };

/**
 * Compare two DSH version strings (core triple + optional -alpha.N /
 * -beta.N / -rc.N prerelease) with full prerelease ordering: within one
 * core, alpha.N < beta.N < rc.N < the plain release. Unlike the coarse
 * compareVersions above, this distinguishes 0.1.0-rc.6 from 0.1.0-rc.7,
 * which the supported-runtime floor needs.
 *
 * @param {string} left - Left version.
 * @param {string} right - Right version.
 * @returns {number|null} Negative when left < right, 0 when equal, positive when left > right; null when either is unparseable.
 */
function compareDshVersions(left, right) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/.exec(String(value || '').trim());
    if (!match) return null;
    return {
      core: match.slice(1, 4).map(Number),
      pre: match[4] === undefined ? null : { rank: PRERELEASE_RANK[match[4]], n: Number(match[5]) },
    };
  };
  const a = parse(left);
  const b = parse(right);
  if (a === null || b === null) return null;
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
  }
  if (a.pre === null && b.pre === null) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  if (a.pre.rank !== b.pre.rank) return a.pre.rank - b.pre.rank;
  return a.pre.n - b.pre.n;
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

/**
 * Derive runtime-issue flags for DSH versions whose known upstream defects
 * affect this extension's surfaces (session-5f3403fe verification against
 * upstream master 49a606bc5b / 0.1.2-alpha.5, 2026-09-02).
 *
 * exportDoublePrefix: the runtime names session export archives
 * 'dsh-session-' + full sessionId; ids already start with 'session-',
 * so downloads save as dsh-session-session-<uuid>.zip. Not fixed in any
 * released runtime (still present in 0.1.2-alpha.5); diagnostics-only -
 * the extension passes session ids through untouched.
 *
 * sparseProjectionTitles: below PROJECTION_CACHE_MIN, cold session.list
 * rows may omit the projections column entirely, so the sidebar shows bare
 * UUIDs until the one-shot titler renames the session.
 *
 * moduleHmrWindowCrash: below MODULE_HMR_OPTIN_MIN, shipped profiles
 * reload source modules on file change; the integration sync must stay
 * content-aware (byte-identical files never trigger a reload).
 *
 * @param {string|null|undefined} dshVersion - Version reported by the runtime resolver (may be null when unknown).
 * @returns {{known: boolean, supported: boolean, exportDoublePrefix: boolean, sparseProjectionTitles: boolean, moduleHmrWindowCrash: boolean}}
 *   All false with known=false when the version is missing or unparseable
 *   (supported mirrors the parse result: an unparseable version is never
 *   reported as unsupported - negotiation and spawn self-heal own that
 *   decision).
 */
function deriveRuntimeIssues(dshVersion) {
  if (parseVersionParts(dshVersion) === null) {
    return {
      known: false,
      supported: false,
      exportDoublePrefix: false,
      sparseProjectionTitles: false,
      moduleHmrWindowCrash: false,
    };
  }
  return {
    known: true,
    supported: compareDshVersions(dshVersion, SUPPORTED_DSH_MIN) >= 0,
    // No released runtime fixes the double-prefix export naming yet.
    exportDoublePrefix: true,
    sparseProjectionTitles: compareVersions(dshVersion, PROJECTION_CACHE_MIN) < 0,
    moduleHmrWindowCrash: compareVersions(dshVersion, MODULE_HMR_OPTIN_MIN) < 0,
  };
}

module.exports = {
  deriveFeatureFlags,
  deriveRuntimeIssues,
  compareDshVersions,
  SUPPORTED_DSH_MIN,
  PROJECTION_CACHE_MIN,
  MODULE_HMR_OPTIN_MIN,
};
