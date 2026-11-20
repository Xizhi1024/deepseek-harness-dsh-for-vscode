'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { installNpmRuntime, resolveNpmRuntime } = require('../src/npmRuntime');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-npm-runtime-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { storageRoot: path.join(root, 'storage'), dshHome: path.join(root, '.dsh'), version: '0.2.2-rc.5' };
}

test('automatic installation selects a checksum-pinned Node archive for each supported OS and architecture', async (t) => {
  const options = await fixture(t);
  const unavailable = new Error('offline');
  for (const platform of ['darwin', 'linux', 'win32']) {
    for (const arch of ['arm64', 'x64']) {
      await assert.rejects(installNpmRuntime({ ...options, platform, arch }, {
        downloader: {
          async download({ url, sha256 }) {
            const expectedPlatform = platform === 'win32' ? 'win' : platform;
            const extension = platform === 'win32' ? 'zip' : 'tar.gz';
            assert.equal(new URL(url).origin, 'https://nodejs.org');
            assert.ok(url.endsWith(`-${expectedPlatform}-${arch}.${extension}`));
            assert.match(sha256, /^[0-9a-f]{64}$/);
            throw unavailable;
          },
        },
      }), (error) => error === unavailable);
      assert.deepEqual(await fs.readdir(path.join(options.storageRoot, 'npm', `${platform}-${arch}`)), []);
    }
  }
});

test('failed npm installation can be retried, concurrent installs publish one complete runtime, and subsequent calls reuse it', {
  skip: !['win32', 'darwin', 'linux'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch),
}, async (t) => {
  const options = await fixture(t);
  const windows = process.platform === 'win32';
  const archive = 'test-node-distribution';
  const deps = {
    downloader: { async download() { return archive; } },
    async runCommand(command, args, { cwd }) {
      if (args[0] === '-xf') {
        const node = path.join(cwd, 'node-v24.22.3-' + (windows ? 'win' : process.platform) + '-' + process.arch,
          windows ? 'node.exe' : 'bin/node');
        await fs.mkdir(path.dirname(node), { recursive: true });
        await fs.writeFile(node, '', { mode: 0o755 });
        return '';
      }
      if (args[1] === 'install') {
        assert.equal(args[args.indexOf('--prefix') + 1], cwd);
        assert.equal(args.at(-1), `@deepseek-ai/dsh@${options.version}`);
        const root = path.join(cwd, 'node_modules', '@deepseek-ai', 'dsh');
        await fs.mkdir(root, { recursive: true });
        await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
          name: '@deepseek-ai/dsh', version: options.version, bin: { dsh: 'cli.js' },
        }));
        await fs.writeFile(path.join(root, 'cli.js'), '');
        return '';
      }
      assert.equal(args[1], '--version');
      return options.version;
    },
  };
  assert.equal(await resolveNpmRuntime(options), null);
  await assert.rejects(installNpmRuntime(options, {
    ...deps,
    async runCommand(...args) {
      if (args[1][1] === 'install') throw new Error('npm install failed');
      return deps.runCommand(...args);
    },
  }), /npm install failed/);
  assert.equal(await resolveNpmRuntime(options), null);

  const [first, second] = await Promise.all([installNpmRuntime(options, deps), installNpmRuntime(options, deps)]);
  assert.deepEqual(first, second);
  assert.equal(first.source, 'extension-npm-install');
  assert.equal(first.dshVersion, options.version);
  assert.ok(first.executablePath.startsWith(first.payloadRoot + path.sep));
  assert.deepEqual(await fs.readdir(path.dirname(first.payloadRoot)), [options.version]);
  assert.deepEqual(await resolveNpmRuntime(options), first);
  assert.deepEqual(await installNpmRuntime(options, {
    downloader: { download() { assert.fail('existing install should be reused'); } },
  }), first);
});
