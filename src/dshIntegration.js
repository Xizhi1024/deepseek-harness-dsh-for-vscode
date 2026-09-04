'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { assertValidProfileName, MANAGED_PROFILE } = require('./managedRuntimeLaunch');

const INTEGRATION_PACKAGE_NAME = 'dsh-vscode-integration';
const INTEGRATION_FILES = Object.freeze([
  'package.json',
  'lib/index.js',
  'lib/client.js',
  'lib/tools.js',
  'lib/lmRoute.js',
  'lib/fimRoutes.js',
  'lib/linkRoutes.js',
  'lib/compatSessionRoutes.js',
  'lib/editObserver.js',
]);
// Records which extension version last owned the synced package directory.
// See installDshIntegration: several installed/dev versions of this extension
// share one DSH home, and each version only knows ITS file list — without the
// marker, mixed-version bytes accumulate in the same directory (live incident
// 2026-09-04: every tool call on freshly spawned runtimes failed with
// "Cannot read properties of undefined (reading 'kind')" after an installed
// 0.9.x/1.0.x activation rewrote 5 of the 8 dev-version files).
const SYNC_MARKER_NAME = '.vscode-sync.json';

function requireAbsolute(value, label) {
  if (typeof value !== 'string' || value.length === 0 || !path.isAbsolute(value)) {
    throw new Error(`${label} must be a non-empty absolute path`);
  }
  return path.resolve(value);
}

function toPosix(value) {
  return String(value).replace(/\\/g, '/');
}

function atomicCopy(source, destination, operations = {}) {
  const {
    mkdirSync = fs.mkdirSync,
    readFileSync = fs.readFileSync,
    writeFileSync = fs.writeFileSync,
    renameSync = fs.renameSync,
    chmodSync = fs.chmodSync,
  } = operations;
  mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  writeFileSync(temporary, readFileSync(source), { mode: 0o600 });
  renameSync(temporary, destination);
  try { chmodSync(destination, 0o600); } catch { /* Windows ACLs */ }
}

/**
 * True when source and destination hold identical bytes. Missing or
 * unreadable destinations read as "different" so the copy still happens.
 *
 * @param {string} source - Absolute source path.
 * @param {string} destination - Absolute destination path.
 * @param {Function} readFileSync - Read seam (injectable in tests).
 * @returns {boolean} True when the bytes match.
 */
function contentEquals(source, destination, readFileSync) {
  try {
    return readFileSync(source).equals(readFileSync(destination));
  } catch {
    return false;
  }
}

/**
 * Read the syncing extension's own version (package.json beside its entry
 * source). Returns null when unavailable — the caller then keeps the legacy
 * incremental behavior and writes no marker.
 */
function readExtensionVersion(extensionRoot, readFileSync) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'));
    return parsed && typeof parsed.version === 'string' && parsed.version.length > 0
      ? parsed.version
      : null;
  } catch {
    return null;
  }
}

/**
 * Enumerate every regular file under root (recursively; unreadable
 * directories are skipped). Used only by the foreign-file sweep.
 */
function listFilesUnder(root, readdirSync) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(root);
  return out;
}

/**
 * Install the extension-owned DSH dual-half integration package beneath the
 * selected DSH home. Only a fixed allow-list of files is copied from the VSIX.
 *
 * Bytes-identical destinations are SKIPPED: rewriting unchanged plugin
 * files under a live DSH instance (shared home, symlinked profile) forces
 * cordis-plugin-hmr reloads whose window breaks every in-flight tool call
 * (live incident 2026-09-03: F5 activation rewrote all 7 lib files, and
 * during the reload window every tool - run_code included - failed with
 * "Cannot read properties of undefined (reading 'kind')"). Real content
 * changes still land (and reload) exactly as before.
 *
 * Multi-version guard (2026-09-04 follow-up): a `.vscode-sync.json` marker
 * records the extension version that last owned the directory. When another
 * version (installed release, older/newer dev build) owns it — or the marker
 * is missing while files exist — every file NOT in this version's allow-list
 * is removed BEFORE the copy, so the directory can never hold a mixed-version
 * byte set. The sweep only ever touches the extension-owned package
 * directory; result.foreignRemoved lists what went.
 */
function installDshIntegration(dshHome, extensionPath, options = {}) {
  const home = requireAbsolute(dshHome, 'DSH home');
  const extension = requireAbsolute(extensionPath, 'Extension path');
  const profileName = options.profileName === undefined ? MANAGED_PROFILE : options.profileName;
  assertValidProfileName(profileName);
  const sourceRoot = path.join(extension, 'runtime-integration', INTEGRATION_PACKAGE_NAME);
  const nodeModulesPath = path.join(home, 'profiles', profileName, 'node_modules');
  const packageRoot = path.join(nodeModulesPath, INTEGRATION_PACKAGE_NAME);
  const {
    existsSync = fs.existsSync,
    readFileSync = fs.readFileSync,
    writeFileSync = fs.writeFileSync,
    renameSync = fs.renameSync,
    mkdirSync = fs.mkdirSync,
    readdirSync = fs.readdirSync,
    unlinkSync = fs.unlinkSync,
  } = options;
  const extensionVersion = readExtensionVersion(extension, readFileSync);
  const markerPath = path.join(packageRoot, SYNC_MARKER_NAME);
  const allowedFiles = new Set(INTEGRATION_FILES);

  let versionChanged = false;
  const foreignRemoved = [];
  if (extensionVersion && existsSync(path.join(packageRoot, 'package.json'))) {
    let marker = null;
    if (existsSync(markerPath)) {
      try {
        marker = JSON.parse(readFileSync(markerPath, 'utf8'));
      } catch {
        marker = null;
      }
    }
    if (!marker || marker.syncedBy !== extensionVersion) {
      versionChanged = true;
      for (const file of listFilesUnder(packageRoot, readdirSync)) {
        const relative = toPosix(path.relative(packageRoot, file));
        if (allowedFiles.has(relative) || relative === SYNC_MARKER_NAME) continue;
        try {
          unlinkSync(file);
          foreignRemoved.push(relative);
        } catch {
          // best-effort sweep: an undeletable foreign file must not block sync
        }
      }
    }
  }

  let copied = 0;
  let skipped = 0;
  for (const relative of INTEGRATION_FILES) {
    const source = path.join(sourceRoot, ...relative.split('/'));
    if (!existsSync(source)) throw new Error(`DSH integration asset is missing: ${relative}`);
    const destination = path.join(packageRoot, ...relative.split('/'));
    if (existsSync(destination) && contentEquals(source, destination, readFileSync)) {
      skipped += 1;
      continue;
    }
    atomicCopy(source, destination, options);
    copied += 1;
  }

  if (extensionVersion) {
    const temporary = `${markerPath}.${process.pid}.tmp`;
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(temporary, JSON.stringify({ syncedBy: extensionVersion }, null, 2) + '\n');
    renameSync(temporary, markerPath);
  }

  return Object.freeze({
    nodeModulesPath,
    packageRoot,
    copied,
    skipped,
    versionChanged,
    foreignRemoved: Object.freeze(foreignRemoved),
  });
}

module.exports = {
  INTEGRATION_FILES,
  INTEGRATION_PACKAGE_NAME,
  SYNC_MARKER_NAME,
  installDshIntegration,
};
