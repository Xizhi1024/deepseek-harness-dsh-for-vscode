'use strict';

// node scripts/probe-dsh020rc1.js <absolute-installed-dsh-package-root> <absolute-evidence-directory>
// This is a real runtime contract probe, not installed VSIX/UI acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { ServerManager } = require('../src/serverManager');
const { installDshIntegration, INTEGRATION_FILES } = require('../src/dshIntegration');
const { deriveRuntimeProfileName, ensureProfileScaffold } = require('../src/profileScaffold');
const { writeEmbedOverlay } = require('../src/embedOverlay');
const { ensureHmrDisabled } = require('../src/hmrGuard');
const { loopbackFetch } = require('../src/loopbackAuth');
const { createDshRuntimeClient } = require('../src/runtime/client');
const { verifyNodeRuntime } = require('../src/runtime/compatibility');

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function deploymentFiles(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? deploymentFiles(path.join(directory, entry.name), `${prefix}${entry.name}/`)
    : [`${prefix}${entry.name}`]);
}
function sanitizedChildEnv(env) {
  // Child tests inherit system launch essentials, never personal provider keys.
  const allowed = /^(?:PATH|PATHEXT|SystemRoot|ComSpec|WINDIR|TEMP|TMP|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|DSH_HOME|DSH_TEXT_EDITOR|DSH_VSCODE_API_TOKEN|DSH_VSCODE_RUNTIME_INSTANCE_ID|DSH_VSCODE_RUNTIME_VERSION)$/i;
  return Object.fromEntries(Object.entries(env).filter(([name, value]) => allowed.test(name) && value !== undefined));
}
async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

async function main() {
  const [packageRoot, outputRoot] = process.argv.slice(2);
  assert.ok(packageRoot && path.isAbsolute(packageRoot), 'Provide an absolute isolated DSH package root');
  assert.ok(outputRoot && path.isAbsolute(outputRoot), 'Provide an absolute evidence directory');
  const runtimeManifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(runtimeManifest.name, '@deepseek-ai/dsh');
  assert.equal(runtimeManifest.version, '0.2.0-rc.1');
  await verifyNodeRuntime(process.execPath);
  fs.mkdirSync(outputRoot, { recursive: true });
  const runRoot = fs.mkdtempSync(path.join(outputRoot, 'run-'));
  const home = path.join(runRoot, 'home');
  const workspace = path.join(runRoot, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const extensionRoot = path.resolve(__dirname, '..');
  const integrationRoot = path.join(extensionRoot, 'runtime-integration/dsh-vscode-integration');
  const integrationManifest = JSON.parse(fs.readFileSync(path.join(integrationRoot, 'package.json'), 'utf8'));
  const profileName = deriveRuntimeProfileName('contract-probe', runtimeManifest.version);
  const withModel = process.argv.includes('--with-local-provider');
  const token = randomBytes(32).toString('base64url');
  const instanceId = randomUUID();
  const evidence = { runtimeVersion: runtimeManifest.version, integrationVersion: integrationManifest.version,
    extensionVersion: JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8')).version,
    nodeVersion: process.version, platform: process.platform, arch: process.arch,
    runtimeManifestSha256: sha256(path.join(packageRoot, 'package.json')),
    isolated: { home: true, workspace: true, profile: true, providerEnvironment: true }, cases: [] };
  const feeds = [];
  let manager;
  let ownedPid = null;
  let stage = 'prepare';
  const passed = (id, details = {}) => evidence.cases.push({ id, status: 'PASS', ...details });
  let sequence = 0;
  const op = () => ({ requestId: `probe-${++sequence}`, signal: AbortSignal.timeout(15000), timeoutMs: 15000 });
  try {
    const expectedFiles = ['package.json', ...deploymentFiles(path.join(integrationRoot, 'lib'), 'lib/'),
      ...deploymentFiles(path.join(integrationRoot, 'contracts'), 'contracts/')];
    for (const file of expectedFiles) assert.ok(INTEGRATION_FILES.includes(file), `Deployment allow-list missing ${file}`);
    ensureProfileScaffold({ dshHome: home, profileName, donorProfileName: '' });
    if (withModel) {
      const fixtureRoot = path.join(home, 'profiles', profileName, 'node_modules', 'vscode-contract-provider');
      fs.mkdirSync(fixtureRoot, { recursive: true });
      fs.copyFileSync(path.join(__dirname, 'fixtures/dsh020rc1-provider.mjs'), path.join(fixtureRoot, 'index.mjs'));
      fs.writeFileSync(path.join(fixtureRoot, 'package.json'), JSON.stringify({ name: 'vscode-contract-provider', version: '1.0.0', type: 'module', main: 'index.mjs' }));
      const llmModule = pathToFileURL(path.join(path.dirname(packageRoot), 'dsh-llm/lib/index.js')).href;
      fs.writeFileSync(path.join(home, 'profiles', profileName, 'cordis.patch.yml'), [
        '- id: agent-default-model', '  config:', '    provider: vscode-contract-probe', '    model: deterministic',
        '- id: session-title-llm', '  disabled: true',
        '- insert:', '    - id: vscode-contract-provider', '      name: vscode-contract-provider', '      config:', `        llmModule: ${JSON.stringify(llmModule)}`, '',
      ].join('\n'));
      fs.writeFileSync(path.join(workspace, 'probe-tool.txt'), 'before\n');
    }
    ensureHmrDisabled({ dshHome: home, profileName, dshVersion: runtimeManifest.version });
    const installed = installDshIntegration(home, extensionRoot, { profileName });
    evidence.integrationFiles = Object.fromEntries(expectedFiles.map((file) => {
      const source = path.join(integrationRoot, file);
      const synced = path.join(installed.packageRoot, file);
      assert.equal(sha256(source), sha256(synced), `Synced bytes differ for ${file}`);
      return [file, sha256(source)];
    }));
    const overlay = writeEmbedOverlay(home);
    manager = new ServerManager({ embedPatchPath: overlay,
      spawnEnv: { DSH_HOME: home, DSH_VSCODE_API_TOKEN: token, DSH_VSCODE_RUNTIME_INSTANCE_ID: instanceId, DSH_VSCODE_RUNTIME_VERSION: runtimeManifest.version },
      spawnFn: (file, args, options) => spawn(file, args, { ...options, env: sanitizedChildEnv(options.env) }),
    });
    manager.setResolvedRuntime({ executablePath: process.execPath, entrypointArgs: [path.join(packageRoot, 'lib/bin.js')],
      dshHome: home, profileHome: path.join(home, 'profiles', profileName), profileName, dshVersion: runtimeManifest.version });
    stage = 'startup';
    const launch = { host: '127.0.0.1', port: await freePort(), autoStart: true, cwd: workspace, registryFile: path.join(home, 'instances.json') };
    const server = await manager.ensureServer(launch);
    ownedPid = server.pid;
    assert.equal(server.owned, true);
    assert.ok(new URL(server.url).searchParams.has('token'));
    passed('startup', { owned: true, authenticatedHealth: await manager.healthCheck(server.url) });
    const api = createDshRuntimeClient({ endpoint: server.url, tokenProvider: () => token, expectedInstanceId: instanceId });
    stage = 'facade-auth';
    const facadePath = '/api/vscode/v1/capabilities';
    for (const [kind, headers, status] of [
      ['cookie-only', {}, 401], ['wrong-token', { Authorization: 'Bearer invalid-probe' }, 401], // allow-secret-scan: deliberately invalid authentication fixture
      ['browser-origin', { Authorization: `Bearer ${token}`, Origin: 'http://127.0.0.1' }, 403],
    ]) {
      const response = await loopbackFetch(server.url, facadePath, { headers, signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, status, kind); await response.body.cancel();
      passed(kind);
    }
    stage = 'capabilities';
    const capabilities = await api.capabilities(op());
    assert.equal(capabilities.runtimeVersion, runtimeManifest.version);
    assert.equal(capabilities.integrationVersion, integrationManifest.version);
    assert.equal(capabilities.adapterId, 'dsh-0.2.0-rc.1');
    passed('capabilities', { features: capabilities.features });
    stage = 'workspace';
    const firstWorkspace = await api.ensureWorkspace(workspace, op());
    assert.equal((await api.ensureWorkspace(workspace, op())).id, firstWorkspace.id);
    assert.ok((await api.listWorkspaces(op())).some((item) => item.id === firstWorkspace.id));
    passed('workspace-create-list-reuse');
    stage = 'session';
    const firstSession = await api.createSession(firstWorkspace.id, op());
    await api.renameSession(firstSession.id, 'Synthetic runtime contract probe', op());
    const sessions = await api.listSessions(firstWorkspace.id, op());
    const listed = sessions.find((item) => item.id === firstSession.id);
    assert.equal(listed?.title, 'Synthetic runtime contract probe');
    assert.equal(listed?.workspaceId, firstWorkspace.id);
    passed('session-create-list-rename');
    stage = 'follow';
    const controller = new AbortController();
    const feed = await api.openFeed(firstSession.id, { requestId: 'probe-feed', signal: controller.signal, timeoutMs: 10000 });
    feeds.push(feed);
    const iterator = feed.events[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.value.kind, 'snapshot');
    assert.equal(first.value.sessionId, firstSession.id);
    assert.equal(first.value.deliverySeq, 1);
    assert.equal(first.value.runtimeInstanceId, instanceId);
    await iterator.return(); await feed.close();
    const reopened = await api.openFeed(firstSession.id, { requestId: 'probe-reopen', signal: controller.signal, timeoutMs: 10000 });
    feeds.push(reopened);
    const nextIterator = reopened.events[Symbol.asyncIterator]();
    const next = await nextIterator.next();
    assert.equal(next.value.kind, 'snapshot');
    assert.notEqual(next.value.streamEpoch, first.value.streamEpoch);
    await nextIterator.return(); await reopened.close();
    passed('follow-opening-snapshot-return-reopen');
    stage = 'cancel-idle-session';
    assert.equal((await api.cancelSession(firstSession.id, op())).admission, 'accepted');
    passed('cancel-idle-session', { limitation: 'Active turn cancellation requires a model-backed probe.' });
    stage = 'reuse';
    assert.equal((await manager.ensureServer(launch)).pid, server.pid);
    passed('same-owned-pid');
    if (withModel) {
      async function runTurn(marker, cancelOnChunk = false) {
        const session = await api.createSession(firstWorkspace.id, op());
        const controller = new AbortController();
        const deadline = setTimeout(() => controller.abort(), 30000);
        const feed = await api.openFeed(session.id, { requestId: `feed-${marker}`, signal: controller.signal, timeoutMs: 10000 });
        feeds.push(feed);
        const updates = [];
        const consumption = (async () => {
          for await (const update of feed.events) {
            updates.push(update);
            if (cancelOnChunk && update.kind === 'assistant-chunk') {
              cancelOnChunk = false;
              await api.cancelSession(session.id, op());
            }
            if (update.kind === 'turn-state' && ['completed', 'failed', 'cancelled'].includes(update.state)) return update.state;
          }
          throw new Error('Feed closed without turn terminal');
        })();
        consumption.catch(() => {}); // Submission may reject before the consumer settles.
        try {
          const requestId = `prompt-${marker}`;
          assert.equal((await api.submitPrompt({ sessionId: session.id, content: [{ kind: 'text', text: marker }], mode: 'queue', clientRequestId: requestId }, op())).admission, 'accepted');
          const terminal = await consumption;
          return { terminal, updates };
        } finally { clearTimeout(deadline); controller.abort(); await feed.close(); await consumption.catch(() => {}); }
      }
      stage = 'local-provider-stream';
      const streamed = await runTurn('probe-stream');
      assert.equal(streamed.terminal, 'completed');
      const chunks = streamed.updates.filter((update) => update.kind === 'assistant-chunk' && update.channel === 'answer');
      assert.ok(chunks.length >= 2);
      assert.equal(chunks.map((update) => update.text).join(''), 'alpha beta');
      const durable = streamed.updates.flatMap((update) => update.kind === 'durable' ? update.changes : []).filter((change) => change.op === 'upsert' && change.record.kind === 'assistant');
      assert.equal(durable.length, 1);
      passed('local-provider-stream', { chunks: chunks.length, assistantRecords: durable.length, terminal: streamed.terminal });
      stage = 'local-provider-cancel';
      const cancelled = await runTurn('probe-cancel', true);
      assert.equal(cancelled.terminal, 'cancelled');
      passed('local-provider-active-cancel', { terminal: cancelled.terminal });
      stage = 'local-provider-tools';
      const toolTurn = await runTurn('probe-tool');
      evidence.toolProbe = toolTurn.updates.flatMap((update) => update.kind === 'durable' ? update.changes : []).filter((change) => change.op === 'upsert' && change.record.kind === 'tool').map((change) => ({ tool: change.record.tool, content: change.record.content }));
      assert.equal(toolTurn.terminal, 'completed');
      assert.equal(fs.readFileSync(path.join(workspace, 'probe-tool.txt'), 'utf8'), 'after\n');
      const tools = toolTurn.updates.flatMap((update) => update.kind === 'durable' ? update.changes : []).filter((change) => change.op === 'upsert' && change.record.kind === 'tool');
      const toolNames = tools.map((change) => change.record.tool.name);
      assert.ok(JSON.stringify(toolNames) === JSON.stringify(['read', 'write', 'edit']) || JSON.stringify(toolNames) === JSON.stringify(['run_code']));
      assert.ok(tools.every((change) => change.record.tool.state === 'succeeded'));
      const observations = toolTurn.updates.filter((update) => update.kind === 'edit-observation' && update.observation.phase === 'confirmed');
      assert.equal(observations.length, 2);
      assert.ok(observations.every((update) => update.observation.toolCallId && update.observation.sourceDurableSeq));
      passed('local-provider-real-tools', { tools: ['read', 'write', 'edit'], dispatch: toolNames, confirmedObservations: observations.length, terminal: toolTurn.terminal });
    }
    evidence.status = 'PASS';
  } catch (error) {
    evidence.status = 'FAIL';
    // Raw upstream exceptions may include request bodies or credentials.
    evidence.cases.push({ id: stage, status: 'FAIL', code: typeof error.code === 'string' ? error.code : 'ASSERTION_OR_RUNTIME_FAILURE',
      message: error.name === 'AssertionError' ? String(error.message).replace(/token=[^\s&]+/g, 'token=REDACTED') : 'See isolated runtime logs for local debugging.' });
    process.exitCode = 1;
  } finally {
    for (const feed of feeds) await feed.close().catch(() => {});
    if (manager) await manager.stop();
    evidence.ownedChildAfterStop = manager ? manager.hasOwnedChild() : false;
    try { if (ownedPid) process.kill(ownedPid, 0); evidence.ownedPidExited = !ownedPid; }
    catch (error) { evidence.ownedPidExited = error.code === 'ESRCH'; }
    if (ownedPid && !evidence.ownedPidExited) {
      evidence.status = 'FAIL'; process.exitCode = 1;
      evidence.cases.push({ id: 'owned-process-exit', status: 'FAIL', code: 'OWNED_PROCESS_STILL_ALIVE' });
    }
    evidence.limitations = ['No installed VSIX or browser UI exercised.', withModel
      ? 'Deterministic local LlmAdapter backend used; no production model, provider network, Changes accept/undo UI or CH1 notification delivery certified.'
      : 'No model/provider used; prompt stream and real tool turn are not certified.'];
    fs.writeFileSync(path.join(runRoot, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify({ status: evidence.status, cases: evidence.cases, evidence: path.join(runRoot, 'evidence.json') }));
  }
}

if (require.main === module) main().catch((error) => { console.error(error.code || error.name || 'Probe failed'); process.exitCode = 1; });
module.exports = { sanitizedChildEnv, deploymentFiles };
