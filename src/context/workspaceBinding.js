"use strict";

const path = require("node:path");

/**
 * Workspace binding (SM-2).
 *
 * Replaces the extension's old "cwd == workspace" parallel model with the DSH
 * workspace registry. The binding maps a VS Code workspace root to a DSH
 * WorkspaceView and a blank root session, reusing the registry and session
 * APIs instead of killing/restarting the DSH child when the active workspace
 * changes.
 *
 * 0.1.5 dropped `workspace.list`, so registration is create-or-adopt:
 * `workspace.create` returns `{ workspace, created }`. On a server this
 * extension runs a miss simply registers; on a genuinely user-managed server a
 * `created: true` answer means the extension JUST registered a workspace the
 * user did not see coming, so the consent gate fires and a decline ROLLS THE
 * CREATION BACK with `workspace.delete` (safe: the root session is created only
 * after binding, so the fresh workspace holds no sessions yet). A pre-existing
 * workspace (`created: false`) proceeds silently - no prompt regression on
 * every reload.
 *
 * "Runs" covers two handle shapes: `owned` (this window spawned the child) and
 * `managed` (a sibling window of the same OS environment did, and this window
 * adopted it in shared-instance mode). Both are the extension's own
 * bookkeeping; gating the second on consent made a shared instance effectively
 * unbindable - the prompt was answered away or declined, and a decline rolled
 * the registration back every time. Only a server neither window started (the
 * user's own `dsh web`, adopted with autoStart off) still prompts.
 */

const { listSessions, createSession } = require("../sessionNavigation");
const {
  createWorkspace,
  deleteWorkspace,
} = require("../ch2/workspaceClient");

/** @type {Readonly<Record<string,string>>} */
const BINDING_STATES = Object.freeze({
  UNBOUND: "unbound",
  RESOLVING: "resolving",
  MATCHING: "matching",
  CONSENT: "consent",
  CREATING: "creating",
  ENSURING: "ensuring",
  BOUND: "bound",
  VERIFYING: "verifying",
  ERROR: "error",
});

/**
 * Build the initial Binding value.
 *
 * `errorCode` is the DSH API business code behind a failed bind (e.g.
 * `workspace/invalid-path`), kept separate from the human-readable `error`
 * text so callers can react to the CAUSE instead of matching prose; null
 * whenever the binding is not in error.
 *
 * @returns {object} A frozen Binding.
 */
function initialBinding() {
  return Object.freeze({
    state: BINDING_STATES.UNBOUND,
    cwd: null,
    workspaceId: null,
    sessionId: null,
    owned: false,
    error: null,
    errorCode: null,
    at: Date.now(),
  });
}

/**
 * Create a workspace binding controller.
 *
 * @param {object} options
 * @param {object} options.vscode - VS Code facade used by the default consent
 *   dialog.
 * @param {() => string|null|undefined} [options.baseUrlProvider] - Returns the
 *   current DSH loopback base URL; falls back to the server passed to resolve.
 * @param {(cwd: string) => Promise<boolean>|boolean} [options.requestConsent] -
 *   Called when a non-owned server had to register a NEW workspace for `cwd`
 *   (`created === true`); a decline rolls the registration back. Defaults to a
 *   modal VS Code warning.
 * @param {number} [options.debounceMs=250] - Debounce window for resolve calls.
 * @param {(binding: object) => void} [options.onChange] - Called after every
 *   state change.
 * @returns {object} `{ resolve, refresh, dispose, state }`.
 */
function createWorkspaceBinding({
  vscode,
  baseUrlProvider,
  requestConsent,
  debounceMs = 250,
  onChange,
  fetchImpl,
} = {}) {
  let binding = initialBinding();
  /** @type {Map<string, {workspaceId: string, sessionId: string}>} */
  const cache = new Map();
  let timer = null;
  /** @type {Array<(sessionId: string|null) => void>} */
  let waiters = [];
  let currentServer = null;
  let currentCwd = null;
  let disposed = false;
  /** Identity of the server the cache was populated for. @type {string|null} */
  let cacheServerId = null;
  // Run serialization: `workspace/create` + `session/list` + `session/create`
  // are multi-round-trip flows, so a resolve() arriving while one flow is in
  // flight (view-resolution connect, workspace rebind, @dsh participant …)
  // used to start a SECOND concurrent flow. Concurrent flows double-created
  // sessions (both saw "no matching session" before either created one),
  // double-prompted the consent dialog, and interleaved setState() so the
  // caller-visible binding state belonged to the other run. All runs now go
  // through one promise chain: strictly one at a time, latest (server, cwd)
  // wins, and every waiter is settled by the run that incorporated it.
  let runChain = Promise.resolve();

  /**
   * Replace the binding snapshot and notify listeners.
   *
   * @param {object} patch - Partial binding fields to overwrite.
   */
  function setState(patch) {
    binding = Object.freeze({ ...binding, ...patch, at: Date.now() });
    if (typeof onChange === "function") {
      try {
        onChange(binding);
      } catch (_) {
        // Listener failures must never break the binding state machine.
      }
    }
  }

  /**
   * @param {string|null|undefined} cwd - Candidate workspace root.
   * @returns {string|null} Normalized non-empty cwd or null.
   */
  function normalizeCwd(cwd) {
    if (typeof cwd !== "string" || cwd.length === 0) return null;
    return cwd;
  }

  /**
   * @param {string} cwd - Workspace root.
   * @returns {string} Cache key.
   */
  function cacheKey(cwd) {
    const resolved = path.resolve(cwd);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }

  /**
   * Identity of the server a binding was resolved against (loopback origin +
   * owned pid). The in-memory cache must never answer for a different server:
   * after a reconnect the child may come back on another port (port-conflict
   * fallback), a different DSH home, or as a foreign shared instance, and a
   * cached sessionId from the previous instance would point at a workspace or
   * session that no longer exists there — the sidebar then loads a dead
   * dsh_session and the workspace silently fails to bind.
   *
   * The pid is part of the identity whenever it is known - owned or adopted
   * from the instance registry alike. The port is the one thing that DOES
   * repeat: a dead shared instance is replaced on the same configured port, so
   * a url-only identity would serve the previous instance's workspace and
   * session ids to the replacement (the sidebar loads a dead dsh_session and
   * the workspace silently fails to bind).
   *
   * @param {object|null} server - Current server handle.
   * @returns {string|null} Server identity, or null when unknown.
   */
  function serverIdentity(server) {
    const url = server && typeof server.url === "string" ? server.url : null;
    if (!url) return null;
    const pid = Number.isInteger(server.pid) ? `#${server.pid}` : "";
    return `${url}${pid}`;
  }

  /**
   * Drop the cache whenever the server identity changed since the last run.
   *
   * @param {object|null} server - Server handle of the upcoming run.
   */
  function ensureCacheServer(server) {
    const identity = serverIdentity(server);
    if (identity === null) return;
    if (cacheServerId !== identity) {
      cache.clear();
      cacheServerId = identity;
    }
  }

  /**
   * @param {object} server - Current server handle.
   * @returns {string|null} Loopback base URL.
   */
  function getBaseUrl(server) {
    const fromProvider = typeof baseUrlProvider === "function" ? baseUrlProvider() : null;
    return fromProvider || (server && server.url) || null;
  }

  /**
   * Default consent prompt. Returns true only when the user picks the create
   * action.
   *
   * @param {string} cwd - Workspace root to create.
   * @returns {Promise<boolean>} User decision.
   */
  async function defaultRequestConsent(cwd) {
    if (!vscode || !vscode.window || typeof vscode.window.showWarningMessage !== "function") {
      return false;
    }
    const createLabel = "创建并绑定";
    const choice = await vscode.window.showWarningMessage(
      `DSH workspace is not registered for ${cwd}`,
      { modal: true },
      createLabel
    );
    return choice === createLabel;
  }

  /**
   * @param {string} cwd - Workspace root.
   * @returns {Promise<boolean>} User decision.
   */
  async function requestConsentFor(cwd) {
    if (typeof requestConsent === "function") {
      return Boolean(await requestConsent(cwd));
    }
    return defaultRequestConsent(cwd);
  }

  /**
   * True when both paths resolve to the same directory (platform-aware).
   *
   * @param {string} a - First path.
   * @param {string} b - Second path.
   * @returns {boolean} True when equal after resolution.
   */
  function sameResolvedPath(a, b) {
    if (typeof a !== "string" || typeof b !== "string" || a.length === 0 || b.length === 0) {
      return false;
    }
    const left = path.resolve(a);
    const right = path.resolve(b);
    return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
  }

  /**
   * B2 sticky binding: reuse the workspace's most recently updated ROOT
   * session (blank or not), creating one only when no root session matches
   * at all.
   *
   * The previous blank-only reuse multiplied sessions: once a conversation
   * started the session stopped being blank, so every reconnect / window
   * reload / rebind created yet another session (issue #4 session
   * explosion). The freshest-root rule keeps @dsh prompts, the sidebar
   * iframe and reloads on ONE session (3 messages -> 0 new sessions),
   * while a freshly created "New Session" still wins because its
   * updatedAt is newest.
   *
   * Membership: workspace.sessionIds when present, with a same-cwd
   * fallback so sessions created through dsh.newSession (bare cwd payload)
   * also stick. Subagent-origin and child sessions never bind (they follow
   * their own parents).
   *
   * @param {string} baseUrl - DSH loopback base URL.
   * @param {object} workspace - WorkspaceView.
   * @param {string} cwd - Workspace root being bound.
   * @param {Function} [fetchImpl] - Optional fetch implementation.
   * @returns {Promise<string>} Session id.
   */
  async function ensureWorkspaceRootSession(baseUrl, workspace, cwd, fetchImpl) {
    const items = await listSessions(baseUrl, { fetchImpl });
    const sessionIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [];
    // listSessions sorts by updatedAt descending: the first matching root
    // session IS the freshest.
    for (const item of items) {
      if (
        item
        && item.origin !== "subagent"
        && !item.parentSessionId
        && typeof item.sessionId === "string"
        && item.sessionId.length > 0
        && (sessionIds.includes(item.sessionId) || sameResolvedPath(item.cwd, cwd))
      ) {
        return item.sessionId;
      }
    }
    return createSession(baseUrl, { workspaceId: workspace.workspaceId, fetchImpl });
  }

  /**
   * Settle all debounced waiters with null and cancel any pending timer.
   */
  function settleNull() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve(null);
  }

  /**
   * Execute one full binding pass.
   *
   * @param {object|null} server - Server handle to bind.
   * @param {string|null} cwd - Workspace root to bind.
   * @param {boolean} forceRefresh - True to bypass the in-memory cache.
   * @returns {Promise<string|null>} Bound session id, or null on consent
   *   cancel / no workspace / error.
   */
  async function run(server, cwd, forceRefresh) {
    if (disposed || !cwd) {
      if (!cwd) setState({ ...initialBinding(), owned: Boolean(server && server.owned) });
      return null;
    }

    const owned = Boolean(server && server.owned === true);
    // A server this extension started - this window (owned) or a sibling
    // window of the same environment (managed, adopted in shared mode) - is
    // the extension's own instance, never a service the user must consent to
    // having workspaces registered on. `owned` still drives the reported
    // state: it keeps meaning "this window owns the child process".
    const trustedServer = owned || Boolean(server && server.managed === true);
    ensureCacheServer(server);
    const key = cacheKey(cwd);
    if (!forceRefresh && cache.has(key)) {
      const cached = cache.get(key);
      setState({
        state: BINDING_STATES.BOUND,
        cwd,
        workspaceId: cached.workspaceId,
        sessionId: cached.sessionId,
        owned,
        error: null,
        errorCode: null,
      });
      return cached.sessionId;
    }

    const baseUrl = getBaseUrl(server);
    if (!baseUrl) {
      setState({
        state: BINDING_STATES.ERROR,
        cwd,
        workspaceId: null,
        sessionId: null,
        owned,
        error: "DSH workspace API unavailable: no base URL",
      });
      return null;
    }

    try {
      setState({
        state: BINDING_STATES.CREATING,
        cwd,
        workspaceId: null,
        sessionId: null,
        owned,
        error: null,
        errorCode: null,
      });
      // 0.1.5 has no workspace.list: create-or-adopt is the only probe.
      const created = await createWorkspace(baseUrl, cwd, { fetchImpl });
      const workspace = created.workspace;

      if (!trustedServer && created.created === true) {
        // A user-managed server just got a workspace registered that the user
        // did not see coming - the consent gate fires now, before any session
        // is bound to it.
        setState({
          state: BINDING_STATES.CONSENT,
          cwd,
          workspaceId: workspace.workspaceId,
          sessionId: null,
          owned,
          error: null,
          errorCode: null,
        });
        const allowed = await requestConsentFor(cwd);
        if (!allowed) {
          // Roll the fresh registration back. Safe: the root session is
          // created only below, so the workspace holds no sessions to
          // cascade. A failed rollback still leaves the binding unbound.
          try {
            await deleteWorkspace(baseUrl, { workspaceId: workspace.workspaceId }, { fetchImpl });
          } catch (_) {
            /* the decline stands either way */
          }
          setState({
            state: BINDING_STATES.UNBOUND,
            cwd,
            workspaceId: null,
            sessionId: null,
            owned,
            error: null,
            errorCode: null,
          });
          return null;
        }
      }

      setState({
        state: BINDING_STATES.ENSURING,
        cwd,
        workspaceId: workspace.workspaceId,
        sessionId: null,
        owned,
        error: null,
        errorCode: null,
      });
      const sessionId = await ensureWorkspaceRootSession(baseUrl, workspace, cwd, fetchImpl);
      cache.set(key, { workspaceId: workspace.workspaceId, sessionId });
      setState({
        state: BINDING_STATES.BOUND,
        cwd,
        workspaceId: workspace.workspaceId,
        sessionId,
        owned,
        error: null,
        errorCode: null,
      });
      return sessionId;
    } catch (err) {
      setState({
        state: BINDING_STATES.ERROR,
        cwd,
        workspaceId: binding.workspaceId,
        sessionId: binding.sessionId,
        owned,
        error: err && err.message ? err.message : String(err),
        // The DSH API business code from the session layer
        // (DSH_SESSION_API_BUSINESS_ERROR carries it), e.g.
        // `workspace/invalid-path` — the machine-readable cause the status
        // page turns into actionable guidance.
        errorCode: err && typeof err.businessCode === "string" && err.businessCode.length > 0
          ? err.businessCode
          : null,
      });
      return null;
    }
  }

  /**
   * Queue one binding pass on the run chain. Strictly one pass executes at a
   * time; each pass reads the LATEST currentServer/currentCwd (latest-wins)
   * and settles exactly the waiters handed to it, so a resolve() that arrives
   * while a pass is in flight is served by a fresh later pass instead of
   * racing it.
   *
   * @param {boolean} forceRefresh - True to bypass the in-memory cache.
   * @param {Array<(sessionId: string|null) => void>} pending - Waiters this
   *   pass owns.
   * @returns {Promise<string|null>} The pass's bound session id.
   */
  function enqueueRun(forceRefresh, pending) {
    const promise = runChain.then(() => {
      const owned = pending.splice(0);
      return run(currentServer, currentCwd, forceRefresh).then((sessionId) => {
        for (const settle of owned) settle(sessionId);
        return sessionId;
      });
    });
    // Keep the chain alive whatever happens; run() never rejects (it maps
    // failures to the ERROR state), but a waiter-settle throw must not poison
    // later passes.
    runChain = promise.then(() => undefined, () => undefined);
    return promise;
  }

  return {
    /**
     * Resolve the DSH workspace/session binding for a server and workspace
     * root. Calls are debounced; rapid changes produce one create-or-adopt
     * probe (0.1.5 dropped `workspace.list`). Passes are serialized: a call
     * arriving while another pass runs is chained behind it (never concurrent
     * with it), so session creation and consent prompts cannot duplicate.
     *
     * @param {object} server - RunningServer handle.
     * @param {string|null|undefined} cwd - Workspace root.
     * @returns {Promise<string|null>} Bound session id or null.
     */
    resolve(server, cwd) {
      const normalizedCwd = normalizeCwd(cwd);
      currentServer = server || null;
      currentCwd = normalizedCwd;

      if (!normalizedCwd) {
        settleNull();
        setState({
          ...initialBinding(),
          owned: Boolean(server && server.owned === true),
        });
        return Promise.resolve(null);
      }

      setState({
        state: BINDING_STATES.RESOLVING,
        cwd: normalizedCwd,
        workspaceId: null,
        sessionId: null,
        owned: Boolean(server && server.owned === true),
        error: null,
        errorCode: null,
      });

      return new Promise((resolvePromise) => {
        waiters.push(resolvePromise);
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          const pending = waiters;
          waiters = [];
          enqueueRun(false, pending);
        }, debounceMs);
      });
    },

    /**
     * Force a full re-run of the binding flow, bypassing the in-memory cache.
     * Serialized with any in-flight/debounced pass; drains waiters resolved
     * so far so they settle with this refresh's outcome.
     *
     * @returns {Promise<string|null>} Bound session id or null.
     */
    refresh() {
      if (disposed) return Promise.resolve(null);
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const pending = waiters;
      waiters = [];
      return enqueueRun(true, pending);
    },

    /**
     * Pin the binding's cached session for the current workspace root (B2:
     * explicit user switches - dsh.newSession / dsh.switchSession - must
     * move the cached binding too, otherwise @dsh prompts keep targeting
     * the previously bound session).
     *
     * @param {string|null|undefined} sessionId - Session id to pin.
     * @returns {boolean} True when the cache was updated.
     */
    setActiveSession(sessionId) {
      if (disposed) return false;
      if (typeof sessionId !== "string" || sessionId.length === 0) return false;
      if (!currentCwd) return false;
      ensureCacheServer(currentServer);
      const key = cacheKey(currentCwd);
      const previous = cache.get(key);
      cache.set(key, { workspaceId: previous ? previous.workspaceId : null, sessionId });
      if (binding.cwd && cacheKey(binding.cwd) === key) {
        setState({
          state: BINDING_STATES.BOUND,
          sessionId,
          error: null,
          errorCode: null,
        });
      }
      return true;
    },

    /**
     * @returns {object} Current frozen Binding snapshot.
     */
    state() {
      return binding;
    },

    dispose() {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const pending = waiters;
      waiters = [];
      for (const resolve of pending) resolve(null);
    },
  };
}

module.exports = {
  BINDING_STATES,
  createWorkspaceBinding,
};
