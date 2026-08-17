'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const protocol = require('../../src/protocol/webview');
const webviewHtml = require('../../src/webviewHtml');
const webviewMessages = require('../../src/webviewMessages');
const interactionBridge = require('../../src/interactionBridge');
const threadAttachment = require('../../src/threadAttachment');

function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error('waitFor condition was not met before timeout'));
      setTimeout(poll, 5);
    };
    poll();
  });
}

function runFramePage(url = 'http://127.0.0.1:3080') {
  const html = webviewHtml.framePage({ url });
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, 'framePage must contain one inline script');
  const postedToVscode = [];
  const postedToFrame = [];
  const frameListeners = {};
  const windowListeners = {};
  let removed = false;
  let contentWindow = {
    postMessage(message, origin) {
      postedToFrame.push({ message, origin, target: contentWindow });
    },
  };
  const frame = {
    get contentWindow() {
      return contentWindow;
    },
    set contentWindow(value) {
      contentWindow = value;
    },
    addEventListener(type, callback) {
      frameListeners[type] = callback;
    },
    remove() {
      removed = true;
    },
  };
  const fallback = {
    classList: { add() {} },
  };
  const retry = {
    addEventListener() {},
  };
  const sandbox = {
    acquireVsCodeApi: () => ({
      postMessage(message) {
        postedToVscode.push(message);
      },
    }),
    document: {
      getElementById(id) {
        if (id === 'frame') return frame;
        if (id === 'fallback') return fallback;
        if (id === 'fallback-retry') return retry;
        return null;
      },
    },
    window: {
      addEventListener(type, callback) {
        windowListeners[type] = callback;
      },
    },
    location: { reload() {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    console,
  };
  vm.runInNewContext(match[1], sandbox);
  return {
    frame,
    frameListeners,
    origin: new URL(url).origin,
    postedToFrame,
    postedToVscode,
    removed: () => removed,
    setFrameContentWindow(value) {
      frame.contentWindow = value;
    },
    sendFromFrame(data, overrides = {}) {
      windowListeners.message({
        source: overrides.source === undefined ? frame.contentWindow : overrides.source,
        origin: overrides.origin === undefined ? new URL(url).origin : overrides.origin,
        data,
      });
    },
    sendFromExtension(data, overrides = {}) {
      windowListeners.message({
        source: overrides.source === undefined ? {} : overrides.source,
        origin: overrides.origin === undefined ? 'vscode-webview://extension' : overrides.origin,
        data,
      });
    },
    windowListeners,
  };
}

function loadClientHarness() {
  const clientPath = path.join(
    __dirname,
    '..',
    '..',
    'runtime-integration',
    'dsh-vscode-integration',
    'lib',
    'client.js'
  );
  const code = fs.readFileSync(clientPath, 'utf8');
  let loaded = null;
  const postedToParent = [];
  const timers = new Map();
  let nextTimerId = 1;
  let messageListener = null;
  const parent = {
    postMessage(message, targetOrigin) {
      postedToParent.push({ message, targetOrigin });
    },
  };
  const windowObj = {
    __ModuleLoader__: {
      load(definition) {
        loaded = definition;
      },
    },
    parent,
    location: { search: '?dsh_embed=vscode' },
    addEventListener(type, callback) {
      if (type === 'message') messageListener = callback;
    },
    removeEventListener() {},
  };
  const clipboard = { writeText() {} };
  const sandbox = {
    window: windowObj,
    navigator: { clipboard },
    document: {
      addEventListener() {},
      removeEventListener() {},
    },
    Element: function Element() {},
    TextEncoder,
    URL,
    URLSearchParams,
    setTimeout(callback, ms) {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, { callback, ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  const api = loaded.factory();
  return {
    api,
    clipboard,
    messageListener: () => messageListener,
    postedToParent,
    timers,
    windowObj,
  };
}

function applyClient(harness) {
  let cleanup = null;
  const ctx = {
    effect(fn) {
      cleanup = fn();
    },
    conversation: {
      input: {
        for() {
          return {
            state: { getSnapshot: () => ({ draft: '' }) },
            setDraft() {},
          };
        },
      },
    },
    sessions: {
      list: { getSnapshot: () => ({ current: 's' }) },
      scope: () => ({}),
    },
  };
  harness.api.apply(ctx);
  return { cleanup };
}

function bridgeMessage(requestId = 'request_1') {
  return {
    type: protocol.MESSAGE_TYPES.BRIDGE,
    channel: protocol.CHANNELS.INTERACTION,
    version: protocol.VERSIONS.INTERACTION,
    requestId,
    method: 'clipboard/writeText',
    params: { text: 'x' },
  };
}

function threadResultMessage(requestId = 'request_1') {
  return {
    type: protocol.MESSAGE_TYPES.THREAD_ATTACH_RESULT,
    channel: protocol.CHANNELS.THREAD,
    version: protocol.VERSIONS.THREAD,
    requestId,
    ok: true,
  };
}

test('B2 QA parsers reject overlong/NUL request ids and malformed envelopes', () => {
  const overLong = 'x'.repeat(201);
  for (const requestId of [overLong, 'bad\0id', '', 123, null, undefined]) {
    assert.strictEqual(interactionBridge.parseInteractionRequest({ ...bridgeMessage(), requestId }), null);
    assert.strictEqual(threadAttachment.parseThreadResult({ ...threadResultMessage(), requestId }), null);
  }
  for (const message of [null, undefined, 'x', 42, [], {}, { type: 'unknown' }]) {
    assert.strictEqual(interactionBridge.parseInteractionRequest(message), null);
    assert.strictEqual(threadAttachment.parseThreadResult(message), null);
  }
});

test('B2 QA webview message router ignores missing/unknown/non-object payloads', () => {
  const calls = [];
  const handle = webviewMessages.createWebviewMessageHandler({
    openBrowser() { calls.push('openBrowser'); },
    retry() { calls.push('retry'); },
    interaction() { calls.push('interaction'); },
    threadResult() { calls.push('threadResult'); },
    handshakeError() { calls.push('handshakeError'); },
  });
  for (const message of [null, undefined, 'x', 42, [], {}, { type: 'unknown' }]) {
    assert.strictEqual(handle(message), false);
  }
  assert.deepStrictEqual(calls, []);
});

test('B2 QA framePage ignores wrong source/origin and malformed message envelopes', () => {
  const page = runFramePage();
  page.sendFromFrame(bridgeMessage(), { source: {}, origin: page.origin });
  page.sendFromFrame(bridgeMessage(), { source: page.frame.contentWindow, origin: 'https://evil.example' });
  page.sendFromFrame(null);
  page.sendFromFrame('x');
  page.sendFromFrame(42);
  page.sendFromFrame({});
  page.sendFromFrame({ type: 'unknown' });
  assert.deepStrictEqual(page.postedToVscode, []);
  assert.deepStrictEqual(page.postedToFrame, []);
});

test('B2 QA framePage forwards thread attach through the original thread channel after load', () => {
  const page = runFramePage();
  page.frameListeners.load();
  const attach = {
    type: protocol.MESSAGE_TYPES.THREAD_ATTACH,
    channel: protocol.CHANNELS.THREAD,
    version: protocol.VERSIONS.THREAD,
    requestId: 'request_1',
    text: 'selected code',
  };
  page.sendFromExtension(attach);
  const forwarded = page.postedToFrame.find((entry) => entry.message.type === protocol.MESSAGE_TYPES.THREAD_ATTACH);
  assert.ok(forwarded, 'thread attach must be forwarded to the iframe after load');
  assert.deepStrictEqual(forwarded.message, attach);
});

test('B2 QA framePage re-sends READY after iframe reload and accepts HELLO in the new context', () => {
  const page = runFramePage();
  page.frameListeners.load();
  const readies = page.postedToFrame.filter((entry) => entry.message.type === protocol.MESSAGE_TYPES.READY);
  assert.strictEqual(readies.length, 1);

  const newWindow = {
    postMessage(message, origin) {
      page.postedToFrame.push({ message, origin, target: newWindow });
    },
  };
  page.setFrameContentWindow(newWindow);
  page.frameListeners.load();

  const readiesAfterReload = page.postedToFrame.filter((entry) => entry.message.type === protocol.MESSAGE_TYPES.READY);
  assert.strictEqual(readiesAfterReload.length, 2);
  assert.strictEqual(readiesAfterReload[1].target, newWindow);

  page.sendFromFrame({
    type: protocol.MESSAGE_TYPES.HELLO,
    channel: protocol.CHANNELS.INTERACTION,
    version: protocol.VERSIONS.INTERACTION,
    capabilities: {},
  }, { source: newWindow, origin: page.origin });
  assert.deepStrictEqual(
    page.postedToVscode.filter((message) => message.type === protocol.MESSAGE_TYPES.HELLO),
    []
  );
});

test('B2 QA hello/ready builders preserve non-1 versions; consumers reject or ignore them', () => {
  const hello = protocol.helloMessage(2, { clipboard: true });
  const ready = protocol.readyMessage(2, { clipboard: true });
  assert.strictEqual(hello.version, 2);
  assert.strictEqual(ready.version, 2);
  assert.strictEqual(protocol.isHello(hello), true);
  assert.strictEqual(protocol.isReady(ready), true);

  const page = runFramePage();
  page.sendFromFrame(hello);
  const mismatch = page.postedToVscode.find((message) => message.type === protocol.MESSAGE_TYPES.HELLO);
  assert.ok(mismatch);
  assert.strictEqual(mismatch.ok, false);
});

test('B2 QA repeated HELLO v1 is idempotent on the shell side', () => {
  const page = runFramePage();
  page.frameListeners.load();
  const hello = {
    type: protocol.MESSAGE_TYPES.HELLO,
    channel: protocol.CHANNELS.INTERACTION,
    version: protocol.VERSIONS.INTERACTION,
    capabilities: {},
  };
  page.sendFromFrame(hello);
  page.sendFromFrame(hello);
  assert.deepStrictEqual(page.postedToVscode, []);
});

test('B2 QA HELLO version above supported posts handshakeError and keeps the iframe', () => {
  const page = runFramePage();
  page.sendFromFrame({
    type: protocol.MESSAGE_TYPES.HELLO,
    channel: protocol.CHANNELS.INTERACTION,
    version: 2,
    capabilities: {},
  });
  const mismatch = page.postedToVscode.find((message) => message.type === protocol.MESSAGE_TYPES.HELLO);
  assert.ok(mismatch);
  assert.strictEqual(mismatch.ok, false);
  assert.match(mismatch.error, /版本不匹配/);
  assert.strictEqual(page.removed(), false);
});

test('B2 QA client ignores wrong source and malformed message envelopes without sending', () => {
  const harness = loadClientHarness();
  const { cleanup } = applyClient(harness);
  const listener = harness.messageListener();
  const before = harness.postedToParent.length;
  const ready = {
    type: protocol.MESSAGE_TYPES.READY,
    channel: protocol.CHANNELS.INTERACTION,
    version: protocol.VERSIONS.INTERACTION,
    capabilities: {},
  };
  listener({ source: {}, data: ready });
  listener({ source: harness.windowObj.parent, data: null });
  listener({ source: harness.windowObj.parent, data: 'x' });
  listener({ source: harness.windowObj.parent, data: 42 });
  listener({ source: harness.windowObj.parent, data: {} });
  listener({ source: harness.windowObj.parent, data: { type: 'unknown' } });
  assert.strictEqual(harness.postedToParent.length, before);
  cleanup();
});

test('B2 QA client re-arms handshake after dispose and does not leak the old timer', () => {
  const harness = loadClientHarness();
  const first = applyClient(harness);
  assert.strictEqual(harness.postedToParent.filter((entry) => entry.message.type === protocol.MESSAGE_TYPES.HELLO).length, 1);
  assert.strictEqual([...harness.timers.values()].filter((timer) => timer.ms === 2000).length, 1);

  first.cleanup();
  assert.strictEqual([...harness.timers.values()].filter((timer) => timer.ms === 2000).length, 0);

  const second = applyClient(harness);
  assert.strictEqual(harness.postedToParent.filter((entry) => entry.message.type === protocol.MESSAGE_TYPES.HELLO).length, 2);
  assert.strictEqual([...harness.timers.values()].filter((timer) => timer.ms === 2000).length, 1);
  second.cleanup();
});

test('B2 QA client repeated READY v1 is idempotent', async () => {
  const harness = loadClientHarness();
  const { cleanup } = applyClient(harness);
  const listener = harness.messageListener();
  const bridgePosts = () => harness.postedToParent.filter((entry) => entry.message.type === protocol.MESSAGE_TYPES.BRIDGE);

  const write = harness.clipboard.writeText('hello');
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(bridgePosts().length, 0);

  const ready = {
    type: protocol.MESSAGE_TYPES.READY,
    channel: protocol.CHANNELS.INTERACTION,
    version: protocol.VERSIONS.INTERACTION,
    capabilities: {},
  };
  listener({ source: harness.windowObj.parent, data: ready });
  listener({ source: harness.windowObj.parent, data: ready });

  await waitFor(() => bridgePosts().length === 1);
  assert.strictEqual(bridgePosts().length, 1);
  const posted = bridgePosts()[0].message;
  listener({
    source: harness.windowObj.parent,
    data: {
      type: protocol.MESSAGE_TYPES.BRIDGE_RESULT,
      channel: protocol.CHANNELS.INTERACTION,
      version: protocol.VERSIONS.INTERACTION,
      requestId: posted.requestId,
      ok: true,
    },
  });
  await write;
  cleanup();
});

test('B2 QA client ignores unsupported READY versions and keeps the 2s degraded passthrough', async () => {
  const harness = loadClientHarness();
  const { cleanup } = applyClient(harness);
  const listener = harness.messageListener();
  const bridgePosts = () => harness.postedToParent.filter((entry) => entry.message.type === protocol.MESSAGE_TYPES.BRIDGE);

  const write = harness.clipboard.writeText('hello');
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(bridgePosts().length, 0);

  listener({
    source: harness.windowObj.parent,
    data: {
      type: protocol.MESSAGE_TYPES.READY,
      channel: protocol.CHANNELS.INTERACTION,
      version: 2,
      capabilities: {},
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(bridgePosts().length, 0);

  const handshakeTimer = [...harness.timers.values()].find((timer) => timer.ms === 2000);
  assert.ok(handshakeTimer);
  handshakeTimer.callback();
  await waitFor(() => bridgePosts().length === 1);
  assert.strictEqual(bridgePosts()[0].message.version, protocol.VERSIONS.INTERACTION);
  const posted = bridgePosts()[0].message;
  listener({
    source: harness.windowObj.parent,
    data: {
      type: protocol.MESSAGE_TYPES.BRIDGE_RESULT,
      channel: protocol.CHANNELS.INTERACTION,
      version: protocol.VERSIONS.INTERACTION,
      requestId: posted.requestId,
      ok: true,
    },
  });
  await write;
  cleanup();
});

test('B2 QA client handles THREAD_ATTACH without waiting for READY and returns a versioned result', async () => {
  const harness = loadClientHarness();
  const { cleanup } = applyClient(harness);
  const listener = harness.messageListener();
  const attach = {
    type: protocol.MESSAGE_TYPES.THREAD_ATTACH,
    channel: protocol.CHANNELS.THREAD,
    version: protocol.VERSIONS.THREAD,
    requestId: 'request_1',
    text: 'selected code',
  };
  listener({ source: harness.windowObj.parent, data: attach });
  await waitFor(() => harness.postedToParent.some((entry) => entry.message.type === protocol.MESSAGE_TYPES.THREAD_ATTACH_RESULT));
  const result = harness.postedToParent.find((entry) => entry.message.type === protocol.MESSAGE_TYPES.THREAD_ATTACH_RESULT).message;
  assert.strictEqual(result.channel, protocol.CHANNELS.THREAD);
  assert.strictEqual(result.version, protocol.VERSIONS.THREAD);
  assert.strictEqual(result.requestId, 'request_1');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(harness.postedToParent.some((entry) => entry.message.type === protocol.MESSAGE_TYPES.BRIDGE), false);
  cleanup();
});

test('B2 QA framePage keeps the existing HTML escaping for XSS-bearing iframe/error content', () => {
  const evil = '<script>alert(1)</script>"\\<img src=x onerror=alert(1)></iframe>';
  const html = webviewHtml.framePage({
    url: 'http://127.0.0.1:3080/?x="><script>alert(1)</script>',
    failText: evil,
    openBrowserLabel: evil,
    retryLabel: evil,
    lang: evil,
  });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(!html.includes('<img src=x onerror=alert(1)>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('&quot;'));
  assert.strictEqual((html.match(/<\/iframe>/g) || []).length, 1);
});

test('B2 QA thread coordinator still posts the original thread channel/version message', async () => {
  const sent = [];
  const coordinator = new threadAttachment.ThreadAttachmentCoordinator({ timeoutMs: 1000 });
  const pending = coordinator.request({
    async postMessage(message) {
      sent.push(message);
      return true;
    },
  }, 'selected code');
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].type, protocol.MESSAGE_TYPES.THREAD_ATTACH);
  assert.strictEqual(sent[0].channel, protocol.CHANNELS.THREAD);
  assert.strictEqual(sent[0].version, protocol.VERSIONS.THREAD);
  assert.strictEqual(coordinator.handleResult({
    type: protocol.MESSAGE_TYPES.THREAD_ATTACH_RESULT,
    channel: protocol.CHANNELS.THREAD,
    version: protocol.VERSIONS.THREAD,
    requestId: sent[0].requestId,
    ok: true,
  }), true);
  await pending;
  coordinator.dispose();
});

test('B2 QA framePage rejects overlong/NUL bridge request ids without forwarding', () => {
  for (const requestId of ['x'.repeat(201), 'bad\0id']) {
    const page = runFramePage();
    page.sendFromFrame(bridgeMessage(requestId));
    assert.strictEqual(page.postedToVscode.length, 0, 'overlong/NUL request id must not be forwarded to VS Code');
    assert.strictEqual(page.postedToFrame.length, 0);
  }
});

test('B2 QA client rejects overlong/NUL THREAD_ATTACH request ids without sending a result', async () => {
  const harness = loadClientHarness();
  const { cleanup } = applyClient(harness);
  const listener = harness.messageListener();
  for (const requestId of ['x'.repeat(201), 'bad\0id']) {
    listener({
      source: harness.windowObj.parent,
      data: {
        type: protocol.MESSAGE_TYPES.THREAD_ATTACH,
        channel: protocol.CHANNELS.THREAD,
        version: protocol.VERSIONS.THREAD,
        requestId,
        text: 'selected code',
      },
    });
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(
    harness.postedToParent.some((entry) => entry.message.type === protocol.MESSAGE_TYPES.THREAD_ATTACH_RESULT),
    false
  );
  cleanup();
});