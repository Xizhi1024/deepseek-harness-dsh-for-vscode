'use strict';

/**
 * D2: structured Diagnose report (pure).
 *
 * Replaces the old single-string dsh.diagnose toast with a sectioned
 * report (service / bridge / compatibility / plugins / alerts), humanized
 * startup-error text with suggested actions, a WSL default-terminal
 * detector (README compatibility promise), and a JSON projection for the
 * DSH OutputChannel. All inputs are injected; no VS Code import here.
 */

const { getStartupError } = require('../startupErrors');

function defaultLoc(template, params = {}) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? `{${key}}`));
}

/**
 * True when a default terminal profile name looks like a WSL shell.
 *
 * @param {string|null|undefined} name - Default profile name.
 * @returns {boolean} True when the name matches a known WSL distro shell.
 */
function isWslProfile(name) {
  return typeof name === 'string' && name.length > 0
    && /wsl|ubuntu|debian|kali|suse|pengwin|oracle/i.test(name);
}

/**
 * Humanize one error through the startup-error taxonomy: known codes get
 * the table hint and retryability; everything else passes through as text.
 *
 * @param {Error|{code?: string, message?: string}|string|null} err - Error value.
 * @returns {{text: string, hint: string, retryable: boolean}|null} Null when
 *   nothing can be derived.
 */
function humanizeError(err) {
  if (err && typeof err === 'object' && typeof err.message === 'string' && err.message.length > 0) {
    const def = err.code ? getStartupError(err.code) : null;
    if (def) return { text: err.message, hint: def.diagnoseHint, retryable: def.retryable };
    return { text: err.message, hint: '', retryable: true };
  }
  if (typeof err === 'string' && err.length > 0) {
    const def = getStartupError(err.split(':')[0].trim());
    return def ? { text: err, hint: def.diagnoseHint, retryable: def.retryable } : { text: err, hint: '', retryable: true };
  }
  return null;
}

/**
 * Build the sectioned Diagnose report.
 *
 * @param {object} options
 * @param {object} options.snapshot - diagnosticSnapshot() output.
 * @param {string} [options.hostVersion] - VS Code version string.
 * @param {object} [options.hostCapabilities] - deriveVscodeCapabilities() result.
 * @param {object} [options.compat] - { dshVersion, patchOverlay, themeParam, toolsV3 }.
 * @param {Array<{id: string, error: *, at: *}>} [options.featureFailures] - Feature-registry failures.
 * @param {number} [options.selfHealCount] - Patch-drop self-heal events.
 * @param {string|null} [options.defaultTerminalProfile] - Default terminal profile name.
 * @param {string} [options.platform] - process.platform override (tests).
 * @param {Function} [options.loc] - Localization helper.
 * @param {() => string} [options.now] - Timestamp provider.
 * @returns {object} Frozen report with summary, sections, alerts and json.
 */
function buildDiagnoseReport({
  snapshot,
  hostVersion = 'unknown',
  hostCapabilities = {},
  compat = {},
  featureFailures = [],
  selfHealCount = 0,
  defaultTerminalProfile = null,
  platform = process.platform,
  loc = defaultLoc,
  now = () => new Date().toISOString(),
} = {}) {
  const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const server = snap.server && typeof snap.server === 'object' ? snap.server : {};
  const bridge = snap.bridge && typeof snap.bridge === 'object' ? snap.bridge : {};
  const home = snap.home && typeof snap.home === 'object' ? snap.home : {};
  const providers = Array.isArray(snap.providers) ? snap.providers : [];
  const installed = providers.filter((provider) => provider && provider.installed).length;
  const plugins = snap.dshPlugins && typeof snap.dshPlugins === 'object' ? snap.dshPlugins : {};
  const pluginStates = plugins.states && typeof plugins.states === 'object' ? plugins.states : {};

  const alerts = [];
  if (!server.available) {
    alerts.push({
      id: 'server-down',
      severity: 'error',
      text: loc('DSH server is not running'),
      hint: loc('Start it with the Restart DSH Server command, or enable dsh.autoStart.'),
      action: { command: 'dsh.restartServer' },
    });
  }
  if (!bridge.listening) {
    alerts.push({
      id: 'bridge-closed',
      severity: 'warn',
      text: loc('VS Code bridge is closed'),
      hint: loc('Reload the VS Code window to rebuild the bridge.'),
      action: { command: 'workbench.action.reloadWindow' },
    });
  }
  if (platform === 'win32' && isWslProfile(defaultTerminalProfile)) {
    alerts.push({
      id: 'wsl-default-terminal',
      severity: 'warn',
      text: loc('Default terminal profile "{profile}" is a WSL shell — extension-host terminals and the terminal bridge become unreliable when the workspace lives in WSL.', { profile: defaultTerminalProfile }),
      hint: loc('Set terminal.integrated.defaultProfile.windows to a Windows shell (PowerShell or cmd); see the README compatibility table.'),
      action: { command: 'workbench.action.openSettings', args: ['terminal.integrated.defaultProfile.windows'] },
    });
  }
  for (const failure of Array.isArray(featureFailures) ? featureFailures : []) {
    const human = humanizeError(failure && failure.error);
    if (!human) continue;
    alerts.push({
      id: 'feature-' + (failure && failure.id ? failure.id : 'unknown'),
      severity: 'error',
      text: loc('Feature {id} degraded: {message}', { id: (failure && failure.id) || 'unknown', message: human.text }),
      hint: human.hint,
      action: null,
    });
  }
  if (selfHealCount > 0) {
    alerts.push({
      id: 'self-heal',
      severity: 'info',
      text: loc('Self-healed without --patch: {count} time(s)', { count: String(selfHealCount) }),
      hint: '',
      action: null,
    });
  }

  const chat = hostCapabilities && hostCapabilities.chatParticipant ? 'yes' : 'no';
  const lm = hostCapabilities && hostCapabilities.lmProvider ? 'yes' : 'no';
  const mcp = hostCapabilities && hostCapabilities.mcpServerDefinitions ? 'yes' : 'no';
  const dshVersion = compat && typeof compat.dshVersion === 'string' && compat.dshVersion.length > 0 ? compat.dshVersion : 'unknown';

  const sections = [
    {
      id: 'service',
      items: [
        {
          label: 'server',
          detail: server.available
            ? String(server.url || '') + (server.owned ? ' (owned)' : '')
            : loc('stopped'),
          severity: server.available ? 'ok' : 'error',
          hint: '',
          action: null,
        },
        {
          label: 'home',
          detail: String(home.mode || 'unknown') + ' · ' + String(home.path || ''),
          severity: 'info',
          hint: '',
          action: null,
        },
        {
          label: 'host',
          detail: 'VS Code ' + String(hostVersion) + ' · chat=' + chat + ', lm=' + lm + ', mcp=' + mcp,
          severity: 'info',
          hint: '',
          action: null,
        },
      ],
    },
    {
      id: 'bridge',
      items: [
        {
          label: 'bridge',
          detail: bridge.listening
            ? 'listening :' + String(bridge.port == null ? '?' : bridge.port)
            : loc('closed'),
          severity: bridge.listening ? 'ok' : 'warn',
          hint: '',
          action: null,
        },
      ],
    },
    {
      id: 'compat',
      items: [
        {
          label: 'dsh',
          detail: dshVersion
            + ' (patch=' + (compat && compat.patchOverlay ? 'yes' : 'no')
            + ', theme=' + (compat && compat.themeParam ? 'yes' : 'no')
            + ', toolsV3=' + (compat && compat.toolsV3 ? 'yes' : 'no') + ')',
          severity: 'info',
          hint: '',
          action: null,
        },
      ],
    },
    {
      id: 'plugins',
      items: [
        {
          label: 'providers',
          detail: installed + '/' + providers.length + ' installed',
          severity: 'info',
          hint: '',
          action: null,
        },
        {
          label: 'catalog',
          detail: 'revision ' + String(snap.catalogRevision || 'unknown').slice(0, 8)
            + ' · plugins active=' + String(pluginStates.active == null ? '?' : pluginStates.active)
            + ', disabled=' + String(pluginStates.disabled == null ? '?' : pluginStates.disabled)
            + ', absent=' + String(pluginStates.absent == null ? '?' : pluginStates.absent),
          severity: 'info',
          hint: '',
          action: null,
        },
      ],
    },
  ];
  if (alerts.length > 0) {
    sections.push({
      id: 'alerts',
      items: alerts,
    });
  }

  const summary = loc('server {server}, bridge {bridge}, providers {installed}/{total} installed, {count} alert(s)', {
    server: server.available ? loc('running') : loc('stopped'),
    bridge: bridge.listening ? loc('listening') : loc('closed'),
    installed: String(installed),
    total: String(providers.length),
    count: String(alerts.length),
  });

  return Object.freeze({
    generatedAt: now(),
    summary,
    sections,
    alerts,
    json: {
      generatedAt: now(),
      host: String(hostVersion),
      capabilities: { chatParticipant: chat === 'yes', lmProvider: lm === 'yes', mcpServerDefinitions: mcp === 'yes' },
      compat: {
        dshVersion,
        patchOverlay: Boolean(compat && compat.patchOverlay),
        themeParam: Boolean(compat && compat.themeParam),
        toolsV3: Boolean(compat && compat.toolsV3),
      },
      defaultTerminalProfile: defaultTerminalProfile || null,
      platform,
      alerts,
      snapshot: snap,
    },
  });
}

const SECTION_LABELS = Object.freeze({
  service: 'Service',
  bridge: 'Bridge',
  compat: 'Compatibility',
  plugins: 'Plugins',
  alerts: 'Alerts',
});

const SEVERITY_PREFIX = Object.freeze({
  ok: '',
  info: '$(info) ',
  warn: '$(warning) ',
  error: '$(error) ',
});

/**
 * Build QuickPick items for the report: one separator per section plus one
 * pickable entry per item, with codicon severity prefixes and joined
 * detail/hint text.
 *
 * @param {object} report - buildDiagnoseReport() output.
 * @param {object} [options]
 * @param {Function} [options.loc] - Localization helper.
 * @returns {Array<object>} Items shaped { separator?, label, detail, action }.
 */
function buildDiagnoseQuickPickItems(report, { loc = defaultLoc } = {}) {
  const items = [];
  for (const section of (report && Array.isArray(report.sections)) ? report.sections : []) {
    items.push({ separator: true, label: loc(SECTION_LABELS[section.id] || section.id) });
    for (const entry of Array.isArray(section.items) ? section.items : []) {
      items.push({
        separator: false,
        label: (SEVERITY_PREFIX[entry.severity] || '') + String(entry.label || ''),
        detail: [entry.detail, entry.hint].filter((part) => typeof part === 'string' && part.length > 0).join(' — '),
        action: entry.action || null,
      });
    }
  }
  return items;
}

/**
 * Show the report as a sectioned QuickPick and resolve with the picked
 * entry (or null on cancel/hide/absent host API). Mirrors the
 * sessionNavigation.showSessionQuickPick degradation contract; the caller
 * must NOT await this on command paths where a picker without events would
 * hang (fire-and-forget is fine).
 *
 * @param {object} vscode - VS Code facade.
 * @param {object} report - buildDiagnoseReport() output.
 * @param {object} [options] - Forwarded to buildDiagnoseQuickPickItems plus placeholder.
 * @returns {Promise<object|null>} Picked item or null.
 */
function showDiagnoseQuickPick(vscode, report, options = {}) {
  if (!vscode || !vscode.window || typeof vscode.window.createQuickPick !== 'function') {
    return Promise.resolve(null);
  }
  const built = buildDiagnoseQuickPickItems(report, options);
  const separatorKind = vscode.QuickPickItemKind && vscode.QuickPickItemKind.Separator;
  const picker = vscode.window.createQuickPick();
  picker.canPickMany = false;
  picker.items = built.map((item) => (item.separator && separatorKind
    ? { label: item.label, kind: separatorKind }
    : { label: item.label, detail: item.detail }));
  picker.placeholder = (options.loc || defaultLoc)('DSH diagnose — pick a row for details and actions');
  const actionByIndex = new Map();
  built.forEach((item, index) => {
    if (!item.separator) actionByIndex.set(index, item.action);
  });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { picker.dispose(); } catch (_) { /* ignore */ }
      resolve(value);
    };
    if (typeof picker.onDidAccept === 'function') {
      picker.onDidAccept(() => {
        const selected = picker.selectedItems && picker.selectedItems[0];
        const index = selected ? picker.items.indexOf(selected) : -1;
        finish(selected ? { action: actionByIndex.get(index) || null } : null);
      });
    }
    if (typeof picker.onDidHide === 'function') {
      picker.onDidHide(() => finish(null));
    }
    picker.show();
  });
}

module.exports = {
  buildDiagnoseReport,
  buildDiagnoseQuickPickItems,
  showDiagnoseQuickPick,
  humanizeError,
  isWslProfile,
};
