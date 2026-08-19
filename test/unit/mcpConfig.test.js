'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  expandServer,
  inputKeys,
  mergeMcpSources,
} = require('../../src/mcp/config');
const { createConsentGate } = require('../../src/mcp/consent');

test('mergeMcpSources merges user/remote/workspace/file order with later wins and diagnostics', () => {
  const { servers, diagnostics } = mergeMcpSources([
    { source: 'user', servers: { alpha: { command: 'alpha-user' }, keep: { command: 'keep-user' } } },
    { source: 'workspace', servers: [{ name: 'alpha', command: 'alpha-workspace' }] },
    { source: '.vscode/mcp.json', servers: [{ name: 'keep', url: 'http://127.0.0.1:9/mcp', type: 'http' }] },
  ]);
  assert.deepStrictEqual(servers.map((server) => server.name), ['alpha', 'keep']);
  assert.strictEqual(servers[0].command, 'alpha-workspace');
  assert.strictEqual(servers[1].type, 'http');
  assert.ok(diagnostics.some((entry) => entry.message.includes('overrides')), 'overrides must be diagnosed');
});

test('expandServer expands env vars silently and disables on missing env', async () => {
  const { servers } = mergeMcpSources([
    { source: 'user', servers: [{ name: 's1', command: 'node', args: ['${env:TOKEN}'] }] },
  ]);
  const ok = await expandServer(servers[0], { env: { TOKEN: 'abc' } });
  assert.strictEqual(ok.server.args[0], 'abc');
  const disabled = await expandServer(servers[0], { env: {} });
  assert.strictEqual(disabled.disabled, true);
  assert.ok(disabled.reason.includes('env-missing: TOKEN'));
});

test('expandServer asks each input variable once and caches it', async () => {
  const { servers } = mergeMcpSources([
    { source: 'user', servers: [{ name: 's1', command: 'node', env: { KEY: '${input:apiKey}' } }] },
  ]);
  const cache = new Map();
  const asked = [];
  const askInput = async (key) => {
    asked.push(key);
    return 'secret';
  };
  const first = await expandServer(servers[0], { env: {}, inputCache: cache, askInput });
  const second = await expandServer(servers[0], { env: {}, inputCache: cache, askInput });
  assert.strictEqual(first.server.env.KEY, 'secret');
  assert.strictEqual(second.server.env.KEY, 'secret');
  assert.deepStrictEqual(asked, ['apiKey'], 'the input must be asked exactly once per session');
  assert.strictEqual(inputKeys('x${input:a}y${input:b}z').join(','), 'a,b');
});

test('expandServer disables when the user dismisses an input prompt', async () => {
  const { servers } = mergeMcpSources([
    { source: 'user', servers: [{ name: 's1', command: 'node', args: ['${input:missing}'] }] },
  ]);
  const result = await expandServer(servers[0], { env: {}, inputCache: new Map(), askInput: async () => undefined });
  assert.strictEqual(result.disabled, true);
  assert.ok(result.reason.includes('input-missing: missing'));
});

function fakeGlobalState() {
  const store = new Map();
  return {
    get(key) {
      return store.get(key);
    },
    update(key, value) {
      store.set(key, value);
    },
    _store: store,
  };
}

test('consent gate persists per-server approval in globalState and fail-closed on reject', async () => {
  const globalState = fakeGlobalState();
  const asked = [];
  const vscode = {
    window: {
      async showWarningMessage(message, options, ...buttons) {
        asked.push({ message, buttons });
        return asked.length === 1 ? 'Reject' : 'Allow';
      },
    },
  };
  const loc = (template, params) => String(template).replace(/\{(\w+)\}/g, (_, key) => String(params && params[key] !== undefined ? params[key] : `{${key}}`));
  const gate = createConsentGate({ globalState, vscode, loc });
  const rejected = await gate.ensureConsent('s1', { toolCount: 2 });
  assert.strictEqual(rejected, false);
  assert.strictEqual(gate.isConsented('s1'), false);
  const allowed = await gate.ensureConsent('s1', { toolCount: 2 });
  assert.strictEqual(allowed, true);
  assert.strictEqual(gate.isConsented('s1'), true);
  assert.ok(asked[0].message.includes('s1'));
  assert.strictEqual(globalState._store.get('dsh.mcp.consentedServers').includes('s1'), true);
  assert.strictEqual(gate.forget('s1'), true);
  assert.strictEqual(gate.isConsented('s1'), false);
});
