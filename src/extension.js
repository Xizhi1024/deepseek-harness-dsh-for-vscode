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
  normalizeClosePolicy,
  shouldStopOnViewClose,
  reconcileConfigChange,
} = require("./serverManager");
const { ensureManagedRuntime } = require("./runtimeProvisioner");
const { resolveLocalDshRuntime } = require("./localRuntimeResolver");
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
const { VersionedBridgeServer } = require("./versionedBridgeServer");
const { createBridgeWorkspaceIdentity } = require("./bridgeWorkspace");
const { DEFAULT_HOST, DEFAULT_PORT, VIEW_ID, CONTAINER_ID } = require("./types");
const { createVscodeFacade } = require("./vscodeFacade");
const { createWebviewMessageHandler } = require("./webviewMessages");
const { createWorkspaceContext } = require("./workspaceContext");
const { createEditorContext } = require("./editorContext");
const {
  createExtensionBridgeHandlers,
  detectProviderStates,
  diagnosticSnapshot,
} = require("./providerDetector");
const { writeEmbedOverlay } = require("./embedOverlay");
const { LifecycleQueue } = require("./lifecycle");

let vscode = null; // injected during activation; avoids loading vscode in node:test
let hostContext = null; // workspace/config facade bound during activation
let manager = null; // ServerManager instance (created in activate)
let currentServer = null; // RunningServer | null
let currentExternalUrl = null; // client-reachable URL (forwarded in remote workspaces)
let currentSessionId = null; // DSH session id to pass to the iframe (dsh_session)
let currentView = null; // vscode.WebviewView | null
let statusBar = null; // vscode.StatusBarItem | null
let boundCwd = null; // workspace root the current server is bound to (null = none)
let lastConfig = null; // last config snapshot used for change detection (reconciler)
let lifecycle = null; // the one queue for every lifecycle transition
let viewGeneration = 0; // invalidates delayed connects for disposed/replaced views
let textDocumentBridge = null; // per-window authenticated DSH -> vscode.window bridge
let versionedBridge = null; // per-window versioned JSON-RPC bridge
let editorContext = null; // per-window approved editor attachments backing vscode/editor methods
let embedPatchPath = null; // generated --patch overlay applied to extension-owned DSH children
let runtimeStorageRoot = null; // managed runtime storage under VS Code global storage
let localDshHome = null; // persistent extension-owned .dsh configuration home
let ensureRuntime = null; // resolves/verifies (and optionally provisions) the managed runtime
let ensureWorkspaceSessionFn = null; // owned-instance automatic workspace session binding
let runtimeAbort = new AbortController(); // cancels in-flight runtime provisioning on deactivate

/**
 * Localize a template with params. Templates are English by default and are
 * translated through the l10n bundle (l10n/bundle.l10n.*.json) according to
 * the VS Code display language — one source of truth, no mixed languages.
 */
function loc(template, params) {
  return vscode.l10n.t(template, params || {});
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
  // Owned instances are automatically bound to the current workspace root.
  // Reused external instances are never touched. Binding is best-effort:
  // failures/timeouts must not make the overall connect fail.
  if (server.owned && cwd && !currentSessionId) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const sessionId = await ensureWorkspaceSessionFn(server.url, cwd, { signal: controller.signal });
      currentSessionId = sessionIdFromValue(sessionId);
    } catch (err) {
      console.warn('dsh-vs-sidebar: auto workspace binding skipped:', err && err.message ? err.message : err);
    } finally {
      clearTimeout(timer);
    }
  }
  const url = await externalize(server.url);
  currentExternalUrl = url;
  const mode = loc(server.owned ? "managed" : "reused");
  setStatusBar(
      "$(radio-tower) " + loc("DSH: {port} ({mode})", { port: String(server.port), mode }),
      loc("DSH server: {url}", { url: server.url }) + (cwd ? " | " + loc("workspace: {cwd}", { cwd }) : "")
  );
  renderFrame(context);
}

async function connectNow(context) {
  try {
    const cfg = hostContext.config();
    const cwd = hostContext.workspaceCwd();
    setStatusBar("$(radio-tower) " + loc("DSH: connecting…"));
    render(statusPage({ title: loc("Connecting to DeepSeek Harness…"), detail: "", lang: vscode.env.language }));

    let server = null;
    // autoStart uses the locally installed official DSH package by default and
    // an explicitly configured verified release manifest as an opt-in path.
    // Both launch with the extension-owned persistent .dsh home and web profile.
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
          dshHome: localDshHome,
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
      try {
        render(statusPage({
          title: loc("DeepSeek Harness unavailable"),
          detail: err && err.template ? loc(err.template, err.params) : String(err && err.message ? err.message : err),
          url,
          showOpenBrowser: Boolean(currentExternalUrl),
          showRetry: true,
          openBrowserLabel: loc("Open in browser"),
          retryLabel: loc("Retry"),
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

  await stopOwnedServer();
  currentServer = null;
  currentExternalUrl = null;
  currentSessionId = null;
  boundCwd = cwd;
  // Approved editor attachments are workspace-scoped; a root change must
  // never leak the previous workspace's content into the new DSH instance.
  editorContext?.clearAttachments();
  render(statusPage({
    title: loc("Connecting to DeepSeek Harness…"),
    detail: loc("Workspace changed — rebinding to the new workspace…"),
    lang: vscode.env.language,
  }));
  await connectNow(context);
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
async function activateWithDependencies(context, dependencies = {}) {
  vscode = createVscodeFacade(dependencies.vscode || require("vscode"));
  hostContext = createWorkspaceContext(vscode, context);
  lifecycle = new LifecycleQueue();
  try {
    runtimeAbort?.abort?.();
  } catch {
    // ignore stale controller abort errors during repeated activation
  }
  runtimeAbort = new AbortController();
  const realpath = dependencies.realpath || require('node:fs').promises.realpath;
  runtimeStorageRoot = path.join(context.globalStorageUri.fsPath, 'runtime');
  localDshHome = path.join(context.globalStorageUri.fsPath, '.dsh');
  ensureRuntime = dependencies.ensureRuntime
    || dependencies.ensureManagedRuntime
    || ((options) => options.manifestUrl
      ? ensureManagedRuntime(options)
      : resolveLocalDshRuntime(options));
  ensureWorkspaceSessionFn = dependencies.ensureWorkspaceSession || ensureWorkspaceSession;
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
  try {
    embedPatchPath = writeEmbedOverlay(context.globalStorageUri.fsPath);
  } catch (err) {
    console.error('dsh-vs-sidebar: could not write embed overlay; starting without --patch:', err);
    embedPatchPath = null;
  }
  const bridgeStarter = dependencies.startTextDocumentBridge || startTextDocumentBridge;
  textDocumentBridge = await bridgeStarter({
    openTextDocument: async (absolutePath) => {
      if (typeof absolutePath !== "string" || !path.isAbsolute(absolutePath)) {
        throw new Error("Text document bridge requires an absolute path");
      }
      if (vscode.workspace.isTrusted === false) {
        throw new Error("Text document bridge requires a trusted workspace");
      }
      const folders = vscode.workspace.workspaceFolders;
      if (!Array.isArray(folders) || folders.length === 0) {
        throw new Error("Text document bridge requires an open workspace folder");
      }
      const resolved = path.resolve(absolutePath);
      // Resolve symlinks before the containment check: a path that lexically
      // looks like it is inside the workspace must not escape through a link
      // to another directory (e.g. a workspace symlink pointing outside).
      let candidateReal = resolved;
      try {
        candidateReal = await realpath(resolved);
      } catch {
        const parentReal = await realpath(path.dirname(resolved)).catch(() => path.resolve(path.dirname(resolved)));
        candidateReal = path.join(parentReal, path.basename(resolved));
      }
      let insideWorkspace = false;
      for (const folder of folders) {
        const folderPath = folder && folder.uri && folder.uri.fsPath
          ? folder.uri.fsPath
          : null;
        if (!folderPath) continue;
        let folderReal = path.resolve(folderPath);
        try {
          folderReal = await realpath(folderPath);
        } catch {
          folderReal = path.resolve(folderPath);
        }
        const relative = path.relative(folderReal, candidateReal);
        if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
          insideWorkspace = true;
          break;
        }
      }
      if (!insideWorkspace) {
        throw new Error(`Refusing to open path outside the workspace: ${absolutePath}`);
      }
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath));
      await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
    },
  });
  context.subscriptions.push({
    dispose() {
      textDocumentBridge?.close().catch(() => {});
    },
  });
  const extensionBridgeHandlers = dependencies.extensionBridgeHandlers === undefined
    ? createExtensionBridgeHandlers({ vscode })
    : dependencies.extensionBridgeHandlers;
  const versionedBridgeStarter = dependencies.startVersionedBridge
    || (async (options) => new VersionedBridgeServer(options).start());
  versionedBridge = await versionedBridgeStarter({
    handlers: dependencies.vscodeBridgeHandlers === undefined
      ? { ...editorContext.handlers, ...extensionBridgeHandlers }
      : dependencies.vscodeBridgeHandlers,
    workspace: createBridgeWorkspaceIdentity(vscode, context),
    serverVersion: require('../package.json').version,
  });
  context.subscriptions.push({
    dispose() {
      versionedBridge?.close().catch(() => {});
    },
  });
  const createServerManager = dependencies.createServerManager
    || ((options) => new ServerManager(options));
  manager = createServerManager({
    spawnEnv: { ...textDocumentBridge.env, ...versionedBridge.env },
    embedPatchPath,
    onStatus: (s) => {
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

  // Prune dead registry entries (best effort). NEVER kills live instances —
  // they may belong to another VS Code window with its own workspace.
  try {
    ServerManager.cleanupStaleRegistry(hostContext.registryFilePath());
  } catch (_) { /* best effort */ }

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
          retry: () => scheduleConnect(context, resolvedViewGeneration).catch(() => {}),
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

  context.subscriptions.push(
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
    vscode.commands.registerCommand("dsh.restartServer", () => lifecycle.enqueue("restart server", async () => {
      if (currentServer && currentServer.owned !== true && !manager.hasOwnedChild()) {
        vscode.window.showInformationMessage(loc("The running DSH server is reused and cannot be restarted by this extension"));
        return;
      }
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
    vscode.commands.registerCommand("dsh.addActiveFile", () => {
      runEditorAttachment(() => editorContext.attachActiveFile(), "Editor context attached ({kind})");
    }),
    vscode.commands.registerCommand("dsh.addActiveSelection", () => {
      runEditorAttachment(() => editorContext.attachActiveSelection(), "Editor context attached ({kind})");
    }),
    vscode.commands.registerCommand("dsh.addProblems", () => {
      runEditorAttachment(() => editorContext.attachProblems(), "Editor context attached ({kind})");
    }),
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
        });
        const installed = snapshot.providers.filter((provider) => provider.installed).length;
        vscode.window.showInformationMessage(loc(
          "DSH diagnose: server {server}, bridge {bridge}, catalog {catalog}, providers {installed}/{total} installed",
          {
            server: snapshot.server.available ? loc("running") : loc("stopped"),
            bridge: snapshot.bridge.listening ? loc("listening") : loc("closed"),
            catalog: String(snapshot.catalogRevision).slice(0, 8),
            installed: String(installed),
            total: String(snapshot.providers.length),
          }
        ));
      } catch (err) {
        vscode.window.showErrorMessage(loc("DSH diagnose failed: {message}", {
          message: err && err.message ? err.message : String(err),
        }));
      }
    })
  );

  // Follow the workspace: when folders are added/removed or the active
  // editor moves to another root (multi-root), rebind the sidebar to the new
  // root's DSH instance. sameRoot() inside rebindToWorkspace keeps unrelated
  // editor switches (same folder) a no-op.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => scheduleRebind(context)),
    vscode.window.onDidChangeActiveTextEditor(() => scheduleRebind(context)),
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
    // React to dsh.* settings changes (host / port / autoStart / closePolicy /
    // runtime manifest + version) through the serialized reconciler so burst
    // changes never race a restart.
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
      ) {
        scheduleConfigReconcile(context);
      }
    })
  );

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
    await versionedBridge?.close().catch(() => {});
    versionedBridge = null;
    await textDocumentBridge?.close().catch(() => {});
    textDocumentBridge = null;
    try {
      statusBar?.dispose?.();
    } catch {
      // status bar disposal is best-effort during extension shutdown
    }
    statusBar = null;
    currentView = null;
    currentServer = null;
    currentExternalUrl = null;
    currentSessionId = null;
    boundCwd = null;
  }
}

module.exports = { activate, deactivate, activateWithDependencies };
