window.__ModuleLoader__.load({
  id: 'dsh-vscode-integration',
  factory: () => {
    const module = { exports: {} };
    const CHANNEL = 'dsh-vscode-interaction';
    const VERSION = 1;
    const TIMEOUT_MS = 10000;
    const pending = new Map();
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

    function onMessage(event) {
      if (event.source !== window.parent) return;
      const message = event.data;
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
        window.addEventListener('message', onMessage);
        document.addEventListener('click', onClick, true);
        const restoreClipboard = installClipboardBridge();
        return () => {
          restoreClipboard();
          document.removeEventListener('click', onClick, true);
          window.removeEventListener('message', onMessage);
          for (const waiter of pending.values()) {
            clearTimeout(waiter.timer);
            waiter.reject(new Error('VS Code integration disposed'));
          }
          pending.clear();
        };
      }, 'dsh-vscode-integration: browser interaction bridge');
    }

    module.exports.apply = apply;
    module.exports.inject = [];
    module.exports.name = 'dsh-vscode-integration';
    return module.exports;
  },
});
