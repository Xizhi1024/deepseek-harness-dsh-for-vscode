'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createVscodeFacade } = require('../../src/vscodeFacade');

test('the facade forwards every top-level VS Code surface extension.js consumes', () => {
  const api = {
    commands: {}, env: {}, extensions: {}, languages: {}, l10n: {},
    Position: class {}, Range: class {}, WorkspaceEdit: class {},
    StatusBarAlignment: {}, ConfigurationTarget: {},
    ColorThemeKind: { Dark: 2 }, ViewColumn: { Active: 1 }, version: '1.106.0',
    Uri: {}, window: {}, workspace: {},
  };
  const facade = createVscodeFacade(api);
  for (const key of Object.keys(api)) {
    assert.strictEqual(facade[key], api[key], 'facade must forward ' + key);
  }
  // Regression (R16 F5): createWebviewPanel needs ViewColumn.Active through the
  // facade; theme derivation needs ColorThemeKind; diagnose needs version.
  assert.strictEqual(facade.ViewColumn.Active, 1);
  assert.strictEqual(facade.ColorThemeKind.Dark, 2);
  assert.strictEqual(facade.version, '1.106.0');
  assert.strictEqual(facade.WorkspaceEdit, api.WorkspaceEdit);
  assert.strictEqual(facade.Position, api.Position);
  assert.throws(() => { facade.window = {}; }, /Cannot assign/, 'facade stays frozen');
});
