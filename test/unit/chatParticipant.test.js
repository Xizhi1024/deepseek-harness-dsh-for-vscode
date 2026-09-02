'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createChatParticipantModule } = require('../../src/chatParticipant');

const DISABLED_MESSAGE = 'DSH chat participant is disabled (dsh.features.chat-participant).';

function defaultLoc(template, params = {}) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? `{${key}}`));
}

function makeResponse({ throwOnMarkdown = false } = {}) {
  return {
    calls: [],
    attempts: 0,
    markdown(text) {
      this.attempts += 1;
      if (throwOnMarkdown) throw new Error('markdown broken');
      this.calls.push(text);
    },
  };
}

function makeToken() {
  const listeners = [];
  const token = {
    isCancellationRequested: false,
    disposed: 0,
    onCancellationRequested(listener) {
      listeners.push(listener);
      return () => {
        token.disposed += 1;
        const index = listeners.indexOf(listener);
        if (index !== -1) listeners.splice(index, 1);
      };
    },
    cancel() {
      token.isCancellationRequested = true;
      for (const listener of [...listeners]) listener();
    },
  };
  return token;
}

function makeDeps() {
  const promptCalls = [];
  const streamCalls = [];
  const resolveCalls = [];
  const listCalls = [];
  const order = [];
  const deps = {
    chatClient: {
      async prompt(args) {
        order.push('prompt');
        promptCalls.push(args);
        return { accepted: true, sessionId: args.sessionId };
      },
      async streamSession(args) {
        order.push('stream');
        streamCalls.push(args);
        if (typeof args.onReady === 'function') {
          order.push('stream-ready');
          args.onReady();
        }
        return { reason: 'stream-end' };
      },
    },
    resolveSessionId: async () => {
      resolveCalls.push(1);
      return 'session-1';
    },
    isEnabled: () => true,
    listSessionsFn: async () => {
      listCalls.push(1);
      return [];
    },
    loc: defaultLoc,
  };
  return { deps, promptCalls, streamCalls, resolveCalls, listCalls, order };
}

// ---------------------------------------------------------------------------
// handleRequest
// ---------------------------------------------------------------------------

test('handleRequest queues request.prompt and streams markdown chunks, splitting overlong deltas', async () => {
  const { deps, promptCalls, streamCalls, resolveCalls, order } = makeDeps();
  const longDelta = 'a'.repeat(17000);
  deps.chatClient.streamSession = async (args) => {
    streamCalls.push(args);
    order.push('stream');
    if (typeof args.onReady === 'function') {
      order.push('stream-ready');
      args.onReady();
    }
    args.onText('hi');
    args.onText(longDelta);
    return { reason: 'stream-end' };
  };

  const module = createChatParticipantModule(deps);
  const response = makeResponse();
  const token = makeToken();

  await module.handleRequest({ prompt: 'hello' }, {}, response, token);

  assert.equal(resolveCalls.length, 1);
  assert.equal(promptCalls.length, 1);
  assert.deepStrictEqual(promptCalls[0], {
    sessionId: 'session-1',
    content: 'hello',
    mode: 'queue',
    signal: promptCalls[0].signal,
  });
  assert.ok(promptCalls[0].signal instanceof AbortSignal);
  assert.equal(streamCalls.length, 1);
  assert.equal(streamCalls[0].sessionId, 'session-1');
  assert.strictEqual(streamCalls[0].signal, promptCalls[0].signal);
  assert.deepStrictEqual(order, ['stream', 'stream-ready', 'prompt']);
  assert.deepStrictEqual(response.calls, [
    'hi',
    'a'.repeat(8000),
    'a'.repeat(8000),
    'a'.repeat(1000),
  ]);
  assert.equal(token.disposed, 1);
  assert.equal(Object.isFrozen(module), true);
});

test('handleRequest only shows the disabled message and makes no DSH requests when the feature gate is off', async () => {
  const { deps, promptCalls, streamCalls, resolveCalls } = makeDeps();
  deps.isEnabled = () => false;

  const module = createChatParticipantModule(deps);
  const response = makeResponse();

  await module.handleRequest({ prompt: 'hi' }, {}, response, makeToken());

  assert.deepStrictEqual(response.calls, [DISABLED_MESSAGE]);
  assert.equal(resolveCalls.length, 0);
  assert.equal(promptCalls.length, 0);
  assert.equal(streamCalls.length, 0);
});

test('handleRequest surfaces resolveSessionId errors as markdown and does not throw', async () => {
  const { deps, promptCalls, streamCalls } = makeDeps();
  deps.resolveSessionId = async () => {
    throw new Error('boom');
  };

  const module = createChatParticipantModule(deps);
  const response = makeResponse();

  await assert.doesNotReject(module.handleRequest({ prompt: 'hi' }, {}, response, makeToken()));
  assert.equal(response.calls.length, 1);
  assert.match(response.calls[0], /DSH unavailable: boom/);
  assert.equal(promptCalls.length, 0);
  assert.equal(streamCalls.length, 0);
});

test('handleRequest surfaces prompt errors as markdown and aborts the live stream', async () => {
  const { deps, promptCalls, streamCalls } = makeDeps();
  deps.chatClient.prompt = async (args) => {
    promptCalls.push(args);
    throw new Error('prompt down');
  };

  const module = createChatParticipantModule(deps);
  const response = makeResponse();

  await assert.doesNotReject(module.handleRequest({ prompt: 'hi' }, {}, response, makeToken()));
  assert.equal(response.calls.length, 1);
  assert.match(response.calls[0], /DSH unavailable: prompt down/);
  assert.equal(promptCalls.length, 1);
  assert.equal(streamCalls.length, 1);
  assert.equal(streamCalls[0].signal.aborted, true);
});

test('handleRequest never sends the prompt when the live stream fails before ready', async () => {
  const { deps, promptCalls, streamCalls } = makeDeps();
  deps.chatClient.streamSession = async (args) => {
    streamCalls.push(args);
    args.onDone({ reason: 'DSH_SESSION_API_UNAVAILABLE' });
    return { reason: 'DSH_SESSION_API_UNAVAILABLE' };
  };

  const module = createChatParticipantModule(deps);
  const response = makeResponse();

  await assert.doesNotReject(module.handleRequest({ prompt: 'hi' }, {}, response, makeToken()));
  assert.equal(promptCalls.length, 0);
  assert.equal(response.calls.length, 1);
  assert.match(response.calls[0], /DSH unavailable: live stream/);
});

test('handleRequest streams markdown progressively as live deltas arrive', async () => {
  const { deps } = makeDeps();
  deps.chatClient.streamSession = async (args) => {
    if (typeof args.onReady === 'function') args.onReady();
    args.onText('Hello');
    args.onText(' native');
    args.onText(' chat!');
    return { reason: 'stream-end' };
  };

  const module = createChatParticipantModule(deps);
  const response = makeResponse();

  await module.handleRequest({ prompt: 'hi' }, {}, response, makeToken());

  assert.ok(response.calls.length >= 2, 'markdown must be called per delta (true streaming)');
  assert.deepStrictEqual(response.calls, ['Hello', ' native', ' chat!']);
});

test('handleRequest wires token cancellation into the prompt/stream AbortSignal and disposes the listener', async () => {
  const { deps, promptCalls, streamCalls } = makeDeps();
  const token = makeToken();
  deps.chatClient.prompt = async (args) => {
    promptCalls.push(args);
    token.cancel();
    return { accepted: true, sessionId: args.sessionId };
  };

  const module = createChatParticipantModule(deps);
  const response = makeResponse();

  await module.handleRequest({ prompt: 'hi' }, {}, response, token);

  assert.equal(promptCalls.length, 1);
  assert.equal(promptCalls[0].signal.aborted, true);
  assert.equal(streamCalls.length, 1);
  assert.strictEqual(streamCalls[0].signal, promptCalls[0].signal);
  assert.equal(streamCalls[0].signal.aborted, true);
  assert.equal(token.disposed, 1);
});

test('handleRequest sends no requests when the token is already cancelled', async () => {
  const { deps, promptCalls, streamCalls, resolveCalls } = makeDeps();
  const token = makeToken();
  token.isCancellationRequested = true;

  const module = createChatParticipantModule(deps);
  const response = makeResponse();

  await module.handleRequest({ prompt: 'hi' }, {}, response, token);

  assert.equal(resolveCalls.length, 0);
  assert.equal(promptCalls.length, 0);
  assert.equal(streamCalls.length, 0);
  assert.equal(response.calls.length, 0);
});

test('handleRequest aborts the stream and stops calling markdown when response.markdown throws', async () => {
  const { deps, streamCalls } = makeDeps();
  deps.chatClient.streamSession = async (args) => {
    streamCalls.push(args);
    if (typeof args.onReady === 'function') args.onReady();
    args.onText('a'.repeat(8500));
    args.onText('b');
    return { reason: 'stream-end' };
  };

  const module = createChatParticipantModule(deps);
  const response = makeResponse({ throwOnMarkdown: true });

  await module.handleRequest({ prompt: 'hi' }, {}, response, makeToken());

  assert.equal(response.attempts, 1);
  assert.equal(response.calls.length, 0);
  assert.equal(streamCalls[0].signal.aborted, true);
});

test('handleRequest never reads request.model', async () => {
  const { deps, streamCalls } = makeDeps();
  deps.chatClient.streamSession = async (args) => {
    streamCalls.push(args);
    if (typeof args.onReady === 'function') args.onReady();
    args.onText('ok');
    return { reason: 'stream-end' };
  };
  const request = { prompt: 'hi' };
  let modelReads = 0;
  Object.defineProperty(request, 'model', {
    get() {
      modelReads += 1;
      return { family: 'gpt-4o' };
    },
    enumerable: true,
    configurable: true,
  });

  const module = createChatParticipantModule(deps);
  const response = makeResponse();

  await module.handleRequest(request, {}, response, makeToken());

  assert.equal(modelReads, 0);
  assert.deepStrictEqual(response.calls, ['ok']);
});

// ---------------------------------------------------------------------------
// provideFollowups
// ---------------------------------------------------------------------------

test('provideFollowups returns up to 5 root sessions with title/sessionId fallbacks', async () => {
  const { deps } = makeDeps();
  const longId = 'x'.repeat(30);
  deps.listSessionsFn = async () => [
    { sessionId: 's1', title: 'First', updatedAt: 7 },
    { sessionId: longId, title: '', updatedAt: 6 },
    { sessionId: 's3', title: 'Subagent', updatedAt: 5, origin: 'subagent' },
    { sessionId: 's4', title: 'Child', updatedAt: 4, parentSessionId: 's1' },
    { sessionId: 's5', title: 'Fifth', updatedAt: 3 },
    { sessionId: 's6', title: 'Sixth', updatedAt: 2 },
    { sessionId: 's7', title: 'Seventh', updatedAt: 1 },
  ];

  const module = createChatParticipantModule(deps);
  const followups = await module.provideFollowups({}, {}, makeToken());

  assert.equal(followups.length, 5);
  assert.deepStrictEqual(followups[0], { label: 'First', prompt: 'First', participant: 'dsh' });
  assert.deepStrictEqual(followups[1], {
    label: longId,
    prompt: longId.slice(0, 24),
    participant: 'dsh',
  });
  assert.deepStrictEqual(followups[2], { label: 'Fifth', prompt: 'Fifth', participant: 'dsh' });
  assert.deepStrictEqual(followups[3], { label: 'Sixth', prompt: 'Sixth', participant: 'dsh' });
  assert.deepStrictEqual(followups[4], { label: 'Seventh', prompt: 'Seventh', participant: 'dsh' });
});

test('provideFollowups silently returns [] when the feature gate is off', async () => {
  const { deps, listCalls } = makeDeps();
  deps.isEnabled = () => false;

  const module = createChatParticipantModule(deps);
  const followups = await module.provideFollowups({}, {}, makeToken());

  assert.deepStrictEqual(followups, []);
  assert.equal(listCalls.length, 0);
});

test('provideFollowups silently returns [] when listSessionsFn throws', async () => {
  const { deps, listCalls } = makeDeps();
  deps.listSessionsFn = async () => {
    listCalls.push(1);
    throw new Error('list down');
  };

  const module = createChatParticipantModule(deps);
  const followups = await module.provideFollowups({}, {}, makeToken());

  assert.deepStrictEqual(followups, []);
  assert.equal(listCalls.length, 1);
});

// ---------------------------------------------------------------------------
// B2 session titles
// ---------------------------------------------------------------------------

test('handleRequest renames the session from the first prompt via titleSession (once per session)', async () => {
  const { deps } = makeDeps();
  const titleCalls = [];
  deps.titleSession = async (sessionId, title) => {
    titleCalls.push({ sessionId, title });
    return true;
  };
  const module = createChatParticipantModule(deps);

  await module.handleRequest({ prompt: 'Fix the login bug\n\nstack trace follows' }, {}, makeResponse(), makeToken());
  await module.handleRequest({ prompt: 'second message' }, {}, makeResponse(), makeToken());

  assert.deepStrictEqual(titleCalls, [{ sessionId: 'session-1', title: 'Fix the login bug' }]);
});

test('handleRequest skips the rename when no title is derivable', async () => {
  const { deps } = makeDeps();
  const titleCalls = [];
  deps.titleSession = async (sessionId, title) => {
    titleCalls.push({ sessionId, title });
  };
  const module = createChatParticipantModule(deps);

  await module.handleRequest({ prompt: '\n   \t' }, {}, makeResponse(), makeToken());

  assert.deepStrictEqual(titleCalls, []);
});

test('handleRequest keeps the response intact when titleSession rejects', async () => {
  const { deps, promptCalls } = makeDeps();
  deps.titleSession = async () => { throw new Error('rename failed'); };
  const module = createChatParticipantModule(deps);
  const response = makeResponse();

  await module.handleRequest({ prompt: 'hello' }, {}, response, makeToken());

  assert.strictEqual(promptCalls.length, 1);
  assert.ok(!response.calls.some((text) => String(text).includes('rename')), 'rename failure must not surface');
});

test('createChatParticipantModule rejects a non-function titleSession', () => {
  const { deps } = makeDeps();
  deps.titleSession = 'nope';
  assert.throws(() => createChatParticipantModule(deps), /titleSession must be a function/);
});
