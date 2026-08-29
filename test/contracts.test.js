'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const manifest = require('../package.json');
const { CONTAINER_ID, VIEW_ID } = require('../src/types');
const { FEATURE_CATALOG } = require('../src/extension');
const { METHODS_V3 } = require('../src/protocol/ch1');

test('published sidebar and Webview IDs remain stable across manifest and runtime', () => {
  assert.strictEqual(CONTAINER_ID, 'dsh-sidebar');
  assert.strictEqual(VIEW_ID, 'dsh.webview');

  const containers = manifest.contributes.viewsContainers.secondarySidebar;
  assert.deepStrictEqual(containers.map((entry) => entry.id), [CONTAINER_ID]);
  assert.ok(Object.hasOwn(manifest.contributes.views, CONTAINER_ID));
  assert.deepStrictEqual(
    manifest.contributes.views[CONTAINER_ID].map((entry) => entry.id),
    [VIEW_ID, 'dsh.changes']
  );
  assert.ok(manifest.activationEvents.includes(`onView:${VIEW_ID}`));
  assert.ok(manifest.activationEvents.includes('onView:dsh.changes'));
  assert.ok(manifest.activationEvents.includes('onCommand:dsh.addFileToThread'));
  assert.ok(manifest.activationEvents.includes('onCommand:dsh.ctrlIEdit'));
});

test('editor title exposes one persistent icon and DSH view title exposes only the gated instance entry', () => {
  const menus = manifest.contributes.menus;
  assert.deepStrictEqual(menus['editor/title'], [
    {
      command: 'dsh.focusSidebar',
      group: 'navigation@40'
    }
  ]);
  assert.deepStrictEqual(menus['view/title'], [{
    command: 'dsh.newInstance',
    when: 'config.dsh.multiInstance.entry && view == dsh.webview',
    group: 'navigation@10'
  }, {
    command: 'dsh.changes.refresh',
    when: 'view == dsh.changes',
    group: 'navigation@1'
  }]);
  // F-c: terminal-state entries (undone/discarded/accepted) no longer offer
  // actions that would only fail — Accept is limited to pending/legacy, Undo
  // to pending/accepted, openDiff stays available for every entry state.
  assert.deepStrictEqual(menus['view/item/context'], [{
    command: 'dsh.changes.openDiff',
    when: 'view == dsh.changes && viewItem =~ /^dsh\\.changes\\.entry/',
    group: 'inline@1'
  }, {
    command: 'dsh.changes.accept',
    when: 'view == dsh.changes && viewItem =~ /^dsh\\.changes\\.entry\\.(pending|legacy)$/',
    group: 'inline@2'
  }, {
    command: 'dsh.changes.undo',
    when: 'view == dsh.changes && viewItem =~ /^dsh\\.changes\\.entry\\.(pending|accepted)$/',
    group: 'inline@3'
  }]);
  assert.deepStrictEqual(menus['editor/context'], [{
    command: 'dsh.addFileToThread',
    when: 'resourceScheme == file',
    group: 'dsh@1'
  }, {
    command: 'dsh.addSelectionToThread',
    when: 'editorHasSelection && resourceScheme == file',
    group: 'dsh@10'
  }]);

  assert.deepStrictEqual(manifest.contributes.keybindings, [{
    command: 'dsh.focusSidebar',
    key: 'ctrl+alt+b',
    when: '!terminalFocus'
  }, {
    command: 'dsh.newInstance',
    key: 'ctrl+alt+n',
    mac: 'cmd+alt+n',
    when: '!terminalFocus'
  }, {
    command: 'dsh.addSelectionToThread',
    key: 'ctrl+l',
    mac: 'cmd+l',
    when: 'config.dsh.keybindings.ctrlL && editorTextFocus'
  }, {
    command: 'dsh.ctrlKEdit',
    key: 'ctrl+k',
    mac: 'cmd+k',
    when: 'config.dsh.features.ctrl-k && editorTextFocus'
  }]);

  // A5/U6: the changes tree has welcome content for its empty state.
  const changesWelcome = (manifest.contributes.viewsWelcome || []).find(
    (entry) => entry.view === 'dsh.changes'
  );
  assert.ok(changesWelcome, 'dsh.changes must contribute viewsWelcome content');
  assert.strictEqual(typeof changesWelcome.contents, 'string');
  assert.ok(changesWelcome.contents.startsWith('%') && changesWelcome.contents.endsWith('%'),
    'viewsWelcome contents must go through the nls %key% mechanism');

  // A7/U13: the new-instance entry is on by default.
  assert.strictEqual(
    manifest.contributes.configuration.properties['dsh.multiInstance.entry'].default,
    true,
    'dsh.multiInstance.entry defaults to true (U13)'
  );
  // B5/U3 supersedes the D8 verdict: Ctrl+K stays opt-in, but enabling the
  // feature must be the single interaction that also activates the key. The
  // binding is contributed once, permanently gated by a config when-clause —
  // opt-in is guaranteed by the gate (default false), not by absence.
  const ctrlKBinding = manifest.contributes.keybindings.find(
    (entry) => entry.command === 'dsh.ctrlKEdit'
  );
  assert.ok(ctrlKBinding, 'B5: dsh.ctrlKEdit must contribute a when-gated Ctrl+K keybinding');
  assert.strictEqual(ctrlKBinding.key, 'ctrl+k');
  assert.strictEqual(
    ctrlKBinding.when,
    'config.dsh.features.ctrl-k && editorTextFocus',
    'opt-in contract: the Ctrl+K binding must stay gated behind config.dsh.features.ctrl-k'
  );
  assert.strictEqual(
    manifest.contributes.configuration.properties['dsh.features.ctrl-k'].default,
    false,
    'ctrl-k remains opt-in (default off); the when-clause keeps the binding inert until enabled'
  );
  // B5/U3: Ctrl+L defaults to on — low risk, it only adds the selection as a
  // draft to the conversation and never sends anything by itself.
  assert.strictEqual(
    manifest.contributes.configuration.properties['dsh.keybindings.ctrlL'].default,
    true,
    'B5/U3: dsh.keybindings.ctrlL defaults to true'
  );
  assert.ok(
    !manifest.contributes.keybindings.some((entry) => entry.command === 'dsh.ctrlIEdit'),
    'E-asm-1 verdict: Ctrl+I must not contribute a default keybinding'
  );
  assert.ok(
    !manifest.contributes.keybindings.some((entry) => entry.command === 'dsh.openSessionHistory'),
    'dsh.openSessionHistory must not contribute a default keybinding'
  );
  assert.ok(
    !manifest.contributes.keybindings.some((entry) => entry.command === 'dsh.fim.setApiKey'),
    'dsh.fim.setApiKey must not contribute a default keybinding'
  );
  assert.deepStrictEqual(menus['editor/title/context'], [{
    command: 'dsh.addFileToThread',
    group: 'dsh@1',
    when: 'resourceScheme == file'
  }]);
  assert.deepStrictEqual(menus['explorer/context'], [{
    command: 'dsh.addFileToThread',
    group: 'dsh@1',
    when: '!explorerResourceIsFolder && resourceScheme == file'
  }, {
    command: 'dsh.addFolderToThread',
    group: 'dsh@2',
    when: 'explorerResourceIsFolder && resourceScheme == file'
  }]);

  const focusCommand = manifest.contributes.commands.find(
    (entry) => entry.command === 'dsh.focusSidebar'
  );
  assert.deepStrictEqual(focusCommand.icon, {
    light: 'media/deepseek-light.svg',
    dark: 'media/deepseek-dark.svg'
  });

  const container = manifest.contributes.viewsContainers.secondarySidebar.find(
    (entry) => entry.id === CONTAINER_ID
  );
  assert.strictEqual(container.icon, 'media/deepseek.svg');
  assert.strictEqual(manifest.icon, 'media/deepseek.png');

  const commandIds = new Set(manifest.contributes.commands.map((entry) => entry.command));
  for (const command of [
    'dsh.addActiveFile',
    'dsh.addActiveSelection',
    'dsh.addSelectionToThread',
    'dsh.addFileToThread',
    'dsh.addProblems',
    'dsh.newSession',
    'dsh.switchSession',
    'dsh.capabilities',
    'dsh.diagnose'
  ]) {
    assert.ok(commandIds.has(command), `${command} remains available in the command palette`);
  }
});

test('extension-host smoke expectations cover every contributed command id', () => {
  const contributed = manifest.contributes.commands.map((entry) => entry.command).sort();
  const smokeExpected = [
    'dsh.addActiveFile',
    'dsh.addActiveSelection',
    'dsh.addFileToThread',
    'dsh.addFolderToThread',
    'dsh.addProblems',
    'dsh.addSelectionToThread',
    'dsh.capabilities',
    'dsh.changes.accept',
    'dsh.changes.focus',
    'dsh.changes.openDiff',
    'dsh.changes.refresh',
    'dsh.changes.undo',
    'dsh.cleanupOrphans',
    'dsh.ctrlIEdit',
    'dsh.ctrlKEdit',
    'dsh.diagnose',
    'dsh.focusSidebar',
    'dsh.mcp.forgetConsent',
    'dsh.mcp.refresh',
    'dsh.newSession',
    'dsh.openInBrowser',
    'dsh.openSessionHistory',
    'dsh.fim.setApiKey',
    'dsh.restartServer',
    'dsh.restartClean',
    'dsh.stopServer',
    'dsh.switchSession',
    'dsh.onboarding',
    'dsh.newInstance',
  ].sort();
  assert.deepStrictEqual(smokeExpected, contributed);
  const commandOrder = manifest.contributes.commands.map((entry) => entry.command);
  assert.ok(
    commandOrder.indexOf('dsh.ctrlIEdit') >= 0 && commandOrder.indexOf('dsh.ctrlKEdit') >= 0
      && commandOrder.indexOf('dsh.ctrlIEdit') < commandOrder.indexOf('dsh.ctrlKEdit'),
    'dsh.ctrlIEdit must be contributed before dsh.ctrlKEdit'
  );
  assert.ok(
    commandOrder.indexOf('dsh.openSessionHistory') === commandOrder.indexOf('dsh.switchSession') + 1,
    'dsh.openSessionHistory must be contributed immediately after dsh.switchSession'
  );
  assert.ok(
    commandOrder.indexOf('dsh.fim.setApiKey') === commandOrder.indexOf('dsh.mcp.refresh') + 1,
    'dsh.fim.setApiKey must be contributed immediately after dsh.mcp.refresh'
  );
});

test('dsh.features.* configuration keys mirror the featureRegistry catalog (L1/L2 present, L0 has none)', () => {
  const properties = manifest.contributes.configuration.properties;
  const featureConfigIds = Object.keys(properties)
    .filter((key) => key.startsWith('dsh.features.'))
    .map((key) => key.slice('dsh.features.'.length))
    .sort();
  const registeredL1L2 = FEATURE_CATALOG
    .filter((feature) => feature.layer !== 'L0')
    .map((feature) => feature.id)
    .sort();
  assert.deepStrictEqual(
    featureConfigIds,
    registeredL1L2,
    'every L1/L2 registry feature must have exactly one dsh.features.* contributes key'
  );

  for (const feature of FEATURE_CATALOG) {
    if (feature.layer === 'L0') {
      assert.ok(
        !Object.hasOwn(properties, 'dsh.features.' + feature.id),
        'L0 feature ' + feature.id + ' must not expose a dsh.features.* switch'
      );
      continue;
    }
    const entry = properties['dsh.features.' + feature.id];
    assert.ok(entry, 'L1/L2 feature ' + feature.id + ' must have a contributes key');
    assert.strictEqual(entry.type, 'boolean', feature.id + ' must be a boolean switch');
    assert.strictEqual(entry.default, feature.defaultEnabled, feature.id + ' default must match defaultEnabled');
  }
  assert.strictEqual(properties['dsh.features.call-export'].scope, 'machine', 'call-export must be machine-scoped');
  assert.strictEqual(properties['dsh.features.ctrl-i'].scope, 'machine', 'ctrl-i must be machine-scoped');
  assert.strictEqual(properties['dsh.features.exports'].scope, 'machine', 'exports must be machine-scoped');
});

test('CH1 v3 method table freezes 32 methods including extensions/callExport', () => {
  assert.strictEqual(METHODS_V3.length, 32);
  assert.ok(METHODS_V3.includes('vscode/extensions/callExport'));
});

test('R23 language-model chat provider contribution and routing config are frozen', () => {
  const providers = manifest.contributes.languageModelChatProviders;
  assert.deepStrictEqual(providers, [{ vendor: 'dsh', displayName: '%dsh.lm.vendor%' }]);
  assert.ok(manifest.activationEvents.includes('onLanguageModelChatProvider:dsh'));
  const properties = manifest.contributes.configuration.properties;
  assert.strictEqual(properties['dsh.lm.route'].default, 'off');
  assert.deepStrictEqual(properties['dsh.lm.route'].enum, ['off', 'fixed', 'dynamic']);
  assert.strictEqual(properties['dsh.features.lm-route'].default, false);
  assert.strictEqual(properties['dsh.features.lm-route'].type, 'boolean');
});

test('E-asm-2 chat participant contribution, activation events, and FIM config are frozen', () => {
  assert.deepStrictEqual(manifest.contributes.chatParticipants, [{
    id: 'dsh',
    name: '%dsh.participant.name%',
    description: '%dsh.participant.description%',
  }]);
  assert.ok(manifest.activationEvents.includes('onChatParticipant:dsh'));
  assert.ok(manifest.activationEvents.includes('onCommand:dsh.openSessionHistory'));
  assert.ok(manifest.activationEvents.includes('onCommand:dsh.fim.setApiKey'));

  const properties = manifest.contributes.configuration.properties;
  assert.strictEqual(properties['dsh.features.chat-participant'].type, 'boolean');
  assert.strictEqual(properties['dsh.features.chat-participant'].default, true);
  assert.strictEqual(properties['dsh.features.tab-completion'].type, 'boolean');
  assert.strictEqual(properties['dsh.features.tab-completion'].default, false);
  assert.strictEqual(properties['dsh.fim.model'].type, 'string');
  assert.strictEqual(properties['dsh.fim.model'].default, '');
  assert.strictEqual(properties['dsh.fim.model'].scope, 'machine');
  assert.ok(
    !Object.hasOwn(properties, 'dsh.fim.apiKey'),
    'dsh.fim.apiKey must never be contributed as a configuration key'
  );
  // 1.0.1: the DSH-side /api/fim route is owned by dsh-vscode-integration, so
  // the upstream endpoint moved into an extension-side machine-scoped setting
  // (injected into the DSH spawn env as DSH_FIM_BASE_URL). The API key stays
  // in VS Code secretStorage and must never become a configuration key.
  assert.ok(Object.hasOwn(properties, 'dsh.fim.baseUrl'), 'dsh.fim.baseUrl must be contributed since 1.0.1');
  assert.strictEqual(properties['dsh.fim.baseUrl'].type, 'string');
  assert.strictEqual(properties['dsh.fim.baseUrl'].default, '');
  assert.strictEqual(properties['dsh.fim.baseUrl'].scope, 'machine');
  assert.ok(!Object.hasOwn(properties, 'dsh.fim.api'), 'dsh.fim.api must not be contributed');
});
