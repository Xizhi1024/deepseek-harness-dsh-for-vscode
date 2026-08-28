'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  LAUNCH_METHODS,
  normalizeLaunchMethod,
  lookupOnPath,
  resolveCommandRuntime,
} = require('../../src/launchMethodResolver');

const NPM_CMD_SHIM = '"%_prog%"  "%dp0%\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*';
const fileStat = { isDirectory: () => false, isFile: () => true };

test('normalizeLaunchMethod accepts only the documented values', () => {
  assert.deepStrictEqual([...LAUNCH_METHODS], ['auto', 'managed', 'command']);
  assert.strictEqual(normalizeLaunchMethod('command'), 'command');
  assert.strictEqual(normalizeLaunchMethod('MANAGED'), 'managed');
  assert.strictEqual(normalizeLaunchMethod('bogus'), 'auto');
  assert.strictEqual(normalizeLaunchMethod(''), 'auto');
});

test('lookupOnPath uses where.exe on win32 and which elsewhere', async () => {
  const calls = [];
  const execFn = async (file, args) => {
    calls.push([file, ...args]);
    return file === 'where.exe' ? 'C:\\x\\dsh.cmd' : '/usr/local/bin/dsh';
  };
  assert.strictEqual(await lookupOnPath('dsh', { platform: 'win32', execFn }), 'C:\\x\\dsh.cmd');
  assert.strictEqual(await lookupOnPath('dsh', { platform: 'darwin', execFn }), '/usr/local/bin/dsh');
  assert.deepStrictEqual(calls, [['where.exe', 'dsh'], ['which', 'dsh']]);

  const failing = async () => null;
  assert.strictEqual(await lookupOnPath('missing', { platform: 'linux', execFn: failing }), null);
});

test('resolveCommandRuntime spawns the absolute executable directly on POSIX', async () => {
  const runtime = await resolveCommandRuntime({
    command: 'dsh',
    dshHome: '/tmp/dsh-home',
    platform: 'darwin',
    env: {},
    deps: {
      execFn: async () => '/usr/local/bin/dsh',
      stat: async (p) => (p === '/usr/local/bin/dsh' ? fileStat : Promise.reject(new Error('ENOENT'))),
    },
  });
  assert.strictEqual(runtime.executablePath, '/usr/local/bin/dsh');
  assert.deepStrictEqual([...runtime.entrypointArgs], []);
  assert.strictEqual(runtime.source, 'command-path');
  assert.strictEqual(runtime.profileHome, path.join('/tmp/dsh-home', 'profiles', 'web'));
});

test('resolveCommandRuntime parses a Windows shim into node + bin.js (never executes it)', async () => {
  const root = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh';
  const binJs = path.win32.join(root, 'lib', 'bin.js');
  const manifest = { name: '@deepseek-ai/dsh', version: '0.1.1-rc.1', bin: { dsh: 'lib/bin.js' } };
  const runtime = await resolveCommandRuntime({
    command: 'dsh',
    dshHome: 'C:\\dsh-home',
    platform: 'win32',
    env: { Path: 'C:\\Users\\dev\\AppData\\Roaming\\npm;C:\\Program Files\\nodejs' },
    deps: {
      execFn: async () => 'C:\\Users\\dev\\AppData\\Roaming\\npm\\dsh.cmd',
      readFile: async (p) => (path.win32.basename(p) === 'package.json'
        ? JSON.stringify(manifest)
        : NPM_CMD_SHIM),
      stat: async (p) => {
        if (typeof p === 'string' && (p === binJs || /node\.exe$/i.test(p))) return fileStat;
        return Promise.reject(new Error('ENOENT'));
      },
    },
  });
  assert.strictEqual(runtime.source, 'command-shim');
  assert.strictEqual(runtime.dshVersion, '0.1.1-rc.1');
  assert.ok(/node\.exe$/i.test(runtime.executablePath), 'launches node.exe, never the .cmd shim');
  assert.deepStrictEqual([...runtime.entrypointArgs], [binJs]);
});

test('resolveCommandRuntime returns null when nothing resolves', async () => {
  const none = await resolveCommandRuntime({
    command: 'dsh',
    dshHome: '/tmp/dsh-home',
    platform: 'linux',
    env: {},
    deps: { execFn: async () => null },
  });
  assert.strictEqual(none, null);
});
