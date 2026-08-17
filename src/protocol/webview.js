'use strict';

/**
 * Single source of truth for the VS Code sidebar <-> DSH Webview bridge
 * protocol. Extension-host modules and generated Webview shell scripts should
 * use these constants instead of re-declaring channel/version/type literals.
 */
const CHANNELS = Object.freeze({
  INTERACTION: 'dsh-vscode-interaction',
  THREAD: 'dsh-vscode-thread',
});

const VERSIONS = Object.freeze({
  INTERACTION: 1,
  THREAD: 1,
});

const MESSAGE_TYPES = Object.freeze({
  BRIDGE: 'dshBridge',
  BRIDGE_RESULT: 'dshBridgeResult',
  THREAD_ATTACH: 'dshThreadAttach',
  THREAD_ATTACH_RESULT: 'dshThreadAttachResult',
  HELLO: 'dshWebviewHello',
  READY: 'dshWebviewReady',
});

/**
 * Shared request-id rule for every versioned webview bridge message that
 * carries one. The shell, the extension-host parsers and the DSH client all
 * apply the same bound so malformed ids are dropped before forwarding or
 * before any side effect.
 */
const REQUEST_ID = /^[A-Za-z0-9_-]{1,100}$/;

function hasValidRequestId(message) {
  return Boolean(message) && typeof message.requestId === 'string' && REQUEST_ID.test(message.requestId);
}

function isBridgeRequest(message) {
  return Boolean(
    message
    && typeof message === 'object'
    && message.type === MESSAGE_TYPES.BRIDGE
    && message.channel === CHANNELS.INTERACTION
    && message.version === VERSIONS.INTERACTION
    && hasValidRequestId(message)
    && typeof message.method === 'string'
    && message.method.length > 0
    && message.params
    && typeof message.params === 'object'
  );
}

function isBridgeResult(message) {
  return Boolean(
    message
    && typeof message === 'object'
    && message.type === MESSAGE_TYPES.BRIDGE_RESULT
    && message.channel === CHANNELS.INTERACTION
    && message.version === VERSIONS.INTERACTION
    && hasValidRequestId(message)
    && typeof message.ok === 'boolean'
  );
}

function isThreadAttach(message) {
  return Boolean(
    message
    && typeof message === 'object'
    && message.type === MESSAGE_TYPES.THREAD_ATTACH
    && message.channel === CHANNELS.THREAD
    && message.version === VERSIONS.THREAD
    && hasValidRequestId(message)
    && typeof message.text === 'string'
  );
}

function isThreadResult(message) {
  return Boolean(
    message
    && typeof message === 'object'
    && message.type === MESSAGE_TYPES.THREAD_ATTACH_RESULT
    && message.channel === CHANNELS.THREAD
    && message.version === VERSIONS.THREAD
    && hasValidRequestId(message)
    && typeof message.ok === 'boolean'
  );
}

function isHello(message) {
  return Boolean(
    message
    && typeof message === 'object'
    && message.type === MESSAGE_TYPES.HELLO
    && message.channel === CHANNELS.INTERACTION
  );
}

function isReady(message) {
  return Boolean(
    message
    && typeof message === 'object'
    && message.type === MESSAGE_TYPES.READY
    && message.channel === CHANNELS.INTERACTION
  );
}

function helloMessage(version = VERSIONS.INTERACTION, capabilities = {}) {
  return {
    type: MESSAGE_TYPES.HELLO,
    channel: CHANNELS.INTERACTION,
    version,
    capabilities,
  };
}

function readyMessage(version = VERSIONS.INTERACTION, capabilities = {}) {
  return {
    type: MESSAGE_TYPES.READY,
    channel: CHANNELS.INTERACTION,
    version,
    capabilities,
  };
}

module.exports = {
  CHANNELS,
  MESSAGE_TYPES,
  REQUEST_ID,
  VERSIONS,
  hasValidRequestId,
  helloMessage,
  isBridgeRequest,
  isBridgeResult,
  isHello,
  isReady,
  isThreadAttach,
  isThreadResult,
  readyMessage,
};
