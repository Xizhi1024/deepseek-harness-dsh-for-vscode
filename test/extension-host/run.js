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
  const requestedExecutable = process.env.VSCODE_TEST_EXECUTABLE;
  const requestedVersion = process.env.VSCODE_TEST_VERSION || '1.106.0';
  const originalEnvironment = { ...process.env };
  const testStatePath = path.resolve(__dirname, '..', '..', '.vscode-test');
  const isolatedRoot = path.join(testStatePath, `development-${process.pid}`);
  const launchEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(PATH|PATHEXT|SystemRoot|ComSpec|WINDIR|TEMP|TMP|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(name)));
  Object.assign(launchEnvironment, {
    DSH_HOME: path.join(isolatedRoot, 'dsh-home'),
    DSH_VSCODE_STORAGE_ROOT: path.join(isolatedRoot, 'extension-storage'),
    USERPROFILE: path.join(isolatedRoot, 'user-home'),
    APPDATA: path.join(isolatedRoot, 'appdata'),
    LOCALAPPDATA: path.join(isolatedRoot, 'localappdata'),
  });
  for (const name of ['DSH_HOME', 'DSH_VSCODE_STORAGE_ROOT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    fs.mkdirSync(launchEnvironment[name], { recursive: true });
  }
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, launchEnvironment);
  const savedEnv = {};
  for (const key of HOST_ONLY_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  try {
    const markerPath = path.join(testStatePath, `extension-host-proof-${process.pid}.json`);
    fs.rmSync(markerPath, { force: true });
    await runTests({
      version: requestedVersion,
      ...(requestedExecutable ? { vscodeExecutablePath: requestedExecutable } : {}),
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
        'dsh.addFileToThread',
        'dsh.addProblems',
        'dsh.addSelectionToThread',
        'dsh.capabilities',
        'dsh.changes.toggleScope',
        'dsh.cleanupOrphans',
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
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, originalEnvironment);
  }
}

main().catch((error) => {
  console.error('Extension-host smoke failed:', error);
  process.exitCode = 1;
});
