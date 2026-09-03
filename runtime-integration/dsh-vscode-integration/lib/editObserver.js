// ---------------------------------------------------------------------------
// C2 (1.1.0): DSH tool-layer edit/write observation.
//
// Observes the dsh-tools 'tools/pre-execute' waterfall for the 'edit' and
// 'write' DSH tools and reports metadata-only notifications
// ('vscode/dshEditObserved') to the VS Code extension so it can attribute the
// write in the changes tree. This is observe-ONLY:
//  - the handler ALWAYS delegates through next(): a cordis waterfall listener
//    that returns without calling next() short-circuits the chain with its
//    return value, and dsh-tools then reads gate.kind of undefined — the
//    "Cannot read properties of undefined (reading 'kind')" incident that
//    killed EVERY tool call (run_code included) on bridge-attached children
//    between 2026-09-02 00:19 and this fix;
//  - every failure path is contained: observation can never break the tool
//    execution it watches.
//
// The beforeText snapshot is read purely to size it; it is NOT persisted and
// never leaves this process — the notification carries {size, truncated} only.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

const OBSERVED_TOOLS = new Set(['edit', 'write']);
const SNAPSHOT_MAX_BYTES = 1024 * 1024; // 1 MiB, mirrors the extension-side edit cap
const PATH_KEYS = ['file_path', 'filePath', 'path'];

/**
 * Defensively pull the file path out of a pre-execute carrier. The exec shape
 * has drifted across dsh-tools versions (arguments / args / params / input),
 * so every known container is probed; no match → null (skip, never throw).
 * @param {object} exec
 * @returns {string|null}
 */
function extractPath(exec) {
  if (!exec || typeof exec !== 'object') return null;
  const containers = [exec.arguments, exec.args, exec.params, exec.input, exec];
  for (const container of containers) {
    if (!container || typeof container !== 'object') continue;
    for (const key of PATH_KEYS) {
      const value = container[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
  }
  return null;
}

/**
 * Session id for attribution: exec.agent.session.id first, exec.agent.id as
 * the fallback, '' when neither resolves.
 * @param {object} exec
 * @returns {string}
 */
function extractSessionId(exec) {
  const agent = exec && typeof exec === 'object' ? exec.agent : null;
  const candidates = [
    agent && agent.session && agent.session.id,
    agent && agent.id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return '';
}

/**
 * Size the before-snapshot without keeping it. Returns null when the file
 * cannot be read (missing file, permissions, races): the caller then skips
 * the notification entirely.
 * @param {string} path
 * @param {Function} readFileSyncFn - injectable seam for tests.
 * @returns {{size: number, truncated: boolean}|null}
 */
function readBeforeSnapshot(path, readFileSyncFn = readFileSync) {
  let buffer;
  try {
    buffer = readFileSyncFn(path);
  } catch {
    return null;
  }
  if (!Buffer.isBuffer(buffer)) {
    try {
      buffer = Buffer.from(String(buffer), 'utf8');
    } catch {
      return null;
    }
  }
  const truncated = buffer.length > SNAPSHOT_MAX_BYTES;
  return {
    // size = byte length of the (possibly truncated) beforeText; the content
    // itself is discarded here and never enters the notification.
    size: truncated ? SNAPSHOT_MAX_BYTES : buffer.length,
    truncated,
  };
}

/**
 * Mount the edit/write observer on a DSH plugin context.
 *
 * @param {object} deps
 * @param {object} deps.ctx - DSH plugin context (needs ctx.on).
 * @param {Function} deps.notify - receives the payload object; transport
 *   failures must be contained on the caller side (and are caught here too).
 * @param {Function} [deps.log] - optional diagnostic logger.
 * @param {Function} [deps.readFileSyncFn] - test seam for the before-read.
 * @returns {{dispose: () => void}
 */
function createEditObserver({ ctx, notify, log = () => {}, readFileSyncFn = readFileSync } = {}) {
  if (!ctx || typeof ctx.on !== 'function') {
    throw new TypeError('createEditObserver requires a DSH ctx with ctx.on');
  }
  if (typeof notify !== 'function') {
    throw new TypeError('createEditObserver requires a notify function');
  }
  const disposeListener = ctx.on('tools/pre-execute', (exec, next) => {
    try {
      if (exec && OBSERVED_TOOLS.has(exec.name)) {
        const path = extractPath(exec);
        if (path) {
          const snapshot = readBeforeSnapshot(path, readFileSyncFn);
          if (snapshot) {
            notify({
              tool: exec.name,
              path,
              sessionId: extractSessionId(exec),
              size: snapshot.size,
              truncated: snapshot.truncated,
            });
          }
        } else {
          log('[dsh-vscode-integration] edit observer: no path in exec, skipping');
        }
      }
    } catch (error) {
      log('[dsh-vscode-integration] edit observer failed: ' + (error && error.message ? error.message : error));
    }
    // Observe-only: ALWAYS delegate. Returning a value (even undefined)
    // without calling next() short-circuits the cordis waterfall and makes
    // dsh-tools read gate.kind of undefined — every tool call in the child
    // then fails with the 'reading kind' error. A denied or failed
    // observation must not influence the tool execution.
    return typeof next === 'function' ? next() : undefined;
  });
  return {
    dispose() {
      if (typeof disposeListener === 'function') disposeListener();
    },
  };
}

export {
  SNAPSHOT_MAX_BYTES,
  createEditObserver,
  extractPath,
  extractSessionId,
  readBeforeSnapshot,
};
