'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { createDshRuntimeClient } = require('../../src/runtime/client');
const { createSessionFeedHub } = require('../../src/session/feedHub');
const { createTranscriptState, reduceSessionUpdate } = require('../../src/session/transcript');
const { validateSessionUpdate } = require('../../src/protocol/runtime');

const identity = { runtimeInstanceId: 'runtime-1', sessionId: 'session-1', streamEpoch: 'epoch-1' };
const snapshot = { ...identity, deliverySeq: 1, kind: 'snapshot', records: [], sourceCursor: null, hasMore: false, window: { maxMessages: 200 } };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function queue() {
  const values = [];
  let wake;
  let done = false;
  return { push(value) { values.push(value); wake?.(); wake = null; }, close() { done = true; wake?.(); wake = null; },
    async *[Symbol.asyncIterator]() { while (!done) { if (values.length) yield values.shift(); else await new Promise((resolve) => { wake = resolve; }); } } };
}

test('transcript separates transient text, durable watermark and turn completion', () => {
  let state = reduceSessionUpdate(createTranscriptState(), snapshot);
  state = reduceSessionUpdate(state, { kind: 'assistant-start', attemptId: 'attempt-1', revision: 1 });
  state = reduceSessionUpdate(state, { kind: 'assistant-chunk', attemptId: 'attempt-1', revision: 1, index: 0, channel: 'answer', text: 'one' });
  assert.equal(state.activeAttempts[0].answer, 'one');
  assert.throws(() => reduceSessionUpdate(state, { kind: 'assistant-chunk', attemptId: 'attempt-1', revision: 1, index: 2, channel: 'answer', text: 'lost' }), { code: 'RESYNC_REQUIRED' });
  state = reduceSessionUpdate(state, { kind: 'assistant-end', attemptId: 'attempt-1', revision: 1, outcome: 'abandoned', committedSeq: null });
  assert.equal(state.turn, null);
  assert.equal(state.activeAttempts.length, 0);
  assert.equal(Object.isFrozen(state.records), true);
});

test('hub shares one stream, atomically seeds full in-flight text, and releases the last owner', async () => {
  const source = queue();
  let opens = 0;
  let closes = 0;
  const hub = createSessionFeedHub({ createRequestId: () => 'request-1', openFeed: async () => {
    opens++;
    return { events: source, close: async () => { closes++; source.close(); } };
  } });
  const a = [];
  const b = [];
  const consumer = (out) => ({ onBaseline: (value) => out.push(['base', value]), onUpdate: (value) => out.push(['update', value]), onError: (error) => out.push(['error', error]) });
  const first = hub.subscribe({ instanceId: 'runtime-1', sessionId: 'session-1' }, consumer(a));
  source.push(snapshot);
  source.push({ ...identity, deliverySeq: 2, kind: 'assistant-start', attemptId: 'attempt-1', revision: 5 });
  source.push({ ...identity, deliverySeq: 3, kind: 'assistant-chunk', attemptId: 'attempt-1', revision: 5, index: 0, channel: 'answer', text: 'prefix' });
  await tick();
  const second = hub.subscribe({ instanceId: 'runtime-1', sessionId: 'session-1' }, consumer(b));
  assert.equal(opens, 1);
  assert.equal(b[0][1].state.activeAttempts[0].answer, 'prefix');
  assert.equal(b[0][1].throughDeliverySeq, 3);
  first.release();
  assert.equal(closes, 0);
  second.release();
  await hub.dispose();
  assert.ok(closes > 0);
  assert.equal(hub.activeFeeds, 0);
});

test('client caches the first snapshot and removes acquisition deadline after readiness', async () => {
  const timers = new Map();
  let counter = 0;
  let controller;
  const body = new ReadableStream({ start(value) { controller = value; value.enqueue(new TextEncoder().encode(`event: update\ndata: ${JSON.stringify(snapshot)}\n\n`)); } });
  const client = createDshRuntimeClient({ endpoint: 'http://127.0.0.1:15920', expectedInstanceId: 'runtime-1', tokenProvider: () => 'test-token',
    timers: { setTimeout(fn, ms) { const id = ++counter; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); } },
    fetch: async (_url, options) => { assert.equal(options.headers.Authorization, 'Bearer test-token'); return new Response(body, { headers: { 'content-type': 'text/event-stream' } }); },
  });
  const feed = await client.openFeed('session-1', { requestId: 'request-1', signal: new AbortController().signal, timeoutMs: 10 });
  assert.equal([...timers.values()].some((timer) => timer.ms === 10), false);
  const reader = feed.events[Symbol.asyncIterator]();
  assert.deepEqual((await reader.next()).value, snapshot);
  const pending = reader.next();
  controller.enqueue(new TextEncoder().encode(': heartbeat\n\n'));
  await tick();
  assert.equal(timers.size, 1);
  await feed.close();
  await pending;
  assert.equal(timers.size, 0);
});

test('client never replays a mutation with unknown admission', async () => {
  let calls = 0;
  const client = createDshRuntimeClient({ endpoint: 'http://127.0.0.1:15920', expectedInstanceId: 'runtime-1', tokenProvider: () => 'token', fetch: async () => { calls++; throw new Error('lost'); } });
  await assert.rejects(client.submitPrompt({ sessionId: 'session-1', content: [{ kind: 'text', text: 'hello' }], mode: 'steer', clientRequestId: 'request-1' }, { requestId: 'request-1', signal: new AbortController().signal }), { code: 'OUTCOME_UNKNOWN', effect: 'unknown' });
  assert.equal(calls, 1);
});

test('target adapter preserves queue/steer, public controller calls and one-shot workspace iteration', async () => {
  const { createDsh020rc1Adapter } = await import('../../runtime-integration/dsh-vscode-integration/lib/adapters/dsh020rc1.js');
  let releases = 0;
  let received;
  const adapter = createDsh020rc1Adapter({ ctx: {
    workspaceController: { follow: () => ({ async *[Symbol.asyncIterator]() { try { yield { type: 'baseline', value: { items: [{ workspaceId: 'workspace-1', path: 'D:\\work', title: 'Work', sessionIds: ['session-1'] }] } }; } finally { releases++; } } }) },
    sessionController: { prompt: async (value) => { received = value; return { accepted: true }; }, cancel: () => ({ accepted: true }) },
  }, runtimeVersion: '0.2.0-rc.1', integrationVersion: '0.10.0', runtimeInstanceId: 'runtime-1' });
  const op = { requestId: 'request-1', signal: new AbortController().signal };
  assert.equal((await adapter.listWorkspaces(op))[0].id, 'workspace-1');
  assert.equal(releases, 1);
  await adapter.submitPrompt({ sessionId: 'session-1', content: [{ kind: 'text', text: 'hi' }], mode: 'steer', clientRequestId: 'request-1' }, op);
  assert.equal(received.mode, 'steer');
  assert.equal(received.requestId, 'request-1');
  await assert.rejects(adapter.submitPrompt({ sessionId: 'session-1', content: [{ kind: 'file', uri: 'file:///secret', label: null }], mode: 'queue', clientRequestId: 'request-1' }, op), { code: 'CAPABILITY_UNAVAILABLE' });
});

test('target adapter verifies source revision/index, preserves historical replacement semantics and confirms successful tools', async () => {
  const { createDsh020rc1Adapter } = await import('../../runtime-integration/dsh-vscode-integration/lib/adapters/dsh020rc1.js');
  const frames = [
    { type: 'snapshot', header: { id: 'session-1' }, records: [], cursor: -1, hasMore: false, assistantStream: { revision: 0 } },
    { type: 'event', event: { type: 'turn/start', seq: 0, data: { turn: 1 } } },
    { type: 'event', event: { type: 'user/message', seq: 1, surfaceOp: 'append', data: { content: [{ type: 'text', text: 'question' }], source: { kind: 'user', rpcId: 'request-1' } } } },
    { type: 'assistant-stream', frame: { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 } },
    { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'attempt-1', revision: 2, index: 0, chunk: { type: 'block-start' } } },
    { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'attempt-1', revision: 3, index: 1, chunk: { type: 'text-delta', text: 'hello' } } },
    { type: 'event', event: { type: 'assistant/message', seq: 2, surfaceOp: 'append', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'hello' }] } } } },
    { type: 'assistant-stream', frame: { type: 'end', attemptId: 'attempt-1', revision: 4, index: 2, outcome: { kind: 'committed', seq: 2, eventType: 'assistant/message' } } },
    { type: 'event', event: { type: 'tool/call', seq: 3, data: { callId: 'call-1', name: 'edit', arguments: '{"file_path":"D:/work/a.txt"}' } } },
    { type: 'event', event: { type: 'tool/result', seq: 4, surfaceOp: 'append', data: { message: { toolCallId: 'call-1', content: [{ type: 'text', text: 'ok' }] } } } },
    { type: 'event', event: { type: 'user/message', seq: 5, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 }, data: { content: [{ type: 'text', text: 'model summary' }] } } },
    { type: 'event', event: { type: 'turn/end', seq: 6, data: { turn: 1, reason: { kind: 'completed' } } } },
  ];
  let returned = false;
  const adapter = createDsh020rc1Adapter({ ctx: { workspaceController: {}, sessionController: { follow: () => ({ async *[Symbol.asyncIterator]() { try { yield* frames; } finally { returned = true; } } }) } }, runtimeVersion: '0.2.0-rc.1', integrationVersion: '0.10.0', runtimeInstanceId: 'runtime-1' });
  const feed = await adapter.openFeed('session-1', { signal: new AbortController().signal });
  let state = createTranscriptState();
  const updates = [];
  for await (const update of feed.events) { assert.equal(validateSessionUpdate(update), true, JSON.stringify(update)); updates.push(update); state = reduceSessionUpdate(state, update); }
  assert.equal(returned, true);
  assert.equal(updates.find((item) => item.kind === 'assistant-chunk').revision, 1);
  assert.equal(updates.find((item) => item.kind === 'assistant-chunk').index, 0);
  assert.equal(state.records[0].content[0].text, 'question');
  assert.equal(state.activeAttempts.length, 0);
  assert.equal(state.turn.clientRequestId, 'request-1');
  assert.equal(updates.filter((item) => item.kind === 'edit-observation').length, 1);
});

test('facade rejects wrong tokens and browser origins before accessing services', async () => {
  const { installRuntimeFacade } = await import('../../runtime-integration/dsh-vscode-integration/lib/runtimeFacade.js');
  const routes = new Map();
  let calls = 0;
  const facade = installRuntimeFacade({ ctx: { webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } } },
    adapter: { capabilities() { calls++; } }, token: 'a'.repeat(32), runtimeInstanceId: 'runtime-1' });
  for (const headers of [{ authorization: 'Bearer wrong' }, { authorization: `Bearer ${'a'.repeat(32)}`, origin: 'http://evil.test' }]) {
    const request = Readable.from([]); Object.assign(request, { method: 'GET', url: '/api/vscode/v1/capabilities', headers });
    const response = new EventEmitter(); Object.assign(response, { writeHead(status) { this.status = status; }, end(body) { this.body = body; this.writableEnded = true; }, destroy() { this.destroyed = true; } });
    await routes.get('/api/vscode/v1/capabilities')(request, response);
    assert.ok([401, 403].includes(response.status));
    assert.equal(JSON.parse(response.body).ok, false);
  }
  assert.equal(calls, 0);
  facade.dispose();
  assert.equal(routes.size, 0);
});

test('confirmed durable edits deduplicate after tracker restart while distinct calls remain distinct', async () => {
  const { createChangeTracker } = require('../../src/changeTracker');
  const files = new Map();
  const fsOps = { mkdirSync() {}, readFileSync(file) { if (!files.has(file)) throw new Error('ENOENT'); return files.get(file); },
    writeFileSync(file, value) { files.set(file, value); }, renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); } };
  const options = { storageUri: { fsPath: 'D:/test-only' }, vscode: { workspace: {} }, fsOps, now: () => '2026-09-30T00:00:00.000Z' };
  const evidence = { tool: 'edit', path: 'D:/test-only/file.txt', sessionId: 'session-1', observationId: 'session-1:20:call-1', sourceDurableSeq: '20', toolCallId: 'call-1' };
  const tracker = createChangeTracker(options);
  const first = await tracker.recordToolEdit(evidence);
  const restarted = createChangeTracker(options);
  assert.equal((await restarted.recordToolEdit(evidence)).id, first.id);
  assert.equal(restarted.list().length, 1);
  await restarted.recordToolEdit({ ...evidence, observationId: 'session-1:25:call-2', sourceDurableSeq: '25', toolCallId: 'call-2' });
  assert.equal(restarted.list().length, 2);
});

test('pre-execute observations never become successful Changes entries', async () => {
  const { createEditEventProjector } = require('../../src/editEventProjector');
  const records = [];
  const projector = createEditEventProjector({ recordToolEdit: (value) => records.push(value), baseUrl: null });
  const evidence = { observationId: 'observation-1', sessionId: 'session-1', path: 'D:/file.txt', tool: 'edit', phase: 'pre-execute' };
  projector.observe(evidence);
  assert.equal(records.length, 0);
  projector.observe({ ...evidence, phase: 'confirmed', sourceDurableSeq: '20' });
  projector.observe({ ...evidence, phase: 'confirmed', sourceDurableSeq: '20' });
  await tick();
  assert.equal(records.length, 1);
  projector.dispose();
});

test('target chat shows abandoned attempts as progress and appends each committed message once', async () => {
  const { createDshChatClient } = require('../../src/dshChatClient');
  let consumer;
  let prompt;
  let releases = 0;
  const signal = new AbortController().signal;
  const texts = [];
  const progress = [];
  const client = createDshChatClient({ baseUrlProvider: () => 'http://127.0.0.1:15920',
    runtimeApiProvider: () => ({ submitPrompt: async (input) => { prompt = input; } }), runtimeInstanceIdProvider: () => 'runtime-1',
    feedHubProvider: () => ({ subscribe(_key, value) { consumer = value; value.onBaseline({ state: { records: [], activeAttempts: [] } }); return { release() { releases++; } }; } }),
  });
  const done = client.streamSession({ sessionId: 'session-1', signal, onText: (text) => texts.push(text), onProgress: (text) => progress.push(text), onDone() {} });
  await tick();
  await client.prompt({ sessionId: 'session-1', signal, content: 'hello' });
  consumer.onUpdate({ kind: 'turn-state', state: 'running', clientRequestId: prompt.clientRequestId });
  consumer.onUpdate({ kind: 'assistant-chunk', channel: 'answer', text: 'discarded draft' });
  consumer.onUpdate({ kind: 'assistant-end', outcome: 'abandoned' });
  assert.deepEqual(texts, []);
  assert.deepEqual(progress, ['discarded draft']);
  const record = { id: 'event:4', kind: 'assistant', content: [{ kind: 'text', text: 'final answer' }] };
  consumer.onUpdate({ kind: 'durable', changes: [{ op: 'upsert', record }] });
  consumer.onUpdate({ kind: 'durable', changes: [{ op: 'upsert', record }] });
  consumer.onUpdate({ kind: 'turn-state', state: 'completed', clientRequestId: prompt.clientRequestId });
  await done;
  assert.deepEqual(texts, ['final answer']);
  assert.equal(releases, 1);
});

test('exact tool call snapshot joins in either channel order, while wrong call IDs do not join', async () => {
  const { createEditEventProjector } = require('../../src/editEventProjector');
  const writes = [];
  const projector = createEditEventProjector({ recordToolEdit: (value) => writes.push(value) });
  const evidence = { observationId: 'confirmed-1', runtimeInstanceId: 'runtime-1', sessionId: 'session-1', tool: 'edit', path: 'D:/file.txt', toolCallId: 'call-1', sourceDurableSeq: '10', beforeText: null, phase: 'confirmed' };
  projector.observe(evidence);
  projector.observe({ ...evidence, phase: 'pre-execute', observationId: 'pre-wrong', toolCallId: 'call-2', beforeText: 'unrelated' });
  assert.equal(writes.length, 1);
  projector.observe({ ...evidence, phase: 'pre-execute', observationId: 'pre-1', beforeText: 'correct before' });
  await tick();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].beforeText, 'correct before');
  assert.equal(writes[1].observationId, 'confirmed-1');
  projector.dispose();
});
