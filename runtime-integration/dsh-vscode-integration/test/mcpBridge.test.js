import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_SERVERS,
  createMcpBridge,
  existingLoaderServerNames,
  normalizeServer,
  normalizeServers,
} from '../lib/mcpBridge.js';

function stdio(name, overrides = {}) {
  return {
    name,
    type: 'stdio',
    command: 'node',
    args: ['server.js'],
    env: { TOKEN: 't' },
    ...overrides,
  };
}

function http(name, overrides = {}) {
  return {
    name,
    type: 'http',
    url: 'http://127.0.0.1:1234/mcp',
    headers: { Authorization: 'Bearer t' },
    ...overrides,
  };
}

test('normalizeServer maps stdio and http records to dsh-mcp-client configs', () => {
  assert.deepStrictEqual(normalizeServer(stdio('local', { cwd: '/tmp/x' }), 0), {
    name: 'local',
    config: {
      transport: 'stdio',
      serverName: 'local',
      command: 'node',
      args: ['server.js'],
      env: { TOKEN: 't' },
      cwd: '/tmp/x',
    },
  });
  assert.deepStrictEqual(normalizeServer(http('web'), 1), {
    name: 'web',
    config: {
      transport: 'streamable-http',
      serverName: 'web',
      url: 'http://127.0.0.1:1234/mcp',
      headers: { Authorization: 'Bearer t' },
    },
  });
  // defaults fill in the optional collections
  assert.deepStrictEqual(normalizeServer({ name: 'plain', type: 'stdio', command: 'node' }, 0).config, {
    transport: 'stdio',
    serverName: 'plain',
    command: 'node',
    args: [],
    env: {},
    cwd: '',
  });
});

test('normalizeServer rejects malformed names, commands, args and urls', () => {
  for (const [record, pattern] of [
    [null, /must be an object/],
    [{ type: 'stdio', command: 'node' }, /name must match/],
    [{ name: 'has space', type: 'stdio', command: 'node' }, /name must match/],
    [{ name: 'x', type: 'stdio', command: '   ' }, /command must be a non-empty string/],
    [stdio('x', { args: ['ok', 7] }), /args must be an array of strings/],
    [stdio('x', { env: { A: 1 } }), /env must be an object of strings/],
    [stdio('x', { cwd: 7 }), /cwd must be a string/],
    [{ name: 'x', type: 'http', url: 'file:///tmp/x' }, /absolute HTTP\(S\) URL/],
    [{ name: 'x', type: 'http', url: 'http://x', headers: { A: 1 } }, /headers must be an object of strings/],
    [{ name: 'x', type: 'sse', url: 'http://x' }, /type must be/],
  ]) {
    assert.match(normalizeServer(record, 0).error, pattern);
  }
});

test('normalizeServers dedupes names and keeps per-record diagnostics', () => {
  const { entries, rejected } = normalizeServers([
    stdio('same'),
    stdio('same'),
    { name: 'bad name', type: 'stdio', command: 'node' },
  ]);
  assert.deepStrictEqual(entries.map((entry) => entry.name), ['same']);
  assert.strictEqual(rejected.length, 2);
  assert.match(rejected[0].error, /duplicate serverName/);
  assert.match(rejected[1].error, /name must match/);
});

test('normalizeServers rejects a non-array batch and the server cap', () => {
  assert.throws(() => normalizeServers(null), /must be an array/);
  assert.throws(() => normalizeServers('nope'), /must be an array/);
  assert.throws(
    () => normalizeServers(Array.from({ length: MAX_SERVERS + 1 }, (_, index) => stdio(`s${index}`))),
    /server limit/,
  );
});

test('existingLoaderServerNames reads only configured dsh-mcp-client rows', () => {
  const loader = {
    *entries() {
      yield { options: { name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'user-owned' } } };
      yield { options: { name: 'dsh-vscode-integration', config: {} } };
      yield { options: { name: '@deepseek-ai/dsh-mcp-client', config: {} } };
      yield { options: {} };
    },
  };
  assert.deepStrictEqual([...existingLoaderServerNames(loader)], ['user-owned']);
  assert.deepStrictEqual([...existingLoaderServerNames(null)], []);
});

function fakeBridgeHarness({ existingNames = [] } = {}) {
  const log = [];
  const calls = [];
  const children = [];
  const ctx = {
    get(name) {
      if (name !== 'loader') return undefined;
      return {
        entries: () => existingNames.map((serverName) => ({
          options: { name: '@deepseek-ai/dsh-mcp-client', config: { serverName } },
        })),
        import: async () => ({ name: 'fake-mcp-client', apply() {} }),
      };
    },
    plugin(namespace, config) {
      const child = {
        config,
        disposed: 0,
        async dispose() {
          child.disposed += 1;
        },
        then(onFulfilled, onRejected) {
          return Promise.resolve().then(() => {
            if (config.serverName === 'broken') {
              return onRejected ? onRejected(new Error('mount failed')) : undefined;
            }
            return onFulfilled ? onFulfilled(undefined) : undefined;
          });
        },
      };
      calls.push(config);
      children.push(child);
      return child;
    },
  };
  const bridge = createMcpBridge({ ctx, log: (line) => log.push(line), mountTimeoutMs: 1000 });
  return { bridge, calls, children, log };
}

test('createMcpBridge mounts new servers, keeps unchanged ones and removes stale ones', async () => {
  const { bridge, calls, children } = fakeBridgeHarness();
  const first = await bridge.apply([stdio('a'), http('b')]);
  assert.deepStrictEqual(first.mounted, ['a', 'b']);
  assert.deepStrictEqual(first.rejected, []);
  assert.strictEqual(calls.length, 2);

  // Same snapshot: no remount.
  const second = await bridge.apply([stdio('a'), http('b')]);
  assert.deepStrictEqual(second.mounted, []);
  assert.deepStrictEqual(second.removed, []);
  assert.strictEqual(calls.length, 2);

  // Changed token on a, b removed, c added: only a and b are disposed.
  const third = await bridge.apply([stdio('a', { env: { TOKEN: 'new' } }), stdio('c')]);
  assert.deepStrictEqual(third.removed.sort(), ['a', 'b']);
  assert.deepStrictEqual(third.mounted, ['a', 'c']);
  assert.strictEqual(children[0].disposed, 1);
  assert.strictEqual(children[1].disposed, 1);
  assert.strictEqual(children[2].disposed, 0);
  assert.strictEqual(children[3].disposed, 0);
});

test('createMcpBridge skips serverNames owned by the user profile', async () => {
  const { bridge, calls } = fakeBridgeHarness({ existingNames: ['shared'] });
  const result = await bridge.apply([stdio('shared'), stdio('fresh')]);
  assert.deepStrictEqual(result.mounted, ['fresh']);
  assert.deepStrictEqual(result.rejected.map((entry) => entry.server), ['shared']);
  assert.strictEqual(calls.length, 1);
});

test('createMcpBridge reports mount failures without leaving an active entry', async () => {
  const { bridge } = fakeBridgeHarness();
  const result = await bridge.apply([stdio('broken', { failMount: true })]);
  assert.deepStrictEqual(result.mounted, []);
  assert.strictEqual(result.rejected.length, 1);
  assert.match(result.rejected[0].error, /mount failed/);
  assert.strictEqual(result.active, 0);
});

test('createMcpBridge dispose stops every mounted child and rejects later applies', async () => {
  const { bridge, children } = fakeBridgeHarness();
  await bridge.apply([stdio('a'), stdio('b')]);
  await bridge.dispose();
  assert.strictEqual(children[0].disposed, 1);
  assert.strictEqual(children[1].disposed, 1);
  const after = await bridge.apply([stdio('c')]);
  assert.strictEqual(after.disposed, true);
  assert.strictEqual(after.active, 0);
});

test('createMcpBridge serializes concurrent applies', async () => {
  const { bridge, calls } = fakeBridgeHarness();
  const [one, two] = await Promise.all([
    bridge.apply([stdio('a')]),
    bridge.apply([stdio('a'), stdio('b')]),
  ]);
  assert.deepStrictEqual(one.mounted, ['a']);
  assert.deepStrictEqual(two.mounted, ['b']);
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual([...bridge.activeNames].sort(), ['a', 'b']);
});