'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  SERVER_NAME_MAX,
  SERVER_NAME_PATTERN,
  definitionsToServers,
  dedupeAgainstFileSources,
  readRegisteredMcpServers,
  slugifyServerName,
  transportSignature,
} = require('../../src/mcp/vscodeRegistry');
const { renderEmbedOverlay, writeEmbedOverlay } = require('../../src/embedOverlay');

// js-yaml is a transitive dependency; when present it proves the generated
// overlay stays a parseable YAML document (JSON scalars are a YAML subset).
let yaml = null;
try {
  yaml = require('js-yaml');
} catch {
  yaml = null;
}

function stdioDefinition(label, overrides = {}) {
  return {
    label,
    command: 'docker',
    args: ['run', '-i', '--rm', 'mcp/github'],
    env: { GITHUB_TOKEN: 'tok' },
    ...overrides,
  };
}

test('slugifyServerName yields DSH-valid unique names', () => {
  const taken = new Set();
  assert.strictEqual(slugifyServerName('GitHub MCP', taken), 'github-mcp');
  assert.strictEqual(slugifyServerName('GitHub MCP', taken), 'github-mcp-2');
  assert.strictEqual(slugifyServerName('  --**--  ', taken), 'server');
  assert.strictEqual(slugifyServerName('', taken), 'server-2');
  const long = 'x'.repeat(40);
  assert.strictEqual(slugifyServerName(long, taken).length <= SERVER_NAME_MAX, true);
  // collision suffixing respects the 32-char budget
  const base = 'y'.repeat(SERVER_NAME_MAX);
  assert.strictEqual(slugifyServerName(base, taken), base);
  const second = slugifyServerName(base, taken);
  assert.strictEqual(second.length <= SERVER_NAME_MAX, true);
  assert.strictEqual(second.startsWith(base.slice(0, SERVER_NAME_MAX - 2)), true);
  assert.strictEqual(SERVER_NAME_PATTERN.test(second), true);
});

test('definitionsToServers maps stdio and http definitions', () => {
  const { servers, diagnostics } = definitionsToServers([
    stdioDefinition('GitHub MCP'),
    {
      label: 'Web Search',
      uri: { toString: () => 'https://mcp.example.com/mcp' },
      headers: { Authorization: 'Bearer t', bad: 42 },
    },
  ]);
  assert.deepStrictEqual(diagnostics, []);
  assert.deepStrictEqual(servers, [
    {
      name: 'github-mcp',
      type: 'stdio',
      command: 'docker',
      args: ['run', '-i', '--rm', 'mcp/github'],
      env: { GITHUB_TOKEN: 'tok' },
    },
    {
      name: 'web-search',
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer t' },
    },
  ]);
});

test('definitionsToServers keeps optional cwd, drops non-string args/env', () => {
  const { servers } = definitionsToServers([
    stdioDefinition('Local', {
      cwd: '/tmp/work',
      args: ['ok', 7, null, 'also-ok'],
      env: { GOOD: '1', BAD: 9 },
    }),
  ]);
  assert.deepStrictEqual(servers, [{
    name: 'local',
    type: 'stdio',
    command: 'docker',
    args: ['ok', 'also-ok'],
    env: { GOOD: '1' },
    cwd: '/tmp/work',
  }]);
});

test('definitionsToServers skips auth-gated and malformed definitions with diagnostics', () => {
  const { servers, diagnostics } = definitionsToServers([
    stdioDefinition('Auth', { authentication: { providerId: 'github', scopes: ['repo'] } }),
    { label: 'Broken' },
    null,
    'not-an-object',
    stdioDefinition('Empty Command', { command: '   ' }),
  ]);
  assert.deepStrictEqual(servers, []);
  assert.deepStrictEqual(diagnostics.map((entry) => entry.server), ['Auth', 'Broken', 'server', 'server', 'Empty Command']);
  assert.ok(diagnostics[0].message.includes('auth-required'));
  assert.ok(diagnostics[0].message.includes('github'));
  assert.ok(diagnostics[1].message.includes('unsupported-definition'));
});

test('definitionsToServers names stay unique across the whole batch', () => {
  const { servers } = definitionsToServers([
    stdioDefinition('Same Label'),
    stdioDefinition('Same Label'),
    stdioDefinition('Same Label'),
  ]);
  assert.deepStrictEqual(servers.map((server) => server.name), ['same-label', 'same-label-2', 'same-label-3']);
});

test('dedupeAgainstFileSources drops name and transport duplicates, keeps the rest', () => {
  const fileSources = [
    { source: 'user', servers: { 'github-mcp': { command: 'other-command' } } },
    { source: '.vscode/mcp.json', servers: [{ name: 'docker-gh', command: 'docker', args: ['run', '-i', '--rm', 'mcp/github'] }] },
  ];
  const registered = [
    { name: 'github-mcp', type: 'stdio', command: 'docker', args: [] },
    { name: 'docker-gh-2', type: 'stdio', command: 'docker', args: ['run', '-i', '--rm', 'mcp/github'] },
    { name: 'fresh', type: 'stdio', command: 'fresh', args: [] },
  ];
  const { servers, dropped } = dedupeAgainstFileSources(registered, fileSources);
  assert.deepStrictEqual(servers.map((server) => server.name), ['fresh']);
  assert.deepStrictEqual(dropped.map((entry) => entry.server), ['github-mcp', 'docker-gh-2']);
});

test('transportSignature distinguishes stdio and http shapes', () => {
  assert.strictEqual(
    transportSignature({ command: 'npx', args: ['-y', 'server'] }),
    'stdio\u0000npx\u0000-y\u0000server'
  );
  assert.strictEqual(transportSignature({ url: 'http://x/mcp' }), 'http\u0000http://x/mcp');
  assert.strictEqual(transportSignature({}), null);
  assert.strictEqual(transportSignature(null), null);
});

test('readRegisteredMcpServers degrades when the proposal is disabled', () => {
  const gated = {};
  Object.defineProperty(gated, 'mcpServerDefinitions', {
    get() {
      throw new Error('Extension CANNOT use API proposal: mcpServerDefinitions');
    },
  });
  const gatedResult = readRegisteredMcpServers(gated);
  assert.strictEqual(gatedResult.available, false);
  assert.deepStrictEqual(gatedResult.servers, []);
  assert.strictEqual(gatedResult.diagnostics.length, 1);
  assert.ok(gatedResult.diagnostics[0].message.includes('mcpServerDefinitions'));
});

test('readRegisteredMcpServers handles missing/undefined surfaces', () => {
  assert.strictEqual(readRegisteredMcpServers(null).available, false);
  assert.strictEqual(readRegisteredMcpServers(undefined).available, false);
  assert.strictEqual(readRegisteredMcpServers({}).available, false);
  assert.strictEqual(readRegisteredMcpServers({ mcpServerDefinitions: 'nope' }).available, false);
});

test('readRegisteredMcpServers maps a live getter snapshot', () => {
  const lm = {
    mcpServerDefinitions: [
      stdioDefinition('GitHub MCP'),
      { label: 'Auth', command: 'x', authentication: { providerId: 'github' } },
    ],
  };
  const result = readRegisteredMcpServers(lm);
  assert.strictEqual(result.available, true);
  assert.deepStrictEqual(result.servers.map((server) => server.name), ['github-mcp']);
  assert.deepStrictEqual(result.diagnostics.map((entry) => entry.server), ['Auth']);
});

test('embed overlay carries the server snapshot as the integration row config', () => {
  const servers = [
    { name: 'github-mcp', type: 'stdio', command: 'docker', args: ['run', '-i'], env: { TOKEN: 'a"b' } },
    { name: 'web', type: 'http', url: 'https://mcp.example.com/mcp', headers: {} },
    { name: 'empty-stdio', type: 'stdio', command: 'node' },
  ];
  const text = renderEmbedOverlay(servers);
  assert.ok(text.includes('- insert:'));
  assert.ok(text.includes('    - id: vscode-integration'));
  assert.ok(text.includes('      config:'));
  const line = text.split('\n').find((entry) => entry.trim().startsWith('mcpServers:'));
  assert.ok(line, 'the integration row must carry mcpServers');
  const parsed = JSON.parse(line.slice(line.indexOf('mcpServers:') + 'mcpServers:'.length).trim());
  assert.deepStrictEqual(parsed, servers);
  // no per-server loader rows anymore: the plugin mounts at runtime
  assert.ok(!text.includes('vscode-mcp-'));
  assert.ok(!text.includes('name: "@deepseek-ai/dsh-mcp-client"'));
  // single trailing newline
  assert.strictEqual(text.endsWith('\n'), true);
  assert.strictEqual(text.endsWith('\n\n'), false);
});

test('embed overlay without servers stays byte-identical to the historical document', () => {
  const text = renderEmbedOverlay();
  assert.strictEqual(text.includes('dsh-mcp-client'), false);
  assert.strictEqual(renderEmbedOverlay(null).endsWith('\n'), true);
  assert.strictEqual(renderEmbedOverlay([]), text);
});

const OVERLAY_DOC = yaml ? (() => {
  const servers = [
    { name: 'github-mcp', type: 'stdio', command: 'docker', args: ['run', '-i'], env: { TOKEN: 'a"b\\c', UNI: '令牌' }, cwd: '/tmp/x y' },
    { name: 'web', type: 'http', url: 'https://mcp.example.com/mcp?q=1', headers: { Authorization: 'Bearer t' } },
  ];
  return renderEmbedOverlay(servers);
})() : null;

test('generated overlay is a parseable YAML document whose integration config matches the servers', { skip: !yaml && 'js-yaml unavailable' }, () => {
  const doc = yaml.load(OVERLAY_DOC);
  assert.ok(Array.isArray(doc), 'the overlay must parse as a YAML array of patch entries');
  const inserts = doc.filter((entry) => entry && entry.insert);
  assert.strictEqual(inserts.length, 1, 'exactly one insert block (integration row)');
  const rows = inserts[0].insert;
  assert.strictEqual(rows.length, 1, 'only the integration row is inserted');
  const integration = rows[0];
  assert.strictEqual(integration.id, 'vscode-integration');
  assert.strictEqual(integration.name, 'dsh-vscode-integration');
  assert.deepStrictEqual(integration.config.mcpServers, [
    {
      name: 'github-mcp',
      type: 'stdio',
      command: 'docker',
      args: ['run', '-i'],
      env: { TOKEN: 'a"b\\c', UNI: '令牌' },
      cwd: '/tmp/x y',
    },
    {
      name: 'web',
      type: 'http',
      url: 'https://mcp.example.com/mcp?q=1',
      headers: { Authorization: 'Bearer t' },
    },
  ]);
});

test('writeEmbedOverlay persists bridged servers to the overlay file', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mcp-bridge-overlay-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const overlayPath = writeEmbedOverlay(directory, {
    mcpServers: [{ name: 'local', type: 'stdio', command: 'node', args: ['server.js'] }],
  });
  const written = fs.readFileSync(overlayPath, 'utf8');
  assert.ok(written.includes('mcpServers:'));
  assert.ok(!written.includes('vscode-mcp-local'));
  if (yaml) {
    const doc = yaml.load(written);
    const row = doc.find((entry) => entry.insert).insert[0];
    assert.strictEqual(row.id, 'vscode-integration');
    assert.deepStrictEqual(row.config.mcpServers, [
      { name: 'local', type: 'stdio', command: 'node', args: ['server.js'] },
    ]);
  }
});

test('renderMcpBridgeConfig omits the config block for an empty server set', () => {
  const { renderMcpBridgeConfig } = require('../../src/embedOverlay');
  assert.deepStrictEqual(renderMcpBridgeConfig([]), []);
  assert.deepStrictEqual(renderMcpBridgeConfig(null), []);
  assert.deepStrictEqual(renderMcpBridgeConfig([{ name: 'x' }]), [
    '      config:',
    '        mcpServers: [{"name":"x"}]',
  ]);
  assert.deepStrictEqual(renderMcpBridgeConfig([{ name: 'x' }], 'w-1'), [
    '      config:',
    '        windowId: "w-1"',
    '        mcpServers: [{"name":"x"}]',
  ]);
});
