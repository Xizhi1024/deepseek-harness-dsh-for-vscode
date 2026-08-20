# B1 Implementation Notes — Workspace Binding (SM-2)

Branch: `feature/0.6-b1-workspace-binding`
Base: `e766ad7`

## Objective

Replace the extension's old "cwd == workspace" parallel model with the DSH
workspace registry (`workspace.list` / `workspace.create`) and make workspace
switches reuse the running DSH child instead of killing/restarting it.

## Changed / Added Files

- `src/ch2/workspaceClient.js` — new DSH workspace registry JSON-RPC client.
- `src/context/workspaceBinding.js` — new SM-2 binding state machine.
- `src/sessionNavigation.js` — exported internal transport helpers for reuse;
  `createSession` now accepts `workspaceId` and uses `{ workspaceId }` payload
  (workspaceId takes precedence over cwd).
- `src/extension.js` — bindServer/rebindToWorkspace wiring, diagnose binding
  state, retained `ensureWorkspaceSessionFn` seam defaulting to binding.
- `src/providerDetector.js` — `diagnosticSnapshot` includes `binding`.
- `test/extension.test.js` — updated auto-bind/reused tests, added rebind
  no-kill and binding-error UI tests.
- `test/sessionNavigation.test.js` — added `session.create` workspaceId test.
- `test/unit/workspaceClient.test.js` — new workspace client tests.
- `test/unit/workspaceBinding.test.js` — new six-grid binding tests, debounce,
  cache/refresh, API failure.

## Interfaces

### `src/ch2/workspaceClient.js`

```js
listWorkspaces(baseUrl, { signal, fetchImpl }?)
  -> Promise<Array<{ workspaceId, path, title?, sessionIds, createdAt?, updatedAt? }>>
createWorkspace(baseUrl, path, { signal, fetchImpl }?)
  -> Promise<{ workspace: WorkspaceView, created: boolean }>
findWorkspaceByPath(items, fsPath, platform = process.platform)
  -> WorkspaceView | null
```

Reuses `assertLoopbackBaseUrl`, `clientRequest`, `postJson`, `readJsonBody`,
`assertServerResponse`, and `resolveFetchImpl` from `sessionNavigation.js`.

### `src/context/workspaceBinding.js`

```js
BINDING_STATES = Object.freeze({
  UNBOUND: 'unbound', RESOLVING: 'resolving', MATCHING: 'matching',
  CONSENT: 'consent', CREATING: 'creating', ENSURING: 'ensuring',
  BOUND: 'bound', VERIFYING: 'verifying', ERROR: 'error',
})

Binding = {
  state: string,
  cwd: string | null,
  workspaceId: string | null,
  sessionId: string | null,
  owned: boolean,
  error: string | null,
  at: number,
}

createWorkspaceBinding({
  vscode,
  baseUrlProvider?,
  requestConsent?,
  debounceMs = 250,
  onChange?,
  fetchImpl?,   // test seam, defaults to global fetch
}) -> {
  resolve(server, cwd) -> Promise<string | null>,
  refresh() -> Promise<string | null>,
  dispose(),
  state() -> Binding,
}
```

## Behavior

- `resolve(server, cwd)` debounces to one `workspace.list`; null cwd -> UNBOUND.
- Existing workspace path match -> reuse `workspace.sessionIds` blank root
  session, or `session.create({ workspaceId })`.
- Missing workspace + owned server -> auto `workspace.create`.
- Missing workspace + reused server -> `requestConsent` (default modal
  `创建并绑定`); decline -> UNBOUND, approve -> create.
- Any API failure -> state `ERROR` with message; `resolve` returns null so the
  UI can render an error status page and never keep a stale iframe session.
- In-memory `Map<normalizedPath, { workspaceId, sessionId }>` caches bindings;
  `refresh()` bypasses the cache and re-runs `workspace.list`.

## Extension Wiring

- `bindServer`: old owned-only `ensureWorkspaceSessionFn` branch removed; now
  always calls `workspaceBinding.resolve(server, cwd)` when a cwd exists and
  uses the returned sessionId for the iframe.
- `rebindToWorkspace`: no longer calls `stopOwnedServer()`; clears attachments,
  rebinds through the registry, and only falls back to `connectNow()` when
  there is no server handle or the owned child no longer exists.
- `dsh.diagnose`: `diagnosticSnapshot` now carries `binding: workspaceBinding.state()`.

## Test Results

- `npm test`: 165 tests / 164 pass / 1 skip / 0 fail.
- `npm run lint`: passed (64 JS + 6 JSON).

## Unresolved Risks / Notes

- The DSH workspace registry API shapes (`WorkspaceView`, `workspace.create`
  response) are implemented from the task card; no local DSH server source was
  available in this lane to cross-check the exact JSON field names beyond the
  stated contract.
- `workspaceBinding.resolve` does not accept an abort signal; the old
  `ensureWorkspaceSessionFn` seam is retained for compatibility but the default
  wrapper intentionally routes to the binding (which owns its own debounce).
- If a cached workspace/session is deleted outside the extension, the cache is
  only corrected by `refresh()` (or a new resolve after a workspace change).
- Workspace switch "process pid unchanged" is covered by extension-level fake
  integration tests; real F5 multi-root manual acceptance remains for the
  orchestrator/user.
