"use strict";

/**
 * DSH workspace registry client (CH2).
 *
 * Thin typert gateway client over the DSH Web API's workspace create / delete
 * methods. Reuses the loopback/JSON-RPC helpers from sessionNavigation so the
 * two clients share one transport and one response contract.
 *
 * Wire note (verified 2026-09-17 against the installed dsh 0.1.5-rc.1
 * typert gateway): the workspace controller registers create / rename /
 * delete / insertBefore / insertSessionBefore / archiveSession / follow, but
 * NO list endpoint. Registration is therefore create-or-adopt:
 * `workspace/create` returns `{ workspace, created }`, where `created: false`
 * means the workspace was already registered. `workspace/delete` removes a
 * registration by id and is used to roll back a consent-declined creation.
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

/** API path for workspace.create. @type {string} */
const WORKSPACE_CREATE_PATH = "/api/workspace/create";
/** API path for workspace.delete. @type {string} */
const WORKSPACE_DELETE_PATH = "/api/workspace/delete";

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
 * Create or adopt a DSH workspace through `POST <baseUrl>/api/workspace/create`.
 *
 * The call is idempotent: when the registry already has a workspace for the
 * path it returns that workspace with `created: false`, otherwise it registers
 * one with `created: true`.
 *
 * @param {string} baseUrl - Loopback base URL (`http://127.0.0.1:<port>` or
 *   `http://localhost:<port>`).
 * @param {string} workspacePath - Absolute workspace path to register.
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] - Fetch-compatible function; defaults
 *   to `globalThis.fetch`.
 * @param {AbortSignal} [options.signal] - Optional abort signal.
 * @returns {Promise<{ workspace: object, created: boolean }>} Workspace view
 *   plus whether this call registered it (`false` = adopted an existing one).
 * @throws {DshSessionError} With the DSH_SESSION_API_* error codes.
 */
async function createWorkspace(baseUrl, workspacePath, options = {}) {
  const fetchImpl = resolveFetchImpl(options);
  const parsed = assertLoopbackBaseUrl(baseUrl);
  const response = await postJson(
    parsed,
    WORKSPACE_CREATE_PATH,
    clientRequest("workspace/create", { request: { path: workspacePath } }),
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
 * Delete a DSH workspace registration through
 * `POST <baseUrl>/api/workspace/delete`.
 *
 * Used to roll back a create-on-a-shared-server decision the user declined:
 * at that point the workspace carries no sessions yet (the root session is
 * created only after binding), so deletion is safe.
 *
 * @param {string} baseUrl - Loopback base URL (`http://127.0.0.1:<port>` or
 *   `http://localhost:<port>`).
 * @param {object} request
 * @param {string} request.workspaceId - Workspace id to delete.
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] - Fetch-compatible function; defaults
 *   to `globalThis.fetch`.
 * @param {AbortSignal} [options.signal] - Optional abort signal.
 * @returns {Promise<{deleted: true}>} Delete receipt.
 * @throws {TypeError} When workspaceId is missing or empty.
 * @throws {DshSessionError} With the DSH_SESSION_API_* error codes.
 */
async function deleteWorkspace(baseUrl, request, options = {}) {
  if (!request || typeof request.workspaceId !== "string" || request.workspaceId.length === 0) {
    throw new TypeError("workspaceId must be a non-empty string");
  }
  const fetchImpl = resolveFetchImpl(options);
  const parsed = assertLoopbackBaseUrl(baseUrl);
  const response = await postJson(
    parsed,
    WORKSPACE_DELETE_PATH,
    clientRequest("workspace/delete", { request: { workspaceId: request.workspaceId } }),
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
  if (value.deleted !== true) {
    throw new DshSessionError(
      "DSH_SESSION_API_INVALID_RESPONSE",
      "DSH workspace API invalid response: result.value.deleted must be true"
    );
  }
  return { deleted: true };
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
 * @param {Array<object>} items - Workspace items.
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
  createWorkspace,
  deleteWorkspace,
  findWorkspaceByPath,
  normalizeWorkspacePath,
};