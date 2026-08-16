'use strict';

/**
 * CH1 notification coalescer (SM-6).
 *
 * The notifier buffers metadata-only notifications and releases them at most
 * once per `windowMs` or when `maxPending` distinct method+uri buckets are
 * waiting. A later push for the same method+uri replaces the earlier pending
 * params, so rapid editor/diagnostic changes collapse into one wire
 * notification.
 */

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function pendingKey(method, params) {
  const uri = isRecord(params) && typeof params.uri === 'string' ? params.uri : '';
  return `${method}\n${uri}`;
}

/**
 * @param {object} [options] - Notifier options.
 * @param {(method: string, params: object) => void} [options.send] - Sink for flushed notifications.
 * @param {number} [options.windowMs=150] - Coalescing window in milliseconds.
 * @param {number} [options.maxPending=64] - Max distinct pending buckets before an immediate flush.
 * @returns {object} Notifier API.
 */
function createNotifier({
  send,
  windowMs = 150,
  maxPending = 64,
} = {}) {
  if (typeof send !== 'function') {
    throw new TypeError('createNotifier requires a send function');
  }
  if (!Number.isFinite(windowMs) || windowMs < 0) {
    throw new TypeError('createNotifier windowMs must be a non-negative number');
  }
  if (!Number.isInteger(maxPending) || maxPending < 1) {
    throw new TypeError('createNotifier maxPending must be a positive integer');
  }

  /** @type {Map<string, {method: string, params: object}>} */
  const pending = new Map();
  let timer = null;
  let disposed = false;
  let flushing = false;
  const stats = {
    sent: 0,
    sendFailures: 0,
    flushCount: 0,
    dropped: 0,
  };

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function scheduleFlush() {
    if (timer !== null || disposed) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, windowMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function flush() {
    if (disposed || flushing || pending.size === 0) return;
    flushing = true;
    clearTimer();
    const items = [...pending.values()];
    pending.clear();
    stats.flushCount += 1;
    try {
      for (const item of items) {
        try {
          const result = send(item.method, item.params);
          if (result && typeof result.then === 'function') {
            result.then(() => {
              stats.sent += 1;
            }).catch(() => {
              stats.sendFailures += 1;
            });
          } else {
            stats.sent += 1;
          }
        } catch (_) {
          stats.sendFailures += 1;
        }
      }
    } finally {
      flushing = false;
    }
  }

  function push(method, params) {
    if (disposed) return;
    if (typeof method !== 'string' || method.length === 0) {
      throw new TypeError('notifier push method must be a non-empty string');
    }
    if (!isRecord(params)) {
      throw new TypeError('notifier push params must be an object');
    }
    const key = pendingKey(method, params);
    pending.set(key, { method, params });
    if (pending.size >= maxPending) {
      flush();
    } else {
      scheduleFlush();
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearTimer();
    stats.dropped += pending.size;
    pending.clear();
  }

  return Object.freeze({
    push,
    flush,
    dispose,
    get pendingCount() {
      return pending.size;
    },
    get stats() {
      return { ...stats };
    },
  });
}

module.exports = {
  createNotifier,
};
