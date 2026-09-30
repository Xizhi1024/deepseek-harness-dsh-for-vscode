'use strict';

// Real DSH/CH1/facade/journal/file effects, with a small VS Code file-API facade.
// This deliberately does not claim installed extension-host or visible UI coverage.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { ServerManager } = require('../src/serverManager');
const { VersionedBridgeServer } = require('../src/versionedBridgeServer');
const { createV3Handlers } = require('../src/bridge/v3');
const { createChangeTracker, normalizeToolEditPath } = require('../src/changeTracker');
const { createChangeTree } = require('../src/changeTree');
const { createEditEventProjector } = require('../src/editEventProjector');
const { createSessionFeedHub } = require('../src/session/feedHub');
const { createDshRuntimeClient } = require('../src/runtime/client');
const { verifyNodeRuntime } = require('../src/runtime/compatibility');
const { installDshIntegration, INTEGRATION_FILES } = require('../src/dshIntegration');
const { deriveRuntimeProfileName, ensureProfileScaffold } = require('../src/profileScaffold');
const { ensureHmrDisabled } = require('../src/hmrGuard');
const { writeEmbedOverlay } = require('../src/embedOverlay');
const { sanitizedChildEnv } = require('./probe-dsh020rc1');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function until(test, label, ms = 15000) {
  const deadline = Date.now() + ms;
  while (!test()) { assert.ok(Date.now() < deadline, label); await sleep(25); }
}
async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port; await new Promise((resolve) => socket.close(resolve)); return port;
}

function fileApiFacade(workspaceRoot) {
  const contentProviders = new Map();
  const diffCalls = [];
  const applyCalls = [];
  const messages = [];
  const parse = (value) => {
    const url = new URL(String(value));
    return { scheme: url.protocol.slice(0, -1), fsPath: url.protocol === 'file:' ? fileURLToPath(url) : null,
      toString: () => url.href };
  };
  const file = (value) => parse(pathToFileURL(value).href);
  const inWorkspace = (value) => {
    const relative = path.relative(workspaceRoot, value);
    assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'Probe file write must stay in its own workspace');
  };
  const offsetAt = (text, position) => {
    const lines = text.split('\n');
    assert.ok(position.line >= 0 && position.line < lines.length);
    assert.ok(position.character >= 0 && position.character <= lines[position.line].length);
    return lines.slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character;
  };
  class Position { constructor(line, character) { this.line = line; this.character = character; } }
  class Range { constructor(a, b, c, d) { this.start = new Position(a, b); this.end = new Position(c, d); } }
  class WorkspaceEdit {
    constructor() { this.operations = []; }
    replace(uri, range, text) { this.operations.push({ kind: 'replace', uri, range, text }); }
    insert(uri, at, text) { this.operations.push({ kind: 'insert', uri, at, text }); }
    delete(uri, range) { this.operations.push({ kind: 'replace', uri, range, text: '' }); }
    createFile(uri) { this.operations.push({ kind: 'create', uri }); }
    deleteFile(uri) { this.operations.push({ kind: 'deleteFile', uri }); }
  }
  const folder = { uri: file(workspaceRoot) };
  const document = (uri) => {
    const text = fs.readFileSync(uri.fsPath, 'utf8');
    const lines = text.split('\n');
    return { getText: () => text, lineCount: lines.length, lineAt: (line) => ({ text: lines[line] }),
      validatePosition(value) { const line = Math.min(Math.max(value.line, 0), lines.length - 1);
        return new Position(line, Math.min(Math.max(value.character, 0), lines[line].length)); } };
  };
  return {
    contentProviders, diffCalls, applyCalls, messages, Uri: { parse, file }, Position, Range, WorkspaceEdit,
    TreeItem: class { constructor(label, collapsibleState) { Object.assign(this, { label, collapsibleState }); } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    window: { registerTreeDataProvider: () => ({ dispose() {} }), createTreeView: () => ({ dispose() {}, reveal: async () => {} }),
      showInformationMessage: async (message) => messages.push(message), showWarningMessage: async () => { throw new Error('Unexpected destructive fallback'); },
      showErrorMessage: async (message) => messages.push(message) },
    commands: { executeCommand: async (...args) => { diffCalls.push(args); } },
    workspace: { workspaceFolders: [folder], getWorkspaceFolder: () => folder,
      openTextDocument: async (uri) => document(uri),
      registerTextDocumentContentProvider: (scheme, provider) => { contentProviders.set(scheme, provider); return { dispose() { contentProviders.delete(scheme); } }; },
      async applyEdit(edit) {
        applyCalls.push(edit.operations.length);
        for (const operation of edit.operations) {
          inWorkspace(operation.uri.fsPath);
          if (operation.kind === 'create') fs.writeFileSync(operation.uri.fsPath, '', { flag: 'wx' });
          else if (operation.kind === 'deleteFile') fs.unlinkSync(operation.uri.fsPath);
          else {
            const text = fs.readFileSync(operation.uri.fsPath, 'utf8');
            const start = offsetAt(text, operation.kind === 'insert' ? operation.at : operation.range.start);
            const end = operation.kind === 'insert' ? start : offsetAt(text, operation.range.end);
            fs.writeFileSync(operation.uri.fsPath, text.slice(0, start) + operation.text + text.slice(end));
          }
        }
        return true;
      } },
  };
}

// Serialized only into the fresh test profile. Generation is synthetic; tools,
// CH1 RPC, notifications, persistent session events and facade streams are real.
async function localChangesProvider(ctx, config) {
  const { LlmAdapter } = await import(config.llmModule);
  class Provider extends LlmAdapter {
    providerInfo(provider) { return { id: provider, name: 'Local Changes probe' }; }
    async listModels(provider) { return [{ provider, id: 'deterministic', name: 'Local Changes probe', inputModalities: ['text'] }]; }
    async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 131072 } }; }
    async *stream(options) {
      const userIndex = options.messages.findLastIndex((message) => message.role === 'user' && message.content?.some((part) => part.type === 'text' && part.text.includes('probe-changes-')));
      const prompt = (options.messages[userIndex]?.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('');
      const count = options.messages.slice(userIndex + 1).filter((message) => message.role === 'tool').length;
      const calls = prompt.includes('probe-changes-native') ? [
        { name: 'read', args: { file_path: config.targetPath } },
        { name: 'write', args: { file_path: config.targetPath, content: 'middle\n' } },
        { name: 'edit', args: { file_path: config.targetPath, old_string: 'middle', new_string: 'after' } },
      ] : prompt.includes('probe-changes-bridge:') ? [
        { name: 'vscode_changes_push', args: { label: 'Real CH1 Changes probe',
          sessionId: prompt.split('probe-changes-bridge:')[1].split(/\s/)[0],
          edits: [{ kind: 'replace', uri: config.targetUri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, text: 'bridge' }] } },
      ] : [];
      if (options.purpose !== 'session-title' && count < calls.length) {
        const call = calls[count];
        if (!options.tools?.some((tool) => tool.name === call.name)) throw new Error('Required Changes probe tool unavailable');
        const block = { type: 'tool-call', id: `changes-call-${count}`, name: call.name, arguments: JSON.stringify(call.args) };
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
        yield { type: 'block-end', index: 0, block };
        yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'changes-complete' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'changes-complete' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['vscode-changes-probe'], new Provider()));
}

async function main() {
  const [packageRoot, outputRoot] = process.argv.slice(2);
  assert.ok(path.isAbsolute(packageRoot || '') && path.isAbsolute(outputRoot || ''));
  const runtimeManifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(runtimeManifest.name, '@deepseek-ai/dsh'); assert.equal(runtimeManifest.version, '0.2.0-rc.1');
  await verifyNodeRuntime(process.execPath);
  fs.mkdirSync(outputRoot, { recursive: true });
  const runRoot = fs.mkdtempSync(path.join(outputRoot, 'changes-'));
  const home = path.join(runRoot, 'home'); const workspace = path.join(runRoot, 'workspace'); const storage = path.join(runRoot, 'storage');
  fs.mkdirSync(workspace, { recursive: true }); fs.mkdirSync(home, { recursive: true });
  const targetPath = path.join(workspace, 'probe-tool.txt'); fs.writeFileSync(targetPath, 'before\n');
  const extensionRoot = path.resolve(__dirname, '..'); const integrationRoot = path.join(extensionRoot, 'runtime-integration/dsh-vscode-integration');
  const profileName = deriveRuntimeProfileName('changes-probe', runtimeManifest.version);
  const evidence = { status: 'RUNNING', runtimeVersion: runtimeManifest.version, nodeVersion: process.version, cases: [],
    evidenceKind: 'Real DSH/CH1/SSE/projector/journal/files with test VS Code file API; not installed UI',
    sourceHashes: Object.fromEntries(['src/changeTracker.js', 'src/changeTree.js', 'src/editEventProjector.js', 'src/versionedBridgeServer.js', 'src/bridge/v3.js']
      .map((file) => [file, sha256(path.join(extensionRoot, file))])) };
  const save = () => fs.writeFileSync(path.join(runRoot, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  const pass = (id, details = {}) => { evidence.cases.push({ id, status: 'PASS', ...details }); save(); };
  const vscode = fileApiFacade(workspace);
  const tracker = createChangeTracker({ storageUri: { fsPath: storage }, vscode });
  const tree = createChangeTree({ vscode, tracker, storageUri: { fsPath: storage }, additionalRoots: () => [workspace] });
  const token = randomBytes(32).toString('base64url'); const instanceId = randomUUID();
  let manager; let bridge; let hub; let projector; let pid; let stage = 'prepare'; let sequence = 0;
  const op = () => ({ requestId: `changes-probe-${++sequence}`, timeoutMs: 15000 });
  const notifications = []; const observations = []; const recordCalls = [];
  try {
    bridge = await new VersionedBridgeServer({
      handlers: createV3Handlers({ vscode, changeTracker: tracker, getFlag: (key) => key === 'features.changes-review' }),
      workspace: { windowId: randomUUID(), trusted: true, kind: 'local', folders: [{ uri: pathToFileURL(workspace).href, name: 'Changes probe' }] },
      onDshEditObserved(payload) {
        notifications.push(payload);
        projector?.observe({ observationId: randomUUID(), runtimeInstanceId: instanceId, sessionId: payload.sessionId || null,
          path: payload.path, tool: payload.tool, phase: 'pre-execute', origin: 'tool-observer',
          toolCallId: payload.toolCallId || null, sourceDurableSeq: null, beforeText: typeof payload.beforeText === 'string' ? payload.beforeText : null });
      },
    }).start();
    ensureProfileScaffold({ dshHome: home, profileName, donorProfileName: '' });
    const fixtureRoot = path.join(home, 'profiles', profileName, 'node_modules', 'vscode-changes-provider'); fs.mkdirSync(fixtureRoot, { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, 'package.json'), JSON.stringify({ name: 'vscode-changes-provider', version: '1.0.0', type: 'module', main: 'index.mjs' }));
    fs.writeFileSync(path.join(fixtureRoot, 'index.mjs'), `export const name='vscode-changes-provider';\nexport const inject=['llm'];\nexport const apply=${localChangesProvider.toString()};\nexport default {name,inject,apply};\n`);
    fs.writeFileSync(path.join(home, 'profiles', profileName, 'cordis.patch.yml'), [
      '- id: agent-default-model', '  config:', '    provider: vscode-changes-probe', '    model: deterministic',
      '- id: session-title-llm', '  disabled: true', '- insert:', '    - id: vscode-changes-provider', '      name: vscode-changes-provider', '      config:',
      `        llmModule: ${JSON.stringify(pathToFileURL(path.join(path.dirname(packageRoot), 'dsh-llm/lib/index.js')).href)}`,
      `        targetPath: ${JSON.stringify(targetPath)}`, `        targetUri: ${JSON.stringify(pathToFileURL(targetPath).href)}`, '',
    ].join('\n'));
    ensureHmrDisabled({ dshHome: home, profileName, dshVersion: runtimeManifest.version });
    const installed = installDshIntegration(home, extensionRoot, { profileName });
    evidence.integrationHashes = Object.fromEntries(INTEGRATION_FILES.map((file) => { const hash = sha256(path.join(integrationRoot, file));
      assert.equal(hash, sha256(path.join(installed.packageRoot, file))); return [file, hash]; }));
    manager = new ServerManager({ embedPatchPath: writeEmbedOverlay(home),
      spawnEnv: { DSH_HOME: home, DSH_VSCODE_API_TOKEN: token, DSH_VSCODE_RUNTIME_INSTANCE_ID: instanceId,
        DSH_VSCODE_RUNTIME_VERSION: runtimeManifest.version, ...bridge.env },
      spawnFn: (file, args, config) => spawn(file, args, { ...config, env: { ...sanitizedChildEnv(config.env), ...bridge.env } }),
    });
    manager.setResolvedRuntime({ executablePath: process.execPath, entrypointArgs: [path.join(packageRoot, 'lib/bin.js')], packageRoot,
      dshHome: home, profileHome: path.join(home, 'profiles', profileName), profileName, dshVersion: runtimeManifest.version });
    stage = 'runtime-and-real-ch1-startup';
    const server = await manager.ensureServer({ host: '127.0.0.1', port: await freePort(), autoStart: true, cwd: workspace, registryFile: path.join(runRoot, 'registry.json') });
    pid = server.pid; await bridge.waitForInitialized(15000); assert.ok(bridge.hasProtocolVersion(3));
    const api = createDshRuntimeClient({ endpoint: server.url, tokenProvider: () => token, expectedInstanceId: instanceId });
    await api.capabilities(op());
    const workspaceRecord = await api.ensureWorkspace(workspace, op());
    hub = createSessionFeedHub({ createRequestId: () => op().requestId, openFeed: (key, operation) => api.openFeed(key.sessionId, operation) });
    projector = createEditEventProjector({ feedHubProvider: () => hub, runtimeInstanceIdProvider: () => instanceId,
      recordToolEdit: async (payload) => { recordCalls.push(payload); return tracker.recordToolEdit(normalizeToolEditPath(payload, [workspace])); } });
    pass('real-ch1-v3-initialized');
    async function turn(marker) {
      const session = await api.createSession(workspaceRecord.id, op());
      tree.setActiveSession(session.id); await projector.followSession(session.id);
      let ready = false; let terminal; const updates = []; let error;
      const subscription = hub.subscribe({ instanceId, sessionId: session.id }, {
        onBaseline: () => { ready = true; }, onError: (failure) => { error = failure.code; },
        onUpdate: (update) => { updates.push(update); if (update.kind === 'edit-observation') observations.push(update.observation);
          if (update.kind === 'turn-state' && ['completed', 'failed', 'cancelled'].includes(update.state)) terminal = update.state; },
      });
      try {
        await until(() => ready || error, 'Shared Changes feed baseline'); assert.equal(error, undefined);
        const content = marker === 'probe-changes-bridge' ? `${marker}:${session.id}` : marker;
        await api.submitPrompt({ sessionId: session.id, content: [{ kind: 'text', text: content }], mode: 'queue', clientRequestId: `changes-prompt-${++sequence}` }, op());
        await until(() => terminal || error, 'Real Changes turn terminal', 30000); assert.equal(error, undefined); assert.equal(terminal, 'completed');
        return { sessionId: session.id, updates };
      } finally { subscription.release(); }
    }
    stage = 'native-tools-ch1-confirmed-join';
    const native = await turn('probe-changes-native');
    await until(() => tracker.list().length === 2 && tracker.list().every((entry) => entry.before.length === 1), 'CH1 before snapshots join confirmed durable edits');
    assert.equal(fs.readFileSync(targetPath, 'utf8'), 'after\n');
    assert.equal(notifications.length, 2); assert.equal(observations.length, 2);
    let entries = tracker.list(); assert.equal(entries.length, 2);
    const editEntry = entries.find((entry) => entry.tool === 'edit'); const writeEntry = entries.find((entry) => entry.tool === 'write');
    assert.equal(editEntry.before[0].text, 'middle\n'); assert.equal(writeEntry.before[0].text, 'before\n');
    for (const entry of entries) {
      assert.equal(entry.path, targetPath); assert.equal(entry.sessionId, native.sessionId); assert.ok(entry.observationId && entry.sourceDurableSeq && entry.toolCallId);
      const notification = notifications.find((item) => item.toolCallId === entry.toolCallId);
      assert.equal(notification.beforeText, entry.before[0].text);
      assert.equal(observations.filter((item) => item.toolCallId === entry.toolCallId).length, 1);
    }
    evidence.join = entries.map((entry) => ({ tool: entry.tool, toolCallId: entry.toolCallId, observationId: entry.observationId,
      sourceDurableSeq: entry.sourceDurableSeq, beforeText: entry.before[0].text }));
    const groups = tree.provider.getChildren(); assert.equal(groups.length, 1);
    const leaves = tree.provider.getChildren(groups[0]); assert.equal(leaves.length, 2);
    assert.equal(leaves.filter((entry) => entry.tool === 'edit').length, 1);
    for (const entry of leaves) assert.equal(tree.provider.getTreeItem(entry).contextValue, 'dsh.changes.entry.accepted');
    pass('real-ch1-before-plus-confirmed-one-entry-per-tool', { notifications: notifications.length, confirmedObservations: observations.length, entries: entries.length });
    stage = 'feed-replay-dedup';
    const priorRecordCalls = recordCalls.length;
    projector.unfollow(); await projector.followSession(native.sessionId);
    const replayed = [];
    const replayMonitor = hub.subscribe({ instanceId, sessionId: native.sessionId }, {
      onBaseline: () => {}, onError: () => {},
      onUpdate: (update) => { if (update.kind === 'edit-observation') replayed.push(update.observation.observationId); },
    });
    await until(() => replayed.length === 2, 'Reopened real facade must replay both durable edit observations');
    replayMonitor.release();
    assert.deepEqual(replayed.sort(), observations.map((item) => item.observationId).sort());
    for (const observation of observations) projector.observe(observation);
    assert.equal(tracker.list().length, 2); assert.equal(recordCalls.length, priorRecordCalls);
    pass('confirmed-replay-and-repeated-observation-dedup', { realReplayObservations: replayed.length });

    stage = 'tool-diff-accept-and-undo';
    await tree.openDiff(editEntry);
    const toolDiff = vscode.diffCalls.at(-1); assert.equal(toolDiff[0], 'vscode.diff');
    assert.equal(vscode.contentProviders.get(toolDiff[1].scheme).provideTextDocumentContent(toolDiff[1]), 'middle\n');
    assert.equal(fs.readFileSync(toolDiff[2].fsPath, 'utf8'), 'after\n');
    assert.equal(fs.readFileSync(targetPath, 'utf8'), 'after\n');
    const applyCount = vscode.applyCalls.length;
    assert.equal((await tree.accept(editEntry)).alreadyAccepted, true); assert.equal(vscode.applyCalls.length, applyCount);
    assert.equal((await tree.undo(editEntry)).method, 'snapshot-restore'); assert.equal(fs.readFileSync(targetPath, 'utf8'), 'middle\n');
    assert.equal((await tree.undo(writeEntry)).method, 'snapshot-restore'); assert.equal(fs.readFileSync(targetPath, 'utf8'), 'before\n');
    pass('tool-diff-idempotent-accept-undo-real-file');

    stage = 'real-bridge-changes-push';
    const bridgeTurn = await turn('probe-changes-bridge');
    const pushed = tracker.list().filter((entry) => entry.source === 'bridge'); assert.equal(pushed.length, 1);
    assert.equal(pushed[0].sessionId, bridgeTurn.sessionId); assert.equal(pushed[0].status, 'accepted');
    assert.equal(pushed[0].before[0].text, 'before\n'); assert.equal(fs.readFileSync(targetPath, 'utf8'), 'bridge\n');
    assert.equal(vscode.applyCalls.length, applyCount + 1);
    assert.equal((await tree.undo(pushed[0])).method, 'snapshot-restore'); assert.equal(fs.readFileSync(targetPath, 'utf8'), 'before\n');
    assert.equal(vscode.applyCalls.length, applyCount + 2);
    pass('real-dsh-bridge-push-applyedit-and-undo', { actualTool: 'vscode_changes_push', applyEditCalls: 2 });

    stage = 'pending-preview-accept-undo';
    const wire = [{ kind: 'replace', uri: pathToFileURL(targetPath).href, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, text: 'accepted' }];
    const normalized = tracker.validateWireEdits(wire, vscode);
    const pending = await tracker.record({ sessionId: bridgeTurn.sessionId, label: 'Explicit pending journal fixture', edits: wire,
      before: await tracker.snapshotBefore(normalized) });
    assert.equal(tree.provider.getTreeItem(pending).contextValue, 'dsh.changes.entry.pending');
    const previewCount = vscode.applyCalls.length;
    assert.equal((await tree.openDiff(pending)).preview, true);
    const pendingDiff = vscode.diffCalls.at(-1);
    assert.equal(vscode.contentProviders.get(pendingDiff[2].scheme).provideTextDocumentContent(pendingDiff[2]), 'accepted\n');
    assert.equal(fs.readFileSync(targetPath, 'utf8'), 'before\n'); assert.equal(vscode.applyCalls.length, previewCount);
    await tree.accept(pending); assert.equal(fs.readFileSync(targetPath, 'utf8'), 'accepted\n');
    await tree.undo(tracker.get(pending.id)); assert.equal(fs.readFileSync(targetPath, 'utf8'), 'before\n');
    assert.equal(tree.provider.getTreeItem(tracker.get(pending.id)).contextValue, 'dsh.changes.entry.undone');
    assert.equal(vscode.applyCalls.length, previewCount + 2);
    pass('pending-preview-readonly-accept-undo-real-file', { fixture: 'Explicit tracker.record pending proposal, distinct from immediate real changes/push', applyEditCalls: 2 });
    evidence.status = 'PASS'; evidence.applyEditCalls = vscode.applyCalls.length;
  } catch (error) {
    evidence.status = 'FAIL'; process.exitCode = 1;
    evidence.failure = { stage, code: error.code || error.name || 'PROBE_FAILURE',
      message: error.name === 'AssertionError' ? String(error.message).replace(/token=[^\s&]+/g, 'token=REDACTED') : 'Raw errors withheld; inspect synthetic evidence.' };
    evidence.debug = { notifications, observations, journal: tracker.list(), recordCalls };
  } finally {
    projector?.dispose(); await hub?.dispose(); tree.dispose(); await manager?.stop(); await bridge?.close();
    let ownedPidExited = !pid; try { if (pid) process.kill(pid, 0); } catch (error) { ownedPidExited = error.code === 'ESRCH'; }
    evidence.cleanup = { ownedPidExited, activeHubKeys: hub?.activeFeeds || 0, bridgeSockets: bridge?.sockets.size || 0 };
    if (!ownedPidExited) { evidence.status = 'FAIL'; process.exitCode = 1; }
    evidence.limitations = ['No installed VSIX, visible Changes TreeView, command clicks, editor dirty-buffer semantics, or UI interaction exercised.',
      'Native read/write/edit and one real CH1 changes/push turn used a deterministic local LlmAdapter, without provider network or personal keys.',
      'The VS Code file API facade writes real isolated files; it is not the VS Code implementation.',
      'Pending preview/accept is an explicit journal fixture; real changes/push currently applies immediately and records accepted.'];
    save(); console.log(JSON.stringify({ status: evidence.status, cases: evidence.cases, failure: evidence.failure, evidence: path.join(runRoot, 'evidence.json') }));
  }
}

main().catch((error) => { console.error(error.code || error.name || 'Probe failed'); process.exitCode = 1; });
