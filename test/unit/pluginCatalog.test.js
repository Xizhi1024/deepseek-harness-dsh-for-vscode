'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PLUGIN_CATALOG,
  byCapability,
  byPackage,
  catalogRevision,
  catalogSnapshot,
  entriesForCategory,
} = require('../../src/catalog/pluginCatalog');

const EXPECTED_CATEGORY_IDS = ['core', 'ai-cap', 'editor', 'context', 'security', 'ops-ui', 'external'];
const EXPECTED_ENTRY_IDS = [
  'mcp-manager',
  'skill-manager',
  'plugin-marketplace',
  'at-file',
  'git',
  'test',
  'checkpoint',
];

test('plugin catalog exposes seven categories and seven entries, deeply frozen', () => {
  assert.deepStrictEqual(PLUGIN_CATALOG.categories.map((category) => category.id), EXPECTED_CATEGORY_IDS);
  assert.deepStrictEqual(PLUGIN_CATALOG.entries.map((entry) => entry.id), EXPECTED_ENTRY_IDS);
  assert.ok(Object.isFrozen(PLUGIN_CATALOG));
  assert.ok(Object.isFrozen(PLUGIN_CATALOG.categories));
  assert.ok(Object.isFrozen(PLUGIN_CATALOG.entries));
  for (const entry of PLUGIN_CATALOG.entries) {
    assert.ok(Object.isFrozen(entry));
    assert.ok(Object.isFrozen(entry.packageIds));
    assert.ok(Object.isFrozen(entry.capabilities));
    assert.ok(Object.isFrozen(entry.probe));
  }
});

test('catalogSnapshot returns a defensive deep-frozen copy', () => {
  const snapshot = catalogSnapshot();
  assert.notStrictEqual(snapshot, PLUGIN_CATALOG);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.entries));
  assert.notStrictEqual(snapshot.entries[0], PLUGIN_CATALOG.entries[0]);
  assert.ok(Object.isFrozen(snapshot.entries[0].packageIds));
});

test('byCapability finds entries that provide the capability', () => {
  assert.deepStrictEqual(byCapability('mcp.consume').map((entry) => entry.id), ['mcp-manager']);
  assert.deepStrictEqual(byCapability('session.checkpoint').map((entry) => entry.id), ['checkpoint']);
  assert.deepStrictEqual(byCapability('missing.capability'), []);
  assert.deepStrictEqual(byCapability(42), []);
});

test('byPackage finds entries that reference a verified package id', () => {
  assert.deepStrictEqual(byPackage('dsh-mcp-manager').map((entry) => entry.id), ['mcp-manager']);
  assert.deepStrictEqual(byPackage('dshmarket').map((entry) => entry.id), ['plugin-marketplace']);
  assert.deepStrictEqual(byPackage('@deepseek-ai/dsh-session-checkpoint-policy').map((entry) => entry.id), ['checkpoint']);
  assert.deepStrictEqual(byPackage('not-a-package'), []);
});

test('entriesForCategory returns only entries in the requested category', () => {
  assert.deepStrictEqual(entriesForCategory('ai-cap').map((entry) => entry.id), ['mcp-manager', 'skill-manager']);
  assert.deepStrictEqual(entriesForCategory('editor').map((entry) => entry.id), ['git', 'test']);
  assert.deepStrictEqual(entriesForCategory('unknown'), []);
});

test('catalogRevision is stable and matches the snapshot revision', () => {
  const first = catalogRevision();
  const second = catalogRevision();
  assert.strictEqual(first, second);
  assert.strictEqual(first, catalogSnapshot().revision);
  assert.match(first, /^[a-f0-9]{64}$/);
});

test('verified package ids are present and unverified git package list is empty', () => {
  const mcp = PLUGIN_CATALOG.entries.find((entry) => entry.id === 'mcp-manager');
  const git = PLUGIN_CATALOG.entries.find((entry) => entry.id === 'git');
  assert.deepStrictEqual(mcp.packageIds, ['dsh-mcp-manager']);
  assert.deepStrictEqual(git.packageIds, []);
});
