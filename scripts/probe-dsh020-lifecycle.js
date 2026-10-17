'use strict';

// Real, isolated component acceptance. No installed VSIX/browser claim.
// node scripts/probe-dsh020-lifecycle.js <package-root> <evidence-root> <steady|lifecycle|reconnect>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const { ServerManager } = require('../src/serverManager');
const { installDshIntegration, INTEGRATION_FILES } = require('../src/dshIntegration');
const { deriveRuntimeProfileName, ensureProfileScaffold } = require('../src/profileScaffold');
const { ensureHmrDisabled } = require('../src/hmrGuard');
const { writeEmbedOverlay } = require('../src/embedOverlay');
const { createRuntimeIdentityFromResolved } = require('../src/runtime/identity');
const { createRuntimeSupervisor } = require('../src/runtime/supervisor');
const { createDshRuntimeClient } = require('../src/runtime/client');
const { verifyNodeRuntime } = require('../src/runtime/compatibility');
const { createSessionFeedHub } = require('../src/session/feedHub');
const { LIMITS } = require('../src/protocol/runtime');
const { sanitizedChildEnv, parseProbeArguments } = require('./probe-dsh020');

const execFileAsync = promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let sequence = 0;
const op = () => ({ requestId: `lifecycle-probe-${++sequence}`, timeoutMs: 15000 });
function exited(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}
async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  assert.ok(port < 65000, 'Probe needs room for ten fresh-origin ports');
  return port;
}
async function until(test, message, ms = 15000) {
  const deadline = Date.now() + ms;
  while (!test()) { assert.ok(Date.now() < deadline, message); await delay(50); }
}
function measuredTimers() {
  const active = new Set();
  let peak = 0;
  return {
    setTimeout(fn, ms) {
      const timer = setTimeout(() => { active.delete(timer); fn(); }, ms);
      active.add(timer); peak = Math.max(peak, active.size); return timer;
    },
    clearTimeout(timer) { active.delete(timer); clearTimeout(timer); },
    snapshot: () => ({ active: active.size, peak }),
  };
}
async function childRss(pid) {
  if (process.platform === 'win32') {
    const result = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).WorkingSet64`],
      { windowsHide: true, timeout: 5000, maxBuffer: 4096 });
    const bytes = Number(result.stdout.trim()); assert.ok(Number.isFinite(bytes) && bytes > 0); return bytes;
  }
  const result = await execFileAsync('ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 5000, maxBuffer: 4096 });
  return Number(result.stdout.trim()) * 1024;
}

async function main() {
  const { positional, target } = parseProbeArguments(process.argv.slice(2));
  const [packageRoot, outputRoot, mode] = positional;
  assert.ok(path.isAbsolute(packageRoot || '') && path.isAbsolute(outputRoot || ''));
  assert.ok(['steady', 'lifecycle', 'reconnect'].includes(mode));
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@deepseek-ai/dsh'); assert.equal(manifest.version, target || '0.2.0-rc.1');
  await verifyNodeRuntime(process.execPath);
  const extensionRoot = path.resolve(__dirname, '..');
  const integrationRoot = path.join(extensionRoot, 'runtime-integration/dsh-vscode-integration');
  const integrationVersion = JSON.parse(fs.readFileSync(path.join(integrationRoot, 'package.json'), 'utf8')).version;
  fs.mkdirSync(outputRoot, { recursive: true });
  const runRoot = fs.mkdtempSync(path.join(outputRoot, `${mode}-`));
  const evidencePath = path.join(runRoot, 'evidence.json');
  const evidence = { status: 'RUNNING', mode, startedAt: new Date().toISOString(), runtimeVersion: manifest.version,
    integrationVersion, nodeVersion: process.version, cases: [], samples: [],
    sourceHashes: Object.fromEntries(['src/runtime/supervisor.js', 'src/runtime/client.js', 'src/session/feedHub.js', 'src/serverManager.js']
      .map((file) => [file, sha256(path.join(extensionRoot, file))])),
    integrationHashes: Object.fromEntries(INTEGRATION_FILES.map((file) => [file, sha256(path.join(integrationRoot, file))])),
    isolation: { freshHomes: true, freshWorkspaces: true, allowlistedChildEnvironment: true, personalKeys: false } };
  const fixtures = [];
  const save = () => fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  const passed = (id, details = {}) => { evidence.cases.push({ id, status: 'PASS', ...details }); save(); };
  let hub;
  async function fixture(name, options = {}) {
    const directory = path.join(runRoot, name);
    const home = path.join(directory, 'home');
    const workspace = path.join(directory, 'workspace');
    fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(workspace, { recursive: true });
    const profileName = deriveRuntimeProfileName(name, manifest.version);
    const runtime = { executablePath: process.execPath, entrypointArgs: [path.join(packageRoot, 'lib/bin.js')], packageRoot,
      dshHome: home, profileHome: path.join(home, 'profiles', profileName), profileName, dshVersion: manifest.version };
    const identity = await createRuntimeIdentityFromResolved(runtime, { integrationVersion });
    const launch = { host: '127.0.0.1', port: await freePort(), autoStart: true, cwd: workspace,
      registryFile: path.join(directory, 'registry.json') };
    const counts = { spawned: 0, prepared: 0, managerStops: 0 };
    let credentials;
    let server;
    const manager = new ServerManager({ spawnEnv: { DSH_HOME: home },
      spawnFn(file, args, config) { counts.spawned++; return spawn(file, args, { ...config, env: sanitizedChildEnv(config.env) }); } });
    const originalEnsure = manager.ensureServer.bind(manager);
    manager.ensureServer = async (config) => { server = await originalEnsure(config); return server; };
    const originalStop = manager.stop.bind(manager);
    manager.stop = async () => { counts.managerStops++; await originalStop(); };
    const supervisor = createRuntimeSupervisor({ serverManager: manager,
      resolver: async () => ({ runtime, serverOptions: launch, closePolicy: 'onVscodeExit' }),
      prepareIntegration: async () => {
        counts.prepared++;
        ensureProfileScaffold({ dshHome: home, profileName, donorProfileName: '' });
        ensureHmrDisabled({ dshHome: home, profileName, dshVersion: manifest.version });
        const installed = installDshIntegration(home, extensionRoot, { profileName });
        for (const file of INTEGRATION_FILES) assert.equal(sha256(path.join(installed.packageRoot, file)), evidence.integrationHashes[file]);
        return { embedPatchPath: writeEmbedOverlay(home) };
      },
      createClient(args) { credentials = args; return createDshRuntimeClient({ ...args, fetch: options.fetch || globalThis.fetch }); },
      ...(options.supervisor || {}),
    });
    const item = { manager, supervisor, identity, runtime, launch, workspace, counts,
      get server() { return server; }, get credentials() { return credentials; } };
    fixtures.push(item); return item;
  }
  save();
  console.log(JSON.stringify({ status: 'STARTING', mode, evidence: evidencePath }));
  try {
    if (mode === 'steady' || mode === 'reconnect') {
      const transportCuts = new Set();
      const fetchTracked = async (url, init) => {
        if (new URL(url).pathname !== '/api/vscode/v1/events') return fetch(url, init);
        const controller = new AbortController();
        transportCuts.add(controller);
        init.signal.addEventListener('abort', () => transportCuts.delete(controller), { once: true });
        return fetch(url, { ...init, signal: AbortSignal.any([init.signal, controller.signal]) });
      };
      const owner = await fixture('steady-owner', { fetch: fetchTracked });
      const lease = await owner.supervisor.ensure(owner.identity, op());
      const pid = owner.server.pid;
      const workspace = await lease.api.ensureWorkspace(owner.workspace, op());
      const session = await lease.api.createSession(workspace.id, op());
      const retryTimers = measuredTimers();
      const metrics = { opens: 0, active: 0, activePeak: 0, closes: 0, dispatchDepth: 0, dispatchPeak: 0,
        maxUpdateBytes: 0, consumers: 0, consumerPeak: 0, churnRegistrations: 0, terminalErrors: [], cuts: [] };
      const epochs = new Set();
      const observe = (update) => { metrics.maxUpdateBytes = Math.max(metrics.maxUpdateBytes, Buffer.byteLength(JSON.stringify(update))); };
      hub = createSessionFeedHub({ timers: retryTimers, createRequestId: () => op().requestId,
        openFeed: async (_key, operation) => {
          metrics.opens++;
          const underlying = await lease.api.openFeed(session.id, operation);
          metrics.active++; metrics.activePeak = Math.max(metrics.activePeak, metrics.active);
          let closed = false;
          const close = async () => { if (closed) return; closed = true; metrics.active--; metrics.closes++; await underlying.close(); };
          return { close, events: { async *[Symbol.asyncIterator]() {
            try { for await (const update of underlying.events) { observe(update); yield update; } }
            finally { await close(); }
          } } };
        } });
      const subscribe = (primary = false) => {
        metrics.consumers++; metrics.consumerPeak = Math.max(metrics.consumerPeak, metrics.consumers);
        const dispatch = (value) => { metrics.dispatchDepth++; metrics.dispatchPeak = Math.max(metrics.dispatchPeak, metrics.dispatchDepth);
          if (primary && value.streamEpoch) epochs.add(value.streamEpoch); metrics.dispatchDepth--; };
        const handle = hub.subscribe({ instanceId: lease.instanceId, sessionId: session.id }, {
          onBaseline: dispatch, onUpdate: dispatch, onError: (error) => { metrics.terminalErrors.push(error.code); },
        });
        let released = false;
        return { release() { if (!released) { released = true; metrics.consumers--; handle.release(); } } };
      };
      const first = subscribe(true); const second = subscribe(true);
      await until(() => epochs.size === 1, 'Initial shared feed snapshot');
      assert.equal(metrics.opens, 1); assert.equal(hub.activeFeeds, 1);
      passed('two-consumers-one-real-sse', { ownedPid: pid });
      const started = Date.now();
      const duration = mode === 'steady' ? 600000 : 12000;
      const cutTimes = mode === 'steady' ? [120000, 300000] : [2000, 5000];
      for (let sampleIndex = 0; ; sampleIndex++) {
        const elapsed = Date.now() - started;
        for (let i = 0; i < 20; i++) { subscribe().release(); metrics.churnRegistrations++; }
        if (metrics.cuts.length < cutTimes.length && elapsed >= cutTimes[metrics.cuts.length]) {
          const previousEpochs = epochs.size;
          const cutStarted = Date.now();
          assert.equal(transportCuts.size, 1);
          for (const controller of [...transportCuts]) controller.abort();
          await until(() => epochs.size > previousEpochs && metrics.active === 1, 'Real SSE cut must recover into a new snapshot epoch');
          metrics.cuts.push({ elapsedMs: elapsed, recoveryMs: Date.now() - cutStarted });
          assert.equal(owner.server.pid, pid); assert.equal(owner.counts.spawned, 1);
        }
        const caps = await lease.api.capabilities(op()); assert.equal(caps.runtimeInstanceId, lease.instanceId);
        assert.equal((await owner.supervisor.ensure(owner.identity, op())).instanceId, lease.instanceId);
        assert.ok((await lease.api.listSessions(workspace.id, op())).some((item) => item.id === session.id));
        assert.equal(hub.activeFeeds, 1); assert.equal(metrics.active, 1); assert.equal(metrics.consumers, 2);
        assert.equal(metrics.terminalErrors.length, 0);
        evidence.samples.push({ elapsedMs: Date.now() - started, pid, runtimeRss: await childRss(pid), probeRss: process.memoryUsage().rss,
          activeHubKeys: hub.activeFeeds, activeTransports: metrics.active, totalTransportOpens: metrics.opens,
          consumers: metrics.consumers, retryTimers: retryTimers.snapshot().active, epochs: epochs.size });
        save(); console.log(JSON.stringify({ status: 'SAMPLING', mode, sample: sampleIndex, elapsedMs: Date.now() - started, cuts: metrics.cuts.length }));
        if (Date.now() - started >= duration) break;
        await delay(Math.min(mode === 'steady' ? 20000 : 1000, duration - (Date.now() - started)));
      }
      assert.equal(metrics.cuts.length, 2); assert.equal(metrics.opens, 3); assert.equal(epochs.size, 3);
      assert.equal(metrics.activePeak, 1);
      first.release(); assert.equal(hub.activeFeeds, 1);
      second.release(); await hub.dispose(); hub = null;
      await until(() => metrics.active === 0 && transportCuts.size === 0, 'Last release closes all real transports');
      assert.equal(retryTimers.snapshot().active, 0);
      const rss = evidence.samples.map((sample) => sample.runtimeRss);
      evidence.resourceSummary = { durationMs: Date.now() - started, ...metrics, retryTimers: retryTimers.snapshot(),
        runtimeRssMin: Math.min(...rss), runtimeRssMax: Math.max(...rss), runtimeRssFirst: rss[0], runtimeRssLast: rss.at(-1),
        runtimeRssStrictlyIncreasing: rss.every((value, index) => index === 0 || value > rss[index - 1]),
        configuredBounds: { frameBytes: LIMITS.frameBytes, projectionBytes: LIMITS.projectionBytes, maxFeeds: LIMITS.maxFeeds },
        queueMeasurement: 'Observed reconnect timers and synchronous consumer dispatch depth; internal upstream queue occupancy is not exposed by public ports.' };
      passed(mode === 'steady' ? 'ten-minute-steady-two-real-disconnects' : 'two-real-disconnects-recover', { samples: evidence.samples.length, cuts: metrics.cuts, ownedStarts: owner.counts.spawned });
      passed('last-consumer-disposal', { transports: metrics.active, reconnectTimers: retryTimers.snapshot().active });
      await owner.supervisor.stop(op()); assert.ok(exited(pid));
      passed('steady-owned-pid-exit', { pid });
    } else {
      const owner = await fixture('cycle-owner');
      const cycles = [];
      for (let index = 1; index <= 10; index++) {
        const lease = await owner.supervisor.ensure(owner.identity, op());
        const pid = owner.server.pid;
        assert.equal(lease.owned, true);
        assert.equal((await owner.supervisor.ensure(owner.identity, op())).instanceId, lease.instanceId);
        await owner.supervisor.stop(op());
        assert.ok(exited(pid)); assert.equal(owner.manager.hasOwnedChild(), false); assert.equal(owner.manager._healthTimer, null);
        cycles.push({ cycle: index, pid, port: owner.server.port, instanceId: lease.instanceId, exited: true });
        evidence.cycles = cycles; save(); console.log(JSON.stringify({ status: 'CYCLE', cycle: index }));
      }
      assert.equal(new Set(cycles.map((item) => item.pid)).size, 10);
      assert.equal(new Set(cycles.map((item) => item.instanceId)).size, 10);
      assert.equal(owner.counts.spawned, 10);
      passed('ten-real-supervisor-start-stops', { starts: owner.counts.spawned, exits: cycles.length });

      const a = await fixture('coexist-a'); const b = await fixture('coexist-b');
      const [leaseA, leaseB] = await Promise.all([a.supervisor.ensure(a.identity, op()), b.supervisor.ensure(b.identity, op())]);
      assert.notEqual(a.server.pid, b.server.pid); assert.notEqual(a.server.port, b.server.port);
      assert.notEqual(leaseA.instanceId, leaseB.instanceId);
      const borrowedManager = new ServerManager();
      const borrowCounts = { prepares: 0, stops: 0, nodeChecks: 0 };
      const originalProbe = borrowedManager.probe.bind(borrowedManager);
      const target = new URL(b.credentials.endpoint);
      // The trusted endpoint comes directly from this test's owner, never another process's logs.
      // Production has no discovery of bearer/startup secrets; this DI seam is explicit.
      borrowedManager.probe = (host, port) => originalProbe(host, port, `${target.pathname}${target.search}`);
      const originalBorrowEnsure = borrowedManager.ensureServer.bind(borrowedManager);
      borrowedManager.ensureServer = async (options) => ({ ...await originalBorrowEnsure(options), url: b.credentials.endpoint });
      const originalBorrowStop = borrowedManager.stop.bind(borrowedManager);
      borrowedManager.stop = async () => { borrowCounts.stops++; await originalBorrowStop(); };
      const borrower = createRuntimeSupervisor({ serverManager: borrowedManager,
        resolver: async () => ({ runtime: b.runtime, serverOptions: { ...b.launch, port: b.server.port, autoStart: false },
          borrowedCredentials: { token: await b.credentials.tokenProvider(), instanceId: leaseB.instanceId } }),
        prepareIntegration: async () => { borrowCounts.prepares++; },
        verifyNode: async () => { borrowCounts.nodeChecks++; },
        createClient: createDshRuntimeClient,
      });
      fixtures.push({ supervisor: borrower, manager: borrowedManager, counts: borrowCounts });
      const borrowed = await borrower.ensure(b.identity, op()); assert.equal(borrowed.owned, false);
      assert.equal(borrowed.instanceId, leaseB.instanceId);
      await assert.rejects(borrower.restart(op()), { code: 'FORBIDDEN' });
      await a.supervisor.stop(op()); assert.ok(exited(a.server.pid));
      assert.equal((await borrowed.api.capabilities(op())).runtimeInstanceId, leaseB.instanceId);
      await borrower.stop(op()); await borrower.dispose();
      assert.deepEqual(borrowCounts, { prepares: 0, stops: 0, nodeChecks: 0 });
      assert.equal(borrowedManager.hasOwnedChild(), false);
      assert.equal((await leaseB.api.capabilities(op())).runtimeInstanceId, leaseB.instanceId);
      await b.supervisor.stop(op()); assert.ok(exited(b.server.pid));
      passed('two-owned-one-trusted-borrowed-isolation', { ownerPids: [a.server.pid, b.server.pid], borrowerSideEffects: borrowCounts,
        trustedEndpointSelection: 'Test-only DI supplies owner credentials to a real borrowed ServerManager probe; no general external discovery is claimed.' });

      const gate = await fixture('failure-gates');
      // rc.2 is a supported target now; the gate case stays on a version that
      // has no adapter, which is exactly what it exists to prove.
      await assert.rejects(gate.supervisor.ensure({ ...gate.identity, runtimeVersion: '0.2.0-rc.3' }, op()), { code: 'UNSUPPORTED_RUNTIME' });
      await assert.rejects(gate.supervisor.ensure({ ...gate.identity, executablePath: path.join(runRoot, 'missing-node.exe') }, op()),
        (error) => error.code === 'UNSUPPORTED_RUNTIME');
      assert.equal(gate.counts.spawned, 0); assert.equal(gate.counts.prepared, 0);
      passed('unknown-version-and-missing-node-prelaunch-gates', { spawned: 0, prepared: 0 });
    }
    evidence.status = 'PASS';
  } catch (error) {
    evidence.status = 'FAIL'; process.exitCode = 1;
    evidence.failure = { code: error.code || error.name || 'PROBE_FAILURE',
      message: error.name === 'AssertionError' ? String(error.message).replace(/token=[^\s&]+/g, 'token=REDACTED') : 'See isolated evidence; raw errors withheld.' };
  } finally {
    await hub?.dispose();
    evidence.cleanup = [];
    for (const item of fixtures.reverse()) {
      const pid = item.server?.pid;
      await item.supervisor.dispose();
      const clean = !item.manager.hasOwnedChild() && (!pid || exited(pid));
      evidence.cleanup.push({ ...(pid ? { pid } : {}), clean });
      if (!clean) { evidence.status = 'FAIL'; process.exitCode = 1; }
    }
    evidence.finishedAt = new Date().toISOString();
    evidence.limitations = ['Runtime component acceptance only; no installed VSIX or browser UI.',
      'RSS samples describe only this timed workload without claiming a general absence of leaks.',
      'Public ports expose no upstream queue depth; retry-timer peak and dispatch depth are the observed bounds.'];
    save(); console.log(JSON.stringify({ status: evidence.status, mode, cases: evidence.cases, evidence: evidencePath }));
  }
}

main().catch((error) => { console.error(error.code || error.name || 'Probe failed'); process.exitCode = 1; });
