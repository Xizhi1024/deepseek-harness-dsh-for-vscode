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
  'lib/editObserver.js',
]);

function requireAbsolute(value, label) {
  if (typeof value !== 'string' || value.length === 0 || !path.isAbsolute(value)) {
    throw new Error(`${label} must be a non-empty absolute path`);
  }
  return path.resolve(value);
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
 */
function installDshIntegration(dshHome, extensionPath, options = {}) {
  const home = requireAbsolute(dshHome, 'DSH home');
  const extension = requireAbsolute(extensionPath, 'Extension path');
  const profileName = options.profileName === undefined ? MANAGED_PROFILE : options.profileName;
  assertValidProfileName(profileName);
  const sourceRoot = path.join(extension, 'runtime-integration', INTEGRATION_PACKAGE_NAME);
  const nodeModulesPath = path.join(home, 'profiles', profileName, 'node_modules');
  const packageRoot = path.join(nodeModulesPath, INTEGRATION_PACKAGE_NAME);
  const existsSync = options.existsSync || fs.existsSync;
  const readFileSync = options.readFileSync || fs.readFileSync;
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
  return Object.freeze({ nodeModulesPath, packageRoot, copied, skipped });
}

module.exports = {
  INTEGRATION_FILES,
  INTEGRATION_PACKAGE_NAME,
  installDshIntegration,
};
