'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { ensureDshOnPath } = require('../src/runtimeEnvironment');

test('Windows runtime PATH appends the npm user bin once', () => {
  const env = { PATH: 'C:\\Windows', APPDATA: 'C:\\Users\\test\\AppData\\Roaming' };
  const expected = path.join(env.APPDATA, 'npm');
  ensureDshOnPath({ env, platform: 'win32' });
  assert.deepStrictEqual(env.PATH.split(path.delimiter), ['C:\\Windows', expected]);
  ensureDshOnPath({ env, platform: 'win32' });
  assert.deepStrictEqual(env.PATH.split(path.delimiter), ['C:\\Windows', expected]);
});

test('POSIX runtime PATH adds only existing candidates and tolerates probe errors', () => {
  const env = { PATH: '/usr/bin', HOME: '/home/test' };
  const existing = new Set([
    path.join(env.HOME, '.local', 'bin'),
    '/usr/local/bin',
  ]);
  ensureDshOnPath({
    env,
    platform: 'linux',
    existsSync(directory) {
      if (directory.endsWith(`${path.sep}.yarn${path.sep}bin`)) throw new Error('probe failed');
      return existing.has(directory);
    },
  });
  assert.deepStrictEqual(env.PATH.split(path.delimiter), [
    '/usr/bin',
    path.join(env.HOME, '.local', 'bin'),
    '/usr/local/bin',
  ]);
});
