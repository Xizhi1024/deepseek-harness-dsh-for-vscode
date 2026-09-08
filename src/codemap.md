# src/

## Responsibility

This is the root Service Layer / Composition Root of the DSH VS Code sidebar extension (plain CommonJS, no build step). It contains:

- **Composition root & wiring**: `extension.js` (activation/deactivation, command registration, feature assembly) plus `featureRegistry.js` (layered L0→L1→L2 feature bootstrap with fault isolation), `lifecycle.js` (serialized lifecycle queue), and `startupGate.js` (retry cooldown).
- **Runtime provisioning & process management**: a pipeline that resolves, downloads, verifies, installs, and launches a managed DSH runtime (`runtimeProvisioner`, `runtimeResolver`, `runtimeInstaller`, `runtimeDownloader`, `runtimeArchive`, `runtimeArtifact`, `localRuntimeResolver`, `launchMethodResolver`, `shimResolver`, `processDiscovery`, `serverManager`, `managedRuntimeLaunch`, `workspaceContext`).
- **Bridge infrastructure (Adapter layer)**: loopback JSON-RPC servers exposing VS Code APIs to the DSH child (`versionedBridgeServer` CH1 protocol, `textDocumentBridge`, `webEmbedProxy`, `loopbackAuth`) and webview-side message routing (`interactionBridge`, `threadAttachment`, `webviewMessages`, `webviewHtml`).
- **Domain services**: change tracking/review (`changeTracker`, `changeTree`, `changeWatcher`, `editEventProjector`), session/chat clients over the DSH web API (`sessionNavigation`, `dshChatClient`), editor context & attachments (`editorContext`), chat participant (`chatParticipant`), LM provider route (`lmRoute`), inline FIM completions (`inlineCompletion`), exported programmatic API face (`exportsFace`).
- **Supporting policies/utilities**: capability catalog & provider detection (`capabilityCatalog`, `providerDetector`, `vscodeCapabilities`, `dshCompat`), DSH home/profile management (`dshHome`, `profileScaffold`, `embedOverlay`, `hmrGuard`, `dshIntegration`), onboarding wizard (`onboarding`), startup-error taxonomy (`startupErrors`), shared constants (`types.js`), VS Code facade (`vscodeFacade`), session titling (`sessionTitler`), journaling (`callExportJournal`), workspace identity (`bridgeWorkspace`).

Subfolders (`commands/`, `protocol/`, `ch1/`, `catalog/`, `detection/`, `diagnose/`) have their own mappers.

## Design Patterns

- **Dependency Injection / Pure Core + Assembly (asm) layer**: nearly every module is a `createXxx({...deps})` factory taking an injected `vscode` facade, fetch, timers, and fs seams so `node:test` can drive them without a real host (`chatParticipant`, `exportsFace`, `inlineCompletion`, `changeWatcher`, `onboarding`, `lmRoute`, `dshChatClient`...). `vscodeFacade.js` formalizes the VS Code API boundary.
- **Facade**: `createVscodeFacade` freezes the consumed VS Code surface; `workspaceContext.config()` normalizes `dsh.*` settings into one plain object.
- **Factory + Frozen Value Objects**: all resolvers/provisioners return `Object.freeze(...)` runtime descriptors (`{executablePath, entrypointArgs, dshHome, profileHome, profileName, source, dshVersion}`) shared across `runtimeResolver`, `localRuntimeResolver`, `launchMethodResolver`, `managedRuntimeLaunch.normalizeResolvedRuntime`.
- **Strategy / Chain of Resolvers**: launch method selection (`auto|managed|command` in `launchMethodResolver`) picks between managed-runtime resolution (`runtimeResolver`), local npm-package discovery (`localRuntimeResolver` + `shimResolver` PATH/shim scanning), and command-path resolution. Version managers (nvm/fnm/asdf/volta/scoop) are enumerated as candidate lists.
- **Observer / Event-driven**: `featureRegistry` (`onFeatureFailure`), `ServerManager.onStatus` lifecycle callbacks, hand-rolled VS Code-style events (`changeTree.createTreeEvent` with `fire`/`dispose`), SSE event streams (`dshChatClient.streamSession` → `editEventProjector`), `ThreadAttachmentCoordinator` pending-request map with timeout.
- **Singleton-ish module state**: `processDiscovery.discoverDshWebPorts._cache` (5s TTL), `inlineCompletion.fimUnavailableNotified` once-per-session flag, `sessionTitler` memoized one-shot rename set.
- **Repository / Journal (persistence)**: `changeTracker` JSON journal at `globalStorage/changes/journal.json` (atomic tmp+rename writes, id watermark from persisted entries), `callExportJournal` (`callExport/journal.json`, best-effort), runtime pointer files (`state/current.json`, `last-good.json` in `runtimeInstaller`).
- **State machine**: change entries transition `pending → accepted → undone` / `discarded` (plus legacy `applied`); bridge connections `uninitialized → initialized(protocolVersion)`; watcher mode `watching → disabled(poll) → stopped`.
- **Proxy (literal HTTP)**: `webEmbedProxy` rewrites the embedded iframe's requests onto the authenticated child (strips browser-trust headers, relays WebSocket upgrades). `textDocumentBridge` is an authenticated loopback HTTP adapter for open-in-editor.
- **Template Method / Table-driven taxonomy**: `startupErrors.STARTUP_ERRORS` maps stable codes → {retryable, template, diagnoseHint}; `dshCompat` derives capability flags from version thresholds; `vscodeCapabilities` derives host API booleans.
- **Whitelist validation (controlled catalog)**: `capabilityCatalog` validates provider entries and URI schemes at load; `runtimeArtifact` validates manifests (SHA-256, safe relative paths); `versionedBridgeServer` validates JSON-RPC frames, token (timingSafeEqual), and protocol negotiation.

## Data & Control Flow

**Startup / server acquisition** (extension.js → serverManager):
1. `activateWithDependencies` reads config via `workspaceContext` (port via `resolveDefaultPort`: DSH_VSCODE_PORT pin > isolated-storage default > 3080).
2. Runtime resolution per `dsh.launch.method`: `ensureManagedRuntime` (pointer → manifest → full hash verify; downloads release manifest from `dsh.runtime.manifestUrl` over HTTPS only, selects newest platform/arch artifact, downloads+extracts tar.gz into staging, verifies every file hash/size/exec-bit, atomically promotes, rolls back to last-good on failure) OR `resolveLocalDshRuntime` (explicit `dsh.local.packageRoot`/`dsh.executablePath` first, Windows shim parsing, then global-layout and version-manager candidates) OR `resolveCommandRuntime` (where.exe/which, shim→node+bin.js).
3. DSH home resolved (`resolveDshHome`: setting > DSH_HOME > ~/.dsh, or isolated under globalStorage) + legacy migration; profile scaffolded (`ensureProfileScaffold`), HMR guard applied, integration package synced content-awarely (`installDshIntegration`), embed overlay written.
4. `ServerManager` probes host:port for `__DSH_BOOT__`; spawns the managed runtime via `buildManagedLaunchSpec` (`--profile --host --port --no-open [--patch]`, env DSH_HOME, DSH_TEXT_EDITOR=vscode, heartbeat/watchdog env), scanning up to 50 ports forward, polling health (30s timeout); maintains a JSON instance registry for stale cleanup; reuses external instances when autoStart is off (with `processDiscovery` fallback). Startup failures classified via `startupErrors` codes; `StartupGate` throttles auto-retries.

**Bridge flow** (DSH child → VS Code): spawn env carries `DSH_VSCODE_BRIDGE_HOST/PORT/TOKEN/PROTOCOL`. `VersionedBridgeServer` (loopback TCP, newline-delimited JSON-RPC) performs `initialize` (token + protocolVersion negotiation → returns workspace identity from `bridgeWorkspace`, method/notification tables), dispatches version-gated handler maps (`providerDetector`, `editorContext`, `changeTracker` changes/push, git getStatus, callExport...) with per-request AbortController + 15s timeout, emits notifications (`vscode/dshEditObserved` → `changeTracker.recordToolEdit` with ±2s (path, sessionId) merge). `textDocumentBridge` separately serves open-document requests with its own bearer token. `webEmbedProxy` forwards the webview iframe's HTTP/WS traffic, attaching the launch-token cookie exchanged by `loopbackAuth.exchangeLaunchCookie`.

**Webview flow**: `webviewHtml.framePage/statusPage` generate CSP-hardened HTML embedding the DSH iframe (with dsh_session, dsh_theme params); `webviewMessages.createWebviewMessageHandler` routes webview→host messages (openBrowser, retry, HELLO handshake errors, BRIDGE interaction requests → `interactionBridge` clipboard/link/attachment methods, thread-attach results, dshSessionChanged relays); host→webview `DSH_THEME_CHANGED`; `ThreadAttachmentCoordinator` pushes selection/file attachments into the iframe thread with request/response correlation and timeout.

**Session/chat flow**: `sessionNavigation` (list/create/rename via JSON-RPC POST to /api/session.*, loopback-only) + `dshChatClient` (prompt via /api/session.prompt; live SSE via /api/events.mux with stall timeout, frame cap) power the sidebar session binding (`ensureWorkspaceSession` reuses blank cwd-bound sessions), the `@dsh` chat participant (`chatParticipant.handleRequest`: connect stream FIRST, await readiness, queue prompt, forward deltas in ≤8000-char markdown chunks; one-shot titling via `sessionTitler`), the `exportsFace` (ask/listSessions/addContext with stable DSH_EXPORT_* codes), `lmRoute` (registers a `dsh` LanguageModelChatProvider proxying /api/lm/models + /api/lm/chat SSE), and `editEventProjector` (bounded session.export ZIP back-scan + live events.mux subscription → `recordToolEdit`).

**Change review flow**: bridge pushes / tool notifications / `changeWatcher` external events / projector hits all land in the journal; `changeTree` (session or all scope, grouped by source) renders the `dsh.changes` TreeView, offers read-only in-memory previews (`dsh-change-preview` scheme) for pending entries, and Accept (only disk-writing path, via `vscode.workspace.applyEdit`) / Undo (checkpoint seam or snapshot whole-file restore) / openDiff (`vscode.diff`).

## Integration Points

**Internal dependencies (imports within src/):**
- `extension.js` imports nearly everything: serverManager, runtimeProvisioner, localRuntimeResolver, launchMethodResolver, processDiscovery, startupErrors, vscodeCapabilities, dshCompat, webviewHtml, sessionNavigation, textDocumentBridge, ch1/notifier, versionedBridgeServer, bridgeWorkspace, types, vscodeFacade, webviewMessages, interactionBridge, dshIntegration, hmrGuard, threadAttachment, commands/shell (subfolder), providerDetector, dshHome, editorContext, changeTracker, dshChatClient, sessionTitler, lmRoute, chatParticipant, exportsFace, editEventProjector, changeTree, changeWatcher, onboarding, webEmbedProxy, loopbackAuth, workspaceContext, featureRegistry, lifecycle, startupGate, embedOverlay, profileScaffold, managedRuntimeLaunch, capabilityCatalog...
- Runtime pipeline chain: runtimeProvisioner → runtimeResolver, runtimeDownloader, runtimeInstaller, runtimeArtifact, serverManager(ServerError); runtimeInstaller → runtimeArchive, runtimeArtifact; localRuntimeResolver → shimResolver, managedRuntimeLaunch, startupErrors, serverManager; launchMethodResolver → shimResolver, localRuntimeResolver, managedRuntimeLaunch.
- Session/chat cluster: dshChatClient → sessionNavigation, loopbackAuth; sessionNavigation → loopbackAuth; chatParticipant/exportsFace → sessionTitler; editEventProjector → dshChatClient, loopbackAuth; inlineCompletion → loopbackAuth.
- Change cluster: changeTree/changeWatcher → changeTracker; threadAttachment → protocol/webview; interactionBridge/webviewHtml → protocol/webview; versionedBridgeServer → protocol/ch1; providerDetector → capabilityCatalog, catalog/pluginCatalog, detection/pluginDetector, detection/profileProbe, diagnose/pluginSummary.
- Home/profile cluster: dshHome → managedRuntimeLaunch; profileScaffold/embedOverlay/dshIntegration/hmrGuard → managedRuntimeLaunch; runtimeResolver → runtimeArtifact, managedRuntimeLaunch; workspaceContext → managedRuntimeLaunch, types, serverManager.

**External (VS Code / Node / network):**
- VS Code APIs: webview view `dsh.webview` in container `dsh-sidebar`, `vscode.lm.registerLanguageModelChatProvider` (1.104+), chat participant `@dsh`, `registerInlineCompletionItemProvider`, TreeView `dsh.changes`, commands (`dsh.openInBrowser`, `dsh.restartServer`, `dsh.stopServer`, `dsh.focusSidebar`, `dsh.changes.openDiff/accept/undo/refresh/focus`, `dsh.addFileToThread`, `dsh.onboarding`, `dsh.diagnose`, `vscode.diff`, `vscode.open`, `simpleBrowser.show`, `workbench.extensions.show`), built-in `vscode.git` API, SecretStorage (FIM key), globalStorageUri/globalState, l10n.
- DSH web API endpoints: /api/session.list, /api/session.create, /api/session.rename, /api/session.prompt, /api/session.export, /api/events.mux (SSE), /api/fim, /api/lm/models, /api/lm/chat, /api/remote.mux (WS).
- Spawn env contract: DSH_VSCODE_BRIDGE_*, DSH_VSCODE_OPEN_URL/TOKEN, DSH_VSCODE_HEARTBEAT_PATH/WINDOW_ID/WATCHDOG, DSH_HOME, DSH_TEXT_EDITOR, DSH_VSCODE_PORT/STORAGE_ROOT; runtime release manifestUrl over HTTPS.
- Node built-ins only (fs, path, crypto, net, http, https, zlib, child_process); zero npm dependencies.

**Consumers**: `extension.js` (package.json main) is the sole consumer of most modules; subfolder modules (`commands/shell`, `protocol/webview`, `protocol/ch1`, `catalog/`, `detection/`, `diagnose/`) consume the shared constants/clients defined here.

## Files

- `bridgeWorkspace.js` — Builds the frozen workspace identity (windowId hash, trust, kind local/wsl/remote-ssh/virtual, folders) returned by bridge `initialize`. (~28 lines)
- `callExportJournal.js` — Best-effort persistent journal of vscode/extensions/callExport summaries (`callExport/journal.json`, capped, atomic writes). (~106 lines)
- `capabilityCatalog.js` — Frozen, self-validating provider catalog (4 entries) with URI whitelist, snapshots, resolveProvider, SHA-256 catalogRevision. (~208 lines)
- `chatParticipant.js` — Pure `@dsh` chat participant core: stream-first prompt handling, chunked markdown deltas, followups from recent root sessions. (~370 lines)
- `changeTracker.js` — Change journal: wire-edit validation, before-snapshots, Accept/Undo state machine, tool-edit merge, snapshot restore edits. (~735 lines)
- `changeTree.js` — `dsh.changes` TreeView provider with source grouping, session scope, in-memory pending previews, openDiff/accept/undo actions. (~867 lines)
- `changeWatcher.js` — FileSystemWatcher fallback recording external on-disk changes as journal entries, with debounce, mtime dedup, rate-limit circuit breaker to git polling. (~447 lines)
- `dshChatClient.js` — HTTP/SSE client: session.prompt + events.mux subscription with stall timeout and frame caps. (~617 lines)
- `dshCompat.js` — DSH version parsing/comparison and derived capability, runtime-issue, and adapter-line flags. (~238 lines)
- `dshHome.js` — DSH user-data home resolution (shared/isolated, setting/env/default), 0.4.x migration guard, runtime-home binding. (~178 lines)
- `dshIntegration.js` — Content-aware sync of the extension-owned dsh-vscode-integration plugin package into the profile, with version marker and foreign-file sweep. (~213 lines)
- `editEventProjector.js` — Projects edit/write tool calls from session.export back-scan and live events.mux into the change journal (minimal ZIP reader). (~358 lines)
- `editorContext.js` — Bridge handlers for editor attachments (active-file, selection, problems, folder, file) with size/diagnostic budgets and EditorContextError codes. (~748 lines)
- `embedOverlay.js` — Renders/writes the `--patch` overlays: embed overlay (disable duplicate plugins, insert vscode-integration) and clean-restart overlay. (~223 lines)
- `exportsFace.js` — Frozen programmatic face for other extensions: ask/listSessions/addContext with stable DSH_EXPORT_* error codes. (~382 lines)
- `extension.js` — Composition root: activation, config, runtime resolution, server lifecycle, webview, commands, bridge wiring, feature registration. (~3141 lines)
- `featureRegistry.js` — Layered (L0/L1/L2) feature registry with per-feature fault isolation, settings gating, and LIFO teardown. (~180 lines)
- `hmrGuard.js` — Ensures cordis-plugin-hmr is disabled in the profile's cordis.patch.yml (idempotent, atomic, backup). (~102 lines)
- `inlineCompletion.js` — Pure FIM inline-completion provider: context window build, debounce, /api/fim call, 503 once-per-session guidance. (~418 lines)
- `interactionBridge.js` — Webview bridge handlers for clipboard read/write, link/open, attachment/open with byte caps and versioned result messages. (~101 lines)
- `launchMethodResolver.js` — dsh.launch.method normalization and command-mode runtime resolution (where/which, shim parsing, node pairing). (~166 lines)
- `lifecycle.js` — LifecycleQueue: serialized lifecycle work, enqueueOnce dedup, shutdown gating. (~53 lines)
- `lmRoute.js` — Registers the `dsh` VS Code language-model provider proxying /api/lm/* with SSE parsing and token estimation. (~295 lines)
- `localRuntimeResolver.js` — Local @deepseek-ai/dsh package + Node discovery across npm/pnpm/yarn/volta/scoop/nvm layouts; safe entrypoint validation. (~448 lines)
- `loopbackAuth.js` — Launch-token → session-cookie exchange and same-origin loopback fetch wrapper. (~66 lines)
- `managedRuntimeLaunch.js` — Runtime normalization, launchability checks, and the managed spawn spec (--profile/--host/--port/--no-open/--patch, env). (~204 lines)
- `onboarding.js` — 6-step QuickPick setup wizard (profile, autoStart, close policy, features, optional FIM, summary) gated by globalState. (~480 lines)
- `processDiscovery.js` — Cached scan of running `dsh web` process command lines (PowerShell/ps) to recover ports. (~84 lines)
- `profileScaffold.js` — Creates custom DSH profile dirs (package.json, cordis.patch.yml, pnpm-workspace.yaml) mirroring initProfile. (~81 lines)
- `providerDetector.js` — Provider state detection from vscode.extensions, bridge handlers (getProviderStates, openDetails), and the dsh.diagnose snapshot. (~256 lines)
- `runtimeArchive.js` — Strict streaming USTAR/gunzip extractor restricted to manifest-listed files, sizes, and safe paths. (~169 lines)
- `runtimeArtifact.js` — Runtime manifest parsing/validation (hashes, paths, versions) and full directory verification (size, sha256, exec bits). (~246 lines)
- `runtimeDownloader.js` — HTTPS-only archive downloader with redirect/size/hash/cancellation enforcement and content-addressed cache. (~117 lines)
- `runtimeInstaller.js` — Staged install, promote (current/last-good pointers), guarded rollback, and obsolete-runtime cleanup. (~224 lines)
- `runtimeProvisioner.js` — Release-manifest parsing/fetch and ensureManagedRuntime orchestration (resolve → download → install → promote → re-verify → rollback). (~282 lines)
- `runtimeResolver.js` — Resolves current/last-good runtimes from pointer files with full manifest+payload verification. (~96 lines)
- `serverManager.js` — Server lifecycle: probe/spawn/health-check/stop, port scanning, instance registry, close policies, heartbeat. (~1428 lines)
- `sessionNavigation.js` — Loopback JSON-RPC client for session.list/create/rename plus QuickPick mapping and workspace-session binding. (~688 lines)
- `sessionTitler.js` — Pure title derivation from first prompt plus memoized one-shot session rename guard. (~67 lines)
- `shimResolver.js` — Windows dsh.cmd/.ps1 shim parsing to package roots; PATH/global-layout candidates; executablePath setting normalization. (~211 lines)
- `startupErrors.js` — Central startup-error taxonomy (codes → retryable/template/diagnoseHint) and rendering/retry predicates. (~166 lines)
- `startupGate.js` — Cooldown gate bounding automatic startup retries (explicit user retries bypass). (~28 lines)
- `textDocumentBridge.js` — Authenticated loopback HTTP bridge letting the DSH child open absolute local paths in this window. (~208 lines)
- `threadAttachment.js` — Attachment markdown-link formatting, bounded folder listing, and the ThreadAttachmentCoordinator request/response bridge. (~273 lines)
- `types.js` — Shared constants: ports, view/container ids, BOOT_MARKER, watchdog cadences and env keys. (~90 lines)
- `versionedBridgeServer.js` — Loopback newline-JSON-RPC server: initialize/token/protocol negotiation, versioned dispatch, timeouts, notifications. (~450 lines)
- `vscodeCapabilities.js` — VS Code version → capability booleans (chatParticipant, lmProvider, mcpServerDefinitions). (~77 lines)
- `vscodeFacade.js` — Freezes the consumed VS Code API surface for the extension host and tests. (~42 lines)
- `webEmbedProxy.js` — Loopback HTTP/WebSocket proxy that authenticates the embedded iframe against the owned DSH child. (~211 lines)
- `webviewHtml.js` — CSP-hardened status/frame page HTML generators with safe URL/JSON escaping and theme/session params. (~477 lines)
- `webviewMessages.js` — Fixed webview→host message router plus the DSH_THEME_CHANGED message type. (~73 lines)
- `workspaceContext.js` — Config/workspace binding helpers: normalized dsh.* settings, cwd resolution, registry path, default-port logic. (~116 lines)
