'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { assertValidProfileName } = require('../managedRuntimeLaunch');
const { runtimeCompatibility, portError } = require('./compatibility');

const PATH_FIELDS = Object.freeze(['executablePath', 'entrypoint', 'packageRoot', 'home']);
const IDENTITY_FIELDS = Object.freeze(['runtimeVersion', 'integrationVersion', 'adapterId', ...PATH_FIELDS, 'profile', 'source']);

/** Construct the public, secret-free immutable identity of one explicit selection. */
function createRuntimeIdentity(input) {
  if (!input || typeof input !== 'object') throw portError('INVALID_ARGUMENT', 'A resolved runtime identity is required.');
  const compatibility = runtimeCompatibility(input.runtimeVersion);
  if (!compatibility.adapterId || input.adapterId !== compatibility.adapterId) {
    throw portError('UNSUPPORTED_RUNTIME', 'Select an exact DSH version with a matching adapter.');
  }
  if (typeof input.integrationVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(input.integrationVersion)) {
    throw portError('INVALID_ARGUMENT', 'A concrete integration version is required.');
  }
  if (!['managed', 'local', 'command'].includes(input.source)) throw portError('INVALID_ARGUMENT', 'Invalid runtime source.');
  try { assertValidProfileName(input.profile); } catch { throw portError('INVALID_ARGUMENT', 'Invalid runtime profile.'); }
  const value = Object.fromEntries(IDENTITY_FIELDS.map((name) => [name, input[name]]));
  for (const name of PATH_FIELDS) {
    if (typeof value[name] !== 'string' || !path.isAbsolute(value[name]) || value[name].includes('\0')) {
      throw portError('INVALID_ARGUMENT', `Runtime ${name} must be an absolute path.`);
    }
    value[name] = path.resolve(value[name]);
  }
  const relative = path.relative(value.packageRoot, value.entrypoint);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw portError('INVALID_ARGUMENT', 'The runtime entrypoint must be inside its package root.');
  }
  return Object.freeze(value);
}

function runtimeIdentityKey(identity, platform = process.platform) {
  const value = createRuntimeIdentity(identity);
  return JSON.stringify(IDENTITY_FIELDS.map((name) => PATH_FIELDS.includes(name) && platform === 'win32'
    ? value[name].toLowerCase() : value[name]));
}

function identityToResolvedRuntime(input) {
  const identity = createRuntimeIdentity(input);
  return Object.freeze({
    executablePath: identity.executablePath, entrypointArgs: Object.freeze([identity.entrypoint]), packageRoot: identity.packageRoot,
    dshHome: identity.home, profileHome: path.join(identity.home, 'profiles', identity.profile),
    profileName: identity.profile, dshVersion: identity.runtimeVersion,
  });
}

/** Validate the actual package manifest at the resolved boundary, without guessing "lib" is the package root. */
async function createRuntimeIdentityFromResolved(runtime, { integrationVersion, source = 'local', readFile = fs.promises.readFile } = {}) {
  const entrypoint = runtime?.entrypointArgs?.[0];
  if (typeof entrypoint !== 'string' || !path.isAbsolute(entrypoint)) {
    throw portError('UNSUPPORTED_RUNTIME', 'The target adapter requires a verified Node CLI entrypoint.');
  }
  const candidates = runtime.packageRoot ? [runtime.packageRoot] : [];
  if (!candidates.length) {
    let directory = path.dirname(entrypoint);
    for (let depth = 0; depth < 4; depth++) {
      candidates.push(directory);
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  for (const packageRoot of candidates) {
    let manifest;
    try { manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')); }
    catch { continue; }
    if (manifest.name !== '@deepseek-ai/dsh') continue;
    if (manifest.version !== runtime.dshVersion) throw portError('CONFLICT', 'Resolved DSH version differs from its package manifest.');
    const adapter = runtimeCompatibility(runtime.dshVersion);
    return createRuntimeIdentity({ runtimeVersion: runtime.dshVersion, integrationVersion, adapterId: adapter.adapterId,
      executablePath: runtime.executablePath, entrypoint, packageRoot, home: runtime.dshHome, profile: runtime.profileName, source });
  }
  throw portError('UNSUPPORTED_RUNTIME', 'The selected DSH package manifest could not be verified.');
}

module.exports = { createRuntimeIdentity, createRuntimeIdentityFromResolved, runtimeIdentityKey, identityToResolvedRuntime };
