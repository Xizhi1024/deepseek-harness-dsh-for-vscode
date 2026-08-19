'use strict';

const { McpJsonRpcClient, McpRpcError } = require('./jsonRpc');

const MCP_PROTOCOL_VERSION = '2024-11-05';
const CALL_TIMEOUT_MS = 60000;

/**
 * Spawn a stdio MCP server and expose a tiny request API. The child is owned
 * by this client and disposed when the extension deactivates or the manager
 * refreshes (best-effort kill; VS Code window teardown reaps the rest).
 *
 * @param {object} options
 * @param {object} options.server - Expanded stdio server record.
 * @param {Function} options.spawn - child_process.spawn seam.
 * @param {object} [options.env] - Base environment (default process.env).
 * @param {Function} [options.logger]
 * @returns {{start: Function, request: Function, dispose: Function, child: object}}
 */
function createStdioMcpClient({ server, spawn, env = process.env, logger = () => {} } = {}) {
  if (!server || server.type !== 'stdio' || typeof server.command !== 'string') {
    throw new TypeError('createStdioMcpClient requires an expanded stdio server');
  }
  if (typeof spawn !== 'function') {
    throw new TypeError('createStdioMcpClient requires a spawn function');
  }
  const child = spawn(server.command, Array.isArray(server.args) ? server.args : [], {
    cwd: typeof server.cwd === 'string' && server.cwd.length > 0 ? server.cwd : undefined,
    env: { ...(env || {}), ...(server.env || {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const rpc = new McpJsonRpcClient({
    write: (line) => {
      if (child.stdin && !child.stdin.destroyed) child.stdin.write(line + '\n');
    },
    onError: (error) => logger(`[mcp:${server.name}] ${error.message}`),
  });
  if (child.stdout) child.stdout.on('data', (chunk) => rpc.handleData(chunk));
  if (child.stderr) child.stderr.on('data', (chunk) => logger(`[mcp:${server.name}] ${String(chunk)}`));
  child.on('exit', (code, signal) => {
    rpc.close(new McpRpcError('MCP_DISCONNECTED', `MCP stdio server ${server.name} exited (code=${code}, signal=${signal})`));
  });

  let started = false;
  async function start() {
    if (started) return { protocolVersion: MCP_PROTOCOL_VERSION };
    const result = await rpc.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'dsh-vs-sidebar', version: '0.6.0' },
    }, { timeoutMs: 15000 });
    started = true;
    rpc.notify('notifications/initialized');
    return result;
  }

  function request(method, params = {}, options = {}) {
    if (!started) {
      return Promise.reject(new McpRpcError('MCP_NOT_STARTED', 'MCP stdio client is not started'));
    }
    const timeoutMs = method === 'tools/call' ? CALL_TIMEOUT_MS : 15000;
    return rpc.request(method, params, { ...options, timeoutMs });
  }

  function dispose() {
    rpc.close(new McpRpcError('MCP_DISPOSED', 'MCP stdio client disposed'));
    try {
      child.kill();
    } catch {
      // already exited
    }
  }

  return Object.freeze({ child, dispose, request, start });
}

module.exports = {
  MCP_PROTOCOL_VERSION,
  createStdioMcpClient,
};
