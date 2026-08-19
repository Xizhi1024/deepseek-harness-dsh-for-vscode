'use strict';

const { McpRpcError } = require('./jsonRpc');

const MCP_PROTOCOL_VERSION = '2024-11-05';
const CALL_TIMEOUT_MS = 60000;
const INIT_TIMEOUT_MS = 15000;

function parseSsePayload(body) {
  const messages = [];
  let buffer = body || '';
  let newline = buffer.indexOf('\n');
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.startsWith('data:')) {
      const payload = line.slice('data:'.length).trim();
      if (payload.length > 0 && payload !== '[DONE]') {
        try {
          messages.push(JSON.parse(payload));
        } catch {
          // ignore non-JSON SSE lines
        }
      }
    }
    newline = buffer.indexOf('\n');
  }
  return messages;
}

/**
 * Minimal streamable-HTTP/SSE MCP client. Sends one JSON-RPC POST per request
 * and accepts either a JSON response body or an SSE stream containing the
 * JSON-RPC response. Session headers are preserved from the server response.
 *
 * @param {object} options
 * @param {object} options.server - Expanded http/sse server record.
 * @param {Function} [options.fetchImpl] - fetch seam.
 * @returns {{start: Function, request: Function, dispose: Function}}
 */
function createHttpMcpClient({ server, fetchImpl = null } = {}) {
  if (!server || (server.type !== 'http' && server.type !== 'sse') || typeof server.url !== 'string') {
    throw new TypeError('createHttpMcpClient requires an expanded http/sse server');
  }
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : fetch;
  let sessionHeader = null;
  let nextId = 1;

  function buildHeaders(method) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(server.headers || {}),
    };
    if (sessionHeader) headers['Mcp-Session-Id'] = sessionHeader;
    return headers;
  }

  async function request(method, params = {}, { signal = null, timeoutMs = method === 'tools/call' ? CALL_TIMEOUT_MS : INIT_TIMEOUT_MS } = {}) {
    const id = nextId;
    nextId += 1;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal && typeof signal.addEventListener === 'function') {
      if (signal.aborted) {
        throw new McpRpcError('MCP_ABORTED', `MCP request cancelled: ${method}`);
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    try {
      const response = await fetchFn(server.url, {
        method: 'POST',
        headers: buildHeaders(method),
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new McpRpcError('MCP_HTTP_ERROR', `MCP HTTP request failed with status ${response.status}`);
      }
      const session = response.headers && (response.headers.get ? response.headers.get('mcp-session-id') : response.headers['Mcp-Session-Id']);
      if (typeof session === 'string' && session.length > 0) sessionHeader = session;
      const contentType = response.headers && (response.headers.get ? response.headers.get('content-type') : response.headers['content-type']);
      if (typeof contentType === 'string' && contentType.includes('text/event-stream')) {
        const body = await response.text();
        const messages = parseSsePayload(body);
        const message = messages.find((candidate) => candidate && candidate.id === id);
        if (!message) throw new McpRpcError('MCP_PROTOCOL_ERROR', 'MCP SSE stream did not contain the request response');
        if (message.error) throw new McpRpcError(message.error.code || 'MCP_ERROR', message.error.message || 'MCP error');
        return message.result;
      }
      const payload = await response.json();
      if (payload && payload.error) {
        throw new McpRpcError(payload.error.code || 'MCP_ERROR', payload.error.message || 'MCP error');
      }
      return payload && payload.result;
    } finally {
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
    }
  }

  function start() {
    return request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'dsh-vs-sidebar', version: '0.6.0' },
    }, { timeoutMs: INIT_TIMEOUT_MS });
  }

  function dispose() {
    sessionHeader = null;
  }

  return Object.freeze({ dispose, request, start });
}

module.exports = {
  MCP_PROTOCOL_VERSION,
  createHttpMcpClient,
  parseSsePayload,
};
