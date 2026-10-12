'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { packageRootsFromShim, extractShimEntrypoints } = require('./shimResolver');
const { nodeCandidates, detectDshVersionNear } = require('./localRuntimeResolver');
const { MANAGED_PROFILE } = require('./managedRuntimeLaunch');
const { ServerError } = require('./serverManager');
const { STARTUP_ERRORS } = require('./startupErrors');
const { isForeignHostPath, hostEnvironmentLabel } = require('./runtimeEnvironment');

/** Valid dsh.launch.method values. 'auto' = managed first, then command. */
const LAUNCH_METHODS = Object.freeze(['auto', 'managed', 'command']);

function normalizeLaunchMethod(value) {
  const method = String(value || 'auto').trim().toLowerCase();
  return LAUNCH_METHODS.includes(method) ? method : 'auto';
}

function firstLine(output) {
  return String(output || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] || null;
}

function lookupLines(output) {
  return String(output || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/**
 * Content markers of a shim that re-execs itself into a Windows process: pnpm
 * writes `uname -a` / `wslpath` handling into the shim, so a Linux window that
 * spawns it gets `node.exe` whenever no native node is on PATH.
 */
const CROSS_EXEC_HINT = /wslpath|cygpath|node\.exe|basedir_win/i;

/**
 * Structured refusal for a command hit that belongs to the other OS
 * environment. Launching it would produce a DSH that sees only that OS's
 * paths, so every workspace of this window fails with `workspace/invalid-path`
 * — the failure this guard exists to prevent, with a message that says so.
 *
 * @param {string} hit - The refused PATH hit or shim.
 * @param {string} platform - Host platform the hit is foreign to.
 * @param {string} [reason] - Extra detail appended after the template.
 */
function foreignRuntimeError(hit, platform, reason = '') {
  const params = { path: hit, host: hostEnvironmentLabel({ platform }) };
  const error = new ServerError(
    STARTUP_ERRORS.RUNTIME_FOREIGN_ENVIRONMENT.template,
    params,
    'RUNTIME_FOREIGN_ENVIRONMENT'
  );
  if (reason) error.message = `${error.message} — ${reason}`;
  return error;
}

/** Shim extensions npm/pnpm/yarn write on Windows. */
const SHIM_SUFFIXES = ['.cmd', '.bat', '.ps1'];

/**
 * Whether a Windows PATH hit is a shim whose content we can parse. Besides
 * the .cmd/.bat/.ps1 trio, pnpm writes an EXTENSIONLESS POSIX `sh` shim
 * alongside them — and that one is what `where.exe dsh` returns first, so
 * rejecting it outright stranded every pnpm-global install. Accepting it is
 * safe: the caller parses read-only and verifies the recovered root against
 * package.json, so a non-shim file simply fails verification.
 */
function isParseableShim(hit) {
  const lower = String(hit).toLowerCase();
  if (SHIM_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return true;
  return path.win32.extname(lower) === '';
}

/**
 * Resolve PATH hits for a command name using the platform's lookup utility
 * ('where.exe' on Windows, 'which' elsewhere). Never spawns the command
 * itself. Injectable for tests via deps.execFn.
 *
 * `all: true` returns every hit on POSIX (`which -a`), which is what lets the
 * caller skip a Windows-side hit and keep looking for a native one; without it
 * only the first hit is returned, as before.
 *
 * @returns {Promise<string|string[]|null>} First hit, all hits, or null/[].
 */
async function lookupOnPath(command, {
  platform = process.platform,
  env = process.env,
  execFn,
  all = false,
} = {}) {
  const run = execFn || ((file, args) => new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, env }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  }));
  const allHits = all && platform !== 'win32';
  const output = await run(
    platform === 'win32' ? 'where.exe' : 'which',
    allHits ? ['-a', command] : [command]
  );
  if (output === null || output === undefined) return allHits ? [] : null;
  if (Array.isArray(output)) {
    const lines = output.map((line) => String(line).trim()).filter(Boolean);
    return allHits ? lines : (lines[0] || null);
  }
  return allHits ? lookupLines(output) : firstLine(output);
}

/**
 * Command-mode runtime resolution: turn the user's dsh command (default
 * 'dsh' from PATH, or dsh.launch.command) into a verified launch runtime
 * WITHOUT executing dsh itself.
 *
 * Every platform parses shims instead of running them: npm/pnpm/yarn shims
 * embed the package's lib/bin.js entrypoint, which is then run with a resolved
 * native node. On Windows that also sidesteps the Node >= 24 EINVAL
 * restriction on spawning .cmd files; on POSIX it is what keeps a WSL window
 * from silently becoming a Windows process (pnpm's shim converts itself with
 * `wslpath` + `node.exe` when the extension-host PATH has no native node).
 *
 * A PATH hit that belongs to the other OS environment is never selected: with
 * only such hits the resolution fails loudly (RUNTIME_FOREIGN_ENVIRONMENT)
 * instead of handing this window a DSH that rejects all of its paths.
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
  const resolvedHome = path.resolve(dshHome);

  if (platform !== 'win32') {
    const hits = await lookupOnPath(command, { platform, env, execFn: deps.execFn, all: true });
    const foreign = [];
    let hit = null;
    for (const candidate of hits) {
      if (isForeignHostPath(candidate, { platform })) {
        foreign.push(candidate);
        continue;
      }
      hit = candidate;
      break;
    }
    if (!hit) {
      if (foreign.length > 0) throw foreignRuntimeError(foreign[0], platform);
      return null;
    }
    try {
      const info = await stat(hit);
      if (!info.isFile()) return null;
    } catch {
      return null;
    }
    // A shim is parsed into (native node, entrypoint) — never spawned as-is.
    const readText = deps.readFile || ((p) => fs.promises.readFile(p, 'utf8'));
    let content = '';
    try {
      content = await readText(hit);
    } catch {
      content = '';
    }
    if (extractShimEntrypoints(content).length > 0) {
      const roots = await packageRootsFromShim(hit, { readFile: deps.readFile, platform });
      const shimRuntime = await runtimeFromShimRoots({
        roots, platform, env, stat, readFile: readText, dshHome: resolvedHome, profileName,
      });
      if (shimRuntime) return shimRuntime;
      // Unverifiable shim: refuse when its content shows the self-conversion,
      // so it can never be spawned into a foreign process.
      if (CROSS_EXEC_HINT.test(content)) {
        throw foreignRuntimeError(
          hit,
          platform,
          'the shim converts itself to a Windows executable (wslpath/node.exe) and no package could be verified behind it'
        );
      }
      return null;
    }
    if (CROSS_EXEC_HINT.test(content)) {
      throw foreignRuntimeError(
        hit,
        platform,
        'the command is a shim that re-execs a Windows node.exe'
      );
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
  const hit = await lookupOnPath(command, { platform, env, execFn: deps.execFn });
  if (!hit) return null;
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
  if (!isParseableShim(hit)) {
    return null;
  }
  const roots = await packageRootsFromShim(hit, { readFile: deps.readFile, platform });
  return runtimeFromShimRoots({
    roots, platform, env, stat, readFile: deps.readFile, dshHome: resolvedHome, profileName,
  });
}

/**
 * Verify shim-derived package roots into a launchable (node, entrypoint)
 * runtime. The shim shape is the same on both platforms, so this is shared:
 * the first root whose package.json is the official @deepseek-ai/dsh and whose
 * entrypoint exists wins. Returns null when no root verifies (or when no Node
 * executable is available for it), keeping the caller's existing null/throw
 * decision in its own hands. Foreign roots are skipped: a shim token may point
 * into the other OS's filesystem (the Windows-side shim's `C:\...` target).
 */
async function runtimeFromShimRoots({
  roots,
  platform,
  env,
  stat,
  readFile,
  dshHome,
  profileName,
}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const readManifest = readFile || ((p) => fs.promises.readFile(p, 'utf8'));
  for (const root of roots) {
    if (isForeignHostPath(root, { platform })) continue;
    const manifestPath = pathApi.join(root, 'package.json');
    let manifest;
    try {
      manifest = JSON.parse(await readManifest(manifestPath));
    } catch {
      continue;
    }
    if (manifest.name !== '@deepseek-ai/dsh') continue;
    const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin && manifest.bin.dsh;
    if (typeof bin !== 'string') continue;
    const entry = pathApi.resolve(root, ...bin.replace(/\\/g, '/').split('/'));
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
      dshHome,
      profileHome: path.join(dshHome, 'profiles', profileName),
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
