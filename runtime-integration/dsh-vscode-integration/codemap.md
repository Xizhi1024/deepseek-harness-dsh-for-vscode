# dsh-vscode-integration

## Responsibility

Integration **0.11.1**, bundled with extension **1.2.2 candidate**, supplies the DSH host plugin and embedded browser client. Host files are plain ESM with no npm dependencies. Browser files register flat chunks with the upstream module loader. Exact targets: DSH `0.2.0-rc.1`, `0.2.0-rc.2`, `0.2.1-rc.1` and `0.2.1-rc.2` (adapter factory shared in `adapters/dsh020.js`); separate legacy adapter: `0.1.2-rc.1`.

Package entries remain `lib/index.js` and `lib/client.js`. The client descriptor injects the public session controller, session UI, layout, workspace and Conversation packages. `src/dshIntegration.js` synchronizes all declared files into the selected runtime profile before startup.

## Target host path

1. `lib/index.js` selects the target branch from the owned launch environment and injects public `sessionController`, `workspaceController` and `webServer`.
2. `lib/adapters/dsh020.js` (with per-version wrappers `dsh020rc1.js`/`dsh020rc2.js`) maps exact upstream public operations into workspace/session/prompt/cancel/follow capabilities. Source revision/index continuity is checked before text normalization; snapshots reconcile a newly opened stream.
3. `lib/runtimeFacade.js` mounts authenticated `/api/vscode/v1/capabilities`, `/api/vscode/v1/rpc` and session-follow SSE. It validates payloads, bounds bodies/queues, and disposes iterators on disconnect. Long feeds are not terminated by the short RPC deadline.
4. `contracts/runtime-v1.json`, `session-bridge-v1.json` and `validate.cjs` define and validate the normalized boundary. The extension host reuses this validator through `src/protocol/runtime.js`.
5. `lib/editObserver.js` captures pre-execution edit/write metadata and before-text when available; it always delegates through `next()`. Confirmed attribution comes from durable tool evidence. The observer alone cannot certify completion.

The target branch does not mount `compatSessionRoutes.js` or patch private upstream openPath methods. Text prompt queue/steer semantics and session cancellation are explicit. Non-text file/image upload is not implemented as a guessed URI mapping.

## Browser chunks

| File | Responsibility |
|---|---|
| `lib/client.js` | Entry, embedded-mode gate, clipboard/link/theme behavior and conditional target/legacy setup |
| `lib/client.dsh020.js` | Exact public DSH browser-service adapter (target-line shared; identity injected by the loader): observe/navigate target and capture/commit insertion into the main Conversation |
| `lib/client.sessionBridge.js` | Versioned browser request handling, target publication, cancellation, ticket bounds and disposal |

The two helper chunks are flat siblings loaded with `require.async` through `window.__ModuleLoader__`. They are packaging/synchronization allowlist members; they are not nested browser ESM imports.

The shell supplies surface identity and checks message origin. Surface epoch and selection generation protect navigation and asynchronous attachment work. Expanded internal rightbar explicitly refuses insertion; collapse it to use the main Conversation. A07 remains partial because no reliable public source identifies every composer.

Target initialization leaves React-owned search/composer/message DOM intact and does not install the legacy linkify observer. Native DSH rendering and streaming remain authoritative. Legacy follow/current polling and guarded linkify stay confined to the legacy branch.

## Other host responsibilities

- `lib/tools.js`: authenticated CH1 TCP tool bridge, method negotiation, request deadlines, reconnect backoff and generation swap.
- `lib/index.js`: heartbeat watchdog, owned-window liveness, effect-scoped route/bridge cleanup. `closePolicy=never` disables the owner watchdog.
- `lib/linkRoutes.js`: authenticated editor-open bridge with link payload validation and a custom-header browser guard.
- `lib/lmRoute.js`, `lib/fimRoutes.js`: optional LM/FIM routes; presence or configuration does not certify the target optional-feature matrix.
- `lib/compatSessionRoutes.js`: legacy-only REST translation for `/api/session.*`, `/api/events.mux` and `/api/workspace.*`; workspace baseline iterators are explicitly released.

## Environment and data scope

Target private launch values include `DSH_VSCODE_API_TOKEN`, `DSH_VSCODE_RUNTIME_INSTANCE_ID` and `DSH_VSCODE_RUNTIME_VERSION`. Existing CH1, textDocumentBridge and watchdog variables remain separate. Tokens are transport-private and absent from public runtime identities.

Target profiles add `-dsh020rc1`/`-dsh020rc2`, separating plugin/patch configuration. Home-level sessions and credentials are still shared when processes use the same home. Only the extension-owned child is stopped by its lifecycle.

## Validation

- Host `node:test`, integration tests, schema fixtures and packaging/sync allowlist checks.
- Real runtime/browser evidence includes 60 search cycles at three widths plus IME, prompt/cancel/read/write/edit, 601-second steady-state and ten start/stop cycles.
- Installed-VSIX validation is ongoing; A07 partial, non-text upload/FIM/full optional matrix unverified. No Marketplace publication or daily installation is implied.
- [Architecture contracts](../../PLAN-1.2.0-ARCHITECTURE-CONTRACTS.md), [host mapping evidence](../../HANDOFF-1.2.0-HOST-CONTRACTS.md), [final validation](../../HANDOFF-1.2.0-VALIDATION.md).

Sprint 1 (2026-10-17): exact RC window and source/package hashes are in `evidence/sprint1/release-window.json`; API declaration diffs and real runtime probes are in `evidence/sprint1/`. Installation/UI results are reported separately from runtime contract probes.
