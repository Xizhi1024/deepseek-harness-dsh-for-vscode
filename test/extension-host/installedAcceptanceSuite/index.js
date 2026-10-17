'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { assertWithin, verifyInstalled } = require('../installedAcceptance');

async function run() {
  const expected = JSON.parse(fs.readFileSync(process.env.DSH_INSTALLED_ACCEPTANCE_EXPECTED, 'utf8'));
  const driver = vscode.extensions.getExtension(expected.testDriver.id);
  assert.ok(driver, 'Isolated empty acceptance driver was not loaded');
  assert.equal(fs.realpathSync(driver.extensionPath), fs.realpathSync(expected.testDriver.path));
  const extension = vscode.extensions.getExtension(expected.extensionId);
  assert.ok(extension, 'Installed extension was not discoverable');
  const extensionPath = fs.realpathSync(extension.extensionPath);
  assertWithin(fs.realpathSync(expected.extensionsDir), extensionPath);
  assert.notEqual(extensionPath.toLowerCase(), fs.realpathSync(expected.repoRoot).toLowerCase(), 'Product loaded from development checkout');
  assert.equal(extension.packageJSON.version, expected.extensionVersion);
  assert.equal(vscode.version, expected.expectedVSCodeVersion);
  const verifiedFiles = verifyInstalled(extensionPath, expected);
  const integration = JSON.parse(fs.readFileSync(path.join(extensionPath, 'runtime-integration/dsh-vscode-integration/package.json'), 'utf8'));
  assert.equal(integration.version, expected.integrationVersion);
  await extension.activate(); assert.equal(extension.isActive, true);
  const commands = await vscode.commands.getCommands(true);
  const expectedCommands = ['dsh.focusSidebar', 'dsh.newSession', 'dsh.switchSession', 'dsh.restartServer', 'dsh.stopServer', 'dsh.addFileToThread'];
  if (vscode.workspace.getConfiguration('dsh').get('features.ctrl-i')) expectedCommands.push('dsh.ctrlIEdit');
  if (vscode.workspace.getConfiguration('dsh').get('features.ctrl-k')) expectedCommands.push('dsh.ctrlKEdit');
  for (const command of expectedCommands) assert.ok(commands.includes(command), `Missing installed command ${command}`);
  const proof = { extensionId: extension.id, version: extension.packageJSON.version, integrationVersion: integration.version,
    vscodeVersion: vscode.version, nodeVersion: process.version, extensionPath, testDriver: expected.testDriver,
    installationSource: 'isolated installed VSIX; only the empty acceptance driver uses extensionDevelopmentPath',
    isActive: extension.isActive, verifiedFiles, vsixSha256: expected.vsixSha256, commands: expectedCommands.sort(), runtimeUiAcceptance: 'NOT_RUN',
    extensionHostPid: process.pid, workspaceFolders: (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath) };
  const saveProof = () => fs.writeFileSync(process.env.DSH_INSTALLED_ACCEPTANCE_PROOF, JSON.stringify(proof, null, 2));
  saveProof();
  if (expected.runtimeUi) {
    fs.writeFileSync(expected.runtimeUi.readyPath, 'ready');
    const until = Date.now() + 240000;
    while (!fs.existsSync(expected.runtimeUi.continuePath) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(fs.existsSync(expected.runtimeUi.continuePath), 'UI driver did not attach to the dedicated Code process');
    await vscode.workspace.getConfiguration('dsh').update('autoStart', true, vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand('dsh.focusSidebar');
    await vscode.commands.executeCommand('dsh.newSession');
    await extension.exports.ask('UI search alpha', { signal: AbortSignal.timeout(30000) });
    await vscode.commands.executeCommand('dsh.newSession');
    await extension.exports.ask('UI search beta', { signal: AbortSignal.timeout(30000) });
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await vscode.commands.executeCommand('dsh.focusSidebar');
    await vscode.commands.executeCommand('workbench.action.maximizeAuxiliaryBar');
    await vscode.commands.executeCommand('notifications.clearAll');
    proof.runtimeStartupAndExports = { status: 'PASS', runtimeVersion: expected.runtimeUi.runtimeVersion, sessionsCreated: 2, localProviderResponses: 2, panelClosedAndReopened: true };
    saveProof();
    fs.writeFileSync(expected.runtimeUi.seededPath, 'seeded through installed exports');
    if (expected.runtimeUi.coordinationRoot) fs.writeFileSync(path.join(expected.runtimeUi.coordinationRoot, `${expected.runtimeUi.windowRole}-ready.json`), JSON.stringify({ proofPath: process.env.DSH_INSTALLED_ACCEPTANCE_PROOF, workspaceFolders: proof.workspaceFolders, extensionHostPid: process.pid }));
    while (!fs.existsSync(expected.runtimeUi.releasePath) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 100));
    await vscode.commands.executeCommand('dsh.stopServer');
    proof.ownedRuntimeStopped = true;
    saveProof();
    assert.ok(fs.existsSync(expected.runtimeUi.releasePath), 'UI driver did not complete');
  }
  saveProof();
}
module.exports = { run };
