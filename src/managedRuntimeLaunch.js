'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MANAGED_PROFILE = 'web';
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

function assertValidProfileName(profileName) {
  if (typeof profileName !== 'string' || !PROFILE_NAME_PATTERN.test(profileName)) {
    const error = new Error(`Managed DSH profile name must match ${PROFILE_NAME_PATTERN.source}`);
    error.code = 'CONFIG_PROFILE_INVALID';
    throw error;
  }
  return profileName;
}

function samePath(left, right, platform = process.platform) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

/**
 * Normalize the verified runtime hand-off consumed by ServerManager.
 * RuntimeResolver owns hash verification; this seam rejects PATH lookup and
 * profile/home drift before a child can be spawned.
 */
function normalizeResolvedRuntime(input, platform = process.platform) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Managed DSH runtime has not been resolved');
  }
  const executablePath = input.executablePath;
  const dshHome = input.dshHome;
  const profileName = input.profileName === undefined ? MANAGED_PROFILE : input.profileName;
  const profileHome = input.profileHome;
  const entrypointArgs = input.entrypointArgs === undefined ? [] : input.entrypointArgs;
  if (typeof executablePath !== 'string' || !path.isAbsolute(executablePath)) {
    throw new Error('Managed DSH executablePath must be absolute; PATH lookup is forbidden');
  }
  if (typeof dshHome !== 'string' || !path.isAbsolute(dshHome)) {
    throw new Error('Managed DSH dshHome must be absolute');
  }
  assertValidProfileName(profileName);
  const expectedProfileHome = path.join(path.resolve(dshHome), 'profiles', profileName);
  if (typeof profileHome !== 'string' || !path.isAbsolute(profileHome)) {
    const error = new Error('Managed DSH profileHome must be absolute');
    error.code = 'CONFIG_PROFILE_INVALID';
    throw error;
  }
  if (!samePath(profileHome, expectedProfileHome, platform)) {
    const error = new Error(`Managed DSH profileHome does not match dshHome/profiles/${profileName}`);
    error.code = 'CONFIG_PROFILE_INVALID';
    throw error;
  }
  if (!Array.isArray(entrypointArgs) || entrypointArgs.length > 1) {
    throw new Error('Managed DSH entrypointArgs must contain at most one verified script path');
  }
  const normalizedArgs = entrypointArgs.map((value) => {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) {
      throw new Error('Managed DSH entrypoint argument must be an absolute verified script path');
    }
    if (input.payloadRoot !== undefined) {
      if (typeof input.payloadRoot !== 'string' || !path.isAbsolute(input.payloadRoot)) {
        throw new Error('Managed DSH payloadRoot must be absolute');
      }
      const relative = path.relative(path.resolve(input.payloadRoot), path.resolve(value));
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('Managed DSH entrypoint argument escapes payloadRoot');
      }
    }
    return path.resolve(value);
  });
  return Object.freeze({
    executablePath: path.resolve(executablePath),
    dshHome: path.resolve(dshHome),
    profileHome: path.resolve(profileHome),
    profileName,
    entrypointArgs: Object.freeze(normalizedArgs),
    ...(input.payloadRoot === undefined ? {} : { payloadRoot: path.resolve(input.payloadRoot) }),
  });
}

function assertLaunchableRuntime(runtime, platform = process.platform) {
  const stat = fs.lstatSync(runtime.executablePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Managed DSH executable must be a verified regular file');
  }
  if (platform === 'win32') {
    if (path.extname(runtime.executablePath).toLowerCase() !== '.exe') {
      throw new Error('Managed DSH runtime on Windows requires a native .exe entrypoint');
    }
  } else if ((stat.mode & 0o111) === 0) {
    throw new Error('Managed DSH runtime entrypoint is not executable');
  }
}

function assertEmbedPatchPath(patchPath) {
  if (typeof patchPath !== 'string' || !path.isAbsolute(patchPath)) {
    throw new Error('embed patchPath must be an absolute path');
  }
  if (patchPath.includes('\0')) {
    throw new Error('embed patchPath must not contain NUL');
  }
  const stat = fs.lstatSync(patchPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('embed patchPath must be a verified regular file');
  }
}

function buildManagedLaunchSpec(runtimeInput, host, port, platform = process.platform, options = {}) {
  const runtime = normalizeResolvedRuntime(runtimeInput, platform);
  if (host !== '127.0.0.1') {
    throw new Error('Managed DSH launch requires loopback host 127.0.0.1');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Managed DSH launch port must be an integer from 1 to 65535');
  }
  assertLaunchableRuntime(runtime, platform);
  const { patchPath } = options || {};
  const patchArgs = [];
  if (patchPath !== undefined) {
    assertEmbedPatchPath(patchPath);
    patchArgs.push('--patch', path.resolve(patchPath));
  }
  return Object.freeze({
    command: runtime.executablePath,
    args: Object.freeze([
      ...runtime.entrypointArgs,
      ...patchArgs,
      '--profile', runtime.profileName,
      '--host', host,
      '--port', String(port),
    ]),
    env: Object.freeze({
      DSH_HOME: runtime.dshHome,
      DSH_TEXT_EDITOR: 'vscode',
    }),
    windowsHide: platform === 'win32',
    detached: platform !== 'win32',
  });
}

module.exports = {
  MANAGED_PROFILE,
  PROFILE_NAME_PATTERN,
  assertValidProfileName,
  assertLaunchableRuntime,
  buildManagedLaunchSpec,
  normalizeResolvedRuntime,
};
