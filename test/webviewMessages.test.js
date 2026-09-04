'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createWebviewMessageHandler, DSH_THEME_CHANGED } = require('../src/webviewMessages');

test('Webview messages route only the fixed openBrowser and retry actions', () => {
  const calls = [];
  const handle = createWebviewMessageHandler({
    openBrowser: () => calls.push('openBrowser'),
    retry: () => calls.push('retry'),
  });

  assert.strictEqual(handle(null), false);
  assert.strictEqual(handle('retry'), false);
  assert.strictEqual(handle({ type: 'unknown' }), false);
  assert.strictEqual(handle({ type: 'openBrowser' }), true);
  assert.strictEqual(handle({ type: 'retry' }), true);
  assert.deepStrictEqual(calls, ['openBrowser', 'retry']);
});

test('Webview message routing rejects incomplete handler facades', () => {
  assert.throws(
    () => createWebviewMessageHandler({ openBrowser() {} }),
    /must be functions/
  );
});

test('Webview messages route in-iframe session switches when configured', () => {
  const seen = [];
  const handle = createWebviewMessageHandler({
    openBrowser: () => {},
    retry: () => {},
    sessionChanged: (sessionId) => seen.push(sessionId),
  });

  assert.strictEqual(handle({ type: 'dshSessionChanged', sessionId: 'session-abc' }), true);
  assert.deepStrictEqual(seen, ['session-abc']);
  // Without the optional handler the message is ignored (not routed).
  const bare = createWebviewMessageHandler({ openBrowser: () => {}, retry: () => {} });
  assert.strictEqual(bare({ type: 'dshSessionChanged', sessionId: 'x' }), false);
});

test('Webview messages route DSH interaction requests when configured', () => {
  const calls = [];
  const handle = createWebviewMessageHandler({
    openBrowser() {}, retry() {}, interaction(message) { calls.push(message); },
  });
  const message = { type: 'dshBridge', requestId: 'one' };
  assert.strictEqual(handle(message), true);
  assert.deepStrictEqual(calls, [message]);
});

test('Webview messages route DSH thread acknowledgements when configured', () => {
  const calls = [];
  const handle = createWebviewMessageHandler({
    openBrowser() {}, retry() {}, threadResult(message) { calls.push(message); },
  });
  const message = { type: 'dshThreadAttachResult', requestId: 'one', ok: true };
  assert.strictEqual(handle(message), true);
  assert.deepStrictEqual(calls, [message]);
});

test('Webview messages expose the dshThemeChanged protocol constant', () => {
  assert.strictEqual(DSH_THEME_CHANGED, 'dshThemeChanged');
});
