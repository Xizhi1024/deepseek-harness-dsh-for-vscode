"use strict";
/**
 * DeepSeek Harness Sidebar — VS Code extension entry point.
 *
 * Wiring layer only:
 *  - reads the dsh.* configuration (host/port/autoStart/closePolicy)
 *  - ensures one window-owned local DSH web server exists (or, when
 *    autoStart is disabled, reuses a user-managed configured endpoint)
 *  - renders the DSH web UI inside the auxiliary-bar webview via an iframe
 *  - provides the openInBrowser / restartServer / stopServer / focusSidebar commands
 *  - starts the server at VS Code startup (onStartupFinished) when autoStart
 *    is on, even if the sidebar view is never opened
 *  - honors a configurable close policy (onVscodeExit / onViewClose / never)
 *    and a single serialized reconciler for config/workspace changes
 *
 * Zero npm dependencies. CommonJS.
 */
const vscode = require("vscode");
const {
  ServerManager,
  CLOSE_POLICIES,
  normalizeClosePolicy,
  shouldStopOnViewClose,
  reconcileConfigChange,
} = require("./serverManager");
const { framePage, statusPage } = require("./webviewHtml");
const { startTextDocumentBridge } = require("./textDocumentBridge");
const { DEFAULT_HOST, DEFAULT_PORT, VIEW_ID, CONTAINER_ID } = require("./types");

let manager = null; // ServerManager instance (created in activate)
let currentServer = null; // RunningServer | null
let currentExternalUrl = null; // client-reachable URL (forwarded in remote workspaces)
let currentView = null; // vscode.WebviewView | null
let statusBar = null; // vscode.StatusBarItem | null
let boundCwd = null; // workspace root the current server is bound to (null = none)
let lastConfig = null; // last config snapshot used for change detection (reconciler)
let lifecycleChain = Promise.resolve(); // the one queue for every lifecycle transition
let viewGeneration = 0; // invalidates delayed connects for disposed/replaced views
let deactivating = false; // prevents new work after extension shutdown begins
let textDocumentBridge = null; // per-window authenticated DSH -> vscode.window bridge

/** Read the user's dsh.* settings. */
function config() {
  const c = vscode.workspace.getConfiguration("dsh");
  return {
    host: c.get("host", DEFAULT_HOST),
    port: c.get("port", DEFAULT_PORT),
    autoStart: c.get("autoStart", true),
    closePolicy: normalizeClosePolicy(c.get("closePolicy")),
  };
}

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
function workspaceCwd() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return null;
  }
  try {
    const active = vscode.window.activeTextEditor;
    if (active && active.document && active.document.uri) {
      const folder = vscode.workspace.getWorkspaceFolder(active.document.uri);
      if (folder) return folder.uri.fsPath;
    }
  } catch (_) { /* fall through to the first workspace folder */ }
  return folders[0].uri.fsPath;
}

/**
 * Shared instances-registry location. All VS Code windows record their owned
 * children for stale-entry cleanup and diagnostics; default autoStart mode
 * never adopts an entry written by another window.
 */
function registryFilePath(context) {
  return vscode.Uri.joinPath(context.globalStorageUri, "dsh-instances.json").fsPath;
}

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
function enqueueLifecycle(label, operation) {
  if (deactivating) return Promise.resolve(undefined);
  const next = lifecycleChain.then(async () => {
    if (deactivating) return undefined;
    return operation();
  });
  lifecycleChain = next.catch((err) => {
    console.error(`dsh-vs-sidebar: ${label} failed:`, err);
  });
  return next;
}

/**
 * Main flow: make sure a DSH web server exists, then show it in the sidebar.
 * Must be called from enqueueLifecycle(); the cwd the server ends up bound to
 * is recorded in boundCwd.
 *
 * Null-safe: when no WebviewView has been resolved yet (e.g. activated via
 * onStartupFinished), the server is still ensured; render() simply has nothing
 * to paint and the view — resolved later — schedules another ensure to show it.
 */
async function connectNow(context) {
  try {
    const cfg = config();
    const cwd = workspaceCwd();
    setStatusBar("$(radio-tower) " + loc("DSH: connecting…"));
    render(statusPage({ title: loc("Connecting to DeepSeek Harness…"), detail: "", lang: vscode.env.language }));
    const server = await manager.ensureServer({
        host: cfg.host,
        port: cfg.port,
        autoStart: cfg.autoStart,
        cwd,
        registryFile: registryFilePath(context),
    });
    currentServer = server;
    boundCwd = cwd;
    const url = await externalize(server.url);
    currentExternalUrl = url;
    const mode = loc(server.owned ? "managed" : "reused");
    setStatusBar(
        "$(radio-tower) " + loc("DSH: {port} ({mode})", { port: String(server.port), mode }),
        loc("DSH server: {url}", { url: server.url }) + (cwd ? " | " + loc("workspace: {cwd}", { cwd }) : "")
    );
    render(framePage({
        url,
        lang: vscode.env.language,
        failText: loc("Failed to load: DSH service unreachable"),
        openBrowserLabel: loc("Open in browser"),
        retryLabel: loc("Retry"),
    }));
  } catch (err) {
      currentServer = null;
      boundCwd = null;
      if (deactivating) return;
      setStatusBar("$(error) " + loc("DSH: unavailable"));
      const cfg = config();
      const url = "http://" + cfg.host + ":" + cfg.port;
      currentExternalUrl = await externalize(url);
      try {
        render(statusPage({
          title: loc("DeepSeek Harness unavailable"),
          detail: err && err.template ? loc(err.template, err.params) : String(err && err.message ? err.message : err),
          url,
          showOpenBrowser: true,
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
  return enqueueLifecycle("connect", async () => {
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
  const cfg = config();
  // Validate before stopping a working instance. ensureServer performs the
  // authoritative validation; these checks preserve it on invalid settings.
  if (cfg.host !== DEFAULT_HOST || !Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    await manager.ensureServer({
      host: cfg.host,
      port: cfg.port,
      autoStart: false,
      cwd: workspaceCwd(),
      registryFile: registryFilePath(context),
    });
    return;
  }
  await stopOwnedServer();
  currentServer = null;
  currentExternalUrl = null;
  await connectNow(context);
}

/**
 * True when two cwd values denote the same root. Null-safe: both null means
 * "no workspace" on both sides; samePath handles Windows case/trailing-slash
 * differences.
 */
function sameRoot(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return ServerManager.samePath(a, b);
}

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
  const cwd = workspaceCwd();
  if (sameRoot(cwd, boundCwd)) return; // no effective workspace change

  await stopOwnedServer();
  currentServer = null;
  currentExternalUrl = null;
  boundCwd = cwd;
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
  return enqueueLifecycle("workspace rebind", () => rebindToWorkspace(context));
}

/**
 * React to a `dsh.*` configuration change (host / port / autoStart / closePolicy).
 *
 * All reactions are funneled through a single `lifecycleChain` (a chained
 * promise) so burst setting changes coalesce: a config change arriving during
 * an in-flight restart is queued behind it, never spawning parallel servers,
 * and the queued reconcile re-reads the LATEST config when it runs — so the
 * final state always matches the current settings.
 *
 * The decision of whether to restart is delegated to the pure, self-tested
 * `reconcileConfigChange()` in serverManager.js. A closePolicy-only change
 * does NOT restart (it only affects the dispose handler).
 */
function scheduleConfigReconcile(context) {
  return enqueueLifecycle("config reconcile", async () => {
    const prev = lastConfig || config();
    const next = config();
      // Record the incoming snapshot regardless, so rapid toggles coalesce
      // onto the latest value before the next queued reconcile runs.
    lastConfig = next;

    const decision = reconcileConfigChange(
        prev,
        next,
        Boolean(currentServer),
        Boolean(manager && manager.hasOwnedChild())
    );

    if (decision.shouldReconnect) {
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
function ensureDshOnPath() {
  const node = require("node:path");
  const parts = (process.env.PATH || "").split(node.delimiter);
  const append = (dir) => {
    if (dir && !parts.includes(dir)) {
      process.env.PATH = (process.env.PATH || "") + node.delimiter + dir;
    }
  };
  if (process.platform === "win32") {
    if (process.env.APPDATA) append(node.join(process.env.APPDATA, "npm"));
    return;
  }
  if (process.platform === "darwin" || process.platform === "linux") {
    const fs = require("node:fs");
    const home = process.env.HOME || "";
    const candidates = [];
    if (home) {
      candidates.push(node.join(home, ".npm-global", "bin"));
      candidates.push(node.join(home, ".local", "bin"));
      candidates.push(node.join(home, ".yarn", "bin"));
    }
    candidates.push("/usr/local/bin", "/opt/homebrew/bin");
    for (const dir of candidates) {
      try {
        if (fs.existsSync(dir)) append(dir);
      } catch (_) { /* stat errors are non-fatal */ }
    }
  }
}

async function activate(context) {
  ensureDshOnPath();
  textDocumentBridge = await startTextDocumentBridge({
    openTextDocument: async (absolutePath) => {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath));
      await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
    },
  });
  context.subscriptions.push({
    dispose() {
      textDocumentBridge?.close().catch(() => {});
    },
  });
  manager = new ServerManager({
    spawnEnv: textDocumentBridge.env,
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
      if (s.state === "error" && s.message) {
        setStatusBar("$(error) " + loc(s.message, s.params));
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
    ServerManager.cleanupStaleRegistry(registryFilePath(context));
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
        view.webview.onDidReceiveMessage((msg) => {
          if (msg && msg.type === "openBrowser" && currentExternalUrl) {
            vscode.env.openExternal(vscode.Uri.parse(currentExternalUrl));
          } else if (msg && msg.type === "retry") {
            scheduleConnect(context, resolvedViewGeneration).catch(() => {});
          }
        });
        view.onDidDispose(() => {
          if (currentView !== view) return;
          currentView = null;
          viewGeneration += 1; // cancel a delayed connect tied to this view
          enqueueLifecycle("view-close policy", async () => {
              if (currentView) return; // view re-resolved: never stop under the reopened view
              if (!shouldStopOnViewClose(config().closePolicy)) return;
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
    vscode.commands.registerCommand("dsh.openInBrowser", async () => {
      return enqueueLifecycle("open in browser", async () => {
        if (!currentServer) await connectNow(context);
        if (currentExternalUrl) {
          await vscode.env.openExternal(vscode.Uri.parse(currentExternalUrl));
        }
      });
    }),
    vscode.commands.registerCommand("dsh.restartServer", () => enqueueLifecycle("restart server", async () => {
      if (currentServer && !manager.hasOwnedChild()) {
        vscode.window.showInformationMessage(loc("The running DSH server is reused and cannot be restarted by this extension"));
        return;
      }
      await reconnectNow(context);
    })),
    vscode.commands.registerCommand("dsh.stopServer", () => enqueueLifecycle("stop server", async () => {
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
        boundCwd = null;
        vscode.window.showInformationMessage(loc("DSH server stopped"));
      })),
    vscode.commands.registerCommand("dsh.focusSidebar", async () => {
      await vscode.commands.executeCommand("workbench.view.extension." + CONTAINER_ID);
      await vscode.commands.executeCommand(VIEW_ID + ".focus");
    })
  );

  // Follow the workspace: when folders are added/removed or the active
  // editor moves to another root (multi-root), rebind the sidebar to the new
  // root's DSH instance. sameRoot() inside rebindToWorkspace keeps unrelated
  // editor switches (same folder) a no-op.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => scheduleRebind(context)),
    vscode.window.onDidChangeActiveTextEditor(() => scheduleRebind(context)),
    // React to dsh.* settings changes (host / port / autoStart / closePolicy)
    // through the serialized reconciler so burst changes never race a restart.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("dsh.host") ||
        e.affectsConfiguration("dsh.port") ||
        e.affectsConfiguration("dsh.autoStart") ||
        e.affectsConfiguration("dsh.closePolicy")
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
  lastConfig = config();
  if (lastConfig.autoStart) {
    setImmediate(() => {
      scheduleConnect(context).catch(() => {});
    });
  }
}

async function deactivate() {
  // On VS Code exit, stop only an owned process — and honor the close policy:
  // `never` intentionally leaves even an owned process running for explicit
  // user-managed operation. Other policies stop our child.
  deactivating = true;
  viewGeneration += 1;
  try {
    if (!manager) return undefined;
    if (normalizeClosePolicy(config().closePolicy) === CLOSE_POLICIES.NEVER) {
      await lifecycleChain.catch(() => {});
      return undefined;
    }

    // Prevent probe/port-scan work from spawning after shutdown begins. If a
    // child already exists, stopping it also makes an in-flight health wait
    // settle promptly instead of delaying deactivation for the full timeout.
    manager.cancelPending();
    if (manager.hasOwnedChild()) {
      await manager.stop();
    }
    await lifecycleChain.catch(() => {});
    if (manager.hasOwnedChild()) {
      await manager.stop();
    }
    return undefined;
  } finally {
    await textDocumentBridge?.close().catch(() => {});
    textDocumentBridge = null;
  }
}

module.exports = { activate, deactivate };
