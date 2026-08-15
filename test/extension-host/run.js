'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

// Host variables leaked from the VS Code extension host that runs this agent.
// Electron treats any non-empty ELECTRON_RUN_AS_NODE value as Node mode, and
// stale VSCODE_* process markers would bind the test instance to this host.
const HOST_ONLY_ENV_KEYS = Object.freeze([
  'ELECTRON_RUN_AS_NODE',
  'VSCODE_CODE_CACHE_PATH',
  'VSCODE_CRASH_REPORTER_PROCESS_TYPE',
  'VSCODE_CWD',
  'VSCODE_ESM_ENTRYPOINT',
  'VSCODE_HANDLES_UNCAUGHT_ERRORS',
  'VSCODE_IPC_HOOK',
  'VSCODE_NLS_CONFIG',
  'VSCODE_PID',
]);

async function main() {
  const savedEnv = {};
  for (const key of HOST_ONLY_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  try {
    const testStatePath = path.resolve(__dirname, '..', '..', '.vscode-test');
    const markerPath = path.join(testStatePath, `extension-host-proof-${process.pid}.json`);
    fs.rmSync(markerPath, { force: true });
    await runTests({
      version: process.env.VSCODE_TEST_VERSION || '1.106.0',
      extensionDevelopmentPath: path.resolve(__dirname, '..', '..'),
      extensionTestsPath: path.resolve(__dirname, 'suite'),
      launchArgs: [
        path.resolve(__dirname, 'fixture'),
        '--disable-extensions',
        '--disable-workspace-trust',
        `--user-data-dir=${path.join(testStatePath, `user-data-${process.pid}`)}`,
        `--extensions-dir=${path.join(testStatePath, `extensions-${process.pid}`)}`,
      ],
      extensionTestsEnv: { DSH_EXTENSION_HOST_PROOF: markerPath },
    });
    const proof = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    fs.rmSync(markerPath, { force: true });
    assert.deepStrictEqual(proof, {
      extensionId: 'Xizhi1024.dsh-vs-sidebar',
      isActive: true,
      commands: [
        'dsh.addActiveFile',
        'dsh.addActiveSelection',
        'dsh.addProblems',
        'dsh.capabilities',
        'dsh.diagnose',
        'dsh.focusSidebar',
        'dsh.newSession',
        'dsh.openInBrowser',
        'dsh.restartServer',
        'dsh.stopServer',
        'dsh.switchSession',
      ],
    });
    console.log('Extension-host proof verified.');
  } finally {
    for (const key of HOST_ONLY_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }
}

main().catch((error) => {
  console.error('Extension-host smoke failed:', error);
  process.exitCode = 1;
});
