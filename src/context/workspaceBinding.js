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
 */

const { listSessions, createSession } = require("../sessionNavigation");
const {
  listWorkspaces,
  createWorkspace,
  findWorkspaceByPath,
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
 *   Called when a non-owned server has no workspace for `cwd`. Defaults to a
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
        state: BINDING_STATES.MATCHING,
        cwd,
        workspaceId: null,
        sessionId: null,
        owned,
        error: null,
      });
      const items = await listWorkspaces(baseUrl, { fetchImpl });
      let workspace = findWorkspaceByPath(items, cwd, process.platform);

      if (!workspace) {
        if (owned) {
          setState({
            state: BINDING_STATES.CREATING,
            cwd,
            workspaceId: null,
            sessionId: null,
            owned,
            error: null,
          });
          const created = await createWorkspace(baseUrl, cwd, { fetchImpl });
          workspace = created.workspace;
        } else {
          setState({
            state: BINDING_STATES.CONSENT,
            cwd,
            workspaceId: null,
            sessionId: null,
            owned,
            error: null,
          });
          const allowed = await requestConsentFor(cwd);
          if (!allowed) {
            setState({
              state: BINDING_STATES.UNBOUND,
              cwd,
              workspaceId: null,
              sessionId: null,
              owned,
              error: null,
            });
            return null;
          }
          setState({
            state: BINDING_STATES.CREATING,
            cwd,
            workspaceId: null,
            sessionId: null,
            owned,
            error: null,
          });
          const created = await createWorkspace(baseUrl, cwd, { fetchImpl });
          workspace = created.workspace;
        }
      }

      setState({
        state: BINDING_STATES.ENSURING,
        cwd,
        workspaceId: workspace.workspaceId,
        sessionId: null,
        owned,
        error: null,
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
      });
      return null;
    }
  }

  return {
    /**
     * Resolve the DSH workspace/session binding for a server and workspace
     * root. Calls are debounced; rapid changes produce one workspace.list pass.
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
      });

      return new Promise((resolvePromise) => {
        waiters.push(resolvePromise);
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          const pending = waiters;
          waiters = [];
          run(currentServer, currentCwd, false).then((sessionId) => {
            for (const resolve of pending) resolve(sessionId);
          });
        }, debounceMs);
      });
    },

    /**
     * Force a full re-run of the binding flow, bypassing the in-memory cache.
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
      const promise = run(currentServer, currentCwd, true);
      promise.then((sessionId) => {
        for (const resolve of pending) resolve(sessionId);
      });
      return promise;
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
      const key = cacheKey(currentCwd);
      const previous = cache.get(key);
      cache.set(key, { workspaceId: previous ? previous.workspaceId : null, sessionId });
      if (binding.cwd && cacheKey(binding.cwd) === key) {
        setState({
          state: BINDING_STATES.BOUND,
          sessionId,
          error: null,
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
