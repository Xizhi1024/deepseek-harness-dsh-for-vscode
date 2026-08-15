'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { ServerError } = require('./serverManager');
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
      '/usr/lib/node_modules/@deepseek-ai/dsh'
    );
  }
  return unique(candidates, platform);
}

function nodeCandidates(env, platform) {
  const executable = platform === 'win32' ? 'node.exe' : 'node';
  const candidates = [];
  if (platform === 'win32' && env.ProgramFiles) {
    candidates.push(path.join(env.ProgramFiles, 'nodejs', executable));
  }
  for (const segment of String(env.Path || env.PATH || '').split(path.delimiter)) {
    if (segment.trim()) candidates.push(path.join(segment.trim(), executable));
  }
  return unique(candidates, platform);
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
  if (packageRoot && !path.isAbsolute(packageRoot)) {
    throw new Error('dsh.local.packageRoot must be absolute');
  }
  if (nodePath && !path.isAbsolute(nodePath)) {
    throw new Error('dsh.local.nodePath must be absolute');
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
    throw new ServerError(
      'Official DSH is not installed. Install it with `npm install -g @deepseek-ai/dsh`, then reload VS Code; the extension will create or reuse the selected DSH home automatically.'
    );
  }

  const entrypoint = await realRegularFile(
    safePackageEntrypoint(resolvedPackageRoot, packageJson),
    'DSH executable entry'
  );
  if (!entrypoint) throw new ServerError('The installed official DSH package is incomplete');

  const executablePath = await firstRegularFile(
    nodePath ? [nodePath] : nodeCandidates(env, platform),
    'Node.js executable'
  );
  if (!executablePath) {
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
