'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  CHANNELS,
  MESSAGE_TYPES,
  REQUEST_ID,
  VERSIONS,
  isThreadResult,
} = require('./protocol/webview');

const CHANNEL = CHANNELS.THREAD;
const VERSION = VERSIONS.THREAD;

/**
 * Maximum directory nesting depth for a bounded folder attachment listing.
 * Root children are depth 1; depth ≤ 2 therefore lists children and their
 * immediate sub-entries, never deeper.
 * @type {number}
 */
const DEFAULT_MAX_FOLDER_DEPTH = 2;

/**
 * Maximum number of entries kept in a bounded folder attachment listing.
 * @type {number}
 */
const DEFAULT_MAX_FOLDER_ENTRIES = 500;

/**
 * Names always excluded from a bounded folder listing, independently of the
 * hidden-entry rule: version control metadata and dependency caches.
 * @type {ReadonlySet<string>}
 */
const FOLDER_SKIP_NAMES = new Set(['node_modules', '.git']);

function attachmentFileName(label, fallback) {
  let fileName = String(label || fallback);
  try {
    const pathname = new URL(fileName).pathname;
    fileName = decodeURIComponent(pathname.slice(pathname.lastIndexOf('/') + 1)) || fileName;
  } catch { /* keep the supplied label */ }
  return fileName;
}

function formatSelectionAttachment(attachment, label) {
  if (!attachment || attachment.kind !== 'selection' || typeof attachment.content !== 'string') {
    throw new TypeError('A selection attachment is required');
  }
  if (typeof attachment.id !== 'string' || !/^ctx-[1-9][0-9]*$/.test(attachment.id)) {
    throw new TypeError('A valid selection attachment id is required');
  }
  const start = attachment.range && attachment.range.start ? attachment.range.start.line + 1 : null;
  const end = attachment.range && attachment.range.end ? attachment.range.end.line + 1 : null;
  const fileName = attachmentFileName(label, 'selection');
  const linkLabel = `${fileName}${start === null || end === null ? '' : `:${start}-${end}`}`
    .replace(/([\\\[\]])/g, '\\$1');
  const target = `https://dsh-vscode.invalid/attachment/${encodeURIComponent(attachment.id)}`;
  return `[${linkLabel}](${target})`;
}

function formatFileAttachment(attachment, label) {
  // 'active-file' (single active editor) and 'file' (explicit multi-pick from
  // attachFiles) share the same wire shape and link semantics.
  if (!attachment || (attachment.kind !== 'active-file' && attachment.kind !== 'file') || typeof attachment.content !== 'string') {
    throw new TypeError('A file attachment is required');
  }
  if (typeof attachment.id !== 'string' || !/^ctx-[1-9][0-9]*$/.test(attachment.id)) {
    throw new TypeError('A valid file attachment id is required');
  }
  const fileName = attachmentFileName(label, 'file');
  const linkLabel = fileName.replace(/([\\\[\]])/g, '\\$1');
  const target = `https://dsh-vscode.invalid/attachment/${encodeURIComponent(attachment.id)}`;
  return `[${linkLabel}](${target})`;
}

/**
 * Build a bounded directory listing: relative paths only, never file content.
 *
 * Bounds (this is the safety boundary that keeps folder listings cheap and
 * deterministic):
 *  - depth ≤ {@link DEFAULT_MAX_FOLDER_DEPTH} (root children = depth 1).
 *  - at most {@link DEFAULT_MAX_FOLDER_ENTRIES} entries, including folders.
 *  - `node_modules`, `.git` and every hidden (dot-prefixed) entry are skipped.
 *
 * The walk reads only directory entry names and stat metadata; it never opens
 * files, so this is safe to run on an arbitrary trusted `file://` folder — the
 * same trust boundary the explicit `dsh.addFileToThread` command already uses.
 *
 * `fsApi` is injectable for hermetic tests and defaults to `node:fs`.
 *
 * @param {string} rootFsPath - Absolute file-system path of the folder.
 * @param {object} [options] - Listing options.
 * @param {number} [options.depth] - Maximum listing depth.
 * @param {number} [options.maxEntries] - Maximum entry count.
 * @param {boolean} [options.skipHidden=true] - Skip dot-prefixed entries.
 * @param {{ readdirSync: Function, statSync: Function }} [options.fsApi] - FS facade.
 * @returns {{ root: string, entries: Array<{relPath: string, kind: 'dir'|'file'}>, depth: number, truncated: boolean, rootIsDirectory: boolean }} Listing result.
 */
function buildFolderListing(rootFsPath, options = {}) {
  const depth = Number.isInteger(options.depth) && options.depth >= 1 ? options.depth : DEFAULT_MAX_FOLDER_DEPTH;
  const maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries >= 1
    ? options.maxEntries
    : DEFAULT_MAX_FOLDER_ENTRIES;
  const skipHidden = options.skipHidden !== false;
  const fsApi = options.fsApi && typeof options.fsApi.readdirSync === 'function' && typeof options.fsApi.statSync === 'function'
    ? options.fsApi
    : { readdirSync: fs.readdirSync, statSync: fs.statSync };

  let rootIsDirectory = false;
  try {
    const rootStats = fsApi.statSync(rootFsPath);
    rootIsDirectory = Boolean(rootStats && typeof rootStats.isDirectory === 'function' && rootStats.isDirectory());
  } catch { /* treated as not a directory */ }

  const entries = [];
  let truncated = false;
  if (!rootIsDirectory) {
    return { root: rootFsPath, entries, depth, truncated, rootIsDirectory };
  }

  const stack = [{ fsPath: rootFsPath, relDir: '', producedDepth: 1 }];
  while (stack.length > 0 && !truncated) {
    const current = stack.pop();
    let names;
    try {
      names = fsApi.readdirSync(current.fsPath);
    } catch { /* unreadable directory: skip it */ continue; }
    names.sort();
    for (const name of names) {
      if (entries.length >= maxEntries) {
        truncated = true;
        break;
      }
      if (FOLDER_SKIP_NAMES.has(name)) continue;
      if (skipHidden && name.length > 0 && name[0] === '.') continue;
      const relPath = current.relDir === '' ? name : `${current.relDir}/${name}`;
      const childFsPath = path.join(current.fsPath, name);
      let stats;
      try {
        stats = fsApi.statSync(childFsPath);
      } catch { /* disappear during the walk: skip it */ continue; }
      const isDirectory = Boolean(stats && typeof stats.isDirectory === 'function' && stats.isDirectory());
      entries.push({ relPath, kind: isDirectory ? 'dir' : 'file' });
      if (isDirectory && current.producedDepth < depth) {
        stack.push({ fsPath: childFsPath, relDir: relPath, producedDepth: current.producedDepth + 1 });
      }
    }
  }

  // Deterministic ordering: folders first, then files, each alphabetically.
  entries.sort((left, right) => (
    left.kind === right.kind
      ? left.relPath.localeCompare(right.relPath)
      : left.kind === 'dir' ? -1 : 1
  ));
  return { root: rootFsPath, entries, depth, truncated, rootIsDirectory };
}

/**
 * Render a bounded folder listing as compact flat text: one header line plus
 * one relative path per entry (folders carry a trailing slash).
 *
 * @param {{ entries: Array<{relPath: string, kind: 'dir'|'file'}>, depth: number, truncated: boolean }} listing - Listing to render.
 * @returns {string} Listing text.
 */
function formatFolderListing(listing) {
  const count = listing.entries.length;
  const truncated = listing.truncated === true;
  const header = `folder: ${count} entr${count === 1 ? 'y' : 'ies'} (depth <= ${listing.depth}${truncated ? ', truncated' : ''})`;
  const lines = [header];
  for (const entry of listing.entries) {
    lines.push(entry.kind === 'dir' ? `${entry.relPath}/` : entry.relPath);
  }
  return lines.join('\n');
}

function formatFolderAttachment(attachment, label) {
  if (!attachment || attachment.kind !== 'folder' || typeof attachment.content !== 'string') {
    throw new TypeError('A folder attachment is required');
  }
  if (typeof attachment.id !== 'string' || !/^ctx-[1-9][0-9]*$/.test(attachment.id)) {
    throw new TypeError('A valid folder attachment id is required');
  }
  const fileName = attachmentFileName(label, 'folder');
  const linkLabel = fileName.replace(/([\\\[\]])/g, '\\$1');
  const target = `https://dsh-vscode.invalid/attachment/${encodeURIComponent(attachment.id)}`;
  return `[${linkLabel}](${target})`;
}

function parseThreadResult(message) {
  if (!isThreadResult(message)) return null;
  if (!REQUEST_ID.test(message.requestId)) return null;
  if (typeof message.ok !== 'boolean') return null;
  return {
    requestId: message.requestId,
    ok: message.ok,
    error: typeof message.error === 'string' ? message.error.slice(0, 500) : undefined,
  };
}

class ThreadAttachmentCoordinator {
  constructor({ timeoutMs = 10000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
  }

  async request(webview, text) {
    if (!webview || typeof webview.postMessage !== 'function') throw new TypeError('Webview is unavailable');
    if (typeof text !== 'string' || text.length === 0) throw new TypeError('Thread attachment text is required');
    const requestId = crypto.randomUUID().replace(/-/g, '_');
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('DSH did not accept the selection before the timeout'));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
    });
    const delivered = await webview.postMessage({
      type: MESSAGE_TYPES.THREAD_ATTACH,
      channel: CHANNEL,
      version: VERSION,
      requestId,
      text,
    });
    if (!delivered) {
      const waiter = this.pending.get(requestId);
      if (waiter) {
        this.pending.delete(requestId);
        clearTimeout(waiter.timer);
        waiter.reject(new Error('DSH sidebar Webview is unavailable'));
      }
    }
    return result;
  }

  handleResult(message) {
    const result = parseThreadResult(message);
    if (!result) return false;
    const waiter = this.pending.get(result.requestId);
    if (!waiter) return true;
    this.pending.delete(result.requestId);
    clearTimeout(waiter.timer);
    if (result.ok) waiter.resolve();
    else waiter.reject(new Error(result.error || 'DSH rejected the selection'));
    return true;
  }

  dispose() {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('DSH thread attachment bridge disposed'));
    }
    this.pending.clear();
  }
}

module.exports = {
  CHANNEL,
  VERSION,
  DEFAULT_MAX_FOLDER_DEPTH,
  DEFAULT_MAX_FOLDER_ENTRIES,
  FOLDER_SKIP_NAMES,
  ThreadAttachmentCoordinator,
  buildFolderListing,
  formatFileAttachment,
  formatFolderAttachment,
  formatFolderListing,
  formatSelectionAttachment,
  parseThreadResult,
};
