'use strict';

// Shared, dependency-free evaluator for the deliberately small schema vocabulary
// used by this package. Unknown schema keywords must be added here before use.
const runtime = require('./runtime-v1.json');
const bridge = require('./session-bridge-v1.json');
const schemas = { 'runtime-v1.json': runtime, 'session-bridge-v1.json': bridge };
const SESSION_CHANNEL = 'dsh-vscode-session';
const SESSION_VERSION = 1;
const LIMITS = Object.freeze({
  capabilityTimeoutMs: 5000, rpcTimeoutMs: 30000, startupTimeoutMs: 30000,
  cooldownMs: 30000, bodyBytes: 1048576, responseBytes: 4194304,
  frameBytes: 1048576, maxMessages: 200, feedFrames: 256, feedBytes: 4194304,
  heartbeatMs: 8000, stallMs: 30000, maxFeeds: 32, projectionBytes: 4194304,
  ticketTtlMs: 30000, maxTickets: 32, receiptTtlMs: 120000, maxReceipts: 256,
  handshakeTimeoutMs: 5000, handshakeRetryMs: 250,
  reconnectDelaysMs: Object.freeze([1000, 2000, 4000, 8000, 16000, 30000]),
  reconnectResetMs: 60000,
});
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

// Exact runtimeVersion -> adapterId pairs. The JSON schemas bound each field
// to its enum; this map enforces the pairing the enums alone cannot express.
// Must cover every adapterId in both schema enums and never contain a range.
const ADAPTER_BY_RUNTIME = Object.freeze({
  '0.2.0-rc.1': 'dsh-0.2.0-rc.1',
  '0.2.0-rc.2': 'dsh-0.2.0-rc.2',
  '0.1.2-rc.1': 'legacy-0.1.2-rc.1',
});

function matches(value, rule, document = runtime, budget = { nodes: 0 }, depth = 0) {
  if (++budget.nodes > 200000 || depth > 40 || !rule) return false;
  if (rule.$ref) {
    const [file, pointer] = rule.$ref.split('#');
    const source = file ? schemas[file] : document;
    if (!source || !pointer || !pointer.startsWith('/$defs/')) return false;
    return matches(value, source.$defs[pointer.slice(7)], source, budget, depth + 1);
  }
  if (rule.oneOf) return rule.oneOf.filter((choice) => matches(value, choice, document, budget, depth + 1)).length === 1;
  if (rule.anyOf) return rule.anyOf.some((choice) => matches(value, choice, document, budget, depth + 1));
  if (own(rule, 'const') && value !== rule.const) return false;
  if (rule.enum && !rule.enum.includes(value)) return false;
  if (rule.type === 'null') return value === null;
  if (rule.type === 'boolean') return typeof value === 'boolean';
  if (rule.type === 'integer') return Number.isSafeInteger(value) && value >= rule.minimum && value <= rule.maximum;
  if (rule.type === 'string') {
    if (typeof value !== 'string') return false;
    if (rule.minLength !== undefined && value.length < rule.minLength) return false;
    if (rule.maxLength !== undefined && value.length > rule.maxLength) return false;
    if (rule.pattern && !new RegExp(rule.pattern).test(value)) return false;
    if (rule.format === 'date-time' && (!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) || !Number.isFinite(Date.parse(value)))) return false;
    return true;
  }
  if (rule.type === 'array') {
    if (!Array.isArray(value) || value.length > rule.maxItems || value.length < (rule.minItems || 0)) return false;
    return value.every((item) => matches(item, rule.items, document, budget, depth + 1));
  }
  if (rule.type === 'object') {
    if (!record(value)) return false;
    const props = rule.properties || {};
    if ((rule.required || []).some((key) => !own(value, key))) return false;
    return Object.keys(value).every((key) => own(props, key)
      ? matches(value[key], props[key], document, budget, depth + 1)
      : rule.additionalProperties !== false);
  }
  return own(rule, 'const') || !!rule.enum;
}

function validatePortError(value) { return matches(value, runtime.$defs.PortError); }
function createPortError(code, message, { retryable = false, effect = 'none' } = {}) {
  const fields = { code, message, retryable, effect };
  if (!validatePortError(fields)) throw new TypeError('Invalid port error fields');
  return Object.assign(new Error(message), fields);
}
function validateRpcRequest(value) { return matches(value, runtime.$defs.RpcRequest); }
function validateRpcResponse(value, { method, requestId } = {}) {
  if (!record(value) || (requestId !== undefined && value.requestId !== requestId)) return false;
  if (value.ok === false) return matches(value, runtime.$defs.RpcError);
  if (!own(runtime.methods, method)) return false;
  return matches(value, {
    type: 'object', required: ['protocolVersion', 'requestId', 'ok', 'value'], additionalProperties: false,
    properties: { protocolVersion: { const: 1 }, requestId: { type: 'string', pattern: '^[A-Za-z0-9._:-]{1,100}$' },
      ok: { const: true }, value: runtime.methods[method].value },
  });
}
function validateCapabilityReport(value) {
  return matches(value, runtime.$defs.CapabilityReport) && ADAPTER_BY_RUNTIME[value.runtimeVersion] === value.adapterId;
}
function validateSessionUpdate(value) {
  if (!matches(value, runtime.$defs.SessionUpdate)) return false;
  return value.kind !== 'edit-observation' || (value.observation.runtimeInstanceId === value.runtimeInstanceId
    && value.observation.sessionId === value.sessionId);
}
function validateVisibleTarget(value) { return matches(value, bridge.$defs.VisibleTarget, bridge); }
function validateInsertionTicket(value) { return matches(value, bridge.$defs.InsertionTicket, bridge); }
function sameSurface(a, b) { return a.surfaceId === b.surfaceId && a.surfaceEpoch === b.surfaceEpoch; }
function validateSessionMessage(value, { direction, method, requestId } = {}) {
  if (!record(value)) return false;
  if (requestId !== undefined && value.requestId !== requestId) return false;
  if (direction === 'toBrowser' && !['hello-init', 'request'].includes(value.type)) return false;
  if (direction === 'toHost' && !['hello-ack', 'result', 'targetChanged'].includes(value.type)) return false;
  const def = { 'hello-init': 'HelloInit', 'hello-ack': 'HelloAck', request: 'Request', targetChanged: 'TargetChanged' }[value.type];
  if (def) {
    if (!matches(value, bridge.$defs[def], bridge)) return false;
    if (value.type === 'hello-ack' && ADAPTER_BY_RUNTIME[value.runtimeVersion] !== value.adapterId) return false;
    if (value.type === 'targetChanged') return sameSurface(value, value.target);
    if (value.type === 'request' && value.method === 'insertion.capture') return sameSurface(value, value.params.expected);
    return true;
  }
  if (value.type !== 'result') return false;
  if (value.ok === false) return matches(value, bridge.$defs.ResultError, bridge);
  if (!own(bridge.methods, method)) return false;
  const props = { ...bridge.envelope, type: { const: 'result' },
    requestId: { type: 'string', pattern: '^[A-Za-z0-9._:-]{1,100}$' }, ok: { const: true }, value: bridge.methods[method].value };
  if (!matches(value, { type: 'object', properties: props, required: Object.keys(props), additionalProperties: false }, bridge)) return false;
  return !['target.get', 'session.navigate', 'insertion.capture'].includes(method) || sameSurface(value, value.value);
}
function assertSessionMessage(value, options) {
  if (!validateSessionMessage(value, options)) throw createPortError('PROTOCOL_MISMATCH', 'Invalid session bridge message');
  return value;
}

module.exports = Object.freeze({ SESSION_CHANNEL, SESSION_VERSION, LIMITS,
  validatePortError, createPortError, validateRpcRequest, validateRpcResponse,
  validateCapabilityReport, validateSessionUpdate, validateVisibleTarget,
  validateInsertionTicket, validateSessionMessage,
  validateSessionBridgeMessage: validateSessionMessage, assertSessionMessage,
});
