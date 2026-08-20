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
        const listener = (event) => onMessage(ctx, event);
        window.addEventListener('message', listener);
        document.addEventListener('click', onClick, true);
        const restoreClipboard = installClipboardBridge();
        const restoreExecFallback = installExecCommandFallback();
        const restoreMacShortcutBridge = installMacShortcutBridge();
        window.parent.postMessage({
          type: 'dshThreadReady', channel: THREAD_CHANNEL, version: THREAD_VERSION,
        }, '*');
        return () => {
          if (handshakeTimer) clearTimeout(handshakeTimer);
          restoreClipboard();
          restoreExecFallback();
          restoreMacShortcutBridge();
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
    return module.exports;
  },
});
