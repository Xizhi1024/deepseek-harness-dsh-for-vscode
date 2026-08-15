'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PROVIDER_CATALOG,
  catalogRevision,
  catalogSnapshot,
  isAllowedDetailsUri,
  resolveProvider,
} = require('../src/capabilityCatalog');

const EXPECTED_PROVIDER_IDS = [
  'ms-vscode-remote.remote-wsl',
  'ms-vscode-remote.remote-ssh',
  'GitHub.vscode-pull-request-github',
  'browser-provider-placeholder',
];

test('catalog is a frozen four-entry framework with the controlled shape', () => {
  assert.ok(Array.isArray(PROVIDER_CATALOG));
  assert.strictEqual(PROVIDER_CATALOG.length, 4);
  assert.deepStrictEqual(PROVIDER_CATALOG.map((entry) => entry.providerId), EXPECTED_PROVIDER_IDS);
  assert.ok(Object.isFrozen(PROVIDER_CATALOG));

  for (const entry of PROVIDER_CATALOG) {
    assert.ok(Object.isFrozen(entry), `${entry.providerId} entry must be frozen`);
    assert.ok(Object.isFrozen(entry.capabilityIds), `${entry.providerId} capabilityIds must be frozen`);
    for (const field of [
      'providerId',
      'displayName',
      'publisher',
      'detailsUri',
      'capabilityIds',
      'providerKind',
      'integrationMode',
    ]) {
      assert.ok(entry[field] !== undefined, `${entry.providerId} must include ${field}`);
    }
    assert.ok(Array.isArray(entry.capabilityIds) && entry.capabilityIds.length > 0);
    assert.ok(isAllowedDetailsUri(entry.detailsUri), `${entry.providerId} detailsUri must be whitelisted`);
  }
});

test('detailsUri whitelist accepts only https and controlled vscode:extension URIs', () => {
  assert.strictEqual(isAllowedDetailsUri('https://playwright.dev/docs/'), true);
  assert.strictEqual(isAllowedDetailsUri('vscode:extension/GitHub.vscode-pull-request-github'), true);
  assert.strictEqual(isAllowedDetailsUri('vscode:extension/ms-vscode-remote.remote-wsl'), true);

  assert.strictEqual(isAllowedDetailsUri('http://example.com'), false);
  assert.strictEqual(isAllowedDetailsUri('https://'), false);
  assert.strictEqual(isAllowedDetailsUri('vscode:extension/not-a-valid-id'), false);
  assert.strictEqual(isAllowedDetailsUri('vscode:extension/GitHub.vscode-pull-request-github/path'), false);
  assert.strictEqual(isAllowedDetailsUri('vscode:extension/GitHub.vscode-pull-request-github?x=1'), false);
  assert.strictEqual(isAllowedDetailsUri('file:///tmp/provider'), false);
  assert.strictEqual(isAllowedDetailsUri('javascript:alert(1)'), false);
  assert.strictEqual(isAllowedDetailsUri(''), false);
  assert.strictEqual(isAllowedDetailsUri(42), false);
});

test('all W4 framework entries are manual-assist with the G3 audit reason', () => {
  for (const entry of PROVIDER_CATALOG) {
    assert.strictEqual(entry.integrationMode, 'manual-assist', `${entry.providerId} must not be integrated`);
    assert.match(entry.reason, /interface audit pending \(G3\)/);
    assert.notStrictEqual(entry.compatibility, true);
  }
});

test('browser placeholder is a manual-assist browser entry with an official https detailsUri', () => {
  const browser = resolveProvider('browser-provider-placeholder');
  assert.ok(browser);
  assert.strictEqual(browser.providerKind, 'browser');
  assert.strictEqual(browser.integrationMode, 'manual-assist');
  assert.ok(browser.detailsUri.startsWith('https://'));
  assert.ok(isAllowedDetailsUri(browser.detailsUri));
});

test('resolveProvider returns frozen copies for known ids and null for unknown ids', () => {
  const entry = resolveProvider('ms-vscode-remote.remote-wsl');
  assert.ok(entry);
  assert.strictEqual(entry.providerId, 'ms-vscode-remote.remote-wsl');
  assert.ok(Object.isFrozen(entry));
  assert.ok(Object.isFrozen(entry.capabilityIds));

  assert.strictEqual(resolveProvider('unknown.provider'), null);
  assert.strictEqual(resolveProvider(''), null);
  assert.strictEqual(resolveProvider(undefined), null);
});

test('catalogSnapshot returns a defensive frozen copy of the catalog', () => {
  const snapshot = catalogSnapshot();
  assert.ok(Array.isArray(snapshot));
  assert.strictEqual(snapshot.length, PROVIDER_CATALOG.length);
  assert.notStrictEqual(snapshot, PROVIDER_CATALOG);
  assert.ok(Object.isFrozen(snapshot));
  for (const entry of snapshot) {
    assert.ok(Object.isFrozen(entry));
    assert.ok(Object.isFrozen(entry.capabilityIds));
    assert.notStrictEqual(entry, PROVIDER_CATALOG.find((candidate) => candidate.providerId === entry.providerId));
  }
});

test('catalogRevision is stable while catalog content is unchanged', () => {
  const first = catalogRevision();
  const second = catalogRevision();
  assert.strictEqual(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
});
