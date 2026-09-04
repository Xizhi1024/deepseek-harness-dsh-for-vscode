'use strict';

const fs = require('node:fs');
const path = require('node:path');

// 2026-09-04 incident: a marketplace / plugin-manager operation can leave
// `dsh.profile.bundles` entries whose package is installed neither in the
// profile's node_modules nor in the dsh installation (the orphan was
// "dsh-mermaid" while only "@dsh-external/dsh-mermaid" existed). dsh's
// resolveBundleDir throws on the first unresolvable name and every spawn
// dies with exit 1 before the health probe ever runs — from the sidebar
// this looks like "DSH process exited early (code=1)" with nothing else to
// go on. The guard mirrors the runtime's resolution order (profile
// node_modules, then the dsh package's own node_modules) and strips orphan
// entries from the manifest before a spawn, backing the original up once.

const DSH_PACKAGE_NAME = '@deepseek-ai/dsh';

/**
 * Walk up from a dsh entrypoint (executablePath or an entrypoint argument)
 * to the @deepseek-ai/dsh package directory. Bounded so a misplaced binary
 * cannot walk to the filesystem root.
 *
 * @param {string} startPath - Absolute path inside or below the package.
 * @param {object} [fsOps] - Injectable fs seams for tests.
 * @returns {string|null} Package root directory, or null when not found.
 */
function resolveDshPackageRoot(startPath, fsOps = {}) {
  const {
    existsSync = fs.existsSync,
    readFileSync = fs.readFileSync,
  } = fsOps;
  if (typeof startPath !== 'string' || !path.isAbsolute(startPath)) return null;
  let dir = path.dirname(path.resolve(startPath));
  for (let i = 0; i < 10; i += 1) {
    const manifest = path.join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
        if (parsed && parsed.name === DSH_PACKAGE_NAME) return dir;
      } catch {
        // unreadable manifest: keep walking up
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Bundle names from `dsh.profile.bundles` that resolve neither to a package
 * in the profile's node_modules nor to an in-box package under the dsh
 * installation. Non-string entries are reported as unresolvable too: they
 * crash profile boot the same way, and the manifest rewrite drops them.
 *
 * @param {object} options
 * @param {string} options.profileHome - Profile directory (~/.dsh/profiles/<name>).
 * @param {string|null} [options.dshPackageRoot] - @deepseek-ai/dsh package dir.
 * @param {object} [options.fsOps] - Injectable fs seams for tests.
 * @returns {{orphans: string[], bundles: string[]}|null} Null when the
 *   manifest is absent or has no bundle list (nothing to guard).
 */
function findUnresolvableBundles({ profileHome, dshPackageRoot = null, fsOps = {} } = {}) {
  const { existsSync = fs.existsSync, readFileSync = fs.readFileSync } = fsOps;
  if (typeof profileHome !== 'string' || profileHome.length === 0) return null;
  const manifestPath = path.join(profileHome, 'package.json');
  if (!existsSync(manifestPath)) return null;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    // A corrupt manifest is dshmarket/CLI territory; this guard must not
    // "repair" JSON it cannot parse.
    return null;
  }
  const bundles = manifest && manifest.dsh && manifest.dsh.profile
    ? manifest.dsh.profile.bundles
    : undefined;
  if (!Array.isArray(bundles)) return null;
  const resolvable = (name) => {
    if (typeof name !== 'string' || name.length === 0 || name.includes('\0')) return false;
    if (existsSync(path.join(profileHome, 'node_modules', ...name.split('/'), 'package.json'))) return true;
    if (dshPackageRoot !== null && typeof dshPackageRoot === 'string') {
      return existsSync(path.join(dshPackageRoot, 'node_modules', ...name.split('/'), 'package.json'));
    }
    // Without a resolved installation root the official in-box namespace
    // (@deepseek-ai/*) cannot be proven missing — the runtime resolves those
    // from its own install, and stripping one would break a bootable profile.
    // Stay conservative: only third-party names are provable orphans here.
    return name.startsWith('@deepseek-ai/');
  };
  return { orphans: bundles.filter((name) => !resolvable(name)), bundles };
}

/**
 * Pre-spawn guard: remove unresolvable bundle entries from the profile
 * manifest so the next dsh boot cannot die on resolveBundleDir. The original
 * manifest is backed up once (`.bak-dshext-bundles`); the rewrite is atomic
 * (tmp file + rename). Never touches dependencies or any other field.
 *
 * @param {object} options
 * @param {string} options.dshHome - DSH home directory.
 * @param {string} options.profileName - Profile directory name under it.
 * @param {string} [options.executablePath] - dsh entrypoint, used to locate
 *   the installation's in-box packages.
 * @param {object} [options.fsOps] - Injectable fs seams for tests.
 * @returns {{applied: boolean, reason?: string, removed?: string[],
 *   manifestPath?: string, backupPath?: string}}
 */
function ensureResolvableBundles({ dshHome, profileName, executablePath = null, fsOps = {} } = {}) {
  const {
    existsSync = fs.existsSync,
    readFileSync = fs.readFileSync,
    writeFileSync = fs.writeFileSync,
    renameSync = fs.renameSync,
    copyFileSync = fs.copyFileSync,
  } = fsOps;
  if (typeof dshHome !== 'string' || dshHome.length === 0) {
    throw new TypeError('ensureResolvableBundles requires dshHome');
  }
  if (typeof profileName !== 'string' || profileName.length === 0) {
    throw new TypeError('ensureResolvableBundles requires profileName');
  }
  const profileHome = path.join(dshHome, 'profiles', profileName);
  const dshPackageRoot = executablePath ? resolveDshPackageRoot(executablePath, fsOps) : null;
  const found = findUnresolvableBundles({ profileHome, dshPackageRoot, fsOps });
  if (found === null) return { applied: false, reason: 'no-bundles' };
  if (found.orphans.length === 0) return { applied: false, reason: 'clean', manifestPath: path.join(profileHome, 'package.json') };

  const manifestPath = path.join(profileHome, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const orphans = new Set(found.orphans);
  manifest.dsh.profile.bundles = found.bundles.filter((name) => !orphans.has(name));

  const backupPath = manifestPath + '.bak-dshext-bundles';
  if (!existsSync(backupPath)) {
    try {
      copyFileSync(manifestPath, backupPath);
    } catch {
      // best-effort backup: the atomic replace below is the real safety net
    }
  }
  const temporary = manifestPath + '.dshext-' + process.pid + '.tmp';
  writeFileSync(temporary, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  renameSync(temporary, manifestPath);
  return { applied: true, removed: [...found.orphans], manifestPath, backupPath };
}

module.exports = {
  DSH_PACKAGE_NAME,
  ensureResolvableBundles,
  findUnresolvableBundles,
  resolveDshPackageRoot,
};
