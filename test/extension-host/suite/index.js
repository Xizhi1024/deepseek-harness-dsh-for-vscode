'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vscode = require('vscode');

async function run() {
  const extension = vscode.extensions.getExtension('Xizhi1024.dsh-vs-sidebar');
  assert.ok(extension, 'development extension must be discoverable');
  await extension.activate();
  assert.strictEqual(extension.isActive, true);

  const commands = await vscode.commands.getCommands(true);
  const expectedCommands = [
    'dsh.openInBrowser',
    'dsh.restartServer',
    'dsh.stopServer',
    'dsh.focusSidebar',
    'dsh.addActiveFile',
    'dsh.addActiveSelection',
    'dsh.addFileToThread',
    'dsh.addSelectionToThread',
    'dsh.addProblems',
    'dsh.newSession',
    'dsh.switchSession',
    'dsh.capabilities',
    'dsh.cleanupOrphans',
    'dsh.diagnose',
  ];
  for (const command of expectedCommands) {
    assert.ok(commands.includes(command), `registered command is missing: ${command}`);
  }
  const proofPath = process.env.DSH_EXTENSION_HOST_PROOF;
  assert.ok(proofPath, 'extension-host proof path must be provided by the runner');
  fs.writeFileSync(proofPath, JSON.stringify({
    extensionId: extension.id,
    isActive: extension.isActive,
    commands: expectedCommands.slice().sort(),
  }));
}

module.exports = { run };
