'use strict';

const { randomBytes, randomUUID } = require('node:crypto');
const { createRuntimeIdentity, runtimeIdentityKey, identityToResolvedRuntime } = require('./identity');
const { TARGET_ADAPTER, portError, verifyNodeRuntime, assertCapabilityIdentity } = require('./compatibility');

const STARTUP_MS = 30000;
const COOLDOWN_MS = 30000;

/**
 * Owns only the target facade lifecycle. Legacy launches retain their existing
 * manager path. resolver returns { runtime, serverOptions, closePolicy,
 * borrowedCredentials? }; credentials never leave this closure.
 */
function createRuntimeSupervisor({
  resolver, serverManager, prepareIntegration, createClient,
  clock = { now: () => Date.now() }, timers = { setTimeout, clearTimeout }, logger = () => {},
  verifyNode = verifyNodeRuntime, createInstanceId = randomUUID,
  createToken = () => randomBytes(32).toString('base64url'),
  getClosePolicy,
} = {}) {
  if (typeof resolver !== 'function' || !serverManager || typeof createClient !== 'function'
      || typeof prepareIntegration !== 'function') throw new TypeError('RuntimeSupervisor dependencies are required');
  let generation = 0;
  let disposed = false;
  let current = null;
  let selected = null;
  let activeController = null;
  let tail = Promise.resolve();
  let disposal = null;
  let failure = null;
  let closePolicy = 'onVscodeExit';
  let ownsLifecycle = false;
  const pending = new Map();

  const log = (state) => {
    try { logger({ component: 'runtime', state }); } catch { /* diagnostics cannot affect ownership */ }
  };
  const enqueue = (task) => {
    const operation = tail.then(task, task);
    tail = operation.catch(() => {});
    return operation;
  };
  const check = (expected, signal) => {
    if (disposed || generation !== expected || signal?.aborted) {
      throw typeof signal?.reason?.code === 'string' ? signal.reason : portError('CANCELLED', 'Runtime operation was cancelled.');
    }
  };
  function waitFor(promise, op = {}, timeoutMs = STARTUP_MS) {
    if (op.signal?.aborted) return Promise.reject(portError('CANCELLED', 'Runtime operation was cancelled.'));
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        timers.clearTimeout(timer);
        op.signal?.removeEventListener('abort', cancel);
        fn(value);
      };
      const cancel = () => finish(reject, typeof op.signal.reason?.code === 'string' ? op.signal.reason : portError('CANCELLED', 'Runtime operation was cancelled.'));
      const budget = Number.isFinite(op.timeoutMs) && op.timeoutMs > 0 ? Math.min(timeoutMs, op.timeoutMs) : timeoutMs;
      timer = timers.setTimeout(() => finish(reject, portError('TIMEOUT', 'Runtime operation timed out.', true)), budget);
      op.signal?.addEventListener('abort', cancel, { once: true });
      Promise.resolve(promise).then((value) => finish(resolve, value), (error) => finish(reject, error));
    });
  }
  async function stopOwned() {
    if (ownsLifecycle) {
      await serverManager.stop();
      ownsLifecycle = false;
      serverManager.setSpawnEnv?.({ DSH_VSCODE_API_TOKEN: undefined, DSH_VSCODE_RUNTIME_INSTANCE_ID: undefined, DSH_VSCODE_RUNTIME_VERSION: undefined });
    }
    current = null;
  }
  async function start(identity, key, expected, requestId, explicit) {
    check(expected);
    if (current?.key === key) {
      try {
        const lease = current.lease;
        const caps = await waitFor(lease.api.capabilities({ requestId, signal: new AbortController().signal, timeoutMs: 5000 }), {}, 5000);
        check(expected);
        assertCapabilityIdentity(caps, identity, lease.instanceId);
        return lease;
      } catch (error) {
        await stopOwned();
        if (generation === expected && !disposed) failure = { key, at: clock.now() };
        throw error?.code ? error : portError('TRANSPORT_LOST', 'Runtime readiness was lost.', true);
      }
    }
    if (!explicit && failure?.key === key && clock.now() - failure.at < COOLDOWN_MS) {
      throw portError('NOT_READY', 'Runtime startup is cooling down after a failed attempt.', true);
    }
    const controller = new AbortController();
    activeController = controller;
    const deadline = timers.setTimeout(() => controller.abort(portError('TIMEOUT', 'Runtime startup timed out.', true)), STARTUP_MS);
    const op = { requestId, signal: controller.signal, timeoutMs: STARTUP_MS };
    const step = async (promise) => {
      const value = await waitFor(promise, op);
      check(expected, controller.signal);
      return value;
    };
    let startingOwned = false;
    try {
      if (current) { log('stopping'); await step(stopOwned()); }
      log('resolving');
      const resolved = await step(resolver(identity, op));
      if (!resolved || !resolved.serverOptions) throw portError('INVALID_ARGUMENT', 'The resolver did not return launch options.');
      const options = resolved.serverOptions;
      closePolicy = ['never', 'onVscodeExit', 'onViewClose'].includes(resolved.closePolicy) ? resolved.closePolicy : 'onVscodeExit';
      const borrowed = options.autoStart === false;
      let token;
      let instanceId;
      if (borrowed) {
        token = resolved.borrowedCredentials?.token;
        instanceId = resolved.borrowedCredentials?.instanceId;
        if (typeof token !== 'string' || token.length < 32 || typeof instanceId !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(instanceId)) {
          throw portError('CAPABILITY_UNAVAILABLE', 'The external runtime has no trusted integration handshake.');
        }
      } else {
        if (serverManager.hasOwnedChild?.() && !ownsLifecycle) {
          throw portError('CONFLICT', 'This server manager is owned by another runtime lifecycle.');
        }
        await step(verifyNode(identity.executablePath, { signal: controller.signal }));
        log('preparing');
        const prepared = await step(prepareIntegration(identity, op));
        const runtime = resolved.runtime || identityToResolvedRuntime(identity);
        // Prevent a resolver from validating one selection then launching another.
        const expectedRuntime = identityToResolvedRuntime(identity);
        for (const name of ['executablePath', 'dshHome', 'profileHome', 'profileName', 'dshVersion']) {
          if (runtime[name] !== expectedRuntime[name]) throw portError('CONFLICT', 'The resolved launch does not match its runtime identity.');
        }
        if (JSON.stringify(runtime.entrypointArgs) !== JSON.stringify(expectedRuntime.entrypointArgs)) {
          throw portError('CONFLICT', 'The resolved entrypoint does not match its runtime identity.');
        }
        serverManager.setResolvedRuntime(runtime);
        if (prepared?.embedPatchPath) serverManager.setEmbedPatchPath(prepared.embedPatchPath);
        token = createToken();
        instanceId = createInstanceId();
        serverManager.setSpawnEnv({ DSH_VSCODE_API_TOKEN: token, DSH_VSCODE_RUNTIME_INSTANCE_ID: instanceId, DSH_VSCODE_RUNTIME_VERSION: identity.runtimeVersion });
        startingOwned = true;
        ownsLifecycle = true;
      }
      log('starting');
      const server = await step(serverManager.ensureServer(options));
      if (server.owned !== !borrowed) throw portError('CONFLICT', 'Runtime process ownership differs from the selected launch mode.');
      log('authenticating');
      // endpoint may contain the owned startup token; it remains transport-private.
      const api = createClient({ endpoint: server.url, tokenProvider: () => token, expectedInstanceId: instanceId, clock, timers });
      const capabilities = await step(api.capabilities({ ...op, timeoutMs: 5000 }));
      assertCapabilityIdentity(capabilities, identity, instanceId);
      const lease = Object.freeze({ instanceId, identity, owned: server.owned, api });
      current = { key, lease };
      failure = null;
      log('ready');
      return lease;
    } catch (error) {
      serverManager.cancelPending?.();
      if (startingOwned || current?.lease.owned) await stopOwned();
      else current = null;
      const safe = error?.code && typeof error.retryable === 'boolean' && ['none', 'unknown'].includes(error.effect)
        ? error : portError('NOT_READY', 'The DSH runtime could not become ready.', true);
      if (generation === expected && !disposed && safe.code !== 'CANCELLED') failure = { key, at: clock.now() };
      log(disposed || generation !== expected ? 'idle' : 'failed');
      throw safe;
    } finally {
      timers.clearTimeout(deadline);
      if (activeController === controller) activeController = null;
    }
  }
  function ensureInternal(selection, op = {}, explicit = false) {
    if (disposed) return Promise.reject(portError('CANCELLED', 'Runtime supervisor is disposed.'));
    let identity;
    let key;
    try {
      identity = createRuntimeIdentity(selection);
      if (identity.adapterId !== TARGET_ADAPTER) throw portError('UNSUPPORTED_RUNTIME', 'This supervisor requires the target facade adapter.');
      key = runtimeIdentityKey(identity);
    } catch (error) { return Promise.reject(error); }
    if (op.signal?.aborted) return Promise.reject(portError('CANCELLED', 'Runtime operation was cancelled.'));
    selected = identity;
    const expected = generation;
    const pendingKey = `${expected}:${key}`;
    let operation = pending.get(pendingKey);
    if (!operation) {
      if (pending.size >= 32) return Promise.reject(portError('BACKPRESSURE', 'Too many pending runtime selections.', true));
      operation = enqueue(() => start(identity, key, expected, op.requestId, explicit));
      pending.set(pendingKey, operation);
      operation.finally(() => { if (pending.get(pendingKey) === operation) pending.delete(pendingKey); }).catch(() => {});
    }
    // One caller cancelling its wait must not cancel another caller's startup.
    return waitFor(operation, op);
  }
  function invalidate() {
    generation += 1;
    activeController?.abort(portError('CANCELLED', 'Runtime operation was cancelled.'));
    serverManager.cancelPending?.();
  }
  function stop(op = {}) {
    invalidate();
    return waitFor(enqueue(async () => { log('stopping'); await stopOwned(); log('idle'); }), op);
  }
  async function restart(op = {}) {
    if (disposed) throw portError('CANCELLED', 'Runtime supervisor is disposed.');
    if (current && !current.lease.owned) throw portError('FORBIDDEN', 'An external runtime cannot be restarted by this window.');
    if (!selected) throw portError('NOT_READY', 'No runtime selection is available.');
    const selection = selected;
    await stop(op);
    return ensureInternal(selection, op, true);
  }
  function dispose() {
    if (disposal) return disposal;
    disposed = true;
    invalidate();
    disposal = enqueue(async () => {
      if (typeof getClosePolicy === 'function') {
        const latest = getClosePolicy();
        closePolicy = ['never', 'onVscodeExit', 'onViewClose'].includes(latest) ? latest : 'onVscodeExit';
      }
      if (closePolicy === 'never' && current?.lease.owned) {
        serverManager.detach?.();
        ownsLifecycle = false;
        serverManager.setSpawnEnv?.({ DSH_VSCODE_API_TOKEN: undefined, DSH_VSCODE_RUNTIME_INSTANCE_ID: undefined, DSH_VSCODE_RUNTIME_VERSION: undefined });
        current = null;
      } else await stopOwned();
      selected = null;
      pending.clear();
      log('disposed');
    });
    return disposal;
  }
  return Object.freeze({ ensure: ensureInternal, restart, stop, dispose });
}

module.exports = { createRuntimeSupervisor, STARTUP_MS, COOLDOWN_MS };
