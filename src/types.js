"use strict";

/**
 * Shared contract between the extension host, the webview and the DSH server.
 * Single source of truth for ports, identifiers and the boot marker used to
 * detect whether a URL actually serves the DSH web UI.
 */

/** Default TCP port the DSH web server listens on. @type {number} */
const DEFAULT_PORT = 3080;

/** Default host the DSH web server binds to. @type {string} */
const DEFAULT_HOST = "127.0.0.1";

/**
 * Marker that the DSH web index.html injects into the page. Probing a URL for
 * this symbol tells us whether a real DSH web instance is reachable.
 * @type {string}
 */
const BOOT_MARKER = "__DSH_BOOT__";

/**
 * Id of the webview view registered in package.json. @type {string}
 *
 * ⚠️ Persistent contract: these ids are how VS Code persists the user's
 * sidebar layout and extension state across upgrades. Changing them on a
 * released version makes the old view "disappear" (VS Code logs
 * UNKNOWN_VIEW_CONTAINER / unknown view and the user's layout is reset).
 * Only change them together with a new container id in package.json's
 * contributes.viewsContainers + contributes.views, and never in a patch
 * release.
 */
const VIEW_ID = "dsh.webview";

/** Id of the auxiliary-bar view container registered in package.json. @type {string} */
const CONTAINER_ID = "dsh-sidebar";

// --- C1 watchdog / heartbeat timing + env contract --------------------------
// These are the shared cadences and spawn-env keys agreed between the VS Code
// extension (heartbeat writer, DSH_VSCODE_* injection) and the integrated DSH
// host plugin (reader/check loop). The plugin package is ESM and self-contained
// (it does not and must not `require` this CommonJS file); it mirrors the same
// numeric constants so the two sides of the protocol cannot drift silently.

/** Extension rewrites the heartbeat file this often. @type {number} */
const HEARTBEAT_WRITE_MS = 10 * 1000;

/** DSH host checks the heartbeat this often. @type {number} */
const WATCHDOG_CHECK_MS = 5 * 1000;

/** A heartbeat older than this counts as expired. @type {number} */
const WATCHDOG_EXPIRY_MS = 60 * 1000;

/**
 * Spawn env keys shared between the extension and the owned DSH child.
 *  - HEARTBEAT_PATH — absolute path of the per-window heartbeat file.
 *  - WINDOW_ID — this window's stable commit; the child only trusts heartbeats
 *    carrying it (multi-window ownership, never kept alive by other windows).
 *  - WATCHDOG — "off" when dsh.closePolicy is `never` (D6): the child must not
 *    self-terminate. Absent/any other value means the watchdog runs.
 * @type {Readonly<Record<string, string>>}
 */
const WATCHDOG_ENV = Object.freeze({
  HEARTBEAT_PATH: "DSH_VSCODE_HEARTBEAT_PATH",
  WINDOW_ID: "DSH_VSCODE_WINDOW_ID",
  WATCHDOG: "DSH_VSCODE_WATCHDOG",
});

/**
 * Shape of the resolved DSH server handle used across the extension.
 *
 * @typedef {Object} RunningServer
 * @property {string} url - Base URL of the running DSH web server, e.g. "http://127.0.0.1:3080".
 * @property {string} host - Host the server is listening on.
 * @property {number} port - Port the server is listening on.
 * @property {number|null} pid - Process id, only set when this extension spawned the process (owned=true); null when reusing an existing instance.
 * @property {boolean} owned - true when this extension spawned the process itself; false when reusing an already-running instance (pid is then null).
 */

module.exports = {
  DEFAULT_PORT,
  DEFAULT_HOST,
  BOOT_MARKER,
  VIEW_ID,
  CONTAINER_ID,
  HEARTBEAT_WRITE_MS,
  WATCHDOG_CHECK_MS,
  WATCHDOG_EXPIRY_MS,
  WATCHDOG_ENV,
};
