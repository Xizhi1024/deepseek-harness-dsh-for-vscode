'use strict';

// runtimeConfig — the live bridge-config store (known-issue #1 fix): env
// bootstrap, configure-patch merge semantics, validation rejections.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyConfigurePatch,
  createRuntimeConfig,
  usableToken,
} from '../lib/runtimeConfig.js';

test('createRuntimeConfig bootstraps from the spawn env', () => {
  const config = createRuntimeConfig({
    env: {
      DSH_LM_BRIDGE_TOKEN: ' lm-tok ', // trimmed
      DSH_FIM_BRIDGE_TOKEN: 'fim-tok',
      DSH_FIM_BASE_URL: 'https://api.example.com/beta/completions',
      DSH_FIM_API_KEY: 'sk-test',
      DSH_FIM_MAX_TOKENS: '64',
      DSH_VSCODE_OPEN_URL: 'http://127.0.0.1:9/open',
      DSH_VSCODE_OPEN_TOKEN: 'open-tok', // allow-secret-scan (test fixture)
      DSH_VSCODE_CONFIGURE_TOKEN: 'cfg-tok',
    },
  });
  assert.ok(config.lm.tokens.has('lm-tok'));
  assert.ok(config.fim.tokens.has('fim-tok'));
  assert.strictEqual(config.fim.baseUrl, 'https://api.example.com/beta/completions');
  assert.strictEqual(config.fim.apiKey, 'sk-test');
  assert.strictEqual(config.fim.maxTokens, 64);
  assert.deepStrictEqual(config.links, { openUrl: 'http://127.0.0.1:9/open', openToken: 'open-tok' });
  assert.strictEqual(config.configureToken, 'cfg-tok');
});

test('createRuntimeConfig degrades to empty store on absent env', () => {
  const config = createRuntimeConfig({ env: {} });
  assert.strictEqual(config.lm.tokens.size, 0);
  assert.strictEqual(config.fim.tokens.size, 0);
  assert.strictEqual(config.links, null);
  assert.strictEqual(config.configureToken, '');
});

test('applyConfigure merges fim/lm tokens (upsert) and replaces scalars', () => {
  const config = createRuntimeConfig({ env: { DSH_LM_BRIDGE_TOKEN: 'lm-a', DSH_FIM_BRIDGE_TOKEN: 'fim-a' } });
  const result = config.applyConfigure({
    fim: { addTokens: ['fim-b'], baseUrl: 'https://x/y', apiKey: 'k', template: 'P{prefix}S', maxTokens: 32 },
    lm: { addTokens: ['lm-b'] },
  });
  assert.deepStrictEqual([...config.fim.tokens].sort(), ['fim-a', 'fim-b']);
  assert.deepStrictEqual([...config.lm.tokens].sort(), ['fim-a'.replace('fim', 'lm'), 'lm-b'].sort());
  assert.strictEqual(config.fim.baseUrl, 'https://x/y');
  assert.strictEqual(config.fim.apiKey, 'k');
  assert.strictEqual(config.fim.template, 'P{prefix}S');
  assert.strictEqual(config.fim.maxTokens, 32);
  assert.strictEqual(result.applied.fim.tokensAdded, 1);
  assert.strictEqual(result.applied.lm.tokensAdded, 1);
  // Re-adding an existing token is a no-op, not an error.
  const again = config.applyConfigure({ fim: { addTokens: ['fim-a'] } });
  assert.strictEqual(again.applied.fim.tokensAdded, 0);
});

test('applyConfigure editorLinks replaces and null disables', () => {
  const config = createRuntimeConfig({ env: {} });
  config.applyConfigure({ editorLinks: { openUrl: 'http://127.0.0.1:1/a', openToken: 't' } });
  assert.deepStrictEqual(config.links, { openUrl: 'http://127.0.0.1:1/a', openToken: 't' });
  config.applyConfigure({ editorLinks: { openUrl: 'http://127.0.0.1:2/b', openToken: 'u' } });
  assert.deepStrictEqual(config.links, { openUrl: 'http://127.0.0.1:2/b', openToken: 'u' });
  const disabled = config.applyConfigure({ editorLinks: null });
  assert.strictEqual(config.links, null);
  assert.deepStrictEqual(disabled.applied.editorLinks, { disabled: true });
});

test('applyConfigure rejects malformed patches before mutating anything', () => {
  const config = createRuntimeConfig({ env: { DSH_FIM_BRIDGE_TOKEN: 'fim-a' } });
  assert.throws(() => config.applyConfigure('nope'), TypeError);
  assert.throws(() => config.applyConfigure({ nope: 1 }), /unknown configure field/);
  assert.throws(() => config.applyConfigure({ fim: { nope: 1 } }), /unknown fim patch field/);
  assert.throws(() => config.applyConfigure({ fim: { addTokens: [''] } }), /addTokens/);
  assert.throws(() => config.applyConfigure({ fim: { template: 'no-placeholder' } }), /template/);
  assert.throws(() => config.applyConfigure({ fim: { maxTokens: 0 } }), /maxTokens/);
  assert.throws(() => config.applyConfigure({ editorLinks: { openUrl: 'http://x', openToken: '' } }), /editorLinks/);
  // Nothing above mutated the store.
  assert.deepStrictEqual([...config.fim.tokens], ['fim-a']);
});

test('applyConfigure fim/lm null clears the token sets', () => {
  const config = createRuntimeConfig({ env: { DSH_LM_BRIDGE_TOKEN: 'lm-a', DSH_FIM_BRIDGE_TOKEN: 'fim-a' } });
  config.applyConfigure({ fim: null, lm: null });
  assert.strictEqual(config.fim.tokens.size, 0);
  assert.strictEqual(config.lm.tokens.size, 0);
});

test('applyConfigure() with no patch returns the current state snapshot; {} applies nothing', () => {
  const config = createRuntimeConfig({ env: { DSH_LM_BRIDGE_TOKEN: 'lm-a' } });
  const snapshot = config.applyConfigure();
  assert.strictEqual(snapshot.applied.fim.tokens, 0);
  assert.strictEqual(snapshot.applied.lm.tokens, 1);
  assert.strictEqual(snapshot.applied.editorLinks.enabled, false);
  const noop = config.applyConfigure({});
  assert.strictEqual(noop.applied.fim, null);
  assert.strictEqual(noop.applied.lm, null);
  assert.strictEqual(noop.applied.editorLinks, null);
});

test('usableToken bounds and trims', () => {
  assert.strictEqual(usableToken('  abc  '), 'abc');
  assert.strictEqual(usableToken(''), null);
  assert.strictEqual(usableToken('   '), null);
  assert.strictEqual(usableToken('x'.repeat(513)), null);
  assert.strictEqual(usableToken(42), null);
});

test('applyConfigurePatch is exported for direct use on a plain store shape', () => {
  const config = createRuntimeConfig({ env: {} });
  assert.deepStrictEqual(applyConfigurePatch(config, undefined).applied.fim.tokens, 0);
});
