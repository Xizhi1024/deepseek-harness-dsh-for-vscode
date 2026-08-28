'use strict';

/**
 * serverManager.js — manages the local DeepSeek Harness (DSH) web service
 * from a VS Code auxiliary sidebar.
 *
 * Responsibilities:
 *   - probe a host:port to detect whether the DSH web UI is running there
 *     (its index.html body contains the BOOT_MARKER symbol).
 *   - start one window-owned DSH instance via an already verified managed
 *     runtime on a free port (scanning forward from the configured port), or
 *     reuse a user-managed instance only when autoStart is disabled.
 *   - keep a JSON instance registry for stale-entry cleanup and diagnostics;
 *     live entries from other VS Code windows are never adopted by default.
 *   - report lifecycle transitions through an `onStatus` callback.
 *
 * Zero external dependencies: only Node built-ins are used.
 */

const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildManagedLaunchSpec,
  isNoOpenStderr,
  normalizeResolvedRuntime,
  supportsNoOpenFlag,
} = require('./managedRuntimeLaunch');
const { STARTUP_ERRORS } = require('./startupErrors');

// Shared contract constants normally come from ./types. Fall back to local
// defaults so this file stays independently testable when copied in isolation.
let typesModule = null;
try {
  typesModule = require('./types');
} catch {
  // types.js not available yet — local constants below are used instead.
}
const DEFAULT_PORT = typesModule && typesModule.DEFAULT_PORT != null ? typesModule.DEFAULT_PORT : 3080;
const DEFAULT_HOST = typesModule && typesModule.DEFAULT_HOST != null ? typesModule.DEFAULT_HOST : '127.0.0.1';
const BOOT_MARKER = typesModule && typesModule.BOOT_MARKER != null ? typesModule.BOOT_MARKER : '__DSH_BOOT__';

const PROBE_TIMEOUT_MS = 3000;   // per-probe socket timeout (generous for a busy DSH)
const PORT_SCAN_LIMIT = 50;      // max ports scanned forward when the target is busy
const HEALTH_POLL_MS = 700;      // interval between health checks after spawn
const HEALTH_TIMEOUT_MS = 30000; // overall wait for the spawned service to become ready
const MAX_BODY_BYTES = 5 * 1024 * 1024; // bound on the probe response body we buffer
const TASKKILL_TIMEOUT_MS = 5000; // max wait for taskkill /T /F before stop() proceeds

/**
 * Substitute {name} placeholders in a template with the given params.
 * Unknown placeholders are left intact so a missing param is never silent.
 * @param {string} template
 * @param {object} [params]
 * @returns {string}
 */
function fillTemplate(template, params) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) =>
    params && params[key] !== undefined && params[key] !== null ? String(params[key]) : "{" + key + "}"
  );
}

/**
 * Error whose message is the placeholder-filled English template, while
 * template/params stay available so the extension host can re-render it
 * through vscode.l10n in the user's UI language. The filled English message
 * keeps standalone/CLI consumers readable.
 */
class ServerError extends Error {
  /**
   * @param {string} template - English l10n template with {name} placeholders.
   * @param {object} [params] - placeholder values.
   * @param {string} [code] - Stable machine-readable error class used by the
   *   startup/status UI to decide retryability and diagnose grouping.
   */
  constructor(template, params, code = null) {
    super(fillTemplate(template, params));
    this.name = "ServerError";
    this.template = template;
    this.params = params || {};
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle decision functions.
//
// These are pure (no I/O, no vscode import): the same inputs always produce
// the same output. They live here — not in extension.js — so both the
// extension host and the node:test suite exercise the exact same decision
// code without loading VS Code.
// ---------------------------------------------------------------------------

/**
 * Allowed values of the `dsh.closePolicy` setting.
 *   - `onVscodeExit` — stop the owned server only when VS Code exits (default);
 *     closing the sidebar view keeps it running.
 *   - `onViewClose`  — also stop the owned server when the sidebar view is disposed.
 *   - `never`        — never stop the server automatically; the user stops it
 *     explicitly via `dsh.stopServer`. The process intentionally survives the
 *     extension host. A later window never adopts a surviving process from the
 *     instance registry (the registry is bookkeeping/diagnostics only); if the
 *     owner window crashed, the process shows up in `dsh.cleanupOrphans` where
 *     the user can stop it or remove its stale record.
 *
 * Note: only an OWNED process (spawned by this extension) is ever stopped. A
 * reused external instance is never touched, whatever the policy says.
 * @type {Object<string, string>}
 */
const CLOSE_POLICIES = Object.freeze({
  ON_VSCODE_EXIT: 'onVscodeExit',
  ON_VIEW_CLOSE: 'onViewClose',
  NEVER: 'never',
});

const DEFAULT_CLOSE_POLICY = CLOSE_POLICIES.ON_VSCODE_EXIT;

/**
 * Normalize a raw closePolicy setting to a known value.
 * Anything unknown falls back to the conservative default (onVscodeExit).
 * @param {*} raw - the value read from the config (may be undefined).
 * @returns {string} one of CLOSE_POLICIES.
 */
function normalizeClosePolicy(raw) {
  if (raw === CLOSE_POLICIES.ON_VIEW_CLOSE) return CLOSE_POLICIES.ON_VIEW_CLOSE;
  if (raw === CLOSE_POLICIES.NEVER) return CLOSE_POLICIES.NEVER;
  return CLOSE_POLICIES.ON_VSCODE_EXIT; // default, and fallback for unknown values
}

/**
 * Whether closing the sidebar view should stop the owned server under the
 * given policy. Only `onViewClose` does; the conservative default and `never`
 * both leave a running server alone on view close.
 * @param {*} closePolicy - raw policy value (normalized internally).
 * @returns {boolean}
 */
function shouldStopOnViewClose(closePolicy) {
  return normalizeClosePolicy(closePolicy) === CLOSE_POLICIES.ON_VIEW_CLOSE;
}

/**
 * Whether the `dsh.stopServer` command should stop the server described by
 * `server`. The rule is: only a process THIS extension instance spawned and
 * owns is ever stopped. A reused external instance (found already running and
 * adopted, e.g. from another workspace/VS Code window) must never be killed.
 *
 * @param {object|null|undefined} server - a RunningServer handle, or null when none.
 * @returns {boolean} true only when `server` exists and server.owned === true.
 */
function shouldStopOwnedServer(server) {
  return Boolean(server && server.owned === true);
}

/**
 * Two `dsh.*` endpoint configs are effectively equal when host and port match.
 * Used to decide whether a config change actually requires a reconnect.
 * @param {{host: string, port: number}} a
 * @param {{host: string, port: number}} b
 * @returns {boolean}
 */
function sameEndpoint(a, b) {
  return Boolean(a && b && a.host === b.host && Number(a.port) === Number(b.port));
}

/**
 * React to a `dsh.*` configuration change: decide what each changed key means
 * for the running server, and whether a reconnect+restart is required.
 *
 * Pure and deterministic: the same inputs yield the same action. The caller
 * (extension.js) feeds the reconciled action into a single serialized queue so
 * burst changes coalesce instead of spawning parallel servers.
 *
 * Inputs:
 *   @param {object} prev - previous config { host, port, autoStart, closePolicy }.
 *   @param {object} next - new config      { host, port, autoStart, closePolicy }.
 *   @param {boolean} connected - whether a server is currently bound/connected.
 *   @param {boolean} owned - whether the current server is owned by this extension.
 *
 * Returns an action object:
 *   { shouldReconnect: boolean, reason: string|null }
 *   - shouldReconnect is true when the endpoint changed OR (autoStart went from
 *     false→true and the last ensureServer failed because it was disabled) —
 *     i.e. when a restart is needed to bring the server in line with config.
 *   - reason names the first semantic change, or null when none.
 */
function reconcileConfigChange(prev, next, connected, owned) {
  const p = prev || {};
  const n = next || {};

  const endpointChanged = !sameEndpoint(
    { host: p.host, port: p.port },
    { host: n.host, port: n.port }
  );

  if (endpointChanged) {
    return {
      shouldReconnect: true,
      reason: sameEndpoint({ host: p.host, port: p.port }, { host: p.host, port: n.port })
        ? 'host' : 'port',
      endpointChanged: true,
      autoStartEnabled: null,
      closePolicyChanged: (normalizeClosePolicy(p.closePolicy) !== normalizeClosePolicy(n.closePolicy)),
    };
  }

  // autoStart false→true while nothing is running: a fresh start is now allowed.
  const autoStartEnabled = p.autoStart === false && n.autoStart === true && !connected;

  return {
    shouldReconnect: autoStartEnabled,
    reason: autoStartEnabled ? 'autoStart' : null,
    endpointChanged: false,
    autoStartEnabled,
    closePolicyChanged: (normalizeClosePolicy(p.closePolicy) !== normalizeClosePolicy(n.closePolicy)),
  };
}

/**
 * Kill a process tree by pid. On Windows the spawned dsh is a cmd.exe wrapper,
 * so taskkill /T /F kills the whole tree and the promise resolves when
 * taskkill exits or after `timeoutMs` — whichever comes first. On POSIX the
 * child was spawned detached (its pid is the process-group id), so SIGTERM
 * the group first — dsh web and any workers it spawned all die — then fall
 * back to the single process.
 *
 * Shared by `ServerManager.stop()` (owned child) and the orphan-cleanup
 * command (registry entries from crashed windows).
 *
 * @param {number} pid - Root process id of the tree.
 * @param {object} [options] - Injectable seams for tests.
 * @param {string} [options.platform] - Override process.platform.
 * @param {Function} [options.spawnFn] - Override node:child_process.spawn.
 * @param {number} [options.timeoutMs] - Override TASKKILL_TIMEOUT_MS.
 * @returns {Promise<void>}
 */
function killProcessTree(pid, { platform = process.platform, spawnFn = spawn, timeoutMs = TASKKILL_TIMEOUT_MS } = {}) {
  if (platform === 'win32') {
    return new Promise((resolve) => {
      let killer = null;
      try {
        killer = spawnFn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        resolve();
        return;
      }
      let settled = false;
      let timer = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killer && typeof killer.removeListener === 'function') {
          killer.removeListener('error', finish);
          killer.removeListener('exit', finish);
        }
        resolve();
      };
      if (!killer || typeof killer.once !== 'function') {
        finish();
        return;
      }
      timer = setTimeout(() => {
        try {
          killer.kill?.();
        } catch {
          // ignore: the killer may already be gone
        }
        // Best-effort second tree-kill in case the hung taskkill never made
        // it to the child; a fresh detached taskkill is not awaited.
        try {
          const retry = spawnFn('taskkill', ['/PID', String(pid), '/T', '/F'], {
            stdio: 'ignore',
            detached: true,
            windowsHide: true,
          });
          if (retry && typeof retry.unref === 'function') retry.unref();
        } catch {
          // ignore: the retry is best-effort
        }
        finish();
      }, timeoutMs);
      killer.once('error', finish);
      killer.once('exit', finish);
    });
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already dead
    }
  }
  return Promise.resolve();
}

class ServerManager {
  constructor({ onStatus, spawnEnv, resolvedRuntime, embedPatchPath = null, cleanPatchPath = null, spawnFn = spawn } = {}) {
    this.onStatus = typeof onStatus === 'function' ? onStatus : () => {};
    this.spawnEnv = spawnEnv && typeof spawnEnv === 'object' ? { ...spawnEnv } : {};
    this.resolvedRuntime = resolvedRuntime === undefined
      ? null
      : normalizeResolvedRuntime(resolvedRuntime);
    // Optional DSH CLI `--patch` overlay generated by the extension. It is
    // validated again by buildManagedLaunchSpec immediately before spawn.
    this.embedPatchPath = embedPatchPath;
    this.cleanPatchPath = cleanPatchPath;
    this.clean = false; // clean-restart mode: spawn uses cleanPatchPath and registry marks clean:true
    this.spawnFn = typeof spawnFn === 'function' ? spawnFn : spawn;
    // C1 owner-marked registry: this window's extension-host pid + stable
    // window id, stamped onto every ready registry entry so the next
    // activation can tree-kill entries whose owner window died (multi-window
    // zero mis-kill) without ever touching a live owner.
    this.ownerVscodePid = null; // extension-host process pid (process.pid)
    this.ownerWindowId = null;  // stable window identity (see extension.js deriveWindowId)
    this._selfHealCount = 0; // successful patch-drop self-heal retries for Diagnose
    this._child = null;   // ChildProcess spawned by THIS instance (owned)
    this._noOpenSuppressed = false; // session-sticky: runtime rejected --no-open
    this._lastSpawnArgs = null;     // args of the most recent spawn attempt
    this._lastSpawnLogPath = null;  // per-spawn log used by the no-open self-heal
    this._healthTimer = null;       // post-ready liveness poll (see _startHealthWatch)
    this._healthPort = null;        // port the health poll probes
    this._extraArgs = [];           // dsh.extraArgs appended to owned spawns
    this._registryFile = null; // registry merged on ready (own entry removed on stop)
    this._stopping = false; // true while a deliberate stop() is in progress
    this._ownedServer = null; // last ready endpoint backed by this._child
    this._cancelGeneration = 0; // invalidates an in-flight ensure/spawn operation
    this._lastSpawnPort = null; // last port spawned by THIS instance (fresh origin)
  }

  /**
   * Replace the verified managed runtime used for future spawns. An existing
   * owned child keeps running with the runtime that spawned it; the new value
   * applies from the next spawn (e.g. after a restart).
   * @param {object|null} resolvedRuntime - verified RuntimeResolver output, or null to clear.
   * @returns {object|null} the normalized runtime now in effect.
   */
  setResolvedRuntime(resolvedRuntime) {
    this.resolvedRuntime = resolvedRuntime === undefined || resolvedRuntime === null
      ? null
      : normalizeResolvedRuntime(resolvedRuntime);
    // A fresh runtime re-announces its version; let the version gate decide
    // --no-open again instead of keeping a stale suppression around.
    this._noOpenSuppressed = false;
    return this.resolvedRuntime;
  }

  /** Replace the generated embed overlay used by future owned spawns. */
  setEmbedPatchPath(embedPatchPath) {
    this.embedPatchPath = embedPatchPath === undefined ? null : embedPatchPath;
    return this.embedPatchPath;
  }

  /**
   * Toggle D1 clean-restart mode for future owned spawns: when enabled the
   * `--patch` overlay switches to `cleanPatchPath` (vscode-clean.overlay.yml)
   * and every ready registry entry is marked `clean: true`.
   * @param {{enabled?: boolean, patchPath?: string|null}} [options]
   * @returns {boolean} the clean flag now in effect.
   */
  setCleanMode({ enabled = false, patchPath = null } = {}) {
    this.clean = Boolean(enabled);
    this.cleanPatchPath = enabled ? patchPath : null;
    return this.clean;
  }

  /** True while this manager spawns with the clean overlay. */
  isCleanMode() {
    return Boolean(this.clean);
  }

  /**
   * C1: stamp this window's owner identity onto future ready registry entries.
   * The owner is the extension host process (vscodePid = process.pid) plus a
   * stable window id. Entries without a numeric owner stay legacy-compatible
   * and are left untouched by the activation sweep.
   * @param {{vscodePid?: number|null, windowId?: string|null}} identity
   * @returns {{vscodePid: number|null, windowId: string|null}} the normalized identity.
   */
  setOwnerIdentity({ vscodePid = null, windowId = null } = {}) {
    this.ownerVscodePid = Number.isInteger(vscodePid) ? vscodePid : null;
    this.ownerWindowId = typeof windowId === 'string' && windowId.length > 0 ? windowId : null;
    return { vscodePid: this.ownerVscodePid, windowId: this.ownerWindowId };
  }

  /** Number of successful patch-drop self-heal retries this window performed. */
  selfHealCount() {
    return this._selfHealCount;
  }

  /** Static read helper: an old registry entry without the key reads as non-clean. */
  static isCleanEntry(entry) {
    return Boolean(entry && entry.clean === true);
  }

  /**
   * Extra CLI arguments appended to every future owned DSH spawn (the
   * dsh.extraArgs setting). Validated once here; buildManagedLaunchSpec
   * appends them after its own flags so user flags can still override
   * profile defaults but never the extension-owned --host/--port safety net.
   */
  setExtraArgs(extraArgs) {
    if (extraArgs === undefined || extraArgs === null) {
      this._extraArgs = [];
      return [];
    }
    if (!Array.isArray(extraArgs) || extraArgs.some((value) => typeof value !== 'string' || value.includes('\0'))) {
      throw new TypeError('extraArgs must be an array of strings');
    }
    this._extraArgs = [...extraArgs];
    return [...this._extraArgs];
  }

  /** Merge environment values used by future owned DSH spawns. */
  setSpawnEnv(spawnEnv) {
    if (!spawnEnv || typeof spawnEnv !== 'object') throw new TypeError('spawnEnv must be an object');
    this.spawnEnv = { ...this.spawnEnv, ...spawnEnv };
    return { ...this.spawnEnv };
  }

  /** True while this manager still owns a spawned child, including startup. */
  hasOwnedChild() {
    return Boolean(this._child);
  }

  /** Pid of this window's owned child, or null when none. */
  currentChildPid() {
    return this._child && Number.isInteger(this._child.pid) ? this._child.pid : null;
  }

  /** Invalidate the current ensure/spawn operation without affecting later ones. */
  cancelPending() {
    this._cancelGeneration += 1;
  }

  /** Environment inherited by this window's managed DSH child. */
  _buildSpawnEnv() {
    return {
      ...process.env,
      ...this.spawnEnv,
      ...(this.resolvedRuntime ? { DSH_HOME: this.resolvedRuntime.dshHome } : {}),
      DSH_TEXT_EDITOR: 'vscode',
    };
  }

  _throwIfCancelled(generation) {
    if (generation !== this._cancelGeneration) {
      throw new ServerError('DSH lifecycle operation was cancelled');
    }
  }

  /** Build a reuse handle without losing ownership of our own ready child. */
  _reuseHandle(host, port) {
    const owned = Boolean(
      this._child
      && this._ownedServer
      && this._ownedServer.pid === this._child.pid
      && this._ownedServer.host === host
      && this._ownedServer.port === port
    );
    return {
      url: `http://${host}:${port}`,
      host,
      port,
      pid: owned ? this._child.pid : null,
      owned,
    };
  }

  /**
   * Try to adopt a DSH instance that is already serving `host:port`.
   *
   * Unlike ensureServer()'s default autoStart path this is an explicit
   * caller-requested fallback: it never spawns and never kills anything. It
   * returns a non-owned reuse handle when the endpoint answers as DSH, or
   * null when the endpoint is unreachable / non-DSH / probing fails.
   * Status is emitted through the same lifecycle channel as ensureServer().
   *
   * @param {string} host - DSH endpoint host.
   * @param {number} port - DSH endpoint port.
   * @returns {Promise<object|null>} RunningServer handle, or null.
   */
  async adoptRunningDsh(host, port) {
    try {
      this._emit('probing', 'Probing DSH service: http://{host}:{port}…', { host, port });
      const result = await this.probeWithRetry(host, port);
      if (result && result.reachable && result.isDsh) {
        this._emit('reusing', 'Found a running DSH instance at http://{host}:{port}, reusing', { host, port });
        this._startHealthWatch(host, port);
        return this._reuseHandle(host, port);
      }
    } catch {
      // The caller keeps its original error and decides whether to surface it.
    }
    return null;
  }

  /**
   * Report a lifecycle transition. template is an English l10n template with
   * {name} placeholders and params its values; the listener localizes it
   * (e.g. through vscode.l10n). An optional running-server handle is attached
   * for states that carry one (ready). Callback errors are swallowed so a
   * broken UI listener can never break the manager.
   */
  _emit(state, template, params, server) {
    try {
      const payload = { state, message: template, params: params || {} };
      if (server) payload.server = server;
      this.onStatus(payload);
    } catch {
      // ignore listener errors
    }
  }

  /**
   * Probe host:port with a bounded raw HTTP GET over TCP and a 3s timeout.
   * Raw TCP is deliberate: the F5 Extension Host enables Node's experimental
   * network inspector, whose node:http instrumentation can throw
   * `Missing dataLength in event` and strand the probe Promise forever.
   * Redirects are never followed.
   * Returns:
   *   { reachable: true,  isDsh: true  } — HTTP 200 + BOOT_MARKER in body
   *   { reachable: true,  isDsh: false } — responded, but no BOOT_MARKER
   *   { reachable: false, reason: 'refused' } — connection refused: port free
   *   { reachable: false, reason: 'timeout' } — listener silent: port busy
   *   { reachable: false, reason: '<code>' }  — other transport failure
   */
  async probe(host, port) {
    return new Promise((resolve) => {
      let done = false;
      let raw = '';
      const finish = (result) => {
        if (!done) {
          done = true;
          socket.destroy();
          resolve(result);
        }
      };

      const socket = net.createConnection({ host, port });
      socket.setEncoding('utf8');
      socket.setTimeout(PROBE_TIMEOUT_MS);
      socket.on('connect', () => {
        socket.write(
          `GET / HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\nAccept: text/html\r\n\r\n`
        );
      });
      socket.on('data', (chunk) => {
        const remaining = MAX_BODY_BYTES - raw.length;
        if (remaining > 0) raw += chunk.slice(0, remaining);
        const status = /^HTTP\/1\.[01]\s+(\d{3})\b/.exec(raw);
        if (status && Number(status[1]) === 200 && raw.includes(BOOT_MARKER)) {
          finish({ reachable: true, isDsh: true });
        } else if (raw.length >= MAX_BODY_BYTES) {
          finish({ reachable: true, isDsh: false });
        }
      });
      socket.on('end', () => {
        const status = /^HTTP\/1\.[01]\s+(\d{3})\b/.exec(raw);
        finish({
          reachable: true,
          isDsh: Boolean(status && Number(status[1]) === 200 && raw.includes(BOOT_MARKER)),
        });
      });
      socket.on('timeout', () => finish({ reachable: false, reason: 'timeout' }));
      socket.on('error', (error) => finish({
        reachable: false,
        reason: error && error.code === 'ECONNREFUSED' ? 'refused' : String(error && error.code || 'error'),
      }));
    });
  }

  /**
   * Probe with retries: call probe() up to `attempts` times. The first result
   * with reachable===true (regardless of isDsh) is returned immediately — a
   * reachable answer is definitive, so a busy-but-alive service is never
   * classified as unreachable. Only when every attempt is unreachable is the
   * last result returned; its `reason` then tells the caller whether the port
   * was refused (free) or silent/timed out (treat as occupied). Used by
   * ensureServer before deciding to spawn, to prevent duplicate instances
   * when DSH is busy (e.g. streaming a reply) and a single probe would time
   * out.
   */
  async probeWithRetry(host, port, { attempts = 3, delayMs = 400 } = {}) {
    const n = Math.max(1, attempts); // at least one attempt, even for 0/negative input
    let last = null;
    for (let i = 0; i < n; i++) {
      last = await this.probe(host, port);
      if (last.reachable) return last;
      if (i < n - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return last;
  }

  /**
   * Equivalent to probe(), but returns a simple boolean: is this URL a live DSH?
   * Single-shot by design — meant for fast, cheap polling (e.g. the health
   * poll after spawn); use probeWithRetry() when a definitive answer is needed.
   */
  async healthCheck(url) {
    let host;
    let port;
    try {
      const parsed = new URL(url);
      host = parsed.hostname;
      port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
    } catch {
      return false;
    }
    const result = await this.probe(host, port);
    return Boolean(result.isDsh);
  }

  /**
   * Ensure a DSH web service is available for this VS Code window.
   *  - autoStart === true (default) is window-owned mode: reuse only this
   *    manager's own healthy child. Any service already occupying the
   *    configured port belongs to somebody else, so scan forward and spawn a
   *    dedicated child. This gives each VS Code extension host one process.
   *  - autoStart === false is user-managed mode: reuse a DSH already running
   *    on the configured port and never stop it.
   *  - A non-DSH occupant scans from port + 1; an unreachable port scans from
   *    the configured port itself.
   *  - autoStart === false when reuse is impossible (non-DSH occupant or
   *    unreachable) → throw the original error message.
   *  - On spawn success the { pid, port, host, cwd, at } entry is merged into
   *    the registry for cleanup/diagnostics (never for cross-window adoption).
   *  - cwd: DSH workspace root directory (used as the spawn cwd); null /
   *    undefined / empty string = not specified — the child inherits the
   *    parent process's cwd (no fallback to the user home directory).
   *  - registryFile: path of the instance registry (JSON array of entries).
   *  - Returns a RunningServer: { url, host, port, pid, owned }.
   */
  async ensureServer({ host = DEFAULT_HOST, port = DEFAULT_PORT, autoStart = true, cwd, registryFile } = {}) {
    const generation = this._cancelGeneration;
    if (host !== DEFAULT_HOST) {
      throw new ServerError(STARTUP_ERRORS.CONFIG_HOST_UNSUPPORTED.template, {
        host,
        expected: DEFAULT_HOST,
      }, 'CONFIG_HOST_UNSUPPORTED');
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ServerError(STARTUP_ERRORS.CONFIG_PORT_INVALID.template, { port }, 'CONFIG_PORT_INVALID');
    }
    // Step 1: a repeated ensure in this extension host keeps ownership of its
    // own child, including when that child lives on a scanned-forward port.
    if (autoStart && this._child && this._ownedServer && this._ownedServer.host === host) {
      const own = this._ownedServer;
      this._emit('probing', 'Probing DSH service: http://{host}:{port}…', { host, port: own.port });
      const ownProbe = await this.probeWithRetry(host, own.port);
      this._throwIfCancelled(generation);
      if (ownProbe.isDsh) return this._reuseHandle(host, own.port);
      // A child that no longer serves DSH must not be left behind while a
      // replacement starts. stop() is ownership-gated and removes only ours.
      await this.stop();
      this._throwIfCancelled(generation);
    }

    this._emit('probing', 'Probing DSH service: http://{host}:{port}…', { host, port });

    // Step 2: probe the configured port (with retries against transient busyness).
    const r = await this.probeWithRetry(host, port);
    this._throwIfCancelled(generation);

    // Step 3: reuse is an explicit user-managed mode only. Default autoStart
    // never adopts another window's child or a manually started service.
    if (!autoStart) {
      if (r.reachable && r.isDsh) {
        this._emit('reusing', 'Found a running DSH instance at http://{host}:{port}, reusing', { host, port });
        return this._reuseHandle(host, port);
      }
      throw new ServerError(STARTUP_ERRORS.AUTOSTART_DISABLED.template, {}, 'AUTOSTART_DISABLED');
    }

    // Step 4: any occupied port belongs to another owner and must not be
    // reused; a dead port can host this window's new child. A probe that
    // timed out means a listener exists but did not answer — also occupied, so
    // only an explicit connection refusal counts as free. Within one
    // ServerManager instance, never reuse the last port this instance
    // spawned (fresh origin) so DSH does not cache the previous workspace
    // under the same origin.
    const occupied = r.reachable || r.reason !== 'refused';
    let scanStart = occupied ? port + 1 : port;
    if (this._lastSpawnPort !== null && scanStart <= this._lastSpawnPort) {
      scanStart = this._lastSpawnPort + 1;
    }
    const freePort = await this._findFreePort(host, scanStart);
    this._lastSpawnPort = freePort;
    this._throwIfCancelled(generation);
    return this._spawnAndWait(host, freePort, cwd, registryFile, generation);
  }

  /**
   * Scan forward from startPort (inclusive) for up to PORT_SCAN_LIMIT ports;
   * only a connection-refused port (reachable=false, reason='refused') is
   * considered free. A timed-out probe means a silent listener may own the
   * port, so it is skipped conservatively instead of risking an EADDRINUSE
   * spawn and a misleading "process exited early" error.
   */
  async _findFreePort(host, startPort) {
    for (let i = 0; i < PORT_SCAN_LIMIT; i++) {
      const candidate = startPort + i;
      const probeResult = await this.probe(host, candidate);
      if (!probeResult.reachable && probeResult.reason === 'refused') return candidate;
    }
    throw new ServerError(STARTUP_ERRORS.NO_FREE_PORT.template, {
      limit: PORT_SCAN_LIMIT,
      start: startPort,
    }, 'NO_FREE_PORT');
  }

  /**
   * Resolve the spawn working directory from the caller-provided cwd.
   * null / undefined / empty string mean "not specified" → undefined, so the
   * spawned child inherits the parent process's cwd; any other value passes
   * through unchanged. There is deliberately NO fallback to USERPROFILE/HOME.
   */
  _resolveSpawnCwd(cwd) {
    return cwd === null || cwd === undefined || cwd === '' ? undefined : cwd;
  }

  /**
   * Compare two paths for "same directory". Windows: path.resolve-normalized
   * and case-insensitive (tolerates drive-case and trailing-slash
   * differences); other platforms: plain path.resolve equality.
   */
  static samePath(a, b) {
    if (a === b) return true;
    if (typeof a !== 'string' || typeof b !== 'string' || a === '' || b === '') return false;
    try {
      if (process.platform === 'win32') {
        return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
      }
      return path.resolve(a) === path.resolve(b);
    } catch {
      return false;
    }
  }

  /**
   * Existence check for a pid. NEVER kills anything — the process may belong
   * to another VS Code window. Windows: tasklist /FI is the primary check; if
   * tasklist cannot run (e.g. a sandboxed test environment), fall back to the
   * portable process.kill(pid, 0) probe. ESRCH ⇒ definitely gone (false);
   * anything undeterminable (EPERM, tasklist failure) ⇒ keep (true).
   */
  static _isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (process.platform === 'win32') {
      try {
        const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        // CSV line looks like "node.exe","1234",... — the pid appears quoted.
        return out.includes(`,"${pid}",`);
      } catch {
        // tasklist unavailable: use the portable existence probe instead.
        try {
          process.kill(pid, 0);
          return true;
        } catch (err) {
          return !(err && err.code === 'ESRCH');
        }
      }
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return !(err && err.code === 'ESRCH');
    }
  }

  /** Parse the registry file as-is; [] when missing/unparseable; a legacy single-object file is wrapped. */
  static _readRegistryRaw(registryFile) {
    try {
      const parsed = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === 'object') return [parsed];
      return [];
    } catch {
      return [];
    }
  }

  /** Read the registry, dropping entries whose process is dead (never kills). */
  static _readRegistry(registryFile) {
    return ServerManager._readRegistryRaw(registryFile).filter(
      (e) => e && ServerManager._isProcessAlive(e.pid)
    );
  }

  /** Best-effort write of the registry array (creates the parent directory). */
  static _writeRegistry(registryFile, entries) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(registryFile)), { recursive: true });
      fs.writeFileSync(registryFile, JSON.stringify(entries, null, 2) + '\n');
    } catch {
      // registry persistence is best-effort bookkeeping
    }
  }

  /** Merge one entry into the registry: replaces any same-port entry, keeps the rest. */
  static _mergeRegistry(registryFile, entry) {
    if (!registryFile) return;
    const entries = ServerManager._readRegistry(registryFile).filter(
      (e) => !(e && e.port === entry.port)
    );
    entries.push(entry);
    ServerManager._writeRegistry(registryFile, entries);
  }

  /** Remove ONLY the entry with the given pid; other windows' entries stay. */
  static _removeRegistryEntry(registryFile, pid) {
    if (!registryFile) return;
    const entries = ServerManager._readRegistryRaw(registryFile).filter(
      (e) => !(e && e.pid === pid)
    );
    ServerManager._writeRegistry(registryFile, entries);
  }

  /** Pure launch-spec assembly for the configured managed runtime and optional embed overlay. */
  _effectivePatchPath() {
    return this.clean && this.cleanPatchPath != null ? this.cleanPatchPath : this.embedPatchPath;
  }

  /** Pure launch-spec assembly for the configured managed runtime and optional patch overlay. */
  _buildLaunchSpec(host, port, usePatch = true) {
    const patchPath = usePatch ? this._effectivePatchPath() : null;
    // --no-open is passed only while not suppressed (spawn self-heal) and
    // while the resolved runtime's version is known-new enough (or unknown,
    // in which case the self-heal below covers a wrong optimistic guess).
    const noOpen = !this._noOpenSuppressed
      && supportsNoOpenFlag(this.resolvedRuntime && this.resolvedRuntime.dshVersion);
    const spec = buildManagedLaunchSpec(
      this.resolvedRuntime,
      host,
      port,
      process.platform,
      {
        ...(patchPath === null || patchPath === undefined ? {} : { patchPath }),
        noOpen,
      }
    );
    const extra = Array.isArray(this._extraArgs) ? this._extraArgs : [];
    if (extra.length === 0) return spec;
    return Object.freeze({ ...spec, args: Object.freeze([...spec.args, ...extra]) });
  }

  /**
   * Spawn the verified managed runtime and poll until the service is
   * ready, the process exits early, or the 30s deadline passes. The spawn cwd
   * follows the ensureServer contract: only an explicitly provided cwd is
   * used; otherwise the child inherits the extension host's current directory.
   */
  async _spawnAndWait(host, port, cwd, registryFile, generation = this._cancelGeneration) {
    this._throwIfCancelled(generation);
    try {
      return await this._spawnWithPatchSelfHeal(host, port, cwd, registryFile, generation, true);
    } catch (err) {
      // --no-open self-heal: a runtime older than 0.1.0-rc.7 rejects the
      // flag through Commander's "unknown option" error and exits before
      // the health probe can pass. When the per-spawn log proves exactly
      // that rejection, retry once with the flag removed; the suppression
      // sticks for the session so later restarts skip the broken flag.
      if (!(err && err.code === 'SPAWN_EXITED_EARLY')) throw err;
      if (!this._lastSpawnPassedNoOpen()) throw err;
      if (!isNoOpenStderr(this._readLastSpawnLogTail())) throw err;
      this._noOpenSuppressed = true;
      try {
        const server = await this._spawnWithPatchSelfHeal(host, port, cwd, registryFile, generation, true);
        this._selfHealCount += 1;
        this._emit('selfheal', 'DSH runtime rejected --no-open (older than 0.1.0-rc.7); retried without the flag');
        return server;
      } catch (err2) {
        // No second retry: the original SPAWN_EXITED_EARLY code stands.
        throw err2;
      }
    }
  }

  /** True when the most recent spawn actually passed --no-open. */
  _lastSpawnPassedNoOpen() {
    return Array.isArray(this._lastSpawnArgs) && this._lastSpawnArgs.includes('--no-open');
  }

  /** Tail (last 8 KiB) of the most recent per-spawn log, or '' when absent. */
  _readLastSpawnLogTail(maxBytes = 8192) {
    const logPath = this._lastSpawnLogPath;
    if (typeof logPath !== 'string' || logPath.length === 0) return '';
    try {
      const stat = fs.statSync(logPath);
      const start = Math.max(0, stat.size - maxBytes);
      const fd = fs.openSync(logPath, 'r');
      try {
        const buffer = Buffer.alloc(stat.size - start);
        fs.readSync(fd, buffer, 0, buffer.length, start);
        return buffer.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return '';
    }
  }

  /** Session flag: the current runtime rejected --no-open once already. */
  noOpenSuppressed() {
    return Boolean(this._noOpenSuppressed);
  }

  // D1 -patch self-heal: when the first spawn exits early while a --patch
  // overlay was in effect, retry exactly once with the patch removed. A
  // successful retry continues transparently and is recorded for Diagnose;
  // a second early exit reports the original SPAWN_EXITED_EARLY error.
  async _spawnWithPatchSelfHeal(host, port, cwd, registryFile, generation, usePatch) {
    const hadPatch = usePatch && this._effectivePatchPath() != null;
    try {
      return await this._spawnAttempt(host, port, cwd, registryFile, generation, usePatch);
    } catch (err) {
      if (!(hadPatch && err && err.code === 'SPAWN_EXITED_EARLY')) throw err;
      try {
        const server = await this._spawnAttempt(host, port, cwd, registryFile, generation, false);
        this._selfHealCount += 1;
        this._emit('selfheal', 'DSH exited early with --patch; retried without --patch');
        return server;
      } catch (err2) {
        // No second retry: the original SPAWN_EXITED_EARLY code stands.
        throw err2;
      }
    }
  }

  _spawnAttempt(host, port, cwd, registryFile, generation = this._cancelGeneration, usePatch = true) {
    this._throwIfCancelled(generation);
    if (!this.resolvedRuntime) {
      throw new ServerError('Managed DSH runtime is unavailable; install or verify it before auto-start');
    }
    const launch = this._buildLaunchSpec(host, port, usePatch);
    this._lastSpawnArgs = launch.args;
    const spawnCwd = this._resolveSpawnCwd(cwd);
    // Capture stdout/stderr into a per-spawn log next to the instance registry
    // (truncated on every spawn), so an unexpected exit leaves something to
    // diagnose beyond the exit code. Fallback to stdio:'ignore' when the log
    // cannot be opened (e.g. read-only global storage).
    let logPath = null;
    let logFd = null;
    if (registryFile) {
      logPath = path.join(path.dirname(path.resolve(registryFile)), `dsh-server-${port}-${process.pid}.log`);
      try {
        logFd = fs.openSync(logPath, 'w');
      } catch {
        logPath = null;
        logFd = null;
      }
    }
    this._lastSpawnLogPath = logPath;
    // Include the cwd option ONLY when explicitly requested; otherwise omit it
    // entirely so the child inherits the parent process's current directory
    // (no fallback to the user home directory).
    const opts = {
      stdio: logFd === null ? 'ignore' : ['ignore', logFd, logFd],
      // Tell a DSH instance managed by this extension to route text-file
      // gestures back into the current VS Code window. Ordinary standalone
      // DSH processes keep their platform-default editor behavior.
      env: { ...this._buildSpawnEnv(), ...launch.env },
      ...(spawnCwd !== undefined ? { cwd: spawnCwd } : {}),
      windowsHide: launch.windowsHide,
      detached: launch.detached,
    };
    // POSIX uses a dedicated process group so extension deactivation can stop
    // the whole managed tree. Windows taskkill /T applies the same ownership
    // boundary to the native runtime executable.
    const child = this.spawnFn(launch.command, launch.args, opts);
    if (logFd !== null) {
      try { fs.closeSync(logFd); } catch { /* child holds the duplicated descriptor */ }
    }

    this._child = child;
    this._emit('starting', 'Starting DSH web (pid={pid}, port={port})…', { pid: child.pid, port });

    return new Promise((resolve, reject) => {
      const deadline = Date.now() + HEALTH_TIMEOUT_MS;
      let settled = false;

      // Persistent listener: any exit NOT caused by stop() is unexpected and
      // reported through onStatus (e.g. the service crashed after becoming ready).
      const onUnexpectedExit = (code, signal) => {
        if (this._stopping) return;        // deliberate stop()
        if (this._child !== child) return; // already detached (timeout cleanup)
        this._child = null;
        this._ownedServer = null;
        // code/signal are null on the opposite exit paths (Windows clean
        // exit has signal=null); the {placeholder} renderer keeps nulls as
        // literal "{signal}", so normalize both to a visible value.
        this._emit('error', 'DSH process exited unexpectedly (pid={pid}, code={code}, signal={signal})', {
          pid: child.pid,
          code: code == null ? 'none' : code,
          signal: signal == null ? 'none' : signal,
          log: logPath,
        });
      };
      child.on('exit', onUnexpectedExit);

      child.once('error', (err) => {
        if (settled) return;
        settled = true;
        if (this._child === child) this._child = null;
        this._ownedServer = null;
        this._emit('error', STARTUP_ERRORS.SPAWN_ERROR.template, { error: err.message, log: logPath });
        reject(new ServerError(STARTUP_ERRORS.SPAWN_ERROR.template, { error: err.message }, 'SPAWN_ERROR'));
      });

      child.once('exit', (code, signal) => {
        if (settled) return;
        settled = true;
        if (this._stopping) {
          reject(new ServerError('DSH process was stopped'));
          return;
        }
        reject(new ServerError(STARTUP_ERRORS.SPAWN_EXITED_EARLY.template, {
          code: code == null ? 'none' : code,
          signal: signal == null ? 'none' : signal,
        }, 'SPAWN_EXITED_EARLY'));
      });

      const poll = async () => {
        if (settled) return;
        if (generation !== this._cancelGeneration) {
          settled = true;
          if (this._child === child) this._child = null;
          child.removeListener('exit', onUnexpectedExit);
          await this._killChild(child);
          reject(new ServerError('DSH lifecycle operation was cancelled'));
          return;
        }
        const probeResult = await this.probe(host, port);
        if (settled) return;

        if (probeResult.reachable && probeResult.isDsh) {
          settled = true;
          resolve(this._finalizeReady(host, port, cwd, child.pid, registryFile, logPath));
          return;
        }

        if (Date.now() >= deadline) {
          settled = true;
          this._child = null;
          this._ownedServer = null;
          child.removeListener('exit', onUnexpectedExit);
          await this._killChild(child); // best-effort cleanup of the hung process
          reject(new ServerError(
            STARTUP_ERRORS.HEALTH_TIMEOUT.template,
            { seconds: HEALTH_TIMEOUT_MS / 1000, pid: child.pid },
            'HEALTH_TIMEOUT'
          ));
          return;
        }

        setTimeout(poll, HEALTH_POLL_MS);
      };

      poll();
    });
  }

  /**
   * After the service is healthy: merge this instance's entry into the
   * registry (same-port entry replaced, others kept), emit {state:"ready"}
   * and return the RunningServer object.
   */
  _finalizeReady(host, port, cwd, pid, registryFile, logPath = null) {
    this._registryFile = registryFile || null;
    if (registryFile) {
      const entryCwd = cwd === null || cwd === undefined || cwd === '' ? null : cwd;
      ServerManager._mergeRegistry(registryFile, {
        pid,
        port,
        host,
        cwd: entryCwd,
        clean: Boolean(this.clean),
        // C1 owner-marked registry: lets the next activation sweep tree-kill
        // only entries whose owner extension-host is confirmed dead; never
        // present on legacy entries (read compatibly as "no owner marker").
        vscodePid: this.ownerVscodePid,
        windowId: this.ownerWindowId,
        at: Date.now(),
        ...(logPath ? { log: logPath } : {}),
      });
    }
    const server = { url: `http://${host}:${port}`, host, port, pid, owned: true };
    this._ownedServer = server;
    this._emit('ready', 'DSH web ready: http://{host}:{port} (pid={pid})', { host, port, pid }, server);
    this._startHealthWatch(host, port);
    return server;
  }

  /**
   * Kill a child process tree owned by this manager.
   *
   * @param {object} child - ChildProcess-like handle with a pid.
   * @param {object} [options] - Injectable seams for tests; forwarded to
   *   `killProcessTree`.
   * @returns {Promise<void>}
   */
  _killChild(child, options = {}) {
    return killProcessTree(child.pid, options);
  }

  /**
   * Stop the instance: kill whatever this instance spawned, remove ONLY this
   * instance's entry from the registry (other windows' entries stay) and
   * clear internal records. Safe to call when nothing was spawned.
   */
  /**
   * Post-ready health watchdog (credited to the MIT-licensed
   * Fengze233/dsh-vscode ServiceManager.startHealthWatch): poll the ready
   * endpoint every 30s; when it stops answering as DSH — the child was
   * killed from outside, the machine resumed from sleep, a port hijack —
   * emit a 'lost' status so the sidebar can surface the disconnect instead
   * of silently showing a dead iframe. The timer self-clears on loss; stop()
   * and a fresh ensureServer cycle clear it as well.
   */
  _startHealthWatch(host, port, intervalMs = 30000) {
    this._clearHealthWatch();
    // Instance-level override (mainly a test seam) beats the default cadence.
    const cadence = Number.isInteger(this._healthIntervalMs) && this._healthIntervalMs > 0
      ? this._healthIntervalMs
      : intervalMs;
    this._healthPort = port;
    this._healthTimer = setInterval(() => {
      Promise.resolve(this.probe(host, port))
        .then((result) => {
          if (this._healthTimer === null) return;
          if (result && result.reachable && result.isDsh) return;
          this._clearHealthWatch();
          this._emit('lost', 'DSH service stopped answering at http://{host}:{port}', { host, port });
        })
        .catch(() => { /* probe errors are treated as silent */ });
    }, cadence);
    if (typeof this._healthTimer.unref === 'function') this._healthTimer.unref();
  }

  _clearHealthWatch() {
    if (this._healthTimer !== null) {
      clearInterval(this._healthTimer);
      this._healthTimer = null;
    }
    this._healthPort = null;
  }

  async stop() {
    this._emit('stopping', 'Stopping DSH process…');
    this._stopping = true;

    const child = this._child;
    if (child) {
      await this._killChild(child);
      // Fallback: if the child has not exited yet (e.g. taskkill failed),
      // force-kill it directly.
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill(); } catch { /* ignore */ }
      }
    }

    // Remove ONLY our own entry (matched by the pid we spawned); entries of
    // other VS Code windows must survive.
    if (this._registryFile && child) {
      ServerManager._removeRegistryEntry(this._registryFile, child.pid);
    }

    this._child = null;
    this._ownedServer = null;
    this._registryFile = null;
    this._stopping = false;
    this._clearHealthWatch();

    this._emit('stopped', child ? 'DSH process stopped' : 'No process was started by this instance');
  }

  /**
   * Clean up a stale registry file: read it, write back only the entries
   * whose process is still alive, and NEVER kill any process (a live DSH may
   * belong to another VS Code window). A missing or corrupt file is removed.
   */
  static cleanupStaleRegistry(registryFile) {
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    } catch {
      parsed = null; // missing or unparseable
    }
    if (!Array.isArray(parsed)) {
      // Missing / corrupt / legacy single-object file: nothing to salvage —
      // remove it (best effort). A missing file raises ENOENT — ignored.
      try { fs.unlinkSync(registryFile); } catch { /* ignore */ }
      return;
    }
    const alive = parsed.filter((e) => e && ServerManager._isProcessAlive(e.pid));
    if (alive.length !== parsed.length) {
      ServerManager._writeRegistry(registryFile, alive);
    }
  }

  /**
   * Backward-compatible alias of cleanupStaleRegistry (legacy name used by
   * extension.js). NOTE: unlike the old behavior it never kills anything.
   */
  static cleanupStalePid(registryFile) {
    return ServerManager.cleanupStaleRegistry(registryFile);
  }

  /**
   * List registry entries whose pid is still alive, without writing the file.
   * Used by the orphan-cleanup command; a live DSH may belong to another
   * VS Code window, so this never kills anything by itself.
   *
   * @param {string} registryFile - Registry JSON path.
   * @returns {Array<object>} Alive raw entries (host/port/pid/cwd/at).
   */
  static aliveRegistryEntries(registryFile) {
    return ServerManager._readRegistry(registryFile);
  }

  /**
   * Remove registry entries with the given pids (best effort). Used after the
   * user explicitly stops an orphan or chooses to drop its stale record.
   *
   * @param {string} registryFile - Registry JSON path.
   * @param {number[]} pids - Pids whose entries must be removed.
   */
  static removeRegistryEntries(registryFile, pids) {
    if (!Array.isArray(pids) || pids.length === 0) return;
    const wanted = new Set(pids);
    const entries = ServerManager._readRegistryRaw(registryFile).filter(
      (e) => !(e && wanted.has(e.pid))
    );
    ServerManager._writeRegistry(registryFile, entries);
  }

  /**
   * C1 owner-marked orphan sweep (activation-time, before L0). Reads the raw
   * registry and, for every new-style entry that carries a numeric owner
   * (`vscodePid`), tree-kills the entry's DSH child process when the recorded
   * owner extension-host pid is no longer alive, then drops the entry.
   *
   * Safety rules (multi-window zero mis-kill):
   *  - an entry whose owner is still alive is NEVER touched (another live
   *    VS Code window owns it);
   *  - legacy entries WITHOUT a numeric vscodePid are left alone — they may
   *    belong to a still-running pre-C1 window, and dead-child pruning of such
   *    entries stays the job of cleanupStaleRegistry();
   *  - entries owned by `currentVscodePid` (this window) are never swept.
   *
   * Reuses the exact tree-kill implementation that backs the orphan-cleanup
   * command (`killProcessTree`); nothing here re-implements process killing.
   *
   * @param {string} registryFile - Registry JSON path.
   * @param {object} [options]
   * @param {(pid: number) => Promise<void>} [options.terminate] - defaults to killProcessTree.
   * @param {(pid: number) => boolean} [options.isProcessAlive] - defaults to ServerManager._isProcessAlive.
   * @param {number|null} [options.currentVscodePid] - this window's extension-host pid.
   * @returns {Promise<Array<{pid: number, port: number|undefined, vscodePid: number}>>} swept entries.
   */
  static async sweepDeadOwnerEntries(registryFile, { terminate = null, isProcessAlive = null, currentVscodePid = null } = {}) {
    const kill = typeof terminate === 'function' ? terminate : (pid) => killProcessTree(pid);
    const alive = typeof isProcessAlive === 'function' ? isProcessAlive : (pid) => ServerManager._isProcessAlive(pid);
    const keep = [];
    const swept = [];
    for (const entry of ServerManager._readRegistryRaw(registryFile)) {
      if (!entry || !Number.isInteger(entry.pid)) {
        keep.push(entry);
        continue;
      }
      const owner = entry.vscodePid;
      if (!Number.isInteger(owner) || owner <= 0) {
        // Legacy / ownerless: compatible read, leave to dead-pid pruning.
        keep.push(entry);
        continue;
      }
      if (currentVscodePid !== null && currentVscodePid !== undefined && owner === currentVscodePid) {
        keep.push(entry);
        continue;
      }
      if (alive(owner)) {
        // Owner extension-host is alive: never touch another window's child.
        keep.push(entry);
        continue;
      }
      try {
        await kill(entry.pid);
      } catch {
        // best-effort tree-kill; the record is still dropped below.
      }
      swept.push({ pid: entry.pid, port: entry.port, vscodePid: owner });
    }
    if (swept.length > 0) {
      ServerManager._writeRegistry(registryFile, keep);
    }
    return swept;
  }
}

module.exports = {
  ServerManager,
  ServerError,
  CLOSE_POLICIES,
  DEFAULT_CLOSE_POLICY,
  killProcessTree,
  normalizeClosePolicy,
  shouldStopOnViewClose,
  shouldStopOwnedServer,
  sameEndpoint,
  reconcileConfigChange,
  buildManagedLaunchSpec,
  normalizeResolvedRuntime,
  sweepDeadOwnerEntries: (registryFile, options) => ServerManager.sweepDeadOwnerEntries(registryFile, options),
};
