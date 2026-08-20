'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * E-T2b callExport journal: persists vscode/extensions/callExport summaries
 * into `<storageDir>/callExport/journal.json` as a JSON array.
 *
 * The journal is best-effort by contract: a storageDirProvider of null, a
 * missing/invalid storage directory, or any IO failure makes record() a
 * no-op so a journal problem can never change the callExport outcome.
 *
 * The module deliberately has zero VS Code imports; node:fs/path are used
 * directly (same precedent as changeTracker / dshHome).
 */

const DEFAULT_MAX_ENTRIES = 500;

/**
 * @param {object} [options]
 * @param {Function} [options.storageDirProvider] - () => { fsPath } | null.
 *   Returns context.globalStorageUri (or null for tests); null disables IO.
 * @param {Function} [options.now] - Timestamp provider (milliseconds since
 *   epoch) used only when a caller-supplied entry has no `at` string.
 * @param {number} [options.maxEntries] - Soft upper bound; older entries are
 *   trimmed first. Defaults to 500.
 * @returns {object} Frozen journal API { record(entry): void }.
 */
function createCallExportJournal({
  storageDirProvider = null,
  now = Date.now,
  maxEntries = DEFAULT_MAX_ENTRIES,
} = {}) {
  const provider = typeof storageDirProvider === 'function' ? storageDirProvider : null;
  const limit = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : DEFAULT_MAX_ENTRIES;
  let idSeq = 0;

  function resolveJournalPath() {
    if (provider === null) return null;
    let storageDir = null;
    try {
      storageDir = provider();
    } catch {
      return null;
    }
    if (!storageDir || typeof storageDir.fsPath !== 'string' || storageDir.fsPath.length === 0) {
      return null;
    }
    return path.join(storageDir.fsPath, 'callExport', 'journal.json');
  }

  function nextId() {
    idSeq += 1;
    return 'ce-' + idSeq;
  }

  function readEntries(filePath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // A missing/corrupt journal starts over; best-effort by contract.
      return [];
    }
  }

  function writeEntries(filePath, entries) {
    // Atomic write, same tmp+rename shape as changeTracker.
    const temporary = `${filePath}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(entries, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, filePath);
  }

  /**
   * Append one callExport summary entry.
   *
   * The v3 bridge call site (E-T2a) already passes id/at; those caller values
   * are kept verbatim. When a caller omits id/at the journal produces them
   * itself ('ce-' sequence + ISO timestamp from `now`).
   *
   * @param {object} entry - { id?, at?, extensionId, method, argsSummary, result }.
   * @returns {void}
   */
  function record(entry) {
    const filePath = resolveJournalPath();
    if (!filePath) return; // no storageDirProvider -> best-effort no-op
    try {
      const source = entry && typeof entry === 'object' ? entry : {};
      const stored = Object.assign({}, source, {
        id: typeof source.id === 'string' && source.id.length > 0 ? source.id : nextId(),
        at: typeof source.at === 'string' && source.at.length > 0 ? source.at : new Date(now()).toISOString(),
      });
      const entries = readEntries(filePath);
      entries.push(stored);
      writeEntries(filePath, entries.slice(-limit));
    } catch {
      // journal IO failure must not affect the callExport outcome
    }
  }

  return Object.freeze({ record });
}

module.exports = { createCallExportJournal };
