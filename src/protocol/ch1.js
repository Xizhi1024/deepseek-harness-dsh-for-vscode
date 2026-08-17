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

module.exports = {
  METHODS_BY_VERSION,
  NOTIFICATIONS_BY_VERSION,
  PROTOCOL_VERSIONS,
  V2_NOTIFICATION_SCHEMA,
};
