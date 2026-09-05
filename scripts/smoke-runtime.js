'use strict';

// Usage: node scripts/smoke-runtime.js <absolute DSH package root>
// Creates an isolated home and workspace; never reads/writes the user's sessions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ServerManager } = require('../src/serverManager');
const { installDshIntegration } = require('../src/dshIntegration');
const { ensureProfileScaffold } = require('../src/profileScaffold');
const { writeEmbedOverlay } = require('../src/embedOverlay');
const { createWorkspaceBinding } = require('../src/context/workspaceBinding');
const { listSessions, renameSession } = require('../src/sessionNavigation');
const { loopbackFetch } = require('../src/loopbackAuth');

async function main() {
  const packageRoot = process.argv[2];
  assert.ok(packageRoot && path.isAbsolute(packageRoot), 'Pass an absolute DSH package root');
  const version = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-smoke-'));
  const workspace = path.join(home, 'workspace');
  fs.mkdirSync(workspace);
  const profileName = 'vscode';
  installDshIntegration(home, path.resolve(__dirname, '..'), { profileName });
  ensureProfileScaffold({ dshHome: home, profileName });
  const manager = new ServerManager({ embedPatchPath: writeEmbedOverlay(home) });
  manager.setResolvedRuntime({
    executablePath: process.execPath,
    entrypointArgs: [path.join(packageRoot, 'lib', 'bin.js')],
    dshHome: home,
    profileHome: path.join(home, 'profiles', profileName),
    profileName,
    dshVersion: version,
  });
  const binding = createWorkspaceBinding({ debounceMs: 0, fetchImpl: async (...args) => {
    const response = await fetch(...args);
    if (response.headers.get('content-type')?.includes('json')) {
      const body = await response.clone().json();
      if (body.result?.ok === false) console.error(JSON.stringify(body.result.error));
    }
    return response;
  } });
  try {
    const options = { host: '127.0.0.1', port: 43800, autoStart: true, cwd: workspace, registryFile: path.join(home, 'instances.json') };
    const server = await manager.ensureServer(options);
    assert.equal(await manager.healthCheck(server.url), true);
    const first = await binding.resolve(server, workspace);
    assert.ok(first, binding.state().error || 'workspace binding failed');
    await renameSession(server.url, { sessionId: first, title: 'Runtime smoke' });
    assert.ok((await listSessions(server.url)).some((item) => item.sessionId === first));
    const reused = await manager.ensureServer(options);
    assert.equal(reused.pid, server.pid);
    assert.equal(reused.url, server.url);
    assert.equal(await binding.refresh(), first);
    const events = await loopbackFetch(server.url, '/api/events.mux', { signal: AbortSignal.timeout(10000) });
    assert.equal(events.status, 200);
    const reader = events.body.getReader();
    assert.equal((await reader.read()).done, false);
    await reader.cancel();
    assert.equal(manager.selfHealCount(), 0);
    console.log(JSON.stringify({ version, binding: 'passed', list: 'passed', rename: 'passed', events: 'connected', reuse: 'same PID', repeatBinding: 'same session', home }));
  } finally {
    binding.dispose();
    await manager.stop();
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
