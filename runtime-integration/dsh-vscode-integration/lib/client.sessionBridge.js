window.__ModuleLoader__.load({
  id: 'dsh-vscode-integration',
  chunk: 'client.sessionBridge.js',
  factory: () => {
    const CHANNEL = 'dsh-vscode-session';
    const VERSION = 1;
    const requestId = (value) => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(value);
    const id = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256;
    const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
    const keys = (value, expected) => object(value) && Object.keys(value).every((key) => expected.includes(key)) && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
    const base = ['channel', 'version', 'surfaceId', 'surfaceEpoch', 'type'];
    const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;
    const sameSurface = (a, b) => a.surfaceId === b.surfaceId && a.surfaceEpoch === b.surfaceEpoch;
    // Exact target adapter pairs the hello-ack may carry. Mirrors
    // TARGET_RUNTIME_IDENTITIES in lib/adapters/dsh020.js and the adapterId
    // enum in contracts/session-bridge-v1.json — the three must not drift.
    const TARGET_ADAPTER_IDS = { '0.2.0-rc.1': 'dsh-0.2.0-rc.1', '0.2.0-rc.2': 'dsh-0.2.0-rc.2',
      '0.2.1-rc.1': 'dsh-0.2.1-rc.1', '0.2.1-rc.2': 'dsh-0.2.1-rc.2' };
    const errorCodes = ['INVALID_ARGUMENT', 'UNAUTHENTICATED', 'FORBIDDEN', 'UNSUPPORTED_RUNTIME', 'CAPABILITY_UNAVAILABLE', 'NOT_READY', 'NOT_FOUND', 'CONFLICT', 'STALE_TARGET', 'CANCELLED', 'TIMEOUT', 'TRANSPORT_LOST', 'OUTCOME_UNKNOWN', 'BACKPRESSURE', 'RESYNC_REQUIRED', 'PROTOCOL_MISMATCH', 'INTERNAL'];
    function validTarget(value) {
      const fields = ['surfaceId', 'surfaceEpoch', 'selectionGeneration', 'state'];
      if (!object(value) || !id(value.surfaceId) || !Number.isSafeInteger(value.surfaceEpoch) || value.surfaceEpoch < 0 || !Number.isSafeInteger(value.selectionGeneration) || value.selectionGeneration < 0) return false;
      if (value.state === 'known') return keys(value, [...fields, 'sessionId']) && id(value.sessionId);
      if (value.state === 'unknown') return keys(value, [...fields, 'reason']) && typeof value.reason === 'string' && value.reason.length > 0 && value.reason.length <= 4096;
      return value.state === 'none' && keys(value, fields);
    }
    function validateSessionMessage(message, { direction, method, requestId: expectedRequestId } = {}) {
      if (!object(message) || message.channel !== CHANNEL || message.version !== VERSION || !id(message.surfaceId) || !Number.isSafeInteger(message.surfaceEpoch) || message.surfaceEpoch < 0) return false;
      if (expectedRequestId !== undefined && message.requestId !== expectedRequestId) return false;
      if (direction === 'toBrowser' && !['hello-init', 'request'].includes(message.type)) return false;
      if (direction === 'toHost' && !['hello-ack', 'result', 'targetChanged'].includes(message.type)) return false;
      if (message.type === 'hello-init') return keys(message, [...base, 'nonce']) && typeof message.nonce === 'string' && /^[a-f0-9]{32}$/.test(message.nonce);
      if (message.type === 'hello-ack') {
        if (!keys(message, [...base, 'runtimeVersion', 'adapterId', 'capabilities']) || typeof message.runtimeVersion !== 'string' || message.runtimeVersion.length < 1 || message.runtimeVersion.length > 100 || TARGET_ADAPTER_IDS[message.runtimeVersion] !== message.adapterId) return false;
        if (!keys(message.capabilities, ['navigation', 'targetObservation', 'insertion', 'theme', 'clipboard'])) return false;
        return Object.values(message.capabilities).every((value) => object(value) && (value.state === 'available' ? keys(value, ['state'])
          : keys(value, ['state', 'reason']) && ['unavailable', 'unverified'].includes(value.state) && typeof value.reason === 'string' && value.reason.length > 0 && value.reason.length <= 4096));
      }
      if (message.type === 'targetChanged') return keys(message, [...base, 'target']) && validTarget(message.target) && sameSurface(message, message.target);
      if (message.type === 'result') {
        if (!requestId(message.requestId)) return false;
        if (message.ok === false) {
          const e = message.error;
          return keys(message, [...base, 'requestId', 'ok', 'error']) && keys(e, ['code', 'message', 'retryable', 'effect']) && errorCodes.includes(e.code)
            && typeof e.message === 'string' && e.message.length <= 4096 && typeof e.retryable === 'boolean' && ['none', 'unknown'].includes(e.effect);
        }
        if (message.ok !== true || !keys(message, [...base, 'requestId', 'ok', 'value'])) return false;
        const value = message.value;
        if (method === 'target.get' || method === 'session.navigate') return validTarget(value) && sameSurface(message, value);
        if (method === 'insertion.capture') return keys(value, ['ticketId', 'surfaceId', 'surfaceEpoch', 'selectionGeneration', 'sessionId', 'expiresAt'])
          && id(value.ticketId) && id(value.surfaceId) && id(value.sessionId) && nonnegative(value.surfaceEpoch) && nonnegative(value.selectionGeneration) && nonnegative(value.expiresAt) && sameSurface(message, value);
        if (method === 'insertion.commit') return keys(value, ['inserted']) && value.inserted === true;
        return (method === 'insertion.cancel' || method === 'request.cancel') && value === null;
      }
      if (message.type !== 'request' || !keys(message, [...base, 'requestId', 'method', 'params']) || !requestId(message.requestId)) return false;
      const p = message.params;
      switch (message.method) {
        case 'target.get': return keys(p, []);
        case 'session.navigate': return keys(p, ['sessionId']) && id(p.sessionId);
        case 'insertion.capture': return keys(p, ['expected']) && validTarget(p.expected) && sameSurface(message, p.expected);
        case 'insertion.commit': return keys(p, ['ticketId', 'text']) && id(p.ticketId) && typeof p.text === 'string' && p.text.length <= 1024 * 1024;
        case 'insertion.cancel': return keys(p, ['ticketId']) && id(p.ticketId);
        case 'request.cancel': return keys(p, ['targetRequestId']) && requestId(p.targetRequestId);
        default: return false;
      }
    }

    function createSessionBridge({ ctx, createBrowserSessionAdapter, runtimeIdentity, window: win, nonce, initialSession, clock = Date, timers = globalThis }) {
      if (!runtimeIdentity || TARGET_ADAPTER_IDS[runtimeIdentity.runtimeVersion] !== runtimeIdentity.adapterId) {
        throw new Error('The session bridge requires an exact target runtime identity.');
      }
      let identity;
      let adapter;
      let offTarget = () => {};
      let parentOrigin;
      let disposed = false;
      const requests = new Map();

      function post(message) {
        if (!disposed) win.parent.postMessage(message, parentOrigin === 'null' ? '*' : parentOrigin);
      }
      function envelope(type) { return { channel: CHANNEL, version: VERSION, ...identity, type }; }
      function result(message, ok, value) {
        return { channel: CHANNEL, version: VERSION, surfaceId: message.surfaceId, surfaceEpoch: message.surfaceEpoch,
          type: 'result', requestId: message.requestId, ok, ...(ok ? { value } : { error: value }) };
      }
      function errorOf(error) {
        const known = error && errorCodes.includes(error.code);
        return { code: known ? error.code : 'INTERNAL', message: known ? String(error.message).slice(0, 500) : 'Browser session operation failed', retryable: false, effect: known && error.effect === 'unknown' ? 'unknown' : 'none' };
      }
      function ack() {
        // The loader injects the exact selected identity (dsh_runtime param);
        // the bridge never hardcodes one version over another.
        post({ ...envelope('hello-ack'), ...runtimeIdentity, capabilities: adapter.getCapabilities() });
        post({ ...envelope('targetChanged'), target: adapter.getTarget() });
      }
      function clearRequests() {
        for (const entry of requests.values()) { entry.controller.abort(); timers.clearTimeout(entry.timer); }
        requests.clear();
      }
      function reset() {
        offTarget();
        clearRequests();
        if (adapter) adapter.dispose();
      }
      async function invoke(message, controller, currentAdapter) {
        const params = message.params;
        const op = { requestId: message.requestId, signal: controller.signal };
        switch (message.method) {
          case 'target.get': return currentAdapter.getTarget();
          case 'session.navigate': return currentAdapter.navigate(params.sessionId, op);
          case 'insertion.capture': {
            const ticket = await currentAdapter.captureInsertion(params.expected, op);
            if (controller.signal.aborted) {
              currentAdapter.cancelInsertion(ticket.ticketId);
              throw { code: 'CANCELLED', message: 'Insertion capture cancelled', effect: 'none' };
            }
            return ticket;
          }
          case 'insertion.commit': return currentAdapter.commitInsertion(params.ticketId, params.text, op);
          case 'insertion.cancel': currentAdapter.cancelInsertion(params.ticketId); return null;
          case 'request.cancel': {
            const entry = requests.get(params.targetRequestId);
            if (entry) entry.controller.abort();
            return null;
          }
          default: throw { code: 'INVALID_ARGUMENT', message: 'Unsupported browser operation', effect: 'none' };
        }
      }
      function receive(event) {
        if (disposed || event.source !== win.parent || !validateSessionMessage(event.data, { direction: 'toBrowser' })) return;
        const message = event.data;
        if (message.type === 'hello-init') {
          if (message.nonce !== nonce || (parentOrigin !== undefined && event.origin !== parentOrigin)) return;
          if (identity && (message.surfaceId !== identity.surfaceId || message.surfaceEpoch < identity.surfaceEpoch)) return;
          if (!identity || message.surfaceEpoch !== identity.surfaceEpoch) {
            reset();
            identity = { surfaceId: message.surfaceId, surfaceEpoch: message.surfaceEpoch };
            parentOrigin = event.origin;
            adapter = createBrowserSessionAdapter({ ctx, surfaceIdentity: identity, document: win.document, clock, timers });
            offTarget = adapter.observeTarget((target) => post({ ...envelope('targetChanged'), target }));
            if (id(initialSession)) void adapter.navigate(initialSession, { requestId: 'initial_navigation' }).catch(() => {});
          }
          ack();
          return;
        }
        if (!identity || event.origin !== parentOrigin || message.surfaceId !== identity.surfaceId || message.surfaceEpoch !== identity.surfaceEpoch) return;
        const payload = JSON.stringify({ method: message.method, params: message.params });
        const previous = requests.get(message.requestId);
        if (previous) {
          if (previous.payload !== payload) { post(result(message, false, errorOf({ code: 'CONFLICT', message: 'Request identity was reused with different parameters' }))); return; }
          const generation = identity;
          previous.promise.then((response) => { if (identity === generation && !disposed) post(response); });
          return;
        }
        for (const [key, entry] of requests) if (entry.expiresAt <= clock.now()) { timers.clearTimeout(entry.timer); requests.delete(key); }
        if (requests.size >= 256) {
          post(result(message, false, errorOf({ code: 'BACKPRESSURE', message: 'Browser request capacity is full' })));
          return;
        }
        const generation = identity;
        const controller = new AbortController();
        const entry = { controller, payload, expiresAt: Infinity, timer: undefined, promise: undefined };
        const currentAdapter = adapter;
        entry.promise = Promise.resolve().then(() => invoke(message, controller, currentAdapter)).then(
          (value) => result(message, true, value), (error) => result(message, false, errorOf(error)),
        ).then((response) => {
          if (!disposed && identity === generation && requests.get(message.requestId) === entry) {
            entry.expiresAt = clock.now() + 120000;
            entry.timer = timers.setTimeout(() => { if (requests.get(message.requestId) === entry) requests.delete(message.requestId); }, 120000);
          }
          return response;
        });
        requests.set(message.requestId, entry);
        entry.promise.then((response) => { if (identity === generation && !disposed) post(response); });
      }
      win.addEventListener('message', receive);
      return Object.freeze({
        dispose() { if (disposed) return; disposed = true; win.removeEventListener('message', receive); reset(); },
        getDiagnostics: () => Object.freeze({
          pendingRequests: [...requests.values()].filter((entry) => entry.expiresAt === Infinity).length,
          requestReceipts: [...requests.values()].filter((entry) => entry.expiresAt !== Infinity).length,
          ...(adapter ? adapter.getDiagnostics() : {}),
        }),
      });
    }
    return { createSessionBridge, validateSessionMessage, validateSessionRequest: (value) => validateSessionMessage(value, { direction: 'toBrowser' }), validTarget };
  },
});
