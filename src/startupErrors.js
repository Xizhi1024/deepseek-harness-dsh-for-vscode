'use strict';

/**
 * Central startup-error taxonomy for the DSH launch path.
 *
 * Every startup error code is defined here once with:
 *  - retryable: whether the existing Retry action may help without a
 *    configuration/environment change first.
 *  - template: canonical English l10n template. Every template MUST also
 *    exist in l10n/bundle.l10n.json and l10n/bundle.l10n.zh-cn.json.
 *  - diagnoseHint: one-line guidance surfaced by dsh.diagnose.
 *
 * Rendering rule: known codes render through this table (template + the real
 * underlying err.message as a note when it differs); unknown codes fall back
 * to the original error text unchanged.
 */
const STARTUP_ERRORS = Object.freeze({
  AUTOSTART_DISABLED: Object.freeze({
    retryable: false,
    template: 'DSH is not running and dsh.autoStart is disabled',
    diagnoseHint: 'Enable dsh.autoStart or start DSH manually, then retry.',
  }),
  CONFIG_HOST_UNSUPPORTED: Object.freeze({
    retryable: false,
    template: 'Unsupported dsh.host "{host}"; this extension requires {expected}',
    diagnoseHint: 'Set dsh.host to 127.0.0.1.',
  }),
  CONFIG_PORT_INVALID: Object.freeze({
    retryable: false,
    template: 'Invalid dsh.port "{port}"; expected an integer from 1 to 65535',
    diagnoseHint: 'Set dsh.port to an integer from 1 to 65535.',
  }),
  CONFIG_PACKAGE_ROOT_INVALID: Object.freeze({
    retryable: false,
    template: 'Invalid dsh.local.packageRoot: {path}',
    diagnoseHint: 'Set dsh.local.packageRoot to the directory containing @deepseek-ai/dsh.',
  }),
  CONFIG_NODE_PATH_INVALID: Object.freeze({
    retryable: false,
    template: 'Invalid dsh.local.nodePath: {path}',
    diagnoseHint: 'Set dsh.local.nodePath to an absolute Node.js executable path.',
  }),
  CONFIG_HOME_PATH_INVALID: Object.freeze({
    retryable: false,
    template: 'Invalid DSH home path: {path}',
    diagnoseHint: 'Set dsh.home.path (or DSH_HOME) to an absolute directory path.',
  }),
  CONFIG_PROFILE_INVALID: Object.freeze({
    retryable: false,
    template: 'Invalid dsh.profile: {profile}',
    diagnoseHint: 'Set dsh.profile to 1-64 characters matching [A-Za-z0-9._-].',
  }),
  RUNTIME_NOT_INSTALLED: Object.freeze({
    retryable: true,
    template: 'Official DSH is not installed. Install it with `npm install -g @deepseek-ai/dsh`, then reload VS Code; the extension will create or reuse the selected DSH home automatically.',
    diagnoseHint: 'Install the official DSH package or configure dsh.runtime.manifestUrl, then retry.',
  }),
  RUNTIME_NODE_MISSING: Object.freeze({
    retryable: true,
    template: 'Node.js was not found for the installed DSH package. Set dsh.local.nodePath to the absolute Node executable path.',
    diagnoseHint: 'Install Node.js or set dsh.local.nodePath, then retry.',
  }),
  NO_FREE_PORT: Object.freeze({
    retryable: true,
    template: 'No free port found within {limit} ports starting from {start}',
    diagnoseHint: 'Free a port near dsh.port or change dsh.port.',
  }),
  SPAWN_ERROR: Object.freeze({
    retryable: true,
    template: 'Failed to start dsh: {error}',
    diagnoseHint: 'Check the DSH spawn log and retry.',
  }),
  SPAWN_EXITED_EARLY: Object.freeze({
    retryable: true,
    template: 'DSH process exited early (code={code}, signal={signal})',
    diagnoseHint: 'Inspect the DSH log; retry after fixing the startup blocker.',
  }),
  HEALTH_TIMEOUT: Object.freeze({
    retryable: true,
    template: 'DSH service did not become ready within {seconds}s; process terminated (pid={pid})',
    diagnoseHint: 'Inspect the DSH log, then restart DSH or retry.',
  }),
  BRIDGE_INIT_TIMEOUT: Object.freeze({
    retryable: true,
    template: 'VS Code bridge initialization timed out',
    diagnoseHint: 'Restart DSH or reload the VS Code window.',
  }),
});

function fillTemplate(template, params) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) =>
    params && params[key] !== undefined && params[key] !== null ? String(params[key]) : `{${key}}`
  );
}

/**
 * Look up a startup error definition by stable machine code.
 * @param {string|undefined} code
 * @returns {Readonly<{retryable: boolean, template: string, diagnoseHint: string}>|null}
 */
function getStartupError(code) {
  return (typeof code === 'string' && STARTUP_ERRORS[code]) || null;
}

/**
 * Central Retry-enablement predicate. Unknown codes remain retryable (the
 * pre-existing default), while every classified non-retryable code keeps the
 * Retry button hidden.
 */
function isRetryableStartupError(err) {
  const def = getStartupError(err && err.code);
  return def ? def.retryable : true;
}

/**
 * Render one startup error through the taxonomy.
 *
 * Known codes use the localized table template and append the real underlying
 * err.message when it carries extra information. Unknown codes are returned
 * exactly as-is (free-text fallback, no guessing).
 *
 * @param {Error|*} err
 * @param {(template: string, params?: object) => string} [loc]
 * @returns {string}
 */
function renderStartupError(err, loc) {
  if (!err || typeof err !== 'object') return String(err);
  const def = getStartupError(err.code);
  if (!def) {
    return err && err.message ? String(err.message) : String(err);
  }
  const params = err.params || {};
  const localized = typeof loc === 'function'
    ? loc(def.template, params)
    : fillTemplate(def.template, params);
  const underlying = err && err.message ? String(err.message) : '';
  const filled = fillTemplate(def.template, params);
  if (underlying && underlying !== filled && underlying !== localized) {
    return localized + ' — ' + underlying;
  }
  return localized;
}

/**
 * One line per startup error code, used by dsh.diagnose to keep the taxonomy
 * observable and healthy.
 * @returns {string}
 */
function startupErrorTable() {
  return Object.keys(STARTUP_ERRORS)
    .sort()
    .map((code) => {
      const def = STARTUP_ERRORS[code];
      return `${code}: ${def.retryable ? 'retryable' : 'non-retryable'} — ${def.diagnoseHint}`;
    })
    .join('\n');
}

module.exports = {
  STARTUP_ERRORS,
  fillTemplate,
  getStartupError,
  isRetryableStartupError,
  renderStartupError,
  startupErrorTable,
};
