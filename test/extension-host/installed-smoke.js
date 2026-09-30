'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');
const { pathToFileURL } = require('node:url');
const { runTests } = require('@vscode/test-electron');
const { assertWithin, candidateManifest, verifyInstalled, codePaths } = require('./installedAcceptance');
const { verifyElectronUi } = require('./installedAcceptanceElectronUi');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}

function runCli(executable, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Isolated VSIX installation timed out')); }, 60000);
    child.stdout.on('data', (data) => { output = (output + data).slice(-10000); });
    child.stderr.on('data', (data) => { output = (output + data).slice(-10000); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); if (code === 0) resolve(output); else reject(new Error(`Isolated VSIX install failed (${code}): ${output}`)); });
  });
}

async function main(profileFile = process.argv[2] || process.env.DSH_INSTALLED_ACCEPTANCE_PROFILE) {
  assert.ok(profileFile, 'Pass an isolated acceptance profile JSON path');
  const profile = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
  for (const key of ['isolationRoot', 'vsixPath', 'vscodeExecutablePath', 'expectedVSCodeVersion']) assert.ok(profile[key], `Missing acceptance profile ${key}`);
  for (const key of ['isolationRoot', 'vsixPath', 'vscodeExecutablePath']) assert.ok(path.isAbsolute(profile[key]), `${key} must be absolute`);
  const code = codePaths(profile.vscodeExecutablePath);
  assert.equal(code.version, profile.expectedVSCodeVersion, 'VS Code executable version mismatch');
  const expected = candidateManifest(profile.vsixPath, profile.expectedExtensionVersion || '1.2.1', profile.expectedIntegrationVersion || '0.11.0');
  if (profile.expectedVsixSha256) assert.equal(expected.vsixSha256, profile.expectedVsixSha256, 'Candidate VSIX changed');
  fs.mkdirSync(profile.isolationRoot, { recursive: true });
  const runRoot = fs.mkdtempSync(path.join(profile.isolationRoot, `installed-${code.version}-`));
  assertWithin(profile.isolationRoot, runRoot);
  const userDataDir = path.join(runRoot, 'user-data');
  const extensionsDir = path.join(runRoot, 'extensions');
  const workspace = path.join(runRoot, 'workspace');
  for (const directory of [userDataDir, extensionsDir, workspace, path.join(workspace, '.vscode')]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify({ 'dsh.autoStart': false, 'telemetry.telemetryLevel': 'off', 'update.mode': 'none' }));
  const expectedPath = path.join(runRoot, 'expected.json');
  const proofPath = path.join(runRoot, 'proof.json');
  let runtimeUi;
  if (profile.runtimePackageRoot) {
    assert.ok(path.isAbsolute(profile.runtimePackageRoot) && path.isAbsolute(profile.playwrightModulePath), 'UI acceptance needs explicit absolute runtime and Playwright package paths');
    runtimeUi = { readyPath: path.join(runRoot, 'ui-ready'), continuePath: path.join(runRoot, 'ui-continue'), seededPath: path.join(runRoot, 'ui-seeded'), releasePath: path.join(runRoot, 'ui-release'), port: await freePort() };
    const userSettings = path.join(userDataDir, 'User'); fs.mkdirSync(userSettings, { recursive: true });
    fs.writeFileSync(path.join(userSettings, 'settings.json'), JSON.stringify({
      'dsh.autoStart': false, 'dsh.local.packageRoot': profile.runtimePackageRoot, 'dsh.local.nodePath': process.execPath,
      'dsh.runtime.version': '0.2.0-rc.1', 'dsh.profile': 'installed-acceptance', 'dsh.home.mode': 'isolated',
      'dsh.host': '127.0.0.1', 'dsh.port': await freePort(),
      'dsh.features.exports': true,
      'dsh.features.ctrl-i': true, 'dsh.features.ctrl-k': true,
      'dsh.closePolicy': 'onVscodeExit', 'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
    }));
  }
  fs.writeFileSync(expectedPath, JSON.stringify({ ...expected, extensionsDir, runtimeUi, expectedVSCodeVersion: code.version, repoRoot: path.resolve(__dirname, '../..') }, null, 2));
  const safeEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SystemRoot|ComSpec|WINDIR|TEMP|TMP|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(key)));
  Object.assign(safeEnvironment, {
    USERPROFILE: path.join(runRoot, 'user-home'), HOME: path.join(runRoot, 'user-home'),
    APPDATA: path.join(runRoot, 'appdata'), LOCALAPPDATA: path.join(runRoot, 'localappdata'),
    DSH_HOME: path.join(runRoot, 'dsh-home'), DSH_VSCODE_STORAGE_ROOT: path.join(runRoot, 'extension-storage'),
    DSH_INSTALLED_ACCEPTANCE_EXPECTED: expectedPath, DSH_INSTALLED_ACCEPTANCE_PROOF: proofPath,
  });
  for (const key of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'DSH_HOME', 'DSH_VSCODE_STORAGE_ROOT']) fs.mkdirSync(safeEnvironment[key], { recursive: true });
  await runCli(profile.vscodeExecutablePath, [code.cli, '--install-extension', profile.vsixPath, '--force', '--user-data-dir', userDataDir, '--extensions-dir', extensionsDir], { ...safeEnvironment, ELECTRON_RUN_AS_NODE: '1' });
  const installed = fs.readdirSync(extensionsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(extensionsDir, entry.name)).filter((directory) => {
    try { const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')); return `${pkg.publisher}.${pkg.name}`.toLowerCase() === expected.extensionId.toLowerCase(); } catch { return false; }
  });
  assert.equal(installed.length, 1, 'Expected exactly one isolated installed DSH extension');
  verifyInstalled(installed[0], expected);
  // VS Code only executes extensionTestsPath in an extension-development
  // window. The development extension is an empty test driver, never DSH.
  const testDriver = path.join(runRoot, 'test-driver');
  fs.mkdirSync(testDriver, { recursive: true });
  fs.writeFileSync(path.join(testDriver, 'package.json'), JSON.stringify({ name: 'dsh-installed-acceptance-driver', publisher: 'local-test', version: '1.0.0', engines: { vscode: '^1.106.0' }, main: './index.js', activationEvents: ['*'] }));
  fs.writeFileSync(path.join(testDriver, 'index.js'), 'exports.activate = () => {};\n');
  const expectedRun = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
  expectedRun.testDriver = { id: 'local-test.dsh-installed-acceptance-driver', path: testDriver };
  fs.writeFileSync(expectedPath, JSON.stringify(expectedRun, null, 2));
  if (runtimeUi) {
    const { ensureProfileScaffold, deriveRuntimeProfileName } = require(path.join(installed[0], 'src/profileScaffold'));
    const dshHome = path.join(safeEnvironment.DSH_VSCODE_STORAGE_ROOT, '.dsh');
    const profileName = deriveRuntimeProfileName('installed-acceptance', '0.2.0-rc.1');
    ensureProfileScaffold({ dshHome, profileName, donorProfileName: '' });
    const fixtureRoot = path.join(dshHome, 'profiles', profileName, 'node_modules', 'vscode-contract-provider');
    fs.mkdirSync(fixtureRoot, { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, '../../scripts/fixtures/dsh020rc1-provider.mjs'), path.join(fixtureRoot, 'index.mjs'));
    fs.writeFileSync(path.join(fixtureRoot, 'package.json'), JSON.stringify({ name: 'vscode-contract-provider', version: '1.0.0', type: 'module', main: 'index.mjs' }));
    const llmModule = pathToFileURL(path.join(path.dirname(profile.runtimePackageRoot), 'dsh-llm/lib/index.js')).href;
    fs.writeFileSync(path.join(dshHome, 'profiles', profileName, 'cordis.patch.yml'), [
      '- id: agent-default-model', '  config:', '    provider: vscode-contract-probe', '    model: deterministic',
      '- id: session-title-llm', '  disabled: true', '- insert:', '    - id: vscode-contract-provider',
      '      name: vscode-contract-provider', '      config:', `        llmModule: ${JSON.stringify(llmModule)}`, '',
    ].join('\n'));
  }
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, safeEnvironment);
    const testController = new AbortController();
    const testRun = runTests({ vscodeExecutablePath: profile.vscodeExecutablePath,
      extensionDevelopmentPath: [testDriver], // DSH discovery uses only the isolated installed extensions.
      extensionTestsPath: path.join(__dirname, 'installedAcceptanceSuite'), reuseMachineInstall: true,
      launchArgs: [workspace, '--new-window', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-updates', '--disable-telemetry', '--disable-gpu', '--headless',
        `--user-data-dir=${userDataDir}`, `--extensions-dir=${extensionsDir}`, ...(runtimeUi ? [`--remote-debugging-port=${runtimeUi.port}`] : [])], extensionTestsEnv: safeEnvironment });
    testRun.catch(error => testController.abort(error));
    let uiProof, uiError;
    try {
      if (runtimeUi) uiProof = await verifyElectronUi({ ...runtimeUi, playwrightModulePath: profile.playwrightModulePath, expected, runRoot, signal: testController.signal });
    } catch (error) {
      uiError = error;
    } finally { await testRun; }
    assert.ok(fs.existsSync(proofPath), 'Installed suite did not write evidence');
    const proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
    assert.equal(proof.vsixSha256, expected.vsixSha256);
    assert.equal(proof.version, expected.extensionVersion);
    assert.equal(proof.integrationVersion, expected.integrationVersion);
    assert.equal(proof.vscodeVersion, code.version);
    assert.equal(proof.verifiedFiles, Object.keys(expected.files).length);
    if (uiError) {
      proof.runtimeUiAcceptance = { status: 'BLOCKED', reason: uiError.message, claimedUiPass: false };
      fs.writeFileSync(proofPath, JSON.stringify(proof, null, 2));
      throw new Error(`Installed UI acceptance blocked; partial evidence preserved at ${proofPath}`, { cause: uiError });
    }
    if (uiProof) { proof.runtimeUiAcceptance = uiProof; fs.writeFileSync(proofPath, JSON.stringify(proof, null, 2)); }
    console.log(JSON.stringify({ status: 'PASS', scope: uiProof ? 'installed identity, activation and actual runtime webview' : 'installed artifact identity and activation only', proofPath, ...proof }, null, 2));
    return proof;
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}
if (require.main === module) main().catch((error) => { console.error('Installed acceptance failed:', error); process.exitCode = 1; });
module.exports = { main };
