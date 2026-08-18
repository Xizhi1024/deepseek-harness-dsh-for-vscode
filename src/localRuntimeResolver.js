'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { ServerError, ServerManager } = require('./serverManager');
const { MANAGED_PROFILE } = require('./managedRuntimeLaunch');

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

function versionManagerPackageCandidates(env, platform) {
  const candidates = [];
  for (const root of versionManagerRoots(env, platform)) {
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
      const versionRoot = path.join(root, version);
      // nvm/asdf/n/Volta keep globals in <version>/lib; fnm adds an
      // `installation` layer. Windows nvm can also use a direct
      // `<version>/node_modules` layout, covered by the NVM_SYMLINK fallback.
      candidates.push(
        path.join(versionRoot, 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
        path.join(versionRoot, 'installation', 'lib', 'node_modules', '@deepseek-ai', 'dsh')
      );
    }
  }
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
  const executable = platform === 'win32' ? 'node.exe' : 'node';
  const candidates = [];
  if (platform === 'win32' && env.NVM_SYMLINK) {
    candidates.push(
      path.join(env.NVM_SYMLINK, executable),
      path.join(env.NVM_SYMLINK, 'bin', executable)
    );
  }
  if (platform === 'win32' && env.LOCALAPPDATA) {
    candidates.push(path.join(env.LOCALAPPDATA, '.volta', 'bin', executable));
  }
  for (const root of versionManagerRoots(env, platform)) {
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
      const versionRoot = path.join(root, version);
      candidates.push(
        path.join(versionRoot, executable),
        path.join(versionRoot, 'bin', executable),
        path.join(versionRoot, 'installation', executable)
      );
    }
  }
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
  platform = process.platform,
  env = process.env,
} = {}) {
  if (typeof dshHome !== 'string' || !path.isAbsolute(dshHome)) {
    throw new Error('Local DSH dshHome must be absolute');
  }
  if (packageRoot && !isConfiguredPathAbsolute(packageRoot, platform)) {
    const error = new Error('dsh.local.packageRoot must be absolute (Windows drive-letter path on win32)');
    error.code = 'CONFIG_PACKAGE_ROOT_INVALID';
    throw error;
  }
  if (nodePath && !isConfiguredPathAbsolute(nodePath, platform)) {
    const error = new Error('dsh.local.nodePath must be absolute (Windows drive-letter path on win32)');
    error.code = 'CONFIG_NODE_PATH_INVALID';
    throw error;
  }

  // The selected DSH home is independent from the npm installation. Create it
  // even when DSH itself is still missing so shared/isolated selection is
  // stable from the first activation onward.
  const resolvedHome = path.resolve(dshHome);
  await fs.promises.mkdir(resolvedHome, { recursive: true });

  const roots = packageRoot ? [packageRoot] : packageCandidates(env, platform);
  let resolvedPackageRoot = null;
  let packageJson = null;
  for (const candidate of roots) {
    const manifestPath = await firstRegularFile([path.join(candidate, 'package.json')], 'DSH package manifest');
    if (!manifestPath) continue;
    const parsed = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
    if (parsed.name !== '@deepseek-ai/dsh') continue;
    resolvedPackageRoot = await fs.promises.realpath(path.dirname(manifestPath));
    packageJson = parsed;
    break;
  }
  if (!resolvedPackageRoot) {
    if (packageRoot) {
      throw new ServerError(
        `The configured dsh.local.packageRoot does not contain the official @deepseek-ai/dsh package: ${packageRoot}`,
        {},
        'CONFIG_PACKAGE_ROOT_INVALID'
      );
    }
    throw new ServerError(
      'Official DSH is not installed. Install it with `npm install -g @deepseek-ai/dsh`, then reload VS Code; the extension will create or reuse the selected DSH home automatically.'
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
  const executablePath = await firstRegularFile(
    nodePath
      ? [nodePath]
      : [
          ...(platform === 'win32' ? [] : colocatedNodeCandidates(resolvedPackageRoot, nodeExecutable)),
          ...nodeCandidates(env, platform)
        ],
    'Node.js executable'
  );
  if (!executablePath) {
    if (nodePath) {
      throw new ServerError(
        `The configured dsh.local.nodePath is not a usable Node.js executable: ${nodePath}`,
        {},
        'CONFIG_NODE_PATH_INVALID'
      );
    }
    throw new ServerError(
      'Node.js was not found for the installed DSH package. Set dsh.local.nodePath to the absolute Node executable path.'
    );
  }

  return Object.freeze({
    executablePath,
    entrypointArgs: Object.freeze([entrypoint]),
    dshHome: resolvedHome,
    profileHome: path.join(resolvedHome, 'profiles', MANAGED_PROFILE),
    profileName: MANAGED_PROFILE,
    source: 'local-official-package',
    dshVersion: typeof packageJson.version === 'string' ? packageJson.version : null,
  });
}

module.exports = {
  nodeCandidates,
  packageCandidates,
  resolveLocalDshRuntime,
};
