window.__ModuleLoader__.load({
  id: 'dsh-vscode-integration',
  chunk: 'client.dsh020.js',
  factory: () => {
    const fail = (code, message, effect = 'none') => Object.assign(new Error(message), { code, retryable: false, effect });
    const isSource = (source) => source && typeof source.getSnapshot === 'function' && typeof source.subscribe === 'function';
    const isId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 256 && !id.includes('\0');

    /** Exact DSH 0.2.0 target-line public browser service adapter (identity injected by the loader); no DOM or private selection access. */
    function createBrowserSessionAdapter({ ctx, surfaceIdentity, document: doc, clock = Date, timers = globalThis }) {
      const identity = Object.freeze({ surfaceId: surfaceIdentity.surfaceId, surfaceEpoch: surfaceIdentity.surfaceEpoch });
      const source = ctx.uiSession && ctx.uiSession.adapter && ctx.uiSession.adapter.current;
      const panel = ctx.layout && ctx.layout.panelInfo;
      const listeners = new Set();
      const tickets = new Map();
      const receipts = new Map();
      const navigationWaiters = new Set();
      let sequence = 0;
      let disposed = false;
      let target = Object.freeze({ ...identity, selectionGeneration: 0, state: 'unknown', reason: 'Session observation is not ready' });
      let generationBinding;
      let presentationTimer;

      function rightbarReason() {
        if (!ctx.sidebarRight || typeof ctx.sidebarRight.isExpanded !== 'function') return 'Public right-sidebar visibility is unavailable';
        if (ctx.sidebarRight.isExpanded()) return 'Close the DSH right sidebar before adding content to the main conversation';
        if (typeof ctx.sidebarRight.focusedTarget === 'function' && ctx.sidebarRight.focusedTarget()) return 'Focus the main DSH conversation before adding content; floating sidebar pages are not insertion targets';
        return undefined;
      }

      function readTarget() {
        if (!isSource(source) || !isSource(panel)) return { state: 'unknown', reason: 'Public session observation is unavailable' };
        const selection = panel.getSnapshot();
        if (!selection || !Object.prototype.hasOwnProperty.call(selection, 'activePanelId')) return { state: 'unknown', reason: 'Panel observation is unavailable' };
        if (selection.activePanelId !== null) return { state: 'none' };
        const blocked = rightbarReason();
        if (blocked) return { state: 'unknown', reason: blocked };
        const binding = source.getSnapshot();
        if (!binding || !binding.props) return { state: 'unknown', reason: 'Session binding is unavailable' };
        if (binding.key === undefined) return { state: 'none' };
        if (!isId(binding.key) || binding.props.sessionId !== binding.key) return { state: 'unknown', reason: 'Session binding identity is invalid' };
        return { state: 'known', sessionId: binding.key };
      }

      function releaseTicket(entry) {
        if (entry.released) return;
        entry.released = true;
        timers.clearTimeout(entry.timer);
        entry.reference.release();
      }

      function cancelInsertion(ticketId) {
        const entry = tickets.get(ticketId);
        if (!entry) return;
        tickets.delete(ticketId);
        releaseTicket(entry);
      }

      function reconcile() {
        if (disposed) return;
        let next;
        let binding;
        try {
          next = readTarget();
          binding = next.state === 'known' ? ctx.sessions.binding(next.sessionId) : undefined;
        } catch { next = { state: 'unknown', reason: 'Session observation failed' }; }
        if (next.state === target.state && next.sessionId === target.sessionId && next.reason === target.reason && binding === generationBinding) return;
        generationBinding = binding;
        target = Object.freeze({ ...identity, selectionGeneration: target.selectionGeneration + 1, ...next });
        for (const id of [...tickets.keys()]) cancelInsertion(id);
        for (const listener of [...listeners]) {
          try { listener(target); } catch { listeners.delete(listener); }
        }
      }

      const offSource = isSource(source) ? source.subscribe(reconcile) : () => {};
      const offPanel = isSource(panel) ? panel.subscribe(reconcile) : () => {};
      // No rightbar-expanded observable is exposed. Events merely trigger a
      // fresh public API read after its UI commit; no DOM ownership is inferred.
      const refreshPresentation = () => {
        timers.clearTimeout(presentationTimer);
        presentationTimer = timers.setTimeout(reconcile, 0);
      };
      const presentationEvents = ['focusin', 'pointerup', 'keyup'];
      if (doc && typeof doc.addEventListener === 'function') for (const event of presentationEvents) doc.addEventListener(event, refreshPresentation, true);
      reconcile();

      function assertLive(op) {
        if (disposed) throw fail('NOT_READY', 'Browser session adapter is disposed');
        if (op && op.signal && op.signal.aborted) throw fail('CANCELLED', 'Operation cancelled');
      }

      function assertTarget(expected) {
        reconcile();
        if (target.state === 'unknown') throw fail('CAPABILITY_UNAVAILABLE', target.reason);
        if (target.state === 'none') throw fail('NOT_READY', 'No visible conversation');
        if (!expected || expected.state !== 'known' || expected.surfaceId !== identity.surfaceId || expected.surfaceEpoch !== identity.surfaceEpoch
          || expected.selectionGeneration !== target.selectionGeneration || expected.sessionId !== target.sessionId) {
          throw fail('STALE_TARGET', 'Visible conversation changed');
        }
      }

      function deadline(op) { return Math.max(1, Math.min(30000, Number(op && op.timeoutMs) || 30000)); }

      async function navigate(sessionId, op) {
        assertLive(op);
        if (!isId(sessionId)) throw fail('INVALID_ARGUMENT', 'Invalid session identity');
        if (!ctx.uiWorkspace || typeof ctx.uiWorkspace.openSession !== 'function' || !isSource(source) || !isSource(panel)) {
          throw fail('CAPABILITY_UNAVAILABLE', 'Public session navigation is unavailable');
        }
        return new Promise((resolve, reject) => {
          let timer;
          let offReady = () => {};
          let opened = false;
          let finished = false;
          const signal = op && op.signal;
          const finish = (error, value) => {
            if (finished) return;
            finished = true;
            timers.clearTimeout(timer);
            offReady();
            listeners.delete(check);
            navigationWaiters.delete(stop);
            if (signal) signal.removeEventListener('abort', abort);
            if (error) reject(error); else resolve(value);
          };
          const check = () => {
            if (opened && target.state === 'known' && target.sessionId === sessionId) finish(null, target);
          };
          const open = () => {
            if (finished || opened) return;
            // Early browser activation precedes the Session Controller's first
            // snapshot. retain/openSession cannot address those identities yet.
            const list = ctx.sessions && ctx.sessions.list;
            if (isSource(list) && list.getSnapshot().phase !== 'ready') return;
            opened = true;
            try {
              // Supersede an asynchronous upstream startup restoration through
              // the public navigation lifetime before selecting our target.
              if (typeof ctx.layout.beginNavigation === 'function') ctx.layout.beginNavigation();
              if (ctx.sidebarRight && ctx.sidebarRight.isExpanded() && typeof ctx.sidebarRight.toggleExpanded === 'function') ctx.sidebarRight.toggleExpanded();
              ctx.uiWorkspace.openSession(sessionId); reconcile(); check();
            } catch { finish(fail('NOT_FOUND', 'Session could not be opened')); }
          };
          const stop = () => finish(fail('CANCELLED', 'Browser surface was disposed'));
          const abort = () => finish(fail('CANCELLED', 'Navigation wait cancelled', 'unknown'));
          listeners.add(check);
          navigationWaiters.add(stop);
          if (signal) signal.addEventListener('abort', abort, { once: true });
          timer = timers.setTimeout(() => finish(fail('TIMEOUT', 'Navigation was not observed', 'unknown')), deadline(op));
          if (isSource(ctx.sessions && ctx.sessions.list)) offReady = ctx.sessions.list.subscribe(open);
          open();
        });
      }

      function pruneReceipts() {
        for (const [id, entry] of receipts) if (entry.expiresAt <= clock.now()) receipts.delete(id);
      }

      async function captureInsertion(expected, op) {
        assertLive(op);
        assertTarget(expected);
        pruneReceipts();
        if (tickets.size >= 32 || tickets.size + receipts.size >= 256) throw fail('BACKPRESSURE', 'Insertion capacity is full');
        if (!ctx.sessions || typeof ctx.sessions.retain !== 'function' || typeof ctx.uiSession.bindingSource !== 'function') {
          throw fail('CAPABILITY_UNAVAILABLE', 'Public insertion binding is unavailable');
        }
        // The binding is already live because it is visible. retain extends that exact
        // generation; waiting on ready here would unnecessarily wait for history I/O.
        const reference = ctx.sessions.retain(target.sessionId, { source: 'vscodeInsertion', signal: op && op.signal });
        let retained = false;
        try {
          assertLive(op);
          assertTarget(expected);
          if (reference.binding !== generationBinding) throw fail('STALE_TARGET', 'Session generation changed');
          const snapshot = ctx.uiSession.bindingSource(reference).getSnapshot();
          const actions = snapshot && snapshot.props && snapshot.props.inputActions;
          if (!actions || typeof actions.captureInsertion !== 'function' || typeof actions.insertText !== 'function') {
            throw fail('CAPABILITY_UNAVAILABLE', 'Revision guarded input is unavailable');
          }
          const span = actions.captureInsertion();
          const ticket = Object.freeze({ ...identity, selectionGeneration: target.selectionGeneration, sessionId: target.sessionId,
            ticketId: `insert_${(++sequence).toString(36)}`, expiresAt: clock.now() + 30000 });
          const entry = { ticket, span, actions, reference, released: false, timer: undefined };
          entry.timer = timers.setTimeout(() => cancelInsertion(ticket.ticketId), 30000);
          tickets.set(ticket.ticketId, entry);
          retained = true;
          return ticket;
        } finally { if (!retained) reference.release(); }
      }

      async function commitInsertion(ticketId, text, op) {
        assertLive(op);
        if (typeof text !== 'string' || text.length === 0 || new TextEncoder().encode(text).length > 1024 * 1024) throw fail('INVALID_ARGUMENT', 'Invalid insertion text');
        pruneReceipts();
        const previous = receipts.get(ticketId);
        if (previous) {
          if (previous.text !== text) throw fail('CONFLICT', 'Insertion ticket payload changed');
          return previous.result;
        }
        const entry = tickets.get(ticketId);
        if (!entry) throw fail('STALE_TARGET', 'Insertion ticket is no longer active');
        try {
          if (entry.ticket.expiresAt <= clock.now()) throw fail('STALE_TARGET', 'Insertion ticket expired');
          assertTarget({ ...entry.ticket, state: 'known' });
          if (entry.reference.binding !== generationBinding) throw fail('STALE_TARGET', 'Session generation changed');
          if (!entry.actions.insertText(text, entry.span)) throw fail('CONFLICT', 'Draft changed or input is locked');
          const result = Object.freeze({ inserted: true });
          receipts.set(ticketId, { text, result, expiresAt: clock.now() + 120000 });
          return result;
        } finally { cancelInsertion(ticketId); }
      }

      function getCapabilities() {
        const capability = (supported, reason) => Object.freeze(supported ? { state: 'available' } : { state: 'unavailable', reason });
        const observed = isSource(source) && isSource(panel);
        let theme;
        try { theme = typeof ctx.get === 'function' ? ctx.get('theme') : undefined; } catch { /* optional service */ }
        return Object.freeze({
          navigation: capability(observed && ctx.uiWorkspace && typeof ctx.uiWorkspace.openSession === 'function', 'Public navigation service is unavailable'),
          targetObservation: capability(observed, 'Public session observation is unavailable'),
          insertion: capability(observed && !rightbarReason() && ctx.uiSession && typeof ctx.uiSession.bindingSource === 'function' && ctx.sessions && typeof ctx.sessions.retain === 'function', rightbarReason() || 'Public insertion service is unavailable'),
          theme: capability(Boolean(theme), 'Theme service is unavailable'),
          clipboard: capability(true),
        });
      }

      return Object.freeze({
        getTarget() { reconcile(); return target; },
        observeTarget(listener) {
          assertLive();
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        navigate, captureInsertion, commitInsertion, cancelInsertion,
        dispose() {
          if (disposed) return;
          disposed = true;
          offSource(); offPanel();
          timers.clearTimeout(presentationTimer);
          if (doc && typeof doc.removeEventListener === 'function') for (const event of presentationEvents) doc.removeEventListener(event, refreshPresentation, true);
          for (const stop of [...navigationWaiters]) stop();
          for (const id of [...tickets.keys()]) cancelInsertion(id);
          receipts.clear(); listeners.clear();
        },
        getDiagnostics: () => Object.freeze({ tickets: tickets.size, receipts: receipts.size, retains: tickets.size, observers: listeners.size }),
        getCapabilities,
      });
    }
    return { createBrowserSessionAdapter };
  },
});
