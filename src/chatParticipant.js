'use strict';

/**
 * Chat participant core module for the DSH VS Code extension.
 *
 * This module owns the pure `@dsh` chat handler and followup provider logic
 * only. Registration and assembly (package.json contributes.chatParticipants,
 * wiring `ensureWorkspaceSession`, feature gate, session list) stay in the asm
 * layer; everything here runs against injected deps so node:test can drive the
 * full handler path with fake response streams and fake tokens.
 *
 * The D9 boundary is deliberate: `request.model` is never read. The DSH
 * participant consumes the text prompt and streams DSH-owned session output,
 * never the vscode.lm provider.
 */

const { deriveSessionTitle } = require("./sessionTitler");

/**
 * Maximum segment length passed to a single `response.markdown` call. The SSE
 * frame cap (1 MiB) lets the DSH stream produce very long text deltas, so a
 * delta is re-sliced into at most this many characters per markdown call to
 * keep the chat UI responsive.
 * @type {number}
 */
const MARKDOWN_CHUNK_MAX = 8000;

/**
 * Minimal l10n fallback for tests and non-localized hosts (same shape as
 * src/commands/addFileToThread.js defaultLoc).
 *
 * @param {string} template - Template with `{name}` placeholders.
 * @param {object} [params] - Placeholder values.
 * @returns {string} Rendered template.
 */
function defaultLoc(template, params = {}) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? `{${key}}`));
}

/**
 * Extract a human-readable error message without throwing on non-Error values.
 *
 * @param {*} err - Rejection value.
 * @returns {string} Error message.
 */
function errorMessage(err) {
  return err && err.message ? err.message : String(err);
}

/**
 * True for followup-eligible root session items. Subagent-origin and
 * child sessions are skipped; mirrors `rootSessionItems` filtering without
 * importing sessionNavigation (this core module stays zero real IO).
 *
 * @param {*} item - Candidate session item.
 * @returns {boolean} True when the item is a root session.
 */
function isRootSessionItem(item) {
  return Boolean(item)
    && typeof item === 'object'
    && !Array.isArray(item)
    && item.origin !== 'subagent'
    && !item.parentSessionId;
}

/**
 * Create the frozen DSH chat participant core module.
 *
 * @param {object} deps - Injected dependencies.
 * @param {object} deps.chatClient - DSH chat client with `prompt` and
 *   `streamSession` (real implementation: src/dshChatClient.js).
 * @param {Function} deps.resolveSessionId - Resolves the current workspace
 *   session id (asm: ensureWorkspaceSession).
 * @param {Function} deps.isEnabled - Feature gate for
 *   `dsh.features.chat-participant` (asm: registry).
 * @param {Function} deps.listSessionsFn - Session list function accepting
 *   `{ signal }`; result sorted by `updatedAt` descending (asm:
 *   sessionNavigation.listSessions).
 * @param {Function} [deps.titleSession] - Optional one-shot rename hook
 *   (asm: the shared sessionTitler bound to sessionNavigation.renameSession)
 *   called once per session id with a title derived from the first prompt
 *   (B2 bare-UUID-title guard). Failures are swallowed and never affect
 *   the chat response.
 * @param {Function} [deps.loc] - Localization helper.
 * @returns {{handleRequest: Function, provideFollowups: Function}} Frozen
 *   participant module.
 */
function createChatParticipantModule({
  chatClient,
  resolveSessionId,
  isEnabled,
  listSessionsFn,
  titleSession,
  loc = defaultLoc,
}) {
  if (!chatClient || typeof chatClient.prompt !== 'function' || typeof chatClient.streamSession !== 'function') {
    throw new TypeError('chatClient.prompt and chatClient.streamSession are required');
  }
  if (typeof resolveSessionId !== 'function') {
    throw new TypeError('resolveSessionId must be a function');
  }
  if (typeof isEnabled !== 'function') {
    throw new TypeError('isEnabled must be a function');
  }
  if (typeof listSessionsFn !== 'function') {
    throw new TypeError('listSessionsFn must be a function');
  }
  if (typeof titleSession !== 'undefined' && typeof titleSession !== 'function') {
    throw new TypeError('titleSession must be a function when provided');
  }

  /** Session ids already handed to titleSession (one attempt each). */
  const titledSessions = new Set();
  if (typeof loc !== 'function') {
    throw new TypeError('loc must be a function');
  }

  /**
   * Stream one text delta to `response.markdown`, re-slicing deltas longer
   * than MARKDOWN_CHUNK_MAX into bounded segments.
   *
   * @param {object} response - VS Code ChatResponse-like stream.
   * @param {string} text - Text delta from `streamSession.onText`.
   * @returns {void}
   */
  function markdownChunks(response, text) {
    if (typeof text !== 'string' || text.length === 0) return;
    for (let offset = 0; offset < text.length; offset += MARKDOWN_CHUNK_MAX) {
      response.markdown(text.slice(offset, offset + MARKDOWN_CHUNK_MAX));
    }
  }

  /**
   * `@dsh` chat participant handler.
   *
   * Flow: feature gate → cancellation gate → resolve current DSH session →
   * connect the live SSE stream FIRST (the DSH event bus has no replay: any
   * `session/event` emitted before the mux connection subscribes is lost
   * forever, so the prompt must not be queued before the stream is ready) →
   * await stream readiness → queue the prompt → forward text deltas to
   * `response.markdown` as they arrive. Errors are shown in the chat response
   * (error-direct principle), never thrown to VS Code.
   *
   * @param {object} request - VS Code ChatRequest-like request.
   * @param {object} context - VS Code ChatContext-like context (not consumed).
   * @param {object} response - VS Code ChatResponse-like response stream.
   * @param {object} token - VS Code CancellationToken-like token.
   * @returns {Promise<void>} Always resolves (errors are surfaced via markdown).
   */
  async function handleRequest(request, context, response, token) {
    if (!isEnabled()) {
      response.markdown(loc('DSH chat participant is disabled (dsh.features.chat-participant).'));
      return;
    }
    if (token && token.isCancellationRequested) return;

    const controller = new AbortController();
    let disposed = false;
    let disposeListener = null;
    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      if (disposeListener) {
        try {
          disposeListener();
        } catch (_) {
          /* ignore dispose failures */
        }
        disposeListener = null;
      }
    };

    if (token && typeof token.onCancellationRequested === 'function') {
      disposeListener = token.onCancellationRequested(() => controller.abort());
      if (token.isCancellationRequested) {
        cleanup();
        return;
      }
    }

    let sessionId;
    try {
      sessionId = await resolveSessionId();
    } catch (err) {
      response.markdown(loc('DSH unavailable: {message}', { message: errorMessage(err) }));
      cleanup();
      return;
    }

    let streamBroken = false;
    let sawText = false;
    let streamTerminalReason = null;
    let streamError = null;
    let settleReady = null;
    const ready = new Promise((resolve) => {
      settleReady = resolve;
    });

    const onText = (text) => {
      if (streamBroken) return;
      try {
        if (typeof text === 'string' && text.length > 0) sawText = true;
        markdownChunks(response, text);
      } catch (_) {
        streamBroken = true;
        try {
          controller.abort();
        } catch (_) {
          /* ignore double-abort */
        }
      }
    };
    const onReady = () => {
      settleReady();
    };
    const onDone = (result) => {
      streamTerminalReason = result && typeof result.reason === 'string'
        ? result.reason
        : 'stream-end';
      settleReady();
      cleanup();
    };

    // Connect the live stream first. The promise never rejects here (the
    // wrapper catches and records the error) so the readiness gate below is
    // the single ordering point.
    const streamPromise = (async () => {
      try {
        return await chatClient.streamSession({
          sessionId,
          onText,
          onDone,
          onReady,
          signal: controller.signal,
        });
      } catch (err) {
        streamError = err;
        settleReady();
        return null;
      }
    })();

    await ready;

    if (streamError) {
      try {
        response.markdown(loc('DSH unavailable: {message}', { message: errorMessage(streamError) }));
      } catch (_) {
        /* response stream itself failed */
      }
      cleanup();
      return;
    }
    if (streamTerminalReason !== null && !sawText) {
      // The stream ended before the prompt was queued and nothing was
      // delivered: user abort ends silently, anything else means no delta
      // could ever be delivered.
      if (streamTerminalReason !== 'aborted') {
        try {
          response.markdown(loc('DSH unavailable: live stream ended before the prompt was sent ({reason})', { reason: streamTerminalReason }));
        } catch (_) {
          /* response stream itself failed */
        }
      }
      cleanup();
      return;
    }

    try {
      await chatClient.prompt({
        sessionId,
        content: request.prompt,
        mode: 'queue',
        signal: controller.signal,
      });
    } catch (err) {
      try {
        response.markdown(loc('DSH unavailable: {message}', { message: errorMessage(err) }));
      } catch (_) {
        /* response stream itself failed */
      }
      try {
        controller.abort();
      } catch (_) {
        /* ignore double-abort */
      }
      await streamPromise;
      cleanup();
      return;
    }

    // B2: sessions reached through the API keep bare-UUID titles; give the
    // session a readable title derived from this first prompt. One attempt
    // per session per module lifetime; failures never affect the response.
    let titlePromise = null;
    if (typeof titleSession === 'function' && !titledSessions.has(sessionId)) {
      const title = deriveSessionTitle(request.prompt);
      if (title.length > 0) {
        titledSessions.add(sessionId);
        titlePromise = Promise.resolve()
          .then(() => titleSession(sessionId, title))
          .catch(() => {});
      }
    }

    const streamResult = await streamPromise;
    if (
      !streamBroken
      && !sawText
      && streamResult !== null
      && streamTerminalReason !== null
      && streamTerminalReason !== 'stream-end'
      && streamTerminalReason !== 'aborted'
    ) {
      // The stream failed without delivering any visible delta: surface the
      // reason instead of leaving a silent, empty chat response.
      try {
        response.markdown(loc('DSH unavailable: {message}', { message: streamTerminalReason }));
      } catch (_) {
        /* response stream itself failed */
      }
    }
    if (titlePromise) await titlePromise;
    cleanup();
  }

  /**
   * Followup provider for the DSH participant: offer the 5 most recent root
   * sessions as one-click continuation prompts. Pure enhancement — feature
   * gate off or listing failure silently degrades to `[]`.
   *
   * @param {object} _result - VS Code ChatResult (not consumed).
   * @param {object} _context - VS Code ChatContext (not consumed).
   * @param {object} _token - VS Code CancellationToken (not consumed).
   * @returns {Promise<Array<object>>} Up to 5 followup items.
   */
  async function provideFollowups(_result, _context, _token) {
    if (!isEnabled()) return [];
    let items;
    try {
      items = await listSessionsFn({});
    } catch (_) {
      return [];
    }
    if (!Array.isArray(items)) return [];

    const followups = [];
    for (const item of items) {
      if (followups.length >= 5) break;
      if (!isRootSessionItem(item)) continue;
      const sessionId = typeof item.sessionId === 'string' && item.sessionId.length > 0
        ? item.sessionId
        : '';
      if (sessionId === '') continue;
      const title = typeof item.title === 'string' && item.title.length > 0
        ? item.title
        : '';
      followups.push({
        label: title || sessionId,
        prompt: title || sessionId.slice(0, 24),
        participant: 'dsh',
      });
    }
    return followups;
  }

  return Object.freeze({ handleRequest, provideFollowups });
}

module.exports = { createChatParticipantModule };
