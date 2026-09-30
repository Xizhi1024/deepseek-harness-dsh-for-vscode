# src/

## Responsibility

The CommonJS extension host for 1.2.1 candidate: `extension.js` assembles exact runtime selection, shared session services, webview surfaces, commands and optional features. No npm runtime dependencies. Target DSH is exactly `0.2.0-rc.1` or `0.2.0-rc.2` (descriptor table in `runtime/compatibility.js`); legacy `0.1.2-rc.1` remains a separate path.

## Runtime modules

| Module | Responsibility |
|---|---|
| `runtime/identity.js` | Verify package manifest and construct immutable identity: version, adapter, executable/entrypoint/package root, home/profile, integration version |
| `runtime/compatibility.js` | Exact adapter policy; verify the selected child Node satisfies `^22.19.0 \|\| >=24.0.0`; check capability identity |
| `runtime/supervisor.js` | Serialize ensure/stop/restart, prepare before spawn, hold private credentials, authenticate readiness, respect ownership and current close policy |
| `runtime/client.js` | Authenticated facade RPC and bounded SSE with startup-cookie transport; unknown mutation outcomes are not automatically retried |
| Resolver/provisioner modules | Discover or obtain the selected package and executable; verify artifacts |
| `serverManager.js` | Low-level process, port, health, ownership and registry operations |
| `dshHome.js`, `profileScaffold.js`, `embedOverlay.js`, `dshIntegration.js`, `hmrGuard.js` | Home/profile selection, donor scaffolding, overlay, content-aware integration sync and HMR guard |

Target profiles use `-dsh020rc1`/`-dsh020rc2`; sessions/credentials remain shared for processes on the same home. Unknown external runtimes can be displayed browser-only and cannot receive session mutations.

## Session modules

| Module | Responsibility |
|---|---|
| `session/feedHub.js` | Share one transport per runtime/session, seed subscribers atomically with current baseline, bound state/retries and release on the last consumer |
| `session/transcript.js` | Reduce snapshots, durable records and temporary assistant attempts; enforce continuity and reconciliation |
| `session/coordinator.js` | Bound operations by deadline, verify workspace membership, reject stale navigation and bind attachment capture/prepare/commit to the selected target |
| `session/browserProxy.js` | Host end of versioned browser protocol; handshake, result validation, visible-target mirror and pending request disposal |
| `sessionNavigation.js`, `ch2/workspaceClient.js` | Existing public wrapper signatures with injected target RuntimeApi; legacy REST only for the legacy path |
| `dshChatClient.js` | Target prompt/cancel through RuntimeApi and stream observation through shared FeedHub; legacy transport retained separately |
| `chatParticipant.js`, `exportsFace.js` | VS Code Chat/programmatic consumers; target progress and committed assistant text avoid duplicate abandoned attempts |
| `context/workspaceBinding.js`, `workspaceContext.js` | Legacy workspace binding and stable focus/root identity |
| `protocol/runtime.js` | Re-export integration `contracts/validate.cjs`; no second host schema definition |

## Target startup and surface flow

1. Resolve the exact package, child executable and home. Derive the target profile and identity.
2. Supervisor verifies Node, prepares/synchronizes integration, starts the owned child and checks the private capability handshake.
3. Composition root installs one runtime client, FeedHub and coordinator. Workspace focus ensures workspace identity without automatically creating a session.
4. `webviewHtml.js` paints a shell with surface identity; the browser handshake creates a proxy/coordinator registration. Repeated ensure preserves a live iframe. Restart rebinds surviving panels to the current endpoint with fresh epochs.
5. New/Switch waits for confirmed browser navigation before updating the visible target. Attachments capture the target before asynchronous preparation, then verify the insertion ticket at commit.
6. Surface release aborts pending operations/tickets. Runtime release detaches the edit projector and shared feeds; shutdown stops only owned processes according to policy.

The target iframe uses flat integration client chunks and public DSH UI services. It does not derive conversation identity by editing DOM. Only the main Conversation accepts attachments; an expanded DSH internal right sidebar produces an explicit refusal.

## Changes and bridges

- `editEventProjector.js`: subscribe to the shared feed, accept confirmed durable tool evidence, retain bounded pre-execution candidates, join snapshots only through reliable tool-call identity.
- `changeTracker.js`: persist stable observation deduplication and accurate before-text. Unattributed filesystem events stay external.
- `changeTree.js`: diff/accept/undo; prefer the recorded before snapshot over a Git fallback. Native tool edits are observed after execution.
- `changeWatcher.js`: preserve 1.1.8 excluded-path filtering, bounded event queues and Git overload recovery.
- `versionedBridgeServer.js`, `bridge/v3.js`, `ch1/notifier.js`: authenticated CH1 protocol, consent-gated methods and coalesced notifications.
- `loopbackAuth.js`, `webEmbedProxy.js`: owned startup-cookie exchange and HTTP/SSE/WebSocket embedding.
- `textDocumentBridge.js`, `interactionBridge.js`, `editorContext.js`, `threadAttachment.js`: editor operations and attachment/link payloads.
- `lifecycle.js`, `startupGate.js`: lifecycle serialization, coalescing and retry cooldown.
- `featureRegistry.js`, `vscodeFacade.js`, `vscodeCapabilities.js`: injected feature assembly and host capabilities.
- `lmRoute.js`, `inlineCompletion.js`, `mcp/`, `commands/`, `catalog/`, `detection/`, `diagnose/`: optional features, registries and diagnostics; availability must not be inferred from version alone.

## Wire boundaries and verification

Target: `/api/vscode/v1/capabilities`, `/api/vscode/v1/rpc`, session-follow SSE; shared schemas live in the integration package's `contracts/`. Legacy: `/api/session.*`, `/api/events.mux`, `/api/workspace.*`. CH1 and browser protocols retain separate channel identities.

Use `node:test` with injected facade/fetch/timers and `npm run check:w0`. [Host mapping](../HANDOFF-1.2.0-HOST-CONTRACTS.md) explains stream normalization and tool evidence. [Final validation](../HANDOFF-1.2.0-VALIDATION.md) records candidate acceptance: installed-state testing is ongoing, A07 partial, non-text prompt upload/FIM/full optional matrix unverified.
