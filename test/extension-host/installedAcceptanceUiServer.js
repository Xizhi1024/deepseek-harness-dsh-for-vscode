'use strict';
// Component UI harness: real DSH + real browser chunks inside the actual shell.
// This does not claim installed VSIX acceptance; its host facade is a test driver.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { ServerManager } = require('../../src/serverManager');
const { installDshIntegration } = require('../../src/dshIntegration');
const { ensureProfileScaffold, deriveRuntimeProfileName } = require('../../src/profileScaffold');
const { ensureHmrDisabled } = require('../../src/hmrGuard');
const { writeEmbedOverlay } = require('../../src/embedOverlay');
const { loopbackFetch } = require('../../src/loopbackAuth');
const { createDshRuntimeClient } = require('../../src/runtime/client');
const { framePage } = require('../../src/webviewHtml');
const { createWebEmbedProxy } = require('../../src/webEmbedProxy');

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port; await new Promise((resolve) => socket.close(resolve)); return port;
}
async function main() {
  const [packageRoot, evidenceRoot] = process.argv.slice(2);
  assert.ok(path.isAbsolute(packageRoot) && path.isAbsolute(evidenceRoot));
  assert.equal(JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'))).version, '0.2.0-rc.1');
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const runRoot = fs.mkdtempSync(path.join(evidenceRoot, 'ui-'));
  const home = path.join(runRoot, 'home'), workspace = path.join(runRoot, 'workspace');
  fs.mkdirSync(workspace, { recursive: true }); fs.mkdirSync(home, { recursive: true });
  const profileName = deriveRuntimeProfileName('ui-acceptance', '0.2.0-rc.1');
  ensureProfileScaffold({ dshHome: home, profileName, donorProfileName: '' });
  const fixtureRoot = path.join(home, 'profiles', profileName, 'node_modules', 'vscode-contract-provider');
  fs.mkdirSync(fixtureRoot, { recursive: true });
  fs.copyFileSync(path.resolve(__dirname, '../../scripts/fixtures/dsh020rc1-provider.mjs'), path.join(fixtureRoot, 'index.mjs'));
  fs.writeFileSync(path.join(fixtureRoot, 'package.json'), JSON.stringify({ name: 'vscode-contract-provider', version: '1.0.0', type: 'module', main: 'index.mjs' }));
  const llmModule = pathToFileURL(path.join(path.dirname(packageRoot), 'dsh-llm/lib/index.js')).href;
  fs.writeFileSync(path.join(home, 'profiles', profileName, 'cordis.patch.yml'), [
    '- id: agent-default-model', '  config:', '    provider: vscode-contract-probe', '    model: deterministic',
    '- id: session-title-llm', '  disabled: true', '- insert:', '    - id: vscode-contract-provider',
    '      name: vscode-contract-provider', '      config:', `        llmModule: ${JSON.stringify(llmModule)}`, '',
  ].join('\n'));
  ensureHmrDisabled({ dshHome: home, profileName, dshVersion: '0.2.0-rc.1' });
  const extensionRoot = path.resolve(__dirname, '../..');
  installDshIntegration(home, extensionRoot, { profileName });
  const token = randomBytes(32).toString('base64url'), instance = randomUUID();
  const manager = new ServerManager({ embedPatchPath: writeEmbedOverlay(home),
    spawnEnv: { DSH_HOME: home, DSH_VSCODE_API_TOKEN: token, DSH_VSCODE_RUNTIME_INSTANCE_ID: instance, DSH_VSCODE_RUNTIME_VERSION: '0.2.0-rc.1' },
    spawnFn: (file, args, options) => spawn(file, args, { ...options, windowsHide: true, env: Object.fromEntries(Object.entries(options.env).filter(([key]) => /^(PATH|PATHEXT|SystemRoot|ComSpec|WINDIR|TEMP|TMP|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|DSH_HOME|DSH_TEXT_EDITOR|DSH_VSCODE_API_TOKEN|DSH_VSCODE_RUNTIME_INSTANCE_ID|DSH_VSCODE_RUNTIME_VERSION)$/i.test(key))) }),
  });
  manager.setResolvedRuntime({ executablePath: process.execPath, entrypointArgs: [path.join(packageRoot, 'lib/bin.js')], dshHome: home,
    profileHome: path.join(home, 'profiles', profileName), profileName, dshVersion: '0.2.0-rc.1' });
  let shell, proxy;
  let closing = false;
  const stop = async () => { if (closing) return; closing = true; if (shell) shell.close(); if (proxy) proxy.close(); await manager.stop(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const server = await manager.ensureServer({ host: '127.0.0.1', port: await freePort(), autoStart: true, cwd: workspace, registryFile: path.join(home, 'instances.json') });
    const api = createDshRuntimeClient({ endpoint: server.url, tokenProvider: () => token, expectedInstanceId: instance, fetch: (url, options) => loopbackFetch(server.url, url, options) });
    let seq = 0;
    const op = () => ({ requestId: `ui-probe-${++seq}`, signal: AbortSignal.timeout(15000) });
    await api.capabilities(op());
    const workspaceInfo = await api.ensureWorkspace(workspace, op());
    const sessions = [];
    for (const title of ['UI search alpha', 'UI search beta']) {
      const session = await api.createSession(workspaceInfo.id, op());
      // Seed a durable message so DSH does not fold/reuse these as blank sessions.
      const feedOp = { requestId: `ui-feed-${++seq}`, signal: AbortSignal.timeout(20000) };
      const feed = await api.openFeed(session.id, feedOp);
      const terminal = (async () => { for await (const update of feed.events) if (update.kind === 'turn-state' && ['completed', 'failed', 'cancelled'].includes(update.state)) return update.state; })();
      terminal.catch(() => {});
      try {
        await api.submitPrompt({ sessionId: session.id, content: [{ kind: 'text', text: 'probe-stream' }], mode: 'queue', clientRequestId: `ui-seed-${++seq}` }, op());
        assert.equal(await terminal, 'completed');
      } finally { await feed.close(); }
      await api.renameSession(session.id, title, op()); sessions.push({ id: session.id, title });
    }
    proxy = createWebEmbedProxy();
    const embeddedUrl = await proxy.start(server.url);
    const html = framePage({ url: embeddedUrl, sessionId: sessions[0].id, runtimeVersion: '0.2.0-rc.1', surfaceIdentity: { surfaceId: 'ui-probe', surfaceEpoch: 1 } })
      .replace('<head>', '<head><script>window.__vscodeEvents=[];window.acquireVsCodeApi=()=>({postMessage(message){window.__vscodeEvents.push(message);}});</script>');
    shell = http.createServer((req, res) => {
      if (req.url === '/stop' && req.method === 'POST') { res.writeHead(200); res.end('stopping'); void stop(); return; }
      if (req.url !== '/') { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html);
    });
    await new Promise((resolve) => shell.listen(0, '127.0.0.1', resolve));
    const status = { status: 'READY', shellUrl: `http://127.0.0.1:${shell.address().port}/`, runRoot, sessions, runtimeVersion: '0.2.0-rc.1', pid: process.pid };
    fs.writeFileSync(path.join(runRoot, 'status.json'), JSON.stringify(status, null, 2));
    console.log(JSON.stringify(status));
    setTimeout(stop, 30 * 60 * 1000).unref();
  } catch (error) { if (proxy) proxy.close(); await manager.stop(); throw error; }
}
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
