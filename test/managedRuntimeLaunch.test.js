'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildManagedLaunchSpec,
  normalizeResolvedRuntime,
} = require('../src/managedRuntimeLaunch');
const {
  EMBED_DISABLED_PLUGIN_IDS,
  EMBED_INTEGRATION_PACKAGE,
  EMBED_INTEGRATION_PLUGIN_ID,
  renderEmbedOverlay,
  writeEmbedOverlay,
} = require('../src/embedOverlay');
const { ServerManager } = require('../src/serverManager');

function fixture(t, extension = process.platform === 'win32' ? '.exe' : '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-managed-launch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executablePath = path.join(root, `dsh${extension}`);
  fs.writeFileSync(executablePath, 'runtime');
  if (process.platform !== 'win32') fs.chmodSync(executablePath, 0o755);
  const entryScript = path.join(root, 'app', 'bin.js');
  fs.mkdirSync(path.dirname(entryScript), { recursive: true });
  fs.writeFileSync(entryScript, 'script');
  return {
    executablePath,
    entrypointArgs: [entryScript],
    payloadRoot: root,
    dshHome: root,
    profileHome: path.join(root, 'profiles', 'web'),
    profileName: 'web',
  };
}

test('managed launch uses an absolute verified executable and fixed web-profile args', (t) => {
  const runtime = fixture(t, '.exe');
  const launch = buildManagedLaunchSpec(runtime, '127.0.0.1', 4321, 'win32');
  assert.strictEqual(launch.command, runtime.executablePath);
  assert.deepStrictEqual(launch.args, [
    runtime.entrypointArgs[0],
    '--profile', 'web', '--host', '127.0.0.1', '--port', '4321',
  ]);
  assert.deepStrictEqual(launch.env, {
    DSH_HOME: runtime.dshHome,
    DSH_TEXT_EDITOR: 'vscode',
  });
  assert.strictEqual(launch.windowsHide, true);
  assert.strictEqual(launch.detached, false);
});

test('managed launch accepts any legal profile name and keeps spawn order', (t) => {
  const runtime = fixture(t, '.exe');
  const custom = { ...runtime, profileName: 'dev', profileHome: path.join(runtime.dshHome, 'profiles', 'dev') };
  const normalized = normalizeResolvedRuntime(custom, 'win32');
  assert.strictEqual(normalized.profileName, 'dev');
  assert.strictEqual(normalized.profileHome, path.join(runtime.dshHome, 'profiles', 'dev'));
  const launch = buildManagedLaunchSpec(custom, '127.0.0.1', 4321, 'win32');
  assert.deepStrictEqual(launch.args, [
    runtime.entrypointArgs[0],
    '--profile', 'dev', '--host', '127.0.0.1', '--port', '4321',
  ]);
});

test('managed launch rejects PATH lookup, invalid profile names, profile drift, and non-native Windows shims', (t) => {
  const runtime = fixture(t, '.cmd');
  assert.throws(
    () => normalizeResolvedRuntime({ ...runtime, executablePath: 'dsh' }),
    /absolute.*PATH lookup/
  );
  for (const bad of ['', 'x'.repeat(65), 'bad/name', 'bad\\name', 'bad name', '中文']) {
    assert.throws(
      () => normalizeResolvedRuntime({ ...runtime, profileName: bad }),
      (error) => error && error.code === 'CONFIG_PROFILE_INVALID' && /profile name must match/.test(error.message)
    );
  }
  assert.throws(
    () => normalizeResolvedRuntime({ ...runtime, profileHome: path.join(runtime.dshHome, 'profiles', 'other') }),
    (error) => error && error.code === 'CONFIG_PROFILE_INVALID' && /profileHome does not match/.test(error.message)
  );
  assert.throws(
    () => buildManagedLaunchSpec(runtime, '127.0.0.1', 3080, 'win32'),
    /native \.exe entrypoint/
  );
});

test('managed launch validates loopback and port before spawning', (t) => {
  const runtime = fixture(t, '.exe');
  assert.throws(
    () => buildManagedLaunchSpec(runtime, '0.0.0.0', 3080, 'win32'),
    /loopback host/
  );
  assert.throws(
    () => buildManagedLaunchSpec(runtime, '127.0.0.1', 0, 'win32'),
    /integer from 1 to 65535/
  );
});

test('managed launch appends a verified embed --patch before --profile', (t) => {
  const runtime = fixture(t, '.exe');
  const overlayPath = writeEmbedOverlay(runtime.dshHome);
  const launch = buildManagedLaunchSpec(runtime, '127.0.0.1', 4321, 'win32', {
    patchPath: overlayPath,
    ignoredOption: 'must not change existing behavior',
  });
  assert.deepStrictEqual(launch.args, [
    runtime.entrypointArgs[0],
    '--patch', overlayPath,
    '--profile', 'web',
    '--host', '127.0.0.1',
    '--port', '4321',
  ]);
  assert.deepStrictEqual(launch.env, {
    DSH_HOME: runtime.dshHome,
    DSH_TEXT_EDITOR: 'vscode',
  });
  assert.strictEqual(launch.windowsHide, true);
  assert.strictEqual(launch.detached, false);
});

test('managed launch rejects invalid embed patch paths', (t) => {
  const runtime = fixture(t, '.exe');
  assert.throws(
    () => buildManagedLaunchSpec(runtime, '127.0.0.1', 4321, 'win32', { patchPath: 'relative/overlay.yml' }),
    /embed patchPath must be an absolute path/
  );
  assert.throws(
    () => buildManagedLaunchSpec(runtime, '127.0.0.1', 4321, 'win32', { patchPath: 42 }),
    /embed patchPath must be an absolute path/
  );
  assert.throws(
    () => buildManagedLaunchSpec(runtime, '127.0.0.1', 4321, 'win32', {
      patchPath: path.join(runtime.dshHome, 'bad\0path.yml'),
    }),
    /embed patchPath must not contain NUL/
  );
  const directoryPatch = path.join(runtime.dshHome, 'patch-dir');
  fs.mkdirSync(directoryPatch);
  assert.throws(
    () => buildManagedLaunchSpec(runtime, '127.0.0.1', 4321, 'win32', { patchPath: directoryPatch }),
    /embed patchPath must be a verified regular file/
  );
});

test('managed launch rejects symlink embed patch paths where symlinks can be created', {
  skip: process.platform === 'win32' && 'symlink creation is unreliable on Windows; directory case covers the same regular-file branch',
}, (t) => {
  const runtime = fixture(t);
  const target = path.join(runtime.dshHome, 'overlay.yml');
  fs.writeFileSync(target, 'overlay');
  const link = path.join(runtime.dshHome, 'overlay-link.yml');
  fs.symlinkSync(target, link);
  assert.throws(
    () => buildManagedLaunchSpec(runtime, '127.0.0.1', 4321, process.platform, { patchPath: link }),
    /embed patchPath must be a verified regular file/
  );
});

test('embed overlay renders and writes only the frozen disabled plugin ids', (t) => {
  assert.deepStrictEqual([...EMBED_DISABLED_PLUGIN_IDS], [
    'better-sidebar',
    'ui-dsh-aionui-panel',
  ]);
  assert.strictEqual(Object.isFrozen(EMBED_DISABLED_PLUGIN_IDS), true);

  const rendered = renderEmbedOverlay();
  assert.strictEqual(rendered.endsWith('\n'), true);
  assert.strictEqual(rendered.endsWith('\n\n'), false);
  const lines = rendered.split('\n');
  assert.ok(lines.length >= 6, 'two comment lines, two plugin entries, trailing newline');
  assert.match(lines[0], /^# .*VS Code embed overlay, generated by dsh-vs-sidebar/);
  assert.match(lines[1], /^#/);
  for (const id of EMBED_DISABLED_PLUGIN_IDS) {
    assert.strictEqual(rendered.includes(`- id: ${id}\n  disabled: true\n`), true);
  }
  assert.ok(rendered.includes(
    `- insert:\n    - id: ${EMBED_INTEGRATION_PLUGIN_ID}\n      name: ${EMBED_INTEGRATION_PACKAGE}\n`
  ));

  const marker = 'CALLER_INPUT_MARKER';
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-embed-overlay-${marker}-`));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const overlayPath = writeEmbedOverlay(directory);
  assert.strictEqual(path.isAbsolute(overlayPath), true);
  assert.strictEqual(overlayPath, path.join(
    directory,
    '.integrations',
    'vscode-sidebar',
    'vscode-embed.overlay.yml'
  ));

  const written = fs.readFileSync(overlayPath, 'utf8');
  assert.strictEqual(written, rendered);
  assert.strictEqual(written.includes('better-sidebar'), true);
  assert.strictEqual(written.includes('ui-dsh-aionui-panel'), true);
  assert.strictEqual(written.includes('disabled: true'), true);
  assert.strictEqual(written.includes(marker), false);
});

test('writeEmbedOverlay requires a non-empty absolute directory', () => {
  assert.throws(() => writeEmbedOverlay(''), /non-empty absolute path/);
  assert.throws(() => writeEmbedOverlay('relative/dir'), /non-empty absolute path/);
});

test('writeEmbedOverlay accepts injected fs operations', () => {
  const calls = [];
  const directory = path.join(os.tmpdir(), 'dsh-embed-injected');
  const returned = writeEmbedOverlay(directory, {
    mkdirSync: (dir, options) => {
      calls.push(['mkdir', dir, options]);
    },
    writeFileSync: (file, content, options) => {
      calls.push(['write', file, options]);
      assert.strictEqual(content, renderEmbedOverlay());
    },
    renameSync: (source, destination) => calls.push(['rename', source, destination]),
    chmodSync: (file, mode) => calls.push(['chmod', file, mode]),
  });
  assert.strictEqual(returned, path.join(directory, '.integrations', 'vscode-sidebar', 'vscode-embed.overlay.yml'));
  assert.strictEqual(calls[0][0], 'mkdir');
  assert.deepStrictEqual(calls[0][2], { recursive: true });
  assert.strictEqual(calls[1][0], 'write');
  assert.match(calls[1][1], /\.vscode-embed\.overlay\.\d+\.tmp$/);
  assert.deepStrictEqual(calls[1][2], { encoding: 'utf8', mode: 0o600 });
  assert.deepStrictEqual(calls[2], ['rename', calls[1][1], returned]);
  assert.deepStrictEqual(calls[3], ['chmod', returned, 0o600]);
});

test('ServerManager fails closed when auto-start has no resolved runtime', async () => {
  const manager = new ServerManager();
  manager.probeWithRetry = async () => ({ reachable: false });
  manager._findFreePort = async () => 43123;
  await assert.rejects(
    manager.ensureServer({ host: '127.0.0.1', port: 43123, autoStart: true }),
    /Managed DSH runtime is unavailable/
  );
  assert.strictEqual(manager.hasOwnedChild(), false);
});

test('ServerManager child environment pins managed DSH home and editor', (t) => {
  const runtime = fixture(t);
  const manager = new ServerManager({
    resolvedRuntime: runtime,
    spawnEnv: { DSH_HOME: 'wrong', DSH_TEXT_EDITOR: 'wrong', KEEP: 'yes' },
  });
  const env = manager._buildSpawnEnv();
  assert.strictEqual(env.DSH_HOME, runtime.dshHome);
  assert.strictEqual(env.DSH_TEXT_EDITOR, 'vscode');
  assert.strictEqual(env.KEEP, 'yes');
});
