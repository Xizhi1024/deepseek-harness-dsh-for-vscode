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

console.log(`Package-content gate passed for ${files.length} files.`);
