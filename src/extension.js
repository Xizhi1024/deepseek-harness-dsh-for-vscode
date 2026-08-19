"use strict";
/**
 * DeepSeek Harness Sidebar — VS Code extension entry point.
 *
 * Wiring layer only:
 *  - reads the dsh.* configuration (host/port/autoStart/closePolicy/runtime)
 *  - resolves the managed runtime before every autoStart, then ensures one
 *    window-owned local DSH web server exists (or, when autoStart is disabled,
 *    reuses a user-managed configured endpoint)
 *  - renders the DSH web UI inside the auxiliary-bar webview via an iframe
 *  - provides the openInBrowser / restartServer / stopServer / focusSidebar commands
 *  - starts the server at VS Code startup (onStartupFinished) when autoStart
 *    is on, even if the sidebar view is never opened
 *  - honors a configurable close policy (onVscodeExit / onViewClose / never)
 *    and a single serialized reconciler for config/workspace changes
 *
 * Zero npm dependencies. CommonJS.
 */
const path = require("node:path");
const {
  ServerManager,
  CLOSE_POLICIES,
  killProcessTree,
  normalizeClosePolicy,
  shouldStopOnViewClose,
  reconcileConfigChange,
} = require("./serverManager");
const { ensureManagedRuntime } = require("./runtimeProvisioner");
const { resolveLocalDshRuntime } = require("./localRuntimeResolver");
const { STARTUP_ERRORS, isRetryableStartupError, renderStartupError } = require("./startupErrors");
const { deriveVscodeCapabilities } = require("./vscodeCapabilities");
const { framePage, statusPage, safeHttpUrl } = require("./webviewHtml");
const {
  listSessions,
  createSession,
  ensureWorkspaceSession,
  rootSessionItems,
  reuseBlankSession,
  buildQuickPickItems,
  showSessionQuickPick,
  sessionIdFromValue,
  DshSessionError,
} = require("./sessionNavigation");
const { startTextDocumentBridge } = require("./textDocumentBridge");
const { createNotifier } = require("./ch1/notifier");
const { VersionedBridgeServer } = require("./versionedBridgeServer");
const { createBridgeWorkspaceIdentity } = require("./bridgeWorkspace");
const { DEFAULT_HOST, DEFAULT_PORT, VIEW_ID, CONTAINER_ID } = require("./types");
const { createVscodeFacade } = require("./vscodeFacade");
const { createWebviewMessageHandler, DSH_THEME_CHANGED } = require("./webviewMessages");
const {
  handleInteractionRequest,
  parseInteractionRequest,
} = require('./interactionBridge');
const { installDshIntegration } = require('./dshIntegration');
const {
  ThreadAttachmentCoordinator,
  formatFileAttachment,
  formatFolderAttachment,
  formatSelectionAttachment,
} = require('./threadAttachment');
const { createCommandShell, NullAdapter } = require('./commands/shell');
const {
  createAddFileToThreadCommand,
  createAddFolderToThreadCommand,
} = require('./commands/addFileToThread');
const { createCleanupOrphansCommand } = require('./commands/cleanupOrphans');
const { createWorkspaceContext } = require("./workspaceContext");
const { createWorkspaceBinding, BINDING_STATES } = require("./context/workspaceBinding");
const { createEditorContext } = require("./editorContext");
const {
  createExtensionBridgeHandlers,
  detectProviderStates,
  diagnosticSnapshot,
} = require("./providerDetector");
const { writeCleanOverlay, writeEmbedOverlay } = require("./embedOverlay");
const {
  HOME_MODES,
  bindRuntimeHome,
  migrateLegacyHomeMode,
  resolveDshHome,
} = require('./dshHome');
const { LifecycleQueue } = require("./lifecycle");
const { createFeatureRegistry } = require("./featureRegistry");

// Startup/connect retry semantics are centralized in src/startupErrors.js:
// classified codes decide Retry enablement, unknown codes stay retryable.

let vscode = null; // injected during activation; avoids loading vscode in node:test
let hostContext = null; // workspace/config facade bound during activation
let manager = null; // ServerManager instance (created in activate)
let currentServer = null; // RunningServer | null
let currentExternalUrl = null; // client-reachable URL (forwarded in remote workspaces)
let currentSessionId = null; // DSH session id to pass to the iframe (dsh_session)
let currentDshTheme = null; // active VS Code theme ('dark'|'light') for dsh_theme / dshThemeChanged
let currentView = null; // vscode.WebviewView | null
let statusBar = null; // vscode.StatusBarItem | null
let boundCwd = null; // workspace root the current server is bound to (null = none)
let lastConfig = null; // last config snapshot used for change detection (reconciler)
let lifecycle = null; // the one queue for every lifecycle transition
let viewGeneration = 0; // invalidates delayed connects for disposed/replaced views
let textDocumentBridge = null; // per-window authenticated DSH -> vscode.window bridge
let versionedBridge = null; // per-window versioned JSON-RPC bridge
let notificationNotifier = null; // CH1 v2 metadata notification coalescer
let notificationSubscriptions = []; // selection/diagnostics event disposables
let editorContext = null; // per-window approved editor attachments backing vscode/editor methods
let embedPatchPath = null; // generated --patch overlay applied to extension-owned DSH children
let runtimeStorageRoot = null; // managed runtime storage under VS Code global storage
let activeDshHome = null; // effective shared/isolated DSH user-data home
let activeDshHomeInfo = null; // effective mode/path/source for diagnostics
let ensureRuntime = null; // resolves/verifies (and optionally provisions) the managed runtime
let ensureWorkspaceSessionFn = null; // retained injection seam; defaults to workspaceBinding.resolve
let workspaceBinding = null; // SM-2 workspace registry binding (created in activate)
let runtimeAbort = new AbortController(); // cancels in-flight runtime provisioning on deactivate
let threadAttachmentCoordinator = null; // owning-window request/ack bridge into the DSH composer
let injectedDependencies = {}; // activation seams shared with the feature setups (deps stays { context, services })
let registry = null; // R25 feature registry (created in activateWithDependencies)
let featureFailures = []; // R25 [{ id, error, at }] folded into dsh.diagnose
let interactionHandlers = []; // webview interaction routers registered by L1/L2 features
let cleanMode = false; // D1 clean-restart mode: spawns with vscode-clean.overlay.yml
let cleanPatchPath = null; // absolute clean overlay currently in effect
let pendingCleanRestart = false; // status-page Retry maps to Restart-Clean on HEALTH_TIMEOUT/SPAWN_EXITED_EARLY
let selfHealEvents = []; // Diagnose records successful patch-drop self-heal retries here

async function waitForResolvedView(timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!currentView && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return currentView;
}

/** Best-effort URI string used in metadata-only v2 notifications. */
function describeUri(uri) {
  if (!uri) return null;
  if (typeof uri.toString === 'function') {
    try {
      return uri.toString();
    } catch (_) {
      return String(uri);
    }
  }
  return String(uri);
}

/** Approved attachment ids currently associated with a URI string. */
function attachmentIdsForUri(uriString) {
  if (!editorContext || typeof uriString !== 'string') return [];
  const snapshot = editorContext.attachmentSnapshot ? editorContext.attachmentSnapshot() : [];
  return snapshot
    .filter((attachment) => attachment && attachment.document && attachment.document.uri === uriString)
    .map((attachment) => attachment.id)
    .filter((id) => typeof id === 'string');
}

/** True when a v2 CH1 client has completed initialize on the live bridge. */
function hasV2Bridge() {
  if (!versionedBridge) return false;
  if (typeof versionedBridge.hasProtocolVersion === 'function' && versionedBridge.hasProtocolVersion(2)) return true;
  if (typeof versionedBridge.hasV2Clients === 'function' && versionedBridge.hasV2Clients()) return true;
  return false;
}

/**
 * Push one v2 metadata notification through the coalescer. When no v2 client
 * is currently connected the event is dropped immediately so no pending queue
 * can leak across connections/workspaces.
 */
function pushV2Notification(method, params) {
  if (!hasV2Bridge()) return;
  notificationNotifier?.push(method, params);
}

/** vscode/editor/selectionChanged metadata-only notification. */
function notifySelectionChanged(event) {
  const editor = event && event.textEditor;
  const document = editor && editor.document;
  const uriString = document && describeUri(document.uri);
  if (!uriString) return;
  const attachmentIds = attachmentIdsForUri(uriString);
  if (attachmentIds.length === 0) return;
  pushV2Notification('vscode/editor/selectionChanged', {
    uri: uriString,
    version: document.version,
    attachmentIds,
  });
}

/** vscode/editor/activeEditorChanged metadata-only notification. */
function notifyActiveEditorChanged(editor) {
  const document = editor && editor.document;
  const uriString = document && describeUri(document.uri);
  if (!uriString) return;
  if (attachmentIdsForUri(uriString).length === 0) return;
  pushV2Notification('vscode/editor/activeEditorChanged', {
    uri: uriString,
  });
}

/** vscode/diagnosticsChanged metadata-only notification for approved URIs. */
function notifyDiagnosticsChanged(event) {
  const uris = event && event.uris;
  if (!Array.isArray(uris)) return;
  for (const uri of uris) {
    const uriString = describeUri(uri);
    if (!uriString) continue;
    const attachmentIds = attachmentIdsForUri(uriString);
    if (attachmentIds.length === 0) continue;
    pushV2Notification('vscode/diagnosticsChanged', {
      uri: uriString,
      attachmentIds,
    });
  }
}

function prepareDshHome(config, context) {
  const resolved = resolveDshHome({
    mode: config.homeMode,
    configuredPath: config.homePath,
    globalStoragePath: context.globalStorageUri.fsPath,
  });
  activeDshHome = resolved.path;
  const integration = installDshIntegration(
    activeDshHome,
    context.extensionPath || path.resolve(__dirname, '..'),
    { profileName: config.profile }
  );
  const info = {
    ...resolved,
    integrationNodeModulesPath: integration.nodeModulesPath,
  };
  activeDshHomeInfo = info;
  embedPatchPath = writeEmbedOverlay(activeDshHome);
  manager?.setEmbedPatchPath?.(embedPatchPath);
  return info;
}

/**
 * Localize a template with params. Templates are English by default and are
 * translated through the l10n bundle (l10n/bundle.l10n.*.json) according to
 * the VS Code display language — one source of truth, no mixed languages.
 */
function loc(template, params) {
  return vscode.l10n.t(template, params || {});
}

/** Apply the D1 clean-restart mode to the module state and the ServerManager. */
function applyCleanMode(enabled, patchPath) {
  cleanMode = Boolean(enabled);
  cleanPatchPath = enabled ? patchPath : null;
  try {
    manager?.setCleanMode?.({ enabled: cleanMode, patchPath: cleanPatchPath });
  } catch (_) { /* non-fatal: a clean-mode mismatch only affects spawn flags */ }
  return cleanMode;
}

/** Leave clean-restart mode; the next restart uses the normal embed overlay. */
function clearCleanMode() {
  return applyCleanMode(false, null);
}

/** True when a failed startup should offer the Restart-Clean entry. */
function isCleanRestartEligible(err) {
  const code = err && err.code;
  return code === "HEALTH_TIMEOUT" || code === "SPAWN_EXITED_EARLY";
}

/**
 * Localized dsh.diagnose startup-error table. Every row flows through the
 * startupErrors taxonomy and is rendered via the bilingual l10n template keys
 * (the localized hints live in l10n/bundle.l10n.*.json).
 * @returns {string}
 */
function localizedStartupErrorTable() {
  return Object.keys(STARTUP_ERRORS)
    .sort()
    .map((code) => {
      const def = STARTUP_ERRORS[code];
      return `${code}: ${def.retryable ? loc("retryable") : loc("non-retryable")} — ${loc(def.diagnoseHint)}`;
    })
    .join('\n');
}

/**
 * Map a VS Code active color theme kind to the DSH theme marker (`dark` or
 * `light`). Dark and HighContrast resolve to `dark`, Light and
 * HighContrastLight to `light`; unknown kinds resolve to undefined so no
 * `dsh_theme` URL parameter is emitted.
 *
 * @param {{kind?: number}|undefined} theme - `vscode.window.activeColorTheme`.
 * @returns {'dark'|'light'|undefined}
 */
function themeFromColorThemeKind(theme) {
  const kind = theme && theme.kind;
  if (kind === undefined || kind === null) return undefined;
  if (kind === vscode?.ColorThemeKind?.Dark || kind === 2) return 'dark';
  if (kind === vscode?.ColorThemeKind?.HighContrast || kind === 3) return 'dark';
  if (kind === vscode?.ColorThemeKind?.Light || kind === 1) return 'light';
  if (kind === vscode?.ColorThemeKind?.HighContrastLight || kind === 4) return 'light';
  return undefined;
}

/**
 * The directory the DSH server should treat as its workspace root.
 * Defaults to the current VS Code workspace: in multi-root setups the
 * workspace of the active editor wins, otherwise the first folder.
 * Returns null when no workspace is open — the spawned process then
 * inherits the extension host's cwd (no forced fallback to a home dir).
 */
/**
 * In remote scenarios (WSL / Remote-SSH) the server runs on the remote side
 * while the webview renders on the local client; asExternalUri sets up VS
 * Code port forwarding and returns the client-reachable URI.
 */
async function externalize(url) {
  try {
    const uri = await vscode.env.asExternalUri(vscode.Uri.parse(url));
    return uri.toString(true);
  } catch (_) {
    return url; // local scenario or forwarding unavailable: keep the raw loopback URL
  }
}

function setStatusBar(text, tooltip) {
  if (!statusBar) {
    // The indicator is normally created by the L1 statusbar-basic feature.
    // When that feature is disabled or failed, L0 still surfaces its state
    // through a fallback item so the $(error) lifeline always has a seat.
    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  }
  statusBar.text = text;
  statusBar.tooltip = tooltip || text;
  statusBar.show();
}

/** Push an HTML page into the sidebar webview, if one is open. */
function render(page) {
  if (currentView) {
    currentView.webview.html = page;
  }
}

/**
 * Render the DSH iframe for the current external URL, carrying the active
 * session id when one was created or selected. Used after session navigation
 * so the embedded DSH web UI reloads against the requested session.
 */
function renderFrame(context) {
  if (!currentExternalUrl) return;
  render(framePage({
    url: currentExternalUrl,
    lang: vscode.env.language,
    failText: loc("Failed to load: DSH service unreachable"),
    openBrowserLabel: loc("Open in browser"),
    retryLabel: loc("Retry"),
    sessionId: currentSessionId,
    theme: currentDshTheme,
  }));
}

/**
 * Stop the manager-owned child, if any, so a reused external instance is
 * NEVER killed — mirroring the exact rule the
 * `dsh.stopServer` command and the close policy rely on. Safe no-op when
 * there is nothing owned.
 * @returns {Promise<boolean>} true when an owned server was stopped.
 */
async function stopOwnedServer() {
  if (!manager || !manager.hasOwnedChild()) return false;
  await manager.stop();
  return true;
}

/**
 * Append one operation to the single lifecycle queue. Every caller re-reads
 * workspace/config state inside its operation, so rapid changes are latest-wins.
 * The queue stays usable after a failed operation while the caller still sees
 * the original rejection.
 */
/**
 * Main flow: make sure a DSH web server exists, then show it in the sidebar.
 * Must be called from LifecycleQueue.enqueue(); the cwd the server ends up bound to
 * is recorded in boundCwd.
 *
 * Null-safe: when no WebviewView has been resolved yet (e.g. activated via
 * onStartupFinished), the server is still ensured; render() simply has nothing
 * to paint and the view — resolved later — schedules another ensure to show it.
 */
/**
 * Bind the sidebar to one ready RunningServer handle: record it, optionally
 * auto-bind an owned instance to the current workspace session, externalize
 * its URL for the webview and update the status bar / iframe.
 */
async function bindServer(context, server, cwd) {
  currentServer = server;
  boundCwd = cwd;
  const url = await externalize(server.url);
  currentExternalUrl = url;
  const mode = loc(server.owned ? "managed" : "reused");
  setStatusBar(
      "$(radio-tower) " + loc("DSH: {port} ({mode})", { port: String(server.port), mode }),
      loc("DSH server: {url}", { url: server.url }) + (cwd ? " | " + loc("workspace: {cwd}", { cwd }) : "")
  );

  let sessionId = null;
  if (cwd) {
    // SM-2: bind through the DSH workspace registry. This works for both
    // owned and reused servers and never stops an owned child on workspace
    // switches; consent is requested before creating a workspace on reused
    // instances.
    sessionId = await workspaceBinding.resolve(server, cwd);
    currentSessionId = sessionId ? sessionIdFromValue(sessionId) : null;
    const bindingState = workspaceBinding.state();
    if (bindingState.state === BINDING_STATES.ERROR) {
      render(statusPage({
        title: loc("DSH workspace binding failed"),
        detail: bindingState.error || loc("Unknown workspace binding error"),
        showRetry: true,
        retryLabel: loc("Retry"),
        lang: vscode.env.language,
      }));
      return;
    }
  } else {
    currentSessionId = null;
  }
  renderFrame(context);
}

async function connectNow(context) {
  try {
    // The Restart-Clean entry only applies to the next failed startup.
    pendingCleanRestart = false;

    const cfg = hostContext.config();
    prepareDshHome(cfg, context);
    const cwd = hostContext.workspaceCwd();
    setStatusBar("$(radio-tower) " + loc("DSH: connecting…"));
    render(statusPage({ title: loc("Connecting to DeepSeek Harness…"), detail: "", lang: vscode.env.language }));

    let server = null;
    // autoStart uses the locally installed official DSH package by default and
    // an explicitly configured verified release manifest as an opt-in path.
    // Both launch with the independently selected shared/isolated home and the configured dsh.profile.
    // One exception: when no managed runtime can be provided but a DSH
    // instance is already serving the configured endpoint, adopt that
    // instance as a reused external server instead of stranding the sidebar.
    if (cfg.autoStart) {
      render(statusPage({
        title: loc("Connecting to DeepSeek Harness…"),
        detail: loc("Resolving official DSH runtime…"),
        lang: vscode.env.language,
      }));
      let resolvedRuntime;
      try {
        resolvedRuntime = await ensureRuntime({
          storageRoot: runtimeStorageRoot,
          platform: process.platform,
          arch: process.arch,
          manifestUrl: cfg.runtimeManifestUrl,
          version: cfg.runtimeVersion,
          dshHome: activeDshHome,
          packageRoot: cfg.localPackageRoot,
          nodePath: cfg.localNodePath,
          signal: runtimeAbort.signal,
        });
      } catch (runtimeError) {
        const adopted = typeof manager.adoptRunningDsh === 'function'
          ? await manager.adoptRunningDsh(cfg.host, cfg.port).catch(() => null)
          : null;
        if (!adopted) throw runtimeError;
        manager.setResolvedRuntime(null);
        console.warn(
          'dsh-vs-sidebar: configured runtime unavailable; reusing running DSH instance:',
          runtimeError && runtimeError.message ? runtimeError.message : runtimeError
        );
        server = adopted;
      }
      if (server === null) {
        resolvedRuntime = bindRuntimeHome(resolvedRuntime, activeDshHome, cfg.profile);
        manager.setResolvedRuntime(resolvedRuntime);
      }
    }

    if (server === null) {
      server = await manager.ensureServer({
        host: cfg.host,
        port: cfg.port,
        autoStart: cfg.autoStart,
        cwd,
        registryFile: hostContext.registryFilePath(),
      });
    }
    await bindServer(context, server, cwd);
  } catch (err) {
    currentServer = null;
    boundCwd = null;
    if (lifecycle.stopped) return;
    setStatusBar("$(error) " + loc("DSH: unavailable"));
    const cfg = hostContext.config();
    const url = "http://" + cfg.host + ":" + cfg.port;
    currentExternalUrl = safeHttpUrl(url) === "about:blank" ? null : await externalize(url);
    const cleanEligible = isCleanRestartEligible(err);
    pendingCleanRestart = cleanEligible;
    try {
      render(statusPage({
        title: loc("DeepSeek Harness unavailable"),
        detail: renderStartupError(err, loc),
        url,
        showOpenBrowser: Boolean(currentExternalUrl),
        showRetry: isRetryableStartupError(err),
        openBrowserLabel: loc("Open in browser"),
        retryLabel: cleanEligible ? loc("Restart-Clean") : loc("Retry"),
        lang: vscode.env.language,
      }));
    } catch (_) { /* never throw out of connect() */ }
  }
}

/** Queue an ensure operation, optionally tied to one resolved view instance. */
function scheduleConnect(context, expectedViewGeneration = null) {
  return lifecycle.enqueue("connect", async () => {
    if (
      expectedViewGeneration !== null
      && (expectedViewGeneration !== viewGeneration || !currentView)
    ) {
      return;
    }
    await connectNow(context);
  });
}

/** Re-connect: stops only servers this extension spawned, never a reused one. */
async function reconnectNow(context) {
  const cfg = hostContext.config();
  // Validate before stopping a working instance. ensureServer performs the
  // authoritative validation; these checks preserve it on invalid settings.
  if (cfg.host !== DEFAULT_HOST || !Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    await manager.ensureServer({
      host: cfg.host,
      port: cfg.port,
      autoStart: false,
      cwd: hostContext.workspaceCwd(),
      registryFile: hostContext.registryFilePath(),
    });
    return;
  }
  await stopOwnedServer();
  currentServer = null;
  currentExternalUrl = null;
  currentSessionId = null;
  await connectNow(context);
}

/** D1 clean restart: write the clean overlay, enter clean mode and restart. */
async function restartCleanNow(context) {
  if (currentServer && currentServer.owned !== true && !manager.hasOwnedChild()) {
    vscode.window.showInformationMessage(loc("The running DSH server is reused and cannot be restarted by this extension"));
    return false;
  }
  pendingCleanRestart = false;
  const cfg = hostContext.config();
  let overlayPath;
  try {
    overlayPath = writeCleanOverlay(activeDshHome, cfg.profile || "web");
  } catch (err) {
    vscode.window.showErrorMessage(loc("Clean restart failed: {message}", {
      message: err && err.message ? err.message : String(err),
    }));
    return false;
  }
  applyCleanMode(true, overlayPath);
  // Clean-mode status page banner with the Restart-normal entry (existing
  // status-page message protocol: the Retry button is reused).
  render(statusPage({
    title: loc("DeepSeek Harness (clean mode)"),
    detail: loc("Non-core DSH plugins are disabled until Restart-normal."),
    showRetry: true,
    retryLabel: loc("Restart-normal"),
    lang: vscode.env.language,
  }));
  await reconnectNow(context);
  return true;
}

/** Restart-normal: reuses the normal restart path and clears the clean flag. */
async function restartNormalNow(context) {
  if (currentServer && currentServer.owned !== true && !manager.hasOwnedChild()) {
    vscode.window.showInformationMessage(loc("The running DSH server is reused and cannot be restarted by this extension"));
    return false;
  }
  clearCleanMode();
  await reconnectNow(context);
  return true;
}

/**
 * True when two cwd values denote the same root. Null-safe: both null means
 * "no workspace" on both sides; samePath handles Windows case/trailing-slash
 * differences.
 */
/**
 * Re-bind the sidebar to the current workspace root. Called whenever the
 * workspace changed — folders added/removed, or the active editor moved to
 * another folder in a multi-root workspace — so the embedded DSH instance
 * always matches the workspace the user is looking at.
 *
 * Stops a server this extension spawned for the OLD root (reused instances
 * are never touched), resets the view to a "connecting" state and re-runs
 * the whole probe/reuse/spawn flow for the new cwd. No-ops when the root did
 * not effectively change.
 */
async function rebindToWorkspace(context) {
  const cwd = hostContext.workspaceCwd();
  if (hostContext.sameRoot(cwd, boundCwd)) return; // no effective workspace change

  // Approved editor attachments are workspace-scoped; a root change must
  // never leak the previous workspace's content into the new DSH instance.
  editorContext?.clearAttachments();
  boundCwd = cwd;
  render(statusPage({
    title: loc("Connecting to DeepSeek Harness…"),
    detail: loc("Workspace changed — rebinding to the new workspace…"),
    lang: vscode.env.language,
  }));

  // Recovery path: if there is no server handle at all, or the owned child
  // process no longer exists, fall back to the full connect/ensure flow.
  if (!currentServer || (currentServer.owned && !manager.hasOwnedChild())) {
    currentServer = null;
    currentExternalUrl = null;
    currentSessionId = null;
    await connectNow(context);
    return;
  }

  // Workspace switch must not kill the DSH child: rebind the existing server
  // to the new workspace through the workspace registry.
  const sessionId = await workspaceBinding.resolve(currentServer, cwd);
  currentSessionId = sessionId ? sessionIdFromValue(sessionId) : null;
  const bindingState = workspaceBinding.state();
  if (bindingState.state === BINDING_STATES.ERROR) {
    render(statusPage({
      title: loc("DSH workspace binding failed"),
      detail: bindingState.error || loc("Unknown workspace binding error"),
      showRetry: true,
      retryLabel: loc("Retry"),
      lang: vscode.env.language,
    }));
    return;
  }
  renderFrame(context);
}

/**
 * Queue a workspace-driven rebind. Chained so rapid workspace switches are
 * processed one after another instead of racing each other.
 */
function scheduleRebind(context) {
  return lifecycle.enqueue("workspace rebind", () => rebindToWorkspace(context));
}

/**
 * React to a `dsh.*` configuration change (host / port / autoStart /
 * closePolicy / runtime manifest and version).
 *
 * All reactions are funneled through one LifecycleQueue so burst setting
 * changes coalesce: a config change arriving during
 * an in-flight restart is queued behind it, never spawning parallel servers,
 * and the queued reconcile re-reads the LATEST config when it runs — so the
 * final state always matches the current settings.
 *
 * The decision of whether to restart is delegated to the pure, self-tested
 * `reconcileConfigChange()` in serverManager.js. A closePolicy-only change
 * does NOT restart (it only affects the dispose handler). Runtime manifest /
 * version changes restart an owned autoStart server so the new provisioning
 * inputs take effect; they never touch a reused external instance.
 */
function scheduleConfigReconcile(context) {
  return lifecycle.enqueue("config reconcile", async () => {
    const prev = lastConfig || hostContext.config();
    const next = hostContext.config();
      // Record the incoming snapshot regardless, so rapid toggles coalesce
      // onto the latest value before the next queued reconcile runs.
    lastConfig = next;

    const decision = reconcileConfigChange(
        prev,
        next,
        Boolean(currentServer),
        Boolean(manager && manager.hasOwnedChild())
    );

    const runtimeChanged = next.autoStart && (
      String(prev.runtimeManifestUrl || '') !== String(next.runtimeManifestUrl || '')
      || String(prev.runtimeVersion || '') !== String(next.runtimeVersion || '')
      || String(prev.localPackageRoot || '') !== String(next.localPackageRoot || '')
      || String(prev.localNodePath || '') !== String(next.localNodePath || '')
      || String(prev.homeMode || '') !== String(next.homeMode || '')
      || String(prev.homePath || '') !== String(next.homePath || '')
      || String(prev.profile || '') !== String(next.profile || '')
    );

    if (decision.shouldReconnect || runtimeChanged) {
      await reconnectNow(context);
    }
  });
}

/**
 * Ensure the dsh CLI is findable when VS Code was launched with a trimmed
 * PATH:
 *  - Windows: launched from the Start menu/Explorer, the npm global bin dir
 *    (%APPDATA%\npm, where dsh.cmd lives) may be missing from PATH.
 *  - macOS: launched from Finder/Dock, the launchd PATH (/usr/bin:/bin:
 *    /usr/sbin:/sbin) lacks the npm global bin (~/.npm-global/bin,
 *    /usr/local/bin, /opt/homebrew/bin).
 *  - Linux: desktop-launched sessions often lack the user npm prefix
 *    (~/.local/bin, ~/.npm-global/bin).
 * Only directories that actually exist are appended (POSIX), so a terminal
 * launch with a full PATH is never polluted.
 */

/**
 * R25 feature catalog — the single registration source for every feature.
 * Layer L0 is the lifeline (never configurable, executed first, zero
 * dependency on L1/L2 output); L1 features default to enabled and can be
 * turned off through `dsh.features.<id>`. The catalog is exported so
 * test/contracts.test.js can assert bidirectional agreement with
 * contributes.configuration.
 * @type {Array<{id: string, label: string, layer: 'L0'|'L1'|'L2', defaultEnabled: boolean, core: boolean, setup: (deps: object) => Promise<unknown>|unknown}>}
 */
const FEATURE_CATALOG = [
  { id: 'core-server', label: 'DSH server core', layer: 'L0', defaultEnabled: true, core: true, setup: setupCoreServer },
  { id: 'core-sidebar', label: 'DSH sidebar core', layer: 'L0', defaultEnabled: true, core: true, setup: setupCoreSidebar },
  { id: 'clipboard-bridge', label: 'Clipboard bridge', layer: 'L1', defaultEnabled: true, core: false, setup: setupClipboardBridge },
  { id: 'thread-attachment', label: 'Add to DSH thread', layer: 'L1', defaultEnabled: true, core: false, setup: setupThreadAttachment },
  { id: 'editor-links', label: 'Editor links (Read…)', layer: 'L1', defaultEnabled: true, core: false, setup: setupEditorLinks },
  { id: 'statusbar-basic', label: 'Status bar indicator', layer: 'L1', defaultEnabled: true, core: false, setup: setupStatusbarBasic },
  { id: 'theme-follow', label: 'Theme follow (dark/light)', layer: 'L1', defaultEnabled: true, core: false, setup: setupThemeFollow },
];

/**
 * R25: L0 core-server. ServerManager startup/health/restart/stop lifecycle,
 * dsh.restartServer / dsh.stopServer commands and closePolicy/deactivate
 * tree-kill paths. Publishes the ServerManager handle and the shared bridge
 * env bag into services for L1/L2 consumers. Never reads anything an L1/L2
 * feature produced (its own setup failures degrade to a recorded failure).
 */
async function setupCoreServer({ context, services }) {
  lifecycle = new LifecycleQueue();
  workspaceBinding = (injectedDependencies.createWorkspaceBinding || createWorkspaceBinding)({
    vscode,
    baseUrlProvider: () => currentServer && currentServer.url,
  });
  notificationSubscriptions = [];
  notificationNotifier = null;
  try {
    runtimeAbort?.abort?.();
  } catch {
    // ignore stale controller abort errors during repeated activation
  }
  runtimeAbort = new AbortController();
  runtimeStorageRoot = path.join(context.globalStorageUri.fsPath, 'runtime');
  const initialConfig = hostContext.config();
  const initialSharedHome = resolveDshHome({
    mode: HOME_MODES.SHARED,
    configuredPath: initialConfig.homePath,
    globalStoragePath: context.globalStorageUri.fsPath,
  }).path;
  const migration = await migrateLegacyHomeMode({
    vscode,
    context,
    sharedHome: initialSharedHome,
    isolatedHome: path.join(context.globalStorageUri.fsPath, '.dsh'),
  });
  if (migration.changed) {
    vscode.window.showWarningMessage(loc(
      'DSH kept your existing isolated DSH home to protect its modules and sessions. Set dsh.home.mode to shared when you are ready to use the official shared DSH home.'
    ));
  }
  ensureRuntime = injectedDependencies.ensureRuntime
    || injectedDependencies.ensureManagedRuntime
    || ((options) => options.manifestUrl
      ? ensureManagedRuntime(options)
      : resolveLocalDshRuntime(options));
  ensureWorkspaceSessionFn = injectedDependencies.ensureWorkspaceSession || ((baseUrl, cwd, options) => {
    const server = currentServer || { url: baseUrl, owned: true };
    return workspaceBinding.resolve(server, cwd);
  });
  try {
    prepareDshHome(hostContext.config(), context);
  } catch (err) {
    console.error('dsh-vs-sidebar: could not write embed overlay; starting without --patch:', err);
    embedPatchPath = null;
  }
  services.bridgeEnv = {};
  const createServerManager = injectedDependencies.createServerManager
    || ((options) => new ServerManager(options));
  manager = createServerManager({
    spawnEnv: services.bridgeEnv, // live shared bag: L0 publishes it, L1/L2 bridge features merge into it
    embedPatchPath,
    onStatus: (s) => {
      if (s.state === "selfheal") {
        // Successful patch-drop self-heal: transparent for the user, kept
        // for Diagnose.
        selfHealEvents.push(s);
        return;
      }

      // Surface each lifecycle stage inside the sidebar so the user can see
      // whether we reused an instance or started a new one (multi-instance
      // transparency).
      const stage = {
        probing: loc("Probing DSH service…"),
        reusing: loc("Reusing a running instance…"),
        starting: loc("Starting dsh web…"),
      }[s.state];
      if (stage) {
        try {
          const detail = stage + (s.message ? " — " + loc(s.message, s.params) : "");
          render(statusPage({ title: loc("Connecting to DeepSeek Harness…"), detail, lang: vscode.env.language }));
        } catch (_) { /* non-fatal */ }
      }
      if (s.state === "error") {
        setStatusBar("$(error) " + (s.message ? loc(s.message, s.params) : loc("DSH: unavailable")));
        currentServer = null;
        currentExternalUrl = null;
        currentSessionId = null;
        boundCwd = null;
        pendingCleanRestart = false;
        try {
          render(statusPage({
            title: loc("DeepSeek Harness unavailable"),
            detail: s.message ? loc(s.message, s.params) : "",
            showRetry: true,
            retryLabel: loc("Retry"),
            lang: vscode.env.language,
          }));
        } catch (_) { /* non-fatal */ }
      } else if (s.state === "stopped") {
        // Command-visible result of dsh.stopServer (and of a close-policy
        // stop): update the status bar and, when the view is still open,
        // show a stopped page with a Retry action.
        setStatusBar("$(circle-slash) " + loc("DSH: stopped"));
        render(statusPage({
          title: loc("DeepSeek Harness stopped"),
          detail: "",
          showRetry: true,
          retryLabel: loc("Retry"),
          lang: vscode.env.language,
        }));
      } else if (s.state === "ready") {
        const mode = loc(s.server && s.server.owned ? "managed" : "reused");
        setStatusBar("$(radio-tower) " + loc("DSH: {port} ({mode})", { port: String(s.server ? s.server.port : "?"), mode }));
      }
    },
  });
  services.manager = manager;
  // Prune dead registry entries (best effort). NEVER kills live instances —
  // they may belong to another VS Code window with its own workspace.
  try {
    ServerManager.cleanupStaleRegistry(hostContext.registryFilePath());
  } catch (_) { /* best effort */ }
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => scheduleRebind(context)),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      notifyActiveEditorChanged(editor);
      scheduleRebind(context);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("dsh.host") ||
        e.affectsConfiguration("dsh.port") ||
        e.affectsConfiguration("dsh.autoStart") ||
        e.affectsConfiguration("dsh.closePolicy") ||
        e.affectsConfiguration("dsh.runtime.manifestUrl") ||
        e.affectsConfiguration("dsh.runtime.version") ||
        e.affectsConfiguration("dsh.local.packageRoot") ||
        e.affectsConfiguration("dsh.local.nodePath")
        || e.affectsConfiguration("dsh.home.mode")
        || e.affectsConfiguration("dsh.home.path")
        || e.affectsConfiguration("dsh.profile")
      ) {
        scheduleConfigReconcile(context);
      }
    })
  );
  return () => {
    // deactivate: workspace binding is disposed last (reverse of setup order).
    workspaceBinding?.dispose?.();
    workspaceBinding = null;
  };
}

/**
 * R25: L0 core-sidebar. WebviewViewProvider registration (VIEW_ID is a
 * persistent contract), webviewHtml/webviewMessages, status/error pages,
 * versioned bridge + CH1 notifier, and the
 * dsh.focusSidebar/newSession/switchSession/openInBrowser/capabilities/
 * diagnose/cleanupOrphans commands (commands themselves register in
 * registerFeatureCommands to keep the legacy physical order).
 */
async function setupCoreSidebar({ context, services }) {
  interactionHandlers = [];
  editorContext = createEditorContext({
    vscode,
    onChange: (payload) => {
      // versionedBridge is assigned later in activation; command-triggered
      // changes always arrive after it exists. A missing bridge is a no-op.
      try {
        versionedBridge?.notify('vscode/contextChanged', payload);
      } catch (_) { /* notification is advisory; requests stay authoritative */ }
    },
  });
  services.editorContext = editorContext;
  const extensionBridgeHandlers = injectedDependencies.extensionBridgeHandlers === undefined
    ? createExtensionBridgeHandlers({ vscode })
    : injectedDependencies.extensionBridgeHandlers;
  const versionedBridgeStarter = injectedDependencies.startVersionedBridge
    || (async (options) => new VersionedBridgeServer(options).start());
  versionedBridge = await versionedBridgeStarter({
    handlers: injectedDependencies.vscodeBridgeHandlers === undefined
      ? { ...editorContext.handlers, ...extensionBridgeHandlers }
      : injectedDependencies.vscodeBridgeHandlers,
    workspace: createBridgeWorkspaceIdentity(vscode, context),
    serverVersion: require('../package.json').version,
  });
  if (versionedBridge.env) {
    Object.assign(services.bridgeEnv, versionedBridge.env);
  }
  services.manager?.setSpawnEnv?.(versionedBridge.env || {});
  notificationNotifier = createNotifier({
    send: (method, params) => {
      versionedBridge?.notify?.(method, params);
    },
  });
  context.subscriptions.push({
    dispose() {
      for (const disposable of notificationSubscriptions) {
        disposable?.dispose?.();
      }
      notificationSubscriptions = [];
      notificationNotifier?.dispose();
      notificationNotifier = null;
      versionedBridge?.close().catch(() => {});
    },
  });
  const provider = {
    resolveWebviewView(view) {
      // VS Code shows "Error restoring view: <id>" whenever this function
      // throws or rejects, so it must never propagate an exception.
      try {
        const resolvedViewGeneration = ++viewGeneration;
        currentView = view;
        view.webview.options = { enableScripts: true };
        // Synchronous first paint: the webview always has content, even if
        // the async connect below fails later.
        view.webview.html = statusPage({ title: loc("Connecting to DeepSeek Harness…"), detail: "", lang: vscode.env.language });
        // NOTE: onDidReceiveMessage lives on the Webview, not the WebviewView.
        view.webview.onDidReceiveMessage(createWebviewMessageHandler({
          openBrowser: () => {
            // The status page also renders after a failed connect; in that
            // state currentServer is null but currentExternalUrl points at
            // the configured endpoint, so keep this handler usable there.
            const candidate = currentExternalUrl && safeHttpUrl(currentExternalUrl);
            if (candidate && candidate !== "about:blank") {
              vscode.env.openExternal(vscode.Uri.parse(candidate));
            }
          },
          retry: () => {
            if (pendingCleanRestart) {
              pendingCleanRestart = false;
              return lifecycle.enqueue("restart clean", () => restartCleanNow(context)).catch(() => {});
            }
            if (cleanMode && manager?.isCleanMode?.()) {
              return lifecycle.enqueue("restart server", () => restartNormalNow(context)).catch(() => {});
            }
            return scheduleConnect(context, resolvedViewGeneration).catch(() => {});
          },
          interaction: (message) => {
            // Route to the feature-registered interaction handlers
            // (clipboard-bridge, editor-links); a disabled feature simply
            // has no handler and its messages are ignored.
            handleWebviewInteraction(message, view.webview);
          },
          threadResult: (message) => threadAttachmentCoordinator?.handleResult(message),
          handshakeError: (message) => {
            const detail = message && message.error ? message.error : loc("Webview 桥版本不匹配");
            setStatusBar("$(error) " + loc("Webview 桥版本不匹配"), detail);
          },
        }));
        view.onDidDispose(() => {
          if (currentView !== view) return;
          currentView = null;
          viewGeneration += 1; // cancel a delayed connect tied to this view
          lifecycle.enqueue("view-close policy", async () => {
              if (currentView) return; // view re-resolved: never stop under the reopened view
              if (!shouldStopOnViewClose(hostContext.config().closePolicy)) return;
              if (await stopOwnedServer()) {
                currentServer = null;
                currentExternalUrl = null;
                boundCwd = null;
              }
            }).catch(() => {});
        });
        // Run the asynchronous ensure outside the synchronous resolve call.
        // its own errors and only mutates view.webview.html via render().
        setImmediate(() => {
          scheduleConnect(context, resolvedViewGeneration).catch(() => {});
        });
      } catch (err) {
        console.error("dsh-vs-sidebar: resolveWebviewView failed:", err);
      }
    },
  };
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );
  context.subscriptions.push(
    vscode.extensions.onDidChange(() => {
      // Provider install/enable/disable changes refresh the bridge and the
      // DSH capability registry. The bridge is assigned above; a missing
      // bridge is a no-op because the notification is advisory.
      try {
        versionedBridge?.notify('vscode/providerStatesChanged', {
          providers: detectProviderStates({ vscode }),
        });
      } catch (_) { /* notification is advisory; requests stay authoritative */ }
    }),
  );

  // CH1 v2 metadata notifications: selection and diagnostics are advisory and
  // only relevant for URIs that already have approved attachments. Disposables
  // are kept out of context.subscriptions only to preserve the existing public
  // subscription count; the feature teardown always cleans them up.
  notificationSubscriptions = [
    vscode.window.onDidChangeTextEditorSelection?.(notifySelectionChanged),
    vscode.languages?.onDidChangeDiagnostics?.(notifyDiagnosticsChanged),
  ].filter(Boolean);
  return async () => {
    for (const disposable of notificationSubscriptions) {
      disposable?.dispose?.();
    }
    notificationSubscriptions = [];
    notificationNotifier?.dispose();
    notificationNotifier = null;
    await versionedBridge?.close().catch(() => {});
    versionedBridge = null;
    editorContext = null;
  };
}

/**
 * R25: L1 clipboard-bridge (dsh.features.clipboard-bridge). Embedded copy/
 * paste patching: the iframe clipboard path handled by the interaction bridge
 * (clipboard/writeText) is registered only when this feature is enabled.
 */
async function setupClipboardBridge() {
  const handler = async (message, webview) => {
    const request = parseInteractionRequest(message);
    if (!request || request.method !== 'clipboard/writeText') return false;
    return handleInteractionRequest({ vscode, webview, message });
  };
  interactionHandlers.push(handler);
  return () => {
    interactionHandlers = interactionHandlers.filter((h) => h !== handler);
  };
}

/**
 * R25: L1 thread-attachment (dsh.features.thread-attachment). The owning-
 * window request/ack coordinator backing dsh.addActiveFile/addActiveSelection/
 * addSelectionToThread/addFileToThread/addProblems (command registration is
 * gated in registerFeatureCommands).
 */
async function setupThreadAttachment({ context }) {
  threadAttachmentCoordinator = new ThreadAttachmentCoordinator();
  context.subscriptions.push({ dispose() { threadAttachmentCoordinator?.dispose(); } });
  return () => {
    threadAttachmentCoordinator?.dispose();
    threadAttachmentCoordinator = null;
  };
}

/**
 * R25: L1 editor-links (dsh.features.editor-links). textDocumentBridge
 * (Read… opens in this window) plus draft-link handling: link/open and
 * attachment/open interaction methods through editorContext.openAttachment.
 * Publishes its bridge env into the shared bag so the L0 ServerManager spawns
 * its child with the token (the child is only spawned later by connectNow).
 */
async function setupEditorLinks({ context, services }) {
  const bridgeStarter = injectedDependencies.startTextDocumentBridge || startTextDocumentBridge;
  textDocumentBridge = await bridgeStarter({
    openTextDocument: async (absolutePath) => {
      if (typeof absolutePath !== "string" || !path.isAbsolute(absolutePath)) {
        throw new Error("Text document bridge requires an absolute path");
      }
      if (vscode.workspace.isTrusted === false) {
        throw new Error("Text document bridge requires a trusted workspace");
      }
      // Shared DSH homes intentionally expose older sessions whose cwd may be
      // outside the folder currently open in this VS Code window. The bridge
      // is loopback-only and authenticated with a per-process bearer token
      // known only to this extension-owned DSH child, so retain the absolute
      // path and workspace-trust gates without rejecting shared-session files.
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath));
      await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
    },
  });
  context.subscriptions.push({
    dispose() {
      textDocumentBridge?.close().catch(() => {});
    },
  });
  if (textDocumentBridge.env) {
    Object.assign(services.bridgeEnv, textDocumentBridge.env);
  }
  services.manager?.setSpawnEnv?.(textDocumentBridge.env || {});
  const handler = async (message, webview) => {
    const request = parseInteractionRequest(message);
    if (!request || request.method === 'clipboard/writeText') return false;
    return handleInteractionRequest({
      vscode,
      webview,
      message,
      openAttachment: (attachmentId) => services.editorContext?.openAttachment(attachmentId),
    });
  };
  interactionHandlers.push(handler);
  return async () => {
    interactionHandlers = interactionHandlers.filter((h) => h !== handler);
    await textDocumentBridge?.close().catch(() => {});
    textDocumentBridge = null;
  };
}

/**
 * R25/R12: L1 theme-follow (dsh.features.theme-follow). Follows the VS Code
 * active color theme: the initial theme is stamped on the iframe URL via
 * `dsh_theme`, and every onDidChangeActiveColorTheme event is pushed through
 * the existing webview message channel (`dshThemeChanged`) so the shell can
 * forward it to the DSH iframe without reloading. When the API is unavailable
 * (test/legacy hosts) the setup degrades to a no-op subscription so the
 * feature lifecycle still participates in context.subscriptions.
 */
async function setupThemeFollow({ context }) {
  const initialTheme = themeFromColorThemeKind(vscode.window.activeColorTheme);
  if (initialTheme) {
    currentDshTheme = initialTheme;
  }
  let themeListener = null;
  if (typeof vscode.window.onDidChangeActiveColorTheme === 'function') {
    themeListener = vscode.window.onDidChangeActiveColorTheme((theme) => {
      const nextTheme = themeFromColorThemeKind(theme);
      if (!nextTheme) return;
      currentDshTheme = nextTheme;
      try {
        currentView?.webview?.postMessage?.({ type: DSH_THEME_CHANGED, theme: nextTheme });
      } catch (_) { /* theme notification is advisory */ }
    });
  }
  const subscription = { dispose() { themeListener?.dispose?.(); } };
  context.subscriptions.push(subscription);
  return () => {
    themeListener?.dispose?.();
    currentDshTheme = null;
  };
}

/**
 * R25: L1 statusbar-basic (dsh.features.statusbar-basic). The status bar
 * indicator item is created here and eagerly, so setStatusBar() merely
 * updates it; when the feature is off/failed, setStatusBar falls back to a
 * bare L0 item (the $(error) lifeline survives).
 */
async function setupStatusbarBasic() {
  if (typeof vscode.window.createStatusBarItem === 'function') {
    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  }
  return () => {
    try {
      statusBar?.dispose?.();
    } catch (_) {
      // status bar disposal is best-effort during extension shutdown
    }
    statusBar = null;
  };
}

/**
 * Route one webview interaction message to the feature-registered interaction
 * handlers. Each handler inspects the message and returns true when it took
 * the request; unknown messages stay ignored (same as the pre-R25 router,
 * where handleInteractionRequest returned false for unmatched methods).
 */
async function handleWebviewInteraction(message, webview) {
  for (const handler of interactionHandlers) {
    try {
      if (await handler(message, webview)) return;
    } catch (error) {
      console.error('dsh-vs-sidebar: Webview interaction bridge failed:', error);
    }
  }
}

/**
 * Register the dsh.* command surface.
 *
 * The registration ORDER below is a frozen legacy contract:
 * test/extension.test.js asserts `[...commands.keys()]` deep-equals the
 * pre-R25 single-push physical order (openInBrowser → restart/stop → add* →
 * newSession…cleanupOrphans). The R25 layer model executes each feature's
 * setup contiguously and cannot reproduce that interleave, so commands stay
 * in this one orchestrator block, gated per owning feature by its setup
 * status — a disabled/failed feature simply skips its commands.
 *
 * @param {object} context - ExtensionContext.
 * @param {Set<string>} featureOk - ids whose setup reported status 'ok'.
 */
function registerFeatureCommands(context, featureOk) {
  /** Run one user-triggered editor attachment and surface its outcome. */
  function runEditorAttachment(attach, successTemplate) {
    try {
      const attachment = attach();
      vscode.window.showInformationMessage(loc(successTemplate, { kind: attachment.kind }));
    } catch (err) {
      vscode.window.showErrorMessage(loc("Editor context attach failed: {message}", {
        message: err && err.message ? err.message : String(err),
      }));
    }
  }

  const registered = [];

  if (featureOk.has('core-sidebar')) {
    registered.push(
    vscode.commands.registerCommand("dsh.openInBrowser", async () => {
      return lifecycle.enqueue("open in browser", async () => {
        if (!currentServer) await connectNow(context);
        if (!currentServer) {
          vscode.window.showErrorMessage(loc("DSH: unavailable"));
          return;
        }
        if (currentExternalUrl) {
          await vscode.env.openExternal(vscode.Uri.parse(currentExternalUrl));
        }
      });
    }),
    );
  }

  if (featureOk.has('core-server')) {
    registered.push(
    vscode.commands.registerCommand("dsh.restartServer", () => lifecycle.enqueue("restart server", async () => {
      if (currentServer && currentServer.owned !== true && !manager.hasOwnedChild()) {
        vscode.window.showInformationMessage(loc("The running DSH server is reused and cannot be restarted by this extension"));
        return;
      }
      clearCleanMode(); // Restart-normal clears any clean-restart flag
      await reconnectNow(context);
    })),
    vscode.commands.registerCommand("dsh.stopServer", () => lifecycle.enqueue("stop server", async () => {
      // Stops ONLY a process this extension instance spawned and owns. A
      // reused external server (found already running and adopted) is never
      // killed — the pure decision function is self-tested in serverManager.js.
        if (!manager.hasOwnedChild()) {
          vscode.window.showInformationMessage(loc("No DSH server is owned by this extension"));
          return;
        }
        await stopOwnedServer();
        currentServer = null;
        currentExternalUrl = null;
        currentSessionId = null;
        boundCwd = null;
        vscode.window.showInformationMessage(loc("DSH server stopped"));
      })),
    );
  }

  if (featureOk.has('thread-attachment')) {
  // 0.6 command shell: this batch wires only dsh.addFileToThread through the
  // router gate. Existing commands stay direct until the later migration batch.
  const commandShell = createCommandShell({
    router: {
      get(capabilityId) {
        return capabilityId === 'dsh.addFileToThread' ? { id: 'dsh.addFileToThread' } : NullAdapter;
      },
    },
  });
    registered.push(
    vscode.commands.registerCommand("dsh.addActiveFile", () => {
      runEditorAttachment(() => editorContext.attachActiveFile(), "Editor context attached ({kind})");
    }),
    vscode.commands.registerCommand("dsh.addActiveSelection", () => {
      runEditorAttachment(() => editorContext.attachActiveSelection(), "Editor context attached ({kind})");
    }),
    vscode.commands.registerCommand("dsh.addSelectionToThread", async () => {
      try {
        const attachment = editorContext.attachActiveSelection();
        await vscode.commands.executeCommand("workbench.view.extension." + CONTAINER_ID);
        await vscode.commands.executeCommand(VIEW_ID + ".focus");
        const view = await waitForResolvedView();
        if (!view) throw new Error(loc("DSH sidebar is unavailable"));
        if (!currentServer) await scheduleConnect(context);
        if (!currentServer) throw new Error(loc("DSH: unavailable"));
        const text = formatSelectionAttachment(attachment, attachment.document.uri);
        await threadAttachmentCoordinator.request(view.webview, text);
        vscode.window.showInformationMessage(loc("Selection added to the DSH conversation"));
      } catch (err) {
        vscode.window.showErrorMessage(loc("Add to DSH conversation failed: {message}", {
          message: err && err.message ? err.message : String(err),
        }));
      }
    }),
    commandShell.register(
      vscode,
      "dsh.addFileToThread",
      "dsh.addFileToThread",
      createAddFileToThreadCommand({
        vscode,
        editorContext,
        coordinator: threadAttachmentCoordinator,
        formatFileAttachment,
        waitForResolvedView,
        ensureConnected: async () => {
          if (!currentServer) await scheduleConnect(context);
          return Boolean(currentServer);
        },
        loc,
      })
    ),
    vscode.commands.registerCommand("dsh.addFolderToThread", createAddFolderToThreadCommand({
      vscode,
      editorContext,
      coordinator: threadAttachmentCoordinator,
      formatFolderAttachment,
      waitForResolvedView,
      ensureConnected: async () => {
        if (!currentServer) await scheduleConnect(context);
        return Boolean(currentServer);
      },
      loc,
    })),
    vscode.commands.registerCommand("dsh.addProblems", () => {
      runEditorAttachment(() => editorContext.attachProblems(), "Editor context attached ({kind})");
    }),
    );
  }

  if (featureOk.has('core-sidebar')) {
    registered.push(
    vscode.commands.registerCommand("dsh.newSession", () => lifecycle.enqueue("new session", async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      try {
        if (!currentServer) await connectNow(context);
        if (!currentServer) {
          vscode.window.showErrorMessage(loc("Session command failed: {message}", {
            message: loc("DSH: unavailable"),
          }));
          return;
        }
        // Session API calls must use the raw loopback URL, never the
        // externalized (port-forwarded) client URL.
        const baseUrl = currentServer.url;
        const items = await listSessions(baseUrl, { signal: controller.signal });
        const reused = reuseBlankSession(items, boundCwd);
        const sessionId = reused || await createSession(baseUrl, {
          cwd: boundCwd,
          signal: controller.signal,
        });
        currentSessionId = sessionIdFromValue(sessionId);
        renderFrame(context);
        vscode.window.showInformationMessage(loc("Session created: {sessionId}", { sessionId }));
      } catch (err) {
        vscode.window.showErrorMessage(loc("Session command failed: {message}", {
          message: err && err.message ? err.message : String(err),
        }));
      } finally {
        clearTimeout(timer);
      }
    })),
    vscode.commands.registerCommand("dsh.switchSession", () => lifecycle.enqueue("switch session", async () => {
      try {
        if (!currentServer) await connectNow(context);
        if (!currentServer) {
          vscode.window.showErrorMessage(loc("Session command failed: {message}", {
            message: loc("DSH: unavailable"),
          }));
          return;
        }
        const baseUrl = currentServer.url;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 6000);
        let items;
        try {
          items = await listSessions(baseUrl, { signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }
        const rows = rootSessionItems(items);
        if (rows.length === 0) {
          vscode.window.showInformationMessage(loc("No sessions available"));
          return;
        }
        const selected = await showSessionQuickPick(vscode, rows, {
          placeholder: loc("Switch Session"),
        });
        if (selected && selected.sessionId) {
          currentSessionId = sessionIdFromValue(selected.sessionId);
          renderFrame(context);
          vscode.window.showInformationMessage(loc("Session switched: {sessionId}", {
            sessionId: selected.sessionId,
          }));
        }
      } catch (err) {
        vscode.window.showErrorMessage(loc("Session command failed: {message}", {
          message: err && err.message ? err.message : String(err),
        }));
      }
    })),
    vscode.commands.registerCommand("dsh.focusSidebar", async () => {
      await vscode.commands.executeCommand("workbench.view.extension." + CONTAINER_ID);
      await vscode.commands.executeCommand(VIEW_ID + ".focus");
    }),
    vscode.commands.registerCommand("dsh.capabilities", async () => {
      // The capability center itself is rendered by the DSH web UI in the
      // sidebar; this command only reveals the sidebar and points the user
      // at it. No fake UI is rendered from the extension host.
      await vscode.commands.executeCommand("workbench.view.extension." + CONTAINER_ID);
      await vscode.commands.executeCommand(VIEW_ID + ".focus");
      vscode.window.showInformationMessage(loc("Open the Capabilities center in the DSH sidebar"));
    }),
    vscode.commands.registerCommand("dsh.diagnose", async () => {
      try {
        const snapshot = diagnosticSnapshot({
          vscode,
          config: hostContext.config(),
          server: currentServer,
          bridge: versionedBridge,
          home: activeDshHomeInfo,
          binding: workspaceBinding && workspaceBinding.state() || null,
        });
        const installed = snapshot.providers.filter((provider) => provider.installed).length;
        snapshot.featureFailures = featureFailures.slice();
        const failuresSuffix = featureFailures.length === 0
          ? ""
          : " — " + loc("Degraded features: {items}", {
            items: featureFailures.map((f) => f.id + ": " + f.error).join(" | "),
          });
        const startupTableSuffix = "\n\n" + localizedStartupErrorTable();
        const selfHealSuffix = selfHealEvents.length === 0
          ? ""
          : " — " + loc("Self-healed without --patch: {count} time(s)", { count: String(selfHealEvents.length) });
        const hostCapabilities = deriveVscodeCapabilities(vscode.version);
        const hostVersion = typeof vscode.version === 'string' && vscode.version.length > 0
          ? vscode.version
          : 'unknown';
        const capabilityText = "chat=" + (hostCapabilities.chatParticipant ? "yes" : "no")
          + ", lm=" + (hostCapabilities.lmProvider ? "yes" : "no")
          + ", mcp=" + (hostCapabilities.mcpServerDefinitions ? "yes" : "no");
        vscode.window.showInformationMessage(loc(
          "DSH diagnose: host {hostVersion} ({capabilities}), home {homeMode} ({homePath}), server {server}, bridge {bridge}, catalog {catalog}, providers {installed}/{total} installed",
          {
            hostVersion,
            capabilities: capabilityText,
            homeMode: snapshot.home.mode,
            homePath: snapshot.home.path,
            server: snapshot.server.available ? loc("running") : loc("stopped"),
            bridge: snapshot.bridge.listening ? loc("listening") : loc("closed"),
            catalog: String(snapshot.catalogRevision).slice(0, 8),
            installed: String(installed),
            total: String(snapshot.providers.length),
          }
        ) + failuresSuffix + startupTableSuffix + selfHealSuffix);
      } catch (err) {
        vscode.window.showErrorMessage(loc("DSH diagnose failed: {message}", {
          message: err && err.message ? err.message : String(err),
        }));
      }
    }),
    vscode.commands.registerCommand("dsh.cleanupOrphans", createCleanupOrphansCommand({
      vscode,
      registryFilePath: () => hostContext.registryFilePath(),
      listAliveEntries: (file) => ServerManager.aliveRegistryEntries(file),
      probeEntry: (host, port) => manager.probeWithRetry(host, port, { attempts: 2, delayMs: 300 }),
      terminate: (pid) => killProcessTree(pid),
      removeEntries: (file, pids) => ServerManager.removeRegistryEntries(file, pids),
      ownedPid: () => manager.currentChildPid(),
      loc,
    }))
    );
  }

  if (featureOk.has('core-server')) {
    registered.push(
    vscode.commands.registerCommand("dsh.restartClean", () => lifecycle.enqueue("restart clean", async () => {
      if (currentServer && currentServer.owned !== true && !manager.hasOwnedChild()) {
        vscode.window.showInformationMessage(loc("The running DSH server is reused and cannot be restarted by this extension"));
        return;
      }
      await restartCleanNow(context);
    }))
    );
  }

  context.subscriptions.push(...registered);
}

async function activateWithDependencies(context, dependencies = {}) {
  vscode = createVscodeFacade(dependencies.vscode || require("vscode"));
  hostContext = createWorkspaceContext(vscode, context);
  injectedDependencies = dependencies || {};

  // Display-only host capability matrix. This warning is intentionally not a
  // behavior gate: the extension keeps its engines floor and does not use
  // these booleans to enable/disable any API path.
  const hostCapabilities = deriveVscodeCapabilities(vscode.version);
  if (typeof vscode.version === 'string' && vscode.version.length > 0) {
    const missing = [];
    if (!hostCapabilities.chatParticipant) missing.push('chatParticipant');
    if (!hostCapabilities.lmProvider) missing.push('lmProvider');
    if (!hostCapabilities.mcpServerDefinitions) missing.push('mcpServerDefinitions');
    if (missing.length > 0) {
      console.warn(
        `dsh-vs-sidebar: VS Code ${vscode.version} does not expose optional DSH integration APIs (${missing.join(', ')}); upgrade to VS Code 1.105+ for the full capability set.`
      );
    }
  }

  const services = {};
  featureFailures = [];
  selfHealEvents = [];
  cleanMode = false;
  cleanPatchPath = null;
  pendingCleanRestart = false;

  registry = null;
  try {
    registry = createFeatureRegistry({
      getFeatureSetting: (id) => {
        try {
          return vscode.workspace.getConfiguration('dsh').get('features.' + id);
        } catch (_) {
          return undefined; // an inert workspace config falls back to defaultEnabled
        }
      },
      onFeatureFailure: (record) => {
        const label = (FEATURE_CATALOG.find((feature) => feature.id === record.id) || {}).label || record.id;
        vscode.window.showWarningMessage(loc("Feature {label} failed: {error}", {
          label,
          error: record.error,
        }));
      },
    });
    for (const feature of FEATURE_CATALOG) {
      registry.register(feature);
    }
    const setupResults = await registry.setupAll({ context, services });
    featureFailures = Array.isArray(registry.failures) ? registry.failures.slice() : [];
    const featureOk = new Set(setupResults.filter((record) => record.status === 'ok').map((record) => record.id));
    registerFeatureCommands(context, featureOk);
  } catch (err) {
    // The registry isolates per-feature failures; this catch is only for
    // assembly-level bugs. The extension must never throw out of activate.
    console.error('dsh-vs-sidebar: feature assembly failed:', err);
    featureFailures = Array.isArray(registry?.failures) ? registry.failures.slice() : featureFailures;
  }

  // autoStart at VS Code startup: activate even when the sidebar view is never
  // opened. connectNow() is null-safe — no WebviewView resolved yet is fine, the
  // server is still ensured and the view (resolved later) shows it via a fresh
  // queued ensure. Default autoStart gives this extension host its own child;
  // reuse is available only when autoStart is explicitly disabled.
  lastConfig = hostContext.config();
  if (lastConfig.autoStart) {
    setImmediate(() => {
      scheduleConnect(context).catch(() => {});
    });
  }
}

async function activate(context) {
  return activateWithDependencies(context);
}

async function deactivate() {
  // On VS Code exit, stop only an owned process — and honor the close policy:
  // `never` intentionally leaves even an owned process running for explicit
  // user-managed operation. Other policies stop our child.
  lifecycle?.stopAccepting?.();
  runtimeAbort?.abort?.(); // cancel only in-flight provisioning; never touches a ready owned child
  viewGeneration += 1;
  try {
    if (!manager) return undefined;
    if (normalizeClosePolicy(hostContext.config().closePolicy) === CLOSE_POLICIES.NEVER) {
      await lifecycle.wait();
      return undefined;
    }

    // Prevent probe/port-scan work from spawning after shutdown begins. If a
    // child already exists, stopping it also makes an in-flight health wait
    // settle promptly instead of delaying deactivation for the full timeout.
    manager.cancelPending();
    if (manager.hasOwnedChild()) {
      await manager.stop();
    }
    await lifecycle.wait();
    if (manager.hasOwnedChild()) {
      await manager.stop();
    }
    return undefined;
  } finally {
    // R25: feature teardowns run in reverse setup order; per-teardown
    // failures are contained inside the registry (dispose never throws).
    if (registry) {
      try {
        await registry.dispose();
      } catch (err) {
        console.error('dsh-vs-sidebar: feature registry dispose failed:', err);
      }
    }
    currentView = null;
    currentServer = null;
    currentExternalUrl = null;
    currentSessionId = null;
    currentDshTheme = null;
    boundCwd = null;
  }
}

module.exports = { activate, deactivate, activateWithDependencies, isRetryableStartupError, themeFromColorThemeKind, FEATURE_CATALOG };
