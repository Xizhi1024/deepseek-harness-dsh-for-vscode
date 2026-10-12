'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const {
  SHARE_MODES,
  WSL_SHARED_DEFAULT_PORT,
  normalizeShareMode,
  detectRuntimeEnvironment,
  resolveSharedEndpointPort,
  hostEnvironmentLabel,
  windowsMountRoots,
  isForeignHostPath,
  detectProcessEnvironment,
} = require('../src/runtimeEnvironment');

const OS_RELEASE_PATH = '/proc/sys/kernel/osrelease';

function readerFor(content) {
  return (path) => {
    if (path === OS_RELEASE_PATH) {
      if (content === null) throw new Error('ENOENT');
      return content;
    }
    throw new Error('unexpected read: ' + path);
  };
}

test('detectRuntimeEnvironment classifies Windows extension hosts', () => {
  const environment = detectRuntimeEnvironment({
    platform: 'win32',
    env: {},
    readFile: readerFor(null),
    fresh: true,
  });
  assert.deepStrictEqual(
    { id: environment.id, isWsl: environment.isWsl, platform: environment.platform },
    { id: 'windows', isWsl: false, platform: 'win32' }
  );
});

test('detectRuntimeEnvironment classifies WSL via WSL_DISTRO_NAME', () => {
  const environment = detectRuntimeEnvironment({
    platform: 'linux',
    env: { WSL_DISTRO_NAME: 'Ubuntu' },
    readFile: readerFor(null), // no /proc access needed when the env var is set
    fresh: true,
  });
  assert.strictEqual(environment.id, 'wsl');
  assert.strictEqual(environment.isWsl, true);
});

test('detectRuntimeEnvironment classifies WSL via the Microsoft kernel marker', () => {
  for (const release of [
    '5.15.153.1-microsoft-standard-WSL2\n',
    '4.4.0-19041-Microsoft\n',
  ]) {
    const environment = detectRuntimeEnvironment({
      platform: 'linux',
      env: {},
      readFile: readerFor(release),
      fresh: true,
    });
    assert.strictEqual(environment.id, 'wsl');
    assert.strictEqual(environment.isWsl, true);
  }
});

test('detectRuntimeEnvironment classifies plain Linux and other platforms', () => {
  const linux = detectRuntimeEnvironment({
    platform: 'linux',
    env: {},
    readFile: readerFor('5.15.0-generic\n'),
    fresh: true,
  });
  assert.deepStrictEqual({ id: linux.id, isWsl: linux.isWsl }, { id: 'linux', isWsl: false });

  const mac = detectRuntimeEnvironment({
    platform: 'darwin',
    env: {},
    readFile: readerFor(null),
    fresh: true,
  });
  assert.deepStrictEqual({ id: mac.id, isWsl: mac.isWsl }, { id: 'other', isWsl: false });
});

test('detectRuntimeEnvironment results are frozen and memoized', () => {
  let reads = 0;
  const options = {
    platform: 'linux',
    env: {},
    readFile: () => {
      reads += 1;
      return '5.15.153.1-microsoft-standard-WSL2\n';
    },
  };
  const first = detectRuntimeEnvironment({ ...options, fresh: true });
  const second = detectRuntimeEnvironment(options);
  assert.strictEqual(first, second);
  assert.strictEqual(reads, 1);
  assert.ok(Object.isFrozen(first));
});

test('normalizeShareMode falls back to the given default for unknown values', () => {
  assert.strictEqual(normalizeShareMode('environment'), SHARE_MODES.ENVIRONMENT);
  assert.strictEqual(normalizeShareMode('window'), SHARE_MODES.WINDOW);
  assert.strictEqual(normalizeShareMode(undefined), SHARE_MODES.WINDOW);
  assert.strictEqual(normalizeShareMode(undefined, SHARE_MODES.ENVIRONMENT), SHARE_MODES.ENVIRONMENT);
  assert.strictEqual(normalizeShareMode('Environment'), SHARE_MODES.WINDOW, 'matching is exact');
});

test('resolveSharedEndpointPort shifts only an unpinned default port on WSL', () => {
  const wsl = { id: 'wsl', isWsl: true, platform: 'linux' };
  const windows = { id: 'windows', isWsl: false, platform: 'win32' };
  const linux = { id: 'linux', isWsl: false, platform: 'linux' };

  // The core case: WSL, shared mode, autoStart, port left at its default.
  assert.strictEqual(resolveSharedEndpointPort({
    port: 3080, portExplicit: false, shareMode: SHARE_MODES.ENVIRONMENT, autoStart: true, environment: wsl,
  }), WSL_SHARED_DEFAULT_PORT);
  assert.strictEqual(WSL_SHARED_DEFAULT_PORT, 3081);

  // An explicitly pinned port is always honored verbatim — the user owns the topology.
  assert.strictEqual(resolveSharedEndpointPort({
    port: 3080, portExplicit: true, shareMode: SHARE_MODES.ENVIRONMENT, autoStart: true, environment: wsl,
  }), 3080);
  assert.strictEqual(resolveSharedEndpointPort({
    port: 4100, portExplicit: true, shareMode: SHARE_MODES.ENVIRONMENT, autoStart: true, environment: wsl,
  }), 4100);

  // User-managed mode keeps the configured port for backward compatibility.
  assert.strictEqual(resolveSharedEndpointPort({
    port: 3080, portExplicit: false, shareMode: SHARE_MODES.ENVIRONMENT, autoStart: false, environment: wsl,
  }), 3080);

  // Legacy window mode never shifts.
  assert.strictEqual(resolveSharedEndpointPort({
    port: 3080, portExplicit: false, shareMode: SHARE_MODES.WINDOW, autoStart: true, environment: wsl,
  }), 3080);

  // Non-WSL environments never shift.
  for (const environment of [windows, linux, null]) {
    assert.strictEqual(resolveSharedEndpointPort({
      port: 3080, portExplicit: false, shareMode: SHARE_MODES.ENVIRONMENT, autoStart: true, environment,
    }), 3080);
  }
});

test('hostEnvironmentLabel names the side of the Windows/WSL split', () => {
  assert.strictEqual(hostEnvironmentLabel({ platform: 'win32', env: {} }), 'Windows');
  assert.strictEqual(hostEnvironmentLabel({ platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' } }), 'WSL');
  assert.strictEqual(hostEnvironmentLabel({ platform: 'darwin', env: {} }), 'macOS');
});

// The real WSL mount table (verbatim from /proc/mounts on the reference
// machine): C:\134 is the octal-escaped device `C:\`, and the two tmpfs
// mounts under /mnt must never be mistaken for a foreign root.
const MOUNTS_FIXTURE = [
  'drivers /usr/lib/wsl/drivers 9p ro,nosuid,nodev,noatime,aname=drivers;fmask=222 0 0',
  'C:\\134 /mnt/c 9p rw,noatime,aname=drvfs;path=C:\\;uid=1000;gid=1000;symlinkroot=/mnt/ 0 0',
  'none /mnt/wsl tmpfs rw,relatime 0 0',
  'none /mnt/wslg tmpfs rw,relatime 0 0',
  '/dev/sdd /mnt/wslg/distro ext4 ro,relatime 0 0',
  '/dev/sdb /mnt/data ext4 rw,relatime 0 0',
  'C:\\134 /media/win-drive 9p rw,aname=drvfs;path=C:\\ 0 0',
].join('\n');

test('windowsMountRoots reads only drive-letter drvfs/9p mounts', () => {
  const roots = windowsMountRoots({
    platform: 'linux',
    mountPath: '/fixture/mounts',
    readFile: () => MOUNTS_FIXTURE,
    fresh: true,
  });
  assert.deepStrictEqual([...roots], ['/mnt/c', '/media/win-drive']);
  // A native ext4 mount under /mnt is NOT a foreign root, and the tmpfs
  // mounts under /mnt are not either; /usr/lib/wsl/drivers has no drive
  // device, so it is out as well (it is a Linux-visible driver share).
  assert.ok(!roots.includes('/mnt/data'));
  assert.ok(!roots.includes('/mnt/wslg'));
  assert.ok(!roots.includes('/mnt/wsl'));
  assert.ok(!roots.includes('/usr/lib/wsl/drivers'));
});

test('windowsMountRoots is inert off Linux and falls back only on an empty table', () => {
  assert.deepStrictEqual([...windowsMountRoots({
    platform: 'win32', mountPath: '/fixture/mounts', readFile: () => MOUNTS_FIXTURE, fresh: true,
  })], []);
  assert.deepStrictEqual([...windowsMountRoots({
    platform: 'darwin', mountPath: '/fixture/mounts', readFile: () => MOUNTS_FIXTURE, fresh: true,
  })], []);
  // Unreadable table: only the /mnt/c naming convention can apply, and only
  // when that directory exists (the dev hosts of this extension include real
  // WSL machines, so both outcomes are legitimate — assert against the real
  // filesystem rather than against one of them).
  const fallback = windowsMountRoots({
    platform: 'linux', mountPath: '/fixture/missing', readFile: () => { throw new Error('ENOENT'); }, fresh: true,
  });
  assert.deepStrictEqual([...fallback], fs.existsSync('/mnt/c') ? ['/mnt/c'] : []);
});

test('isForeignHostPath classifies Windows-side paths on a POSIX host', () => {
  const options = { platform: 'linux', mountRoots: ['/mnt/c'] };
  assert.strictEqual(isForeignHostPath('/mnt/c/Users/u/AppData/Local/pnpm/bin/dsh', options), true);
  assert.strictEqual(isForeignHostPath('/mnt/c', options), true);
  assert.strictEqual(isForeignHostPath('C:\\Users\\u\\pnpm\\dsh.cmd', options), true);
  assert.strictEqual(isForeignHostPath('/home/u/.local/share/pnpm/bin/dsh', options), false);
  // A sibling directory whose name merely starts with a root's name is native.
  assert.strictEqual(isForeignHostPath('/mnt/cache/dsh', options), false);
  // Inert on Windows and for non-absolute/empty input.
  assert.strictEqual(isForeignHostPath('/mnt/c/x', { platform: 'win32' }), false);
  assert.strictEqual(isForeignHostPath('', options), false);
  assert.strictEqual(isForeignHostPath(null, options), false);
});

test('detectProcessEnvironment recognizes a WSL interop process', () => {
  const interop = detectProcessEnvironment(6443, {
    platform: 'linux',
    procRoot: '/proc',
    readFile: () => 'node.exe\n',
    readlink: () => '/init',
  });
  assert.strictEqual(interop, 'windows');

  // exe → /init alone is enough (the comm rename can lag the exec).
  assert.strictEqual(detectProcessEnvironment(6443, {
    platform: 'linux',
    procRoot: '/proc',
    readFile: () => 'init\n',
    readlink: () => '/init',
  }), 'windows');

  // A native process is never foreign.
  assert.strictEqual(detectProcessEnvironment(1234, {
    platform: 'linux',
    procRoot: '/proc',
    readFile: () => 'node\n',
    readlink: () => '/usr/bin/node',
  }), 'unknown');

  // Unreadable (gone, or another user's process): unknown, never foreign.
  assert.strictEqual(detectProcessEnvironment(1234, {
    platform: 'linux',
    procRoot: '/proc',
    readFile: () => { throw new Error('ENOENT'); },
    readlink: () => { throw new Error('ENOENT'); },
  }), 'unknown');

  // Off Linux there is no /proc to read, and a bad pid is not looked up.
  assert.strictEqual(detectProcessEnvironment(1, {
    platform: 'win32', readFile: () => { throw new Error('must not read'); },
  }), 'unknown');
  assert.strictEqual(detectProcessEnvironment(0, {
    platform: 'linux', readFile: () => { throw new Error('must not read'); },
  }), 'unknown');
});
