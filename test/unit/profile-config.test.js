'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createWorkspaceContext } = require('../../src/workspaceContext');
const { bindRuntimeHome } = require('../../src/dshHome');
const { INTEGRATION_FILES, installDshIntegration } = require('../../src/dshIntegration');
const {
  assertValidProfileName,
  buildManagedLaunchSpec,
  normalizeResolvedRuntime,
} = require('../../src/managedRuntimeLaunch');
const { isRetryableStartupError } = require('../../src/extension');

function createExtensionTree(root) {
  const extension = path.join(root, 'extension');
  const source = path.join(extension, 'runtime-integration', 'dsh-vscode-integration');
  for (const relative of INTEGRATION_FILES) {
    const file = path.join(source, ...relative.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, relative);
  }
  return extension;
}

function createFakeVscode(values = {}) {
  return {
    Uri: { joinPath(base, child) { return { fsPath: path.join(base.fsPath, child) }; } },
    window: { activeTextEditor: null },
    workspace: {
      workspaceFolders: [],
      getConfiguration() {
        return { get: (key, fallback) => values[key] ?? fallback };
      },
    },
  };
}

function createRuntime(home, profileName, profileHome, root) {
  const executablePath = path.join(root, `dsh${process.platform === 'win32' ? '.exe' : ''}`);
  fs.writeFileSync(executablePath, 'runtime');
  if (process.platform !== 'win32') fs.chmodSync(executablePath, 0o755);
  const entryScript = path.join(root, 'app', 'bin.js');
  fs.mkdirSync(path.dirname(entryScript), { recursive: true });
  fs.writeFileSync(entryScript, 'script');
  return {
    executablePath,
    entrypointArgs: [entryScript],
    payloadRoot: root,
    dshHome: home,
    profileHome,
    profileName,
  };
}

test('custom dsh.profile flows consistently through all five startup seams', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-profile-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const extension = createExtensionTree(root);

  const cfg = createWorkspaceContext(createFakeVscode({ profile: 'dev' }), {
    globalStorageUri: { fsPath: path.join(root, 'state') },
  }).config();
  assert.strictEqual(cfg.profile, 'dev');

  const bound = bindRuntimeHome({ executablePath: path.join(root, 'dsh.exe') }, home, cfg.profile);
  assert.strictEqual(bound.profileHome, path.join(home, 'profiles', 'dev'));
  assert.strictEqual(bound.profileName, 'dev');

  const integration = installDshIntegration(home, extension, { profileName: cfg.profile });
  assert.strictEqual(integration.nodeModulesPath, path.join(home, 'profiles', 'dev', 'node_modules'));

  const runtime = createRuntime(home, cfg.profile, bound.profileHome, root);
  const normalized = normalizeResolvedRuntime(runtime, process.platform);
  assert.strictEqual(normalized.profileName, 'dev');
  const launch = buildManagedLaunchSpec(runtime, '127.0.0.1', 3080, process.platform);
  const profileIndex = launch.args.indexOf('--profile');
  assert.strictEqual(launch.args[profileIndex + 1], 'dev');

  assert.strictEqual(isRetryableStartupError({ code: 'CONFIG_PROFILE_INVALID' }), false);
});

test('default dsh.profile=web keeps the master web path snapshot', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-profile-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const extension = createExtensionTree(root);

  const cfg = createWorkspaceContext(createFakeVscode(), {
    globalStorageUri: { fsPath: path.join(root, 'state') },
  }).config();
  assert.strictEqual(cfg.profile, 'web');

  const bound = bindRuntimeHome({ executablePath: path.join(root, 'dsh.exe') }, home);
  assert.strictEqual(bound.profileHome, path.join(home, 'profiles', 'web'));
  assert.strictEqual(bound.profileName, 'web');

  const integration = installDshIntegration(home, extension);
  assert.strictEqual(integration.nodeModulesPath, path.join(home, 'profiles', 'web', 'node_modules'));

  const runtime = createRuntime(home, cfg.profile, bound.profileHome, root);
  const normalized = normalizeResolvedRuntime(runtime, process.platform);
  assert.strictEqual(normalized.profileName, 'web');
  const launch = buildManagedLaunchSpec(runtime, '127.0.0.1', 3080, process.platform);
  const profileIndex = launch.args.indexOf('--profile');
  assert.strictEqual(launch.args[profileIndex + 1], 'web');
});

test('invalid profile names are rejected with CONFIG_PROFILE_INVALID across all validators', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-profile-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const extension = createExtensionTree(root);
  const badNames = ['', 'x'.repeat(65), 'bad/name', 'bad\\name', 'bad name', '中文'];

  for (const bad of badNames) {
    assert.throws(
      () => assertValidProfileName(bad),
      (error) => error && error.code === 'CONFIG_PROFILE_INVALID' && /profile name must match/.test(error.message)
    );
    assert.throws(
      () => bindRuntimeHome({ executablePath: path.join(root, 'dsh.exe') }, home, bad),
      (error) => error && error.code === 'CONFIG_PROFILE_INVALID' && /profile name must match/.test(error.message)
    );
    assert.throws(
      () => installDshIntegration(home, extension, { profileName: bad }),
      (error) => error && error.code === 'CONFIG_PROFILE_INVALID' && /profile name must match/.test(error.message)
    );
    assert.throws(
      () => normalizeResolvedRuntime({
        executablePath: path.join(root, 'dsh.exe'),
        dshHome: home,
        profileHome: path.join(home, 'profiles', bad),
        profileName: bad,
      }, process.platform),
      (error) => error && error.code === 'CONFIG_PROFILE_INVALID' && /profile name must match/.test(error.message)
    );
  }
});
