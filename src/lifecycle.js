'use strict';

/** Serialize extension lifecycle work and stop accepting work during shutdown. */
class LifecycleQueue {
  /** @param {{onError?: (label: string, error: unknown) => void}} [options] */
  constructor({ onError = (label, error) => console.error(`dsh-vs-sidebar: ${label} failed:`, error) } = {}) {
    this._accepting = true;
    this._chain = Promise.resolve();
    this._onError = onError;
    this._pending = new Map();
    this._latest = new Map();
  }

  /** @returns {boolean} true after shutdown begins. */
  get stopped() {
    return !this._accepting;
  }

  /**
   * Append one operation while keeping later work usable after a rejection.
   * @param {string} label
   * @param {() => Promise<unknown>|unknown} operation
   * @returns {Promise<unknown>}
   */
  enqueue(label, operation) {
    if (!this._accepting) return Promise.resolve(undefined);
    const next = this._chain.then(async () => {
      if (!this._accepting) return undefined;
      return operation();
    });
    this._chain = next.catch((error) => this._onError(label, error));
    return next;
  }

  /** Share queued/running duplicate work without changing ordinary queue semantics. */
  enqueueOnce(key, operation) {
    if (this._pending.has(key)) return this._pending.get(key);
    const pending = this.enqueue(key, operation).finally(() => this._pending.delete(key));
    this._pending.set(key, pending);
    return pending;
  }

  /** Coalesce event bursts, keeping at most one queued successor to running work. */
  enqueueLatest(key, operation) {
    if (!this._accepting) return Promise.resolve(undefined);
    const queued = this._latest.get(key);
    if (queued) {
      queued.operation = operation;
      return queued.promise;
    }
    const job = { operation, promise: null };
    job.promise = this.enqueue(key, () => {
      this._latest.delete(key);
      return job.operation();
    }).finally(() => {
      if (this._latest.get(key) === job) this._latest.delete(key);
    });
    this._latest.set(key, job);
    return job.promise;
  }

  /** Prevent queued-but-not-started and future operations from running. */
  stopAccepting() {
    this._accepting = false;
  }

  /** Wait until the currently running operation and queue settle. */
  async wait() {
    await this._chain.catch(() => {});
  }
}

module.exports = { LifecycleQueue };
