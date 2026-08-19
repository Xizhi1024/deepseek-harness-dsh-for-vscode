import { readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import net from 'node:net';

import { createBridgeTools } from './tools.js';
import { createLmRoutes } from './lmRoute.js';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// 'webServer' MUST be declared: createLmRoutes touches ctx.webServer at
// construction time and cordis throws 'cannot get property "webServer"
// without inject' — which aborts the whole plugin tree at boot (the DSH
// process exits before the sidebar ever connects). This package is only
// installed into extension-owned homes, where the web profile always
// provides the webServer service.
const inject = ['apiProxy', 'tools', 'llm', 'webServer'];
const name = 'dsh-vscode-integration';

// ---------------------------------------------------------------------------
// C1 watchdog (DSH side): cadences + spawn-env keys. This package is ESM and
// self-contained — it never `require`s the extension's CommonJS src/types.js —
// so the numbers below mirror src/types.js and must not drift (the extension
// writes the heartbeat at HEARTBEAT_WRITE_MS; this host checks it here every
// WATCHDOG_CHECK_MS and treats a heartbeat older than WATCHDOG_EXPIRY_MS as
// expired).
// ---------------------------------------------------------------------------
const WATCHDOG_CHECK_MS = 5 * 1000;
const WATCHDOG_EXPIRY_MS = 60 * 1000;
const HEARTBEAT_ENV = 'DSH_VSCODE_HEARTBEAT_PATH';
const WINDOW_ID_ENV = 'DSH_VSCODE_WINDOW_ID';
const WATCHDOG_ENV = 'DSH_VSCODE_WATCHDOG';

function failure(request, message) {
  return {
    rpcId: request.rpcId,
    result: {
      ok: false,
      error: { code: 'internal', message, details: {} },
    },
  };
}

async function openThroughBridge(path, signal, env = process.env) {
  const rawUrl = env.DSH_VSCODE_OPEN_URL;
  const token = env.DSH_VSCODE_OPEN_TOKEN;
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || typeof token !== 'string' || token.length === 0) {
    throw new Error('VS Code text-document bridge is unavailable');
  }
  const endpoint = new URL(rawUrl);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password) {
    throw new Error('VS Code text-document bridge endpoint is invalid');
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ path }),
    signal,
  });
  if (!response.ok) throw new Error(`VS Code rejected the file-open request (${response.status})`);
}

// ---------------------------------------------------------------------------
// Watchdog protocol primitives (pure parts, directly exercisable with node:test).
// ---------------------------------------------------------------------------

/**
 * Parse one heartbeat payload. Garbage or unparsable text yields null (the
 * caller treats it as an expired heartbeat — safe degradation).
 * @param {string} text - raw file content.
 * @returns {{ownerPid: number|null, windowId: string, ownerStartTs: number|null, lastWriteMs: number|null}|null}
 */
function parseHeartbeat(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  return {
    ownerPid: Number.isInteger(parsed.ownerPid) ? parsed.ownerPid : null,
    windowId: typeof parsed.windowId === 'string' ? parsed.windowId : '',
    ownerStartTs: Number.isFinite(parsed.ownerStartTs) ? parsed.ownerStartTs : null,
    lastWriteMs: Number.isFinite(parsed.at) ? parsed.at : null,
  };
}

/**
 * Read + stat a heartbeat file.
 *  - missing file        → null (treated as expired)
 *  - corrupt content     → { lastWriteMs } with identity nulls (treated as expired)
 *  - healthy             → parsed payload with a concrete lastWriteMs
 * @param {string} filePath
 * @param {object} [seams] - injectable readFileSync / statSync for tests.
 * @returns {object|null}
 */
function readHeartbeat(filePath, { readFileSyncFn = readFileSync, statSyncFn = statSync } = {}) {
  let mtimeMs = null;
  try {
    const stats = statSyncFn(filePath);
    if (stats && Number.isFinite(stats.mtimeMs)) mtimeMs = stats.mtimeMs;
    else if (stats && Number.isFinite(Number(stats.mtime))) mtimeMs = Number(stats.mtime);
  } catch {
    return null; // missing: expired
  }
  try {
    const parsed = parseHeartbeat(readFileSyncFn(filePath, 'utf8'));
    if (parsed === null) return { lastWriteMs: mtimeMs }; // corrupt: expired, identity unknown
    return { ...parsed, lastWriteMs: parsed.lastWriteMs !== null ? parsed.lastWriteMs : mtimeMs };
  } catch {
    return { lastWriteMs: mtimeMs }; // corrupt: expired, identity unknown
  }
}

/**
 * The dual-condition watchdog verdict (D6 quad ②③④):
 *
 * Only `exit:true` when the heartbeat is expired>expiryMs AND the owner/parent
 * is positively gone — plus window ownership and PID-reuse guards that keep us
 * waiting instead of exiting on any uncertainty:
 *  - fresh heartbeat            → wait (never exit while the owner writes);
 *  - heartbeat from another windowId → wait (multi-window ownership ④);
 *  - recorded owner pid ≠ our ppid (owner replaced/reparented) → exit;
 *  - our ppid process is dead (ESRCH) → exit;
 *  - missing/corrupt heartbeat + live ppid → wait (safe degradation);
 *  - live ppid whose start time ≠ recorded owner start (PID reuse ③) → wait.
 *
 * @param {object} state
 * @param {object|null} [state.heartbeat] - readHeartbeat output (null = missing).
 * @param {string} [state.expectedWindowId] - DSH_VSCODE_WINDOW_ID.
 * @param {number|null} [state.ppid] - process.ppid.
 * @param {boolean} [state.ppidExists] - whether pid=ppid is alive.
 * @param {number|null} [state.ppidStartTs] - pid=ppid actual start (null = unknown).
 * @param {number} [state.expiryMs] - tolerated heartbeat age.
 * @param {number} [state.now] - current epoch ms.
 * @returns {{exit: boolean, reason: string}}
 */
function evaluateWatchdog({
  heartbeat = null,
  expectedWindowId = '',
  ppid = null,
  ppidExists = false,
  ppidStartTs = null,
  expiryMs = WATCHDOG_EXPIRY_MS,
  now = Date.now(),
} = {}) {
  if (typeof expectedWindowId !== 'string' || expectedWindowId.length === 0) {
    return { exit: false, reason: 'not-configured' };
  }
  if (!Number.isInteger(ppid) || ppid <= 0) {
    return { exit: false, reason: 'no-ppid' };
  }
  const lastWriteMs = heartbeat && Number.isFinite(heartbeat.lastWriteMs) ? heartbeat.lastWriteMs : null;
  const fresh = lastWriteMs !== null && Number.isFinite(now) && (now - lastWriteMs) <= expiryMs;
  if (fresh) return { exit: false, reason: 'fresh' };

  // Expired. Now the dual condition: owner/ppid must be positively gone, with
  // the multi-window ownership and PID-reuse guards applied first.
  if (heartbeat && typeof heartbeat.windowId === 'string' && heartbeat.windowId.length > 0
      && heartbeat.windowId !== expectedWindowId) {
    return { exit: false, reason: 'window-mismatch' }; // ④ not our heartbeat
  }
  const ownerKnown = Boolean(heartbeat && Number.isInteger(heartbeat.ownerPid));
  if (ownerKnown && heartbeat.ownerPid !== ppid) {
    return { exit: true, reason: 'owner-gone' };
  }
  if (!ppidExists) {
    return { exit: true, reason: 'ppid-dead' };
  }
  if (!ownerKnown) {
    return { exit: false, reason: 'owner-unknown' }; // missing/corrupt + live ppid → wait
  }
  // A live pid that shares our recorded owner pid: confront its real start time
  // against the heartbeat (③ PID reuse). Any uncertainty keeps waiting.
  if (heartbeat.ownerStartTs !== null && ppidStartTs !== null) {
    if (ppidStartTs === heartbeat.ownerStartTs) return { exit: false, reason: 'owner-alive' };
    return { exit: false, reason: 'pid-reuse' };
  }
  return { exit: false, reason: 'start-unknown' };
}

/**
 * Best-effort process start timestamp, cross-process comparable with the
 * extension's own `osProcessStartMs` (mirrored in src/extension.js):
 *  - POSIX: /proc/<pid>/stat field 22 (`starttime` ticks — same boot base on
 *    both sides);
 *  - win32: PowerShell Get-Process StartTime → epoch milliseconds.
 * Returns null when unavailable (the watchdog then stays conservative-wait).
 * @param {number} pid
 * @returns {number|null}
 */
function osProcessStartMs(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'win32') {
      const command = '[int64]((Get-Process -Id ' + pid
        + ' -ErrorAction Stop).StartTime.ToUniversalTime() - [datetime]\'1970-01-01 00:00:00Z\').TotalMilliseconds';
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const ms = Number(String(out).trim());
      return Number.isFinite(ms) ? Math.round(ms) : null;
    }
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
    const starttime = Number(fields[19]); // field 22 → index 22 - 3
    return Number.isFinite(starttime) ? starttime : null;
  } catch {
    return null;
  }
}

function defaultPpidExists(ppid) {
  if (!Number.isInteger(ppid) || ppid <= 0) return false;
  try {
    process.kill(ppid, 0);
    return true;
  } catch (err) {
    return !(err && err.code === 'ESRCH');
  }
}

/**
 * Build the DSH-side watchdog check loop.
 *
 * Wiring rules:
 *  - DSH_VSCODE_WATCHDOG === 'off' (injected when dsh.closePolicy is `never`)
 *    → start() is a no-op, the loop never runs (D6).
 *  - No heartbeat path → start() is a no-op (nothing to monitor).
 *  - Otherwise checks every `intervalMs`: read the heartbeat, probe whether the
 *    parent (ppid) is alive, compute the pure verdict, and call `onExit` when
 *    the verdict says exit (default: terminate the DSH process).
 *
 * @param {object} [opts]
 * @param {object} [opts.env] - env source (default process.env).
 * @param {string} [opts.heartbeatPath] - DSH_VSCODE_HEARTBEAT_PATH.
 * @param {string} [opts.expectedWindowId] - DSH_VSCODE_WINDOW_ID.
 * @param {string} [opts.watchdog] - DSH_VSCODE_WATCHDOG ("off" disables).
 * @param {number|null} [opts.ppid] - process.ppid override.
 * @param {Function} [opts.readHeartbeatFn] - file reader seam.
 * @param {Function} [opts.ppidExistsFn] - liveness probe seam.
 * @param {Function} [opts.getPpidStartMsFn] - start-time seam.
 * @param {Function} [opts.onExit] - invocation on a positive verdict.
 * @param {number} [opts.intervalMs]
 * @param {number} [opts.expiryMs]
 * @param {Function} [opts.now]
 * @returns {{running: boolean, start: () => object, stop: () => object, _timer: ReturnType<typeof setInterval>|null}}
 */
function createWatchdogMonitor({
  env = process.env,
  heartbeatPath = env && env[HEARTBEAT_ENV],
  expectedWindowId = env && env[WINDOW_ID_ENV],
  watchdog = env && env[WATCHDOG_ENV],
  ppid = process.ppid,
  readHeartbeatFn = null,
  ppidExistsFn = null,
  getPpidStartMsFn = null,
  onExit = null,
  intervalMs = WATCHDOG_CHECK_MS,
  expiryMs = WATCHDOG_EXPIRY_MS,
  now = Date.now,
} = {}) {
  const monitor = {
    running: false,
    _timer: null,
    start() {
      if (monitor.running) return monitor;
      if (watchdog === 'off') return monitor; // D6: closePolicy=never — never self-terminate
      if (typeof heartbeatPath !== 'string' || heartbeatPath.length === 0) return monitor;
      monitor.running = true;
      const read = typeof readHeartbeatFn === 'function' ? readHeartbeatFn : readHeartbeat;
      const ppidAlive = typeof ppidExistsFn === 'function' ? ppidExistsFn : () => defaultPpidExists(ppid);
      const realStartOf = typeof getPpidStartMsFn === 'function' ? getPpidStartMsFn : osProcessStartMs;
      let cachedPpidStart = null;
      let cachedPpidStartDone = false;
      const ppidStart = () => {
        if (!cachedPpidStartDone) {
          cachedPpidStartDone = true;
          try {
            cachedPpidStart = realStartOf(ppid);
          } catch {
            cachedPpidStart = null;
          }
        }
        return cachedPpidStart;
      };
      const check = () => {
        const verdict = evaluateWatchdog({
          heartbeat: read(heartbeatPath),
          expectedWindowId,
          ppid,
          ppidExists: ppidAlive(),
          ppidStartTs: ppidStart(),
          expiryMs,
          now: typeof now === 'function' ? now() : now,
        });
        if (verdict.exit) {
          monitor.stop();
          if (typeof onExit === 'function') onExit(verdict);
        }
      };
      // Arm the loop first so an exit verdict on the very first check can
      // stop() and clear the timer that this process has already scheduled.
      monitor._timer = setInterval(check, intervalMs);
      if (monitor._timer && typeof monitor._timer.unref === 'function') monitor._timer.unref();
      check();
      return monitor;
    },
    stop() {
      if (monitor._timer) {
        clearInterval(monitor._timer);
        monitor._timer = null;
      }
      monitor.running = false;
      return monitor;
    },
  };
  return monitor;
}

function apply(ctx) {
  ctx.effect(() => {
    const host = ctx.apiProxy.host;
    const original = host.openPath;
    host.openPath = async (request, signal) => {
      const target = request && request.payload && request.payload.path;
      if (typeof target !== 'string' || target.length === 0) {
        return failure(request, 'path open failed: a path is required');
      }
      try {
        await openThroughBridge(target, signal);
        return { rpcId: request.rpcId, result: { ok: true, value: { opened: true } } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failure(request, `path open failed: ${message}`);
      }
    };
    // C1 watchdog: if this DSH process is a VS Code-managed child, keep an eye
    // on its owner window and self-terminate only when the dual condition is
    // met (heartbeat expired AND owner gone). Inert for standalone DSH (no
    // DSH_VSCODE_* env) and for closePolicy=never (DSH_VSCODE_WATCHDOG=off).
    const monitor = createWatchdogMonitor({
      onExit: () => process.exit(0),
    });
    monitor.start();
    return () => {
      host.openPath = original;
      monitor.stop();
    };
  }, 'dsh-vscode-integration: host.openPath bridge + C1 watchdog');

  ctx.effect(() => {
    // Descriptors are built register()-shaped (JSON-Schema roots); the
    // spec-shaped SDK defineTool helper must never wrap them implicitly.
    const bridge = createBridgeTools({
      env: process.env,
      ctx,
      net,
      version: packageJson.version,
    });
    const started = bridge.start();
    return () => {
      if (started && typeof started.stop === 'function') started.stop();
    };
  }, 'dsh-vscode-integration: vscode bridge tools');

  ctx.effect(() => {
    const routes = createLmRoutes({ env: process.env, ctx });
    return () => routes.dispose();
  }, 'dsh-vscode-integration: /api/lm routes');
}

export {
  apply,
  inject,
  name,
  openThroughBridge,
  parseHeartbeat,
  readHeartbeat,
  evaluateWatchdog,
  osProcessStartMs,
  createWatchdogMonitor,
};
