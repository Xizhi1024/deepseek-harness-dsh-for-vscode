'use strict';

/**
 * serverManager.js — manages the local DeepSeek Harness (DSH) web service
 * from a VS Code auxiliary sidebar.
 *
 * Responsibilities:
 *   - probe a host:port to detect whether the DSH web UI is running there
 *     (its index.html body contains the BOOT_MARKER symbol).
 *   - start one window-owned DSH instance via the globally installed `dsh`
 *     CLI on a free port (scanning forward from the configured port), or
 *     reuse a user-managed instance only when autoStart is disabled.
 *   - keep a JSON instance registry for stale-entry cleanup and diagnostics;
 *     live entries from other VS Code windows are never adopted by default.
 *   - report lifecycle transitions through an `onStatus` callback.
 *
 * Zero external dependencies: only Node built-ins are used.
 */

const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

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
   */
  constructor(template, params) {
    super(fillTemplate(template, params));
    this.name = "ServerError";
    this.template = template;
    this.params = params || {};
  }
}

// ---------------------------------------------------------------------------
// Lifecycle decision functions.
//
// These are pure (no I/O, no vscode import): the same inputs always produce
// the same output. They live here — not in extension.js — so both the
// extension host and the standalone Node self-test exercise the exact same
// decision code, and so `node src/serverManager.js` stays meaningful.
// ---------------------------------------------------------------------------

/**
 * Allowed values of the `dsh.closePolicy` setting.
 *   - `onVscodeExit` — stop the owned server only when VS Code exits (default);
 *     closing the sidebar view keeps it running.
 *   - `onViewClose`  — also stop the owned server when the sidebar view is disposed.
 *   - `never`        — never stop the server automatically; the user stops it
 *     explicitly via `dsh.stopServer`. The process intentionally survives the
 *     extension host and can be adopted again through the instance registry.
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

class ServerManager {
  constructor({ onStatus, spawnEnv } = {}) {
    this.onStatus = typeof onStatus === 'function' ? onStatus : () => {};
    this.spawnEnv = spawnEnv && typeof spawnEnv === 'object' ? { ...spawnEnv } : {};
    this._child = null;   // ChildProcess spawned by THIS instance (owned)
    this._registryFile = null; // registry merged on ready (own entry removed on stop)
    this._stopping = false; // true while a deliberate stop() is in progress
    this._ownedServer = null; // last ready endpoint backed by this._child
    this._cancelGeneration = 0; // invalidates an in-flight ensure/spawn operation
  }

  /** True while this manager still owns a spawned child, including startup. */
  hasOwnedChild() {
    return Boolean(this._child);
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
   * Probe host:port with GET / and a 3s timeout. Redirects are never
   * followed (http.request default behavior — no manual following either).
   * Returns:
   *   { reachable: true,  isDsh: true  } — HTTP 200 + BOOT_MARKER in body
   *   { reachable: true,  isDsh: false } — responded, but no BOOT_MARKER
   *   { reachable: false }               — connection failed / timed out
   */
  async probe(host, port) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (result) => {
        if (!done) { done = true; resolve(result); }
      };

      const req = http.request(
        {
          host,
          port,
          path: '/',
          method: 'GET',
          timeout: PROBE_TIMEOUT_MS,
          // One-off agent: sockets are not pooled, so probes never keep a
          // server (or the extension process) alive after they finish.
          agent: false,
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            if (body.length < MAX_BODY_BYTES) body += chunk; // bounded read
          });
          res.on('end', () => {
            finish({
              reachable: true,
              isDsh: res.statusCode === 200 && body.includes(BOOT_MARKER),
            });
          });
          res.on('error', () => finish({ reachable: true, isDsh: false }));
        }
      );

      req.on('timeout', () => {
        // Timed out: destroy the socket so 'error' fires and we resolve as unreachable.
        req.destroy(new Error('probe timeout'));
      });
      req.on('error', () => finish({ reachable: false }));
      req.end();
    });
  }

  /**
   * Probe with retries: call probe() up to `attempts` times. The first result
   * with reachable===true (regardless of isDsh) is returned immediately — a
   * reachable answer is definitive, so a busy-but-alive service is never
   * classified as unreachable. Only when every attempt is unreachable is the
   * last result returned. Used by ensureServer before deciding to spawn, to
   * prevent duplicate instances when DSH is busy (e.g. streaming a reply) and
   * a single probe would time out.
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
      throw new ServerError('Unsupported dsh.host "{host}"; this extension requires {expected}', {
        host,
        expected: DEFAULT_HOST,
      });
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ServerError('Invalid dsh.port "{port}"; expected an integer from 1 to 65535', { port });
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
      throw new ServerError('DSH is not running and dsh.autoStart is disabled');
    }

    // Step 4: any occupied port belongs to another owner and must not be
    // reused; a dead port can host this window's new child.
    const scanStart = r.reachable ? port + 1 : port;
    const freePort = await this._findFreePort(host, scanStart);
    this._throwIfCancelled(generation);
    return this._spawnAndWait(host, freePort, cwd, registryFile, generation);
  }

  /**
   * Scan forward from startPort (inclusive) for up to PORT_SCAN_LIMIT ports;
   * the first port where probe() reports reachable:false is considered free.
   */
  async _findFreePort(host, startPort) {
    for (let i = 0; i < PORT_SCAN_LIMIT; i++) {
      const candidate = startPort + i;
      const probeResult = await this.probe(host, candidate);
      if (!probeResult.reachable) return candidate;
    }
    throw new ServerError('No free port found within {limit} ports starting from {start}', {
      limit: PORT_SCAN_LIMIT,
      start: startPort,
    });
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

  /**
   * Spawn the `dsh` CLI (cmd shim on Windows) and poll until the service is
   * ready, the process exits early, or the 30s deadline passes. The spawn cwd
   * follows the ensureServer contract: only an explicitly provided cwd is
   * used; otherwise the child inherits the extension host's current directory.
   */
  _spawnAndWait(host, port, cwd, registryFile, generation = this._cancelGeneration) {
    this._throwIfCancelled(generation);
    const isWindows = process.platform === 'win32';
    const spawnCwd = this._resolveSpawnCwd(cwd);
    // On Windows `dsh` is a cmd shim, so it must go through cmd.exe /c.
    // Include the cwd option ONLY when explicitly requested; otherwise omit it
    // entirely so the child inherits the parent process's current directory
    // (no fallback to the user home directory).
    const opts = {
      stdio: 'ignore',
      // Tell a DSH instance managed by this extension to route text-file
      // gestures back into the current VS Code window. Ordinary standalone
      // DSH processes keep their platform-default editor behavior.
      env: this._buildSpawnEnv(),
      ...(spawnCwd !== undefined ? { cwd: spawnCwd } : {}),
    };
    const child = isWindows
      ? spawn('cmd.exe', ['/c', 'dsh', 'web', '--host', host, '--port', String(port)], {
          ...opts,
          windowsHide: true,
        })
      : // POSIX: detached creates a dedicated process group solely so normal
        // extension deactivation can SIGTERM the whole DSH tree via kill(-pid)
        // in _killChild instead of leaving worker descendants behind.
        spawn('dsh', ['web', '--host', host, '--port', String(port)], {
          ...opts,
          detached: true,
        });

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
        this._emit('error', 'DSH process exited unexpectedly (pid={pid}, code={code}, signal={signal})', {
          pid: child.pid,
          code,
          signal,
        });
      };
      child.on('exit', onUnexpectedExit);

      child.once('error', (err) => {
        if (settled) return;
        settled = true;
        if (this._child === child) this._child = null;
        this._ownedServer = null;
        this._emit('error', 'Failed to start dsh: {error}', { error: err.message });
        reject(new Error('Failed to start dsh: ' + err.message));
      });

      child.once('exit', (code, signal) => {
        if (settled) return;
        settled = true;
        const template = this._stopping
          ? 'DSH process was stopped'
          : 'DSH process exited early (code={code}, signal={signal})';
        reject(new ServerError(template, this._stopping ? {} : { code, signal }));
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
          resolve(this._finalizeReady(host, port, cwd, child.pid, registryFile));
          return;
        }

        if (Date.now() >= deadline) {
          settled = true;
          this._child = null;
          this._ownedServer = null;
          child.removeListener('exit', onUnexpectedExit);
          await this._killChild(child); // best-effort cleanup of the hung process
          reject(new ServerError(
            'DSH service did not become ready within {seconds}s; process terminated (pid={pid})',
            { seconds: HEALTH_TIMEOUT_MS / 1000, pid: child.pid }
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
  _finalizeReady(host, port, cwd, pid, registryFile) {
    this._registryFile = registryFile || null;
    if (registryFile) {
      const entryCwd = cwd === null || cwd === undefined || cwd === '' ? null : cwd;
      ServerManager._mergeRegistry(registryFile, { pid, port, host, cwd: entryCwd, at: Date.now() });
    }
    const server = { url: `http://${host}:${port}`, host, port, pid, owned: true };
    this._ownedServer = server;
    this._emit('ready', 'DSH web ready: http://{host}:{port} (pid={pid})', { host, port, pid }, server);
    return server;
  }

  /**
   * Kill a child process. On Windows the spawned dsh is a cmd.exe wrapper,
   * so taskkill /T /F kills the whole tree and the promise resolves when
   * taskkill exits. On POSIX the child was spawned detached (its pid is the
   * process-group id), so SIGTERM the group first — dsh web and any workers
   * it spawned all die — then fall back to the single process.
   */
  _killChild(child) {
    if (process.platform === 'win32') {
      return new Promise((resolve) => {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        killer.once('error', () => resolve());
        killer.once('exit', () => resolve());
      });
    }
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        // already dead
      }
    }
    return Promise.resolve();
  }

  /**
   * Stop the instance: kill whatever this instance spawned, remove ONLY this
   * instance's entry from the registry (other windows' entries stay) and
   * clear internal records. Safe to call when nothing was spawned.
   */
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
}

module.exports = {
  ServerManager,
  ServerError,
  CLOSE_POLICIES,
  DEFAULT_CLOSE_POLICY,
  normalizeClosePolicy,
  shouldStopOnViewClose,
  shouldStopOwnedServer,
  sameEndpoint,
  reconcileConfigChange,
};

// ---------------------------------------------------------------------------
// Self-test (only runs when this file is executed directly):
//   node src/serverManager.js
// Verifies probe detection (DSH vs non-DSH vs closed port), probeWithRetry
// recovery from a busy/hanging DSH, the forward port scan, registry-based
// workspace matching (reuse vs spawn branch), dead-entry filtering, samePath,
// _resolveSpawnCwd, cleanupStaleRegistry safety and the no-op stop(). It
// NEVER spawns a real dsh process and never touches port 3080.
// ---------------------------------------------------------------------------
if (require.main === module) {
  (async () => {
    const assert = require('node:assert');
    const os = require('node:os');

    // --- Fixture servers on random high ports (listen(0) => OS-assigned).
    const dshServer = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><head><script>window.__DSH_BOOT__={config:{}}</script></head></html>');
    });
    await new Promise((resolve) => dshServer.listen(0, '127.0.0.1', resolve));
    const dshPort = dshServer.address().port;
    assert.notStrictEqual(dshPort, 3080, 'self-test port must never collide with the real DSH web port');

    const plainServer = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello');
    });
    await new Promise((resolve) => plainServer.listen(0, '127.0.0.1', resolve));
    const plainPort = plainServer.address().port;
    assert.notStrictEqual(plainPort, 3080);
    assert.notStrictEqual(plainPort, dshPort);

    // Guaranteed-closed port: bind, note the port, close, then probe it.
    const temp = http.createServer();
    await new Promise((resolve) => temp.listen(0, '127.0.0.1', resolve));
    const closedPort = temp.address().port;
    await new Promise((resolve) => temp.close(resolve));

    const mgr = new ServerManager();

    // 0. Endpoint validation rejects values the current DSH Web profile cannot
    //    serve, before any socket probe or cmd.exe argument construction.
    await assert.rejects(
      mgr.ensureServer({ host: '0.0.0.0', port: 3080 }),
      /requires 127\.0\.0\.1/
    );
    await assert.rejects(
      mgr.ensureServer({ host: '127.0.0.1', port: 0 }),
      /integer from 1 to 65535/
    );

    // 1. probe: DSH, non-DSH, closed port.
    const pDsh = await mgr.probe('127.0.0.1', dshPort);
    assert.deepStrictEqual(pDsh, { reachable: true, isDsh: true });
    const pPlain = await mgr.probe('127.0.0.1', plainPort);
    assert.deepStrictEqual(pPlain, { reachable: true, isDsh: false });
    const pClosed = await mgr.probe('127.0.0.1', closedPort);
    assert.deepStrictEqual(pClosed, { reachable: false });

    // 2. healthCheck mirrors probe as a boolean.
    assert.strictEqual(await mgr.healthCheck(`http://127.0.0.1:${dshPort}/`), true);
    assert.strictEqual(await mgr.healthCheck(`http://127.0.0.1:${plainPort}/`), false);

    // 3. Port scan skips the occupied port and finds a free one.
    const freePort = await mgr._findFreePort('127.0.0.1', plainPort);
    assert.ok(freePort > plainPort && freePort <= plainPort + PORT_SCAN_LIMIT, `free=${freePort}`);
    const pFree = await mgr.probe('127.0.0.1', freePort);
    assert.strictEqual(pFree.reachable, false);

    // 4. ensureServer reuses a detected DSH (no spawn).
    const statuses = [];
    const mgr2 = new ServerManager({ onStatus: (s) => statuses.push(s.state) });
    const reused = await mgr2.ensureServer({ host: '127.0.0.1', port: dshPort, autoStart: false });
    assert.deepStrictEqual(reused, { url: `http://127.0.0.1:${dshPort}`, host: '127.0.0.1', port: dshPort, pid: null, owned: false });
    assert.deepStrictEqual(statuses, ['probing', 'reusing']);

    // 5. autoStart:false on a non-DSH port throws the contract error.
    await assert.rejects(
      mgr2.ensureServer({ host: '127.0.0.1', port: plainPort, autoStart: false }),
      /autoStart/
    );

    // 6. cleanupStalePid is safe on a missing / unparseable pid file.
    const missingPid = path.join(os.tmpdir(), `dsh-stale-missing-${process.pid}-${Date.now()}.json`);
    assert.doesNotThrow(() => ServerManager.cleanupStalePid(missingPid));
    const badPid = path.join(os.tmpdir(), `dsh-stale-bad-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(badPid, 'this is not json');
    assert.doesNotThrow(() => ServerManager.cleanupStalePid(badPid));
    assert.strictEqual(fs.existsSync(badPid), false, 'stale pid file should be deleted');

    // 7. stop() is a safe no-op when nothing was spawned.
    const stopStatuses = [];
    const mgr3 = new ServerManager({ onStatus: (s) => stopStatuses.push(s.state) });
    await mgr3.stop();
    assert.deepStrictEqual(stopStatuses, ['stopping', 'stopped']);

    // 8. probeWithRetry recovers where a single probe misjudges: the fixture
    //    hangs the FIRST request (past the 3s probe timeout) and only answers
    //    the SECOND with the DSH boot marker (added time ~3s).
    let slowHits = 0;
    const slowDshServer = http.createServer((req, res) => {
      slowHits += 1;
      if (slowHits === 1) {
        return; // first request: never respond — the client probe times out
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><script>window.__DSH_BOOT__={}</script>');
    });
    await new Promise((resolve) => slowDshServer.listen(0, '127.0.0.1', resolve));
    const slowDshPort = slowDshServer.address().port;
    assert.notStrictEqual(slowDshPort, 3080);

    const singleProbe = await mgr.probe('127.0.0.1', slowDshPort); // hits the hang -> unreachable
    assert.deepStrictEqual(singleProbe, { reachable: false });
    const retried = await mgr.probeWithRetry('127.0.0.1', slowDshPort, { attempts: 3, delayMs: 400 });
    assert.deepStrictEqual(retried, { reachable: true, isDsh: true });

    // 9. Unit-check the retry loop itself (no network): the first two probe()
    //    attempts are unreachable, the third succeeds -> reachable is returned.
    class FlakyProbe extends ServerManager {
      constructor() {
        super();
        this.calls = 0;
      }
      async probe() {
        this.calls += 1;
        if (this.calls < 3) return { reachable: false };
        return { reachable: true, isDsh: true };
      }
    }
    const flaky = new FlakyProbe();
    const flakyResult = await flaky.probeWithRetry('127.0.0.1', 1, { attempts: 3, delayMs: 10 });
    assert.deepStrictEqual(flakyResult, { reachable: true, isDsh: true });
    assert.strictEqual(flaky.calls, 3, 'retry loop must call probe() attempts times');

    // 10. _resolveSpawnCwd: null/undefined/empty string -> undefined (inherit
    //     parent cwd); real paths pass through unchanged.
    const spawnCwdCases = [
      [null, undefined],
      [undefined, undefined],
      ['', undefined],
      ['D:\\ws', 'D:\\ws'],
      ['/home/user/ws', '/home/user/ws'],
    ];
    for (const [input, expected] of spawnCwdCases) {
      assert.strictEqual(
        mgr._resolveSpawnCwd(input),
        expected,
        `_resolveSpawnCwd(${JSON.stringify(input)}) should be ${JSON.stringify(expected)}`
      );
    }

    // 11. samePath: normalize + (win32) case-insensitive comparison.
    if (process.platform === 'win32') {
      assert.strictEqual(ServerManager.samePath('D:\\Coding', 'D:\\Coding\\'), true);
      assert.strictEqual(ServerManager.samePath('D:\\Coding', 'd:\\coding'), true);
      assert.strictEqual(ServerManager.samePath('D:\\Coding', 'D:\\Other'), false);
      assert.strictEqual(ServerManager.samePath('D:\\Coding', ''), false);
    } else {
      assert.strictEqual(ServerManager.samePath('/home/u/ws', '/home/u/ws/'), true);
      assert.strictEqual(ServerManager.samePath('/home/u/ws', '/home/u/other'), false);
    }

    // 12. Per-window ownership: registry entries from another extension host
    //     are never adopted in autoStart mode, even for the same cwd or no cwd.
    //     Reuse remains available only through explicit autoStart:false.
    const regFile = path.join(os.tmpdir(), `dsh-registry-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(regFile, JSON.stringify([
      { pid: process.pid, port: dshPort, host: '127.0.0.1', cwd: 'D:\\A', at: Date.now() },
    ], null, 2));
    class NoSpawnMgr extends ServerManager {
      constructor() {
        super();
        this.spawnBranch = false;
      }
      async _spawnAndWait() {
        this.spawnBranch = true;
        throw new Error('spawn-branch-reached');
      }
    }
    const noSpawn = new NoSpawnMgr();
    await assert.rejects(
      noSpawn.ensureServer({ host: '127.0.0.1', port: dshPort, cwd: 'D:\\A', registryFile: regFile }),
      /spawn-branch-reached/
    );
    assert.strictEqual(noSpawn.spawnBranch, true, 'autoStart must not adopt another window for the same workspace');

    const manualReuseMgr = new NoSpawnMgr();
    const reusedManual = await manualReuseMgr.ensureServer({
      host: '127.0.0.1', port: dshPort, cwd: 'D:\\A', registryFile: regFile, autoStart: false,
    });
    assert.deepStrictEqual(reusedManual, {
      url: `http://127.0.0.1:${dshPort}`,
      host: '127.0.0.1', port: dshPort, pid: null, owned: false,
    });
    assert.strictEqual(manualReuseMgr.spawnBranch, false, 'autoStart:false explicitly reuses a user-managed instance');

    //     Re-ensuring the endpoint this same manager spawned must preserve
    //     ownership; otherwise a later view resolve would turn the child into
    //     a reused instance and stop/deactivate would leak it.
    const ownedAgainMgr = new NoSpawnMgr();
    ownedAgainMgr._child = { pid: process.pid };
    ownedAgainMgr._ownedServer = {
      url: `http://127.0.0.1:${dshPort}`,
      host: '127.0.0.1',
      port: dshPort,
      pid: process.pid,
      owned: true,
    };
    const ownedAgain = await ownedAgainMgr.ensureServer({
      host: '127.0.0.1',
      port: dshPort,
      cwd: 'D:\\A',
      registryFile: regFile,
    });
    assert.deepStrictEqual(ownedAgain, {
      url: `http://127.0.0.1:${dshPort}`,
      host: '127.0.0.1',
      port: dshPort,
      pid: process.pid,
      owned: true,
    });
    assert.strictEqual(ownedAgainMgr.hasOwnedChild(), true);
    const forwardIgnored = new NoSpawnMgr();
    await assert.rejects(
      forwardIgnored.ensureServer({ host: '127.0.0.1', port: plainPort, cwd: 'D:\\A', registryFile: regFile }),
      /spawn-branch-reached/
    );
    assert.strictEqual(forwardIgnored.spawnBranch, true, 'a scanned-forward registry entry from another window must be ignored');
    const noWorkspaceMgr = new NoSpawnMgr();
    await assert.rejects(
      noWorkspaceMgr.ensureServer({ host: '127.0.0.1', port: dshPort, cwd: null, registryFile: regFile }),
      /spawn-branch-reached/
    );
    assert.strictEqual(noWorkspaceMgr.spawnBranch, true, 'a window without a workspace still gets its own child');

    // 13. Dead-entry filtering + cleanupStaleRegistry (never kills anything).
    const deadPid = 99999999; // (almost certainly) not running
    const regDead = path.join(os.tmpdir(), `dsh-registry-dead-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(regDead, JSON.stringify([
      { pid: deadPid, port: 32000, host: '127.0.0.1', cwd: null, at: Date.now() },
    ], null, 2));
    assert.deepStrictEqual(ServerManager._readRegistry(regDead), [], 'dead entry must be filtered out');

    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' });
    sleeper.unref();
    const regLive = path.join(os.tmpdir(), `dsh-registry-live-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(regLive, JSON.stringify([
      { pid: sleeper.pid, port: 32001, host: '127.0.0.1', cwd: 'D:\\Live', at: Date.now() },
    ], null, 2));
    const liveEntries = ServerManager._readRegistry(regLive);
    assert.strictEqual(liveEntries.length, 1, 'live entry must be kept');
    assert.strictEqual(liveEntries[0].pid, sleeper.pid);
    assert.strictEqual(sleeper.exitCode, null, 'reading the registry must never kill a live process');
    ServerManager.cleanupStaleRegistry(regLive);
    assert.strictEqual(JSON.parse(fs.readFileSync(regLive, 'utf8')).length, 1, 'cleanup keeps live entries');
    assert.strictEqual(sleeper.exitCode, null, 'cleanup must never kill live processes');
    ServerManager.cleanupStaleRegistry(regDead);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(regDead, 'utf8')), [], 'cleanup rewrites registry without dead entries');

    // 14. stop() removes ONLY this instance's registry entry.
    const regStop = path.join(os.tmpdir(), `dsh-registry-stop-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(regStop, JSON.stringify([
      { pid: 41001, port: 32010, host: '127.0.0.1', cwd: 'D:\\Own', at: 1 },
      { pid: 41002, port: 32011, host: '127.0.0.1', cwd: 'D:\\Other', at: 2 },
    ], null, 2));
    const fakeChild = { pid: 41001, exitCode: 1, signalCode: null, kill() {} };
    class NoKillMgr extends ServerManager {
      async _killChild() { /* never really kill */ }
    }
    const noKill = new NoKillMgr();
    noKill._child = fakeChild;
    noKill._registryFile = regStop;
    await noKill.stop();
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(regStop, 'utf8')),
      [{ pid: 41002, port: 32011, host: '127.0.0.1', cwd: 'D:\\Other', at: 2 }],
      "stop() must keep other windows' entries"
    );

    // 15. Lifecycle decision functions (pure, no I/O).
    //     closePolicy normalization: known values pass through, unknown values
    //     fall back to the conservative default onVscodeExit.
    assert.strictEqual(normalizeClosePolicy(undefined), CLOSE_POLICIES.ON_VSCODE_EXIT);
    assert.strictEqual(normalizeClosePolicy('onVscodeExit'), CLOSE_POLICIES.ON_VSCODE_EXIT);
    assert.strictEqual(normalizeClosePolicy('onViewClose'), CLOSE_POLICIES.ON_VIEW_CLOSE);
    assert.strictEqual(normalizeClosePolicy('never'), CLOSE_POLICIES.NEVER);
    assert.strictEqual(normalizeClosePolicy('garbage'), CLOSE_POLICIES.ON_VSCODE_EXIT, 'unknown policy falls back to the conservative default');

    //     shouldStopOnViewClose: only onViewClose stops on view disposal.
    assert.strictEqual(shouldStopOnViewClose('onViewClose'), true);
    assert.strictEqual(shouldStopOnViewClose('onVscodeExit'), false);
    assert.strictEqual(shouldStopOnViewClose('never'), false);
    assert.strictEqual(shouldStopOnViewClose(undefined), false, 'default policy must survive a view close');

    //     shouldStopOwnedServer: only an owned server is ever stopped.
    assert.strictEqual(shouldStopOwnedServer({ pid: 123, owned: true }), true);
    assert.strictEqual(shouldStopOwnedServer({ pid: null, owned: false }), false, 'reused external instance must never be stopped');
    assert.strictEqual(shouldStopOwnedServer(null), false);
    assert.strictEqual(shouldStopOwnedServer(undefined), false);

    //     sameEndpoint: host/port equality (port compared numerically).
    assert.strictEqual(sameEndpoint({ host: '127.0.0.1', port: 3080 }, { host: '127.0.0.1', port: 3080 }), true);
    assert.strictEqual(sameEndpoint({ host: '127.0.0.1', port: 3080 }, { host: '127.0.0.1', port: 3081 }), false);
    assert.strictEqual(sameEndpoint({ host: '127.0.0.1', port: 3080 }, { host: 'localhost', port: 3080 }), false);
    assert.strictEqual(sameEndpoint({ host: '127.0.0.1', port: '3080' }, { host: '127.0.0.1', port: 3080 }), true);

    //     reconcileConfigChange: endpoint/autoStart/closePolicy reactions.
    const base = { host: '127.0.0.1', port: 3080, autoStart: true, closePolicy: 'onVscodeExit' };
    assert.deepStrictEqual(
      reconcileConfigChange(base, { ...base }, true, true),
      { shouldReconnect: false, reason: null, endpointChanged: false, autoStartEnabled: false, closePolicyChanged: false },
      'no change -> no reconnect'
    );
    const portChanged = reconcileConfigChange(base, { ...base, port: 3081 }, true, true);
    assert.strictEqual(portChanged.shouldReconnect, true);
    assert.strictEqual(portChanged.reason, 'port');
    const hostChanged = reconcileConfigChange(base, { ...base, host: 'localhost' }, true, true);
    assert.strictEqual(hostChanged.shouldReconnect, true);
    assert.strictEqual(hostChanged.reason, 'host');
    const autoStartOff = reconcileConfigChange(base, { ...base, autoStart: false }, true, true);
    assert.strictEqual(autoStartOff.shouldReconnect, false, 'autoStart true->false must not restart');
    assert.strictEqual(autoStartOff.closePolicyChanged, false);
    const autoStartOn = reconcileConfigChange(
      { ...base, autoStart: false }, { ...base, autoStart: true }, false, false
    );
    assert.strictEqual(autoStartOn.shouldReconnect, true, 'autoStart false->true when idle re-enables startup');
    assert.strictEqual(autoStartOn.reason, 'autoStart');
    const autoStartOnConnected = reconcileConfigChange(
      { ...base, autoStart: false }, { ...base, autoStart: true }, true, true
    );
    assert.strictEqual(autoStartOnConnected.shouldReconnect, false, 'autoStart false->true while connected is a no-op');

    //     Managed children receive a per-window file bridge plus the legacy
    //     CLI marker; constructor input is copied so later mutation cannot
    //     redirect an already-created manager.
    const bridgeInput = {
      DSH_VSCODE_OPEN_URL: 'http://127.0.0.1:43123/open-text-document',
      DSH_VSCODE_OPEN_TOKEN: 'window-token',
      DSH_TEXT_EDITOR: 'wrong-value',
    };
    const bridgeMgr = new ServerManager({ spawnEnv: bridgeInput });
    bridgeInput.DSH_VSCODE_OPEN_TOKEN = 'mutated';
    const childEnv = bridgeMgr._buildSpawnEnv();
    assert.strictEqual(childEnv.DSH_VSCODE_OPEN_URL, 'http://127.0.0.1:43123/open-text-document');
    assert.strictEqual(childEnv.DSH_VSCODE_OPEN_TOKEN, 'window-token');
    assert.strictEqual(childEnv.DSH_TEXT_EDITOR, 'vscode', 'the compatibility marker cannot be overridden');
    const policyChanged = reconcileConfigChange(base, { ...base, closePolicy: 'onViewClose' }, true, true);
    assert.strictEqual(policyChanged.shouldReconnect, false, 'closePolicy change alone must not restart');
    assert.strictEqual(policyChanged.closePolicyChanged, true);

    //     Cancellation invalidates an in-flight ensure before it can spawn.
    class CancelledEnsureMgr extends ServerManager {
      constructor() {
        super();
        this.spawnAttempted = false;
      }
      async probeWithRetry() {
        this.cancelPending();
        return { reachable: false };
      }
      async _spawnAndWait() {
        this.spawnAttempted = true;
        throw new Error('must-not-spawn');
      }
    }
    const cancelledEnsure = new CancelledEnsureMgr();
    await assert.rejects(
      cancelledEnsure.ensureServer({ host: '127.0.0.1', port: 3080, autoStart: true }),
      /cancelled/
    );
    assert.strictEqual(cancelledEnsure.spawnAttempted, false, 'cancelled ensure must not spawn');

    // --- Cleanup: close fixture servers, stop the helper child, drop temp files.
    await new Promise((resolve) => plainServer.close(resolve));
    await new Promise((resolve) => dshServer.close(resolve));
    await new Promise((resolve) => {
      slowDshServer.close(() => resolve());
      slowDshServer.closeAllConnections?.(); // force-close any lingering probe sockets
    });
    if (sleeper && sleeper.exitCode === null) {
      try { sleeper.kill(); } catch { /* ignore */ }
    }
    for (const p of [regFile, regDead, regLive, regStop]) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }

    console.log('All self-tests passed.');
    console.log('  endpoint validation: non-loopback host and invalid port rejected');
    console.log(`  probe DSH    (port ${dshPort}) = ${JSON.stringify(pDsh)}`);
    console.log(`  probe plain  (port ${plainPort}) = ${JSON.stringify(pPlain)}`);
    console.log(`  probe closed (port ${closedPort}) = ${JSON.stringify(pClosed)}`);
    console.log('  healthCheck DSH = true, non-DSH = false');
    console.log(`  port scan skipped occupied ${plainPort} -> free ${freePort}`);
    console.log(`  ensureServer reuse statuses = ${JSON.stringify(statuses)}`);
    console.log('  autoStart:false on non-DSH port rejected as expected');
    console.log('  cleanupStalePid safe (missing + unparseable), stale file removed');
    console.log(`  stop() no-op statuses = ${JSON.stringify(stopStatuses)}`);
    console.log(`  probeWithRetry: single probe misjudged hanging DSH as ${JSON.stringify(singleProbe)}, retried -> ${JSON.stringify(retried)} (port ${slowDshPort})`);
    console.log(`  probeWithRetry retry loop: ${flaky.calls} probe() calls, first two unreachable -> ${JSON.stringify(flakyResult)}`);
    console.log('  _resolveSpawnCwd: null/undefined/"" -> undefined (inherit), paths pass through (5 cases OK)');
    console.log('  samePath: win32 case/trailing-slash-insensitive, other platforms resolve-equal (cases OK)');
    console.log('  per-window ownership: autoStart ignores other registry entries; self re-ensure preserves owned=true; autoStart:false reuses');
    console.log('  dead-entry filtering: dead pid dropped, live pid kept & never killed; cleanupStaleRegistry rewrites');
    console.log('  stop() removed only its own registry entry, kept others');
    console.log('  closePolicy: normalize + onViewClose gating; unknown -> onVscodeExit (conservative default)');
    console.log('  ownership: shouldStopOwnedServer only stops owned=true (reused instance never killed)');
    console.log('  config reconcile: endpoint/autoStart trigger reconnect; closePolicy alone does not restart');
    console.log('  file bridge env: per-window URL/token copied; legacy vscode marker forced');
    console.log('  cancellation: invalidated ensure exits before spawn');
  })().catch((err) => {
    console.error('Self-test FAILED:', err);
    process.exitCode = 1;
  });
}
