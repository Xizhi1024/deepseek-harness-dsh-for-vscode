'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const webviewHtml = require('../../src/webviewHtml');
const webviewMessages = require('../../src/webviewMessages');

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

function runFramePage(url) {
  const html = webviewHtml.framePage({ url });
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, 'framePage must contain one inline script');
  const postedToVscode = [];
  const postedToFrame = [];
  const frameListeners = {};
  const windowListeners = {};
  const timers = [];
  const fallbackClasses = new Set();
  const events = [];
  let frameSrc = null;
  let inserted = false;
  let removed = false;
  let retryClick = null;
  const frame = {
    contentWindow: {
      postMessage(message, origin) {
        postedToFrame.push({ message, origin });
      },
    },
    style: { display: "", cssText: "" },
    setAttribute() {},
    addEventListener(type, callback) {
      frameListeners[type] = callback;
      events.push('on:' + type);
    },
    set src(value) {
      frameSrc = value;
      events.push('src');
    },
    get src() {
      return frameSrc;
    },
    remove() {
      removed = true;
    },
  };
  const fallback = {
    classList: {
      add(name) { fallbackClasses.add(name); },
      remove(name) { fallbackClasses.delete(name); },
      contains(name) { return fallbackClasses.has(name); },
    },
  };
  const retry = {
    addEventListener(type, callback) {
      if (type === 'click') retryClick = callback;
    },
  };
  const sandbox = {
    acquireVsCodeApi: () => ({
      postMessage(message) {
        postedToVscode.push(message);
      },
    }),
    document: {
      createElement(tag) {
        assert.strictEqual(tag, 'iframe');
        return frame;
      },
      body: {
        insertBefore(element, before) {
          assert.strictEqual(element, frame);
          assert.strictEqual(before, fallback);
          inserted = true;
        },
      },
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
    setTimeout: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimeout: () => {},
    console,
  };
  vm.runInNewContext(match[1], sandbox);
  return {
    frame,
    frameListeners,
    fallbackClasses,
    frameSrc: () => frameSrc,
    events: () => events.slice(),
    inserted: () => inserted,
    origin: new URL(url).origin,
    postedToFrame,
    postedToVscode,
    removed: () => removed,
    timers,
    clickRetry() {
      assert.ok(retryClick, 'retry button must have a click handler');
      retryClick();
    },
    windowListeners,
  };
}

test('framePage handshake: ready after load, hello accepted, bridge still passes through', () => {
  const page = runFramePage('http://127.0.0.1:3080');
  page.frameListeners.load();

  assert.ok(
    page.postedToFrame.some((entry) => entry.message.type === 'dshWebviewReady' && entry.message.version === 1),
    'shell must send dshWebviewReady after iframe load'
  );

  page.windowListeners.message({
    source: page.frame.contentWindow,
    origin: page.origin,
    data: {
      type: 'dshWebviewHello',
      channel: 'dsh-vscode-interaction',
      version: 1,
      capabilities: {},
    },
  });

  page.windowListeners.message({
    source: page.frame.contentWindow,
    origin: page.origin,
    data: {
      type: 'dshBridge',
      channel: 'dsh-vscode-interaction',
      version: 1,
      requestId: 'request_1',
      method: 'clipboard/writeText',
      params: { text: 'x' },
    },
  });

  assert.ok(
    page.postedToVscode.some((message) => message.type === 'dshBridge'),
    'bridge message must be forwarded after the optional hello handshake'
  );
  assert.strictEqual(page.removed(), false, 'a successful handshake must keep the iframe visible');
});

test('framePage keeps v1 direct passthrough when no hello is received', () => {
  const page = runFramePage('http://127.0.0.1:3080');
  page.windowListeners.message({
    source: page.frame.contentWindow,
    origin: page.origin,
    data: {
      type: 'dshBridge',
      channel: 'dsh-vscode-interaction',
      version: 1,
      requestId: 'request_1',
      method: 'link/open',
      params: { url: 'https://example.com' },
    },
  });

  assert.ok(
    page.postedToVscode.some((message) => message.type === 'dshBridge'),
    'v1 clients that never send hello must keep the old direct passthrough'
  );
  assert.strictEqual(page.removed(), false, 'v1 passthrough must not hide the iframe');
});

test('framePage reports a version mismatch without removing the iframe', () => {
  const page = runFramePage('http://127.0.0.1:3080');
  page.windowListeners.message({
    source: page.frame.contentWindow,
    origin: page.origin,
    data: {
      type: 'dshWebviewHello',
      channel: 'dsh-vscode-interaction',
      version: 2,
      capabilities: {},
    },
  });

  const mismatch = page.postedToVscode.find((message) => message.type === 'dshWebviewHello');
  assert.ok(mismatch, 'version mismatch must be reported to the extension host');
  assert.strictEqual(mismatch.ok, false);
  assert.match(mismatch.error, /版本不匹配/);
  assert.strictEqual(page.removed(), false, 'version mismatch must keep the iframe visible');
});

test('webview message router forwards handshake errors when configured', () => {
  const calls = [];
  const handle = webviewMessages.createWebviewMessageHandler({
    openBrowser() {},
    retry() {},
    handshakeError(message) {
      calls.push(message);
    },
  });
  const mismatch = {
    type: 'dshWebviewHello',
    channel: 'dsh-vscode-interaction',
    version: 2,
    ok: false,
    error: 'Webview 桥版本不匹配',
  };
  assert.strictEqual(handle(mismatch), true);
  assert.deepStrictEqual(calls, [mismatch]);
});

function loadClientHarness(options = {}) {
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
  const documentListeners = {};
  const execCommands = [];
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
    navigator: { clipboard, platform: options.platform ?? 'MacIntel' },
    document: {
      addEventListener(type, callback) {
        documentListeners[type] = callback;
      },
      removeEventListener(type) {
        delete documentListeners[type];
      },
      execCommand(command) {
        execCommands.push(command);
      },
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
    documentListeners,
    execCommands,
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

test('client waits for READY before sending dshBridge and flushes after READY', async () => {
  const harness = loadClientHarness();
  applyClient(harness);
  const listener = harness.messageListener();
  assert.ok(listener, 'client must register a message listener');

  const bridgePosts = () => harness.postedToParent.filter((entry) => entry.message.type === 'dshBridge');
  const write = harness.clipboard.writeText('hello');
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(bridgePosts().length, 0, 'dshBridge must not be sent before READY');

  listener({
    source: harness.windowObj.parent,
    data: {
      type: 'dshWebviewReady',
      channel: 'dsh-vscode-interaction',
      version: 1,
      capabilities: {},
    },
  });

  await waitFor(() => bridgePosts().length === 1);
  const posted = bridgePosts()[0].message;
  assert.strictEqual(posted.method, 'clipboard/writeText');
  assert.strictEqual(posted.params.text, 'hello');

  listener({
    source: harness.windowObj.parent,
    data: {
      type: 'dshBridgeResult',
      channel: 'dsh-vscode-interaction',
      version: 1,
      requestId: posted.requestId,
      ok: true,
    },
  });
  await write;
});

test('client degrades to v1 passthrough when no READY arrives within 2s', async () => {
  const harness = loadClientHarness();
  const { cleanup } = applyClient(harness);
  const listener = harness.messageListener();

  const bridgePosts = () => harness.postedToParent.filter((entry) => entry.message.type === 'dshBridge');
  const write = harness.clipboard.writeText('hello');
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(bridgePosts().length, 0);

  const handshakeTimer = [...harness.timers.values()].find((timer) => timer.ms === 2000);
  assert.ok(handshakeTimer, 'client must arm a 2s handshake timeout');
  handshakeTimer.callback();

  await waitFor(() => bridgePosts().length === 1);
  const posted = bridgePosts()[0].message;
  assert.strictEqual(posted.method, 'clipboard/writeText');

  listener({
    source: harness.windowObj.parent,
    data: {
      type: 'dshBridgeResult',
      channel: 'dsh-vscode-interaction',
      version: 1,
      requestId: posted.requestId,
      ok: true,
    },
  });
  await write;
  cleanup();
});

test('client installs a macOS Cmd+V paste bridge inside the embedded iframe', () => {
  const harness = loadClientHarness();
  const { cleanup } = applyClient(harness);

  const keydown = harness.documentListeners.keydown;
  assert.ok(keydown, 'client must install a keydown listener on macOS');
  assert.strictEqual(harness.execCommands.length, 0);

  let prevented = false;
  keydown({
    metaKey: true,
    ctrlKey: false,
    code: 'KeyV',
    key: 'v',
    defaultPrevented: false,
    preventDefault() {
      prevented = true;
    },
  });

  assert.strictEqual(harness.execCommands.length, 1);
  assert.strictEqual(harness.execCommands[0], 'paste');
  assert.strictEqual(prevented, true, 'Cmd+V must suppress the intercepted native handling');

  cleanup();
  assert.strictEqual(harness.documentListeners.keydown, undefined, 'cleanup must remove the keydown bridge');
});

test('client does not install the paste bridge on non-mac platforms', () => {
  const harness = loadClientHarness({ platform: 'Win32' });
  applyClient(harness);

  assert.strictEqual(harness.documentListeners.keydown, undefined, 'paste shortcut bridge is macOS-only');
  assert.strictEqual(harness.execCommands.length, 0);
});

test('framePage attaches load/error handlers before navigating the iframe', () => {
  const page = runFramePage('http://127.0.0.1:3080');
  const events = page.events();
  const loadIndex = events.indexOf('on:load');
  const errorIndex = events.indexOf('on:error');
  const srcIndex = events.indexOf('src');
  assert.ok(loadIndex >= 0 && errorIndex >= 0, 'both frame handlers must be installed');
  assert.ok(srcIndex >= 0, 'the frame must be navigated');
  assert.ok(loadIndex < srcIndex, 'the load handler must exist before src is set');
  assert.ok(errorIndex < srcIndex, 'the error handler must exist before src is set');
});

test('framePage timeout keeps the iframe and a late load heals the fallback', () => {
  const page = runFramePage('http://127.0.0.1:3080');
  assert.strictEqual(page.fallbackClasses.has('show'), false);

  page.timers[0]();

  assert.ok(page.fallbackClasses.has('show'), 'timeout must show the fallback');
  assert.strictEqual(page.frame.style.display, 'none', 'the iframe is hidden, not destroyed');
  assert.strictEqual(page.removed(), false, 'a timeout must never remove the iframe');
  assert.ok(
    page.postedToVscode.some((message) => message.type === 'frameLoadFailed' && message.reason === 'timeout'),
    'the shell must report the failure to the host for diagnostics'
  );

  page.frameListeners.load();

  assert.strictEqual(page.fallbackClasses.has('show'), false, 'a late load must hide the fallback');
  assert.strictEqual(page.frame.style.display, '', 'the iframe must become visible again');
  assert.ok(
    page.postedToFrame.some((entry) => entry.message.type === 'dshWebviewReady'),
    'a healed frame still receives READY'
  );
});

test('framePage retry re-navigates the same iframe and arms a fresh timer', () => {
  const page = runFramePage('http://127.0.0.1:3080');
  page.timers[0]();
  const originalSrc = page.frameSrc();
  assert.ok(originalSrc, 'the frame must have a URL');

  page.clickRetry();

  assert.strictEqual(page.fallbackClasses.has('show'), false, 'retry must hide the fallback');
  assert.strictEqual(page.frame.style.display, '', 'retry must show the iframe');
  assert.strictEqual(page.frameSrc(), originalSrc, 'retry must reuse the memoized embed URL');
  assert.strictEqual(page.timers.length, 2, 'retry must arm another load timeout');
});
