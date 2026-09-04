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
    // session list loads asynchronously), then route it through
    // sessions.open() exactly like a user click on the session row.
    // Session-current watcher: a conversation switch performed INSIDE the
    // DSH web UI (session-row click) is invisible to the VS Code shell — the
    // shell only re-renders on its own navigation commands, so the changes
    // tree and the workspace binding kept pointing at the previous session
    // (live bug 2026-09-04: "switching conversations did not switch the
    // changes view"). Poll the session-list mirror's `current` pointer and
    // announce every change to the shell; the shell relays the
    // dshSessionChanged message to the extension host.
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
          const current = snapshot && typeof snapshot.current === 'string' ? snapshot.current : null;
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

    function startEmbeddedSessionFollow(ctx) {
      const target = new URLSearchParams(window.location.search).get('dsh_session');
      if (!target) return () => {};
      if (!ctx.sessions || typeof ctx.sessions.open !== 'function') return () => {};
      if (!ctx.sessions.list || typeof ctx.sessions.list.getSnapshot !== 'function') return () => {};
      let disposed = false;
      let timer = null;
      const attempt = (remaining) => {
        if (disposed) return;
        let snapshot = null;
        try {
          snapshot = ctx.sessions.list.getSnapshot();
        } catch {
          // A broken snapshot store must never break activation.
          return;
        }
        if (snapshot && snapshot.byId && snapshot.byId[target] !== undefined) {
          if (snapshot.current !== target) {
            try {
              ctx.sessions.open(target);
            } catch {
              // select() can race list refreshes; the next reload retries.
            }
          }
          return;
        }
        if (remaining > 0) {
          timer = setTimeout(() => attempt(remaining - 1), 100);
        }
      };
      attempt(50);
      return () => {
        disposed = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      };
    }

    // B3 (issue #6): reply-path linkify. Recognizes two clickable forms in
    // rendered message text — file:/// URLs (including Windows drive form
    // file:///D:/...) and workspace-relative paths with an optional :line or
    // :line:col suffix — wraps them in <a class="dsh-vscode-file-link">, and
    // POSTs the parsed target to the same-origin /api/vscode/open-link route
    // registered by this package's host side, which opens the file in the
    // owning VS Code window. The pure extraction helpers are exposed on
    // module.exports.__linkify for unit tests (no DOM required).
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

    function linkifyTextNode(node) {
      const parent = node.parentNode;
      if (!parent || typeof parent.replaceChild !== 'function') return;
      // Never link text that already lives inside a link/button (this also
      // stops the observer from re-wrapping our own anchors' text).
      const owner = node.parentElement;
      if (owner && typeof owner.closest === 'function' && owner.closest('a,button')) return;
      const text = node.nodeValue;
      const targets = extractLinkTargets(text);
      if (targets.length === 0) return;
      const fragment = document.createDocumentFragment();
      let cursor = 0;
      for (const target of targets) {
        if (target.start > cursor) {
          fragment.appendChild(document.createTextNode(text.slice(cursor, target.start)));
        }
        const anchor = document.createElement('a');
        anchor.setAttribute('class', 'dsh-vscode-file-link');
        anchor.setAttribute('role', 'link');
        anchor.setAttribute('tabindex', '0');
        anchor.setAttribute('data-dsh-link-path', target.path);
        if (target.line !== undefined) anchor.setAttribute('data-dsh-link-line', String(target.line));
        if (target.col !== undefined) anchor.setAttribute('data-dsh-link-col', String(target.col));
        anchor.textContent = text.slice(target.start, target.end);
        fragment.appendChild(anchor);
        cursor = target.end;
      }
      if (cursor < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(cursor)));
      }
      parent.replaceChild(fragment, node);
    }

    function scanElementTree(root) {
      let budget = LINKIFY_MAX_NODES_PER_SCAN;
      const visit = (node) => {
        if (budget <= 0) return;
        budget -= 1;
        if (node.nodeType === 3) {
          linkifyTextNode(node);
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
        for (let index = 0; index < children.length; index += 1) visit(children[index]);
      };
      visit(root);
    }

    function onLinkifyClick(event) {
      if (event.defaultPrevented || event.button !== 0) return;
      const target = event.target;
      const element = target && typeof target.closest === 'function'
        ? target.closest('a.dsh-vscode-file-link')
        : null;
      if (!element) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const path = element.getAttribute('data-dsh-link-path') || '';
      if (path.length === 0) return;
      const line = Number(element.getAttribute('data-dsh-link-line')) || undefined;
      const col = Number(element.getAttribute('data-dsh-link-col')) || undefined;
      fetch(LINKIFY_OPEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-DSH-VSCode-Linkify': '1' },
        body: JSON.stringify({ path, line, col }),
      }).catch(() => {
        // Opening is best-effort; a failed click must never break the page.
      });
    }

    function installReplyLinkify() {
      if (typeof document.createElement !== 'function') return () => {};
      if (typeof document.createDocumentFragment !== 'function') return () => {};
      if (!document.body || typeof window.MutationObserver !== 'function') return () => {};
      if (typeof fetch !== 'function') return () => {};
      const style = document.createElement('style');
      style.textContent = 'a.dsh-vscode-file-link{cursor:pointer;text-decoration:underline;text-underline-offset:2px}a.dsh-vscode-file-link:hover{opacity:.85}';
      (document.head || document.body).appendChild(style);
      // One initial pass over already-rendered messages; afterwards only new
      // subtrees are post-processed (no whole-page rescans).
      scanElementTree(document.body);
      const observer = new window.MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes || []) {
            if (node.nodeType === 3) linkifyTextNode(node);
            else if (node.nodeType === 1) scanElementTree(node);
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      document.addEventListener('click', onLinkifyClick, true);
      return () => {
        observer.disconnect();
        document.removeEventListener('click', onLinkifyClick, true);
        if (style.parentNode && typeof style.parentNode.removeChild === 'function') {
          style.parentNode.removeChild(style);
        }
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
    // text; no DOM involved). Not consumed by the DSH module loader.
    module.exports.__linkify = {
      extractLinkTargets,
      parseFileUrlTarget,
      parseWorkspacePathTarget,
      splitLineSuffix,
    };
    return module.exports;
  },
});
