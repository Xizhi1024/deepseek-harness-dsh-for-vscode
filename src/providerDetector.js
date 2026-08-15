'use strict';

const {
  catalogRevision,
  catalogSnapshot,
  isAllowedDetailsUri,
  resolveProvider,
} = require('./capabilityCatalog');

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * The real VS Code API does not expose a direct "this extension is disabled"
 * flag. This detector therefore approximates enabled state from what the
 * extension host can observe: an installed extension is treated as enabled
 * when it is active OR when its package.json contributes visible commands or
 * views. Installed but inactive with no visible contribution points is
 * reported as `extension-disabled-or-inactive`. This is an API-observable
 * approximation; W4 acceptance that needs the true enabled state should
 * refresh through `vscode.extensions.onDidChange` after the user toggles the
 * extension in the Extensions view.
 */

/**
 * Validate the VS Code facade surface consumed by provider detection.
 *
 * @param {object} vscode - VS Code facade.
 * @returns {void}
 */
function assertExtensionsFacade(vscode) {
  if (!isRecord(vscode)) throw new TypeError('vscode facade must be an object');
  if (!isRecord(vscode.extensions)) {
    throw new TypeError('vscode.extensions must be an object');
  }
  if (typeof vscode.extensions.getExtension !== 'function') {
    throw new TypeError('vscode.extensions.getExtension must be a function');
  }
}

/**
 * @param {object} vscode - VS Code facade.
 * @returns {void}
 */
function assertBridgeHandlersFacade(vscode) {
  assertExtensionsFacade(vscode);
  if (!isRecord(vscode.env) || typeof vscode.env.openExternal !== 'function') {
    throw new TypeError('vscode.env.openExternal must be a function');
  }
  if (!vscode.Uri || typeof vscode.Uri.parse !== 'function') {
    throw new TypeError('vscode.Uri.parse must be a function');
  }
  if (!isRecord(vscode.commands) || typeof vscode.commands.executeCommand !== 'function') {
    throw new TypeError('vscode.commands.executeCommand must be a function');
  }
}

/**
 * @param {string} message - Human-readable error message.
 * @returns {Error} Bridge error with the stable VSCODE_INVALID_PARAMS code.
 */
function invalidParams(message) {
  const error = new Error(message);
  error.bridgeCode = 'VSCODE_INVALID_PARAMS';
  return error;
}

/**
 * True when an extension package.json contributes visible commands or views.
 *
 * @param {object} packageJSON - Extension package.json.
 * @returns {boolean} True for visible command/views contribution points.
 */
function hasVisibleContribution(packageJSON) {
  if (!isRecord(packageJSON) || !isRecord(packageJSON.contributes)) return false;
  const contributes = packageJSON.contributes;
  if (Array.isArray(contributes.commands) && contributes.commands.length > 0) return true;
  if (isRecord(contributes.views)) {
    for (const viewList of Object.values(contributes.views)) {
      if (Array.isArray(viewList) && viewList.length > 0) return true;
    }
  }
  return false;
}

/**
 * Detect the observable state of every provider in the controlled catalog.
 *
 * The function re-reads `vscode.extensions` on every call and keeps no
 * module-level cache, so state can never leak across workspaces or windows.
 * Output only contains providers present in `catalog` — never arbitrary
 * extensions the caller asks about.
 *
 * @param {object} options - Detection options.
 * @param {object} options.vscode - VS Code facade.
 * @param {object[]} [options.catalog] - Catalog to inspect; defaults to the controlled snapshot.
 * @returns {object[]} Provider states in catalog order.
 */
function detectProviderStates({ vscode, catalog = catalogSnapshot() } = {}) {
  assertExtensionsFacade(vscode);
  if (!Array.isArray(catalog)) throw new TypeError('catalog must be an array');

  const states = [];
  for (const entry of catalog) {
    const extension = vscode.extensions.getExtension(entry.providerId);
    const installed = extension !== undefined && extension !== null;
    const state = {
      providerId: entry.providerId,
      installed,
      enabled: false,
      compatible: entry.compatibility === undefined ? 'unknown' : entry.compatibility,
      health: 'unknown',
      reason: entry.reason,
    };

    if (installed) {
      if (isRecord(extension.packageJSON) && extension.packageJSON.version !== undefined) {
        state.version = extension.packageJSON.version;
      }
      if (extension.isActive === true || hasVisibleContribution(extension.packageJSON)) {
        state.enabled = true;
      } else {
        state.enabled = false;
        state.reason = 'extension-disabled-or-inactive';
      }
    } else {
      state.enabled = false;
    }

    states.push(state);
  }
  return states;
}

/**
 * Build the versioned-bridge handlers for the two capability methods.
 *
 * `vscode/extensions/openDetails` only opens catalog-controlled details:
 * `https://` entries go through `vscode.env.openExternal`, while
 * `vscode:extension/...` entries open the VS Code extension details view.
 * No install path exists in this module or in extension.js.
 *
 * @param {object} options - Handler options.
 * @param {object} options.vscode - VS Code facade.
 * @param {object[]} [options.catalog] - Catalog to inspect; defaults to the controlled snapshot.
 * @returns {object} Frozen handler map keyed by bridge method name.
 */
function createExtensionBridgeHandlers({ vscode, catalog = catalogSnapshot() } = {}) {
  assertBridgeHandlersFacade(vscode);

  return Object.freeze({
    'vscode/extensions/getProviderStates': async () => ({
      providers: detectProviderStates({ vscode, catalog }),
    }),

    'vscode/extensions/openDetails': async (params) => {
      const body = isRecord(params) ? params : {};
      if (typeof body.providerId !== 'string' || body.providerId.length === 0) {
        throw invalidParams('openDetails requires providerId as a non-empty string');
      }
      const entry = resolveProvider(body.providerId);
      if (!entry) {
        throw invalidParams(`Unknown provider in catalog: ${body.providerId}`);
      }
      if (!isAllowedDetailsUri(entry.detailsUri)) {
        throw invalidParams(`Provider detailsUri is not allowed: ${entry.providerId}`);
      }
      if (entry.detailsUri.startsWith('https://')) {
        await vscode.env.openExternal(vscode.Uri.parse(entry.detailsUri));
      } else {
        await vscode.commands.executeCommand('workbench.extensions.show', entry.providerId);
      }
      return { opened: true };
    },
  });
}

/**
 * Build a deterministic diagnostic snapshot for `dsh.diagnose` and tests.
 * Pure with respect to VS Code: all inputs are injected and every call
 * re-runs provider detection against the current facade.
 *
 * @param {object} options - Snapshot options.
 * @param {object} options.vscode - VS Code facade.
 * @param {object} [options.config] - Normalized `dsh.*` configuration.
 * @param {object|null} [options.server] - Current server handle, if any.
 * @param {object|null} [options.bridge] - Current versioned bridge, if any.
 * @param {object[]} [options.catalog] - Catalog to inspect; defaults to the controlled snapshot.
 * @param {() => string} [options.now] - Timestamp provider.
 * @returns {object} Diagnostic snapshot with stable field names.
 */
function diagnosticSnapshot({
  vscode,
  config = {},
  server = null,
  bridge = null,
  catalog = catalogSnapshot(),
  now = () => new Date().toISOString(),
} = {}) {
  assertExtensionsFacade(vscode);

  const cfg = isRecord(config) ? config : {};
  return {
    generatedAt: now(),
    catalogRevision: catalogRevision(),
    providers: detectProviderStates({ vscode, catalog }),
    config: {
      host: cfg.host === undefined ? null : cfg.host,
      port: cfg.port === undefined ? null : cfg.port,
      autoStart: cfg.autoStart === undefined ? null : cfg.autoStart,
      closePolicy: cfg.closePolicy === undefined ? null : cfg.closePolicy,
    },
    server: {
      available: Boolean(server),
      owned: Boolean(server && server.owned === true),
      url: server && typeof server.url === 'string' ? server.url : null,
      port: server && Number.isInteger(server.port) ? server.port : null,
    },
    bridge: {
      listening: Boolean(bridge && Number.isInteger(bridge.port)),
      port: bridge && Number.isInteger(bridge.port) ? bridge.port : null,
    },
  };
}

module.exports = {
  createExtensionBridgeHandlers,
  detectProviderStates,
  diagnosticSnapshot,
};
