'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  discoverDshWebPorts,
  isForeignCommandLine,
  looksLikeDshListener,
  parsePorts,
  scanCommands,
} = require('../../src/processDiscovery');

test('parsePorts extracts unique --port values and skips port 0', () => {
  // A Windows-side scan result: both spellings are native there, so the
  // foreign-command filter must stay inert (platform: 'win32').
  const out = [
    'node /usr/lib/dsh/bin.js --profile web --port 3080',
    'node C:\\dsh\\bin.js web --port=3090',
    'dsh web --port 0',
    'node /usr/lib/dsh/bin.js --profile web --port 3080',
    'unrelated --port 9999',
  ].join('\n');
  assert.deepStrictEqual(parsePorts(out, { platform: 'win32' }), [3080, 3090]);
});

test('parsePorts reads the managed launch shape (no `web` subcommand)', () => {
  // The extension's managed spawn runs the package entrypoint directly, so a
  // `dsh.+web` shell filter never matched it and shared-instance adoption
  // silently found nothing on WSL (live bug 2026-09-18).
  const out = [
    '/home/u/.nvm/versions/node/v24.18.0/bin/node /home/u/.nvm/versions/node/v24.18.0/lib/node_modules/@deepseek-ai/dsh/lib/bin.js --profile vscode --host 127.0.0.1 --port 3081 --no-open',
    'node /usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js --profile vscode --host 127.0.0.1 --port 3082 --no-open',
  ].join('\n');
  assert.deepStrictEqual(parsePorts(out), [3081, 3082]);
});

// The live leak of 2026-10-12: under Remote-WSL the process list shows the
// Windows-hosted DSH through interop — `/init /mnt/c/.../node.exe ... --port
// 3081` — and adopting it binds the sidebar to a Win32 workspace API that
// rejects every POSIX path. Only native command lines may be adopted.
const INTEROP_DSH_LINE = '/init /mnt/c/nvm4w/nodejs/node.exe node.exe '
  + 'C:\\Users\\VL197PX\\AppData\\Local\\pnpm\\bin/../global/v11/c7c8447f'
  + '/node_modules/@deepseek-ai/dsh/lib/bin.js --profile vscode --host 127.0.0.1 --port 3081 --no-open';
const NATIVE_DSH_LINE = '/home/u/.nvm/versions/node/v24.18.0/bin/node '
  + '/home/u/.nvm/versions/node/v24.18.0/lib/node_modules/@deepseek-ai/dsh/lib/bin.js '
  + '--profile vscode --host 127.0.0.1 --port 3082 --no-open';

test('parsePorts drops Windows-side command lines on a POSIX host', () => {
  assert.deepStrictEqual(
    parsePorts([INTEROP_DSH_LINE, NATIVE_DSH_LINE].join('\n'), { platform: 'linux' }),
    [3082]
  );
  // Same output on the side that owns those command lines: the filter is inert
  // on win32, so the Windows scan keeps every hit.
  assert.deepStrictEqual(
    parsePorts([INTEROP_DSH_LINE, NATIVE_DSH_LINE].join('\n'), { platform: 'win32' }),
    [3081, 3082]
  );
});

test('isForeignCommandLine classifies the real interop shapes', () => {
  assert.strictEqual(isForeignCommandLine(INTEROP_DSH_LINE, 'linux'), true);
  assert.strictEqual(isForeignCommandLine(NATIVE_DSH_LINE, 'linux'), false);
  // A bare drive-letter path with no /init wrapper (a Windows binary spawned
  // through a different interop path) is still not native.
  assert.strictEqual(isForeignCommandLine('node.exe C:\\dsh\\lib\\bin.js --port 3080', 'linux'), true);
  assert.strictEqual(isForeignCommandLine('C:\\nvm4w\\nodejs\\node.exe /x/bin.js --port 3080', 'linux'), true);
  // "dsh" inside a Linux path is never Windows-shaped.
  assert.strictEqual(isForeignCommandLine('node /home/u/apps/dsh.exe.js --port 3080', 'linux'), false);
  // Inert on win32, where all of the above are native.
  assert.strictEqual(isForeignCommandLine(INTEROP_DSH_LINE, 'win32'), false);
  assert.strictEqual(isForeignCommandLine('node.exe C:\\dsh\\lib\\bin.js --port 3080', 'win32'), false);
});

test('discoverDshWebPorts never adopts a Windows-hosted DSH from a POSIX host', async () => {
  discoverDshWebPorts.resetCache();
  const execFn = async () => [INTEROP_DSH_LINE, NATIVE_DSH_LINE].join('\n');
  assert.deepStrictEqual(await discoverDshWebPorts({ platform: 'linux', execFn }), [3082]);
});

test('looksLikeDshListener rejects paths that merely contain "dsh"', () => {
  assert.strictEqual(looksLikeDshListener('sh -c cd \'/home/u/workspace/deepseek-harness-dsh-for-vscode\' --port 3080'), false);
  assert.strictEqual(looksLikeDshListener('node server.js --port 3080'), false);
  assert.strictEqual(looksLikeDshListener('node /usr/lib/dsh/bin.js --port 3080'), true);
  assert.strictEqual(looksLikeDshListener('dsh web --port 3080'), true);
  assert.strictEqual(looksLikeDshListener('dsh.cmd web --port=3080'), true);
  assert.strictEqual(looksLikeDshListener('node /usr/lib/dsh/bin.js --profile vscode'), false);
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
