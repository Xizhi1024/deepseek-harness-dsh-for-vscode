'use strict';

/**
 * Extension-side FIM (fill-in-the-middle) core logic.
 *
 * This module is intentionally pure: it imports neither `vscode` nor any other
 * repository module.  Everything it needs (document, position, cancellation
 * token, fetch, timers) is injected through `createInlineCompletionProvider`.
 */

const DEBOUNCE_MS = 150;
// Total-duration budget for one /api/fim round trip (the DSH side caps its own
// upstream call at 8000 ms). Real LLM FIM completions typically answer in
// 1-3 s, so 800 ms aborted virtually every real upstream response before it
// arrived; 5000 ms covers the observed range while staying under the server
// cap and keeping the UI responsive. There is no separate first-byte tier:
// the whole request (connect + upstream LLM + SSE body) shares this budget.
const REQUEST_TIMEOUT_MS = 5000;
const MAX_PREFIX_LINES = 64;
const MAX_SUFFIX_LINES = 32;
const MAX_CONTEXT_BYTES = 128 * 1024;

// F-e: session-sticky flag — the 503 "upstream not configured" guidance is
// surfaced to the user at most once per extension-host session, no matter how
// many providers or requests hit the unconfigured route.
let fimUnavailableNotified = false;

/** Test seam: reset the once-per-session 503 notification flag. */
function resetFimUnavailableNotification() {
  fimUnavailableNotified = false;
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

/** Keep the first `maxBytes` bytes of `value` without splitting a UTF-8 char. */
function truncateUtf8Head(value, maxBytes) {
  if (maxBytes <= 0) return '';
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

/** Keep the last `maxBytes` bytes of `value` without splitting a UTF-8 char. */
function truncateUtf8Tail(value, maxBytes) {
  if (maxBytes <= 0) return '';
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= maxBytes) return value;
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString('utf8');
}

/**
 * Build the FIM context window from a full-document string.
 *
 * @param {string} fullText document.getText() result
 * @param {{line: number, character: number}} position
 * @returns {{prefix: string, suffix: string}}
 */
function buildContextWindow(fullText, position) {
  const lines = fullText.split('\n');
  const cursorLine = position.line;
  const cursorChar = position.character;
  const currentLine = lines[cursorLine] || '';

  const currentPrefix = currentLine.slice(0, cursorChar);
  const currentSuffix = currentLine.slice(cursorChar);

  const prefixStart = Math.max(0, cursorLine - MAX_PREFIX_LINES);
  const beforeLines = lines.slice(prefixStart, cursorLine);

  const suffixEnd = Math.min(lines.length, cursorLine + 1 + MAX_SUFFIX_LINES);
  const afterLines = lines.slice(cursorLine + 1, suffixEnd);

  let prefix = beforeLines.length > 0
    ? beforeLines.join('\n') + '\n' + currentPrefix
    : currentPrefix;
  let suffix = afterLines.length > 0
    ? currentSuffix + '\n' + afterLines.join('\n')
    : currentSuffix;

  const remainingPrefixLines = beforeLines.slice();
  const remainingSuffixLines = afterLines.slice();

  // 128 KiB window.  Truncate prefix top (oldest lines) first, then suffix
  // bottom (newest lines), as required by the contract.
  let total = byteLength(prefix) + byteLength(suffix);
  while (total > MAX_CONTEXT_BYTES && remainingPrefixLines.length > 0) {
    remainingPrefixLines.shift();
    prefix = remainingPrefixLines.length > 0
      ? remainingPrefixLines.join('\n') + '\n' + currentPrefix
      : currentPrefix;
    total = byteLength(prefix) + byteLength(suffix);
  }

  while (total > MAX_CONTEXT_BYTES && remainingSuffixLines.length > 0) {
    remainingSuffixLines.pop();
    suffix = remainingSuffixLines.length > 0
      ? currentSuffix + '\n' + remainingSuffixLines.join('\n')
      : currentSuffix;
    total = byteLength(prefix) + byteLength(suffix);
  }

  // Degenerate case (e.g. a single line longer than the whole window): after
  // both line-based truncations the window may still be over budget.  Keep the
  // newest prefix bytes and the oldest suffix bytes, honouring the same
  // direction as the line-based rules above.
  if (total > MAX_CONTEXT_BYTES) {
    if (byteLength(suffix) > MAX_CONTEXT_BYTES) {
      suffix = truncateUtf8Head(suffix, MAX_CONTEXT_BYTES);
      prefix = '';
    } else {
      prefix = truncateUtf8Tail(prefix, MAX_CONTEXT_BYTES - byteLength(suffix));
    }
  }

  return { prefix, suffix };
}

/**
 * Parse a complete SSE body string.
 *
 * @param {string} raw full response text
 * @param {(...args: unknown[]) => void} log
 * @returns {{error: boolean, text: string}}
 */
function parseSSEText(raw, log) {
  let text = '';
  const lines = raw.split(/\r?\n/);

  for (const line of lines) {
    if (line.startsWith('event:')) {
      const eventName = line.slice('event:'.length).trim();
      if (eventName === 'error') {
        log('[inlineCompletion] SSE event:error frame', line);
        return { error: true, text };
      }
      continue;
    }

    if (!line.startsWith('data:')) {
      continue;
    }

    // SSE allows exactly one optional space after the colon.
    const payload = line.slice('data:'.length).replace(/^ /, '');

    if (payload.trim() === '[DONE]') {
      return { error: false, text };
    }

    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch (error) {
      log('[inlineCompletion] malformed SSE data line', line, error);
      return { error: true, text };
    }

    if (!parsed || typeof parsed.text !== 'string') {
      log('[inlineCompletion] SSE data line without string text field', line);
      return { error: true, text };
    }

    text += parsed.text;
  }

  return { error: false, text };
}

/**
 * Create the extension-side inline completion provider.
 *
 * @param {{
 *   getServerUrl: () => string|null,
 *   tokenProvider: () => string|null,
 *   getModel: () => string,
 *   fetchImpl: (url: string, init: object) => Promise<object>,
 *   log?: (...args: unknown[]) => void,
 *   setTimeout?: (fn: () => void, ms: number) => unknown,
 *   clearTimeout?: (id: unknown) => void,
 *   onFimUnavailable?: (guidance: string) => void - called at most once per
 *     session with the guidance text extracted from a 503 /api/fim response,
 *     so the host can surface it (warning message + diagnostics).
 * }} deps
 * @returns {{provider: {provideInlineCompletionItems: Function}, dispose: () => void}}
 */
function createInlineCompletionProvider(deps) {
  const getServerUrl = deps.getServerUrl;
  const tokenProvider = deps.tokenProvider;
  const getModel = deps.getModel;
  const fetchImpl = deps.fetchImpl;
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const onFimUnavailable = typeof deps.onFimUnavailable === 'function' ? deps.onFimUnavailable : null;
  const setTimeoutImpl = deps.setTimeout || globalThis.setTimeout;
  const clearTimeoutImpl = deps.clearTimeout || globalThis.clearTimeout;

  // F-e: surface the 503 "upstream not configured" guidance exactly once per
  // extension-host session (module-level flag shared by every provider).
  function notifyFimUnavailable(guidance) {
    if (fimUnavailableNotified) return;
    fimUnavailableNotified = true;
    if (!onFimUnavailable) return;
    try {
      onFimUnavailable(guidance);
    } catch (error) {
      log('[inlineCompletion] onFimUnavailable callback failed', error);
    }
  }

  let disposed = false;
  let debounceTimer = null;
  let debounceWaiters = [];
  let inflight = false;
  let inflightController = null;

  function clearPendingDebounce() {
    if (debounceTimer !== null) {
      clearTimeoutImpl(debounceTimer);
      debounceTimer = null;
    }
    const waiters = debounceWaiters;
    debounceWaiters = [];
    for (const resolve of waiters) resolve([]);
  }

  async function performRequest(document, position, token) {
    // Re-read the deps at request time so a provider disposed or a token that
    // disappeared during the debounce window cannot produce a request.
    if (disposed) return [];

    const serverUrl = getServerUrl();
    const bridgeToken = tokenProvider();
    const model = getModel();
    if (!serverUrl || !bridgeToken || !model) return [];

    let context;
    try {
      context = buildContextWindow(document.getText(), position);
    } catch (error) {
      log('[inlineCompletion] failed to build context window', error);
      return [];
    }

    inflight = true;
    const controller = new AbortController();
    inflightController = controller;

    const timeoutTimer = setTimeoutImpl(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let cancelDisposable = null;
    if (token && typeof token.onCancellationRequested === 'function') {
      try {
        cancelDisposable = token.onCancellationRequested(() => controller.abort());
      } catch (error) {
        log('[inlineCompletion] failed to attach cancellation listener', error);
      }
    }

    try {
      const response = await fetchImpl(`${serverUrl}/api/fim`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bridgeToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, prefix: context.prefix, suffix: context.suffix }),
        signal: controller.signal,
      });

      const ok = typeof response.ok === 'boolean'
        ? response.ok
        : !response.status || (response.status >= 200 && response.status < 300);
      if (!ok) {
        log('[inlineCompletion] FIM request failed with status', response.status);
        if (response.status === 503) {
          // F-e: the 503 body carries the server-side guidance (JSON with a
          // message field); extract it so the host can show the user why tab
          // completion is dead instead of silently returning nothing.
          let guidance = '';
          try {
            const raw503 = typeof response.text === 'function' ? await response.text() : '';
            try {
              const parsed503 = JSON.parse(raw503);
              guidance = parsed503 && typeof parsed503.message === 'string' ? parsed503.message : raw503;
            } catch {
              guidance = raw503;
            }
          } catch (error) {
            log('[inlineCompletion] failed to read 503 guidance body', error);
          }
          notifyFimUnavailable(guidance);
        }
        return [];
      }

      let raw;
      if (typeof response.text === 'function') {
        raw = await response.text();
      } else {
        log('[inlineCompletion] FIM response has no text() reader');
        return [];
      }

      const parsed = parseSSEText(raw, log);
      if (parsed.error) return [];
      if (parsed.text.length === 0) return [];

      return [{
        insertText: parsed.text,
        range: {
          start: { line: position.line, character: 0 },
          end: { line: position.line, character: position.character },
        },
      }];
    } catch (error) {
      // fail-quiet: completion is an enhancement, never throw.
      log('[inlineCompletion] FIM request failed', error);
      return [];
    } finally {
      clearTimeoutImpl(timeoutTimer);
      if (cancelDisposable && typeof cancelDisposable.dispose === 'function') {
        try {
          cancelDisposable.dispose();
        } catch (error) {
          log('[inlineCompletion] failed to dispose cancellation listener', error);
        }
      }
      inflight = false;
      if (inflightController === controller) {
        inflightController = null;
      }
    }
  }

  function provideInlineCompletionItems(document, position, _context, token) {
    if (disposed) return [];
    if (!document || !position) return [];

    const serverUrl = getServerUrl();
    if (!serverUrl) return [];

    const bridgeToken = tokenProvider();
    if (!bridgeToken) return [];

    const model = getModel();
    if (!model) return [];

    // The newest call always wins the debounce window, including calls that
    // end in the line-start no-op exit below: a stale pending request for a
    // cursor that has since moved to a short line must not fire.
    clearPendingDebounce();

    let fullText;
    try {
      fullText = document.getText();
    } catch (error) {
      log('[inlineCompletion] document.getText failed', error);
      return [];
    }

    const lines = fullText.split('\n');
    const currentLine = lines[position.line] || '';
    const textBeforeCursor = currentLine.slice(0, position.character);
    if (textBeforeCursor.length < 2) return [];

    if (inflight) return [];

    return new Promise((resolve) => {
      debounceWaiters.push(resolve);
      debounceTimer = setTimeoutImpl(() => {
        debounceTimer = null;
        const waiters = debounceWaiters;
        debounceWaiters = [];

        if (disposed || inflight) {
          for (const waiter of waiters) waiter([]);
          return;
        }

        performRequest(document, position, token).then(
          (items) => {
            for (const waiter of waiters) waiter(items);
          },
          (error) => {
            log('[inlineCompletion] provider call failed', error);
            for (const waiter of waiters) waiter([]);
          },
        );
      }, DEBOUNCE_MS);
    });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearPendingDebounce();
    if (inflightController) {
      try {
        inflightController.abort();
      } catch (error) {
        log('[inlineCompletion] failed to abort in-flight request on dispose', error);
      }
    }
  }

  return Object.freeze({
    provider: Object.freeze({ provideInlineCompletionItems }),
    dispose,
  });
}

module.exports = { createInlineCompletionProvider, resetFimUnavailableNotification };
