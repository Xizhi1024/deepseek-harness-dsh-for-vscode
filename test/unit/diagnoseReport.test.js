'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildDiagnoseReport,
  buildDiagnoseQuickPickItems,
  showDiagnoseQuickPick,
  humanizeError,
  isWslProfile,
} = require('../../src/diagnose/report');

const HEALTHY_SNAPSHOT = {
  catalogRevision: 'rev-12345678',
  providers: [{ installed: true }, { installed: false }],
  dshPlugins: { states: { active: 2, disabled: 1, absent: 0 } },
  home: { mode: 'shared', path: 'C:/Users/x/.dsh', source: 'default' },
  server: { available: true, owned: true, url: 'http://127.0.0.1:3080', port: 3080 },
  bridge: { listening: true, port: 3999 },
  binding: null,
};

test('isWslProfile matches known WSL distro shells only', () => {
  assert.strictEqual(isWslProfile('Ubuntu-22.04 (WSL)'), true);
  assert.strictEqual(isWslProfile('Debian'), true);
  assert.strictEqual(isWslProfile('PowerShell'), false);
  assert.strictEqual(isWslProfile('Command Prompt'), false);
  assert.strictEqual(isWslProfile(null), false);
  assert.strictEqual(isWslProfile(''), false);
});

test('humanizeError maps known startup codes to table hints', () => {
  const human = humanizeError({ code: 'RUNTIME_NOT_INSTALLED', message: 'official DSH is not installed' });
  assert.strictEqual(human.text, 'official DSH is not installed');
  assert.strictEqual(human.hint, 'Install the official DSH package or configure dsh.runtime.manifestUrl, then retry.');
  assert.strictEqual(human.retryable, true);
});

test('humanizeError passes unknown and string errors through', () => {
  assert.deepStrictEqual(humanizeError(new Error('boom')), { text: 'boom', hint: '', retryable: true });
  assert.deepStrictEqual(humanizeError('SPAWN_ERROR: spawn failed'), { text: 'SPAWN_ERROR: spawn failed', hint: 'Check the DSH spawn log and retry.', retryable: true });
  assert.strictEqual(humanizeError(undefined), null);
});

test('buildDiagnoseReport sections: service/bridge/compat/plugins (+ alerts when present)', () => {
  const report = buildDiagnoseReport({
    snapshot: HEALTHY_SNAPSHOT,
    hostVersion: '1.106.0',
    hostCapabilities: { chatParticipant: true, lmProvider: false, mcpServerDefinitions: true },
    compat: { dshVersion: '0.3.1', patchOverlay: true, themeParam: true, toolsV3: true },
  });
  assert.deepStrictEqual(report.sections.map((section) => section.id), [
    'service', 'bridge', 'compat', 'plugins',
  ]);
  assert.deepStrictEqual(report.alerts, []);
  assert.ok(report.summary.includes('running'), report.summary);
  assert.ok(report.summary.includes('listening'), report.summary);
  assert.ok(report.summary.includes('1/2'), report.summary);
  const server = report.sections[0].items[0];
  assert.strictEqual(server.severity, 'ok');
  assert.strictEqual(server.detail, 'http://127.0.0.1:3080 (owned)');
  const compat = report.sections[2].items[0];
  assert.ok(compat.detail.startsWith('0.3.1 (patch=yes, theme=yes, toolsV3=yes)'), compat.detail);
  assert.ok(report.json.snapshot === HEALTHY_SNAPSHOT);
  assert.strictEqual(report.json.compat.dshVersion, '0.3.1');
});

test('buildDiagnoseReport renders runtime issues in the compat section when known', () => {
  const report = buildDiagnoseReport({
    snapshot: HEALTHY_SNAPSHOT,
    hostVersion: '1.106.0',
    hostCapabilities: { chatParticipant: true, lmProvider: true, mcpServerDefinitions: true },
    compat: { dshVersion: '0.1.1-rc.2', patchOverlay: true, themeParam: true, toolsV3: true },
    runtimeIssues: {
      known: true, supported: true, exportDoublePrefix: true,
      sparseProjectionTitles: true, moduleHmrWindowCrash: true,
    },
  });
  const compatItems = report.sections.find((section) => section.id === 'compat').items;
  assert.strictEqual(compatItems.length, 2);
  const issues = compatItems[1];
  assert.strictEqual(issues.label, 'runtime issues');
  assert.strictEqual(issues.severity, 'info');
  assert.strictEqual(
    issues.detail,
    'supported=yes, exportDoublePrefix=yes, sparseTitles=yes, moduleHmrWindowCrash=yes',
    issues.detail,
  );
  assert.ok(issues.hint.includes('0.1.2-alpha.1'), issues.hint);
  assert.deepStrictEqual(report.json.compat.runtimeIssues, {
    supported: true, exportDoublePrefix: true,
    sparseProjectionTitles: true, moduleHmrWindowCrash: true,
  });
});

test('buildDiagnoseReport omits runtime issues when unknown and warns when unsupported', () => {
  const unknown = buildDiagnoseReport({
    snapshot: HEALTHY_SNAPSHOT,
    compat: { dshVersion: 'unknown' },
    runtimeIssues: {
      known: false, supported: false, exportDoublePrefix: false,
      sparseProjectionTitles: false, moduleHmrWindowCrash: false,
    },
  });
  const unknownItems = unknown.sections.find((section) => section.id === 'compat').items;
  assert.strictEqual(unknownItems.length, 1);
  assert.strictEqual(unknown.json.compat.runtimeIssues, null);

  const unsupported = buildDiagnoseReport({
    snapshot: HEALTHY_SNAPSHOT,
    compat: { dshVersion: '0.1.0-rc.6' },
    runtimeIssues: {
      known: true, supported: false, exportDoublePrefix: true,
      sparseProjectionTitles: true, moduleHmrWindowCrash: true,
    },
  });
  const unsupportedItem = unsupported.sections.find((section) => section.id === 'compat').items[1];
  assert.strictEqual(unsupportedItem.severity, 'warn');
});

test('buildDiagnoseReport alerts: server down, bridge closed, actions attached', () => {
  const report = buildDiagnoseReport({
    snapshot: {
      providers: [],
      dshPlugins: {},
      home: {},
      server: { available: false },
      bridge: { listening: false },
    },
  });
  assert.deepStrictEqual(report.alerts.map((alert) => alert.id), ['server-down', 'bridge-closed']);
  assert.deepStrictEqual(report.alerts[0].action, { command: 'dsh.restartServer' });
  assert.deepStrictEqual(report.alerts[1].action, { command: 'workbench.action.reloadWindow' });
  assert.strictEqual(report.sections[report.sections.length - 1].id, 'alerts');
  assert.strictEqual(report.alerts[0].severity, 'error');
});

test('buildDiagnoseReport warns on a WSL default terminal on win32 only', () => {
  const wsl = buildDiagnoseReport({
    snapshot: HEALTHY_SNAPSHOT,
    defaultTerminalProfile: 'Ubuntu (WSL)',
    platform: 'win32',
  });
  assert.strictEqual(wsl.alerts.some((alert) => alert.id === 'wsl-default-terminal'), true);
  const wslAlert = wsl.alerts.find((alert) => alert.id === 'wsl-default-terminal');
  assert.ok(wslAlert.text.includes('Ubuntu (WSL)'), wslAlert.text);
  assert.deepStrictEqual(wslAlert.action, { command: 'workbench.action.openSettings', args: ['terminal.integrated.defaultProfile.windows'] });

  const posix = buildDiagnoseReport({
    snapshot: HEALTHY_SNAPSHOT,
    defaultTerminalProfile: 'Ubuntu (WSL)',
    platform: 'linux',
  });
  assert.strictEqual(posix.alerts.some((alert) => alert.id === 'wsl-default-terminal'), false);

  const pwsh = buildDiagnoseReport({
    snapshot: HEALTHY_SNAPSHOT,
    defaultTerminalProfile: 'PowerShell',
    platform: 'win32',
  });
  assert.strictEqual(pwsh.alerts.some((alert) => alert.id === 'wsl-default-terminal'), false);
});

test('buildDiagnoseReport humanizes feature failures and self-heal events', () => {
  const report = buildDiagnoseReport({
    snapshot: HEALTHY_SNAPSHOT,
    featureFailures: [{ id: 'chat-participant', error: { code: 'BRIDGE_INIT_TIMEOUT', message: 'bridge timed out' }, at: 1 }],
    selfHealCount: 2,
  });
  const featureAlert = report.alerts.find((alert) => alert.id === 'feature-chat-participant');
  assert.ok(featureAlert.text.includes('chat-participant'), featureAlert.text);
  assert.strictEqual(featureAlert.hint, 'Restart DSH or reload the VS Code window.');
  assert.strictEqual(report.alerts[report.alerts.length - 1].id, 'self-heal');
});

test('buildDiagnoseQuickPickItems emits separators, severity prefixes and joined details', () => {
  const report = buildDiagnoseReport({
    snapshot: {
      providers: [],
      dshPlugins: {},
      home: {},
      server: { available: false },
      bridge: { listening: false },
    },
  });
  const items = buildDiagnoseQuickPickItems(report);
  assert.strictEqual(items[0].separator, true);
  assert.strictEqual(items[0].label, 'Service');
  const serverEntry = items[1];
  assert.strictEqual(serverEntry.separator, false);
  assert.strictEqual(serverEntry.label, '$(error) server');
  assert.strictEqual(serverEntry.detail, 'stopped');
  const alertEntry = items.find((item) => item.action && item.action.command === 'dsh.restartServer');
  assert.ok(alertEntry, 'the alerts section carries the restart action');
  assert.ok(alertEntry.detail.includes('Restart DSH Server'), alertEntry.detail);
  assert.strictEqual(serverEntry.action, null, 'section rows carry no action; actions live on alerts');
  assert.ok(items.some((item) => item.separator && item.label === 'Alerts'));
});

test('showDiagnoseQuickPick degrades to null without createQuickPick', async () => {
  const report = buildDiagnoseReport({ snapshot: HEALTHY_SNAPSHOT });
  assert.strictEqual(await showDiagnoseQuickPick({ window: {} }, report), null);
});

test('showDiagnoseQuickPick populates the picker and maps picks to actions', async () => {
  const report = buildDiagnoseReport({
    snapshot: {
      providers: [],
      dshPlugins: {},
      home: {},
      server: { available: false },
      bridge: { listening: true, port: 1 },
    },
  });
  const shown = [];
  const pick = {
    canPickMany: null,
    items: null,
    placeholder: '',
    selectedItems: [],
    show() { shown.push(true); },
    dispose() {},
    onDidAccept(listener) { this._accept = listener; },
    onDidHide(listener) { this._hide = listener; },
  };
  const vscodeFake = {
    QuickPickItemKind: { Separator: 3 },
    window: { createQuickPick: () => pick },
  };
  const promise = showDiagnoseQuickPick(vscodeFake, report);
  assert.strictEqual(pick.canPickMany, false);
  assert.ok(Array.isArray(pick.items) && pick.items.length > 0);
  assert.ok(pick.items.some((item) => item.kind === 3), 'separators use QuickPickItemKind when available');
  assert.strictEqual(shown.length, 1);
  // Pick the server-down alert entry (first alerts-section pickable).
  pick.selectedItems = [pick.items[pick.items.length - 1]];
  pick._accept();
  const picked = await promise;
  assert.ok(picked && picked.action);
  assert.strictEqual(picked.action.command, 'dsh.restartServer');
});
