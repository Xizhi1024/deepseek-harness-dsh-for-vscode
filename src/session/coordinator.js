'use strict';

const { createPortError, validateVisibleTarget, validateInsertionTicket, LIMITS } = require('../protocol/runtime');

function createSessionCoordinator({ workspaceBinding, createRequestId,
  clock = { now: () => Date.now() }, timers = { setTimeout, clearTimeout }, logger = () => {} } = {}) {
  let sequence = 0;
  const nextRequestId = createRequestId || (() => `session-${++sequence}`);
  let disposed = false;
  const surfaces = new Map();
  const stale = () => createPortError('STALE_TARGET', 'The target surface changed');
  const cancelled = () => createPortError('CANCELLED', 'Operation cancelled');
  function entryFor(id) {
    const entry = surfaces.get(id);
    if (disposed || !entry || entry.closed) throw createPortError('NOT_FOUND', 'Surface is unavailable');
    return entry;
  }
  function current(entry) {
    if (disposed || entry.closed || surfaces.get(entry.id) !== entry) throw stale();
  }
  function updateTarget(entry, target) {
    if (!validateVisibleTarget(target) || target.surfaceId !== entry.id || target.surfaceEpoch !== entry.epoch
      || target.selectionGeneration < entry.target.selectionGeneration) return;
    entry.target = Object.freeze({ ...target });
  }
  function releaseEntry(entry) {
    if (entry.closed) return;
    entry.closed = true;
    if (surfaces.get(entry.id) === entry) surfaces.delete(entry.id);
    for (const controller of entry.operations) controller.abort();
    for (const ticketId of entry.tickets) {
      try { entry.browser.cancelInsertion(ticketId); } catch { /* best effort; browser epoch also expires tickets */ }
    }
    entry.tickets.clear();
    try { entry.unobserve(); } finally { entry.browser.dispose(); }
  }
  async function run(entry, operation, task) {
    current(entry);
    const op = operation || {};
    const timeoutMs = op.timeoutMs === undefined ? LIMITS.rpcTimeoutMs : Math.min(op.timeoutMs, LIMITS.rpcTimeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw createPortError('INVALID_ARGUMENT', 'Invalid deadline');
    if (op.signal && op.signal.aborted) throw cancelled();
    const controller = new AbortController();
    entry.operations.add(controller);
    let timeout = null;
    let failure = null;
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(failure || cancelled());
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    const relay = () => controller.abort();
    if (op.signal) op.signal.addEventListener('abort', relay, { once: true });
    timeout = timers.setTimeout(() => {
      failure = createPortError('TIMEOUT', 'Session operation timed out');
      controller.abort();
    }, timeoutMs);
    const context = { requestId: op.requestId || nextRequestId(), signal: controller.signal, timeoutMs };
    const check = () => { current(entry); if (controller.signal.aborted) throw failure || cancelled(); };
    try {
      const value = await Promise.race([Promise.resolve().then(() => task(context, check)), aborted]);
      check();
      return value;
    } finally {
      timers.clearTimeout(timeout);
      controller.signal.removeEventListener('abort', onAbort);
      if (op.signal) op.signal.removeEventListener('abort', relay);
      entry.operations.delete(controller);
    }
  }
  function registerSurface({ surfaceId, surfaceEpoch, lease, browser } = {}) {
    if (disposed) throw createPortError('NOT_READY', 'Coordinator disposed');
    if (!surfaceId || !Number.isSafeInteger(surfaceEpoch) || surfaceEpoch < 0 || !lease?.api || !browser) {
      throw createPortError('INVALID_ARGUMENT', 'Invalid surface registration');
    }
    const previous = surfaces.get(surfaceId);
    if (previous && surfaceEpoch <= previous.epoch) throw createPortError('CONFLICT', 'Surface epoch is not newer');
    if (previous) releaseEntry(previous);
    const entry = { id: surfaceId, epoch: surfaceEpoch, lease, browser, closed: false, workspace: null,
      bindingGeneration: 0, operations: new Set(), tickets: new Set(), unobserve: () => {},
      target: Object.freeze({ surfaceId, surfaceEpoch, selectionGeneration: 0, state: 'unknown', reason: 'Waiting for browser target' }) };
    surfaces.set(surfaceId, entry);
    try {
      updateTarget(entry, browser.getTarget());
      entry.unobserve = browser.observeTarget((target) => { if (!entry.closed) updateTarget(entry, target); });
    } catch (error) {
      releaseEntry(entry);
      throw error;
    }
    return () => releaseEntry(entry);
  }
  function bindWorkspace(surfaceId, rootPath, op) {
    const entry = entryFor(surfaceId);
    const generation = ++entry.bindingGeneration;
    return run(entry, op, async (context, check) => {
      const workspace = await entry.lease.api.ensureWorkspace(rootPath, context);
      check();
      if (generation !== entry.bindingGeneration) throw stale();
      entry.workspace = Object.freeze({ ...workspace });
      if (workspaceBinding && typeof workspaceBinding.bindKnownWorkspace === 'function') {
        workspaceBinding.bindKnownWorkspace({ surfaceId, workspace: entry.workspace });
      }
      return entry.workspace;
    });
  }
  function navigate(surfaceId, sessionId, op) {
    const entry = entryFor(surfaceId);
    return run(entry, op, async (context, check) => {
      if (!entry.workspace) throw createPortError('NOT_READY', 'Select a workspace before navigating');
      const bindingGeneration = entry.bindingGeneration;
      const sessions = await entry.lease.api.listSessions(entry.workspace.id, context);
      check();
      if (bindingGeneration !== entry.bindingGeneration) throw stale();
      if (!sessions.some((session) => session.id === sessionId && session.workspaceId === entry.workspace.id)) {
        throw createPortError('NOT_FOUND', 'Session does not belong to the bound workspace');
      }
      const target = await entry.browser.navigate(sessionId, context);
      check();
      if (bindingGeneration !== entry.bindingGeneration || !validateVisibleTarget(target)
        || target.state !== 'known' || target.sessionId !== sessionId || target.surfaceId !== surfaceId
        || target.surfaceEpoch !== entry.epoch
        || target.selectionGeneration < entry.target.selectionGeneration) throw stale();
      updateTarget(entry, target);
      return entry.target;
    });
  }
  function insertAttachment(surfaceId, prepare, op) {
    const entry = entryFor(surfaceId);
    let commitSent = false;
    if (typeof prepare !== 'function') return Promise.reject(createPortError('INVALID_ARGUMENT', 'Attachment preparation is required'));
    return run(entry, op, async (context, check) => {
      const expected = entry.target;
      if (expected.state === 'unknown') throw createPortError('CAPABILITY_UNAVAILABLE', expected.reason || 'Current conversation is not known');
      if (expected.state !== 'known') throw createPortError('NOT_READY', 'Select a conversation');
      let ticket;
      let committed = false;
      const cancelTicket = () => {
        if (ticket && !committed) {
          try { entry.browser.cancelInsertion(ticket.ticketId); } catch { /* browser expiry is the final backstop */ }
        }
      };
      try {
        ticket = await entry.browser.captureInsertion(expected, { ...context, requestId: nextRequestId() });
        if (!validateInsertionTicket(ticket) || ticket.surfaceId !== expected.surfaceId
          || ticket.surfaceEpoch !== expected.surfaceEpoch || ticket.selectionGeneration !== expected.selectionGeneration
          || ticket.sessionId !== expected.sessionId) throw stale();
        entry.tickets.add(ticket.ticketId);
        context.signal.addEventListener('abort', cancelTicket, { once: true });
        check();
        const text = await prepare(context.signal);
        check();
        const latest = entry.target;
        if (latest.state !== 'known' || latest.sessionId !== ticket.sessionId
          || latest.selectionGeneration !== ticket.selectionGeneration || clock.now() >= ticket.expiresAt) throw stale();
        if (typeof text !== 'string') throw createPortError('INVALID_ARGUMENT', 'Attachment must produce text');
        commitSent = true;
        const result = await entry.browser.commitInsertion(ticket.ticketId, text, { ...context, requestId: nextRequestId() });
        committed = true;
        return result;
      } finally {
        context.signal.removeEventListener('abort', cancelTicket);
        if (ticket) {
          entry.tickets.delete(ticket.ticketId);
          if (!committed) {
            try { entry.browser.cancelInsertion(ticket.ticketId); } catch { logger({ code: 'TICKET_CLEANUP_FAILED' }); }
          }
        }
      }
    }).catch((error) => {
      if (commitSent && ['TIMEOUT', 'CANCELLED', 'TRANSPORT_LOST'].includes(error.code)) {
        throw createPortError('OUTCOME_UNKNOWN', 'Attachment insertion result is unknown', { effect: 'unknown' });
      }
      throw error;
    });
  }
  async function dispose() {
    if (disposed) return;
    disposed = true;
    for (const entry of Array.from(surfaces.values())) releaseEntry(entry);
  }
  return Object.freeze({ registerSurface, bindWorkspace, getTarget: (id) => entryFor(id).target,
    navigate, insertAttachment, dispose });
}

module.exports = { createSessionCoordinator };
