'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * C1 L3 watcher fallback (PLAN-1.1.0 L3): a workspace-wide FileSystemWatcher
 * records every on-disk change that neither the bridge (L2) nor the tool
 * interceptor (L1/C2) already attributed, as `source: 'external'` journal
 * entries — the Codex "review after the fact via git" philosophy.
 *
 * Behavior:
 *  - a watch-all FileSystemWatcher glob + 500ms debounce merge;
 *  - ignores .git, the journal/extension globalStorage itself, and paths
 *    matched by the user's `files.watcherExclude` configuration;
 *  - deduplicates against existing bridge/tool-intercept entries by
 *    (path, mtime ±1s) so one write is never journaled twice;
 *  - captures a before-snapshot (≤1MiB, globalStorage/changes/snapshots/<id>)
 *    so external entries stay undoable;
 *  - circuit breaker: >20 events/s sustained for 5s disables the watcher and
 *    degrades to a 60s git-status poll (built-in vscode.git API, read-only,
 *    same shape as the v3 vscode/git/getStatus handler).
 *
 * Every seam (timers, clock, fs ops, vscode facade) is injectable so the unit
 * tests drive the whole state machine without a real watcher.
 */

const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_RATE_LIMIT_PER_SECOND = 20;
const DEFAULT_RATE_SUSTAIN_MS = 5000;
/**
 * Storm hardening (2026-09-05): one flush slice = one journal write. A burst
 * that slips past the rate breaker before it trips (5s window) can queue
 * tens of thousands of pending paths; slices keep each recordBatch bounded
 * and yield between slices so the extension host stays responsive.
 */
const MAX_FLUSH_BATCH = 500;
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEDUP_MTIME_TOLERANCE_MS = 1000;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const GIT_EXTENSION_ID = 'vscode.git';

/**
 * Translate one files.watcherExclude glob into a RegExp. Supports the VS Code
 * glob subset that matters for exclusion lists: `**` (any depth, may wrap
 * slashes), `*` (within one segment) and `?` (one character).
 *
 * @param {string} pattern - Glob pattern.
 * @returns {RegExp} Anchored matcher.
 */
function globToRegExp(pattern) {
  let source = '';
  let i = 0;
  const text = String(pattern);
  while (i < text.length) {
    const char = text[i];
    if (char === '*') {
      if (text[i + 1] === '*') {
        // '**/' -> zero or more path segments; a bare '**' spans separators.
        if (text[i + 2] === '/') {
          source += '(?:[^/]*/)*';
          i += 3;
        } else {
          source += '.*';
          i += 2;
        }
      } else {
        source += '[^/]*';
        i += 1;
      }
    } else if (char === '?') {
      source += '[^/]';
      i += 1;
    } else if ('\\^$.|+()[]{}'.includes(char)) {
      source += '\\' + char;
      i += 1;
    } else {
      source += char;
      i += 1;
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * True when the workspace-relative path is matched by a truthy entry of the
 * files.watcherExclude configuration object.
 *
 * @param {string} relativePath - Posix-style workspace-relative path.
 * @param {object} excludeMap - files.watcherExclude value (glob -> boolean).
 * @returns {boolean}
 */
function matchesWatcherExclude(relativePath, excludeMap) {
  if (!relativePath || !isRecordLike(excludeMap)) return false;
  for (const [glob, enabled] of Object.entries(excludeMap)) {
    if (!enabled) continue;
    try {
      if (globToRegExp(glob).test(relativePath)) return true;
    } catch {
      // an uncompilable user glob must never break the watcher
    }
  }
  return false;
}

function isRecordLike(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function toPosix(value) {
  return String(value).replace(/\\/g, '/');
}

function entryAtMs(entry) {
  const ms = Date.parse(entry && entry.at);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Does one journal entry reference the changed file? Bridge entries carry
 * file URIs inside edits[].uri; tool-intercept entries carry a server-side
 * absolute `path`; watcher entries carry both `path` and `uri`.
 */
function entryMatchesPath(entry, uriString, fsPath) {
  if (!isRecordLike(entry)) return false;
  if (typeof entry.path === 'string' && entry.path === fsPath) return true;
  if (typeof entry.uri === 'string' && entry.uri === uriString) return true;
  if (Array.isArray(entry.edits)) {
    for (const edit of entry.edits) {
      if (edit && String(edit.uri) === uriString) return true;
    }
  }
  return false;
}

/**
 * Path-equality for attribution dedup across producers: tool-intercept
 * entries may carry a differently-cased drive letter or mixed separators
 * than the watcher's fsPath (live incident 2026-09-04: 'D:\\x\\y' vs
 * 'd:\\x\\y' and relative-vs-absolute shapes made the dedup miss, so one
 * agent edit was journaled twice). Resolve both sides and compare
 * case-insensitively on win32.
 */
function sameFsPath(left, right, platform = process.platform) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length === 0 || right.length === 0) {
    return false;
  }
  try {
    const a = path.resolve(left);
    const b = path.resolve(right);
    return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

/**
 * @param {object} options
 * @param {object} options.vscode - VS Code facade (workspace.createFileSystemWatcher,
 *   workspace.getConfiguration, workspace.workspaceFolders, extensions).
 * @param {object} options.tracker - changeTracker instance (list/record/updateEntry).
 * @param {{fsPath:string}} [options.storageUri] - context.globalStorageUri; its
 *   changes/ tree (journal + snapshots) is ignored by the watcher.
 * @param {Function} [options.onDiagnostic] - Optional log sink.
 * @param {Function} [options.nowMs] - Injectable epoch-milliseconds clock.
 * @param {object} [options.timers] - Injectable timer functions.
 * @param {number} [options.debounceMs] - Watcher debounce window.
 * @param {number} [options.pollIntervalMs] - Circuit-breaker git poll interval.
 * @param {object} [options.fsOps] - Injectable fs operations for tests.
 * @returns {object} Frozen watcher API ({ dispose, flush, pollOnce, state }).
 */
function createChangeWatcher({
  vscode,
  tracker,
  storageUri = null,
  onDiagnostic = () => {},
  nowMs = () => Date.now(),
  timers = null,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  fsOps = {},
} = {}) {
  if (!vscode || !vscode.workspace) throw new TypeError('createChangeWatcher requires vscode.workspace');
  if (!tracker || typeof tracker.record !== 'function' || typeof tracker.list !== 'function') {
    throw new TypeError('createChangeWatcher requires a change tracker');
  }
  const {
    statSync = (...args) => fs.statSync(...args),
    readFileSync = (...args) => fs.readFileSync(...args),
    writeFileSync = (...args) => fs.writeFileSync(...args),
    mkdirSync = (...args) => fs.mkdirSync(...args),
  } = fsOps;
  const {
    setTimeout: schedule = (...args) => setTimeout(...args),
    clearTimeout: cancel = (...args) => clearTimeout(...args),
    setInterval: every = (...args) => setInterval(...args),
    clearInterval: stopEvery = (...args) => clearInterval(...args),
  } = timers || {};

  const storageRoot = storageUri && typeof storageUri.fsPath === 'string' ? storageUri.fsPath : null;
  let mode = 'watching';
  let watcher = null;
  let pending = new Map(); // uri.toString() -> { uri, fsPath }
  let pendingTimer = null;
  let pollTimer = null;
  /** Breaker state machine (2026-09-05): whole-second buckets. */
  let bucketSecond = null;
  let bucketCount = 0;
  let overloadSince = null;
  let disposed = false;

  function workspaceRelative(fsPath) {
    const folders = vscode.workspace.workspaceFolders;
    if (!Array.isArray(folders)) return null;
    for (const folder of folders) {
      const root = folder && folder.uri && typeof folder.uri.fsPath === 'string' ? folder.uri.fsPath : null;
      if (!root) continue;
      if (fsPath === root || fsPath.startsWith(root + path.sep) || fsPath.startsWith(root + '/')) {
        return toPosix(fsPath.slice(root.length + 1));
      }
    }
    return null;
  }

  function isIgnored(fsPath) {
    const normalized = toPosix(fsPath);
    if (/(^|\/)\.git(\/|$)/.test(normalized)) return true;
    if (storageRoot) {
      const root = toPosix(storageRoot);
      if (normalized === root || normalized.startsWith(root + '/')) return true;
    }
    const relative = workspaceRelative(fsPath);
    if (relative === null) return true; // outside every workspace folder
    let excludeMap = {};
    try {
      excludeMap = vscode.workspace.getConfiguration('files').get('watcherExclude', {}) || {};
    } catch {
      excludeMap = {};
    }
    return matchesWatcherExclude(relative, excludeMap);
  }

  /**
   * Rate accounting for the breaker, settled in WHOLE-SECOND BUCKETS: the
   * first event of a new second settles the previous bucket's total, and
   * only that settled total feeds the overload state machine. The previous
   * per-event sliding-window check was structurally dead in two ways: the
   * per-event count climbs 1,2,3…20 through the first twenty events of
   * every second and each sub-threshold reading RESET overloadSince, and a
   * window evaluated at a second boundary excludes the previous second's
   * batch by exactly 1000ms — so no real-world storm (>20/s sustained for
   * 5s) ever tripped the breaker (live CPU-storm incident 2026-09-05).
   */
  function noteEvent() {
    const at = nowMs();
    const second = Math.floor(at / 1000);
    if (second !== bucketSecond) {
      if (bucketSecond !== null) {
        if (bucketCount > DEFAULT_RATE_LIMIT_PER_SECOND) {
          if (overloadSince === null) {
            overloadSince = bucketSecond * 1000;
          } else if (second * 1000 - overloadSince >= DEFAULT_RATE_SUSTAIN_MS) {
            bucketSecond = second;
            bucketCount = 1;
            tripBreaker();
            return;
          }
        } else {
          overloadSince = null;
        }
      }
      bucketSecond = second;
      bucketCount = 0;
    }
    bucketCount += 1;
  }

  function tripBreaker() {
    if (mode !== 'watching') return;
    mode = 'git-polling';
    onDiagnostic('change watcher: event rate breaker tripped; degrading to git status polling');
    detachWatcher();
    pending.clear();
    if (pendingTimer !== null) {
      cancel(pendingTimer);
      pendingTimer = null;
    }
    try {
      pollTimer = every(() => {
        pollOnce().catch(() => {});
      }, pollIntervalMs);
    } catch (error) {
      onDiagnostic(`change watcher: git poll timer failed: ${error && error.message ? error.message : error}`);
    }
  }

  function detachWatcher() {
    try {
      watcher?.dispose?.();
    } catch {
      // best-effort
    }
    watcher = null;
  }

  function handleEvent(uri) {
    if (disposed || mode !== 'watching') return;
    noteEvent();
    if (disposed || mode !== 'watching') return; // the breaker may have tripped above
    const fsPath = uri && typeof uri.fsPath === 'string' ? uri.fsPath : String(uri);
    pending.set(String(uri), { uri, fsPath });
    if (pendingTimer === null) {
      pendingTimer = schedule(() => {
        pendingTimer = null;
        flush().catch(() => {});
      }, debounceMs);
    }
  }

  /**
   * Pure-read half of the old processChange: ignore-filter, stat, dedup and
   * snapshot read. Returns {snapshotText, payload} or null when the change
   * must not be journaled; NO tracker writes happen here — slices are
   * persisted once by processBatch (storm hardening, 2026-09-05).
   */
  async function collectChange({ uri, fsPath }) {
    const uriString = String(uri);
    if (isIgnored(fsPath)) return null;
    let mtimeMs = nowMs();
    let size = 0;
    try {
      const stats = statSync(fsPath);
      mtimeMs = typeof stats.mtimeMs === 'number' ? stats.mtimeMs : mtimeMs;
      size = typeof stats.size === 'number' ? stats.size : 0;
    } catch {
      // deleted file: keep the wall-clock fallback mtime
    }
    // (path, mtime ±1s) dedup against EVERY existing attributed entry: a
    // write already recorded by the bridge or tool interceptor must not be
    // duplicated as external.
    // (path, mtime ±1s) dedup against EVERY existing attributed entry: a
    // write already recorded by the bridge or tool interceptor must not be
    // duplicated as external. peekEntries is the zero-copy cache view — the
    // old list() deep-cloned the whole journal for every file (storm
    // amplifier, 2026-09-05).
    const journalView = typeof tracker.peekEntries === 'function' ? tracker.peekEntries() : tracker.list();
    const alreadyTracked = journalView.some((entry) => (
      (entryMatchesPath(entry, uriString, fsPath)
        || (typeof entry.path === 'string' && sameFsPath(entry.path, fsPath)))
      && Math.abs(entryAtMs(entry) - mtimeMs) <= DEDUP_MTIME_TOLERANCE_MS
    ));
    if (alreadyTracked) return null;
    let snapshotText = null;
    if (size > 0 && size <= MAX_SNAPSHOT_BYTES) {
      try {
        snapshotText = readFileSync(fsPath, 'utf8');
      } catch {
        snapshotText = null;
      }
    }
    return {
      snapshotText,
      payload: {
        source: 'external',
        label: path.basename(fsPath),
        sessionId: '',
        edits: [],
        before: [],
        status: 'accepted',
        path: fsPath,
        uri: uriString,
      },
    };
  }

  /**
   * Storm-hardened persistence for one slice: ONE journal write for the whole
   * slice (recordBatch), snapshot files written independently (one per
   * entry), then ONE patch write attaching every snapshot path
   * (applyEntryPatches). Falls back to per-entry record/updateEntry for
   * trackers without the batch APIs.
   */
  async function processBatch(slice) {
    const collected = [];
    for (const change of slice) {
      if (disposed) return;
      try {
        const item = await collectChange(change);
        if (item !== null) collected.push(item);
      } catch (error) {
        onDiagnostic(`change watcher: processing ${change.fsPath} failed: ${error && error.message ? error.message : error}`);
      }
    }
    if (collected.length === 0) return;
    let entries;
    if (typeof tracker.recordBatch === 'function') {
      entries = await tracker.recordBatch(collected.map((item) => item.payload));
    } else {
      entries = [];
      for (const item of collected) entries.push(await tracker.record(item.payload));
    }
    const patches = [];
    for (let i = 0; i < entries.length && i < collected.length; i += 1) {
      const item = collected[i];
      const entry = entries[i];
      if (item.snapshotText === null || !storageRoot) continue;
      if (typeof tracker.updateEntry !== 'function' && typeof tracker.applyEntryPatches !== 'function') continue;
      try {
        const directory = path.join(storageRoot, 'changes', 'snapshots');
        mkdirSync(directory, { recursive: true });
        const snapshotPath = path.join(directory, entry.id);
        writeFileSync(snapshotPath, item.snapshotText, 'utf8');
        patches.push({ id: entry.id, patch: { beforeSnapshotPath: snapshotPath } });
      } catch (error) {
        onDiagnostic(`change watcher: snapshot for ${item.payload.path} failed: ${error && error.message ? error.message : error}`);
      }
    }
    if (patches.length === 0) return;
    if (typeof tracker.applyEntryPatches === 'function') {
      tracker.applyEntryPatches(patches);
    } else {
      for (const { id, patch } of patches) await tracker.updateEntry(id, patch);
    }
  }

  async function flush() {
    const batch = [...pending.values()];
    pending = new Map();
    for (let offset = 0; offset < batch.length; offset += MAX_FLUSH_BATCH) {
      if (disposed) return;
      const slice = batch.slice(offset, offset + MAX_FLUSH_BATCH);
      try {
        await processBatch(slice);
      } catch (error) {
        onDiagnostic(`change watcher: flush slice failed: ${error && error.message ? error.message : error}`);
      }
    }
  }

  /**
   * Circuit-breaker fallback: one read-only git-status sweep through the
   * built-in vscode.git API (mirrors the v3 vscode/git/getStatus handler).
   * Working-tree changes not yet journaled become external entries.
   *
   * @returns {Promise<number>} Count of newly recorded entries.
   */
  async function pollOnce() {
    if (disposed) return 0;
    const extension = vscode.extensions && vscode.extensions.getExtension
      && vscode.extensions.getExtension(GIT_EXTENSION_ID);
    if (!extension) return 0;
    const exported = extension.isActive ? extension.exports : await extension.activate();
    const api = exported && typeof exported.getBuiltInGitApi === 'function'
      ? await exported.getBuiltInGitApi()
      : exported;
    if (!api || typeof api.getRepositories !== 'function') return 0;
    const repositories = await api.getRepositories();
    let recorded = 0;
    for (const repository of Array.isArray(repositories) ? repositories : []) {
      const changes = repository && repository.state && Array.isArray(repository.state.workingTreeChanges)
        ? repository.state.workingTreeChanges
        : [];
      // One batched persistence pass per repository (storm hardening:
      // per-change record was one full journal write each).
      const untracked = [];
      const journalView = typeof tracker.peekEntries === 'function' ? tracker.peekEntries() : tracker.list();
      for (const change of changes) {
        if (!change || !change.uri) continue;
        const fsPath = typeof change.uri.fsPath === 'string' ? change.uri.fsPath : String(change.uri);
        const alreadyTracked = journalView.some((entry) => entryMatchesPath(entry, String(change.uri), fsPath));
        if (alreadyTracked) continue;
        untracked.push({ uri: change.uri, fsPath });
      }
      if (untracked.length > 0) {
        await processBatch(untracked);
        recorded += untracked.length;
      }
    }
    return recorded;
  }

  // Auto-start: create the watcher eagerly. Facades without
  // createFileSystemWatcher (tests, degraded hosts) degrade to polling mode
  // instead of failing changes-review activation.
  if (typeof vscode.workspace.createFileSystemWatcher === 'function') {
    try {
      watcher = vscode.workspace.createFileSystemWatcher('**/*');
      watcher.onDidChange(handleEvent);
      watcher.onDidCreate(handleEvent);
      watcher.onDidDelete(handleEvent);
    } catch (error) {
      onDiagnostic(`change watcher: createFileSystemWatcher failed: ${error && error.message ? error.message : error}`);
      watcher = null;
    }
  }
  if (!watcher) {
    mode = 'disabled';
  }

  function dispose() {
    disposed = true;
    detachWatcher();
    if (pendingTimer !== null) {
      cancel(pendingTimer);
      pendingTimer = null;
    }
    if (pollTimer !== null) {
      try {
        stopEvery(pollTimer);
      } catch {
        // best-effort
      }
      pollTimer = null;
    }
    pending.clear();
    mode = 'stopped';
  }

  function state() {
    return mode;
  }

  return Object.freeze({
    dispose,
    flush,
    pollOnce,
    state,
  });
}

module.exports = {
  createChangeWatcher,
  globToRegExp,
  matchesWatcherExclude,
  sameFsPath,
};
