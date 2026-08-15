'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { CHANNEL, VERSION, handleInteractionRequest, parseInteractionRequest } = require('../src/interactionBridge');

const request = (method, params, requestId = 'request_1') => ({
  type: 'dshBridge', channel: CHANNEL, version: VERSION, requestId, method, params,
});

test('interaction requests accept clipboard text and http(s) links only', () => {
  assert.deepStrictEqual(parseInteractionRequest(request('clipboard/writeText', { text: 'copied' })), {
    requestId: 'request_1', method: 'clipboard/writeText', text: 'copied',
  });
  assert.strictEqual(parseInteractionRequest(request('link/open', { url: 'javascript:alert(1)' })), null);
  assert.strictEqual(parseInteractionRequest(request('link/open', { url: 'file:///tmp/a' })), null);
  assert.deepStrictEqual(parseInteractionRequest(request('link/open', { url: 'https://example.com/a' })), {
    requestId: 'request_1', method: 'link/open', url: 'https://example.com/a',
  });
});

test('interaction handler uses VS Code clipboard and Simple Browser', async () => {
  const calls = [];
  const replies = [];
  const vscode = {
    env: { clipboard: { async writeText(text) { calls.push(['copy', text]); } } },
    commands: { async executeCommand(...args) { calls.push(args); } },
  };
  const webview = { async postMessage(message) { replies.push(message); } };
  await handleInteractionRequest({ vscode, webview, message: request('clipboard/writeText', { text: 'hello' }) });
  await handleInteractionRequest({ vscode, webview, message: request('link/open', { url: 'http://example.com' }, 'request_2') });
  assert.deepStrictEqual(calls, [['copy', 'hello'], ['simpleBrowser.show', 'http://example.com/']]);
  assert.deepStrictEqual(replies.map((value) => [value.requestId, value.ok]), [['request_1', true], ['request_2', true]]);
});
