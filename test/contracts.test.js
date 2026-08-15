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
