'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { assertCatalog, catalogRevision } = require('../../src/catalog/catalogSchema');

function validCatalog() {
  return {
    revision: 'abc123',
    categories: [
      { id: 'core', label: 'Core', hard: true },
      { id: 'ai-cap', label: 'AI Capabilities', hard: false },
    ],
    entries: [
      {
        id: 'mcp-manager',
        category: 'ai-cap',
        packageIds: ['dsh-mcp-manager'],
        capabilities: ['mcp.consume', 'mcp.serve'],
        required: false,
        adapter: 'mcp-manager',
        fallback: '',
        probe: { inventory: true },
        integrationMode: 'manual-assist',
        compatibility: 'unknown',
        reason: 'interface audit pending (G3)',
      },
    ],
  };
}

test('assertCatalog accepts a valid catalog and accepts missing optional detailsUri', () => {
  const catalog = validCatalog();
  assert.doesNotThrow(() => assertCatalog(catalog));
  assert.strictEqual(catalog.detailsUri, undefined);
});

test('assertCatalog rejects a missing required field', () => {
  const catalog = validCatalog();
  delete catalog.entries[0].adapter;
  assert.throws(() => assertCatalog(catalog), TypeError);
});

test('assertCatalog rejects a wrong field type', () => {
  const catalog = validCatalog();
  catalog.entries[0].required = 'yes';
  assert.throws(() => assertCatalog(catalog), TypeError);
});

test('assertCatalog rejects an empty capabilities array', () => {
  const catalog = validCatalog();
  catalog.entries[0].capabilities = [];
  assert.throws(() => assertCatalog(catalog), TypeError);
});

test('assertCatalog rejects an invalid detailsUri when present', () => {
  const catalog = validCatalog();
  catalog.entries[0].detailsUri = 'http://example.com';
  assert.throws(() => assertCatalog(catalog), TypeError);
});

test('assertCatalog accepts a whitelisted detailsUri when present', () => {
  const catalog = validCatalog();
  catalog.entries[0].detailsUri = 'https://example.com/docs';
  assert.doesNotThrow(() => assertCatalog(catalog));
});

test('catalogRevision is a stable sha256 hex string', () => {
  const catalog = validCatalog();
  const first = catalogRevision(catalog);
  const second = catalogRevision(catalog);
  assert.strictEqual(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
});
