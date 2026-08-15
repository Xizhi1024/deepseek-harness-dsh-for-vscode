'use strict';

/** Serialize extension lifecycle work and stop accepting work during shutdown. */
class LifecycleQueue {
  /** @param {{onError?: (label: string, error: unknown) => void}} [options] */
  constructor({ onError = (label, error) => console.error(`dsh-vs-sidebar: ${label} failed:`, error) } = {}) {
    this._accepting = true;
    this._chain = Promise.resolve();
    this._onError = onError;
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
