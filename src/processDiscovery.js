'use strict';

const { execFile } = require('node:child_process');

/**
 * Process-command-line discovery of already-running `dsh web` services.
 *
 * Fallback layer for the case where the configured port stays silent but a
 * DSH web service is in fact running somewhere else on this machine (a port
 * override, a leftover instance from another window, a manually started
 * terminal session). Scans process command lines — never spawns dsh itself.
 *
 * The PowerShell/ps scanning approach is credited to the MIT-licensed
 * DM010727/dsh-cline project (packages/extension/src/extension.ts,
 * discoverDshWebUrls), hardened here with a cache, injectable exec, and
 * per-platform timeouts.
 *
 * @module processDiscovery
 */

const CACHE_TTL_MS = 5000;
const WIN_TIMEOUT_MS = 8000;

function parsePorts(stdout) {
  const ports = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const port = /--port[= ](\d+)/.exec(line)?.[1];
    if (port !== undefined && port !== '0') ports.push(Number(port));
  }
  return [...new Set(ports)];
}

/** Build the platform-specific command list for scanning `dsh … web` processes. */
function scanCommands(platform) {
  if (platform === 'win32') {
    return [{
      file: 'powershell.exe',
      args: ['-NoProfile', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'dsh.+web' } | ForEach-Object { $_.CommandLine }"],
    }];
  }
  return [{
    file: 'sh',
    args: ['-lc', "ps -eo command | grep -E 'dsh.+web' | grep -v grep || true"],
  }];
}

/**
 * Discover ports of running `dsh web` listeners on this machine.
 * Results are cached for CACHE_TTL_MS; failures yield [] (best-effort).
 * @param {{ platform?: string, execFn?: Function }} [deps]
 * @returns {Promise<number[]>} unique ports, order of appearance
 */
async function discoverDshWebPorts({ platform = process.platform, execFn } = {}) {
  const run = execFn || ((file, args) => new Promise((resolve) => {
    execFile(file, args,
      { windowsHide: true, timeout: platform === 'win32' ? WIN_TIMEOUT_MS : 4000 },
      (error, stdout) => resolve(error ? '' : stdout));
  }));
  if (discoverDshWebPorts._cache && Date.now() - discoverDshWebPorts._cacheAt < CACHE_TTL_MS) {
    return discoverDshWebPorts._cache;
  }
  let ports = [];
  for (const command of scanCommands(platform)) {
    try {
      const stdout = await run(command.file, command.args);
      ports = parsePorts(stdout);
    } catch {
      ports = []; // best-effort only: a missing powershell/ps never throws
    }
    if (ports.length > 0) break;
  }
  discoverDshWebPorts._cache = ports;
  discoverDshWebPorts._cacheAt = Date.now();
  return ports;
}

/** Test hook: clear the discovery cache. */
discoverDshWebPorts.resetCache = function resetCache() {
  discoverDshWebPorts._cache = null;
  discoverDshWebPorts._cacheAt = 0;
};

module.exports = { discoverDshWebPorts, parsePorts, scanCommands };
