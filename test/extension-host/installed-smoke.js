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
  const repoRoot = path.resolve(__dirname, '..', '..');
  const testStatePath = path.join(repoRoot, '.vscode-test');
  const profilePath = path.join(testStatePath, 'installed-smoke-profile.json');
  assert.ok(fs.existsSync(profilePath), `missing profile file: ${profilePath}`);
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  assert.ok(profile.userDataDir, 'profile must contain userDataDir');
  assert.ok(profile.extensionsDir, 'profile must contain extensionsDir');

  const markerPath = path.join(testStatePath, `installed-smoke-proof-${process.pid}.json`);
  fs.rmSync(markerPath, { force: true });

  // Use a fresh user-data-dir for the activation run (same isolated
  // extensions-dir where the VSIX was installed). Reusing a user-data-dir left
  // behind by a previously killed smoke run can wedge VS Code's singleton lock.
  const userDataDir = path.join(testStatePath, `vsix-user-smoke-${process.pid}`);
  fs.rmSync(userDataDir, { recursive: true, force: true });

  const savedEnv = {};
  for (const key of HOST_ONLY_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  try {
    await runTests({
      vscodeExecutablePath: path.join(testStatePath, 'vscode-win32-x64-archive-1.106.0', 'Code.exe'),
      // Never pass --extensionDevelopmentPath: the extension must be discovered
      // exclusively from the --extensions-dir where the local VSIX was installed.
      extensionDevelopmentPath: [],
      extensionTestsPath: path.resolve(__dirname, 'installed-suite'),
      reuseMachineInstall: true,
      launchArgs: [
        path.resolve(__dirname, 'fixture'),
        '--disable-workspace-trust',
        `--user-data-dir=${userDataDir}`,
        `--extensions-dir=${profile.extensionsDir}`,
      ],
      extensionTestsEnv: { DSH_INSTALLED_SMOKE_PROOF: markerPath },
    });

    assert.ok(fs.existsSync(markerPath), 'installed-suite must write the proof marker');
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
    console.log('Installed-extension activation proof verified.');
  } finally {
    for (const key of HOST_ONLY_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }
}

main().catch((error) => {
  console.error('Installed-extension smoke failed:', error);
  process.exitCode = 1;
});
