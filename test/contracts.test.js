'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const manifest = require('../package.json');
const { CONTAINER_ID, VIEW_ID } = require('../src/types');
const { FEATURE_CATALOG } = require('../src/extension');

test('published sidebar and Webview IDs remain stable across manifest and runtime', () => {
  assert.strictEqual(CONTAINER_ID, 'dsh-sidebar');
  assert.strictEqual(VIEW_ID, 'dsh.webview');

  const containers = manifest.contributes.viewsContainers.secondarySidebar;
  assert.deepStrictEqual(containers.map((entry) => entry.id), [CONTAINER_ID]);
  assert.ok(Object.hasOwn(manifest.contributes.views, CONTAINER_ID));
  assert.deepStrictEqual(
    manifest.contributes.views[CONTAINER_ID].map((entry) => entry.id),
    [VIEW_ID]
  );
  assert.ok(manifest.activationEvents.includes(`onView:${VIEW_ID}`));
  assert.ok(manifest.activationEvents.includes('onCommand:dsh.addFileToThread'));
});

test('editor title exposes one persistent icon and DSH view title exposes no primary actions', () => {
  const menus = manifest.contributes.menus;
  assert.deepStrictEqual(menus['editor/title'], [
    {
      command: 'dsh.focusSidebar',
      group: 'navigation@40'
    }
  ]);
  assert.ok(!Object.hasOwn(menus, 'view/title'));
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
  }]);
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
    'dsh.cleanupOrphans',
    'dsh.diagnose',
    'dsh.focusSidebar',
    'dsh.newSession',
    'dsh.openInBrowser',
    'dsh.restartServer',
    'dsh.restartClean',
    'dsh.stopServer',
    'dsh.switchSession',
  ].sort();
  assert.deepStrictEqual(smokeExpected, contributed);
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
});
