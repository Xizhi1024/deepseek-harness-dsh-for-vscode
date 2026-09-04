'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const vsceEntry = path.join(path.dirname(require.resolve('@vscode/vsce/package.json')), 'vsce');
const result = spawnSync(process.execPath, [vsceEntry, 'ls', '--no-dependencies'], {
  cwd: process.cwd(),
  encoding: 'utf8',
});
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout || 'vsce ls failed\n');
  process.exit(result.status || 1);
}

const files = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
const forbidden = [
  /^\.agents\//i,
  /^\.dsh-[^/]+\//i,
  /^PLAN-/i,
  /^VERSIONS\.md$/i,
  /^USABILITY-AUDIT\.md$/i,
  /^\.git(?:hub)?\//i,
  /^\.vscode(?:-test)?\//i,
  /^ci\//i,
  /^docs\//i,
  /^scripts\//i,
  /^test\//i,
  /(?:^|\/)node_modules\//i,
  /(?:^|\/)\.env(?:\.|$)/i,
  /(?:^|\/)(?:credentials?|secrets?)(?:\.|\/|$)/i,
  /\.log$/i,
  /\.vsix$/i,
  /^thinking-effort-loaded\.json$/i,
];
const rejected = files.filter((file) => forbidden.some((pattern) => pattern.test(file)));
assert.deepStrictEqual(rejected, [], `Forbidden package entries: ${rejected.join(', ')}`);

for (const required of [
  'package.json',
  'LICENSE',
  'README.md',
  'README.zh-CN.md',
  'CHANGELOG.md',
  'src/extension.js',
  'src/lifecycle.js',
  'src/runtimeArtifact.js',
  'src/runtimeArchive.js',
  'src/runtimeDownloader.js',
  'src/runtimeInstaller.js',
  'src/managedRuntimeLaunch.js',
  'src/embedOverlay.js',
  'src/dshIntegration.js',
  'src/interactionBridge.js',
  'src/threadAttachment.js',
  'src/editorContext.js',
  'src/capabilityCatalog.js',
  'src/providerDetector.js',
  'src/versionedBridgeServer.js',
  'src/bridgeWorkspace.js',
  'src/runtimeResolver.js',
  'src/serverManager.js',
  'src/sessionNavigation.js',
  'src/sessionTitler.js',
  'src/textDocumentBridge.js',
  'src/types.js',
  'src/vscodeFacade.js',
  'src/webviewHtml.js',
  'src/webviewMessages.js',
  'src/workspaceContext.js',
  'src/adapters/contract.js',
  'src/catalog/catalogSchema.js',
  'src/catalog/pluginCatalog.js',
  'src/ch1/notifier.js',
  'src/ch2/workspaceClient.js',
  'src/commands/addFileToThread.js',
  'src/commands/cleanupOrphans.js',
  'src/commands/shell.js',
  'src/context/workspaceBinding.js',
  'src/detection/pluginDetector.js',
  'src/detection/probeTypes.js',
  'src/detection/profileProbe.js',
  'src/diagnose/pluginSummary.js',
  'src/diagnose/report.js',
  'src/protocol/ch1.js',
  'src/protocol/webview.js',
  'runtime-integration/dsh-vscode-integration/package.json',
  'runtime-integration/dsh-vscode-integration/lib/index.js',
  'runtime-integration/dsh-vscode-integration/lib/client.js',
]) {
  assert.ok(files.includes(required), `Required package entry is missing: ${required}`);
}
// Bundled-integration gate (1.1.1): the 1.0.0 VSIX shipped a stale
// runtime-integration snapshot — its client.js predated the dsh_session
// session-follow bridge (KNOWN_ISSUES #6/#9), and every activation of that
// build synced the regressed file into the DSH profile. vsce packages (and
// lists) from the working tree, so a tree-vs-tree comparison can never
// catch that; the guard here compares the working tree against git HEAD:
// a release must carry committed integration code, byte for byte.
const integrationRoot = 'runtime-integration/dsh-vscode-integration';
const fs = require('node:fs');

const bundledIntegration = files
  .filter((entry) => entry.startsWith(`${integrationRoot}/`))
  .sort();
const treeIntegration = [];
const walk = (dir) => {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      walk(full);
      continue;
    }
    // Mirror .vscodeignore: **/*.log never ships (the only global exclude
    // that reaches the integration tree; root-anchored test/** does not).
    if (item.name.endsWith('.log')) continue;
    treeIntegration.push(path.relative(process.cwd(), full).split(path.sep).join('/'));
  }
};
walk(path.join(process.cwd(), integrationRoot));
treeIntegration.sort();
assert.deepStrictEqual(
  bundledIntegration,
  treeIntegration,
  'Bundled runtime-integration file set must match the working tree exactly (missing or extra files)',
);

// Sandboxed hosts leak GIT_CONFIG_COUNT/GIT_CONFIG_VALUE_* pairs that make
// every git invocation exit 128 ("missing config key"); strip them and pin
// safe.directory so the gate works in any environment.
const gitEnv = { ...process.env };
for (const key of Object.keys(gitEnv)) {
  if (key.startsWith('GIT_CONFIG_')) delete gitEnv[key];
}
for (const rel of treeIntegration) {
  // git status --porcelain is empty only when the working-tree file matches the
  // committed content (after clean filters such as CRLF normalization).
  const status = spawnSync('git', ['-c', 'safe.directory=*', 'status', '--porcelain', '--', rel], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: gitEnv,
  });
  assert.strictEqual(status.status, 0, 'git status failed for ' + rel);
  assert.strictEqual(
    status.stdout.trim(),
    '',
    'runtime-integration file diverges from HEAD (commit or revert before packaging - the 1.0.0 VSIX shipped such a stale snapshot): ' + rel,
  );
}

const clientJs = fs.readFileSync(path.join(process.cwd(), integrationRoot, 'lib/client.js'), 'utf8');
assert.ok(
  clientJs.includes('startEmbeddedSessionFollow'),
  'runtime-integration client.js lost the dsh_session session-follow bridge (KNOWN_ISSUES #6/#9 regression canary)',
);

console.log(`Package-content gate passed for ${files.length} files.`);
