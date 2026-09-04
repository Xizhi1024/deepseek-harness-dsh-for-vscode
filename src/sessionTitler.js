'use strict';

/**
 * B2 session titler: pure title derivation plus a memoized one-shot rename
 * guard shared by the chat participant and the exports face, so at most
 * one session.rename is issued per session id per extension lifetime
 * regardless of how many prompts flow through whichever face. Failures
 * are swallowed (the title is cosmetic) and never retried per session.
 */

/** Derived-title cap in Unicode code points (the host enforces its own UTF-8 byte budget on top). @type {number} */
const DERIVED_TITLE_MAX_CODE_POINTS = 60;

/**
 * Derive a readable session title from a prompt's first line.
 *
 * Mirrors the host-side normalization intent (dsh-session-title
 * cleanTitleText: control characters stripped, whitespace collapsed,
 * trimmed) so the raw value we send always normalizes to itself. The
 * slice is code-point safe (never splits a surrogate pair). Returns an
 * empty string when nothing derivable remains - callers must skip the
 * rename then.
 *
 * @param {string} prompt - Raw prompt text.
 * @returns {string} Derived title ("" when not derivable).
 */
function deriveSessionTitle(prompt) {
  if (typeof prompt !== "string") return "";
  const firstLine = prompt.split("\n")[0] || "";
  const collapsed = firstLine
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (collapsed.length === 0) return "";
  const codePoints = Array.from(collapsed);
  if (codePoints.length <= DERIVED_TITLE_MAX_CODE_POINTS) return collapsed;
  return codePoints.slice(0, DERIVED_TITLE_MAX_CODE_POINTS).join("").trimEnd();
}

/**
 * Create a guarded titler.
 *
 * @param {Function} renameFn - Underlying rename, e.g.
 *   (sessionId, title) => renameSession(currentServer.url, { sessionId, title }).
 * @returns {Function} async (sessionId, title) => Promise<boolean> - true
 *   when a rename was issued and accepted; never throws.
 */
function createSessionTitler(renameFn) {
  if (typeof renameFn !== 'function') {
    throw new TypeError('renameFn must be a function');
  }
  const attempted = new Set();
  return async function titleSession(sessionId, title) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return false;
    if (typeof title !== 'string' || title.length === 0) return false;
    if (attempted.has(sessionId)) return false;
    attempted.add(sessionId);
    try {
      await renameFn(sessionId, title);
      return true;
    } catch (_) {
      return false;
    }
  };
}

module.exports = { createSessionTitler, deriveSessionTitle };
