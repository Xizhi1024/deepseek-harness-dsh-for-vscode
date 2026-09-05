'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { DEFAULT_PORT } = require('../../src/types');
const { PORT_SCAN_LIMIT } = require('../../src/serverManager');
const { resolveDefaultPort, ISOLATED_DEFAULT_PORT } = require('../../src/workspaceContext');

const repoRoot = path.resolve(__dirname, '..', '..');

function assertOutsideScanWindow(port) {
  assert.ok(
    port < DEFAULT_PORT || port >= DEFAULT_PORT + PORT_SCAN_LIMIT,
    `port ${port} must stay outside the scan window `
    + `[${DEFAULT_PORT}, ${DEFAULT_PORT + PORT_SCAN_LIMIT - 1}]`,
  );
}

test('F5 extension host isolates VS Code state, extensions, and DSH home', () => {
  const launch = JSON.parse(fs.readFileSync(path.join(repoRoot, '.vscode', 'launch.json'), 'utf8'));
  const configuration = launch.configurations.find((entry) => entry.name === 'Run Extension');

  assert.ok(configuration, 'Run Extension launch configuration must exist');
  assert.ok(configuration.args.includes('--disable-extensions'));
  assert.ok(configuration.args.includes('--disable-workspace-trust'));
  assert.ok(configuration.args.includes(
    '--user-data-dir=${workspaceFolder}/.vscode-test/f5/user-data',
  ));
  assert.ok(configuration.args.includes(
    '--extensions-dir=${workspaceFolder}/.vscode-test/f5/extensions',
  ));
  assert.equal(
    configuration.env && configuration.env.DSH_HOME,
    '${workspaceFolder}/.vscode-test/f5/dsh-home',
  );
  assert.equal(
    configuration.env && configuration.env.DSH_VSCODE_STORAGE_ROOT,
    '${workspaceFolder}/.vscode-test/f5/extension-storage',
  );
});

test('F5 extension host pins a default port outside every installed-window scan window', () => {
  const launch = JSON.parse(fs.readFileSync(path.join(repoRoot, '.vscode', 'launch.json'), 'utf8'));
  const configuration = launch.configurations.find((entry) => entry.name === 'Run Extension');

  assert.ok(configuration, 'Run Extension launch configuration must exist');
  // The dev child must not share the default port with installed windows: a
  // takeover swaps the per-process token AND the per-home cookie secret, so
  // the losing window's sidebar renders the DSH 401 body. The pinned port
  // must also stay beyond the installed windows' forward scan so neither
  // side can ever land on the other's port by fallback.
  assertOutsideScanWindow(resolveDefaultPort(configuration.env));
  // A dev host relaunched with a pre-DSH_VSCODE_PORT env snapshot still
  // carries DSH_VSCODE_STORAGE_ROOT; that derivation must stay outside the
  // scan window too.
  assertOutsideScanWindow(ISOLATED_DEFAULT_PORT);
});
