'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { ServerError, ServerManager } = require('./serverManager');
const { MANAGED_PROFILE } = require('./managedRuntimeLaunch');
const { STARTUP_ERRORS } = require('./startupErrors');
const {
  executableSettingPackageRoots,
  shimDiscoveredPackageRoots,
  windowsPathPackageCandidates,
  windowsGlobalLayoutCandidates,
} = require('./shimResolver');

function unique(values, platform) {
  const seen = new Set();
  return values.filter((value) => {
    if (!value) return false;
    const resolved = path.resolve(value);
    const key = platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isConfiguredPathAbsolute(value, platform) {
  if (platform === 'win32') return /^[A-Za-z]:[\\/]/.test(value);
  return path.posix.isAbsolute(value);
}

function packageCandidates(env, platform) {
  const candidates = [];
  if (env.NPM_CONFIG_PREFIX) {
    candidates.push(platform === 'win32'
      ? path.join(env.NPM_CONFIG_PREFIX, 'node_modules', '@deepseek-ai', 'dsh')
      : path.join(env.NPM_CONFIG_PREFIX, 'lib', 'node_modules', '@deepseek-ai', 'dsh'));
  }
  if (platform === 'win32' && env.APPDATA) {
    candidates.push(path.join(env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh'));
  }
  if (platform === 'win32') {
    // The npm prefix may be ANY directory on PATH (custom prefixes, pnpm's
    // %LOCALAPPDATA%\pnpm, scoop shims, portable layouts): the shim sits
    // directly in the prefix while node_modules sits inside it (or inside
    // the parent for <prefix>/bin layouts). This mirrors the POSIX PATH
    // scan below and fixes GUI-launched VS Code missing shell-only setups.
    candidates.push(...windowsPathPackageCandidates(env));
    candidates.push(...windowsGlobalLayoutCandidates(env).sync);
    // Volta keeps one directory per installed package version under
    // tools/image/packages/<scope>/<name>/<version>; enumerate them so any
    // installed dsh image is reachable without executing volta itself.
    for (const root of windowsGlobalLayoutCandidates(env).voltaRoots) {
      try {
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
          if (entry.isDirectory()) candidates.push(path.join(root, entry.name));
        }
      } catch {
        // Volta not installed or no dsh package image — skip silently.
      }
    }
  }
  if (platform !== 'win32') {
    candidates.push(
      '/usr/local/lib/node_modules/@deepseek-ai/dsh',
      '/usr/lib/node_modules/@deepseek-ai/dsh',
      '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh'
    );
    // npm globals live under the prefix that owns each PATH entry
    // (`<prefix>/bin` on PATH → `<prefix>/lib/node_modules`), so a shell PATH
    // different from VS Code's own still contributes prefixes.
    for (const segment of String(env.Path || env.PATH || '').split(path.delimiter)) {
      const bin = segment.trim();
      if (bin) candidates.push(path.resolve(bin, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh'));
    }
  }
  candidates.push(...versionManagerPackageCandidates(env, platform));
  return unique(candidates, platform);
}

function addVersionManagerRoot(roots, candidate) {
  if (!candidate) return;
  if (roots.some((existing) => ServerManager.samePath(existing, candidate))) return;
  roots.push(candidate);
}

function versionManagerRoots(env, platform) {
  const roots = [];
  const home = env.HOME || (platform === 'win32' ? env.USERPROFILE : '') || '';
  if (platform === 'win32') {
    if (env.LOCALAPPDATA) {
      addVersionManagerRoot(roots, path.join(env.LOCALAPPDATA, '.volta', 'tools', 'image', 'node'));
      addVersionManagerRoot(roots, path.join(env.LOCALAPPDATA, 'fnm', 'node-versions'));
    }
    if (env.APPDATA) {
      addVersionManagerRoot(roots, path.join(env.APPDATA, 'fnm', 'node-versions'));
      addVersionManagerRoot(roots, path.join(env.APPDATA, 'nvm'));
    }
    if (env.NVM_HOME) addVersionManagerRoot(roots, env.NVM_HOME);
  } else if (home) {
    addVersionManagerRoot(roots, path.join(env.NVM_DIR || path.join(home, '.nvm'), 'versions', 'node'));
    addVersionManagerRoot(roots, path.join(home, '.asdf', 'installs', 'nodejs'));
    addVersionManagerRoot(roots, path.join(home, '.volta', 'tools', 'image', 'node'));
    addVersionManagerRoot(roots, '/usr/local/n/versions/node');
    addVersionManagerRoot(roots, path.join(home, 'Library', 'Application Support', 'fnm', 'node-versions'));
    addVersionManagerRoot(roots, path.join(home, '.local', 'share', 'fnm', 'node-versions'));
  }
  return roots;
}

// Enumerate every installed version directory under each version-manager root,
// youngest first, and call cb with the per-version root path. Shared by the
// package and node candidate layers so both stay in lock-step.
function forEachVersionRoot(roots, cb) {
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    const versions = entries.filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareVersionNamesDesc);
    for (const version of versions) {
      cb(path.join(root, version));
    }
  }
}

function versionManagerPackageCandidates(env, platform) {
  const candidates = [];
  forEachVersionRoot(versionManagerRoots(env, platform), (versionRoot) => {
    // nvm/asdf/n/Volta keep globals in <version>/lib; fnm adds an
    // `installation` layer. Windows nvm can also use a direct
    // `<version>/node_modules` layout, covered by the NVM_SYMLINK fallback.
    candidates.push(
      path.join(versionRoot, 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
      path.join(versionRoot, 'installation', 'lib', 'node_modules', '@deepseek-ai', 'dsh')
    );
  });
  if (platform === 'win32' && env.NVM_SYMLINK) {
    const current = env.NVM_SYMLINK;
    candidates.push(
      path.join(current, 'node_modules', '@deepseek-ai', 'dsh'),
      path.join(current, 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
      path.join(current, 'installation', 'lib', 'node_modules', '@deepseek-ai', 'dsh')
    );
  }
  return unique(candidates, platform);
}

function versionManagerNodeCandidates(env, platform) {
  // Version-manager node binaries are a win32 convenience; on POSIX the
  // paired binary is found by the colocated <version>/bin walk, so confine
  // this layer to win32 and keep POSIX candidates equal to the classic set.
  if (platform !== 'win32') return [];
  const candidates = [];
  if (env.NVM_SYMLINK) {
    candidates.push(
      path.join(env.NVM_SYMLINK, 'node.exe'),
      path.join(env.NVM_SYMLINK, 'bin', 'node.exe')
    );
  }
  if (env.LOCALAPPDATA) {
    candidates.push(path.join(env.LOCALAPPDATA, '.volta', 'bin', 'node.exe'));
  }
  forEachVersionRoot(versionManagerRoots(env, platform), (versionRoot) => {
    candidates.push(
      path.join(versionRoot, 'node.exe'),
      path.join(versionRoot, 'bin', 'node.exe'),
      path.join(versionRoot, 'installation', 'node.exe')
    );
  });
  return unique(candidates, platform);
}

function compareVersionNamesDesc(a, b) {
  const as = a.match(/\d+/g) || [];
  const bs = b.match(/\d+/g) || [];
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const delta = (Number(bs[i]) || 0) - (Number(as[i]) || 0);
    if (delta) return delta;
  }
  return b.localeCompare(a);
}

function nodeCandidates(env, platform) {
  const executable = platform === 'win32' ? 'node.exe' : 'node';
  const candidates = [];
  if (platform === 'win32' && env.ProgramFiles) {
    candidates.push(path.join(env.ProgramFiles, 'nodejs', executable));
  }
  candidates.push(...versionManagerNodeCandidates(env, platform));
  for (const segment of String(env.Path || env.PATH || '').split(path.delimiter)) {
    if (segment.trim()) candidates.push(path.join(segment.trim(), executable));
  }
  return unique(candidates, platform);
}

function colocatedNodeCandidates(packageRoot, executable) {
  const candidates = [];
  let dir = path.resolve(packageRoot);
  for (let depth = 0; depth < 6; depth++) {
    dir = path.dirname(dir);
    if (dir === path.dirname(dir)) break;
    candidates.push(path.join(dir, 'bin', executable));
  }
  return candidates;
}

async function realRegularFile(candidate, label) {
  let resolved;
  try {
    resolved = await fs.promises.realpath(candidate);
    const stat = await fs.promises.stat(resolved);
    if (!stat.isFile()) return null;
  } catch {
    return null;
  }
  if (!path.isAbsolute(resolved) || resolved.includes('\0')) {
    throw new Error(`${label} resolved to an invalid path`);
  }
  return resolved;
}

async function firstRegularFile(candidates, label) {
  for (const candidate of candidates) {
    const resolved = await realRegularFile(candidate, label);
    if (resolved) return resolved;
  }
  return null;
}

function safePackageEntrypoint(packageRoot, packageJson) {
  const bin = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.dsh;
  if (typeof bin !== 'string' || bin.trim() === '' || bin.includes('\0')) {
    throw new Error('Official @deepseek-ai/dsh package has no dsh executable entry');
  }
  const root = path.resolve(packageRoot);
  const entry = path.resolve(root, ...bin.replace(/\\/g, '/').split('/'));
  const relative = path.relative(root, entry);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Official @deepseek-ai/dsh executable escapes its package root');
  }
  return entry;
}

async function resolveLocalDshRuntime({
  dshHome,
  packageRoot = '',
  nodePath = '',
  executablePath = '',
  platform = process.platform,
  env = process.env,
} = {}) {
  if (typeof dshHome !== 'string' || !path.isAbsolute(dshHome)) {
    throw new Error('Local DSH dshHome must be absolute');
  }
  if (packageRoot && !isConfiguredPathAbsolute(packageRoot, platform)) {
    const error = new Error('dsh.local.packageRoot must be absolute (Windows drive-letter path on win32)');
    error.code = 'CONFIG_PACKAGE_ROOT_INVALID';
    error.params = { path: packageRoot };
    throw error;
  }
  if (nodePath && !isConfiguredPathAbsolute(nodePath, platform)) {
    const error = new Error('dsh.local.nodePath must be absolute (Windows drive-letter path on win32)');
    error.code = 'CONFIG_NODE_PATH_INVALID';
    error.params = { path: nodePath };
    throw error;
  }
  if (executablePath && !isConfiguredPathAbsolute(executablePath, platform)) {
    const error = new Error('dsh.executablePath must be absolute (Windows drive-letter path on win32)');
    error.code = 'CONFIG_EXECUTABLE_PATH_INVALID';
    error.params = { path: executablePath };
    throw error;
  }

  // The selected DSH home is independent from the npm installation. Create it
  // even when DSH itself is still missing so shared/isolated selection is
  // stable from the first activation onward.
  const resolvedHome = path.resolve(dshHome);
  await fs.promises.mkdir(resolvedHome, { recursive: true });

  // Explicit user input wins: dsh.local.packageRoot and dsh.executablePath
  // (package dir, lib/bin.js, or a Windows shim file) are honored first and
  // exclusively. Without explicit input, Windows additionally probes the
  // authoritative shim-discovery layer (PATH dsh.cmd parsing) before the
  // static layout guesses so pnpm/yarn/custom-prefix installs resolve.
  const explicitRoots = [];
  if (packageRoot) explicitRoots.push(packageRoot);
  if (executablePath) {
    const normalized = await executableSettingPackageRoots(executablePath, { platform });
    if (normalized.error) {
      throw new ServerError(
        `The configured dsh.executablePath could not be interpreted (${normalized.error}): ${executablePath}`,
        { path: executablePath },
        'CONFIG_EXECUTABLE_PATH_INVALID'
      );
    }
    explicitRoots.push(...normalized.packageRoots);
  }
  const shimRoots = explicitRoots.length === 0 && platform === 'win32'
    ? await shimDiscoveredPackageRoots(env)
    : [];
  const roots = explicitRoots.length > 0
    ? explicitRoots
    : [...shimRoots, ...packageCandidates(env, platform)];
  let resolvedPackageRoot = null;
  let packageJson = null;
  for (const candidate of roots) {
    const manifestPath = await firstRegularFile([path.join(candidate, 'package.json')], 'DSH package manifest');
    if (!manifestPath) continue;
    let parsed;
    try {
      parsed = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
    } catch {
      // A9: an unreadable/corrupt manifest must not abort the whole scan —
      // skip to the next candidate instead of failing resolution outright.
      continue;
    }
    if (parsed.name !== '@deepseek-ai/dsh') continue;
    resolvedPackageRoot = await fs.promises.realpath(path.dirname(manifestPath));
    packageJson = parsed;
    break;
  }
  if (!resolvedPackageRoot) {
    if (packageRoot) {
      throw new ServerError(
        `The configured dsh.local.packageRoot does not contain the official @deepseek-ai/dsh package: ${packageRoot}`,
        { path: packageRoot },
        'CONFIG_PACKAGE_ROOT_INVALID'
      );
    }
    if (executablePath) {
      throw new ServerError(
        `The configured dsh.executablePath does not resolve to the official @deepseek-ai/dsh package: ${executablePath}`,
        { path: executablePath },
        'CONFIG_EXECUTABLE_PATH_INVALID'
      );
    }
    throw new ServerError(
      STARTUP_ERRORS.RUNTIME_NOT_INSTALLED.template,
      {},
      'RUNTIME_NOT_INSTALLED'
    );
  }

  const entrypoint = await realRegularFile(
    safePackageEntrypoint(resolvedPackageRoot, packageJson),
    'DSH executable entry'
  );
  if (!entrypoint) throw new ServerError('The installed official DSH package is incomplete');

  // The prefix that owns the DSH package usually owns a matching Node binary in
  // its own `bin/` (nvm/fnm/asdf/n/Homebrew layouts). Prefer that pairing over
  // a PATH scan so a GUI-launched VS Code without the shell PATH still finds Node.
  const nodeExecutable = platform === 'win32' ? 'node.exe' : 'node';
  const resolvedNodeExecutable = await firstRegularFile(
    nodePath
      ? [nodePath]
      : [
          ...(platform === 'win32' ? [] : colocatedNodeCandidates(resolvedPackageRoot, nodeExecutable)),
          ...nodeCandidates(env, platform)
        ],
    'Node.js executable'
  );
  if (!resolvedNodeExecutable) {
    if (nodePath) {
      throw new ServerError(
        `The configured dsh.local.nodePath is not a usable Node.js executable: ${nodePath}`,
        { path: nodePath },
        'CONFIG_NODE_PATH_INVALID'
      );
    }
    throw new ServerError(
      STARTUP_ERRORS.RUNTIME_NODE_MISSING.template,
      {},
      'RUNTIME_NODE_MISSING'
    );
  }

  return Object.freeze({
    executablePath: resolvedNodeExecutable,
    entrypointArgs: Object.freeze([entrypoint]),
    dshHome: resolvedHome,
    profileHome: path.join(resolvedHome, 'profiles', MANAGED_PROFILE),
    profileName: MANAGED_PROFILE,
    source: 'local-official-package',
    dshVersion: typeof packageJson.version === 'string' ? packageJson.version : null,
  });
}

/**
 * A9 (issue #5): best-effort DSH package version discovery near a resolved
 * command hit (a POSIX symlink script or a Windows .exe, where no package
 * manifest is directly known). Resolves symlinks, then walks up from the
 * hit's directory checking both a direct package.json and the npm global
 * layout <ancestor>/node_modules/@deepseek-ai/dsh/package.json at each
 * level. Never throws; returns the version string or null.
 *
 * @param {string} filePath - The resolved command path.
 * @param {object} [seams] - Optional test seams.
 * @param {Function} [seams.readFile] - async (path) => string.
 * @param {Function} [seams.realpath] - async (path) => string.
 * @returns {Promise<string|null>}
 */
async function detectDshVersionNear(filePath, { readFile, realpath } = {}) {
  const read = readFile || ((candidate) => fs.promises.readFile(candidate, 'utf8'));
  const resolveReal = realpath || ((candidate) => fs.promises.realpath(candidate));
  try {
    const absolute = path.resolve(String(filePath));
    const real = await resolveReal(absolute).catch(() => absolute);
    let dir = path.dirname(path.resolve(real));
    for (let depth = 0; depth < 6; depth++) {
      for (const manifestPath of [
        path.join(dir, 'package.json'),
        path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
      ]) {
        try {
          const parsed = JSON.parse(await read(manifestPath));
          if (
            parsed && parsed.name === '@deepseek-ai/dsh'
            && typeof parsed.version === 'string' && parsed.version.length > 0
          ) {
            return parsed.version;
          }
        } catch {
          // try the next layout/ancestor
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // best effort only — a null version degrades diagnostics, never launch
  }
  return null;
}

module.exports = {
  nodeCandidates,
  packageCandidates,
  resolveLocalDshRuntime,
  detectDshVersionNear,
};
