'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  bindRuntimeHome,
  migrateLegacyHomeMode,
  resolveDshHome,
} = require('../src/dshHome');

test('shared home follows setting, environment, then official ~/.dsh precedence', () => {
  const base = path.join(os.tmpdir(), 'dsh-home-resolution');
  const storage = path.join(base, 'storage');
  assert.deepStrictEqual(resolveDshHome({
    globalStoragePath: storage,
    configuredPath: path.join(base, 'custom'),
    env: { DSH_HOME: path.join(base, 'environment') },
    homedir: () => path.join(base, 'user'),
  }), {
    mode: 'shared', path: path.join(base, 'custom'), source: 'setting',
  });
  assert.strictEqual(resolveDshHome({
    globalStoragePath: storage,
    env: { DSH_HOME: path.join(base, 'environment') },
    homedir: () => path.join(base, 'user'),
  }).path, path.join(base, 'environment'));
  assert.strictEqual(resolveDshHome({
    globalStoragePath: storage,
    env: {},
    homedir: () => path.join(base, 'user'),
  }).path, path.join(base, 'user', '.dsh'));
});

test('isolated home is fixed under extension global storage and ignores shared overrides', () => {
  const base = path.join(os.tmpdir(), 'dsh-home-isolated');
  const result = resolveDshHome({
    mode: 'isolated',
    globalStoragePath: path.join(base, 'storage'),
    configuredPath: path.join(base, 'custom'),
    env: { DSH_HOME: path.join(base, 'environment') },
  });
  assert.deepStrictEqual(result, {
    mode: 'isolated',
    path: path.join(base, 'storage', '.dsh'),
    source: 'extension-global-storage',
  });
});

test('custom shared home must be absolute', () => {
  assert.throws(() => resolveDshHome({
    globalStoragePath: path.join(os.tmpdir(), 'storage'),
    configuredPath: 'relative-home',
  }), /must be an absolute path/);
});

test('verified managed runtime can be rebound to the selected DSH home', () => {
  const home = path.join(os.tmpdir(), 'selected-dsh-home');
  const runtime = bindRuntimeHome({ executablePath: path.join(os.tmpdir(), 'dsh.exe') }, home);
  assert.strictEqual(runtime.dshHome, home);
  assert.strictEqual(runtime.profileHome, path.join(home, 'profiles', 'web'));
  assert.strictEqual(runtime.profileName, 'web');
});

test('verified managed runtime can be rebound to a custom DSH profile', () => {
  const home = path.join(os.tmpdir(), 'selected-dsh-home');
  const runtime = bindRuntimeHome(
    { executablePath: path.join(os.tmpdir(), 'dsh.exe') },
    home,
    'dev'
  );
  assert.strictEqual(runtime.dshHome, home);
  assert.strictEqual(runtime.profileHome, path.join(home, 'profiles', 'dev'));
  assert.strictEqual(runtime.profileName, 'dev');
});

test('bindRuntimeHome rejects invalid profile names with CONFIG_PROFILE_INVALID', () => {
  const home = path.join(os.tmpdir(), 'selected-dsh-home');
  for (const bad of ['', 'x'.repeat(65), 'bad/name', 'bad\\name', 'bad name', '中文']) {
    assert.throws(
      () => bindRuntimeHome({ executablePath: path.join(os.tmpdir(), 'dsh.exe') }, home, bad),
      (error) => error && error.code === 'CONFIG_PROFILE_INVALID' && /profile name must match/.test(error.message)
    );
  }
});

test('legacy migration preserves a non-empty isolated home without copying it', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const isolated = path.join(root, 'isolated');
  const shared = path.join(root, 'shared');
  fs.mkdirSync(isolated);
  fs.writeFileSync(path.join(isolated, 'settings.yaml'), 'legacy: true\n');
  const updates = [];
  const state = new Map();
  const vscode = {
    ConfigurationTarget: { Global: 1 },
    workspace: {
      getConfiguration() {
        return {
          inspect() { return { defaultValue: 'shared' }; },
          async update(key, value, target) { updates.push({ key, value, target }); },
        };
      },
    },
  };
  const context = {
    globalState: {
      get(key, fallback) { return state.has(key) ? state.get(key) : fallback; },
      async update(key, value) { state.set(key, value); },
    },
  };
  const result = await migrateLegacyHomeMode({ vscode, context, sharedHome: shared, isolatedHome: isolated });
  assert.deepStrictEqual(result, { changed: true, reason: 'legacy-isolated-preserved' });
  assert.deepStrictEqual(updates, [{ key: 'home.mode', value: 'isolated', target: 1 }]);
  assert.strictEqual(fs.existsSync(path.join(isolated, 'settings.yaml')), true);
  assert.strictEqual(fs.existsSync(shared), false);
});
