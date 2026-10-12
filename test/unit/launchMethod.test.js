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
  // resolve (not join): the resolver anchors POSIX-style roots to the current
  // drive on win32 hosts, so mirror that with path.resolve for a host-neutral expectation
  assert.strictEqual(runtime.profileHome, path.resolve('/tmp/dsh-home', 'profiles', 'web'));
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

test('resolveCommandRuntime parses pnpm extensionless sh shim (where.exe returns it first)', async () => {
  // pnpm's store directory is a content hash, and `where.exe dsh` returns the
  // extensionless `sh` shim ahead of dsh.cmd — the hit that used to be
  // rejected outright, stranding every pnpm-global install.
  const local = 'C:\\Users\\dev\\AppData\\Local\\pnpm';
  const root = path.win32.join(local, 'global', '5', '.pnpm',
    '@deepseek-ai+dsh@0.1.7-rc.1_4a0342b4', 'node_modules', '@deepseek-ai', 'dsh');
  const binJs = path.win32.join(root, 'lib', 'bin.js');
  const shimPath = path.win32.join(local, 'bin', 'dsh');
  const runtime = await resolveCommandRuntime({
    command: 'dsh',
    dshHome: 'C:\\dsh-home',
    platform: 'win32',
    env: { Path: 'C:\\Users\\dev\\AppData\\Local\\pnpm\\bin;C:\\Program Files\\nodejs' },
    deps: {
      execFn: async () => shimPath,
      readFile: async (p) => (path.win32.basename(p) === 'package.json'
        ? JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.7-rc.1', bin: { dsh: 'lib/bin.js' } })
        : 'exec node  "$basedir/../global/5/.pnpm/@deepseek-ai+dsh@0.1.7-rc.1_4a0342b4'
          + '/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"'),
      stat: async (p) => {
        if (typeof p === 'string' && (p === binJs || /node\.exe$/i.test(p))) return fileStat;
        return Promise.reject(new Error('ENOENT'));
      },
    },
  });
  assert.strictEqual(runtime.source, 'command-shim');
  assert.strictEqual(runtime.dshVersion, '0.1.7-rc.1');
  assert.ok(/node\.exe$/i.test(runtime.executablePath), 'launches node.exe, never the sh shim');
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

// ---------------------------------------------------------------------------
// POSIX hosts (Remote-WSL / Remote-SSH).
//
// Two leaks made a WSL window launch a Windows-hosted DSH: the extension-host
// PATH holds the Windows-side pnpm shim (interop), and pnpm's own POSIX shim
// converts itself to node.exe whenever `uname -a` says WSL2 and no native node
// sits next to it. Both are closed here by (a) skipping PATH hits under a
// Windows mount and (b) never spawning a shim — always parsing it into
// (native node, package entrypoint).
const POSIX_SHIM_TEXT = [
  '#!/bin/sh',
  'basedir=/home/u/.local/share/pnpm/bin',
  'exe=""',
  'case `command -p uname -a` in',
  '  *WSL2*)',
  '    if converted=$(command -p wslpath -w "$basedir" 2>/dev/null) && [ -n "$converted" ]; then',
  '      basedir_win="$converted"',
  '      exe=".exe"',
  '    fi',
  '  ;;',
  'esac',
  'if [ -n "$exe" ] && [ -x "$basedir/node.exe" ]; then',
  '  exec "$basedir/node.exe" "$basedir_win/../global/v11/HASH/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"',
  'fi',
  'exec node "$basedir/../global/v11/HASH/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"',
  '# cmd-shim-target=/home/u/.local/share/pnpm/global/v11/HASH/node_modules/@deepseek-ai/dsh/lib/bin.js',
].join('\n').split('HASH').join(
  'c7c8447fc30badd8e10ff1ece58d6ef3660f5f1cfbaf2f6c51a6d8a725822bde'
);
const POSIX_STORE_ROOT = '/home/u/.local/share/pnpm/global/v11/'
  + 'c7c8447fc30badd8e10ff1ece58d6ef3660f5f1cfbaf2f6c51a6d8a725822bde'
  + '/node_modules/@deepseek-ai/dsh';
const POSIX_BIN_JS = POSIX_STORE_ROOT + '/lib/bin.js';
const POSIX_SHIM_PATH = '/home/u/.local/share/pnpm/bin/dsh';
const WINDOWS_SIDE_SHIM = '/mnt/c/Users/u/AppData/Local/pnpm/bin/dsh';

test('lookupOnPath returns every POSIX hit with which -a', async () => {
  const posixCalls = [];
  const posixExec = async (file, args) => {
    posixCalls.push([file, ...args]);
    return WINDOWS_SIDE_SHIM + '\n/usr/local/bin/dsh\n';
  };
  assert.deepStrictEqual(
    await lookupOnPath('dsh', { platform: 'linux', execFn: posixExec, all: true }),
    [WINDOWS_SIDE_SHIM, '/usr/local/bin/dsh']
  );
  assert.deepStrictEqual(posixCalls, [['which', '-a', 'dsh']]);

  // where.exe has no -a: Windows keeps its single-hit lookup.
  const winCalls = [];
  const winExec = async (file, args) => {
    winCalls.push([file, ...args]);
    return 'C:\\x\\dsh.cmd\nC:\\y\\dsh.cmd\n';
  };
  assert.strictEqual(await lookupOnPath('dsh', { platform: 'win32', execFn: winExec, all: true }), 'C:\\x\\dsh.cmd');
  assert.deepStrictEqual(winCalls, [['where.exe', 'dsh']]);

  assert.deepStrictEqual(
    await lookupOnPath('dsh', { platform: 'linux', execFn: async () => null, all: true }),
    []
  );
});

test('resolveCommandRuntime refuses a foreign-only POSIX PATH without stat-ing it', async () => {
  let statCalls = 0;
  let thrown = null;
  try {
    await resolveCommandRuntime({
      command: 'dsh',
      dshHome: '/tmp/dsh-home',
      platform: 'linux',
      env: {},
      deps: {
        execFn: async () => WINDOWS_SIDE_SHIM,
        stat: async () => { statCalls += 1; return fileStat; },
      },
    });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'a foreign-only PATH must refuse, not silently return null');
  assert.strictEqual(thrown.code, 'RUNTIME_FOREIGN_ENVIRONMENT');
  assert.strictEqual(thrown.params.path, WINDOWS_SIDE_SHIM);
  assert.ok(typeof thrown.params.host === 'string' && thrown.params.host.length > 0);
  assert.strictEqual(statCalls, 0, 'the foreign hit is never touched');
});

test('resolveCommandRuntime skips a foreign hit and parses the native POSIX shim', async () => {
  const runtime = await resolveCommandRuntime({
    command: 'dsh',
    dshHome: '/home/u/.dsh',
    platform: 'linux',
    env: { PATH: '/home/u/.local/share/pnpm/bin:/usr/bin' },
    deps: {
      execFn: async () => [WINDOWS_SIDE_SHIM, POSIX_SHIM_PATH].join('\n'),
      readFile: async (p) => (String(p).endsWith('package.json')
        ? JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.7-rc.2', bin: { dsh: 'lib/bin.js' } })
        : POSIX_SHIM_TEXT),
      stat: async (p) => {
        // The shim itself is a real file on PATH; the Windows-side hit above
        // it must not even be stat-ed (see the refusal test).
        if (p === POSIX_BIN_JS || p === '/usr/bin/node' || p === POSIX_SHIM_PATH) return fileStat;
        return Promise.reject(new Error('ENOENT'));
      },
    },
  });
  assert.strictEqual(runtime.source, 'command-shim');
  assert.strictEqual(runtime.executablePath, '/usr/bin/node');
  assert.deepStrictEqual([...runtime.entrypointArgs], [POSIX_BIN_JS]);
  assert.strictEqual(runtime.dshVersion, '0.1.7-rc.2');
  assert.ok(!runtime.executablePath.includes('/mnt/c'), 'never a Windows-mounted node');
  assert.strictEqual(runtime.profileHome, path.resolve('/home/u/.dsh', 'profiles', 'web'));
});

test('resolveCommandRuntime refuses an unverifiable shim that self-converts to Windows', async () => {
  let thrown = null;
  try {
    await resolveCommandRuntime({
      command: 'dsh',
      dshHome: '/home/u/.dsh',
      platform: 'linux',
      env: { PATH: '/home/u/.local/share/pnpm/bin' },
      deps: {
        execFn: async () => POSIX_SHIM_PATH,
        // The package behind the shim cannot be verified (a foreign/other
        // package.json), so the shim itself would be the only thing left to
        // spawn — and its content says it re-execs node.exe on WSL2.
        readFile: async (p) => (String(p).endsWith('package.json')
          ? JSON.stringify({ name: 'not-dsh' })
          : POSIX_SHIM_TEXT),
        stat: async (p) => (p === POSIX_SHIM_PATH
          ? fileStat
          : Promise.reject(new Error('ENOENT'))),
      },
    });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'expected a refusal');
  assert.strictEqual(thrown.code, 'RUNTIME_FOREIGN_ENVIRONMENT');
  assert.match(thrown.message, /wslpath|node\.exe/);
});

test('resolveCommandRuntime keeps a plain POSIX binary on the command-path source', async () => {
  const runtime = await resolveCommandRuntime({
    command: 'dsh',
    dshHome: '/home/u/.dsh',
    platform: 'linux',
    env: { PATH: '/usr/local/bin' },
    deps: {
      execFn: async () => '/usr/local/bin/dsh\n',
      readFile: async () => '#!/bin/sh\nexec node /usr/local/lib/dsh.js "$@"\n',
      stat: async (p) => (p === '/usr/local/bin/dsh'
        ? fileStat
        : Promise.reject(new Error('ENOENT'))),
    },
  });
  assert.strictEqual(runtime.source, 'command-path');
  assert.strictEqual(runtime.executablePath, '/usr/local/bin/dsh');
  assert.deepStrictEqual([...runtime.entrypointArgs], []);
});
