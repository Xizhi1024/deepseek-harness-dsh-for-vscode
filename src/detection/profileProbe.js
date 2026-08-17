'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { probeResult } = require('./probeTypes');

/**
 * Read-only L3 profile probe.
 *
 * Input: { dshHome, packageId }
 * Reads `$DSH_HOME/profiles/web/package.json` and `cordis.patch.yml`.
 *
 * Semantics:
 * - patch entry with `disabled: true` for the package -> 'installed-disabled'
 * - declared in dependencies and no disabled patch entry -> 'unknown'
 *   (runtime active state cannot be confirmed at L3)
 * - both files exist and no declaration -> 'absent'
 * - missing home/files or any read/parse error -> 'unknown'
 *
 * This probe never throws.
 */

/**
 * Extract whether a patch entry id has `disabled: true` using simple line
 * parsing. This intentionally does not depend on a YAML library.
 *
 * @param {string} patchText - Contents of cordis.patch.yml.
 * @param {string} packageId - Package id to look for.
 * @returns {boolean} True when the entry has disabled: true.
 */
function hasDisabledPatchEntry(patchText, packageId) {
  const lines = patchText.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s*-\s*id:\s*["']?([^"'\s]+)["']?\s*(#.*)?$/);
    if (!match || match[1] !== packageId) continue;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (/^\s*-\s*id:/.test(line)) break;
      const disabledMatch = line.match(/^\s*disabled:\s*(true|false)\s*(#.*)?$/);
      if (disabledMatch) return disabledMatch[1] === 'true';
    }
    return false;
  }
  return false;
}

/**
 * Probe the web profile for a package.
 *
 * @param {{dshHome: string, packageId: string}} input - Probe input.
 * @returns {object} Frozen ProbeResult.
 */
function profileProbe({ dshHome, packageId }) {
  try {
    if (typeof dshHome !== 'string' || dshHome.length === 0) {
      return probeResult('profile', 'unknown', 'dshHome is missing or not a string');
    }
    if (typeof packageId !== 'string' || packageId.length === 0) {
      return probeResult('profile', 'unknown', 'packageId is missing or not a string');
    }

    const webProfileDir = path.join(dshHome, 'profiles', 'web');
    const packageJsonPath = path.join(webProfileDir, 'package.json');
    const patchPath = path.join(webProfileDir, 'cordis.patch.yml');

    const packageText = fs.readFileSync(packageJsonPath, 'utf8');
    const patchText = fs.readFileSync(patchPath, 'utf8');

    const packageJson = JSON.parse(packageText);
    const dependencies =
      packageJson && typeof packageJson.dependencies === 'object' && packageJson.dependencies !== null
        ? packageJson.dependencies
        : {};

    const declared = Object.prototype.hasOwnProperty.call(dependencies, packageId);
    const disabled = hasDisabledPatchEntry(patchText, packageId);

    if (disabled) {
      return probeResult(
        'profile',
        'installed-disabled',
        `${packageId} is disabled in cordis.patch.yml`
      );
    }
    if (declared) {
      return probeResult(
        'profile',
        'unknown',
        `${packageId} is declared in dependencies; runtime active state cannot be confirmed at L3`
      );
    }
    return probeResult(
      'profile',
      'absent',
      `${packageId} is not declared in profiles/web/package.json or cordis.patch.yml`
    );
  } catch (error) {
    return probeResult(
      'profile',
      'unknown',
      `profile probe error: ${error && error.message ? error.message : String(error)}`
    );
  }
}

module.exports = {
  hasDisabledPatchEntry,
  profileProbe,
};
