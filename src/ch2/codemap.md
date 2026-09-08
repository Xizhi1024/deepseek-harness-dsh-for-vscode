# src/ch2/

## Responsibility

`src/ch2` implements the DSH workspace registry client ("CH2") for the dsh-vs-sidebar extension. It is a single plain-Node CommonJS module (`workspaceClient.js`) that talks to the DSH Web API's `workspace.list` and `workspace.create` JSON-RPC endpoints over loopback HTTP, validates every response field, and provides path-based lookup helpers so the sidebar can map the currently open VS Code folder to a registered DSH workspace (and register it on demand).

## Design Patterns

- **Thin client / facade over shared transport**: rather than duplicating HTTP code, the module reuses `DshSessionError`, `assertLoopbackBaseUrl`, `clientRequest`, `postJson`, `readJsonBody`, `assertServerResponse`, and `resolveFetchImpl` from `../sessionNavigation`, so both clients share one transport and one response contract.
- **Fail-fast validation (design-by-contract)**: `assertWorkspaceItem` throws `DshSessionError` with `DSH_SESSION_API_INVALID_RESPONSE` codes for any missing or mistyped field (`workspaceId`, `path`, `sessionIds` and its entries, `result.value.items`, `result.value.created`).
- **Dependency injection**: every async function accepts `options.fetchImpl` (defaulting to `globalThis.fetch` via `resolveFetchImpl`) and `options.signal` (AbortSignal), keeping the module testable and cancellable.
- **Immutability at the boundary**: `listWorkspaces` returns a fresh array from `value.items.map(...)`; callers never touch the parsed server payload directly.
- **Platform-aware normalization**: `normalizeWorkspacePath` resolves paths with `path.resolve` and lower-cases on `win32` for case-insensitive matching in `findWorkspaceByPath`.
- **CommonJS module with explicit exports**: `module.exports` exposes only `listWorkspaces`, `createWorkspace`, `findWorkspaceByPath`, `normalizeWorkspacePath`.

## Data & Control Flow

1. Caller supplies a loopback base URL (`http://127.0.0.1:<port>` / `http://localhost:<port>`); `assertLoopbackBaseUrl` validates and parses it (guarding against non-loopback targets).
2. `resolveFetchImpl(options)` picks the fetch implementation; `clientRequest("workspace.list", {})` or `clientRequest("workspace.create", { path })` builds the JSON-RPC request body.
3. `postJson(parsed, API_PATH, body, fetchImpl, signal)` issues the POST to `/api/workspace.list` or `/api/workspace.create`; `readJsonBody(response)` decodes the JSON; `assertServerResponse(body)` checks the JSON-RPC envelope and returns `result`.
4. Response validation: `workspace.list` requires `result.value.items` to be an array and validates each item through `assertWorkspaceItem` (non-empty `workspaceId` string, `path` string, `sessionIds` array of strings); `workspace.create` requires `result.value.workspace` to pass the same item check plus a boolean `created` flag, returning `{ workspace, created }`.
5. Lookup path: UI code (or tests) passes the item list plus an absolute filesystem path to `findWorkspaceByPath`, which normalizes both sides (`path.resolve`, lowercased on win32) and returns the first matching item or `null`.

Any validation or transport failure surfaces as a `DshSessionError` (`DSH_SESSION_API_*` error codes), never a raw TypeError.

## Integration Points

- **DSH Web API (loopback HTTP JSON-RPC)**: `POST /api/workspace.list` and `POST /api/workspace.create` — the DSH workspace registry server.
- **`../sessionNavigation` module**: imports `DshSessionError`, `assertLoopbackBaseUrl`, `clientRequest`, `postJson`, `readJsonBody`, `assertServerResponse`, `resolveFetchImpl` — the shared transport/error layer for the CH1/CH2 clients.
- **Node built-ins**: `node:path` (`path.resolve` for normalization); `process.platform` as the default platform argument in `findWorkspaceByPath`.
- **Consumers (sidebar/extension code and tests)**: injected `fetchImpl`/`signal` options; returned workspace items feed workspace matching for the currently open VS Code folder.

## Files

- `workspaceClient.js` (~187 lines): Workspace registry JSON-RPC client — `listWorkspaces` / `createWorkspace` with strict response validation, plus `findWorkspaceByPath` / `normalizeWorkspacePath` helpers for matching a local folder to a registered DSH workspace.
- `codemap.md` (this file): This codemap document.
