'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { CHANNEL, VERSION, handleInteractionRequest, parseInteractionRequest } = require('../src/interactionBridge');

const request = (method, params, requestId = 'request_1') => ({
  type: 'dshBridge', channel: CHANNEL, version: VERSION, requestId, method, params,
});

test('interaction requests accept clipboard text, http(s) links, and approved attachment ids only', () => {
  assert.deepStrictEqual(parseInteractionRequest(request('clipboard/writeText', { text: 'copied' })), {
    requestId: 'request_1', method: 'clipboard/writeText', text: 'copied',
  });
  assert.strictEqual(parseInteractionRequest(request('link/open', { url: 'javascript:alert(1)' })), null);
  assert.strictEqual(parseInteractionRequest(request('link/open', { url: 'file:///tmp/a' })), null);
  assert.deepStrictEqual(parseInteractionRequest(request('link/open', { url: 'https://example.com/a' })), {
    requestId: 'request_1', method: 'link/open', url: 'https://example.com/a',
  });
  assert.deepStrictEqual(parseInteractionRequest(request('attachment/open', { attachmentId: 'ctx-12' })), {
    requestId: 'request_1', method: 'attachment/open', attachmentId: 'ctx-12',
  });
  assert.strictEqual(parseInteractionRequest(request('attachment/open', { attachmentId: '../secret' })), null);
});

test('interaction handler uses VS Code clipboard, Simple Browser, and the attachment opener', async () => {
  const calls = [];
  const replies = [];
  const vscode = {
    env: { clipboard: { async writeText(text) { calls.push(['copy', text]); } } },
    commands: { async executeCommand(...args) { calls.push(args); } },
  };
  const webview = { async postMessage(message) { replies.push(message); } };
  const openAttachment = async (attachmentId) => { calls.push(['attachment', attachmentId]); };
  await handleInteractionRequest({ vscode, webview, message: request('clipboard/writeText', { text: 'hello' }) });
  await handleInteractionRequest({ vscode, webview, message: request('link/open', { url: 'http://example.com' }, 'request_2') });
  await handleInteractionRequest({
    vscode, webview, openAttachment,
    message: request('attachment/open', { attachmentId: 'ctx-3' }, 'request_3'),
  });
  assert.deepStrictEqual(calls, [
    ['copy', 'hello'],
    ['simpleBrowser.show', 'http://example.com/'],
    ['attachment', 'ctx-3'],
  ]);
  assert.deepStrictEqual(replies.map((value) => [value.requestId, value.ok]), [
    ['request_1', true], ['request_2', true], ['request_3', true],
  ]);
});

test('interaction handler reads the clipboard and returns the payload', async () => {
  const replies = [];
  const vscode = {
    env: { clipboard: { async readText() { return 'pasted'; } } },
    commands: { async executeCommand() {} },
  };
  const webview = { async postMessage(message) { replies.push(message); } };
  assert.deepStrictEqual(parseInteractionRequest(request('clipboard/readText', {})), {
    requestId: 'request_1', method: 'clipboard/readText',
  });
  await handleInteractionRequest({ vscode, webview, message: request('clipboard/readText', {}) });
  assert.strictEqual(replies.length, 1);
  assert.strictEqual(replies[0].ok, true);
  assert.deepStrictEqual(replies[0].data, { text: 'pasted' });
});
