'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const protocol = require('../../src/protocol/webview');
const interactionBridge = require('../../src/interactionBridge');
const threadAttachment = require('../../src/threadAttachment');
const webviewHtml = require('../../src/webviewHtml');
const webviewMessages = require('../../src/webviewMessages');

test('Webview protocol constants are shared by reference across modules', () => {
  assert.strictEqual(interactionBridge.CHANNEL, protocol.CHANNELS.INTERACTION);
  assert.strictEqual(interactionBridge.VERSION, protocol.VERSIONS.INTERACTION);
  assert.strictEqual(threadAttachment.CHANNEL, protocol.CHANNELS.THREAD);
  assert.strictEqual(threadAttachment.VERSION, protocol.VERSIONS.THREAD);
  assert.strictEqual(webviewHtml.CHANNELS, protocol.CHANNELS);
  assert.strictEqual(webviewHtml.VERSIONS, protocol.VERSIONS);
  assert.strictEqual(webviewHtml.MESSAGE_TYPES, protocol.MESSAGE_TYPES);
  assert.strictEqual(webviewMessages.CHANNELS, protocol.CHANNELS);
  assert.strictEqual(webviewMessages.VERSIONS, protocol.VERSIONS);
  assert.strictEqual(webviewMessages.MESSAGE_TYPES, protocol.MESSAGE_TYPES);
});

test('Webview protocol validators accept well-formed bridge and thread messages', () => {
  const bridge = {
    type: protocol.MESSAGE_TYPES.BRIDGE,
    channel: protocol.CHANNELS.INTERACTION,
    version: protocol.VERSIONS.INTERACTION,
    requestId: 'request_1',
    method: 'clipboard/writeText',
    params: { text: 'x' },
  };
  const bridgeResult = {
    type: protocol.MESSAGE_TYPES.BRIDGE_RESULT,
    channel: protocol.CHANNELS.INTERACTION,
    version: protocol.VERSIONS.INTERACTION,
    requestId: 'request_1',
    ok: true,
  };
  const threadAttach = {
    type: protocol.MESSAGE_TYPES.THREAD_ATTACH,
    channel: protocol.CHANNELS.THREAD,
    version: protocol.VERSIONS.THREAD,
    requestId: 'request_1',
    text: 'selected code',
  };
  const threadResult = {
    type: protocol.MESSAGE_TYPES.THREAD_ATTACH_RESULT,
    channel: protocol.CHANNELS.THREAD,
    version: protocol.VERSIONS.THREAD,
    requestId: 'request_1',
    ok: false,
    error: 'rejected',
  };

  assert.strictEqual(protocol.isBridgeRequest(bridge), true);
  assert.strictEqual(protocol.isBridgeRequest({ ...bridge, version: 2 }), false);
  assert.strictEqual(protocol.isBridgeResult(bridgeResult), true);
  assert.strictEqual(protocol.isThreadAttach(threadAttach), true);
  assert.strictEqual(protocol.isThreadResult(threadResult), true);
});

test('hello and ready messages use the interaction channel and requested version', () => {
  assert.deepStrictEqual(protocol.helloMessage(1, { clipboard: true }), {
    type: 'dshWebviewHello',
    channel: 'dsh-vscode-interaction',
    version: 1,
    capabilities: { clipboard: true },
  });
  assert.deepStrictEqual(protocol.readyMessage(1, { clipboard: true }), {
    type: 'dshWebviewReady',
    channel: 'dsh-vscode-interaction',
    version: 1,
    capabilities: { clipboard: true },
  });
  assert.strictEqual(protocol.isHello(protocol.helloMessage(1)), true);
  assert.strictEqual(protocol.isReady(protocol.readyMessage(1)), true);
});
