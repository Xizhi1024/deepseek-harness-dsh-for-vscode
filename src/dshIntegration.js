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
 * Install the extension-owned DSH dual-half integration package beneath the
 * selected DSH home. Only a fixed allow-list of files is copied from the VSIX.
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
  for (const relative of INTEGRATION_FILES) {
    const source = path.join(sourceRoot, ...relative.split('/'));
    if (!existsSync(source)) throw new Error(`DSH integration asset is missing: ${relative}`);
    atomicCopy(source, path.join(packageRoot, ...relative.split('/')), options);
  }
  return Object.freeze({ nodeModulesPath, packageRoot });
}

module.exports = {
  INTEGRATION_FILES,
  INTEGRATION_PACKAGE_NAME,
  installDshIntegration,
};
