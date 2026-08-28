'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  extractShimEntrypoints,
  expandShimToken,
  packageRootFromEntrypoint,
  packageRootsFromShim,
  executableSettingPackageRoots,
  windowsPathPackageCandidates,
  windowsGlobalLayoutCandidates,
} = require('../../src/shimResolver');

const BS = String.fromCharCode(92);
// Windows paths are assembled at runtime so this file contains NO backslash
// literals (immune to any transport-layer escape mangling).
const w = (...parts) => parts.join(BS);
const PKG_TAIL = ['node_modules', '@deepseek-ai', 'dsh'].join(BS);

const NPM_CMD_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  ':start',
  'endLocal & "%_prog%"  "%dp0%' + BS + PKG_TAIL + BS + 'lib' + BS + 'bin.js" %*',
].join(String.fromCharCode(13, 10));

const PNPM_ROOT = w('C:', 'Users', 'dev', 'AppData', 'Local', 'pnpm', 'global', '5',
  '.pnpm', '@deepseek-ai+dsh@0.1.1-rc.1', 'node_modules', '@deepseek-ai', 'dsh');
const PNPM_CMD_SHIM = 'node "' + PNPM_ROOT + BS + 'lib' + BS + 'bin.js" %*';

const PS1_SHIM = '& "C:' + BS + 'Users' + BS + 'dev' + BS + 'AppData' + BS + 'Roaming' + BS
  + 'npm' + BS + PKG_TAIL + BS + 'lib' + BS + 'bin.js" $args';

test('extractShimEntrypoints finds npm %~dp0% and pnpm absolute entrypoints', () => {
  const npmTokens = extractShimEntrypoints(NPM_CMD_SHIM);
  assert.ok(npmTokens.length >= 1, 'npm shim yields at least one token');
  // npm writes `SET dp0=%~dp0` then quotes the target with %dp0%; pnpm
  // uses %~dp0% directly — either spelling must be accepted.
  assert.ok(npmTokens.some((token) => /%[~]?dp0%/.test(token) && token.endsWith('bin.js')));

  const pnpmTokens = extractShimEntrypoints(PNPM_CMD_SHIM);
  assert.ok(pnpmTokens.some((token) => token.includes('@deepseek-ai') && token.endsWith('bin.js')));

  const psTokens = extractShimEntrypoints(PS1_SHIM);
  assert.ok(psTokens.some((token) => token.includes('bin.js')));
});

test('expandShimToken expands %~dp0% into an absolute win32 path', () => {
  const expanded = expandShimToken(
    '%~dp0%' + BS + PKG_TAIL + BS + 'lib' + BS + 'bin.js',
    w('C:', 'Users', 'dev', 'AppData', 'Roaming', 'npm')
  );
  assert.strictEqual(
    expanded,
    w('C:', 'Users', 'dev', 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  );
  assert.strictEqual(expandShimToken('relative' + BS + 'only.js', w('C:', 'x')), null);
});

test('packageRootFromEntrypoint strips the lib/bin.js tail', () => {
  assert.strictEqual(
    packageRootFromEntrypoint(w('C:', 'pnpm', 'global', '5', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')),
    w('C:', 'pnpm', 'global', '5', 'node_modules', '@deepseek-ai', 'dsh')
  );
  assert.strictEqual(packageRootFromEntrypoint('bin.js'), null);
});

test('packageRootsFromShim derives parsed and layout-fallback roots', async () => {
  const roots = await packageRootsFromShim(w('C:', 'prefix', 'dsh.cmd'), {
    readFile: async () => NPM_CMD_SHIM,
  });
  assert.ok(
    roots.includes(w('C:', 'prefix', 'node_modules', '@deepseek-ai', 'dsh')),
    'parsed root present: ' + roots.join(',')
  );

  const pnpmRoots = await packageRootsFromShim(w('C:', 'Users', 'dev', 'AppData', 'Local', 'pnpm', 'dsh.cmd'), {
    readFile: async () => PNPM_CMD_SHIM,
  });
  assert.ok(
    pnpmRoots.includes(PNPM_ROOT),
    'pnpm absolute root recovered: ' + pnpmRoots.join(',')
  );
});

test('windowsPathPackageCandidates probes the segment and its parent', () => {
  const candidates = windowsPathPackageCandidates({
    Path: [w('C:', 'a', 'bin'), w('C:', 'b'), '', w('C:', 'c')].join(';'),
  });
  assert.strictEqual(candidates.length, 6);
  assert.strictEqual(candidates[0], w('C:', 'a', 'bin', 'node_modules', '@deepseek-ai', 'dsh'));
  assert.strictEqual(candidates[1], w('C:', 'a', 'node_modules', '@deepseek-ai', 'dsh'));
});

test('windowsGlobalLayoutCandidates covers pnpm, yarn, scoop, volta', () => {
  const env = { LOCALAPPDATA: w('C:', 'U', 'AppData', 'Local'), USERPROFILE: w('C:', 'U') };
  const { sync, voltaRoots } = windowsGlobalLayoutCandidates(env);
  const joined = sync.join('|');
  for (const marker of [['pnpm','global','5'], ['Yarn','config','global'], ['scoop','persist','nodejs'], ['AppData','Roaming','npm']]) {
    assert.ok(joined.includes(marker.join(BS)), 'missing layout: ' + marker.join(BS));
  }
  assert.strictEqual(voltaRoots.length, 1);
  assert.ok(voltaRoots[0].includes('.volta'));
});

test('executableSettingPackageRoots accepts dir, entrypoint, and shim inputs', async () => {
  const dirStat = { isDirectory: () => true, isFile: () => false };
  const fileStat = { isDirectory: () => false, isFile: () => true };

  const asDir = await executableSettingPackageRoots(w('C:', 'pkg'), { platform: 'win32', stat: async () => dirStat });
  assert.deepStrictEqual(asDir, { packageRoots: [w('C:', 'pkg')] });

  const asJs = await executableSettingPackageRoots(w('C:', 'pkg', 'lib', 'bin.js'), { platform: 'win32', stat: async () => fileStat });
  assert.deepStrictEqual(asJs, { packageRoots: [w('C:', 'pkg')] });

  const asCmd = await executableSettingPackageRoots(w('C:', 'prefix', 'dsh.cmd'), {
    platform: 'win32',
    stat: async () => fileStat,
    readFile: async () => NPM_CMD_SHIM,
  });
  assert.ok(asCmd.packageRoots.includes(w('C:', 'prefix', 'node_modules', '@deepseek-ai', 'dsh')));

  const missing = await executableSettingPackageRoots(w('C:', 'nope', 'dsh.cmd'), {
    platform: 'win32',
    stat: async () => { throw new Error('ENOENT'); },
  });
  assert.strictEqual(missing.error, 'not-found');
});
