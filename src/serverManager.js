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
 *   - in environment-shared mode (`dsh.share.mode = "environment"`, the
 *     extension default) converge every window of one OS environment
 *     (Windows vs WSL) onto ONE instance: adopt whatever already answers as
 *     DSH — on the configured port or discovered from this environment's own
 *     `dsh web` processes — and spawn only when nothing answers, with one
 *     adoption retry to settle a simultaneous-start race.
 *   - keep a JSON instance registry for stale-entry cleanup and diagnostics;
 *     live entries from other VS Code windows are never adopted by default.
 *     Every entry records the OS environment its instance RUNS in, and an
 *     instance of the other environment is refused outright: a Windows-hosted
 *     DSH sees only Windows paths, so a WSL window adopting it fails every
 *     workspace with `workspace/invalid-path` (see _adoptionFacts).
 *     In shared mode the registry additionally records which windows
 *     (attachers) adopted an instance so the spawning window's exit path can
 *     leave it running for the remaining windows, and the activation sweep
 *     reclaims it only once the owner AND every attacher are gone.
 *   - report lifecycle transitions through an `onStatus` callback.
 *
 * Zero external dependencies: only Node built-ins are used.
 */

const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildManagedLaunchSpec,
  isNoOpenStderr,
  normalizeResolvedRuntime,
  supportsNoOpenFlag,
} = require('./managedRuntimeLaunch');
const { STARTUP_ERRORS } = require('./startupErrors');
const { tokenFromUrl } = require('./dshWebAuth');
const {
  SHARE_MODES,
  detectProcessEnvironment,
  detectRuntimeEnvironment,
  hostEnvironmentLabel,
} = require('./runtimeEnvironment');

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
const HEALTH_TIMEOUT_MS = 30000; // overall wait for a WARM spawned service to become ready
// Cold-start readiness budget (first spawn of an extension host). Under a
// multi-window simultaneous start every window spawns its own dsh at once and
// the first boot of the day pays for all of them: N node processes loading the
// same dependency tree through a cold file cache plus antivirus scanning can
// push even the eventual winner past the 30s warm budget — each window then
// killed its own still-booting child (live logs 2026-09-20: chains of
// "did not become ready within 30s" + 0-byte spawn logs, Windows). The child
// exit event still fast-fails genuine breakage (SPAWN_EXITED_EARLY), so a
// longer first-spawn deadline only trades idle waiting for fewer killed
// healthy boots.
const COLD_HEALTH_TIMEOUT_MS = 120000;
// Mid-wait sibling adoption cadence (shared mode): while OUR child is still
// booting, re-check whether a sibling window's instance already became
// adoptable; if so, abandon our doomed duplicate boot and adopt instead. This
// is what actually collapses the N-concurrent-boot storm — without it every
// window burns a full dsh boot's worth of disk/AV contention on a child that
// is going to lose the port race anyway.
const SIBLING_ADOPT_POLL_ROUNDS = 4; // ≈ every 2.8s of the 700ms health poll
const MAX_BODY_BYTES = 5 * 1024 * 1024; // bound on the probe response body we buffer
const TASKKILL_TIMEOUT_MS = 5000; // max wait for taskkill /T /F before stop() proceeds
const PORT_RELEASE_WAIT_MS = 3000; // F-f: max stop() wait for a killed child's port to refuse
const PORT_RELEASE_POLL_MS = 100; // F-f: poll cadence for the port-release wait

// Simultaneous-start settle budgets (multi-window shared mode). When a sibling
// window wins the port race, its DSH binds the port well before the extension
// finalizes the registry entry (the token source adopters need) — the loser's
// single adoption attempt used to expire in ~1s and the window showed
// "DeepSeek Harness unavailable" until a manual Retry (live bug 2026-09-18,
// N windows starting at once). The settle loop re-probes and re-reads the
// registry each round until the sibling becomes adoptable or the budget ends.
const ADOPTION_SETTLE_POLL_MS = 500;      // settle re-probe cadence
const SPAWN_RACE_SETTLE_MS = 12000;       // Step C catch: sibling proven/present
const SPAWN_RACE_SETTLE_NO_SIBLING_MS = 2000; // Step C catch: no sibling evidence
const DISCOVERY_SETTLE_MS = 4000;         // Step A/B: give a booting sibling a moment

// Instance-registry inter-process locking. Every registry mutation is a
// read-modify-write of the whole JSON file; with N windows activating at once
// (sweeps, cleanup, adopter registration, ready-merge all concurrent) a plain
// read→write pair silently drops sibling entries — worst case the freshly
// written entry of the race winner, whose launch token every later adopter
// needs. The lock is best-effort bookkeeping protection: on timeout it proceeds
// unlocked rather than breaking startup.
const REGISTRY_LOCK_POLL_MS = 5;     // sync spin cadence while locked by a peer
const REGISTRY_LOCK_TIMEOUT_MS = 3000; // max wait for a peer lock before going unlocked
const REGISTRY_LOCK_STALE_MS = 3000; // a lock older than this is taken over

/** Bound on the spawn-log excerpt embedded in early-exit error messages. */
const EXCERPT_MAX_BYTES = 1600;
/** Lines of the spawn-log excerpt embedded in early-exit error messages. */
const EXCERPT_MAX_LINES = 10;

/** Liveness-answer TTL (see ServerManager._isProcessAlive). */
const ALIVE_CACHE_TTL_MS = 1500;

/**
 * Turn a spawn-log tail into the ''-or-'\n\n…' suffix used by the early-exit
 * error templates, so the sidebar shows WHY dsh died (its own stderr names
 * the unresolvable bundle / failing plugin / bad flag) instead of a bare
 * exit code — the difference between an agent self-debugging and a dead end.
 *
 * @param {string} tail - Raw log tail (may be '' when no log exists).
 * @returns {string} '' or a newline-led bounded excerpt.
 */
function excerptSuffix(tail) {
  if (typeof tail !== 'string' || tail.trim().length === 0) return '';
  const lines = tail.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
  const picked = lines.slice(-EXCERPT_MAX_LINES).join('\n').slice(-EXCERPT_MAX_BYTES);
  return picked.length === 0 ? '' : '\n\n' + picked;
}

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
  constructor({ onStatus, spawnEnv, resolvedRuntime, embedPatchPath = null, cleanPatchPath = null, spawnFn = spawn, runtimeProfileGuard = null, profileBundleGuard = null } = {}) {
    this.onStatus = typeof onStatus === 'function' ? onStatus : () => {};
    // Optional pre-spawn profile guard (2026-09-04 incident follow-up): the
    // extension injects ensureHmrDisabled so every owned spawn boots a
    // profile whose server module HMR cannot break the tool layer.
    this.runtimeProfileGuard = typeof runtimeProfileGuard === 'function' ? runtimeProfileGuard : null;
    // Optional pre-spawn manifest guard (same incident): strips
    // dsh.profile.bundles entries whose packages are installed nowhere —
    // resolveBundleDir kills the boot on the first orphan (exit 1 before
    // any health probe), which is exactly the "cannot enter after update"
    // crash loop this prevents.
    this.profileBundleGuard = typeof profileBundleGuard === 'function' ? profileBundleGuard : null;
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
    // Which OS environment (windows/wsl/linux/other) this window IS. Stamped
    // onto every ready registry entry as `runtimeEnvironment` and used to
    // refuse adopting an instance of the other environment (see
    // _adoptionFacts); the extension feeds the same value it resolved its
    // runtime with, so both sides of the split agree.
    this.hostEnvironment = detectRuntimeEnvironment().id;
    this._selfHealCount = 0; // successful patch-drop self-heal retries for Diagnose
    this._child = null;   // ChildProcess spawned by THIS instance (owned)
    this._noOpenSuppressed = false; // session-sticky: runtime rejected --no-open
    this._lastSpawnArgs = null;     // args of the most recent spawn attempt
    this._lastSpawnLogPath = null;  // per-spawn log used by the no-open self-heal
    this._healthTimer = null;       // post-ready liveness poll (see _startHealthWatch)
    this._healthPort = null;        // port the health poll probes
    this._extraArgs = [];           // dsh.extraArgs appended to owned spawns
    this._registryFile = null; // registry merged on ready (own entry removed on stop)
    // Configure token for the DSH-side /api/vscode/configure route (plugin
    // 0.8.0): the extension pushes live FIM/LM/editor-links bridge config to
    // a RUNNING instance over it. Generated once per manager, injected into
    // every spawn env, recorded in the registry entry (next to authToken) so
    // an adopting window can configure an instance it did not spawn.
    this._configureToken = null;
    this._stopping = false; // true while a deliberate stop() is in progress
    this._ownedServer = null; // last ready endpoint backed by this._child
    this._cancelGeneration = 0; // invalidates an in-flight ensure/spawn operation
    this._lastSpawnPort = null; // last port spawned by THIS instance (fresh origin)
    this._hasEverBeenReady = false; // first successful spawn switches to the warm readiness budget
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
   *
   * `environment` (the extension's own detectRuntimeEnvironment().id) is
   * optional: when omitted the constructor's detection stands. It is a
   * separate parameter rather than derived here because the extension already
   * resolved it for the runtime — one window, one answer.
   *
   * @param {{vscodePid?: number|null, windowId?: string|null, environment?: string|null}} identity
   * @returns {{vscodePid: number|null, windowId: string|null}} the normalized identity.
   */
  setOwnerIdentity({ vscodePid = null, windowId = null, environment = null } = {}) {
    this.ownerVscodePid = Number.isInteger(vscodePid) ? vscodePid : null;
    this.ownerWindowId = typeof windowId === 'string' && windowId.length > 0 ? windowId : null;
    if (typeof environment === 'string' && environment.length > 0) {
      this.hostEnvironment = environment;
    }
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

  /**
   * This window's configure token for the plugin's /api/vscode/configure
   * route (generated once, stable for the manager's lifetime).
   */
  configureToken() {
    if (typeof this._configureToken !== 'string' || this._configureToken.length === 0) {
      this._configureToken = crypto.randomBytes(32).toString('hex');
    }
    return this._configureToken;
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
      // Plugin 0.8.0 /api/vscode/configure bearer (see configureToken()).
      DSH_VSCODE_CONFIGURE_TOKEN: this.configureToken(),
    };
  }

  _throwIfCancelled(generation) {
    if (generation !== this._cancelGeneration) {
      throw new ServerError('DSH lifecycle operation was cancelled');
    }
  }

  /**
   * Build a reuse handle without losing ownership of our own ready child.
   *
   * dsh 0.1.2+ fences every /api request behind a browser cookie minted from
   * the launch token, so a handle without the token can serve an iframe but
   * CANNOT bind workspaces (workspace/create 401s). Owned handles therefore
   * re-attach their child's token, and an adopted handle carries the token
   * recovered from the instance registry (see adoptRunningDsh).
   * Tokenless handles stay tokenless: older runtimes print no token.
   *
   * `adoption` describes an instance adopted from the registry (see
   * _managedEntryFromRegistry): `pid` is the adopted child's process id, and
   * `managed: true` marks it as started by this extension — by another VS Code
   * window of the same environment — rather than by the user. Consumers use
   * that to treat it as extension bookkeeping (workspace binding skips its
   * consent gate for it) while still reporting `owned: false`, which keeps
   * meaning "this window does not own the child process".
   *
   * @param {string} host - DSH endpoint host.
   * @param {number} port - DSH endpoint port.
   * @param {string|null} [adoptedToken] - Launch token of the adopted child.
   * @param {{pid?: number|null, managed?: boolean}|null} [adoption] - Registry
   *   facts about the adopted child; null for a foreign instance.
   * @returns {object} RunningServer handle.
   */
  _reuseHandle(host, port, adoptedToken = null, adoption = null) {
    const owned = Boolean(
      this._child
      && this._ownedServer
      && this._ownedServer.pid === this._child.pid
      && this._ownedServer.host === host
      && this._ownedServer.port === port
    );
    const authToken = owned
      ? (typeof this._ownedServer.authToken === 'string' && this._ownedServer.authToken.length > 0
        ? this._ownedServer.authToken
        : null)
      : (typeof adoptedToken === 'string' && adoptedToken.length > 0 ? adoptedToken : null);
    const adoptedPid = adoption && Number.isInteger(adoption.pid) ? adoption.pid : null;
    // Configure token: for our own child, ours; for an adopted instance, the
    // spawning window recorded it in the registry entry (plugin 0.8.0) so
    // this window can push live bridge config to the shared instance.
    const configureToken = owned
      ? (typeof this._configureToken === 'string' && this._configureToken.length > 0 ? this._configureToken : null)
      : (adoption && typeof adoption.configureToken === 'string' && adoption.configureToken.length > 0
        ? adoption.configureToken
        : null);
    return {
      url: `http://${host}:${port}`,
      host,
      port,
      pid: owned ? this._child.pid : adoptedPid,
      owned,
      ...(!owned && adoption && adoption.managed === true ? { managed: true } : {}),
      ...(authToken ? {
        authToken,
        authUrl: `http://${host}:${port}/?token=${encodeURIComponent(authToken)}`,
      } : {}),
      ...(configureToken ? { configureToken } : {}),
    };
  }

  /**
   * Try to adopt a DSH instance that is already serving `host:port`.
   *
   * Unlike ensureServer()'s legacy window-owned path this is an explicit
   * caller-requested fallback (or the shared-mode adoption step): it never
   * spawns and never kills anything. It returns a non-owned reuse handle
   * when the endpoint answers as DSH, or null when the endpoint is
   * unreachable / non-DSH / probing fails. Status is emitted through the
   * same lifecycle channel as ensureServer().
   *
   * dsh 0.1.2+ fences the web app and every /api route behind a browser
   * cookie minted from the launch token, so a tokenless probe classifies a
   * HEALTHY fenced instance as not-DSH (401). When the tokenless probe finds
   * a reachable non-DSH endpoint, the launch token is recovered from the
   * instance registry — the owning window records each spawn's log next to
   * the registry, and that log carries the `dsh web: …/?token=…` ready line —
   * and the probe is retried with it. Adopting WITH the token matters twice:
   * the probe then recognizes the fenced instance at all, and the returned
   * handle carries authToken so the sidebar's workspace binding (workspace/
   * create, session/list) can authenticate instead of failing with 401.
   *
   * When `options.registryFile` is given and this manager carries an owner
   * identity, the adoption is recorded in the registry entry of the adopted
   * instance (attachers list) — the spawning window's exit path and the
   * activation sweep read that list to keep a shared instance alive while
   * any adopting window is still attached.
   *
   * `options.settleMs` bounds a re-probe loop for the simultaneous-start
   * race: a sibling window's instance answers 401 (fenced) before its own
   * window has finalized the registry entry, so the first pass finds no
   * launch token and cannot adopt. Each round re-probes and re-reads the
   * registry, so a booting sibling is adopted the moment its token lands.
   * 0 (default) keeps the single-shot behavior.
   *
   * @param {string} host - DSH endpoint host.
   * @param {number} port - DSH endpoint port.
   * @param {object} [options]
   * @param {string|null} [options.registryFile] - Instance registry path for
   *   adopter bookkeeping and launch-token recovery; null (default) keeps the
   *   legacy no-bookkeeping behavior.
   * @param {number} [options.settleMs] - Bounded wait (ms) re-probing until
   *   the endpoint becomes adoptable; 0 = single-shot.
   * @param {boolean} [options.silent] - Skip the "Probing DSH service" status
   *   emission (used by the mid-wait sibling adoption inside the spawn health
   *   poll, where a re-rendered probing page every few seconds is churn).
   * @returns {Promise<object|null>} RunningServer handle, or null.
   */
  async adoptRunningDsh(host, port, { registryFile = null, settleMs = 0, silent = false } = {}) {
    const deadline = Date.now() + Math.max(0, settleMs);
    for (let round = 0; ; round++) {
      try {
        // Refuse an instance of the other OS environment before probing it at
        // all, and re-check on every round: a pre-fix sibling window can write
        // its (foreign) entry while this window is still settling, so this must
        // not be a one-shot decision made before that entry existed. Returning
        // immediately also keeps the settle budget from being spent on an
        // instance this window can never use.
        const facts = ServerManager._adoptionFacts(registryFile, host, port, this.hostEnvironment);
        if (facts.foreign) {
          this._refuseForeignAdoption(facts.entry, registryFile);
          return null;
        }
        // Emit the probing stage only once: the settle loop may run for
        // seconds and re-rendering the status page every round is churn.
        if (round === 0 && !silent) {
          this._emit('probing', 'Probing DSH service: http://{host}:{port}…', { host, port });
        }
        let result = await this.probeWithRetry(host, port);
        let token = null;
        if (result && result.reachable && !result.isDsh) {
          // Reachable but not recognized: on dsh 0.1.2+ this is the auth fence
          // answering 401. Retry with the owning window's launch token.
          token = ServerManager._entryLaunchToken(facts.entry);
          if (token) {
            const withToken = await this.probeWithRetry(host, port, { token });
            if (withToken && withToken.reachable && withToken.isDsh) result = withToken;
            else token = null; // token rejected: do not attach it to the handle
          }
        }
        if (result && result.reachable && result.isDsh) {
          this._emit('reusing', 'Found a running DSH instance at http://{host}:{port}, reusing', { host, port });
          this._startHealthWatch(host, port, token);
          const managedEntry = facts.entry;
          const handle = this._reuseHandle(host, port, token, managedEntry
            ? {
              pid: managedEntry.pid,
              managed: true,
              // Plugin 0.8.0: the spawning window's configure bearer, so this
              // adopting window can push live bridge config to the instance.
              configureToken: typeof managedEntry.configureToken === 'string' ? managedEntry.configureToken : null,
            }
            : null);
          if (!handle.owned) {
            ServerManager._registerAdopter(registryFile, {
              port,
              vscodePid: this.ownerVscodePid,
              windowId: this.ownerWindowId,
            });
          }
          return handle;
        }
      } catch {
        // The caller keeps its original error and decides whether to surface it.
      }
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, ADOPTION_SETTLE_POLL_MS));
    }
  }

  /**
   * Registry entry of the live instance serving host:port, or null.
   *
   * A live entry here means the instance was started by this extension — the
   * registry lives in the extension's own globalStorage and is written only by
   * the spawn path — so an adopting window can treat it as extension
   * bookkeeping instead of a service the user runs. No owner-marker check:
   * entries written by older versions of this extension carry no vscodePid but
   * are just as much ours (the same reading sweepDeadOwnerEntries applies).
   */
  static _managedEntryFromRegistry(registryFile, host, port) {
    if (!registryFile) return null;
    return ServerManager._readRegistryRaw(registryFile).find((e) => e
      && e.port === port
      && (!e.host || e.host === host)
      && Number.isInteger(e.pid)
      && ServerManager._isProcessAlive(e.pid)) || null;
  }

  /**
   * Registry facts about the live instance on host:port — the entry together
   * with whether that instance belongs to the OTHER OS environment.
   *
   * A foreign instance must never be adopted: it sees only the other OS's
   * paths, so every workspace this window binds fails with
   * `workspace/invalid-path` and the sidebar cannot create a session at all
   * (the live WSL failure this gate exists for). Entries written before the
   * `runtimeEnvironment` stamp carry no field, so the process itself is asked
   * — WSL interop is visible in /proc — and an `unknown` verdict is never
   * treated as foreign, which keeps adoption untouched on every platform this
   * side cannot inspect and for every genuinely native process.
   *
   * @param {string|null} registryFile - Instance registry path.
   * @param {string} host - DSH endpoint host.
   * @param {number} port - DSH endpoint port.
   * @param {string} [hostEnvironment] - This window's environment id; defaults
   *   to this host's own detection.
   * @param {{detectProcessEnvironment?: Function}} [deps] - Test seam for the
   *   process observation of pre-stamp entries.
   * @returns {{entry: object|null, foreign: boolean}}
   */
  static _adoptionFacts(registryFile, host, port, hostEnvironment = detectRuntimeEnvironment().id, deps = {}) {
    const entry = ServerManager._managedEntryFromRegistry(registryFile, host, port);
    if (!entry) return { entry: null, foreign: false };
    const observe = typeof deps.detectProcessEnvironment === 'function'
      ? deps.detectProcessEnvironment
      : detectProcessEnvironment;
    const declared = typeof entry.runtimeEnvironment === 'string' && entry.runtimeEnvironment.length > 0
      ? entry.runtimeEnvironment
      : observe(entry.pid);
    return { entry, foreign: declared !== 'unknown' && declared !== hostEnvironment };
  }

  /**
   * Handle a live instance that belongs to the other OS environment.
   *
   * When that entry is owned by THIS very window — a spawn from before this
   * gate existed, or a stale entry whose runtime was replaced — nothing else
   * would ever clean it up: the activation sweep deliberately leaves
   * current-window entries alone. So it is stopped and its entry dropped, and
   * the caller goes on to start a native instance. An instance owned by a
   * SIBLING window is left running — stopping another live window's server is
   * not this window's call — and this window merely refuses to adopt it.
   *
   * The kill is best-effort by nature: on WSL the signal reaches the `/init`
   * interop wrapper and whether the Windows-side process follows cannot be
   * verified from here. Nothing downstream depends on it succeeding — a
   * surviving instance is simply refused again on the next pass.
   *
   * @param {object|null} entry - Live registry entry of the foreign instance.
   * @param {string|null} registryFile - Instance registry path.
   * @returns {boolean} True when this window owned (and tried to stop) it.
   */
  _refuseForeignAdoption(entry, registryFile) {
    const ownedByThisWindow = this.ownerVscodePid !== null
      && entry !== null
      && typeof entry === 'object'
      && entry.vscodePid === this.ownerVscodePid
      && Number.isInteger(entry.pid);
    if (ownedByThisWindow) {
      killProcessTree(entry.pid).catch(() => {
        // best-effort: only the interop wrapper is guaranteed to receive it
      });
      ServerManager._removeRegistryEntry(registryFile, entry.pid);
    }
    this._emit('selfheal', 'The DSH instance at http://{host}:{port} belongs to another OS environment ({environment}); this window will not use it', {
      host: entry && typeof entry.host === 'string' && entry.host.length > 0 ? entry.host : DEFAULT_HOST,
      port: entry && Number.isInteger(entry.port) ? entry.port : DEFAULT_PORT,
      environment: hostEnvironmentLabel(),
    });
    return ownedByThisWindow;
  }

  /**
   * The environment an instance on `pid` runs in, for the registry stamp.
   * Observed first: a child spawned before the foreign-runtime guard existed
   * (a WSL window whose PATH held only a `/mnt/c` shim) is a Windows process
   * whose recorded runtime shape looks native — /proc is the only witness.
   * Falls back to the resolved runtime's declared environment, then to this
   * host's own.
   * @param {number} pid - Process id of the instance.
   * @returns {string} One of 'windows'|'wsl'|'linux'|'other'.
   */
  runtimeEnvironmentFor(pid) {
    const observed = detectProcessEnvironment(pid);
    if (observed !== 'unknown') return observed;
    if (this.resolvedRuntime && typeof this.resolvedRuntime.environment === 'string') {
      return this.resolvedRuntime.environment;
    }
    return this.hostEnvironment;
  }

  /**
   * Recover the launch token of the DSH instance serving host:port from the
   * instance registry. Two sources, in order:
   *
   *   1. `entry.authToken` — recorded by the owning window at spawn time
   *      (see _finalizeReady). This is the durable one: it survives log
   *      rotation, log cleanup, and a moved/renamed log directory.
   *   2. `entry.log` — the child's spawn log, whose ready line carries
   *      `dsh web: …/?token=…`. Kept for entries written by older versions
   *      of this extension (and for a window that spawned before an upgrade
   *      in the same session).
   *
   * Null when no live entry carries either (e.g. a `dsh web` started manually
   * in a terminal) — such instances stay unadoptable on fenced runtimes.
   */
  static _launchTokenFromRegistry(registryFile, host, port) {
    if (!registryFile) return null;
    return ServerManager._entryLaunchToken(
      ServerManager._managedEntryFromRegistry(registryFile, host, port)
    );
  }

  /**
   * The launch token recorded for one registry entry: `entry.authToken` first,
   * the spawn log's ready line second (entries written by older versions of
   * this extension). Null when neither source has one.
   */
  static _entryLaunchToken(entry) {
    if (!entry) return null;
    if (typeof entry.authToken === 'string' && entry.authToken.length > 0) return entry.authToken;
    if (typeof entry.log === 'string' && entry.log.length > 0) {
      return ServerManager.launchTokenFromSpawnLog(entry.log);
    }
    return null;
  }

  /**
   * Tail (last `maxBytes` bytes) of a log file, or '' when missing/unreadable.
   */
  static _readLogTail(logPath, maxBytes = 8192) {
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

  /**
   * Launch token printed by dsh 0.1.2+ in its ready line
   * (`dsh web: http://…/?token=…`) inside the given spawn log. Null on older
   * runtimes (plain URL), truncated logs, and unreadable files.
   */
  static launchTokenFromSpawnLog(logPath) {
    const match = /^dsh web: (\S+)\s*$/m.exec(ServerManager._readLogTail(logPath));
    if (!match) return null;
    return tokenFromUrl(match[1]);
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
   *
   * With no token (the only mode before dsh 0.1.2-rc.1) the probe requests
   * `/` and requires 200 + BOOT_MARKER. With `{ token }` — parsed from the
   * child's own `dsh web: …/?token=…` stdout line — it requests
   * `/?token=…`, where dsh's auth fence answers 303 (token accepted, cookie
   * minted) or 401 (rejected); 303 + BOOT_MARKER-on-200 both count as DSH.
   * Returns:
   *   { reachable: true,  isDsh: true  } — HTTP 200 + BOOT_MARKER, or 303
   *                                         answering a valid token probe
   *   { reachable: true,  isDsh: false } — responded, but not DSH (or auth
   *                                         rejected the token)
   *   { reachable: false, reason: 'refused' } — connection refused: port free
   *   { reachable: false, reason: 'timeout' } — listener silent: port busy
   *   { reachable: false, reason: '<code>' }  — other transport failure
   */
  async probe(host, port, { token = null } = {}) {
    const requestTarget = token
      ? `/?token=${encodeURIComponent(token)}`
      : '/';
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
          `GET ${requestTarget} HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\nAccept: text/html\r\n\r\n`
        );
      });
      socket.on('data', (chunk) => {
        const remaining = MAX_BODY_BYTES - raw.length;
        if (remaining > 0) raw += chunk.slice(0, remaining);
        const status = /^HTTP\/1\.[01]\s+(\d{3})\b/.exec(raw);
        if (status && Number(status[1]) === 200 && raw.includes(BOOT_MARKER)) {
          finish({ reachable: true, isDsh: true });
        } else if (status && Number(status[1]) === 303 && token !== null) {
          // dsh 0.1.2+ auth fence accepting the launch token: the 303 cookie
          // redirect only exists on that path, so it identifies DSH exactly.
          finish({ reachable: true, isDsh: true });
        } else if (raw.length >= MAX_BODY_BYTES) {
          finish({ reachable: true, isDsh: false });
        }
      });
      socket.on('end', () => {
        const status = /^HTTP\/1\.[01]\s+(\d{3})\b/.exec(raw);
        finish({
          reachable: true,
          isDsh: Boolean(status
            && (Number(status[1]) === 200 && raw.includes(BOOT_MARKER)
              || (Number(status[1]) === 303 && token !== null))),
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
  async probeWithRetry(host, port, { attempts = 3, delayMs = 400, token = null } = {}) {
    const n = Math.max(1, attempts); // at least one attempt, even for 0/negative input
    let last = null;
    for (let i = 0; i < n; i++) {
      last = await this.probe(host, port, token === null ? {} : { token });
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
    let token = null;
    try {
      const parsed = new URL(url);
      host = parsed.hostname;
      port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
      token = tokenFromUrl(parsed.href);
    } catch {
      return false;
    }
    const result = await this.probe(host, port, token === null ? {} : { token });
    return Boolean(result.isDsh);
  }

  /**
   * Ensure a DSH web service is available for this VS Code window.
   *  - shareMode 'window' (default, legacy): autoStart === true is
   *    window-owned mode — reuse only this manager's own healthy child; any
   *    service already occupying the configured port belongs to somebody
   *    else, so scan forward and spawn a dedicated child. This gives each
   *    VS Code extension host one process. autoStart === false is
   *    user-managed mode: reuse a DSH already running on the configured port
   *    and never stop it.
   *  - shareMode 'environment' (shared-instance mode): every window of one
   *    OS environment (Windows vs WSL) converges on ONE instance. A DSH
   *    answer on the configured port is adopted (never spawned past), then
   *    this environment's own `dsh web` processes are discovered and probed
   *    (see _ensureSharedEnvironmentServer). Spawning happens only when
   *    nothing answers, followed by a bounded adoption wait that settles a
   *    simultaneous-start race between sibling windows. autoStart === false
   *    keeps the strict user-managed semantics in this mode as well.
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
   *  - discoverDshWebPorts: optional async ({platform}) => number[] scanning
   *    this environment's own processes for running `dsh web` ports; only
   *    used by the environment-shared path (shared mode adoption).
   *  - Returns a RunningServer: { url, host, port, pid, owned }.
   */
  async ensureServer({
    host = DEFAULT_HOST,
    port = DEFAULT_PORT,
    autoStart = true,
    cwd,
    registryFile,
    shareMode = SHARE_MODES.WINDOW,
    discoverDshWebPorts = null,
  } = {}) {
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
    // The own-child probe MUST carry the launch token: dsh 0.1.2+ answers a
    // tokenless probe with 401, which would misclassify the healthy child as
    // "no longer serving DSH" and kill + respawn it on every repeated ensure
    // (killing in-flight sessions and workspace binds with it).
    if (autoStart && this._child && this._ownedServer && this._ownedServer.host === host) {
      const own = this._ownedServer;
      this._emit('probing', 'Probing DSH service: http://{host}:{port}…', { host, port: own.port });
      const ownProbe = await this.probeWithRetry(
        host,
        own.port,
        typeof own.authToken === 'string' && own.authToken.length > 0 ? { token: own.authToken } : {}
      );
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

    // Shared-instance mode: converge on the one DSH of this OS environment.
    if (shareMode === SHARE_MODES.ENVIRONMENT) {
      return this._ensureSharedEnvironmentServer({
        host,
        port,
        autoStart,
        cwd,
        registryFile,
        generation,
        probeResult: r,
        discoverDshWebPorts,
      });
    }

    // Step 3: reuse is an explicit user-managed mode only. Default autoStart
    // never adopts another window's child or a manually started service.
    if (!autoStart) {
      if (r.reachable && r.isDsh) {
        // Environment gate on REGISTRY EVIDENCE only: a `dsh web` the user
        // started by hand has no entry and stays adoptable — this mode exists
        // to attach to exactly that — while an entry naming the other OS
        // environment (or whose process is observably an interop one) is
        // refused. This path cannot self-heal by spawning a native instance,
        // so here the refusal IS the error the user sees.
        const facts = ServerManager._adoptionFacts(registryFile, host, port, this.hostEnvironment);
        if (facts.foreign) {
          this._refuseForeignAdoption(facts.entry, registryFile);
          throw new ServerError(
            STARTUP_ERRORS.RUNTIME_FOREIGN_INSTANCE.template,
            { host, port, environment: hostEnvironmentLabel() },
            'RUNTIME_FOREIGN_INSTANCE'
          );
        }
        this._emit('reusing', 'Found a running DSH instance at http://{host}:{port}, reusing', { host, port });
        return this._reuseHandle(host, port);
      }
      throw new ServerError(STARTUP_ERRORS.AUTOSTART_DISABLED.template, {}, 'AUTOSTART_DISABLED');
    }

    // Step 4: any occupied port belongs to another owner and must not be
    // reused; a dead port can host this window's new child.
    return this._spawnOnFreePort({ host, port, cwd, registryFile, generation, probeResult: r });
  }

  /**
   * Shared-instance ensure (shareMode 'environment'): converge every window
   * of one OS environment (Windows vs WSL) onto ONE DSH instance.
   *
   *  - Step A: whatever already answers as DSH on the configured port IS the
   *    shared instance — adopt it (non-owned handle), whatever window or
   *    terminal started it.
   *  - Step B (autoStart only): the configured port is silent, so scan this
   *    environment's processes (`ps` under WSL/Linux, PowerShell on Windows)
   *    for `dsh web` listeners on other ports and adopt the first one that
   *    answers as DSH. The scan itself drops Windows-shaped command lines off
   *    win32 and adoption refuses a foreign registry entry, because WSL
   *    interop means one environment's process table DOES show the other's
   *    processes (see processDiscovery/isForeignCommandLine).
   *  - Step C: nobody home → spawn the environment's shared instance on the
   *    configured port when free (so later windows find it exactly there),
   *    scanning forward only past a non-DSH occupant. A simultaneous-start
   *    race — a sibling window binds the port between our probe and our
   *    spawn, our child dies of EADDRINUSE — is settled by a bounded adoption
   *    wait (settleMs) before the spawn error stands: the winner binds the
   *    port before its registry token exists, so the loser must re-probe
   *    until the winner becomes adoptable, not just once.
   *
   * The spawning window owns the child (registry entry with its vscodePid);
   * adopters register themselves as attachers so the owner's exit path can
   * leave the instance running for them (see _registerAdopter and
   * ownedChildHasLiveAdopters).
   */
  async _ensureSharedEnvironmentServer({
    host,
    port,
    autoStart,
    cwd,
    registryFile,
    generation,
    probeResult,
    discoverDshWebPorts,
  }) {
    this._throwIfCancelled(generation);

    // Step A: adopt whatever answers on the configured port.
    //
    // The gate is `reachable`, NOT `isDsh`: on dsh 0.1.2+ a tokenless probe of
    // a HEALTHY fenced instance answers 401 and is classified not-DSH, so an
    // isDsh gate skipped adoption for exactly the instances this mode exists
    // to share (live bug 2026-09-18: two windows of one WSL environment each
    // spawned their own DSH, 3081 and 3082). adoptRunningDsh retries the probe
    // with the launch token recovered from the instance registry and returns
    // null for a genuinely foreign endpoint, which falls through to Step B/C
    // unchanged. A bounded settle covers the sibling mid-boot: it answers 401
    // before its own window has written the registry token, so the first pass
    // alone cannot adopt it (multi-window simultaneous start).
    if (probeResult.reachable) {
      const adopted = await this.adoptRunningDsh(host, port, {
        registryFile,
        settleMs: DISCOVERY_SETTLE_MS,
      });
      if (adopted) return adopted;
    }

    // Step B: discover this environment's own `dsh web` listeners elsewhere.
    //
    // The configured port is NOT skipped unconditionally anymore: when our own
    // probe found it bound-but-silent (a booting sibling — 'timeout', or
    // another indeterminate state) and the process scan confirms a dsh on
    // exactly that port, adoption must be attempted on it too, or the spawn
    // below scans forward and brings up a duplicate instance (the silent
    // 3081/3082 shape of the 2026-09-18 race). A plain 'refused' still skips:
    // nothing is there, spawning is correct.
    if (autoStart && typeof discoverDshWebPorts === 'function') {
      for (const candidate of await this._discoverEnvironmentDshPorts(discoverDshWebPorts)) {
        if (candidate === port && (probeResult.reachable || probeResult.reason === 'refused')) continue;
        this._throwIfCancelled(generation);
        const adopted = await this.adoptRunningDsh(host, candidate, {
          registryFile,
          settleMs: DISCOVERY_SETTLE_MS,
        });
        if (adopted) return adopted;
      }
    }

    if (!autoStart) {
      throw new ServerError(STARTUP_ERRORS.AUTOSTART_DISABLED.template, {}, 'AUTOSTART_DISABLED');
    }

    // Step C: spawn, then settle a start race with one bounded adoption wait.
    // The health poll also adopt-checks the configured port every few rounds
    // (adoptSibling): as soon as a sibling window's instance becomes
    // adoptable, this window abandons its own duplicate boot and attaches.
    try {
      return await this._spawnOnFreePort({
        host,
        port,
        cwd,
        registryFile,
        generation,
        probeResult,
        adoptSibling: () => this.adoptRunningDsh(host, port, { registryFile, silent: true }),
      });
    } catch (spawnError) {
      this._throwIfCancelled(generation);
      // Settle a simultaneous-start race: the sibling that beat us to the port
      // is bound well before its registry entry (the adoptable token) lands,
      // and its boot can take seconds under N-window startup load. Scale the
      // settle budget by the evidence that a sibling actually exists — a
      // genuine spawn failure (broken runtime, no sibling) must still fail
      // fast instead of idling for the full budget.
      const postMortem = await this.probe(host, port).catch(() => ({ reachable: false, reason: 'error' }));
      let siblingOnPort = postMortem.reachable || postMortem.reason !== 'refused';
      if (!siblingOnPort && typeof discoverDshWebPorts === 'function') {
        const ports = await this._discoverEnvironmentDshPorts(discoverDshWebPorts);
        siblingOnPort = ports.includes(port);
      }
      const raced = await this.adoptRunningDsh(host, port, {
        registryFile,
        settleMs: siblingOnPort ? SPAWN_RACE_SETTLE_MS : SPAWN_RACE_SETTLE_NO_SIBLING_MS,
      });
      if (raced) return raced;
      if (typeof discoverDshWebPorts === 'function') {
        for (const candidate of await this._discoverEnvironmentDshPorts(discoverDshWebPorts)) {
          if (candidate === port) continue; // just settled above with the full budget
          const adopted = await this.adoptRunningDsh(host, candidate, {
            registryFile,
            settleMs: DISCOVERY_SETTLE_MS,
          });
          if (adopted) return adopted;
        }
      }
      throw spawnError;
    }
  }

  /** Best-effort discovery of this environment's running `dsh web` ports. */
  async _discoverEnvironmentDshPorts(discoverDshWebPorts) {
    try {
      const ports = await discoverDshWebPorts({ platform: process.platform });
      if (!Array.isArray(ports)) return [];
      return ports.filter((candidate) => Number.isInteger(candidate) && candidate > 0 && candidate < 65536);
    } catch {
      return []; // discovery is best-effort: fall through to spawn
    }
  }

  /**
   * Window-owned spawn path (also the shared-mode Step C): only a port that
   * explicitly refuses connections counts as free. A probe that timed out
   * means a listener exists but did not answer — also occupied, so it is
   * skipped conservatively instead of risking an EADDRINUSE spawn and a
   * misleading "process exited early" error. Within one ServerManager
   * instance, never reuse the last port this instance spawned (fresh origin)
   * so DSH does not cache the previous workspace under the same origin.
   */
  async _spawnOnFreePort({ host, port, cwd, registryFile, generation, probeResult, adoptSibling = null }) {
    const occupied = probeResult.reachable || probeResult.reason !== 'refused';
    let scanStart = occupied ? port + 1 : port;
    if (this._lastSpawnPort !== null && scanStart <= this._lastSpawnPort) {
      scanStart = this._lastSpawnPort + 1;
    }
    const freePort = await this._findFreePort(host, scanStart);
    this._lastSpawnPort = freePort;
    this._throwIfCancelled(generation);
    return this._spawnAndWait(host, freePort, cwd, registryFile, generation, { adoptSibling });
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
   * Bounded wait until a port explicitly refuses connections (F-f,
   * sporadic restart port race). A killed child's listener can keep
   * answering — or silently hold — the port for a moment after the process
   * exits; without this wait the next ensureServer() probe marks the
   * configured port occupied (drift to port+1) or the replacement child
   * races the lingering socket. Polls every PORT_RELEASE_POLL_MS and
   * resolves as soon as the probe reports 'refused'; after `timeoutMs` it
   * gives up quietly (the conservative port scan still applies). Never
   * throws.
   *
   * @param {string} host - Loopback host.
   * @param {number} port - Port the killed child was serving on.
   * @param {number} timeoutMs - Bounded wait.
   * @returns {Promise<boolean>} True when the port refused in time.
   */
  async _waitForPortRefused(host, port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let refused = false;
      try {
        const result = await this.probe(host, port);
        refused = !result.reachable && result.reason === 'refused';
      } catch {
        return false;
      }
      if (refused) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, PORT_RELEASE_POLL_MS));
    }
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
   *
   * Results are cached for a short TTL: every registry mutation filters its
   * entries through this check INSIDE the cross-process lock, and one tasklist
   * call costs ~50-150ms — with N windows activating simultaneously the hold
   * time used to approach the lock timeout, past which the mutation proceeds
   * UNLOCKED and silently drops sibling entries again (the race the lock was
   * added to fix). A 1.5s stale-alive answer only ever delays bookkeeping
   * (the next sweep catches up); it never gates a kill (the orphan sweep
   * re-verifies process identity before terminating — see
   * _processCreatedBeforeMs).
   */
  static _isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    const now = Date.now();
    if (!ServerManager._aliveCache) ServerManager._aliveCache = new Map();
    const cached = ServerManager._aliveCache.get(pid);
    if (cached && cached.until > now) return cached.alive;
    const alive = ServerManager._isProcessAliveUncached(pid);
    // Bound the map: drop expired entries once it grows past a few hundred pids.
    if (ServerManager._aliveCache.size > 512) {
      for (const [key, value] of ServerManager._aliveCache) {
        if (value.until <= now) ServerManager._aliveCache.delete(key);
      }
    }
    ServerManager._aliveCache.set(pid, { alive, until: now + ALIVE_CACHE_TTL_MS });
    return alive;
  }

  /** Test/bookkeeping seam: forget every cached liveness answer. */
  static _resetAliveCache() {
    ServerManager._aliveCache = null;
  }

  static _isProcessAliveUncached(pid) {
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

  /**
   * Best-effort process-identity check: was the process `pid` created BEFORE
   * `atMs` (the registry entry's write time)? Registry entries are written
   * AFTER their child spawned, so the live process registered under a pid
   * must predate its entry. A process created AFTER the entry was written is
   * a REUSED pid (Windows recycles pids aggressively): killing it would
   * murder an innocent — live incident 2026-09-20: a window's activation
   * sweep tree-killed a dead-window entry (pid 13908) and, seconds later,
   * that same window's OWN freshly spawned dsh — which Windows had assigned
   * the very same recycled pid — died as "exited unexpectedly" while its
   * ready line was already in the log.
   *
   * Returns true  — process exists and predates the entry: safe to terminate.
   *         false — process exists but is younger than the entry: reused pid.
   *         null  — could not determine (tool missing/failed): the caller
   *                 keeps the legacy kill behavior rather than regressing
   *                 orphan cleanup on exotic systems.
   */
  static _processCreatedBeforeMs(pid, atMs) {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (!Number.isFinite(atMs) || atMs <= 0) return null;
    if (process.platform === 'win32') {
      let out;
      try {
        out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
          `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(pid)}' -Property CreationDate; ` +
          'if ($null -eq $p) { \'GONE\' } else { $p.CreationDate.ToFileTime() }',
        ], {
          encoding: 'utf8',
          timeout: 8000,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch {
        return null;
      }
      const answer = String(out).trim();
      if (answer === 'GONE') return true; // nothing to kill; entry removal is still correct
      const fileTime = Number(answer);
      if (!Number.isFinite(fileTime) || fileTime <= 0) return null;
      // FILETIME: 100ns ticks since 1601-01-01 UTC.
      const createdMs = (fileTime - 116444736000000000) / 10000;
      if (!Number.isFinite(createdMs)) return null;
      return createdMs < atMs;
    }
    // POSIX: elapsed seconds of the live process (`etimes` on procps ps).
    let out;
    try {
      out = execFileSync('ps', ['-o', 'etimes=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 4000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return null;
    }
    const elapsedSeconds = Number(String(out).trim());
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) return null;
    return (Date.now() - elapsedSeconds * 1000) < atMs;
  }

  /**
   * Bounded synchronous sleep used only while waiting for a peer registry
   * lock (all registry mutations are sync read-modify-writes). Atomics.wait
   * parks the thread without a busy loop; hosts that forbid it fall back to
   * a short bounded spin.
   */
  static _sleepSync(ms) {
    if (!ServerManager._sleepBuffer) ServerManager._sleepBuffer = new SharedArrayBuffer(4);
    try {
      Atomics.wait(new Int32Array(ServerManager._sleepBuffer), 0, 0, Math.max(0, ms));
      return;
    } catch {
      // Atomics.wait unavailable here: bounded busy spin below.
    }
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin */ }
  }

  /**
   * Best-effort inter-process lock guarding every registry read-modify-write.
   * With N windows activating simultaneously (sweep, stale cleanup, adopter
   * registration, ready-merge all at once) an unlocked read→write pair drops
   * sibling entries — worst case the race winner's freshly written entry,
   * whose launch token every later adopter needs to attach at all. Returns
   * the lock path, or null when the caller must proceed unlocked (lock
   * unusable, or a peer held it past the timeout): registry bookkeeping is
   * best-effort and must never block startup.
   */
  static _acquireRegistryLock(registryFile) {
    const lockPath = `${registryFile}.lock`;
    const deadline = Date.now() + REGISTRY_LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const fd = fs.openSync(lockPath, 'wx');
        try { fs.writeSync(fd, String(process.pid)); } catch { /* contents are advisory */ }
        try { fs.closeSync(fd); } catch { /* already closed */ }
        return lockPath;
      } catch (err) {
        if (!err || err.code !== 'EEXIST') return null; // cannot lock here: proceed unlocked
        try {
          if (Date.now() - fs.statSync(lockPath).mtimeMs > REGISTRY_LOCK_STALE_MS) {
            try { fs.unlinkSync(lockPath); } catch { /* a peer released it first */ }
          }
        } catch {
          // vanished between open and stat: retry immediately
        }
        if (Date.now() >= deadline) return null;
        ServerManager._sleepSync(REGISTRY_LOCK_POLL_MS);
      }
    }
  }

  /** Release the registry lock (best-effort; a stale lock self-expires). */
  static _releaseRegistryLock(lockPath) {
    if (!lockPath) return;
    try { fs.unlinkSync(lockPath); } catch { /* already gone / taken over */ }
  }

  /** Run fn() while holding the registry lock; proceeds unlocked on timeout. */
  static _withRegistryLock(registryFile, fn) {
    if (!registryFile) return fn();
    const lockPath = ServerManager._acquireRegistryLock(registryFile);
    try {
      return fn();
    } finally {
      ServerManager._releaseRegistryLock(lockPath);
    }
  }

  /**
   * Best-effort write of the registry array (creates the parent directory).
   *
   * Mode 0600: entries carry the instance's launch token (see _finalizeReady)
   * and its spawn-log path, either of which is enough to drive the instance's
   * authenticated API. Only the owning user's own VS Code windows ever read
   * this file, so there is no reader to lose. The mode is applied at creation
   * and re-asserted on every write (an existing file keeps its old mode
   * otherwise); on Windows the mode argument is ignored, which the platform's
   * per-user profile ACLs already cover.
   *
   * The write is an atomic publish (temp file + rename): concurrent readers
   * in sibling windows must never observe a torn file. A truncated registry
   * used to read as unparseable, and cleanupStaleRegistry then deleted the
   * whole file — erasing the race winner's entry and launch token, after
   * which no window could adopt that instance and every one spawned its own.
   */
  static _writeRegistry(registryFile, entries) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(registryFile)), { recursive: true });
      const payload = JSON.stringify(entries, null, 2) + '\n';
      const temporary = `${registryFile}.${process.pid}.${Date.now()}.tmp`;
      try {
        fs.writeFileSync(temporary, payload, { mode: 0o600 });
        try { fs.chmodSync(temporary, 0o600); } catch { /* non-POSIX */ }
        fs.renameSync(temporary, registryFile);
        return;
      } catch {
        try { fs.unlinkSync(temporary); } catch { /* already gone */ }
        // rename failed (platform quirk / AV interference): fall through to
        // the legacy in-place write rather than losing the bookkeeping.
      }
      fs.writeFileSync(registryFile, payload, { mode: 0o600 });
      try {
        fs.chmodSync(registryFile, 0o600);
      } catch {
        // non-POSIX filesystem (or an unsupported mode): best-effort only
      }
    } catch {
      // registry persistence is best-effort bookkeeping
    }
  }

  /** Merge one entry into the registry: replaces any same-port entry, keeps the rest. */
  static _mergeRegistry(registryFile, entry) {
    if (!registryFile) return;
    ServerManager._withRegistryLock(registryFile, () => {
      const entries = ServerManager._readRegistry(registryFile).filter(
        (e) => !(e && e.port === entry.port)
      );
      entries.push(entry);
      ServerManager._writeRegistry(registryFile, entries);
    });
  }

  /** Remove ONLY the entry with the given pid; other windows' entries stay. */
  static _removeRegistryEntry(registryFile, pid) {
    if (!registryFile) return;
    ServerManager._withRegistryLock(registryFile, () => {
      const entries = ServerManager._readRegistryRaw(registryFile).filter(
        (e) => !(e && e.pid === pid)
      );
      ServerManager._writeRegistry(registryFile, entries);
    });
  }

  /**
   * Normalize one attacher identity. Both fields may be null; an identity
   * with neither a positive vscodePid nor a non-empty windowId is unusable.
   */
  static _normalizeAdopter({ vscodePid = null, windowId = null } = {}) {
    return {
      vscodePid: Number.isInteger(vscodePid) && vscodePid > 0 ? vscodePid : null,
      windowId: typeof windowId === 'string' && windowId.length > 0 ? windowId : null,
    };
  }

  /**
   * Record this window as an adopter of the instance registry entry matching
   * `port` (shared-mode bookkeeping). Best-effort: a missing/corrupt registry
   * or a dead entry is silently ignored, and adopters already present (by
   * vscodePid) are never duplicated.
   */
  static _registerAdopter(registryFile, { port, vscodePid, windowId }) {
    if (!registryFile || !Number.isInteger(port)) return;
    const adopter = ServerManager._normalizeAdopter({ vscodePid, windowId });
    if (adopter.vscodePid === null && adopter.windowId === null) return;
    ServerManager._withRegistryLock(registryFile, () => {
      const entries = ServerManager._readRegistryRaw(registryFile);
      let changed = false;
      for (const entry of entries) {
        if (!entry || entry.port !== port || !ServerManager._isProcessAlive(entry.pid)) continue;
        const attachers = Array.isArray(entry.attachers) ? [...entry.attachers] : [];
        const duplicate = attachers.some((a) => a && (
          adopter.vscodePid !== null ? a.vscodePid === adopter.vscodePid : a.windowId === adopter.windowId
        ));
        if (duplicate) continue;
        attachers.push(adopter);
        entry.attachers = attachers;
        changed = true;
      }
      if (changed) ServerManager._writeRegistry(registryFile, entries);
    });
  }

  /**
   * Remove this window's attacher record from every registry entry (called
   * on deactivation). Matching is by vscodePid OR windowId so a window whose
   * extension-host pid changed between adopt cycles is still cleaned up.
   */
  static removeAdopterFromRegistry(registryFile, { vscodePid = null, windowId = null } = {}) {
    if (!registryFile) return;
    const target = ServerManager._normalizeAdopter({ vscodePid, windowId });
    if (target.vscodePid === null && target.windowId === null) return;
    ServerManager._withRegistryLock(registryFile, () => {
      const entries = ServerManager._readRegistryRaw(registryFile);
      let changed = false;
      for (const entry of entries) {
        if (!entry || !Array.isArray(entry.attachers) || entry.attachers.length === 0) continue;
        const filtered = entry.attachers.filter((a) => {
          if (!a || typeof a !== 'object') return true;
          const pidMatch = target.vscodePid !== null && a.vscodePid === target.vscodePid;
          const winMatch = target.windowId !== null && a.windowId === target.windowId;
          return !(pidMatch || winMatch);
        });
        if (filtered.length !== entry.attachers.length) {
          entry.attachers = filtered;
          changed = true;
        }
      }
      if (changed) ServerManager._writeRegistry(registryFile, entries);
    });
  }

  /**
   * True when the entry carries at least one attacher whose extension-host
   * pid is still alive (optionally excluding one pid, e.g. our own).
   */
  static entryHasLiveAdopters(entry, { excludeVscodePid = null, isProcessAlive = null } = {}) {
    const alive = typeof isProcessAlive === 'function' ? isProcessAlive : (pid) => ServerManager._isProcessAlive(pid);
    const attachers = entry && Array.isArray(entry.attachers) ? entry.attachers : [];
    return attachers.some((a) => a
      && Number.isInteger(a.vscodePid)
      && a.vscodePid > 0
      && a.vscodePid !== excludeVscodePid
      && alive(a.vscodePid));
  }

  /**
   * True when the instance this manager spawned is currently adopted by at
   * least one other live window (shared-instance mode): the owner's exit
   * path then leaves the child running for those windows instead of killing
   * it, and the activation sweep reclaims it once every attacher is gone.
   *
   * @param {string|null} registryFile - Instance registry path.
   * @returns {Promise<boolean>}
   */
  async ownedChildHasLiveAdopters(registryFile) {
    if (!this._child || !registryFile) return false;
    const pid = this._child.pid;
    if (!Number.isInteger(pid)) return false;
    const entry = ServerManager._readRegistryRaw(registryFile).find((e) => e && e.pid === pid);
    if (!entry) return false;
    return ServerManager.entryHasLiveAdopters(entry, { excludeVscodePid: this.ownerVscodePid });
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
   * Best-effort pre-spawn profile guard: ensures the target profile's
   * cordis.patch.yml disables server module HMR (0.1.2-alpha.1 upstream
   * default; older runtimes break every in-flight tool call during a module
   * reload). Failures never block the spawn — the guard hardens boot, it is
   * not a precondition.
   */
  _applyRuntimeProfileGuard() {
    const guard = this.runtimeProfileGuard;
    const runtime = this.resolvedRuntime;
    if (!runtime) return;
    if (guard) {
      try {
        const result = guard(runtime);
        if (result && result.applied) {
          this._emit('selfheal', 'Disabled server module HMR in the DSH profile (tool-crash guard for runtimes below 0.1.2-alpha.1)');
        }
      } catch (error) {
        console.error('dsh-vs-sidebar: runtime profile guard failed:', error && error.message ? error.message : error);
      }
    }
    const bundleGuard = this.profileBundleGuard;
    if (bundleGuard) {
      try {
        const result = bundleGuard(runtime);
        if (result && result.applied && Array.isArray(result.removed) && result.removed.length > 0) {
          this._selfHealCount += 1;
          this._emit('selfheal', 'Removed {count} unresolvable DSH profile bundle entries ({names}); manifest backup: {backup}', {
            count: result.removed.length,
            names: result.removed.join(', '),
            backup: result.backupPath || 'none',
          });
        }
      } catch (error) {
        console.error('dsh-vs-sidebar: profile bundle guard failed:', error && error.message ? error.message : error);
      }
    }
  }

  /**
   * Spawn the verified managed runtime and poll until the service is
   * ready, the process exits early, or the 30s deadline passes. The spawn cwd
   * follows the ensureServer contract: only an explicitly provided cwd is
   * used; otherwise the child inherits the extension host's current directory.
   */
  async _spawnAndWait(host, port, cwd, registryFile, generation = this._cancelGeneration, options = {}) {
    this._throwIfCancelled(generation);
    this._applyRuntimeProfileGuard();
    try {
      return await this._spawnWithPatchSelfHeal(host, port, cwd, registryFile, generation, true, options);
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
        const server = await this._spawnWithPatchSelfHeal(host, port, cwd, registryFile, generation, true, options);
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
  /**
   * Launch token printed by dsh 0.1.2+ in its ready line
   * (`dsh web: http://…/?token=…`), read from the most recent spawn log.
   * Null on older runtimes (plain URL) and before the ready line appears.
   */
  _extractLaunchToken() {
    return ServerManager.launchTokenFromSpawnLog(this._lastSpawnLogPath);
  }

  _readLastSpawnLogTail(maxBytes = 8192) {
    return ServerManager._readLogTail(this._lastSpawnLogPath, maxBytes);
  }

  /** Session flag: the current runtime rejected --no-open once already. */
  noOpenSuppressed() {
    return Boolean(this._noOpenSuppressed);
  }

  // D1 -patch self-heal: when the first spawn exits early while a --patch
  // overlay was in effect, retry exactly once with the patch removed. A
  // successful retry continues transparently and is recorded for Diagnose;
  // a second early exit reports the original SPAWN_EXITED_EARLY error.
  async _spawnWithPatchSelfHeal(host, port, cwd, registryFile, generation, usePatch, options = {}) {
    const hadPatch = usePatch && this._effectivePatchPath() != null;
    try {
      return await this._spawnAttempt(host, port, cwd, registryFile, generation, usePatch, options);
    } catch (err) {
      if (!(hadPatch && err && err.code === 'SPAWN_EXITED_EARLY')) throw err;
      try {
        const server = await this._spawnAttempt(host, port, cwd, registryFile, generation, false, options);
        this._selfHealCount += 1;
        // The consequence is the point: the --patch overlay is what inserts
        // the dsh-vscode-integration plugin, and without it nothing consumes
        // the iframe's dsh_session marker — every embedded surface boots the
        // DSH app with its own auto-selected workspace instead of the window's
        // bound one ("newly opened window's workspace never binds"). Naming
        // that here keeps the degradation from being invisible in Diagnose.
        this._emit('selfheal', 'DSH exited early with --patch; retried without --patch — the instance now runs WITHOUT the dsh-vscode-integration plugin (dsh_session follow, theme/clipboard bridges inactive)');
        return server;
      } catch (err2) {
        // No second retry: the original SPAWN_EXITED_EARLY code stands.
        throw err2;
      }
    }
  }

  _spawnAttempt(host, port, cwd, registryFile, generation = this._cancelGeneration, usePatch = true, options = {}) {
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
      // Cold-start aware readiness budget: a first boot of the day can take
      // far longer than the warm 30s (measured 55.7s cold vs ~9s warm on the
      // reference machine) because N windows starting at once each load the
      // whole dsh dependency tree through a cold file cache plus antivirus.
      // Killing those children at 30s reset everyone's progress and produced
      // chains of "did not become ready within 30s" — the multi-window
      // "sometimes never starts" failure. Genuine breakage still fails fast:
      // SPAWN_EXITED_EARLY is event-driven, not deadline-driven.
      const readyTimeoutMs = Number.isFinite(options.readyTimeoutMs) && options.readyTimeoutMs > 0
        ? options.readyTimeoutMs
        : (this._hasEverBeenReady ? HEALTH_TIMEOUT_MS : COLD_HEALTH_TIMEOUT_MS);
      const deadline = Date.now() + readyTimeoutMs;
      let settled = false;
      let polls = 0;

      // Persistent listener: any exit NOT caused by stop() is unexpected and
      // reported through onStatus (e.g. the service crashed after becoming
      // ready). Deliberately NOT gated on the startup `settled` flag: after
      // the ready promise resolves this listener is the lifetime crash
      // reporter. Cleanup races are guarded by the _child identity check
      // below (the deadline/cancel paths null _child before killing).
      const onUnexpectedExit = (code, signal) => {
        if (this._stopping) return;        // deliberate stop()
        if (this._child !== child) return; // already detached (timeout cleanup)
        this._child = null;
        this._ownedServer = null;
        // code/signal are null on the opposite exit paths (Windows clean
        // exit has signal=null); the {placeholder} renderer keeps nulls as
        // literal "{signal}", so normalize both to a visible value.
        this._emit('error', 'DSH process exited unexpectedly (pid={pid}, code={code}, signal={signal}){excerpt}', {
          pid: child.pid,
          code: code == null ? 'none' : code,
          signal: signal == null ? 'none' : signal,
          excerpt: excerptSuffix(this._readLastSpawnLogTail()),
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
        const error = new ServerError(STARTUP_ERRORS.SPAWN_EXITED_EARLY.template, {
          code: code == null ? 'none' : code,
          signal: signal == null ? 'none' : signal,
          // Agent-debuggable: the child's own stderr names the startup
          // blocker (unresolvable bundle, plugin import failure, bad flag);
          // surface its tail instead of a bare exit code.
          excerpt: excerptSuffix(this._readLastSpawnLogTail()),
        }, 'SPAWN_EXITED_EARLY');
        reject(error);
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
        // Post-spawn environment verification (non-Windows hosts only — the
        // observation is Linux /proc based and reports `unknown` elsewhere):
        // the last line of defence behind assertNativeRuntimeEnvironment. A
        // pre-spawn path check cannot see through a symlink into a foreign
        // mount, nor through a shim that re-execs a Windows binary, and WSL
        // interop makes the result observable only once the process exists
        // (/proc/<pid>/comm ends in .exe, /proc/<pid>/exe -> /init). Checked
        // on every round so the fork/exec race cannot hide it, and before any
        // probe result is trusted: the child would answer every workspace
        // path this window sends with workspace/invalid-path.
        if (child.exitCode === null && detectProcessEnvironment(child.pid) === 'windows') {
          settled = true;
          if (this._child === child) this._child = null;
          this._ownedServer = null;
          child.removeListener('exit', onUnexpectedExit);
          await this._killChild(child);
          reject(new ServerError(
            STARTUP_ERRORS.RUNTIME_FOREIGN_ENVIRONMENT.template,
            { path: launch.command, host: hostEnvironmentLabel() },
            'RUNTIME_FOREIGN_ENVIRONMENT'
          ));
          return;
        }
        // dsh 0.1.2+ prints its authenticated URL (…/?token=…) to stdout at
        // readiness; older runtimes never do, so this stays null for them.
        const token = this._extractLaunchToken();
        const probeResult = await this.probe(host, port, token === null ? {} : { token });
        if (settled) return;

        if (probeResult.reachable && probeResult.isDsh) {
          settled = true;
          resolve(this._finalizeReady(host, port, cwd, child.pid, registryFile, logPath, token));
          return;
        }

        // Shared-mode mid-wait sibling adoption: while OUR child is still
        // booting, a sibling window's instance may already be serving the
        // configured port. Once it becomes adoptable, abandon this duplicate
        // boot and adopt — under an N-window cold start every window spawns
        // its own slow boot, and only the first one to bind wins; adopting
        // the moment the winner is adoptable keeps the losers from burning
        // their full readiness budget on a child that must die of
        // EADDRINUSE anyway.
        polls += 1;
        if (
          typeof options.adoptSibling === 'function'
          && polls % SIBLING_ADOPT_POLL_ROUNDS === 0
          && child.exitCode === null
          && child.signalCode === null
        ) {
          try {
            const adopted = await options.adoptSibling();
            if (!settled && adopted) {
              settled = true;
              if (this._child === child) this._child = null;
              this._ownedServer = null;
              child.removeListener('exit', onUnexpectedExit);
              await this._killChild(child); // abandon our duplicate boot
              resolve(adopted);
              return;
            }
          } catch {
            // sibling adoption is opportunistic; keep waiting for our child
          }
          if (settled) return;
        }

        if (Date.now() >= deadline) {
          settled = true;
          this._child = null;
          this._ownedServer = null;
          child.removeListener('exit', onUnexpectedExit);
          await this._killChild(child); // best-effort cleanup of the hung process
          // The killed child's port can keep answering for a moment; without
          // this wait an immediate Retry probes a lingering listener,
          // classifies the port as occupied, and drifts the replacement spawn
          // one port up (field logs: 3080 → 3081 → 3082 retry chains).
          await this._waitForPortRefused(host, port, PORT_RELEASE_WAIT_MS);
          reject(new ServerError(
            STARTUP_ERRORS.HEALTH_TIMEOUT.template,
            { seconds: readyTimeoutMs / 1000, pid: child.pid },
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
  _finalizeReady(host, port, cwd, pid, registryFile, logPath = null, authToken = null) {
    this._registryFile = registryFile || null;
    this._hasEverBeenReady = true; // warm boot from here on: 30s readiness budget
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
        // Which OS environment this instance RUNS in — observed from the
        // process when this side can see it (an interop child spawned by a
        // pre-fix WSL window is a Windows process whose runtime shape looks
        // native), else the resolved runtime's own environment. Other
        // environments' windows refuse to adopt a differing value, so a WSL
        // window can never bind its workspace to a Windows-hosted DSH (whose
        // every path check fails with workspace/invalid-path).
        runtimeEnvironment: this.runtimeEnvironmentFor(pid),
        at: Date.now(),
        ...(logPath ? { log: logPath } : {}),
        // Cross-window sharing on dsh 0.1.2+: the launch token is what makes a
        // fenced instance adoptable at all (a tokenless probe answers 401, so
        // a sibling window cannot even recognize the instance, let alone bind
        // a workspace to it). The spawn log holds the same token in its ready
        // line, but a token here survives log rotation/cleanup and needs no
        // tail read. It is the same secret either way — this registry already
        // records the log path, whose ready line carries the token verbatim —
        // so nothing new is exposed; _writeRegistry keeps the file at 0600.
        ...(authToken ? { authToken } : {}),
        // Plugin 0.8.0 configure bearer: lets an adopting window push live
        // bridge config (FIM/LM/editor-links) to this instance without a
        // restart. Same 0600 file as authToken — same reader set.
        ...(this.configureToken() ? { configureToken: this.configureToken() } : {}),
      });
    }
    // The plain URL stays canonical for every internal consumer; the tokened
    // authUrl exists only for consumers that load the page (sidebar iframe,
    // open-in-browser) on dsh 0.1.2+ where the auth fence would otherwise
    // answer 401.
    const server = {
      url: `http://${host}:${port}`,
      host,
      port,
      pid,
      owned: true,
      ...(authToken ? {
        authToken,
        authUrl: `http://${host}:${port}/?token=${encodeURIComponent(authToken)}`,
      } : {}),
      ...(this.configureToken() ? { configureToken: this.configureToken() } : {}),
    };
    this._ownedServer = server;
    this._emit('ready', 'DSH web ready: http://{host}:{port} (pid={pid})', { host, port, pid }, server);
    this._startHealthWatch(host, port, authToken);
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
  _startHealthWatch(host, port, token = null, intervalMs = 30000) {
    this._clearHealthWatch();
    // Instance-level override (mainly a test seam) beats the default cadence.
    const cadence = Number.isInteger(this._healthIntervalMs) && this._healthIntervalMs > 0
      ? this._healthIntervalMs
      : intervalMs;
    this._healthPort = port;
    this._healthTimer = setInterval(() => {
      Promise.resolve(this.probe(host, port, token === null ? {} : { token }))
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
    // F-f: capture the owned endpoint before the state is cleared — after
    // the kill we wait (bounded) for the port to explicitly refuse.
    const releaseHost = this._ownedServer ? this._ownedServer.host : null;
    const releasePort = this._ownedServer ? this._ownedServer.port : null;
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

    // F-f (sporadic restart port race): see _waitForPortRefused. Only a
    // real owned endpoint is waited for; the wait never throws and a
    // timeout simply hands over to the conservative port scan.
    if (Number.isInteger(releasePort)) {
      await this._waitForPortRefused(releaseHost || DEFAULT_HOST, releasePort, PORT_RELEASE_WAIT_MS);
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
   *
   * Runs under the registry lock: every activating window executes this, and
   * an unlocked prune concurrent with the race winner's ready-merge used to
   * erase that winner's fresh entry (and its launch token) for good.
   */
  static cleanupStaleRegistry(registryFile) {
    ServerManager._withRegistryLock(registryFile, () => {
      let parsed = null;
      try {
        parsed = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
      } catch {
        parsed = null; // missing or unparseable
      }
      if (!Array.isArray(parsed)) {
        // Missing / corrupt / legacy single-object file: nothing to salvage —
        // remove it (best effort). A missing file raises ENOENT — ignored.
        // Safe against torn reads since _writeRegistry publishes atomically.
        try { fs.unlinkSync(registryFile); } catch { /* ignore */ }
        return;
      }
      const alive = parsed.filter((e) => e && ServerManager._isProcessAlive(e.pid));
      if (alive.length !== parsed.length) {
        ServerManager._writeRegistry(registryFile, alive);
      }
    });
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
    ServerManager._withRegistryLock(registryFile, () => {
      const wanted = new Set(pids);
      const entries = ServerManager._readRegistryRaw(registryFile).filter(
        (e) => !(e && wanted.has(e.pid))
      );
      ServerManager._writeRegistry(registryFile, entries);
    });
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
   *  - entries owned by `currentVscodePid` (this window) are never swept;
   *  - shared-mode entries with attachers (windows that adopted a dead
   *    owner's instance) stay alive while any attacher extension-host is
   *    still running — dead attacher pids are pruned on the way; the entry
   *    is swept only once the owner AND every attacher are gone.
   *
   * Reuses the exact tree-kill implementation that backs the orphan-cleanup
   * command (`killProcessTree`); nothing here re-implements process killing.
   *
   * Locking: the read-and-decide pass runs under the registry lock (sibling
   * windows mutate the same file while this sweep reads it); the tree-kills
   * run OUTSIDE the lock (they can take seconds each and the lock must not
   * stall every activating window), and the removal re-merges under a fresh
   * lock pass so entries written concurrently are preserved.
   *
   * @param {string} registryFile - Registry JSON path.
   * @param {object} [options]
   * @param {(pid: number) => Promise<void>} [options.terminate] - defaults to killProcessTree.
   * @param {(pid: number) => boolean} [options.isProcessAlive] - defaults to ServerManager._isProcessAlive.
   * @param {(pid: number, atMs: number) => boolean|null} [options.verify] - process-identity
   *   re-check before each kill (see _processCreatedBeforeMs): false skips the
   *   kill (recycled pid), null keeps legacy behavior; defaults to the real check.
   * @param {({pid: number, atMs: number}) => void} [options.onSkip] - diagnostics
   *   callback for skipped (recycled-pid) kills.
   * @param {number|null} [options.currentVscodePid] - this window's extension-host pid.
   * @returns {Promise<Array<{pid: number, port: number|undefined, vscodePid: number}>>} swept entries.
   */
  static async sweepDeadOwnerEntries(registryFile, { terminate = null, isProcessAlive = null, verify = null, onSkip = null, currentVscodePid = null } = {}) {
    const kill = typeof terminate === 'function' ? terminate : (pid) => killProcessTree(pid);
    const alive = typeof isProcessAlive === 'function' ? isProcessAlive : (pid) => ServerManager._isProcessAlive(pid);

    // Pass 1 (locked): decide which entries stay and which are orphaned.
    const decision = ServerManager._withRegistryLock(registryFile, () => {
      const keep = [];
      const swept = [];
      let attachersPruned = false;
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
        // Owner is dead: shared-mode adopters keep the instance alive until
        // the last of them exits; only then is the orphan reclaimed.
        if (Array.isArray(entry.attachers) && entry.attachers.length > 0) {
          const live = entry.attachers.filter((a) => a
            && Number.isInteger(a.vscodePid)
            && a.vscodePid > 0
            && alive(a.vscodePid));
          if (live.length > 0) {
            entry.attachers = live;
            attachersPruned = true;
            keep.push(entry);
            continue;
          }
        }
        swept.push({ pid: entry.pid, port: entry.port, vscodePid: owner, at: entry.at });
      }
      // Pruned-attacher state is published under the same lock pass; orphaned
      // entries stay in the file until their kills actually ran (pass 2), so
      // a crash here cannot strand a live DSH with no registry record.
      if (attachersPruned) {
        ServerManager._writeRegistry(registryFile, keep);
      }
      return { keep, swept, attachersPruned };
    });

    // Pass 2 (unlocked): tree-kill the orphaned DSH processes. Each kill is
    // re-verified against the entry's write time first: a live process
    // created AFTER the entry was written is a recycled pid wearing the dead
    // entry's number — killing it would terminate some other window's brand
    // new child (live 2026-09-20: sweep "terminated 13908" followed, seconds
    // later, by that same window losing its own fresh child, pid 13908,
    // "exited unexpectedly" with its ready line already on the log).
    const verifyProcess = typeof verify === 'function' ? verify : ((pid, at) => ServerManager._processCreatedBeforeMs(pid, at));
    for (const sweptEntry of decision.swept) {
      const identity = verifyProcess(sweptEntry.pid, sweptEntry.at);
      if (identity === false) {
        // Reused pid: leave the innocent process alone; the stale entry is
        // dropped by pass 3, so a later activation re-evaluates from scratch.
        if (typeof onSkip === 'function') {
          try { onSkip({ pid: sweptEntry.pid, atMs: sweptEntry.at }); } catch { /* diagnostics only */ }
        }
        console.warn(`dsh-vs-sidebar: orphan sweep skipped pid ${sweptEntry.pid} — the process postdates its registry entry (recycled pid)`);
        continue;
      }
      try {
        // identity === true (verified old process) or null (cannot verify on
        // this system — legacy behavior: trust the entry).
        await kill(sweptEntry.pid);
      } catch {
        // best-effort tree-kill; the record is still dropped below
      }
    }

    // Pass 3 (locked): drop the swept entries, preserving anything concurrent
    // windows wrote meanwhile. Matching is pid AND owner: a brand-new entry
    // that happened to reuse a swept pid (pid reuse) carries a different
    // owner marker and survives.
    if (decision.swept.length > 0) {
      ServerManager._withRegistryLock(registryFile, () => {
        const sweptKeys = new Set(decision.swept.map((s) => `${s.pid}:${s.vscodePid}`));
        const survivors = ServerManager._readRegistryRaw(registryFile).filter((e) => {
          if (!e || !Number.isInteger(e.pid)) return true;
          return !sweptKeys.has(`${e.pid}:${e.vscodePid}`);
        });
        ServerManager._writeRegistry(registryFile, survivors);
      });
    }
    return decision.swept;
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
