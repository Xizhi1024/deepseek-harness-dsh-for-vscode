'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { discoverDshWebPorts, parsePorts, scanCommands } = require('../../src/processDiscovery');

test('parsePorts extracts unique --port values and skips port 0', () => {
  const out = [
    'node /usr/lib/dsh/bin.js --profile web --port 3080',
    'node C:\\dsh\\bin.js web --port=3090',
    'dsh web --port 0',
    'node /usr/lib/dsh/bin.js --profile web --port 3080',
    'unrelated --port 9999',
  ].join('\n');
  assert.deepStrictEqual(parsePorts(out), [3080, 3090, 9999]);
});

test('scanCommands builds the platform-specific scan', () => {
  const win = scanCommands('win32');
  assert.strictEqual(win[0].file, 'powershell.exe');
  assert.ok(win[0].args.join(' ').includes('Win32_Process'));

  const posix = scanCommands('darwin');
  assert.strictEqual(posix[0].file, 'sh');
  assert.ok(posix[0].args.join(' ').includes('ps -eo command'));
});

test('discoverDshWebPorts parses exec output and caches within TTL', async () => {
  discoverDshWebPorts.resetCache();
  let calls = 0;
  const execFn = async () => {
    calls += 1;
    return 'node /x/dsh/bin.js --profile web --port 4321';
  };
  const first = await discoverDshWebPorts({ platform: 'linux', execFn });
  assert.deepStrictEqual(first, [4321]);

  const second = await discoverDshWebPorts({ platform: 'linux', execFn });
  assert.deepStrictEqual(second, [4321]);
  assert.strictEqual(calls, 1, 'cache serves the second call without re-exec');
});

test('discoverDshWebPorts yields [] on exec failure (best-effort)', async () => {
  discoverDshWebPorts.resetCache();
  const ports = await discoverDshWebPorts({
    platform: 'win32',
    execFn: async () => { throw new Error('powershell missing'); },
  });
  assert.deepStrictEqual(ports, []);
});
