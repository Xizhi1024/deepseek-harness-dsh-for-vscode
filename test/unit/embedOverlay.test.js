'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  CLEAN_OVERLAY_FILENAME,
  EMBED_DISABLED_PLUGIN_IDS,
  EMBED_INTEGRATION_PACKAGE,
  EMBED_INTEGRATION_PLUGIN_ID,
  extractPatchEntryIds,
  isEmbedPluginId,
  isOfficialPluginId,
  renderCleanOverlay,
  writeCleanOverlay,
} = require('../../src/embedOverlay');

const SAMPLE_PATCH = [
  '# profile patch',
  '- id: @deepseek-ai/official-plugin',
  '  config: stays untouched',
  '- id: live-stats',
  '  disabled: true',
  '',
  '- id: pet',
  '  disabled: true',
  '',
  '- id: ui-dsh-aionui-panel',
  '  disabled: true',
  '',
  '- id: dsh-plugin-marketplace',
  '  disabled: true',
].join('\n');

test('clean overlay classifies official/embed vs third-party patch entries', () => {
  assert.strictEqual(isOfficialPluginId('@deepseek-ai/dsh'), true);
  assert.strictEqual(isOfficialPluginId('dsh-tool'), false);
  assert.strictEqual(isEmbedPluginId('better-sidebar'), true);
  assert.strictEqual(isEmbedPluginId('ui-dsh-aionui-panel'), true);
  assert.strictEqual(isEmbedPluginId(EMBED_INTEGRATION_PLUGIN_ID), true);
  assert.strictEqual(isEmbedPluginId('live-stats'), false);

  assert.deepStrictEqual(extractPatchEntryIds(SAMPLE_PATCH), [
    '@deepseek-ai/official-plugin',
    'live-stats',
    'pet',
    'ui-dsh-aionui-panel',
    'dsh-plugin-marketplace',
  ]);
});

test('renderCleanOverlay disables third-party entries and preserves embed rows', () => {
  const rendered = renderCleanOverlay(SAMPLE_PATCH);
  assert.strictEqual(rendered.endsWith('\n'), true);

  // Official plugin ids are never disabled by the clean overlay.
  assert.strictEqual(rendered.includes('@deepseek-ai/official-plugin'), false);

  // Third-party entries are forced disabled.
  for (const id of ['live-stats', 'pet', 'dsh-plugin-marketplace']) {
    assert.strictEqual(rendered.includes(`- id: ${id}\n  disabled: true`), true, `${id} must be disabled`);
  }

  // The existing embed rows are re-emitted (sidebar/AION disabled, integration inserted).
  for (const id of EMBED_DISABLED_PLUGIN_IDS) {
    assert.strictEqual(rendered.includes(`- id: ${id}\n  disabled: true`), true, `${id} embed row must survive`);
  }
  assert.ok(rendered.includes(
    `- insert:\n    - id: ${EMBED_INTEGRATION_PLUGIN_ID}\n      name: ${EMBED_INTEGRATION_PACKAGE}\n`
  ), 'embed insert row must be appended');
});

test('renderCleanOverlay without a patch degrades to the embed-only overlay', () => {
  const rendered = renderCleanOverlay('');
  for (const id of EMBED_DISABLED_PLUGIN_IDS) {
    assert.ok(rendered.includes(`- id: ${id}\n  disabled: true`));
  }
  assert.ok(rendered.includes(`- id: ${EMBED_INTEGRATION_PLUGIN_ID}`));
});

test('writeCleanOverlay writes to <profileHome>/vscode-clean.overlay.yml from the profile patch', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-clean-overlay-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profileHome = path.join(root, 'profiles', 'web');
  fs.mkdirSync(profileHome, { recursive: true });
  fs.writeFileSync(path.join(profileHome, 'cordis.patch.yml'), SAMPLE_PATCH);

  const overlayPath = writeCleanOverlay(root, 'web');
  assert.strictEqual(overlayPath, path.join(profileHome, CLEAN_OVERLAY_FILENAME));
  const written = fs.readFileSync(overlayPath, 'utf8');
  assert.ok(written.includes('- id: live-stats\n  disabled: true'));
  assert.strictEqual(written.includes('@deepseek-ai/official-plugin'), false);

  // Every Restart-Clean overwrites the previous clean overlay.
  fs.writeFileSync(path.join(profileHome, 'cordis.patch.yml'), '- id: dsh-plugin-marketplace\n  disabled: true\n');
  writeCleanOverlay(root, 'web');
  const rewritten = fs.readFileSync(overlayPath, 'utf8');
  assert.ok(rewritten.includes('- id: dsh-plugin-marketplace\n  disabled: true'));
});

test('writeCleanOverlay validates home and profile name', () => {
  assert.throws(() => writeCleanOverlay('relative', 'web'), /non-empty absolute path/);
  assert.throws(() => writeCleanOverlay(path.resolve('.'), 'bad/name'), /profile name must match/);
  assert.throws(() => writeCleanOverlay(path.resolve('.'), '..'), /profile name must match/);
});
