window.__ModuleLoader__.load({
  id: 'dsh-vscode-integration',
  factory: () => {
    const module = { exports: {} };
    const CHANNEL = 'dsh-vscode-interaction';
    const VERSION = 1;
    const THREAD_CHANNEL = 'dsh-vscode-thread';
    const THREAD_VERSION = 1;
    const TIMEOUT_MS = 10000;
    const HANDSHAKE_TIMEOUT_MS = 2000;
    const pending = new Map();
    const threadRequests = new Map();
    let sequence = 0;
    let handshakeSettled = false;
    let handshakeReady = false;
    let handshakeTimer = null;
    const handshakeWaiters = [];

    function enabled() {
      return window.parent !== window && new URLSearchParams(window.location.search).get('dsh_embed') === 'vscode';
    }

    function markHandshakeReady() {
      if (handshakeSettled) return;
      handshakeSettled = true;
      handshakeReady = true;
      if (handshakeTimer) {
        clearTimeout(handshakeTimer);
        handshakeTimer = null;
      }
      const waiters = handshakeWaiters.splice(0);
      for (const resolve of waiters) resolve();
    }

    function markHandshakeDegraded() {
      if (handshakeSettled) return;
      handshakeSettled = true;
      handshakeReady = true;
      handshakeTimer = null;
      const waiters = handshakeWaiters.splice(0);
      for (const resolve of waiters) resolve();
    }

    function waitForHandshake() {
      if (handshakeSettled) return Promise.resolve();
      return new Promise((resolve) => handshakeWaiters.push(resolve));
    }

    function startHandshake() {
      window.parent.postMessage({
        type: 'dshWebviewHello',
        channel: CHANNEL,
        version: VERSION,
        capabilities: {},
      }, '*');
      handshakeTimer = setTimeout(() => {
        if (!handshakeSettled) {
          // Old shells do not answer READY; keep the v1 passthrough working.
          markHandshakeDegraded();
        }
      }, HANDSHAKE_TIMEOUT_MS);
    }

    function request(method, params) {
      const requestId = `${Date.now().toString(36)}_${(++sequence).toString(36)}`;
      return waitForHandshake().then(() => new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`VS Code ${method} request timed out`));
        }, TIMEOUT_MS);
        pending.set(requestId, { resolve, reject, timer });
        window.parent.postMessage({
          type: 'dshBridge', channel: CHANNEL, version: VERSION, requestId, method, params,
        }, '*');
      }));
    }

    function threadResult(requestId, ok, error) {
      return {
        type: 'dshThreadAttachResult', channel: THREAD_CHANNEL, version: THREAD_VERSION,
        requestId, ok, ...(ok || !error ? {} : { error: String(error).slice(0, 500) }),
      };
    }

    async function attachToDraft(ctx, message) {
      if (typeof message.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(message.requestId)) {
        throw new Error('Invalid DSH thread request id');
      }
      if (typeof message.text !== 'string' || message.text.length === 0 || new TextEncoder().encode(message.text).length > 1024 * 1024) {
        throw new Error('Invalid DSH thread attachment');
      }
      const querySession = new URLSearchParams(window.location.search).get('dsh_session');
      let actx;
      for (let attempt = 0; attempt < 50 && !actx; attempt += 1) {
        const snapshot = ctx.sessions.list.getSnapshot();
        const candidates = [...new Set([snapshot.current, querySession].filter(Boolean))];
        for (const sessionId of candidates) {
          actx = ctx.sessions.scope(sessionId);
          if (actx) break;
        }
        if (!actx) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!actx) throw new Error('Active DSH conversation is unavailable');
      const input = ctx.conversation.input.for(actx);
      const current = input.state.getSnapshot().draft || '';
      input.setDraft(current.length === 0 ? message.text : `${current}\n\n${message.text}`);
    }

    function handleThreadAttach(ctx, message) {
      let work = threadRequests.get(message.requestId);
      if (!work) {
        work = attachToDraft(ctx, message)
          .then(() => threadResult(message.requestId, true))
          .catch((error) => threadResult(message.requestId, false, error && error.message ? error.message : error));
        threadRequests.set(message.requestId, work);
        if (threadRequests.size > 100) threadRequests.delete(threadRequests.keys().next().value);
      }
      work.then((result) => window.parent.postMessage(result, '*'));
    }

    // Theme-follow consumer: the VS Code shell stamps the initial theme on
    // the iframe URL (dsh_theme) and pushes later changes through
    // dshThemeChanged postMessages. Both funnel into the DSH theme service
    // so the sidebar follows the VS Code color theme instead of the OS.
    // The theme service is resolved through ctx.get (optional lookup): the
    // feature degrades silently in profiles without ui-theme and never
    // blocks this plugin's clipboard/link bridges on activation.
    function resolveThemeService(ctx) {
      try {
        if (typeof ctx.get === 'function') {
          const service = ctx.get('theme');
          if (service && typeof service.setTheme === 'function') return service;
          return null;
        }
      } catch { /* dynamic guard */ }
      try {
        if (ctx.theme && typeof ctx.theme.setTheme === 'function') return ctx.theme;
      } catch { /* service not declared for this fiber */ }
      return null;
    }

    function applyVscodeTheme(ctx, theme) {
      if (theme !== 'dark' && theme !== 'light') return;
      const service = resolveThemeService(ctx);
      if (!service) return;
      try { service.setTheme(theme); } catch { /* theme apply is best-effort */ }
    }

    function onMessage(ctx, event) {
      if (event.source !== window.parent) return;
      const message = event.data;
      if (
        message && message.type === 'dshThemeChanged'
        && (message.theme === 'dark' || message.theme === 'light')
      ) {
        applyVscodeTheme(ctx, message.theme);
        return;
      }
      if (
        message && message.type === 'dshWebviewReady'
        && message.channel === CHANNEL && message.version === VERSION
      ) {
        markHandshakeReady();
        return;
      }
      if (
        message && message.type === 'dshThreadAttach'
        && message.channel === THREAD_CHANNEL && message.version === THREAD_VERSION
      ) {
        // Malformed request ids are silently rejected: no pending map entry,
        // no failure echo. Matches the shell/extension-host parser policy.
        if (typeof message.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(message.requestId)) return;
        handleThreadAttach(ctx, message);
        return;
      }
      if (!message || message.type !== 'dshBridgeResult' || message.channel !== CHANNEL || message.version !== VERSION) return;
      const waiter = pending.get(message.requestId);
      if (!waiter) return;
      pending.delete(message.requestId);
      clearTimeout(waiter.timer);
      if (message.ok) waiter.resolve(message.data);
      else waiter.reject(new Error(message.error || 'VS Code interaction failed'));
    }

    function installClipboardBridge() {
      const clipboard = navigator.clipboard;
      if (!clipboard) return () => {};
      const own = Object.getOwnPropertyDescriptor(clipboard, 'writeText');
      const prototype = Object.getPrototypeOf(clipboard);
      const inherited = prototype && Object.getOwnPropertyDescriptor(prototype, 'writeText');
      const original = clipboard.writeText && clipboard.writeText.bind(clipboard);
      const bridged = (text) => request('clipboard/writeText', { text: String(text) });
      try {
        Object.defineProperty(clipboard, 'writeText', { configurable: true, writable: true, value: bridged });
      } catch {
        if (inherited && inherited.configurable) {
          Object.defineProperty(prototype, 'writeText', { ...inherited, value: bridged });
        } else {
          return () => {};
        }
      }
      return () => {
        try {
          if (own) Object.defineProperty(clipboard, 'writeText', own);
          else delete clipboard.writeText;
          if (!own && inherited && clipboard.writeText !== original) Object.defineProperty(prototype, 'writeText', inherited);
        } catch { /* page is unloading */ }
      };
    }

    function installMacShortcutBridge() {
      // VS Code's native Edit menu owns Cmd+C/Cmd+X/Cmd+V on macOS and never
      // forwards them into nested webview iframes (microsoft/vscode#129178);
      // the workbench copy targets its own focused control, so a selection
      // inside the DSH iframe copies nothing. Capture the key events inside
      // the iframe and run the (bridged) execCommand ourselves.
      const platform = typeof navigator !== 'undefined' ? String(navigator.platform || navigator.userAgent || '') : '';
      if (!/Mac/i.test(platform)) return () => {};
      if (typeof document.execCommand !== 'function') return () => {};
      const onKeyDown = (event) => {
        if (event.defaultPrevented) return;
        const withCmd = (event.metaKey || event.ctrlKey) && !event.altKey;
        if (!withCmd) return;
        const isPasteShortcut = event.code === 'KeyV' || event.key === 'v' || event.key === 'V';
        const isCopyShortcut = event.code === 'KeyC' || event.key === 'c' || event.key === 'C';
        const isCutShortcut = event.code === 'KeyX' || event.key === 'x' || event.key === 'X';
        if (isPasteShortcut) {
          event.preventDefault();
          document.execCommand('paste');
          return;
        }
        if (isCopyShortcut || isCutShortcut) {
          // Only claim the shortcut while the selection actually lives in this
          // document; otherwise let the host handle its own focused control.
          // currentSelectionText covers rendered-content selections AND
          // selections inside input/textarea — window.getSelection misses the
          // latter, and the chat composer is a textarea (the primary case).
          if (!currentSelectionText()) return;
          event.preventDefault();
          // cut fallback below only copies (no deletion) — acceptable for the
          // chat-input use case; copy is the primary path.
          document.execCommand(isCopyShortcut ? 'copy' : 'cut');
        }
      };
      document.addEventListener('keydown', onKeyDown, true);
      return () => document.removeEventListener('keydown', onKeyDown, true);
    }

    // R15: execCommand fallback. When the embedded page runs
    // document.execCommand('copy'/'cut') and the browser denies it, forward the
    // selection through the clipboard bridge; when execCommand('paste') is
    // denied (the macOS webview case), read the clipboard through the bridge
    // and insert the text ourselves.
    // input/textarea selections are invisible to window.getSelection() in
    // some engines; read them off the focused control first.
    function currentSelectionText() {
      const active = document.activeElement;
      if (
        active && typeof active.selectionStart === 'number' && typeof active.selectionEnd === 'number'
        && typeof active.value === 'string' && active.selectionEnd > active.selectionStart
      ) {
        return active.value.slice(active.selectionStart, active.selectionEnd);
      }
      return window.getSelection ? String(window.getSelection()) : '';
    }

    function installExecCommandFallback() {
      if (typeof document.execCommand !== 'function') return () => {};
      const native = document.execCommand.bind(document);
      document.execCommand = function execCommandBridged(command, showUi, value) {
        const result = native(command, showUi, value);
        if (result) return result;
        if (!enabled()) return result;
        if (command === 'copy' || command === 'cut') {
          const text = currentSelectionText() || (typeof value === 'string' ? value : '');
          if (text) {
            request('clipboard/writeText', { text }).catch(() => {});
            return true;
          }
          return result;
        }
        if (command === 'paste') {
          request('clipboard/readText', {}).then((data) => {
            const text = data && typeof data.text === 'string' ? data.text : '';
            if (text) native('insertText', false, text);
          }).catch(() => {});
          return true;
        }
        return result;
      };
      return () => {
        try { delete document.execCommand; } catch { document.execCommand = native; }
      };
    }

    function onClick(event) {
      if (event.defaultPrevented || event.button !== 0) return;
      const element = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!element) return;
      let url;
      try { url = new URL(element.href); } catch { return; }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (url.hostname === 'dsh-vscode.invalid' && url.pathname.startsWith('/attachment/')) {
        const attachmentId = decodeURIComponent(url.pathname.slice('/attachment/'.length));
        request('attachment/open', { attachmentId }).catch(() => {});
      } else {
        request('link/open', { url: url.toString() }).catch(() => {});
      }
    }

    // Session-follow consumer: the VS Code shell reloads this iframe with a
    // fresh dsh_session query param whenever the bound workspace changes
    // (folder switch, multi-root editor move, session navigation commands).
    // The DSH web app restores its own persisted current session on boot and
    // no official client consumes the param, so without this bridge the
    // sidebar keeps showing the previous workspace's conversation after the
    // switch. Wait for the target session to appear in the list mirror (the
    // session list loads asynchronously), then route it through the app's
    // session navigation exactly like a user click on the session row
    // (0.1.7+: uiWorkspace.openSession(); older: sessions.open()).
    // Session-current watcher: a conversation switch performed INSIDE the
    // DSH web UI (session-row click) is invisible to the VS Code shell — the
    // shell only re-renders on its own navigation commands, so the changes
    // tree and the workspace binding kept pointing at the previous session
    // (live bug 2026-09-04: "switching conversations did not switch the
    // changes view"). Poll the app's current-session pointer (0.1.7:
    // uiWorkspace.selection; older: the list mirror's `current`) and
    // announce every change to the shell; the shell relays the
    // dshSessionChanged message to the extension host.
    // dsh 0.1.7 moved view selection OUT of the sessions controller (the
    // ClientSessions header now reads "view selection remains outside the
    // Controller"): the session-list snapshot lost its `current` field and
    // `sessions.open()` is gone — both surfaces moved to the `uiWorkspace`
    // service (`selection` snapshot store carrying `{ sessionId }` and
    // `openSession(sessionId)`). Without adapting, the follow loop can no
    // longer read the app's current session nor switch it, so the embedded
    // sidebar silently stays on the app's own restore pick — the most
    // recently updated workspace — which reads as "the plugin's workspace
    // pointing is wrong" after a dsh update (live bug 2026-09-24).
    //
    // `uiWorkspace` is resolved lazily on every read (it may materialize
    // after apply) and is deliberately NOT declared in module.exports.inject:
    // a declared-but-missing inject pends forever on pre-0.1.7 runtimes and
    // the whole bridge would never start (the same failure shape as the
    // server-side apiProxy inject). The legacy sessions surface stays as the
    // fallback so runtimes back to 0.1.5 keep working unchanged.
    function resolveUiWorkspace(ctx) {
      if (!ctx || typeof ctx.get !== 'function') return null;
      try {
        const ui = ctx.get('uiWorkspace');
        if (ui && typeof ui === 'object') return ui;
      } catch {
        // service absent on pre-0.1.7 runtimes: the legacy path owns the read
      }
      return null;
    }

    /** The app's current session id, or null while nothing is selected. */
    function readCurrentSessionId(ctx, snapshot) {
      const ui = resolveUiWorkspace(ctx);
      if (ui && ui.selection && typeof ui.selection.getSnapshot === 'function') {
        try {
          const selection = ui.selection.getSnapshot();
          if (selection && typeof selection.sessionId === 'string' && selection.sessionId.length > 0) {
            return selection.sessionId;
          }
        } catch {
          // fall through to the legacy snapshot field
        }
      }
      return snapshot && typeof snapshot.current === 'string' ? snapshot.current : null;
    }

    /** Route a session switch through the 0.1.7+ navigation, then the legacy face. */
    const OPEN_NO_PATH = 0; // no navigation surface mounted yet — nothing was tried
    const OPEN_ATTEMPTED = 1; // a surface was called (its throw, if any, waits for the next tick)
    function openSessionTarget(ctx, target) {
      const ui = resolveUiWorkspace(ctx);
      if (ui && typeof ui.openSession === 'function') {
        try {
          ui.openSession(target);
        } catch {
          // the next tick retries (throttled by the open budget)
        }
        return OPEN_ATTEMPTED;
      }
      if (ctx && ctx.sessions && typeof ctx.sessions.open === 'function') {
        try {
          ctx.sessions.open(target);
        } catch {
          // the next tick retries
        }
        return OPEN_ATTEMPTED;
      }
      return OPEN_NO_PATH;
    }

    function startSessionCurrentWatcher(ctx) {
      if (!ctx.sessions || !ctx.sessions.list || typeof ctx.sessions.list.getSnapshot !== 'function') {
        return () => {};
      }
      let disposed = false;
      let last = null;
      let timer = null;
      const poll = () => {
        if (disposed) return;
        try {
          const snapshot = ctx.sessions.list.getSnapshot();
          const current = readCurrentSessionId(ctx, snapshot);
          if (last === null) {
            last = current; // baseline: never announce the boot-time session
          } else if (current !== last) {
            last = current;
            if (current) {
              window.parent.postMessage({ type: 'dshSessionChanged', sessionId: current }, '*');
            }
          }
        } catch {
          // a broken snapshot store must never break the page
        }
        timer = setTimeout(poll, 800);
        // Node (tests): keep the poll off the event-loop keep-alive set so the
        // host process can exit; browsers return a numeric handle (no-op).
        if (timer && typeof timer.unref === 'function') timer.unref();
      };
      poll();
      return () => {
        disposed = true;
        if (timer) clearTimeout(timer);
      };
    }

    // Follow timing. The budget is deliberately generous and the loop waits
    // for the sessions service itself: this bridge is the only thing that
    // makes the sidebar show the switched-to workspace, and giving up is
    // INVISIBLE — the page simply keeps rendering the previous workspace's
    // conversation. The old 50 x 100ms window silently expired whenever the
    // list mirror took longer than five seconds (large instances, a cold
    // workspace fetch) or whenever `ctx.sessions` was not mounted at apply
    // time (the follow was then never started at all). Live bug 2026-09-18:
    // "switching folders does not move the sidebar".
    const followLimits = {
      tickMs: 100,
      slowTickMs: 500,
      fastWindowMs: 5000,
      budgetMs: 60000,
      // Re-opening is throttled and capped: a list refresh can reset the
      // selection back to the persisted session, and re-issuing open() forever
      // would fight the app. Ten tries spans the first list loads; past that
      // the next iframe reload (the shell re-sends dsh_session) picks it up.
      openIntervalMs: 500,
      maxOpens: 10,
    };

    function startEmbeddedSessionFollow(ctx) {
      const target = new URLSearchParams(window.location.search).get('dsh_session');
      if (!target) return () => {};
      const startedAt = Date.now();
      const deadline = startedAt + followLimits.budgetMs;
      let disposed = false;
      let timer = null;
      let opens = 0;
      let lastOpenAt = 0;
      let baseline = null;
      let baselineSeen = false;

      const snapshotNow = () => {
        if (!ctx.sessions || !ctx.sessions.list || typeof ctx.sessions.list.getSnapshot !== 'function') {
          return null; // sessions service not mounted yet: keep waiting for it
        }
        try {
          return ctx.sessions.list.getSnapshot();
        } catch {
          return null; // a broken snapshot store must never break activation
        }
      };

      const tick = () => {
        if (disposed) return;
        const snapshot = snapshotNow();
        let done = false;
        if (snapshot) {
          const current = readCurrentSessionId(ctx, snapshot);
          // A 'loading' snapshot still carries the PREVIOUS list, so neither
          // the baseline nor a stand-down decision may be read from it.
          const loaded = snapshot.phase === undefined || snapshot.phase !== 'loading';
          // The baseline is the app's restore point: the session it selected
          // on its own before this bridge ran. A null current is not a
          // selection (the list has not restored one yet), so the baseline
          // stays open until a real one appears — freezing null would make the
          // restore itself look like a user click. The user cannot beat it
          // either: clicking a row requires the list, which is loaded by then.
          if (loaded && !baselineSeen && current !== null) {
            baseline = current;
            baselineSeen = true;
          }
          if (current === target) {
            done = true; // followed — or the user picked it themselves
          } else if (snapshot.byId && snapshot.byId[target] !== undefined) {
            // Someone other than the restore-point chose a session: that is
            // the user clicking a row (or the app moving on), and the follow
            // must stand down instead of yanking the view back. 'Not yet in
            // the list' is NOT that case — it is the list still loading.
            if (loaded && baselineSeen && current !== baseline) {
              done = true;
            } else if (opens < followLimits.maxOpens
              && Date.now() - lastOpenAt >= followLimits.openIntervalMs
              && openSessionTarget(ctx, target) === OPEN_ATTEMPTED) {
              // Only a real navigation attempt consumes the open budget: on
              // 0.1.7+ the uiWorkspace service can mount after apply, and
              // burning the budget on ticks with no navigation surface yet
              // would strand the follow with its work never even tried.
              opens += 1;
              lastOpenAt = Date.now();
            }
          }
        }
        if (done) return;
        if (Date.now() < deadline) {
          const interval = Date.now() - startedAt < followLimits.fastWindowMs
            ? followLimits.tickMs
            : followLimits.slowTickMs;
          timer = setTimeout(tick, interval);
          // Node (tests): keep the poll off the event-loop keep-alive set so
          // the host process can exit; browsers return a numeric handle.
          if (timer && typeof timer.unref === 'function') timer.unref();
        }
      };
      tick();
      return () => {
        disposed = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      };
    }

    // B3 (issue #6): reply-path links. Recognizes two clickable forms in
    // rendered message text — file:/// URLs (including Windows drive form
    // file:///D:/...) and workspace-relative paths with an optional :line or
    // :line:col suffix — and POSTs the chosen target to the same-origin
    // /api/vscode/open-link route registered by this package's host side, which
    // opens the file in the owning VS Code window. The pure extraction helpers
    // are exposed on module.exports.__linkify for unit tests (no DOM required).
    //
    // READ-ONLY BY CONTRACT (live bug 2026-09-24, "the panel's final conclusion
    // is invisible; it can only be copied out"): the first implementation
    // wrapped each matched text node — parent.replaceChild(fragment, node) with
    // an <a class="dsh-vscode-file-link"> per token. The DSH web UI renders
    // messages with React, which keeps its own reference to every text node it
    // created; replacing one DETACHES that reference, so the next
    // reconciliation of the same message — the streaming → final markdown
    // re-render that lands exactly when the answer is committed — inserts or
    // removes against a node that is no longer a child and throws
    // NotFoundError mid-commit. The aborted commit leaves the final answer
    // unpainted while its text stays in the app's own store (readable only
    // through its copy affordance). This module therefore NEVER creates,
    // removes or rewrites a node the app rendered: the underline affordance is
    // a CSS Custom Highlight over Ranges, and a click is resolved by
    // hit-testing the caret position against the same pure extractor.
    const LINKIFY_EXTENSIONS = new Set([
      '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.mts', '.cts', '.json', '.jsonc',
      '.md', '.markdown', '.mdx', '.py', '.pyi', '.rs', '.go', '.java', '.c', '.h',
      '.cc', '.cpp', '.hpp', '.cs', '.rb', '.php', '.swift', '.kt', '.kts', '.sh',
      '.bash', '.zsh', '.fish', '.ps1', '.psm1', '.yml', '.yaml', '.toml', '.ini',
      '.cfg', '.conf', '.env', '.css', '.scss', '.less', '.html', '.htm', '.vue',
      '.svelte', '.astro', '.sql', '.lua', '.pl', '.pm', '.r', '.m', '.mm', '.dart',
      '.ex', '.exs', '.erl', '.hs', '.clj', '.cljs', '.scala', '.gradle', '.xml',
      '.svg', '.txt', '.log', '.lock',
    ]);
    const LINKIFY_TOKEN_RE = /[A-Za-z0-9_.\-\/:@%~+]+/g;
    const LINKIFY_MAX_TEXT = 100000;
    const LINKIFY_MAX_NODES_PER_SCAN = 2000;
    const LINKIFY_SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'A', 'BUTTON', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'NOSCRIPT']);
    const LINKIFY_OPEN_URL = '/api/vscode/open-link';
    // Name of the CSS highlight carrying the underline; one registry slot per
    // document, replaced (never duplicated) on re-install.
    const LINKIFY_HIGHLIGHT_NAME = 'dsh-vscode-file-link';
    // Paint/scan coalescing window: a streaming answer mutates the DOM many
    // times per second and each batch only re-reads the nodes it touched.
    const LINKIFY_FLUSH_MS = 120;

    function splitLineSuffix(token) {
      // Try the :line:col form first: a single greedy optional group would
      // swallow ':3' into the path of 'x.ts:3:9' and keep only the column.
      const both = /^(.+):(\d{1,7}):(\d{1,7})$/.exec(token);
      if (both) {
        return { path: both[1], line: Number(both[2]), col: Number(both[3]) };
      }
      const one = /^(.+):(\d{1,7})$/.exec(token);
      if (one) {
        return { path: one[1], line: Number(one[2]), col: undefined };
      }
      return { path: token, line: undefined, col: undefined };
    }

    function parseFileUrlTarget(token) {
      if (!token.startsWith('file:///')) return null;
      const split = splitLineSuffix(token.slice('file://'.length));
      // file:///D:/x.js keeps the drive form; file:///home/u/x.js keeps the
      // leading slash so POSIX paths stay absolute.
      const rawPath = /^\/[A-Za-z]:(?:[\\/].*)?$/.test(split.path) ? split.path.slice(1) : split.path;
      let decoded;
      try { decoded = decodeURIComponent(rawPath); } catch { return null; }
      if (decoded.length === 0 || decoded.length > 4096 || decoded.includes('\u0000')) return null;
      return { kind: 'file-url', path: decoded, line: split.line, col: split.col };
    }

    function parseWorkspacePathTarget(token) {
      if (token.includes('://') || token.startsWith('file:')) return null;
      if (token.startsWith('/') || token.startsWith('\\')) return null;
      if (/^[A-Za-z]:[\\/]/.test(token)) return null; // absolute drive path: only file:/// form is linked
      if (token.startsWith('www.') || token.includes('@')) return null;
      const split = splitLineSuffix(token);
      const raw = split.path;
      if (raw.length === 0 || raw.length > 4096) return null;
      const hasSeparator = raw.includes('/') || raw.includes('\\');
      const segments = raw.split(/[\\/]+/).filter((segment) => segment.length > 0);
      if (segments.length === 0) return null;
      for (const segment of segments) {
        if (!/^[A-Za-z0-9@._+][A-Za-z0-9@._+\-.]*$/.test(segment)) return null;
      }
      const basename = segments[segments.length - 1];
      const dot = basename.lastIndexOf('.');
      const hasKnownExtension = dot > 0 && LINKIFY_EXTENSIONS.has(basename.slice(dot).toLowerCase());
      // Anti-false-positive rule: link only path-shaped text — a known source
      // extension on the basename, OR a separator plus at least one dotted
      // segment (so plain English like "and/or" or "node:fs" never links).
      const hasDottedSegment = segments.some((segment) => segment.indexOf('.', 1) !== -1);
      if (!hasKnownExtension && !(hasSeparator && hasDottedSegment)) return null;
      return { kind: 'workspace-path', path: raw, line: split.line, col: split.col };
    }

    function extractLinkTargets(text) {
      if (typeof text !== 'string' || text.length === 0 || text.length > LINKIFY_MAX_TEXT) return [];
      const targets = [];
      LINKIFY_TOKEN_RE.lastIndex = 0;
      let match;
      while ((match = LINKIFY_TOKEN_RE.exec(text)) !== null) {
        const token = match[0];
        const target = parseFileUrlTarget(token) || parseWorkspacePathTarget(token);
        if (target) {
          targets.push({
            start: match.index,
            end: match.index + token.length,
            kind: target.kind,
            path: target.path,
            line: target.line,
            col: target.col,
          });
        }
      }
      return targets;
    }

    /**
     * Whether a rendered element may carry a link affordance. Text inside the
     * app's own controls, links and editable surfaces keeps its native meaning
     * (the legacy a[href] handler owns those elements).
     *
     * @param {Element|null} element - Element owning the text node.
     * @returns {boolean}
     */
    function isLinkifyCandidate(element) {
      if (!element || typeof element.closest !== 'function') return false;
      try {
        if (element.closest('a,button,textarea,input,select,option,noscript')) return false;
        // Editable surfaces own their clicks, whether the attribute is
        // contenteditable="true", the empty form (composers), or inherited from
        // an ancestor (isContentEditable covers all three).
        if (element.isContentEditable === true) return false;
        if (element.closest('[contenteditable="true"],[contenteditable=""]')) return false;
      } catch {
        return false; // detached or exotic node: never claim the click
      }
      return true;
    }

    /**
     * The link target a caret offset sits in, or null. Pure — shares the token
     * rules with extractLinkTargets, and both boundaries are inclusive so a
     * click landing just after "x.js" (the caret sits between two characters)
     * still resolves the token the reader pointed at.
     *
     * @param {string} text - nodeValue of the text node under the caret.
     * @param {number} offset - Caret offset inside that text node.
     * @returns {object|null} `{ start, end, kind, path, line, col }` or null.
     */
    function tokenAtOffset(text, offset) {
      if (typeof text !== 'string' || !Number.isInteger(offset) || offset < 0 || offset > text.length) {
        return null;
      }
      for (const target of extractLinkTargets(text)) {
        if (offset >= target.start && offset <= target.end) return target;
      }
      return null;
    }

    /**
     * Visit every text node of a rendered subtree, read-only. Uses the same
     * skip rules and node budget as the former wrapping scanner.
     *
     * @param {Node} root - Subtree root.
     * @param {(node: Text) => void} visit - Called once per visited text node.
     */
    function visitLinkTextNodes(root, visit) {
      let budget = LINKIFY_MAX_NODES_PER_SCAN;
      const walk = (node) => {
        if (budget <= 0) return;
        budget -= 1;
        if (node.nodeType === 3) {
          visit(node);
          return;
        }
        if (node.nodeType !== 1) return;
        if (LINKIFY_SKIP_TAGS.has(node.tagName)) return;
        if (typeof node.getAttribute === 'function') {
          try {
            if (node.getAttribute('contenteditable') === 'true') return;
          } catch { /* attribute access is best-effort */ }
        }
        const children = node.childNodes || [];
        for (let index = 0; index < children.length; index += 1) walk(children[index]);
      };
      walk(root);
    }

    /**
     * Underline painter built on the CSS Custom Highlight API. Highlights are
     * Ranges, so the affordance repaints without creating, removing or
     * rewriting a single node the app owns. Returns null on runtimes without
     * the API (pre-Chromium-105 engines): links keep working, they are simply
     * not underlined.
     *
     * @returns {{track: Function, drop: Function, dispose: Function}|null}
     */
    function createLinkPainter() {
      if (typeof Highlight !== 'function') return null;
      if (typeof CSS === 'undefined' || !CSS || !CSS.highlights) return null;
      if (typeof document.createElement !== 'function') return null;
      if (typeof document.createRange !== 'function') return null;
      let highlight;
      try {
        highlight = new Highlight();
        CSS.highlights.set(LINKIFY_HIGHLIGHT_NAME, highlight);
      } catch {
        return null; // registry unavailable: degrade to click-only links
      }
      const style = document.createElement('style');
      style.textContent = `::highlight(${LINKIFY_HIGHLIGHT_NAME}){text-decoration:underline;text-underline-offset:2px}`;
      (document.head || document.body).appendChild(style);
      const rangesByNode = new WeakMap();
      return {
        /** Recompute one text node's ranges (drops whatever it had before). */
        track(node) {
          const previous = rangesByNode.get(node);
          if (previous) {
            for (const range of previous) highlight.delete(range);
            rangesByNode.delete(node);
          }
          const ranges = [];
          for (const target of extractLinkTargets(node.nodeValue)) {
            const range = document.createRange();
            try {
              range.setStart(node, target.start);
              range.setEnd(node, target.end);
            } catch {
              continue; // node mutated between scan and range creation
            }
            highlight.add(range);
            ranges.push(range);
          }
          if (ranges.length > 0) rangesByNode.set(node, ranges);
        },
        /** Forget one text node's ranges (removed, or emptied, content). */
        drop(node) {
          const previous = rangesByNode.get(node);
          if (!previous) return;
          for (const range of previous) highlight.delete(range);
          rangesByNode.delete(node);
        },
        /** Release the registry slot and the ::highlight() style tag. */
        dispose() {
          try { CSS.highlights.delete(LINKIFY_HIGHLIGHT_NAME); } catch { /* already gone */ }
          if (style.parentNode && typeof style.parentNode.removeChild === 'function') {
            style.parentNode.removeChild(style);
          }
        },
      };
    }

    /**
     * Caret position at viewport coordinates. `caretPositionFromPoint` is the
     * standard; Chromium also exposes the legacy `caretRangeFromPoint`.
     *
     * @param {number} x - Viewport x.
     * @param {number} y - Viewport y.
     * @returns {{node: Node, offset: number}|null}
     */
    function caretPositionAtPoint(x, y) {
      if (typeof document.caretPositionFromPoint === 'function') {
        try {
          const position = document.caretPositionFromPoint(x, y);
          if (position) return { node: position.offsetNode, offset: position.offset };
        } catch { /* fall through to the legacy call */ }
      }
      if (typeof document.caretRangeFromPoint === 'function') {
        try {
          const range = document.caretRangeFromPoint(x, y);
          if (range) return { node: range.startContainer, offset: range.startOffset };
        } catch { /* unresolved */ }
      }
      return null;
    }

    /**
     * The link target under a viewport point, or null. Resolution is a pure
     * hit-test, so the answer is always the text actually on screen at click
     * time — no per-token state to go stale as the app re-renders.
     *
     * @param {number} x - Viewport x.
     * @param {number} y - Viewport y.
     * @returns {object|null} Link target from {@link tokenAtOffset}.
     */
    function linkTargetAtPoint(x, y) {
      const position = caretPositionAtPoint(x, y);
      if (!position || !position.node || position.node.nodeType !== 3) return null;
      if (typeof position.node.nodeValue !== 'string') return null;
      if (!isLinkifyCandidate(position.node.parentElement)) return null;
      return tokenAtOffset(position.node.nodeValue, position.offset);
    }

    /**
     * Install reply-path links: read-only underline painting, caret hit-test
     * click resolution, and a pointer cursor hint over a resolvable token.
     * Nothing here mutates the rendered DOM tree (see the READ-ONLY BY CONTRACT
     * note above).
     *
     * @returns {() => void} disposer.
     */
    function installReplyLinkify() {
      if (typeof document.addEventListener !== 'function') return () => {};
      if (!document.body || typeof fetch !== 'function') return () => {};

      const painter = createLinkPainter();
      const pending = new Set();
      const removed = new Set();
      let flushTimer = null;
      let pointerFrame = null;
      let pointerFrameKind = null;
      let pointerPoint = null;
      let cursorClaim = null;
      let disposed = false;

      /** Repaint one text node when it is still in the document. */
      const trackTextNode = (node) => {
        if (!painter) return;
        if (!node || node.nodeType !== 3) return;
        if (typeof node.nodeValue !== 'string' || node.nodeValue.length === 0) return;
        if (node.isConnected === false) return;
        if (!isLinkifyCandidate(node.parentElement)) return;
        painter.track(node);
      };

      const trackTree = (node) => {
        visitLinkTextNodes(node, trackTextNode);
      };

      /**
       * Forget ranges under a removed subtree. Walks EVERY node (the scan skip
       * rules must not apply here, or a removed list item / control would leak
       * its ranges into the highlight registry forever).
       */
      const dropTree = (node) => {
        if (!painter || !node) return;
        if (node.nodeType === 3) {
          painter.drop(node);
          return;
        }
        if (node.nodeType !== 1) return;
        const children = node.childNodes || [];
        for (let index = 0; index < children.length; index += 1) dropTree(children[index]);
      };

      const flush = () => {
        flushTimer = null;
        if (disposed) return;
        for (const node of removed) dropTree(node);
        removed.clear();
        const nodes = [...pending];
        pending.clear();
        for (const node of nodes) {
          if (node.nodeType === 3) trackTextNode(node);
          else trackTree(node);
        }
      };

      const scheduleFlush = () => {
        if (flushTimer !== null) return;
        flushTimer = setTimeout(flush, LINKIFY_FLUSH_MS);
        // Node (tests): keep this timer off the event-loop keep-alive set.
        if (flushTimer && typeof flushTimer.unref === 'function') flushTimer.unref();
      };

      const schedule = (node) => {
        pending.add(node);
        scheduleFlush();
      };

      // Initial pass over already-rendered content; afterwards only the nodes a
      // mutation actually touched are re-read (no whole-page rescans while the
      // answer streams).
      trackTree(document.body);

      let observer = null;
      if (typeof window.MutationObserver === 'function' && painter) {
        observer = new window.MutationObserver((mutations) => {
          if (disposed) return;
          for (const mutation of mutations) {
            if (mutation.type === 'characterData') {
              schedule(mutation.target);
              continue;
            }
            for (const node of mutation.removedNodes || []) {
              removed.add(node);
              pending.delete(node);
            }
            for (const node of mutation.addedNodes || []) schedule(node);
          }
          if (removed.size > 0 || pending.size > 0) scheduleFlush();
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      }

      const onLinkClick = (event) => {
        if (disposed || event.defaultPrevented || event.button !== 0) return;
        // Double/triple clicks are selection gestures, not navigation.
        if (typeof event.detail === 'number' && event.detail > 1) return;
        const target = linkTargetAtPoint(event.clientX, event.clientY);
        if (!target) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        fetch(LINKIFY_OPEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-DSH-VSCode-Linkify': '1' },
          body: JSON.stringify({ path: target.path, line: target.line, col: target.col }),
        }).catch(() => {
          // Opening is best-effort; a failed click must never break the page.
        });
      };

      /**
       * Pointer-cursor hint over resolvable tokens: the body owns the cursor
       * while the pointer is on a link, and exactly the previous inline value
       * is restored afterwards (the app's own cursor styles win inside its
       * controls).
       */
      const setHoverCursor = (active) => {
        const body = document.body;
        if (!body || !body.style) return;
        if (active) {
          if (cursorClaim !== null) return;
          cursorClaim = body.style.cursor || '';
          body.style.cursor = 'pointer';
        } else if (cursorClaim !== null) {
          body.style.cursor = cursorClaim;
          cursorClaim = null;
        }
      };

      const applyPointerFrame = () => {
        pointerFrame = null;
        pointerFrameKind = null;
        const point = pointerPoint;
        pointerPoint = null;
        if (disposed || !point) return;
        setHoverCursor(linkTargetAtPoint(point.x, point.y) !== null);
      };

      const onPointerMove = (event) => {
        if (disposed) return;
        pointerPoint = { x: event.clientX, y: event.clientY };
        if (pointerFrame !== null) return;
        if (typeof requestAnimationFrame === 'function') {
          pointerFrameKind = 'frame';
          pointerFrame = requestAnimationFrame(applyPointerFrame);
          return;
        }
        pointerFrameKind = 'timer';
        pointerFrame = setTimeout(applyPointerFrame, 60);
        // Node (tests): keep this timer off the event-loop keep-alive set.
        if (pointerFrame && typeof pointerFrame.unref === 'function') pointerFrame.unref();
      };

      const releaseHover = () => {
        pointerPoint = null;
        setHoverCursor(false);
      };

      document.addEventListener('click', onLinkClick, true);
      document.addEventListener('pointermove', onPointerMove, true);
      document.addEventListener('mouseleave', releaseHover, true);
      if (typeof window.addEventListener === 'function') window.addEventListener('blur', releaseHover);

      return () => {
        disposed = true;
        if (flushTimer !== null) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        if (pointerFrame !== null) {
          if (pointerFrameKind === 'frame' && typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(pointerFrame);
          } else {
            clearTimeout(pointerFrame);
          }
        }
        pointerFrame = null;
        pointerFrameKind = null;
        pending.clear();
        removed.clear();
        releaseHover();
        document.removeEventListener('click', onLinkClick, true);
        document.removeEventListener('pointermove', onPointerMove, true);
        document.removeEventListener('mouseleave', releaseHover, true);
        if (typeof window.removeEventListener === 'function') window.removeEventListener('blur', releaseHover);
        if (observer) observer.disconnect();
        if (painter) painter.dispose();
      };
    }

    function apply(ctx) {
      if (!enabled()) return;
      // Initial theme from the URL the shell built for this webview.
      const initialTheme = new URLSearchParams(window.location.search).get('dsh_theme');
      if (initialTheme === 'dark' || initialTheme === 'light') {
        applyVscodeTheme(ctx, initialTheme);
      }
      // Remember the durable DSH preference so disposal restores it (the
      // theme service persists preference writes into DSH settings).
      let initialPreference = null;
      try {
        const service = resolveThemeService(ctx);
        initialPreference = service && service.preference;
      } catch { /* optional */ }
      ctx.effect(() => {
        startHandshake();
        const stopSessionFollow = startEmbeddedSessionFollow(ctx);
        const stopSessionCurrentWatch = startSessionCurrentWatcher(ctx);
        const listener = (event) => onMessage(ctx, event);
        window.addEventListener('message', listener);
        document.addEventListener('click', onClick, true);
        const restoreClipboard = installClipboardBridge();
        const restoreExecFallback = installExecCommandFallback();
        const restoreMacShortcutBridge = installMacShortcutBridge();
        const stopReplyLinkify = installReplyLinkify();
        window.parent.postMessage({
          type: 'dshThreadReady', channel: THREAD_CHANNEL, version: THREAD_VERSION,
        }, '*');
        return () => {
          if (handshakeTimer) clearTimeout(handshakeTimer);
          stopSessionFollow();
          stopSessionCurrentWatch();
          restoreClipboard();
          restoreExecFallback();
          restoreMacShortcutBridge();
          stopReplyLinkify();
          document.removeEventListener('click', onClick, true);
          window.removeEventListener('message', listener);
          for (const waiter of pending.values()) {
            clearTimeout(waiter.timer);
            waiter.reject(new Error('VS Code integration disposed'));
          }
          pending.clear();
          threadRequests.clear();
          if (initialPreference) {
            const service = resolveThemeService(ctx);
            if (service && service.preference !== initialPreference) {
              try { service.setTheme(initialPreference); } catch { /* best-effort restore */ }
            }
          }
        };
      }, 'dsh-vscode-integration: browser interaction bridge');
    }

    module.exports.apply = apply;
    module.exports.inject = ['conversation', 'sessions'];
    module.exports.name = 'dsh-vscode-integration';
    // Pure linkify helpers exposed for unit tests (extract targets from plain
    // text and resolve the token under a caret; no DOM involved). Not consumed
    // by the DSH module loader.
    module.exports.__linkify = {
      extractLinkTargets,
      parseFileUrlTarget,
      parseWorkspacePathTarget,
      splitLineSuffix,
      tokenAtOffset,
    };
    // Follow-loop timings, exposed so unit tests can shrink the budget instead
    // of sleeping for it. Read on every tick, so a test may retune them after
    // load. Not consumed by the DSH module loader.
    module.exports.__sessionFollowLimits = followLimits;
    return module.exports;
  },
});
