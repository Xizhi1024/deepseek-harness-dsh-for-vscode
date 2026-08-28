'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { packageRootsFromShim } = require('./shimResolver');
const { nodeCandidates, detectDshVersionNear } = require('./localRuntimeResolver');
const { MANAGED_PROFILE } = require('./managedRuntimeLaunch');

/** Valid dsh.launch.method values. 'auto' = managed first, then command. */
const LAUNCH_METHODS = Object.freeze(['auto', 'managed', 'command']);

function normalizeLaunchMethod(value) {
  const method = String(value || 'auto').trim().toLowerCase();
  return LAUNCH_METHODS.includes(method) ? method : 'auto';
}

function firstLine(output) {
  return String(output || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] || null;
}

/**
 * Resolve the first PATH hit for a command name using the platform's lookup
 * utility ('where.exe' on Windows, 'which' elsewhere). Never spawns the
 * command itself. Injectable for tests via deps.execFn.
 */
function lookupOnPath(command, { platform = process.platform, env = process.env, execFn } = {}) {
  const run = execFn || ((file, args) => new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, env }, (error, stdout) => {
      resolve(error ? null : firstLine(stdout));
    });
  }));
  return platform === 'win32'
    ? run('where.exe', [command])
    : run('which', [command]);
}

/**
 * Command-mode runtime resolution: turn the user's dsh command (default
 * 'dsh' from PATH, or dsh.launch.command) into a verified launch runtime
 * WITHOUT executing dsh itself.
 *
 * Windows: where.exe finds dsh.cmd; the shim is parsed (never executed) into
 * the package's lib/bin.js entrypoint, which is then run with a resolved
 * node.exe — the same spawn shape as managed mode, immune to the Node >= 24
 * EINVAL restriction on spawning .cmd files directly.
 * POSIX: which finds the absolute executable (shebang script or symlink);
 * it is spawned directly with no entrypoint args.
 *
 * @returns {Promise<object|null>} runtime shape accepted by
 *   normalizeResolvedRuntime, or null when the command cannot be resolved.
 */
async function resolveCommandRuntime({
  command = 'dsh',
  dshHome,
  profileName = MANAGED_PROFILE,
  platform = process.platform,
  env = process.env,
  deps = {},
} = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  if (typeof dshHome !== 'string' || !pathApi.isAbsolute(dshHome)) {
    throw new Error('Command-mode DSH launch requires an absolute dshHome');
  }
  const stat = deps.stat || ((p) => fs.promises.stat(p));
  const hit = await lookupOnPath(command, { platform, env, execFn: deps.execFn });
  if (!hit) return null;
  const resolvedHome = path.resolve(dshHome);

  if (platform !== 'win32') {
    try {
      const info = await stat(hit);
      if (!info.isFile()) return null;
    } catch {
      return null;
    }
    return Object.freeze({
      executablePath: hit,
      entrypointArgs: Object.freeze([]),
      dshHome: resolvedHome,
      profileHome: path.join(resolvedHome, 'profiles', profileName),
      profileName,
      source: 'command-path',
      // A9: recover the official package version from the npm layout around
      // the hit so compat flags (theme-follow / toolsV3) and Diagnose see a
      // real version instead of "unknown".
      dshVersion: await detectDshVersionNear(hit, {
        readFile: deps.readFile,
        realpath: deps.realpath,
      }),
    });
  }

  // Windows: a direct .exe hit spawns as-is; a shim is parsed into the
  // package entrypoint plus a separately resolved node.exe.
  const lower = hit.toLowerCase();
  if (lower.endsWith('.exe')) {
    return Object.freeze({
      executablePath: hit,
      entrypointArgs: Object.freeze([]),
      dshHome: resolvedHome,
      profileHome: path.join(resolvedHome, 'profiles', profileName),
      profileName,
      source: 'command-path',
      dshVersion: await detectDshVersionNear(hit, {
        readFile: deps.readFile,
        realpath: deps.realpath,
      }),
    });
  }
  if (!(lower.endsWith('.cmd') || lower.endsWith('.bat') || lower.endsWith('.ps1'))) {
    return null;
  }
  const roots = await packageRootsFromShim(hit, { readFile: deps.readFile });
  for (const root of roots) {
    const manifestPath = path.win32.join(root, 'package.json');
    let manifest;
    try {
      manifest = JSON.parse(await (deps.readFile || ((p) => fs.promises.readFile(p, 'utf8')))(manifestPath));
    } catch {
      continue;
    }
    if (manifest.name !== '@deepseek-ai/dsh') continue;
    const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin && manifest.bin.dsh;
    if (typeof bin !== 'string') continue;
    const entry = path.win32.resolve(root, ...bin.replace(/\\/g, '/').split('/'));
    try {
      const entryStat = await stat(entry);
      if (!entryStat.isFile()) continue;
    } catch {
      continue;
    }
    const nodeExe = await firstExisting(nodeCandidates(env, platform), stat);
    if (!nodeExe) return null;
    return Object.freeze({
      executablePath: nodeExe,
      entrypointArgs: Object.freeze([entry]),
      dshHome: resolvedHome,
      profileHome: path.join(resolvedHome, 'profiles', profileName),
      profileName,
      source: 'command-shim',
      dshVersion: typeof manifest.version === 'string' ? manifest.version : null,
    });
  }
  return null;
}

async function firstExisting(candidates, stat) {
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

module.exports = {
  LAUNCH_METHODS,
  normalizeLaunchMethod,
  lookupOnPath,
  resolveCommandRuntime,
};
