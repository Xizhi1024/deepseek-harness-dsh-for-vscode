window.__ModuleLoader__.load({
  id: 'dsh-vscode-integration',
  factory: () => {
    const module = { exports: {} };
    const CHANNEL = 'dsh-vscode-interaction';
    const VERSION = 1;
    const THREAD_CHANNEL = 'dsh-vscode-thread';
    const THREAD_VERSION = 1;
    const TIMEOUT_MS = 10000;
    const pending = new Map();
    const threadRequests = new Map();
    let sequence = 0;

    function enabled() {
      return window.parent !== window && new URLSearchParams(window.location.search).get('dsh_embed') === 'vscode';
    }

    function request(method, params) {
      const requestId = `${Date.now().toString(36)}_${(++sequence).toString(36)}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`VS Code ${method} request timed out`));
        }, TIMEOUT_MS);
        pending.set(requestId, { resolve, reject, timer });
        window.parent.postMessage({
          type: 'dshBridge', channel: CHANNEL, version: VERSION, requestId, method, params,
        }, '*');
      });
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

    function onMessage(ctx, event) {
      if (event.source !== window.parent) return;
      const message = event.data;
      if (
        message && message.type === 'dshThreadAttach'
        && message.channel === THREAD_CHANNEL && message.version === THREAD_VERSION
      ) {
        handleThreadAttach(ctx, message);
        return;
      }
      if (!message || message.type !== 'dshBridgeResult' || message.channel !== CHANNEL || message.version !== VERSION) return;
      const waiter = pending.get(message.requestId);
      if (!waiter) return;
      pending.delete(message.requestId);
      clearTimeout(waiter.timer);
      if (message.ok) waiter.resolve();
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

    function onClick(event) {
      if (event.defaultPrevented || event.button !== 0) return;
      const element = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!element) return;
      let url;
      try { url = new URL(element.href); } catch { return; }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      request('link/open', { url: url.toString() }).catch(() => {});
    }

    function apply(ctx) {
      if (!enabled()) return;
      ctx.effect(() => {
        const listener = (event) => onMessage(ctx, event);
        window.addEventListener('message', listener);
        document.addEventListener('click', onClick, true);
        const restoreClipboard = installClipboardBridge();
        window.parent.postMessage({
          type: 'dshThreadReady', channel: THREAD_CHANNEL, version: THREAD_VERSION,
        }, '*');
        return () => {
          restoreClipboard();
          document.removeEventListener('click', onClick, true);
          window.removeEventListener('message', listener);
          for (const waiter of pending.values()) {
            clearTimeout(waiter.timer);
            waiter.reject(new Error('VS Code integration disposed'));
          }
          pending.clear();
          threadRequests.clear();
        };
      }, 'dsh-vscode-integration: browser interaction bridge');
    }

    module.exports.apply = apply;
    module.exports.inject = ['conversation', 'sessions'];
    module.exports.name = 'dsh-vscode-integration';
    return module.exports;
  },
});
