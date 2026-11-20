'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

const { resolveLocalDshRuntime } = require('./localRuntimeResolver');
const { RuntimeDownloader } = require('./runtimeDownloader');
const { killProcessTree } = require('./serverManager');

const DEFAULT_DSH_VERSION = '0.2.2-rc.5';
const NODE_VERSION = '24.22.3';
// https://nodejs.org/en/blog/release/v24.22.3/#shasums
const NODE_ARCHIVE_HASHES = Object.freeze({
  'darwin-arm64': 'ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd',
  'darwin-x64': '977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7',
  'linux-arm64': '261af2af250dfd7e9f25cf151d1b2713a0adf8f10a9ad116c4947f68627affe8',
  'linux-x64': '061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2',
  'win32-arm64': 'b3cc74a295b39d4f273271e96f58c06dd2b35757ca12abec64c7d0598b434f14',
  'win32-x64': 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f',
});

function runtimeLayout({ storageRoot, platform = process.platform, arch = process.arch, version = '' }) {
  const platformArch = `${platform}-${arch}`;
  const sha256 = NODE_ARCHIVE_HASHES[platformArch];
  if (!sha256) throw new Error(`Automatic DSH installation is unavailable for ${platformArch}`);
  const dshVersion = (version || '').trim() || DEFAULT_DSH_VERSION;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(dshVersion) || dshVersion.length > 64) {
    throw new Error('dsh.runtime.version must be an exact npm version for automatic installation');
  }
  const windows = platform === 'win32';
  const nodeDirectory = `node-v${NODE_VERSION}-${windows ? 'win' : platform}-${arch}`;
  return {
    dshVersion,
    root: path.join(storageRoot, 'npm', platformArch, dshVersion),
    nodePath: path.join(nodeDirectory, windows ? 'node.exe' : 'bin/node'),
    npmPath: path.join(nodeDirectory, windows ? 'node_modules' : 'lib/node_modules', 'npm', 'bin', 'npm-cli.js'),
    archive: {
      url: `https://nodejs.org/dist/v${NODE_VERSION}/${nodeDirectory}.${windows ? 'zip' : 'tar.gz'}`,
      sha256,
    },
  };
}

async function resolveInstalled(layout, root, { dshHome, platform }) {
  try {
    await fs.access(root);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const runtime = await resolveLocalDshRuntime({
    dshHome,
    platform,
    nodePath: path.join(root, layout.nodePath),
    packageRoot: path.join(root, 'node_modules', '@deepseek-ai', 'dsh'),
  });
  if (runtime.dshVersion !== layout.dshVersion) throw new Error('Installed DSH version does not match its installation directory');
  return Object.freeze({ ...runtime, payloadRoot: root, source: 'extension-npm-install' });
}

function resolveNpmRuntime(options) {
  const layout = runtimeLayout(options);
  return resolveInstalled(layout, layout.root, options);
}

function run(command, args, { cwd, env, signal }) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd, env, detached: process.platform !== 'win32', windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout = (stdout + chunk).slice(-4096); });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = (stderr + chunk).slice(-4096); });
    let forceTimer;
    let closed = false;
    const stop = () => {
      if (!child.pid) return;
      void killProcessTree(child.pid).then(() => {
        if (closed) return;
        forceTimer = setTimeout(() => {
          if (process.platform === 'win32') {
            try { child.kill('SIGKILL'); } catch { /* exit may be racing */ }
          } else {
            try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the owned group may already be gone */ }
          }
          child.stdout.destroy();
          child.stderr.destroy();
        }, 1000);
      });
    };
    signal.addEventListener('abort', stop, { once: true });
    child.once('error', reject);
    child.once('close', (code, killedBy) => {
      closed = true;
      clearTimeout(forceTimer);
      signal.removeEventListener('abort', stop);
      if (signal.aborted) return reject(signal.reason);
      if (code === 0) return resolve(stdout);
      const npmCode = stderr.match(/^npm (?:error|ERR!) code ([A-Z0-9_]+)$/m)?.[1];
      reject(new Error(`${path.basename(command)} exited with ${npmCode || killedBy || code}`));
    });
  });
}

async function installNpmRuntime(options, {
  downloader = new RuntimeDownloader({ storageRoot: options.storageRoot, maxBytes: 128 * 1024 * 1024 }),
  runCommand = run,
} = {}) {
  const layout = runtimeLayout(options);
  const installed = await resolveInstalled(layout, layout.root, options);
  if (installed) return installed;

  const timeout = AbortSignal.timeout(10 * 60 * 1000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  signal.throwIfAborted();
  const parent = path.dirname(layout.root);
  await fs.mkdir(parent, { recursive: true });
  const staging = await fs.mkdtemp(path.join(parent, '.install-'));
  try {
    const archive = await downloader.download({ ...layout.archive, signal });
    const windows = (options.platform || process.platform) === 'win32';
    const tar = windows
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
    await runCommand(tar, ['-xf', archive], { cwd: staging, signal });

    const node = path.join(staging, layout.nodePath);
    const env = { ...process.env };
    const pathKey = windows ? Object.keys(env).find((key) => key.toUpperCase() === 'PATH') || 'Path' : 'PATH';
    env[pathKey] = [path.dirname(node), env[pathKey]].filter(Boolean).join(path.delimiter);
    await runCommand(node, [
      path.join(staging, layout.npmPath), 'install', '--prefix', staging,
      '--cache', path.join(options.storageRoot, 'npm-cache'),
      '--global=false', '--engine-strict', '--include=prod', '--include=optional',
      '--no-audit', '--no-fund', '--no-update-notifier', `@deepseek-ai/dsh@${layout.dshVersion}`,
    ], { cwd: staging, env, signal });

    const candidate = await resolveInstalled(layout, staging, options);
    const version = await runCommand(node, [...candidate.entrypointArgs, '--version'], { cwd: staging, env, signal });
    if (version.trim() !== layout.dshVersion) throw new Error('Installed DSH failed its version check');
    signal.throwIfAborted();
    try {
      await fs.rename(staging, layout.root);
    } catch (error) {
      // Another extension host may have published the same version first.
      const winner = await resolveInstalled(layout, layout.root, options);
      if (winner) return winner;
      throw error;
    }
    return await resolveInstalled(layout, layout.root, options);
  } finally {
    await fs.rm(staging, { recursive: true, force: true, maxRetries: 3 });
  }
}

module.exports = { installNpmRuntime, resolveNpmRuntime };
