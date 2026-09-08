# src/context/

## Responsibility

**Service Layer / Application Service** for workspace-to-session binding. The single source module here ('workspaceBinding.js') implements the "SM-2" workspace binding: it maps a VS Code workspace root (cwd) to a DSH workspace registry entry (WorkspaceView) plus one root session, replacing the older "cwd == workspace" model that killed/restarted the DSH child on every workspace change. It owns an explicit binding state machine, an in-memory cwd to (workspaceId, sessionId) cache, debounced resolve calls, and a consent gate for creating workspaces on servers the extension does not own. Plain Node.js CommonJS (no TypeScript build); VS Code API access is injected via a 'vscode' facade object, making the module unit-testable outside the host.

## Design Patterns

- **Factory / Module Facade**: createWorkspaceBinding(options) constructs and returns { resolve, refresh, setActiveSession, state, dispose }; module.exports = { BINDING_STATES, createWorkspaceBinding }.
- **Finite State Machine**: BINDING_STATES (frozen enum-like record): UNBOUND -> RESOLVING -> MATCHING -> (CONSENT -> CREATING | CREATING) -> ENSURING -> BOUND, with VERIFYING also defined and ERROR as the failure terminal. Every transition goes through setState(patch), which produces a new frozen immutable snapshot via Object.freeze({ ...binding, ...patch, at: Date.now() }).
- **Observer**: options.onChange(binding) is invoked after every state change; listener exceptions are swallowed so they can never break the state machine.
- **Strategy / Dependency Injection**: baseUrlProvider, requestConsent, fetchImpl, and the vscode facade are injected; defaultRequestConsent (modal showWarningMessage with a "创建并绑定" action) is the fallback consent strategy.
- **Debounce + Promise multiplexing**: resolve() pushes resolve callbacks into a waiters array and (re)arms a single setTimeout(debounceMs=250); one run() pass settles all queued waiters.
- **Cache-Aside (read-through) memoization**: Map<cacheKey, {workspaceId, sessionId}>; resolve reads the cache first, run populates it after a successful bind, refresh() bypasses it (force=true), setActiveSession pins user-driven session switches into it.
- Key abstractions: initialBinding() (frozen Binding snapshot {state, cwd, workspaceId, sessionId, owned, error, at}), ensureWorkspaceRootSession() (B2 "freshest root session" sticky rule), sameResolvedPath() / cacheKey() (platform-aware, case-insensitive-on-Windows path identity).

## Data & Control Flow

Inbound: the host (src/extension.js) calls resolve(server, cwd) whenever the DSH server handle or the active workspace root changes.

1. resolve normalizes cwd; null/empty cwd -> settleNull() + reset to initialBinding() (keeping owned) and resolve null.
2. State set to RESOLVING; the caller's promise is queued in waiters; a debounce timer (default 250 ms) coalesces rapid calls into a single run(currentServer, currentCwd, false).
3. run: cache hit (and not forced) -> BOUND with cached ids, return sessionId. No base URL (baseUrlProvider() or server.url) -> ERROR ("DSH workspace API unavailable: no base URL"), return null.
4. MATCHING: listWorkspaces(baseUrl) then findWorkspaceByPath(items, cwd, process.platform).
5. No match: if server.owned -> CREATING + createWorkspace(baseUrl, cwd). If not owned -> CONSENT -> requestConsentFor(cwd) (custom or default modal); decline -> back to UNBOUND, return null; accept -> CREATING + create.
6. ENSURING: ensureWorkspaceRootSession(baseUrl, workspace, cwd) — lists sessions (sorted by updatedAt desc), returns the first session that has origin !== 'subagent', no parentSessionId, and is either in workspace.sessionIds or has a same-cwd (sameResolvedPath); otherwise createSession(baseUrl, { workspaceId }). This "freshest root session" rule (B2) prevents session explosion on reload/rebind while still honoring explicit "New Session" switches.
7. Success: cache.set(key, {workspaceId, sessionId}), state BOUND, resolve waiters with sessionId. Any throw -> ERROR preserving previous workspaceId/sessionId, resolve null.
8. refresh() cancels the timer, settles queued waiters via a forced run(..., true) (bypasses cache).
9. setActiveSession(sessionId) pins an explicit user switch (dsh.newSession / dsh.switchSession, or the sessionChanged reverse-notify chain) into the cache and re-emits BOUND when it matches the current binding cwd.
10. dispose() sets the disposed flag, clears the timer, and settles all waiters with null; all subsequent calls are no-ops.

Outbound data: the resolved sessionId flows to the caller; every state snapshot flows to the onChange observer (UI wiring in extension.js); HTTP side effects (workspace/session creation) hit the DSH loopback API via the injected fetchImpl.

## Integration Points

Dependencies (imports):
- node:path (resolve, platform-aware cache keys)
- ../sessionNavigation -> listSessions, createSession
- ../ch2/workspaceClient -> listWorkspaces, createWorkspace, findWorkspaceByPath
- Injected: vscode facade (vscode.window.showWarningMessage for the default modal consent), baseUrlProvider, requestConsent, fetchImpl, onChange.

Consumers:
- src/extension.js (line 86): imports createWorkspaceBinding + BINDING_STATES; drives resolve/refresh, calls workspaceBinding.setActiveSession(...) on session switches (lines 164, 2617, 2662), and branches UI on BINDING_STATES.ERROR (lines 839, 996, 1152).
- test/unit/workspaceBinding.test.js: unit-tests the full state machine including cache pinning.
- scripts/smoke-runtime.js and scripts/check-package-contents.js: runtime smoke test + packaging allowlist.
- Related commands/events named in code/comments: dsh.newSession, dsh.switchSession, and the shell -> extension dshSessionChanged / sessionChanged reverse-notification chain.

## Files

- workspaceBinding.js (~481 lines) — Factory createWorkspaceBinding implementing the SM-2 cwd -> DSH workspace + root-session binding FSM with debounce, cache-aside, consent gate, and BINDING_STATES; the only source file directly in this folder.
- codemap.md — this document.
