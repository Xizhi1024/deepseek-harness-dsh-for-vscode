// ---------------------------------------------------------------------------
// DSH side of the versioned VS Code bridge (S3).
//
// This module connects to the extension host over a loopback TCP socket,
// negotiates protocolVersion 3, and registers one DSH tool per advertised
// bridge method (`vscode/terminal/create` -> `vscode_terminal_create`).
//
// Safety properties:
//  - Missing bridge env (no port/token) => start() reports { running:false }
//    and never registers a tool or throws.
//  - Only the methods advertised by `initialize.result.methods` are trusted.
//  - Reconnect backoff re-runs initialize and swaps the tool generation in two
//    phases (fetch methods first; then dispose old tools and register new).
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 15_000;
const LONG_TIMEOUT_MS = 120_000;
const LONG_TIMEOUT_METHODS = new Set([
  'vscode/confirm/ask',
  'vscode/changes/push',
  'vscode/mcp/callTool',
  'vscode/extensions/callExport',
]);
const DEFAULT_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000];
const MAX_FRAME_BYTES = 2 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Pure helpers (directly exercisable with node:test).
// ---------------------------------------------------------------------------

function bridgeTimeoutMs(method) {
  return LONG_TIMEOUT_METHODS.has(method) ? LONG_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

function sanitizeToolSegment(segment) {
  let out = '';
  for (let i = 0; i < segment.length; i += 1) {
    const code = segment.charCodeAt(i);
    const isDigit = code >= 48 && code <= 57;
    const isUpper = code >= 65 && code <= 90;
    const isLower = code >= 97 && code <= 122;
    const isUnderscore = code === 95;
    if (isUpper) {
      const previous = i > 0 ? segment.charCodeAt(i - 1) : 0;
      const previousIsLower = previous >= 97 && previous <= 122;
      const previousIsDigit = previous >= 48 && previous <= 57;
      if ((previousIsLower || previousIsDigit) && out.length > 0 && out[out.length - 1] !== '_') {
        out += '_';
      }
      out += segment[i].toLowerCase();
    } else if (isDigit || isLower || isUnderscore) {
      out += segment[i];
    } else {
      out += '_';
    }
  }
  return out;
}

function toolNameFor(method) {
  const prefix = 'vscode/';
  const segment = method.startsWith(prefix) ? method.slice(prefix.length) : method;
  return 'vscode_' + sanitizeToolSegment(segment);
}

function bridgeEnv(env = process.env) {
  const source = env || {};
  const host = typeof source.DSH_VSCODE_BRIDGE_HOST === 'string' && source.DSH_VSCODE_BRIDGE_HOST.length > 0
    ? source.DSH_VSCODE_BRIDGE_HOST
    : '127.0.0.1';
  const rawPort = source.DSH_VSCODE_BRIDGE_PORT;
  const token = source.DSH_VSCODE_BRIDGE_TOKEN;
  const protocol = typeof source.DSH_VSCODE_BRIDGE_PROTOCOL === 'string' && source.DSH_VSCODE_BRIDGE_PROTOCOL.length > 0
    ? source.DSH_VSCODE_BRIDGE_PROTOCOL
    : '3';
  if (typeof rawPort !== 'string' || rawPort.length === 0 || typeof token !== 'string' || token.length === 0) {
    return { ok: false, reason: 'env-missing' };
  }
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ok: false, reason: 'env-missing' };
  }
  if (host !== '127.0.0.1' && host !== 'localhost') {
    return { ok: false, reason: 'env-invalid-host' };
  }
  return { ok: true, host, port, token, protocol };
}

function jsonRpcError(bridgeCode, message) {
  const error = new Error(message);
  error.code = bridgeCode;
  return error;
}

// ---------------------------------------------------------------------------
// Method -> tool schema table. This mirrors METHODS_V3 (32 entries: 6
// inherited v1/v2 methods + 26 v3 additions incl. E-batch callExport).
// ---------------------------------------------------------------------------

function objectSchema(properties = {}, required = []) {
  const schema = { type: 'object', properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

const stringProp = (description) => ({ type: 'string', description });
const boolProp = (description) => ({ type: 'boolean', description });
const intProp = (description) => ({ type: 'integer', description });
// No `format: "uri"`: the ToolRuntime JSON-Schema subset has no format
// keyword and register()/dispatch would reject the descriptor.
const uriProp = (description) => ({ type: 'string', description });

function positionSchema() {
  return objectSchema({
    line: intProp('Zero-based line number'),
    character: intProp('Zero-based character offset'),
  }, ['line', 'character']);
}

function rangeSchema() {
  return objectSchema({
    start: positionSchema(),
    end: positionSchema(),
  }, ['start', 'end']);
}

function editSchema() {
  return objectSchema({
    kind: { type: 'string', enum: ['insert', 'replace', 'delete', 'create'] },
    uri: uriProp('File URI inside the workspace'),
    at: positionSchema(),
    range: rangeSchema(),
    text: stringProp('Text payload (max 1 MiB per edit)'),
  }, ['kind', 'uri']);
}

const METHOD_SCHEMAS = {
  'vscode/editor/getContext': {
    description: 'Get the active editor and open-document metadata (never document text).',
    parameters: objectSchema(),
  },
  'vscode/editor/open': {
    description: 'Open a workspace document in the VS Code editor.',
    parameters: objectSchema({
      document: objectSchema({ uri: uriProp('Document URI') }, ['uri']),
      range: rangeSchema(),
      preserveFocus: boolProp('Keep focus in the current editor'),
    }, ['document']),
  },
  'vscode/editor/openDiff': {
    description: 'Open a diff view between two workspace documents.',
    parameters: objectSchema({
      left: objectSchema({ uri: uriProp('Left document URI') }, ['uri']),
      right: objectSchema({ uri: uriProp('Right document URI') }, ['uri']),
      title: stringProp('Diff view title'),
      preserveFocus: boolProp('Keep focus in the current editor'),
    }, ['left', 'right']),
  },
  'vscode/workspace/getDiagnostics': {
    description: 'Read VS Code diagnostics for workspace documents.',
    parameters: objectSchema({
      uris: { type: 'array', items: { type: 'string' }, description: 'Optional document URIs; empty = all documents' },
    }),
  },
  'vscode/extensions/getProviderStates': {
    description: 'Get the installed VS Code extension provider states.',
    parameters: objectSchema(),
  },
  'vscode/extensions/openDetails': {
    description: 'Open the VS Code extension details page for a provider id.',
    parameters: objectSchema({ providerId: stringProp('Extension provider id') }, ['providerId']),
  },
  'vscode/terminal/create': {
    description: 'Create a VS Code terminal (consent-gated in the extension).',
    parameters: objectSchema({
      name: stringProp('Terminal name'),
      cwd: stringProp('Working directory'),
    }),
  },
  'vscode/terminal/sendText': {
    description: 'Send text to a bridge-owned VS Code terminal.',
    parameters: objectSchema({
      terminalId: stringProp('Terminal id returned by vscode_terminal_create'),
      text: stringProp('Text to send'),
      addNewline: boolProp('Append a newline (default true)'),
    }, ['terminalId', 'text']),
  },
  'vscode/terminal/read': {
    description: 'Read buffered output from a bridge-owned VS Code terminal.',
    parameters: objectSchema({
      terminalId: stringProp('Terminal id returned by vscode_terminal_create'),
      maxBytes: intProp('Maximum bytes to read (default 8192)'),
    }, ['terminalId']),
  },
  'vscode/tasks/list': {
    description: 'List workspace-declared VS Code tasks.',
    parameters: objectSchema(),
  },
  'vscode/tasks/run': {
    description: 'Run a workspace-declared VS Code task by name.',
    parameters: objectSchema({ name: stringProp('Task name from tasks.json') }, ['name']),
  },
  'vscode/debug/start': {
    description: 'Start a launch.json debug configuration by name.',
    parameters: objectSchema({ name: stringProp('launch.json configuration name') }, ['name']),
  },
  'vscode/debug/stop': {
    description: 'Stop the active VS Code debug session.',
    parameters: objectSchema(),
  },
  'vscode/debug/getStack': {
    description: 'Read the active VS Code debug call stack.',
    parameters: objectSchema(),
  },
  'vscode/workspace/findFiles': {
    description: 'Find files in the workspace by glob pattern.',
    parameters: objectSchema({
      include: stringProp('Include glob pattern'),
      exclude: stringProp('Exclude glob pattern'),
      maxResults: intProp('Maximum results (capped at 500)'),
    }, ['include']),
  },
  'vscode/window/showMessage': {
    description: 'Show a VS Code window message (consent-gated in the extension).',
    parameters: objectSchema({
      message: stringProp('Message text'),
      level: { type: 'string', enum: ['info', 'warning', 'error'] },
    }, ['message']),
  },
  'vscode/extensions/list': {
    description: 'List installed VS Code extensions with activation state.',
    parameters: objectSchema(),
  },
  'vscode/extensions/callExport': {
    description: 'Call an exported method of a VS Code extension (consent-gated; may activate the extension as a side effect).',
    parameters: objectSchema({
      extensionId: stringProp('Extension id in publisher.name form'),
      method: stringProp('Export method name to call (max 128 characters)'),
      args: { type: 'object', description: 'Arguments for the export call (object; use an array for positional arguments)' },
    }, ['extensionId', 'method']),
  },
  'vscode/git/getStatus': {
    description: 'Read the working-tree status of the first Git repository.',
    parameters: objectSchema(),
  },
  'vscode/git/getDiff': {
    description: 'Read the diff with HEAD of the first Git repository.',
    parameters: objectSchema({ uri: uriProp('Optional file URI to diff') }),
  },
  'vscode/editor/getState': {
    description: 'Get the active editor state (metadata only, never document text).',
    parameters: objectSchema(),
  },
  'vscode/editor/read': {
    description: 'Read the active or specified document text (consent-gated in the extension).',
    parameters: objectSchema({ uri: uriProp('Optional document URI; empty = active editor') }),
  },
  'vscode/progress/start': {
    description: 'Start a VS Code progress notification (consent-gated in the extension).',
    parameters: objectSchema({ title: stringProp('Progress title') }, ['title']),
  },
  'vscode/progress/report': {
    description: 'Report progress on a VS Code progress notification.',
    parameters: objectSchema({
      progressId: stringProp('Progress id returned by vscode_progress_start'),
      message: stringProp('Progress message'),
      increment: { type: 'number', description: 'Progress increment' },
    }, ['progressId']),
  },
  'vscode/progress/end': {
    description: 'End a VS Code progress notification.',
    parameters: objectSchema({ progressId: stringProp('Progress id') }, ['progressId']),
  },
  'vscode/statusbar/update': {
    description: 'Update the bridge status bar item (consent-gated in the extension).',
    parameters: objectSchema({
      text: stringProp('Status text'),
      tooltip: stringProp('Status tooltip'),
    }),
  },
  'vscode/output/append': {
    description: 'Append a line to the DSH output channel (consent-gated in the extension).',
    parameters: objectSchema({ line: stringProp('Line to append') }),
  },
  'vscode/confirm/ask': {
    description: 'Ask the user a question through VS Code (fail-closed after 120s).',
    parameters: objectSchema({
      kind: { type: 'string', enum: ['pick', 'input', 'warning'] },
      prompt: stringProp('Question or prompt'),
      items: { type: 'array', items: { type: 'string' }, description: 'Choices for pick prompts' },
    }, ['prompt']),
  },
  'vscode/changes/push': {
    description: 'Apply workspace edits through the VS Code editor. Permission is governed by the DSH sandbox that owns this session - VS Code adds no approval gate. Every batch lands in the changes tree with a before-snapshot and file-level undo (the review surface).',
    parameters: objectSchema({
      sessionId: stringProp('DSH session id for journal isolation'),
      label: stringProp('Change label shown in the tree view (max 200 chars)'),
      mode: { type: 'string', enum: ['ask', 'session'], description: 'Legacy field from the approval era; accepted, ignored' },
      edits: { type: 'array', items: editSchema(), description: 'Workspace edits (max 50)' },
    }, ['edits']),
  },
  'vscode/mcp/listServers': {
    description: 'List the VS Code MCP servers configured for the extension.',
    parameters: objectSchema(),
  },
  'vscode/mcp/listTools': {
    description: 'List the tools of one VS Code MCP server.',
    parameters: objectSchema({ server: stringProp('MCP server name') }, ['server']),
  },
  'vscode/mcp/callTool': {
    description: 'Call a tool on one VS Code MCP server.',
    parameters: objectSchema({
      server: stringProp('MCP server name'),
      tool: stringProp('Tool name'),
      arguments: { type: 'object', description: 'Tool arguments' },
    }, ['server', 'tool']),
  },
};

function descriptorFor(method) {
  const entry = METHOD_SCHEMAS[method];
  if (!entry) return null;
  return {
    name: toolNameFor(method),
    description: entry.description,
    parameters: entry.parameters,
    // ToolRuntime.register() contract: render must return an array of content
    // blocks (e.g. [{ type: 'text', text }]). Returning a bare string makes
    // result.content a non-array and dsh-tools' commit() crashes the whole
    // daemon with `result.content.some is not a function`.
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
  };
}

// ---------------------------------------------------------------------------
// Bridge connection generation.
// ---------------------------------------------------------------------------

class BridgeGeneration {
  constructor({ socket, timeoutMs }) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.disposed = false;
  }

  write(message) {
    if (this.disposed || this.socket.destroyed) {
      throw jsonRpcError('VSCODE_DISCONNECTED', 'The VS Code bridge is disconnected');
    }
    this.socket.write(JSON.stringify(message) + '\n');
  }

  request(method, params, { signal = null, timeoutMs = this.timeoutMs } = {}) {
    if (this.disposed || this.socket.destroyed) {
      return Promise.reject(jsonRpcError('VSCODE_DISCONNECTED', 'The VS Code bridge is disconnected'));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(jsonRpcError('VSCODE_TIMEOUT', `VS Code bridge request timed out: ${method}`));
      }, timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();

      const onAbort = () => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          clearTimeout(timer);
          try {
            this.socket.write(JSON.stringify({
              jsonrpc: '2.0',
              method: '$/cancelRequest',
              params: { id },
            }) + '\n');
          } catch {
            // best-effort cancellation
          }
          reject(jsonRpcError('VSCODE_ABORTED', `VS Code bridge request cancelled: ${method}`));
        }
      };
      if (signal && typeof signal.addEventListener === 'function') {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.pending.set(id, { resolve, reject, timer, signal, onAbort, method });
      try {
        this.write({
          jsonrpc: '2.0',
          id,
          method,
          params: params === undefined ? {} : params,
        });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    });
  }

  handleData(chunk) {
    this.buffer += String(chunk);
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) this.handleLine(line);
      newline = this.buffer.indexOf('\n');
    }
    if (this.buffer.length > MAX_FRAME_BYTES) {
      this.fail(jsonRpcError('VSCODE_FRAME_TOO_LARGE', 'VS Code bridge frame exceeds the 2 MiB limit'));
    }
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return; // ignore noise before/after JSON-RPC frames
    }
    if (!message || message.jsonrpc !== '2.0') return;
    if (message.id === undefined || message.id === null) return; // notifications not needed by the client
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (waiter.signal && typeof waiter.signal.removeEventListener === 'function') {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    if (message.error) {
      const detail = message.error;
      // Server error frames carry the bridge code in error.data.code; the
      // top-level error.code is the numeric JSON-RPC code (-32xxx).
      const bridgeCode = detail.data && typeof detail.data.code === 'string' && detail.data.code.length > 0
        ? detail.data.code
        : (detail.code || 'VSCODE_BRIDGE_ERROR');
      waiter.reject(jsonRpcError(bridgeCode, detail.message || 'VS Code bridge error'));
    } else {
      waiter.resolve(message.result);
    }
  }

  fail(error) {
    if (this.disposed) return;
    this.disposed = true;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      if (waiter.signal && typeof waiter.signal.removeEventListener === 'function') {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      waiter.reject(error);
    }
    this.pending.clear();
    try {
      this.socket.destroy();
    } catch {
      // already gone
    }
  }

  dispose() {
    if (this.disposed) return;
    this.fail(jsonRpcError('VSCODE_DISCONNECTED', 'The VS Code bridge generation was disposed'));
  }
}

// ---------------------------------------------------------------------------
// createBridgeTools
// ---------------------------------------------------------------------------

/**
 * @param {object} deps
 * @param {object} deps.env - env source (default process.env).
 * @param {object} deps.ctx - DSH plugin context ({ tools, effect }).
 * @param {Function} [deps.defineTool] - tool descriptor factory.
 * @param {object} deps.net - node:net module (or a test seam with connect()).
 * @param {string} [deps.version] - clientInfo version sent to the extension.
 * @param {number[]} [deps.backoffMs] - reconnect backoff schedule.
 * @param {Function} [deps.log] - optional logger.
 */
function createBridgeTools({
  env = process.env,
  ctx = null,
  defineTool = null,
  net = null,
  version = '0.6.0',
  backoffMs = DEFAULT_BACKOFF_MS,
  log = () => {},
} = {}) {
  if (!ctx) throw new TypeError('createBridgeTools requires a DSH ctx');
  if (!net) throw new TypeError('createBridgeTools requires the node:net module');
  const register = ctx.tools && typeof ctx.tools.register === 'function' ? ctx.tools.register.bind(ctx.tools) : null;
  if (!register) throw new TypeError('createBridgeTools requires ctx.tools.register');
  // Only an explicitly injected defineTool may wrap the descriptors. The
  // runtime ctx.tools.defineTool (where present) is a SPEC-shaped SDK
  // helper whose parameter grammar differs from the JSON-Schema roots
  // built here; silently preferring it would mis-compile every tool.
  const define = typeof defineTool === 'function' ? defineTool : (descriptor) => descriptor;

  function start() {
    const envState = bridgeEnv(env);
    if (!envState.ok) {
      return { running: false, reason: envState.reason };
    }

    let stopped = false;
    let generation = null;
    let currentTools = [];
    let reconnectTimer = null;
    let backoffIndex = 0;
    let disposed = false;

    function clearReconnect() {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    }

    function scheduleReconnect() {
      if (stopped || disposed) return;
      const delay = backoffMs[Math.min(backoffIndex, backoffMs.length - 1)];
      backoffIndex += 1;
      clearReconnect();
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connectAndRegister();
      }, delay);
      if (reconnectTimer && typeof reconnectTimer.unref === 'function') reconnectTimer.unref();
    }

    function swapTools(previous, methods) {
      const descriptors = [];
      for (const method of methods) {
        const descriptor = descriptorFor(method);
        if (descriptor) {
          descriptors.push({ method, descriptor });
        } else {
          log(`[dsh-vscode-integration] skipping unadvertised/unknown bridge method: ${method}`);
        }
      }
      // Phase 1: dispose the previous tool generation.
      if (previous && Array.isArray(previous.tools)) {
        for (const record of previous.tools) {
          try {
            if (typeof record.dispose === 'function') record.dispose();
          } catch (error) {
            log(`[dsh-vscode-integration] tool dispose failed: ${error && error.message ? error.message : error}`);
          }
        }
      }
      // Phase 2: register the new generation.
      const tools = [];
      for (const entry of descriptors) {
        const descriptor = entry.descriptor;
        const execute = (params, options) => generation.request(entry.method, params, {
          signal: options && options.signal,
          timeoutMs: bridgeTimeoutMs(entry.method),
        });
        const tool = define({ ...descriptor, execute });
        const disposer = register(tool);
        tools.push({ name: descriptor.name, dispose: typeof disposer === 'function' ? disposer : null });
      }
      return tools;
    }

    function attachSocket(socket) {
      const gen = new BridgeGeneration({ socket, timeoutMs: DEFAULT_TIMEOUT_MS });
      generation = gen;
      gen.socket.on('data', (chunk) => gen.handleData(chunk));
      gen.socket.on('error', (error) => {
        log(`[dsh-vscode-integration] bridge socket error: ${error && error.message ? error.message : error}`);
      });
      gen.socket.on('close', () => {
        if (generation !== gen) return;
        // Keep the generation (and its still-registered tools) as the previous
        // generation for the two-phase swap on the next successful connect.
        gen.fail(jsonRpcError('VSCODE_DISCONNECTED', 'The VS Code bridge disconnected'));
        if (!stopped && !disposed) scheduleReconnect();
      });
      return gen;
    }

    async function connectAndRegister() {
      if (stopped || disposed) return;
      const previous = generation;
      const socket = net.connect(envState.port, envState.host);
      const gen = attachSocket(socket);
      const initId = gen.nextId;
      gen.nextId += 1;

      const initPromise = new Promise((resolve, reject) => {
        const waiter = { resolve, reject };
        gen.pending.set(initId, {
          ...waiter,
          timer: setTimeout(() => {
            gen.pending.delete(initId);
            reject(jsonRpcError('VSCODE_INIT_TIMEOUT', 'VS Code bridge initialize timed out'));
          }, DEFAULT_TIMEOUT_MS),
          signal: null,
          onAbort: null,
          method: 'initialize',
        });
      });

      try {
        gen.write({
          jsonrpc: '2.0',
          id: initId,
          method: 'initialize',
          params: {
            token: envState.token,
            protocolVersion: Number(envState.protocol),
            clientInfo: { name: 'dsh-vscode-integration', version },
          },
        });
        const result = await initPromise;
        const methods = result && Array.isArray(result.methods) ? result.methods : null;
        if (!methods) {
          gen.dispose();
          if (generation === gen) generation = previous;
          log('[dsh-vscode-integration] initialize returned no methods; keeping the previous tools');
          scheduleReconnect();
          return;
        }
        if (generation !== gen || gen.disposed) {
          log('[dsh-vscode-integration] bridge generation was replaced before registration; keeping the previous tools');
          gen.dispose();
          if (generation === gen) generation = previous;
          return;
        }
        const tools = swapTools(previous, methods);
        if (generation === gen) {
          gen.tools = tools;
          currentTools = tools;
        }
        backoffIndex = 0;
        log(`[dsh-vscode-integration] bridge tools registered: ${tools.length}`);
      } catch (error) {
        if (generation === gen) generation = previous;
        gen.dispose();
        log(`[dsh-vscode-integration] bridge initialize failed: ${error && error.message ? error.message : error}`);
        scheduleReconnect();
      }
    }

    void connectAndRegister();

    return {
      running: true,
      stop() {
        if (disposed) return { stopped: true };
        disposed = true;
        stopped = true;
        clearReconnect();
        for (const record of currentTools) {
          try {
            if (typeof record.dispose === 'function') record.dispose();
          } catch {
            // best-effort cleanup
          }
        }
        currentTools = [];
        if (generation) {
          generation.dispose();
          generation = null;
        }
        return { stopped: true };
      },
    };
  }

  return { start, bridgeEnv, toolNameFor, bridgeTimeoutMs };
}

export {
  bridgeEnv,
  bridgeTimeoutMs,
  createBridgeTools,
  descriptorFor,
  jsonRpcError,
  sanitizeToolSegment,
  toolNameFor,
  METHOD_SCHEMAS,
};
