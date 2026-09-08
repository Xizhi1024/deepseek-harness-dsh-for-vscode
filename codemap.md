# Repository Atlas: dsh-vs-sidebar (DeepSeek Harness for VS Code)

## Project Responsibility

A zero-npm-dependency, plain CommonJS VS Code extension (desktop-only, VS Code ≥ 1.106) that embeds the full DSH web UI in the auxiliary sidebar. Every window starts and owns a local `dsh web` child process (cwd = current workspace, dedicated profile), and the extension adds the IDE integration layer on top: webview embedding with loopback authentication, context/thread attachments, the DSH Changes review tree (approval-gated writes), the `@dsh` chat participant, LM routing, MCP consumption, terminal/editor/UI bridges, and FIM tab completion (POC) — advanced features behind explicit consent switches.

## System Entry Points

- `src/extension.js` (~3100 lines): composition root — activation, config, runtime resolution, server lifecycle, webview, commands, bridge wiring, feature registration (`package.json` main).
- `package.json`: manifest — commands, views (`dsh.webview`, `dsh.changes`), `dsh.*` configuration, activation events, l10n.
- `runtime-integration/dsh-vscode-integration/`: DSH-side client plugin synced into the runtime profile at activation (`src/dshIntegration.js`).

## Architecture Overview

1. **Runtime provisioning & process lifecycle** (src root: runtimeProvisioner → runtimeResolver/Downloader/Installer/Artifact/Archive, localRuntimeResolver, shimResolver, launchMethodResolver, managedRuntimeLaunch, serverManager, processDiscovery, dshHome, profileScaffold, embedOverlay, hmrGuard): resolve → download/verify → install → spawn → health-check → teardown a managed DSH child.
2. **Loopback bridge layer** (versionedBridgeServer CH1 v1–v3, bridge/v3 handlers, textDocumentBridge, webEmbedProxy, loopbackAuth, ch1/notifier): newline-delimited JSON-RPC server exposing consent-gated VS Code APIs to the DSH child; HTTP/WS proxy authenticating the embedded iframe.
3. **Webview layer** (webviewHtml, webviewMessages, interactionBridge, threadAttachment, protocol/webview): CSP-hardened iframe host, message routing, attachment coordinator.
4. **Session/chat domain** (sessionNavigation, dshChatClient, ch2/workspaceClient, context/workspaceBinding, chatParticipant, sessionTitler, exportsFace, lmRoute, inlineCompletion): loopback JSON-RPC + SSE clients powering the sidebar, `@dsh`, programmatic API face, LM provider, FIM.
5. **Change review** (changeTracker, changeTree, changeWatcher, editEventProjector): journal-based review of DSH-pushed edits with accept/undo.
6. **Cross-cutting** (featureRegistry L0–L2, lifecycle, startupGate, startupErrors, vscodeFacade, vscodeCapabilities, dshCompat, capabilityCatalog, providerDetector, detection/, diagnose/, onboarding, commands/, mcp/, catalog/, adapters/).

Stylistic contract: DI factories (`createXxx({...deps})`) with injected vscode facade/fetch/timers/fs; frozen value objects; fail-closed timeouts; zero npm deps; tests via `node:test` (`npm run check:w0`).

## Directory Map (Aggregated)

| Directory | Responsibility Summary | Detailed Map |
|-----------|------------------------|--------------|
| `src/` | Composition root, runtime provisioning pipeline, bridge/webview/session/change domain services (52 root files). | [View Map](src/codemap.md) |
| `src/adapters/` | 0.6 capability adapter contract: AdapterState enum, CapabilityAdapter base, Null Object. | [View Map](src/adapters/codemap.md) |
| `src/bridge/` | v3 bridge handler factory: consent/feature-gated vscode/* RPC handlers over injected facade. | [View Map](src/bridge/codemap.md) |
| `src/catalog/` | Frozen plugin catalog registry + fail-fast schema validator (SHA-256 revision). | [View Map](src/catalog/codemap.md) |
| `src/ch1/` | CH1 v2 notification coalescer (debounced, last-write-wins, bounded). | [View Map](src/ch1/codemap.md) |
| `src/ch2/` | DSH workspace registry JSON-RPC client (list/create workspaces, path matching). | [View Map](src/ch2/codemap.md) |
| `src/commands/` | DI command-body factory layer (thread attach, cleanup, Ctrl+K/I edits, shell). | [View Map](src/commands/codemap.md) |
| `src/context/` | Workspace binding FSM service (cwd → workspace/session, consent, cache-aside). | [View Map](src/context/codemap.md) |
| `src/detection/` | Plugin/profile probe-based detection with memoization and evidence state machine. | [View Map](src/detection/codemap.md) |
| `src/diagnose/` | Sectioned diagnostics report builder + QuickPick presentation (pure DI). | [View Map](src/diagnose/codemap.md) |
| `src/mcp/` | MCP consume-side service: config merge, consent gate, stdio/HTTP transports, lazy client. | [View Map](src/mcp/codemap.md) |
| `src/protocol/` | Frozen protocol contracts: webview envelope (channels/versions/types) + CH1 versioned method/notification tables with validators. | [View Map](src/protocol/codemap.md) |
| `runtime-integration/` | Vendored side-packages synced into the DSH home at activation. | [View Map](runtime-integration/codemap.md) |
| `runtime-integration/dsh-vscode-integration/` | DSH-side client plugin (lib/: client bridge, tools, editObserver, route plugins) restoring IDE integration inside the child. | [View Map](runtime-integration/dsh-vscode-integration/codemap.md) |

## Key External Contracts

- DSH web API: /api/session.*, /api/events.mux (SSE), /api/fim, /api/lm/*, /api/remote.mux (WS).
- Spawn env: DSH_VSCODE_BRIDGE_HOST/PORT/TOKEN/PROTOCOL, DSH_VSCODE_OPEN_URL/TOKEN, heartbeat/watchdog env, DSH_HOME, DSH_TEXT_EDITOR.
- VS Code: webview `dsh.webview`, TreeView `dsh.changes`, chat participant `@dsh`, `vscode.lm` provider, built-in vscode.git, SecretStorage/globalStorage/l10n.

## Known Constraints / Roadmap

- See KNOWN_ISSUES.md and USABILITY-AUDIT.md (P0–P2 items).
- Roadmap (README): unify runtime boundary management around one runtime identity (home/profile selection, version negotiation, child ownership, port discovery, startup URL/token, health checks) across prepare → spawn → authenticated readiness → teardown; expect internal breaking changes with compatible user behavior.
