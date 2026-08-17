'use strict';

/**
 * CH1 protocol contract for the versioned VS Code bridge.
 *
 * This module is the single source of truth for the protocol versions the
 * extension host can serve, the request methods available in each version and
 * the notifications available in each version. It intentionally contains no
 * runtime dependencies and no VS Code API usage.
 */

const PROTOCOL_VERSIONS = Object.freeze([1, 2]);

const METHODS_V1 = Object.freeze([
  'vscode/editor/getContext',
  'vscode/editor/open',
  'vscode/editor/openDiff',
  'vscode/workspace/getDiagnostics',
  'vscode/extensions/getProviderStates',
  'vscode/extensions/openDetails',
]);

// Batch B3 adds no new request methods; v2 keeps the same six methods.
const METHODS_V2 = Object.freeze([...METHODS_V1]);

const NOTIFICATIONS_V1 = Object.freeze([
  'vscode/contextChanged',
  'vscode/providerStatesChanged',
  'vscode/workspaceChanged',
]);

const NOTIFICATIONS_V2 = Object.freeze([
  ...NOTIFICATIONS_V1,
  'vscode/editor/selectionChanged',
  'vscode/editor/activeEditorChanged',
  'vscode/diagnosticsChanged',
]);

const METHODS_BY_VERSION = Object.freeze({
  1: METHODS_V1,
  2: METHODS_V2,
});

const NOTIFICATIONS_BY_VERSION = Object.freeze({
  1: NOTIFICATIONS_V1,
  2: NOTIFICATIONS_V2,
});

/**
 * Metadata-only payload shapes for v2 notifications. The values describe the
 * wire type of each field; the objects themselves are frozen so the contract
 * cannot be mutated at runtime.
 */
const V2_NOTIFICATION_SCHEMA = Object.freeze({
  'vscode/editor/selectionChanged': Object.freeze({
    uri: 'string',
    version: 'number',
    attachmentIds: 'string[]',
  }),
  'vscode/editor/activeEditorChanged': Object.freeze({
    uri: 'string',
  }),
  'vscode/diagnosticsChanged': Object.freeze({
    uri: 'string',
    attachmentIds: 'string[]',
  }),
});

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function matchesWireType(value, wireType) {
  if (wireType === 'string') return typeof value === 'string';
  if (wireType === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (wireType === 'string[]') {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
  }
  return false;
}

/**
 * Runtime enforcement of the metadata-only v2 notification contract.
 *
 * The schema is authoritative in both directions: every declared field must
 * be present with the declared wire type, and any undeclared field (for
 * example `content` or `body`) is rejected so notification payloads can never
 * smuggle document text through the metadata channel.
 *
 * @param {string} method - CH1 notification method.
 * @param {object} params - Notification params.
 * @returns {object} The validated params (unchanged).
 */
function validateV2NotificationParams(method, params) {
  const schema = V2_NOTIFICATION_SCHEMA[method];
  if (!schema) return params;
  if (!isRecord(params)) {
    throw new TypeError(`CH1 v2 notification ${method} params must be an object (V2_NOTIFICATION_SCHEMA)`);
  }
  for (const [field, wireType] of Object.entries(schema)) {
    if (params[field] === undefined) {
      throw new TypeError(`CH1 v2 notification ${method} is missing required field ${field} (V2_NOTIFICATION_SCHEMA)`);
    }
    if (!matchesWireType(params[field], wireType)) {
      throw new TypeError(`CH1 v2 notification ${method} field ${field} must be ${wireType} (V2_NOTIFICATION_SCHEMA)`);
    }
  }
  for (const field of Object.keys(params)) {
    if (!Object.prototype.hasOwnProperty.call(schema, field)) {
      throw new TypeError(`CH1 v2 notification ${method} does not allow field ${field} (V2_NOTIFICATION_SCHEMA)`);
    }
  }
  return params;
}

module.exports = {
  METHODS_BY_VERSION,
  NOTIFICATIONS_BY_VERSION,
  PROTOCOL_VERSIONS,
  V2_NOTIFICATION_SCHEMA,
  validateV2NotificationParams,
};
