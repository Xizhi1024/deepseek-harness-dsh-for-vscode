'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { deriveVscodeCapabilities } = require('../../src/vscodeCapabilities');

test('vscodeCapabilities derives full snapshot for supported versions', () => {
  assert.deepStrictEqual(deriveVscodeCapabilities('1.106.0'), {
    chatParticipant: true,
    lmProvider: true,
    mcpServerDefinitions: true,
  });
  assert.deepStrictEqual(deriveVscodeCapabilities('1.125.0'), {
    chatParticipant: true,
    lmProvider: true,
    mcpServerDefinitions: true,
  });
});

test('vscodeCapabilities reports pre-chat and pre-lm versions as false', () => {
  assert.deepStrictEqual(deriveVscodeCapabilities('1.88.0'), {
    chatParticipant: false,
    lmProvider: false,
    mcpServerDefinitions: false,
  });
  assert.deepStrictEqual(deriveVscodeCapabilities('1.89.9'), {
    chatParticipant: false,
    lmProvider: false,
    mcpServerDefinitions: false,
  });
});

test('vscodeCapabilities honors each capability boundary inclusively', () => {
  assert.strictEqual(deriveVscodeCapabilities('1.89.9').chatParticipant, false);
  assert.strictEqual(deriveVscodeCapabilities('1.90.0').chatParticipant, true);

  assert.strictEqual(deriveVscodeCapabilities('1.103.9').lmProvider, false);
  assert.strictEqual(deriveVscodeCapabilities('1.104.0').lmProvider, true);

  assert.strictEqual(deriveVscodeCapabilities('1.104.9').mcpServerDefinitions, false);
  assert.strictEqual(deriveVscodeCapabilities('1.105.0').mcpServerDefinitions, true);
});

test('vscodeCapabilities tolerates build suffixes and two-part versions', () => {
  assert.deepStrictEqual(deriveVscodeCapabilities('1.106.0-insider'), {
    chatParticipant: true,
    lmProvider: true,
    mcpServerDefinitions: true,
  });
  assert.deepStrictEqual(deriveVscodeCapabilities('1.105'), {
    chatParticipant: true,
    lmProvider: true,
    mcpServerDefinitions: true,
  });
});

test('vscodeCapabilities degrades safely for invalid version strings', () => {
  const expected = {
    chatParticipant: false,
    lmProvider: false,
    mcpServerDefinitions: false,
  };
  assert.deepStrictEqual(deriveVscodeCapabilities(''), expected);
  assert.deepStrictEqual(deriveVscodeCapabilities('garbage'), expected);
  assert.deepStrictEqual(deriveVscodeCapabilities('1'), expected);
  assert.deepStrictEqual(deriveVscodeCapabilities('v1.106.0'), expected);
  assert.deepStrictEqual(deriveVscodeCapabilities(undefined), expected);
  assert.deepStrictEqual(deriveVscodeCapabilities(null), expected);
});
