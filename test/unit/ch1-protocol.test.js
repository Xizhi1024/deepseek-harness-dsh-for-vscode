'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  METHODS_BY_VERSION,
  NOTIFICATIONS_BY_VERSION,
  PROTOCOL_VERSIONS,
  V2_NOTIFICATION_SCHEMA,
} = require('../../src/protocol/ch1');

test('CH1 protocol exposes frozen versions 1 and 2', () => {
  assert.deepStrictEqual(PROTOCOL_VERSIONS, [1, 2]);
  assert.ok(Object.isFrozen(PROTOCOL_VERSIONS));
});

test('CH1 request methods are identical across v1 and v2 for B3', () => {
  assert.deepStrictEqual(METHODS_BY_VERSION[1], [
    'vscode/editor/getContext',
    'vscode/editor/open',
    'vscode/editor/openDiff',
    'vscode/workspace/getDiagnostics',
    'vscode/extensions/getProviderStates',
    'vscode/extensions/openDetails',
  ]);
  assert.deepStrictEqual(METHODS_BY_VERSION[2], METHODS_BY_VERSION[1]);
  assert.ok(Object.isFrozen(METHODS_BY_VERSION[1]));
  assert.ok(Object.isFrozen(METHODS_BY_VERSION[2]));
});

test('CH1 notifications add v2 metadata events without removing v1 events', () => {
  assert.deepStrictEqual(NOTIFICATIONS_BY_VERSION[1], [
    'vscode/contextChanged',
    'vscode/providerStatesChanged',
    'vscode/workspaceChanged',
  ]);
  assert.deepStrictEqual(NOTIFICATIONS_BY_VERSION[2], [
    'vscode/contextChanged',
    'vscode/providerStatesChanged',
    'vscode/workspaceChanged',
    'vscode/editor/selectionChanged',
    'vscode/editor/activeEditorChanged',
    'vscode/diagnosticsChanged',
  ]);
  assert.ok(Object.isFrozen(NOTIFICATIONS_BY_VERSION[1]));
  assert.ok(Object.isFrozen(NOTIFICATIONS_BY_VERSION[2]));
});

test('CH1 v2 notification schema is metadata-only', () => {
  assert.deepStrictEqual(Object.keys(V2_NOTIFICATION_SCHEMA).sort(), [
    'vscode/diagnosticsChanged',
    'vscode/editor/activeEditorChanged',
    'vscode/editor/selectionChanged',
  ]);
  assert.deepStrictEqual(V2_NOTIFICATION_SCHEMA['vscode/editor/selectionChanged'], {
    uri: 'string',
    version: 'number',
    attachmentIds: 'string[]',
  });
  assert.deepStrictEqual(V2_NOTIFICATION_SCHEMA['vscode/editor/activeEditorChanged'], {
    uri: 'string',
  });
  assert.deepStrictEqual(V2_NOTIFICATION_SCHEMA['vscode/diagnosticsChanged'], {
    uri: 'string',
    attachmentIds: 'string[]',
  });
  for (const schema of Object.values(V2_NOTIFICATION_SCHEMA)) {
    assert.ok(Object.isFrozen(schema));
  }
});
