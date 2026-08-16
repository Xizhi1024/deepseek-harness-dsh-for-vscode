"use strict";

/**
 * DSH workspace registry client (CH2).
 *
 * Thin JSON-RPC client over the DSH Web API's workspace.list / workspace.create
 * methods. Reuses the loopback/JSON-RPC helpers from sessionNavigation so the
 * two clients share one transport and one response contract.
 */

const path = require("node:path");
const {
  DshSessionError,
  assertLoopbackBaseUrl,
  clientRequest,
  postJson,
  readJsonBody,
  assertServerResponse,
  resolveFetchImpl,
} = require("../sessionNavigation");

/** API path for workspace.list. @type {string} */
const WORKSPACE_LIST_PATH = "/api/workspace.list";
/** API path for workspace.create. @type {string} */
const WORKSPACE_CREATE_PATH = "/api/workspace.create";

/**
 * Validate one WorkspaceView-ish item returned by the workspace registry.
 *
 * @param {*} item - Candidate workspace item.
 * @returns {object} The validated item.
 * @throws {DshSessionError} DSH_SESSION_API_INVALID_RESPONSE when required
 *   fields are missing or have the wrong type.
 */
function assertWorkspaceItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new DshSessionError(
      "DSH_SESSION_API_INVALID_RESPONSE",
      "DSH workspace API invalid response: each workspace item must be an object"
    );
  }
  if (typeof item.workspaceId !== "string" || item.workspaceId.length === 0) {
    throw new DshSessionError(
      "DSH_SESSION_API_INVALID_RESPONSE",
      "DSH workspace API invalid response: each workspace item must have a non-empty workspaceId string"
    );
  }
  if (typeof item.path !== "string") {
    throw new DshSessionError(
      "DSH_SESSION_API_INVALID_RESPONSE",
      "DSH workspace API invalid response: each workspace item must have a path string"
    );
  }
  if (!Array.isArray(item.sessionIds)) {
    throw new DshSessionError(
      "DSH_SESSION_API_INVALID_RESPONSE",
      "DSH workspace API invalid response: each workspace item must have a sessionIds array"
    );
  }
  for (const sessionId of item.sessionIds) {
    if (typeof sessionId !== "string") {
      throw new DshSessionError(
        "DSH_SESSION_API_INVALID_RESPONSE",
        "DSH workspace API invalid response: sessionIds entries must be strings"
      );
    }
  }
  return item;
}

/**
 * List DSH workspaces through `POST <baseUrl>/api/workspace.list`.
 *
 * @param {string} baseUrl - Loopback base URL (`http://127.0.0.1:<port>` or
 *   `http://localhost:<port>`).
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] - Fetch-compatible function; defaults
 *   to `globalThis.fetch`.
 * @param {AbortSignal} [options.signal] - Optional abort signal.
 * @returns {Promise<Array<object>>} New array of workspace items.
 * @throws {DshSessionError} With the DSH_SESSION_API_* error codes.
 */
async function listWorkspaces(baseUrl, options = {}) {
  const fetchImpl = resolveFetchImpl(options);
  const parsed = assertLoopbackBaseUrl(baseUrl);
  const response = await postJson(
    parsed,
    WORKSPACE_LIST_PATH,
    clientRequest("workspace.list", {}),
    fetchImpl,
    options.signal
  );
  const body = await readJsonBody(response);
  const result = assertServerResponse(body);
  const value = result.value;
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.items)) {
    throw new DshSessionError(
      "DSH_SESSION_API_INVALID_RESPONSE",
      "DSH workspace API invalid response: result.value.items must be an array"
    );
  }
  return value.items.map((item) => assertWorkspaceItem(item));
}

/**
 * Create a DSH workspace through `POST <baseUrl>/api/workspace.create`.
 *
 * @param {string} baseUrl - Loopback base URL (`http://127.0.0.1:<port>` or
 *   `http://localhost:<port>`).
 * @param {string} workspacePath - Absolute workspace path to register.
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] - Fetch-compatible function; defaults
 *   to `globalThis.fetch`.
 * @param {AbortSignal} [options.signal] - Optional abort signal.
 * @returns {Promise<{ workspace: object, created: boolean }>} Created workspace
 *   view plus whether the registry created it.
 * @throws {DshSessionError} With the DSH_SESSION_API_* error codes.
 */
async function createWorkspace(baseUrl, workspacePath, options = {}) {
  const fetchImpl = resolveFetchImpl(options);
  const parsed = assertLoopbackBaseUrl(baseUrl);
  const response = await postJson(
    parsed,
    WORKSPACE_CREATE_PATH,
    clientRequest("workspace.create", { path: workspacePath }),
    fetchImpl,
    options.signal
  );
  const body = await readJsonBody(response);
  const result = assertServerResponse(body);
  const value = result.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DshSessionError(
      "DSH_SESSION_API_INVALID_RESPONSE",
      "DSH workspace API invalid response: result.value must be an object"
    );
  }
  const workspace = assertWorkspaceItem(value.workspace);
  if (typeof value.created !== "boolean") {
    throw new DshSessionError(
      "DSH_SESSION_API_INVALID_RESPONSE",
      "DSH workspace API invalid response: result.value.created must be a boolean"
    );
  }
  return { workspace, created: value.created };
}

/**
 * Normalize a filesystem path for workspace matching.
 *
 * @param {string} value - Path to normalize.
 * @param {string} platform - Node platform name (`win32` or other).
 * @returns {string} Normalized path.
 */
function normalizeWorkspacePath(value, platform) {
  const resolved = path.resolve(value);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Find a workspace item whose path matches the given filesystem path.
 *
 * @param {Array<object>} items - Workspace items from listWorkspaces.
 * @param {string} fsPath - Absolute workspace path to find.
 * @param {string} [platform=process.platform] - Node platform name.
 * @returns {object|null} Matching workspace item, or null.
 */
function findWorkspaceByPath(items, fsPath, platform = process.platform) {
  if (!Array.isArray(items) || typeof fsPath !== "string" || fsPath.length === 0) {
    return null;
  }
  const target = normalizeWorkspacePath(fsPath, platform);
  for (const item of items) {
    if (!item || typeof item.path !== "string" || item.path.length === 0) continue;
    if (normalizeWorkspacePath(item.path, platform) === target) {
      return item;
    }
  }
  return null;
}

module.exports = {
  listWorkspaces,
  createWorkspace,
  findWorkspaceByPath,
  normalizeWorkspacePath,
};
