'use strict';

/**
 * Select the VS Code API surface used by the extension host.
 *
 * Keeping this boundary explicit lets node:test provide a small in-memory
 * host without loading the real `vscode` module.
 *
 * @param {object} api - Real VS Code API or a compatible test facade.
 * @returns {object} The API surface consumed by extension.js.
 */
function createVscodeFacade(api) {
  if (!api) throw new TypeError('A VS Code API facade is required');
  return Object.freeze({
    commands: api.commands,
    env: api.env,
    extensions: api.extensions,
    languages: api.languages,
    l10n: api.l10n,
    Range: api.Range,
    StatusBarAlignment: api.StatusBarAlignment,
    ConfigurationTarget: api.ConfigurationTarget,
    ColorThemeKind: api.ColorThemeKind,
    ViewColumn: api.ViewColumn,
    version: api.version,
    Uri: api.Uri,
    window: api.window,
    workspace: api.workspace,
  });
}

module.exports = { createVscodeFacade };
