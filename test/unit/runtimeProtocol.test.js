'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const contract = require('../../src/protocol/runtime');
const bridgeFixtures = require('../fixtures/session-bridge-v1.json');

test('session wire fixtures exercise the deployed canonical schemas', () => {
  for (const fixture of bridgeFixtures) {
    assert.equal(contract.validateSessionMessage(fixture.message, fixture.options), fixture.valid, fixture.name);
  }
});

test('RPC allow-list preserves steer and parts, rejects extra input and wrong replies', () => {
  const input = { protocolVersion: 1, requestId: 'r-1', method: 'session.prompt', params: {
    sessionId: 's-1', content: [{ kind: 'text', text: 'hello' }], mode: 'steer', clientRequestId: 'prompt-1',
  } };
  assert.equal(contract.validateRpcRequest(input), true);
  assert.equal(contract.validateRpcRequest({ ...input, params: { ...input.params, execute: 'anything' } }), false);
  assert.equal(contract.validateRpcRequest({ ...input, method: '__proto__' }), false);
  const response = { protocolVersion: 1, requestId: 'r-1', ok: true, value: { admission: 'accepted', clientRequestId: 'prompt-1' } };
  assert.equal(contract.validateRpcResponse(response, { method: 'session.prompt', requestId: 'r-1' }), true);
  assert.equal(contract.validateRpcResponse(response, { method: 'session.rename', requestId: 'r-1' }), false);
  assert.equal(contract.validateRpcResponse(response, { method: 'session.prompt', requestId: 'r-2' }), false);
  assert.equal(contract.validateRpcResponse(response), false);
});

test('normalized evidence cannot claim another session or runtime', () => {
  const event = { runtimeInstanceId: 'i-1', sessionId: 's-1', streamEpoch: 'e-1', deliverySeq: 2,
    kind: 'edit-observation', observation: { observationId: 'o-1', runtimeInstanceId: 'i-1', sessionId: 's-1',
      path: '/work/test.txt', tool: 'edit', phase: 'confirmed', origin: 'session-event', toolCallId: 'tool-1', sourceDurableSeq: '9', beforeText: null } };
  assert.equal(contract.validateSessionUpdate(event), true);
  assert.equal(contract.validateSessionUpdate({ ...event, sessionId: 's-2' }), false);
  assert.equal(contract.validateSessionUpdate({ ...event, deliverySeq: NaN }), false);
});

test('error effects remain explicit and unsupported versions fail closed', () => {
  const error = contract.createPortError('OUTCOME_UNKNOWN', 'Remote result unknown', { effect: 'unknown' });
  assert.equal(error.effect, 'unknown');
  assert.equal(error instanceof Error, true);
  assert.throws(() => contract.createPortError('NOT_A_CODE', 'bad'), TypeError);
  const fixture = bridgeFixtures[0].message;
  assert.equal(contract.validateSessionMessage({ ...fixture, version: 2 }), false);
  assert.equal(contract.validateSessionMessage(fixture, { direction: 'toHost' }), false);
});
