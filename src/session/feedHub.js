"use strict";

const { createPortError, validateSessionUpdate, LIMITS } = require('../protocol/runtime');
const { createTranscriptState, reduceSessionUpdate } = require('./transcript');

const RETRIES = LIMITS.reconnectDelaysMs;

function createSessionFeedHub({ openFeed, createRequestId, clock = { now: Date.now },
  timers = { setTimeout, clearTimeout }, limits = {}, logger = () => {} }) {
  const entries = new Map();
  let disposed = false;
  const maxKeys = limits.maxKeys || LIMITS.maxFeeds;
  const maxBytes = limits.maxBytes || LIMITS.projectionBytes;

  function stop(entry) {
    entry.closed = true;
    entry.controller?.abort();
    if (entry.timer !== null) timers.clearTimeout(entry.timer);
    entry.timer = null;
    const closing = entry.feed?.close();
    if (closing) Promise.resolve(closing).catch(() => {});
    if (entries.get(entry.id) === entry) entries.delete(entry.id);
  }
  function call(entry, consumer, method, value) {
    if (!entry.consumers.has(consumer)) return;
    try { consumer[method](value); }
    catch {
      entry.consumers.delete(consumer);
      try { logger({ event: 'feed-consumer-failed' }); } catch { /* isolated logger */ }
      if (!entry.consumers.size) stop(entry);
    }
  }
  function baseline(entry) {
    return Object.freeze({ runtimeInstanceId: entry.key.instanceId, sessionId: entry.key.sessionId,
      streamEpoch: entry.epoch, throughDeliverySeq: entry.seq, state: entry.state });
  }
  function broadcast(entry, method, value) {
    for (const consumer of [...entry.consumers]) call(entry, consumer, method, value);
  }
  async function run(entry) {
    if (entry.closed || disposed) return;
    const controller = new AbortController();
    entry.controller = controller;
    entry.ready = false;
    let feed;
    try {
      feed = await openFeed(entry.key, { requestId: createRequestId(), signal: controller.signal });
      if (entry.closed || disposed) return;
      entry.feed = feed;
      for await (const update of feed.events) {
        if (entry.closed || disposed) break;
        if (!validateSessionUpdate(update) || update.runtimeInstanceId !== entry.key.instanceId || update.sessionId !== entry.key.sessionId) {
          throw createPortError('PROTOCOL_MISMATCH', 'Invalid feed identity or payload');
        }
        if (!entry.ready) {
          if (update.kind !== 'snapshot' || update.deliverySeq !== 1) throw createPortError('RESYNC_REQUIRED', 'Missing opening snapshot', { retryable: true });
          entry.epoch = update.streamEpoch;
          entry.seq = 0;
          entry.state = createTranscriptState();
        } else if (update.streamEpoch !== entry.epoch || update.deliverySeq !== entry.seq + 1) {
          throw createPortError('RESYNC_REQUIRED', 'Feed sequence gap', { retryable: true });
        }
        const state = reduceSessionUpdate(entry.state, update);
        if (Buffer.byteLength(JSON.stringify(state)) > maxBytes) throw createPortError('BACKPRESSURE', 'Session projection exceeds its memory budget');
        entry.state = state;
        entry.seq = update.deliverySeq;
        if (!entry.ready) {
          entry.ready = true;
          entry.stableSince = clock.now();
          broadcast(entry, 'onBaseline', baseline(entry));
        } else {
          if (clock.now() - entry.stableSince >= LIMITS.reconnectResetMs) entry.failures = 0;
          broadcast(entry, 'onUpdate', Object.freeze(update));
        }
      }
      if (!entry.closed) throw createPortError('TRANSPORT_LOST', 'Session stream closed', { retryable: true });
    } catch (error) {
      if (entry.closed || disposed) return;
      if (entry.ready && clock.now() - entry.stableSince >= LIMITS.reconnectResetMs) entry.failures = 0;
      entry.ready = false;
      const retryable = ['TRANSPORT_LOST', 'TIMEOUT', 'RESYNC_REQUIRED'].includes(error.code);
      if (!retryable || entry.failures >= RETRIES.length) {
        broadcast(entry, 'onError', error.code ? error : createPortError('INTERNAL', 'Session subscription failed'));
        stop(entry);
        return;
      }
      const delay = RETRIES[entry.failures++];
      entry.timer = timers.setTimeout(() => { entry.timer = null; entry.task = run(entry); }, delay);
    } finally {
      controller.abort();
      try { await feed?.close(); } catch { /* no ownership beyond this feed */ }
      if (entry.feed === feed) entry.feed = null;
    }
  }
  function subscribe(key, consumer) {
    if (disposed) throw createPortError('NOT_READY', 'Session feed hub is disposed');
    if (!key || !key.instanceId || !key.sessionId || !['onBaseline', 'onUpdate', 'onError'].every((name) => typeof consumer?.[name] === 'function')) {
      throw createPortError('INVALID_ARGUMENT', 'Feed identity and callbacks are required');
    }
    const id = JSON.stringify([key.instanceId, key.sessionId, 1]);
    // Each handle owns a distinct registration even when callbacks are reused.
    consumer = { ...consumer };
    let entry = entries.get(id);
    if (!entry) {
      if (entries.size >= maxKeys) throw createPortError('BACKPRESSURE', 'Too many active sessions');
      entry = { id, key: Object.freeze({ ...key }), consumers: new Set(), state: createTranscriptState(),
        ready: false, closed: false, timer: null, failures: 0, feed: null, controller: null, task: null };
      entries.set(id, entry);
    }
    // Synchronous registration and current-state delivery form one atomic JS turn.
    entry.consumers.add(consumer);
    if (entry.ready) call(entry, consumer, 'onBaseline', baseline(entry));
    if (!entry.task && !entry.closed) entry.task = run(entry);
    let released = false;
    return Object.freeze({ release() {
      if (released) return;
      released = true;
      entry.consumers.delete(consumer);
      if (!entry.consumers.size) stop(entry);
    } });
  }
  return Object.freeze({ subscribe, async dispose() {
    if (disposed) return;
    disposed = true;
    const active = [...entries.values()];
    for (const entry of active) stop(entry);
    await Promise.allSettled(active.map((entry) => entry.task));
  }, get activeFeeds() { return entries.size; } });
}

module.exports = { createSessionFeedHub };
