'use strict';

/** Bound automatic retries after failure; explicit user retries bypass cooldown. */
class StartupGate {
  constructor({ now = Date.now, cooldownMs = 30000 } = {}) {
    this.now = now;
    this.cooldownMs = cooldownMs;
    this.retryAt = 0;
  }

  recordFailure() {
    this.retryAt = this.now() + this.cooldownMs;
  }

  async run(operation, { force = false } = {}) {
    if (!force && this.now() < this.retryAt) return false;
    try {
      const result = await operation();
      this.retryAt = result === false ? this.now() + this.cooldownMs : 0;
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }
}

module.exports = { StartupGate };
