'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const manifest = require('../package.json');
const { CONTAINER_ID, VIEW_ID } = require('../src/types');

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

  const focusCommand = manifest.contributes.commands.find(
    (entry) => entry.command === 'dsh.focusSidebar'
  );
  assert.strictEqual(focusCommand.icon, 'media/deepseek.svg');

  const container = manifest.contributes.viewsContainers.secondarySidebar.find(
    (entry) => entry.id === CONTAINER_ID
  );
  assert.strictEqual(container.icon, 'media/deepseek.svg');
  assert.strictEqual(manifest.icon, 'media/deepseek.png');

  const commandIds = new Set(manifest.contributes.commands.map((entry) => entry.command));
  for (const command of [
    'dsh.addActiveFile',
    'dsh.addActiveSelection',
    'dsh.addProblems',
    'dsh.newSession',
    'dsh.switchSession',
    'dsh.capabilities',
    'dsh.diagnose'
  ]) {
    assert.ok(commandIds.has(command), `${command} remains available in the command palette`);
  }
});
