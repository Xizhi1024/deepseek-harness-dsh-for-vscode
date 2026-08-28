"use strict";

const { deepStrictEqual } = require('node:assert');
const { createChangeTracker, validateWireEdits, MAX_LABEL_CHARS } = require('../changeTracker');

/**
 * v3a runtime bridge handlers (plan R6, D3 verdict).
 *
 * Every handler is a function (params, { signal }) -> result and throws errors
 * carrying a bridgeCode. Consent-gated surfaces (terminal, editor read, and
 * the user-visible UI surfaces) are only mounted when their dsh.bridge.*
 * setting is enabled; unmounted methods never reach the initialize
 * advertisement, so DSH registers no tool for them.
 *
 * L2 surfaces (changes/push, mcp/*, extensions/callExport) are mounted only
 * when their dsh.features.* gate is enabled; unmounted methods never reach
 * the initialize advertisement, so DSH registers no tool for them.
 */

const MAX_TERMINALS = 8;
const RING_BYTES = 8 * 1024;
const MAX_FIND_FILES = 500;
const MAX_PROGRESS = 2;
const PROGRESS_AUTO_END_MS = 120000;
const CONFIRM_TIMEOUT_MS = 120000;
const CALL_EXPORT_TIMEOUT_MS = 30000;
const FIND_FILES_TIMEOUT_MS = 5000;
const DEFAULT_FIND_FILES_EXCLUDE = '**/{node_modules,.git,dist,out}/**';

function v3Error(bridgeCode, message) {
  const error = new Error(message);
  error.bridgeCode = bridgeCode;
  return error;
}

const withTimeout = (promise, ms) => Promise.race([
  promise,
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    if (timer.unref) timer.unref();
  }),
]);

// Unlike withTimeout (where `undefined` legitimately means "dismissed"), the
// export call needs to distinguish `undefined` as a real return value from a
// timeout, so this settles with a sentinel error instead.
function callWithTimeout(promise, ms, timeoutCode, timeoutMessage) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(v3Error(timeoutCode, timeoutMessage));
    }, ms);
    if (timer.unref) timer.unref();
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isJsonRoundTripLossless(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return false;
  }
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return false;
  }
  try {
    deepStrictEqual(value, parsed);
    return true;
  } catch {
    return false;
  }
}

function summarizeArgs(value) {
  if (value === undefined) return { type: 'undefined', keys: [], bytes: 0 };
  const type = Array.isArray(value) ? 'array' : 'object';
  const keys = Object.keys(value);
  let bytes = 0;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    bytes = 0; // unreachable after round-trip validation
  }
  return { type, keys, bytes };
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw v3Error('VSCODE_INVALID_PARAMS', 'v3 bridge param ' + field + ' must be a non-empty string');
  }
  return value;
}

/**
 * Build the v3 handler map.
 *
 * @param {object} deps
 * @param {object} deps.vscode - VS Code facade (window/workspace/tasks/debug/extensions/commands).
 * @param {Function} deps.getFlag - (key) => boolean setting lookup for consent gates.
 * @param {Function} [deps.appendOutputLine] - DSH OutputChannel sink (best-effort).
 * @param {Function} [deps.getMcpManager] - lazy () => MCP manager resolver (L0 construction may degrade to null).
 * @param {object} [deps.callExportJournal] - optional { record(entry) } summary sink (E-T2b wires the real journal file; null skips).
 * @returns {object} method name -> handler.
 */
function createV3Handlers({ vscode, getFlag, appendOutputLine = () => {}, changeTracker = null, mcpManager = null, getMcpManager = null, callExportJournal = null }) {
  if (!vscode || !vscode.window || !vscode.workspace) {
    throw new TypeError('createV3Handlers requires a vscode facade');
  }
  if (typeof getFlag !== 'function') {
    throw new TypeError('createV3Handlers requires a getFlag(key) setting reader');
  }
  // The MCP manager is an L2 support constructed on the L0 path; resolve it
  // lazily so a degraded construction (null) never breaks the L0 lifeline.
  const resolveMcpManager = typeof getMcpManager === 'function' ? getMcpManager : () => mcpManager;
  const handlers = {};

  // ---- terminal (consent-gated: dsh.bridge.terminal) -----------------------
  if (getFlag('bridge.terminal') && typeof vscode.window.createTerminal === 'function') {
    const terminals = new Map(); // id -> { terminal, ring }
    let terminalSeq = 0;
    const capture = (entry, data) => {
      entry.ring.push(Buffer.from(String(data), 'utf8'));
      let total = 0;
      for (const chunk of entry.ring) total += chunk.length;
      while (total > RING_BYTES && entry.ring.length > 1) {
        total -= entry.ring[0].length;
        entry.ring.shift();
      }
    };
    const entryOf = (terminalId) => {
      const entry = terminals.get(terminalId);
      if (!entry) throw v3Error('VSCODE_TERMINAL_NOT_FOUND', 'Unknown terminalId: ' + terminalId);
      return entry;
    };
    // A8 (issue #7): mirror real terminal output into the ring through
    // window.onDidWriteTerminalData when the host exposes it, so
    // terminal/read sees process output (echo, command results) and not
    // only the text this bridge itself sent. The event is terminal-scoped;
    // only entries whose Terminal instance matches are captured.
    if (typeof vscode.window.onDidWriteTerminalData === 'function') {
      vscode.window.onDidWriteTerminalData((event) => {
        if (!event || typeof event.data !== 'string') return;
        for (const entry of terminals.values()) {
          if (event.terminal === entry.terminal) capture(entry, event.data);
        }
      });
    }
    handlers['vscode/terminal/create'] = async (params) => {
      if (!isRecord(params)) throw v3Error('VSCODE_INVALID_PARAMS', 'terminal/create params must be an object');
      if (terminals.size >= MAX_TERMINALS) {
        throw v3Error('VSCODE_TERMINAL_LIMIT', 'Terminal bridge allows at most ' + MAX_TERMINALS + ' concurrent terminals');
      }
      const name = typeof params.name === 'string' && params.name.length > 0 ? params.name : 'DSH';
      const options = {};
      if (typeof params.cwd === 'string' && params.cwd.length > 0) options.cwd = params.cwd;
      const terminal = vscode.window.createTerminal(options.constructor === Object && Object.keys(options).length > 0 ? { name, ...options } : name);
      const id = 't' + (++terminalSeq);
      const entry = { terminal, ring: [] };
      terminals.set(id, entry);
      // onDidWriteTerminal is global; capture only for our terminals when the
      // event exposes the terminal instance.
      appendOutputLine('[bridge] terminal created: ' + name + ' (' + id + ')');
      return { terminalId: id, name };
    };
    handlers['vscode/terminal/sendText'] = async (params) => {
      if (!isRecord(params)) throw v3Error('VSCODE_INVALID_PARAMS', 'terminal/sendText params must be an object');
      const entry = entryOf(requireString(params.terminalId, 'terminalId'));
      const text = requireString(params.text, 'text');
      const addNewline = params.addNewline === undefined ? true : Boolean(params.addNewline);
      entry.terminal.sendText(text, addNewline);
      capture(entry, text + (addNewline ? String.fromCharCode(10) : ''));
      return {};
    };
    handlers['vscode/terminal/read'] = async (params) => {
      if (!isRecord(params)) throw v3Error('VSCODE_INVALID_PARAMS', 'terminal/read params must be an object');
      const entry = entryOf(requireString(params.terminalId, 'terminalId'));
      const joined = Buffer.concat(entry.ring);
      const maxBytes = Number.isInteger(params.maxBytes) && params.maxBytes > 0 ? Math.min(params.maxBytes, RING_BYTES) : RING_BYTES;
      const bytes = joined.length > maxBytes ? joined.subarray(joined.length - maxBytes) : joined;
      return { text: bytes.toString('utf8'), truncated: joined.length > bytes.length };
    };
  }

  // ---- tasks ---------------------------------------------------------------
  if (vscode.tasks && typeof vscode.tasks.fetchTasks === 'function' && typeof vscode.tasks.executeTask === 'function') {
    const workspaceTasks = async () => {
      const all = await vscode.tasks.fetchTasks();
      // Only tasks declared in the workspace (tasks.json) — never contributed
      // detector tasks (plan: tasks.json declared only).
      return (Array.isArray(all) ? all : []).filter((task) => task && task.source === 'Workspace');
    };
    handlers['vscode/tasks/list'] = async () => {
      const tasks = await workspaceTasks();
      return { tasks: tasks.map((task) => ({ name: task.name, detail: task.detail || '' })) };
    };
    handlers['vscode/tasks/run'] = async (params) => {
      if (!isRecord(params)) throw v3Error('VSCODE_INVALID_PARAMS', 'tasks/run params must be an object');
      const name = requireString(params.name, 'name');
      const tasks = await workspaceTasks();
      const task = tasks.find((entry) => entry.name === name);
      if (!task) throw v3Error('VSCODE_TASK_NOT_FOUND', 'Workspace task not found: ' + name);
      const execution = await vscode.tasks.executeTask(task);
      appendOutputLine('[bridge] task started: ' + name);
      return { started: true, name };
    };
  }

  // ---- debug (launch.json declared only) -----------------------------------
  if (vscode.debug && typeof vscode.debug.startDebugging === 'function') {
    const launchConfigs = async () => {
      if (!vscode.workspace.workspaceFolders) return [];
      const configs = [];
      for (const folder of vscode.workspace.workspaceFolders) {
        try {
          const uri = vscode.Uri.joinPath(folder.uri, '.vscode/launch.json');
          const document = await vscode.workspace.openTextDocument(uri);
          const parsed = JSON.parse(document.getText());
          for (const config of Array.isArray(parsed.configurations) ? parsed.configurations : []) {
            if (config && typeof config.name === 'string') {
              configs.push({ folder, name: config.name, config });
            }
          }
        } catch {
          // no launch.json in this folder — skip
        }
      }
      return configs;
    };
    handlers['vscode/debug/start'] = async (params) => {
      if (!isRecord(params)) throw v3Error('VSCODE_INVALID_PARAMS', 'debug/start params must be an object');
      const name = requireString(params.name, 'name');
      const configs = await launchConfigs();
      const match = configs.find((entry) => entry.name === name);
      if (!match) throw v3Error('VSCODE_DEBUG_CONFIG_NOT_FOUND', 'launch.json configuration not found: ' + name);
      const started = await vscode.debug.startDebugging(match.folder, match.config);
      if (!started) throw v3Error('VSCODE_DEBUG_START_FAILED', 'VS Code declined to start debugging: ' + name);
      appendOutputLine('[bridge] debug started: ' + name);
      return { started: true, name };
    };
    handlers['vscode/debug/stop'] = async () => {
      if (!vscode.debug.activeDebugSession) return { stopped: false };
      await vscode.debug.stopDebugging(vscode.debug.activeDebugSession);
      return { stopped: true };
    };
    handlers['vscode/debug/getStack'] = async () => {
      const session = vscode.debug.activeDebugSession;
      if (!session) return { session: null, frames: [] };
      try {
        const response = await session.customRequest('stackTrace', { threadId: 1, startFrame: 0, levels: 50 });
        const frames = Array.isArray(response && response.stackFrames) ? response.stackFrames : [];
        return {
          session: session.name || '',
          frames: frames.map((frame) => ({ name: frame.name, line: frame.line, column: frame.column })),
        };
      } catch (error) {
        throw v3Error('VSCODE_DEBUG_STACK_FAILED', 'Could not read the debug stack: ' + (error && error.message ? error.message : String(error)));
      }
    };
  }

  // ---- workspace / window ---------------------------------------------------
  // B4/U8: never forward an unbounded query to a huge workspace. The caller's
  // exclude wins when supplied; otherwise a default exclude keeps
  // node_modules/.git/dist/out out of the scan, and a hard timeout returns a
  // model-visible empty result instead of hanging the bridge.
  handlers['vscode/workspace/findFiles'] = async (params) => {
    if (!isRecord(params)) throw v3Error('VSCODE_INVALID_PARAMS', 'findFiles params must be an object');
    const include = requireString(params.include, 'include');
    const exclude = typeof params.exclude === 'string' && params.exclude.length > 0
      ? params.exclude
      : DEFAULT_FIND_FILES_EXCLUDE;
    const requested = Number.isInteger(params.maxResults) && params.maxResults > 0 ? params.maxResults : MAX_FIND_FILES;
    const maxResults = Math.min(requested, MAX_FIND_FILES);
    const outcome = await Promise.race([
      Promise.resolve(vscode.workspace.findFiles(include, exclude, maxResults)).then((uris) => ({ uris, timedOut: false })),
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ uris: null, timedOut: true }), FIND_FILES_TIMEOUT_MS);
        if (timer.unref) timer.unref();
      }),
    ]);
    if (outcome.timedOut) {
      return { files: [], capped: false, timedOut: true };
    }
    const uris = Array.isArray(outcome.uris) ? outcome.uris : [];
    return { files: uris.map((uri) => String(uri)).slice(0, maxResults), capped: uris.length >= maxResults, timedOut: false };
  };

  // ---- user-visible surfaces (consent-gated: dsh.bridge.ui) -----------------
  if (getFlag('bridge.ui')) {
    handlers['vscode/window/showMessage'] = async (params) => {
      if (!isRecord(params)) throw v3Error('VSCODE_INVALID_PARAMS', 'showMessage params must be an object');
      const message = requireString(params.message, 'message');
      const level = params.level === 'warning' || params.level === 'error' ? params.level : 'info';
      if (level === 'error') await vscode.window.showErrorMessage(message);
      else if (level === 'warning') await vscode.window.showWarningMessage(message);
      else await vscode.window.showInformationMessage(message);
      return {};
    };
  }

  // ---- extensions (declared read surface; callExport is feature-gated below) --
  handlers['vscode/extensions/list'] = async () => {
    const all = vscode.extensions.all || [];
    return {
      extensions: all
        .filter((extension) => Boolean(extension && extension.id))
        .map((extension) => ({
          id: extension.id,
          isActive: Boolean(extension.isActive),
          exportsFace: extension.packageJSON && typeof extension.packageJSON.main === 'string',
        })),
    };
  };

  // ---- extensions/callExport (L2 gate: dsh.features.call-export) ------------
  // D12': activation and invocation share one consent gate. Not-approved paths
  // return a model-visible result instead of throwing, so the DSH agent can
  // report the user's decision without a bridge error.
  if (getFlag('features.call-export')) {
    const sessionApprovals = new Set();
    const journal = callExportJournal && typeof callExportJournal.record === 'function' ? callExportJournal : null;
    const recordJournal = (entry) => {
      if (!journal) return;
      try {
        journal.record(entry);
      } catch {
        // The journal is a best-effort summary until E-T2b wires the real file;
        // a journal failure must never change the call outcome.
      }
    };
    let callExportSeq = 0;
    const nextJournalEntry = (extensionId, method, args) => ({
      id: 'ce-' + (++callExportSeq),
      at: new Date().toISOString(),
      extensionId,
      method,
      argsSummary: summarizeArgs(args),
    });

    const invokeCallExport = async ({ extensionId, method, args }) => {
      const extension = vscode.extensions && typeof vscode.extensions.getExtension === 'function'
        ? vscode.extensions.getExtension(extensionId)
        : undefined;
      if (!extension) {
        throw v3Error('VSCODE_EXTENSION_NOT_FOUND', 'VS Code extension not found: ' + extensionId);
      }
      let exported;
      try {
        exported = extension.isActive ? extension.exports : await extension.activate();
      } catch (error) {
        throw v3Error(
          'VSCODE_CALL_EXPORT_FAILED',
          `callExport ${extensionId}.${method}() failed while activating the extension: ${error && error.message ? error.message : String(error)}`,
        );
      }
      if (exported == null || typeof exported[method] !== 'function') {
        throw v3Error('VSCODE_CALL_EXPORT_METHOD_NOT_FOUND', `Export method not found: ${extensionId}.${method}`);
      }
      const callArgs = args === undefined ? [] : (Array.isArray(args) ? args : [args]);
      try {
        return await callWithTimeout(
          exported[method](...callArgs),
          CALL_EXPORT_TIMEOUT_MS,
          'VSCODE_CALL_EXPORT_TIMEOUT',
          `callExport ${extensionId}.${method}() timed out after ${CALL_EXPORT_TIMEOUT_MS}ms`,
        );
      } catch (error) {
        if (error && error.bridgeCode === 'VSCODE_CALL_EXPORT_TIMEOUT') throw error;
        throw v3Error(
          'VSCODE_CALL_EXPORT_FAILED',
          `callExport ${extensionId}.${method}() failed: ${error && error.message ? error.message : String(error)}`,
        );
      }
    };

    handlers['vscode/extensions/callExport'] = async (params) => {
      if (!isRecord(params)) throw v3Error('VSCODE_INVALID_PARAMS', 'callExport params must be an object');
      const extensionId = requireString(params.extensionId, 'extensionId');
      if (!/^[A-Za-z0-9][A-Za-z0-9-]*\.[A-Za-z0-9][A-Za-z0-9-]*$/.test(extensionId)) {
        throw v3Error('VSCODE_INVALID_PARAMS', 'callExport extensionId must look like publisher.name');
      }
      const method = requireString(params.method, 'method');
      if (method.length > 128) {
        throw v3Error('VSCODE_INVALID_PARAMS', 'callExport method must be at most 128 characters');
      }
      if (params.args !== undefined) {
        if (params.args === null || typeof params.args !== 'object') {
          throw v3Error('VSCODE_INVALID_PARAMS', 'callExport args must be an object or an array');
        }
        if (!isJsonRoundTripLossless(params.args)) {
          throw v3Error('VSCODE_INVALID_PARAMS', 'callExport args must survive JSON.stringify/parse losslessly');
        }
      }

      const approvalKey = `${extensionId}\0${method}`;
      if (!sessionApprovals.has(approvalKey)) {
        const choice = await withTimeout(
          vscode.window.showWarningMessage(
            `DSH requests to call the "${extensionId}" extension export "${method}"(). This will activate the extension, which can run code as a side effect.`,
            { modal: true },
            'Allow Once',
            'Allow Session',
            'Reject',
          ),
          CONFIRM_TIMEOUT_MS,
        );
        if (choice === 'Allow Session') {
          sessionApprovals.add(approvalKey);
        } else if (choice !== 'Allow Once') {
          return {
            called: false,
            approved: false,
            reason: choice === 'Reject' ? 'user-rejected' : 'timeout-or-dismissed',
          };
        }
      }

      const entry = nextJournalEntry(extensionId, method, params.args);
      try {
        const result = await invokeCallExport({ extensionId, method, args: params.args });
        recordJournal({ ...entry, result: { ok: true } });
        return { called: true, approved: true, result };
      } catch (error) {
        const errorCode = error && error.bridgeCode ? error.bridgeCode : 'VSCODE_CALL_EXPORT_FAILED';
        recordJournal({ ...entry, result: { ok: false, errorCode } });
        throw error;
      }
    };
  }

  // ---- git (read-only, best-effort via the built-in vscode.git) -------------
  const gitApi = async () => {
    const extension = vscode.extensions.getExtension && vscode.extensions.getExtension('vscode.git');
    if (!extension) throw v3Error('VSCODE_GIT_UNAVAILABLE', 'The built-in Git extension is not available');
    const api = extension.isActive ? extension.exports : await extension.activate();
    const getApi = api && typeof api.getBuiltInGitApi === 'function' ? await api.getBuiltInGitApi() : api;
    if (!getApi || typeof getApi.getRepositories !== 'function') {
      throw v3Error('VSCODE_GIT_UNAVAILABLE', 'The built-in Git API is not reachable');
    }
    return getApi;
  };
  handlers['vscode/git/getStatus'] = async () => {
    const api = await gitApi();
    const repositories = await api.getRepositories();
    return {
      repos: (Array.isArray(repositories) ? repositories : []).map((repo) => ({
        root: String(repo.rootUri),
        changes: (repo.state && Array.isArray(repo.state.workingTreeChanges) ? repo.state.workingTreeChanges : []).map((change) => ({
          uri: String(change.uri),
          status: change.status,
        })),
      })),
    };
  };
  handlers['vscode/git/getDiff'] = async (params) => {
    if (!isRecord(params)) throw v3Error('VSCODE_INVALID_PARAMS', 'getDiff params must be an object');
    const api = await gitApi();
    const repositories = await api.getRepositories();
    const repo = Array.isArray(repositories) && repositories.length > 0 ? repositories[0] : null;
    if (!repo) throw v3Error('VSCODE_GIT_UNAVAILABLE', 'No Git repository is open');
    const pathspec = typeof params.uri === 'string' && params.uri.length > 0 ? vscode.Uri.parse(params.uri).fsPath : undefined;
    const diff = await repo.diffWithHEAD(pathspec);
    return { diff: typeof diff === 'string' ? diff : '' };
  };

  // ---- editor (metadata free; read consent-gated) ---------------------------
  handlers['vscode/editor/getState'] = async () => {
    const editor = vscode.window.activeTextEditor;
    const documents = Array.isArray(vscode.workspace.textDocuments) ? vscode.workspace.textDocuments : [];
    return {
      active: editor && editor.document
        ? {
          uri: String(editor.document.uri),
          languageId: editor.document.languageId,
          dirty: Boolean(editor.document.isDirty),
          selection: {
            start: { line: editor.selection.start.line, character: editor.selection.start.character },
            end: { line: editor.selection.end.line, character: editor.selection.end.character },
          },
        }
        : null,
      openDocuments: documents.map((document) => ({ uri: String(document.uri), languageId: document.languageId, dirty: Boolean(document.isDirty) })),
    };
  };
  if (getFlag('bridge.editorRead')) {
    handlers['vscode/editor/read'] = async (params) => {
      if (!isRecord(params)) throw v3Error('VSCODE_INVALID_PARAMS', 'editor/read params must be an object');
      let document = null;
      if (typeof params.uri === 'string' && params.uri.length > 0) {
        try {
          document = await vscode.workspace.openTextDocument(vscode.Uri.parse(params.uri));
        } catch (error) {
          throw v3Error('VSCODE_DOCUMENT_NOT_FOUND', 'Could not open document: ' + (error && error.message ? error.message : String(error)));
        }
      } else {
        const editor = vscode.window.activeTextEditor;
        document = editor && editor.document;
      }
      if (!document) throw v3Error('VSCODE_NO_ACTIVE_EDITOR', 'No active editor and no uri given');
      return { uri: String(document.uri), text: document.getText() };
    };
  }

  // ---- progress (≤2 concurrent, 120s auto-end; gated by dsh.bridge.ui) ------
  if (getFlag('bridge.ui') && typeof vscode.window.withProgress === 'function') {
    const progressHandles = new Map();
    let progressSeq = 0;
    const autoEnd = (id) => {
      const handle = progressHandles.get(id);
      if (!handle) return;
      progressHandles.delete(id);
      try { handle.resolve(); } catch { /* already settled */ }
    };
    handlers['vscode/progress/start'] = async (params) => {
      if (!isRecord(params)) throw v3Error('VSCODE_INVALID_PARAMS', 'progress/start params must be an object');
      if (progressHandles.size >= MAX_PROGRESS) {
        throw v3Error('VSCODE_PROGRESS_LIMIT', 'Progress bridge allows at most ' + MAX_PROGRESS + ' concurrent operations');
      }
      const title = requireString(params.title, 'title');
      const id = 'p' + (++progressSeq);
      let report = () => {};
      let resolve = () => {};
      const done = new Promise((settled) => { resolve = settled; });
      void vscode.window.withProgress(
        { location: (vscode.ProgressLocation && vscode.ProgressLocation.Notification) || 15, title },
        (progress) => {
          report = (message, increment) => progress.report({ message, increment });
          return done;
        },
      ).catch(() => { /* user dismissed; report-only surface */ });
      progressHandles.set(id, { report, resolve, timer: setTimeout(() => autoEnd(id), PROGRESS_AUTO_END_MS) });
      progressHandles.get(id).timer.unref ? progressHandles.get(id).timer.unref() : undefined;
      return { progressId: id };
    };
    handlers['vscode/progress/report'] = async (params) => {
      if (!isRecord(params)) throw v3Error('VSCODE_INVALID_PARAMS', 'progress/report params must be an object');
      const handle = progressHandles.get(requireString(params.progressId, 'progressId'));
      if (!handle) throw v3Error('VSCODE_PROGRESS_NOT_FOUND', 'Unknown progressId');
      handle.report(typeof params.message === 'string' ? params.message : undefined, Number.isFinite(params.increment) ? params.increment : undefined);
      return {};
    };
    handlers['vscode/progress/end'] = async (params) => {
      if (!isRecord(params)) throw v3Error('VSCODE_INVALID_PARAMS', 'progress/end params must be an object');
      const id = requireString(params.progressId, 'progressId');
      if (!progressHandles.has(id)) throw v3Error('VSCODE_PROGRESS_NOT_FOUND', 'Unknown progressId');
      autoEnd(id);
      return {};
    };
  }

  // ---- statusbar (one dedicated item, $(dsh) prefixed; gated) ---------------
  if (getFlag('bridge.ui') && typeof vscode.window.createStatusBarItem === 'function' && vscode.StatusBarAlignment) {
    let bridgeItem = null;
    handlers['vscode/statusbar/update'] = async (params) => {
      if (!isRecord(params)) throw v3Error('VSCODE_INVALID_PARAMS', 'statusbar/update params must be an object');
      if (!bridgeItem) {
        bridgeItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
        bridgeItem.show();
      }
      bridgeItem.text = '$(dsh) ' + (typeof params.text === 'string' ? params.text : '');
      bridgeItem.tooltip = typeof params.tooltip === 'string' ? params.tooltip : undefined;
      return {};
    };
  }

  // ---- output (same DSH channel as the degradation chain; gated) ------------
  if (getFlag('bridge.ui')) {
    handlers['vscode/output/append'] = async (params) => {
      if (!isRecord(params)) throw v3Error('VSCODE_INVALID_PARAMS', 'output/append params must be an object');
      const line = typeof params.line === 'string' ? params.line : '';
      appendOutputLine(line);
      return {};
    };

    // ---- confirm (fail-closed: timeout = deny) ------------------------------
    handlers['vscode/confirm/ask'] = async (params) => {
      if (!isRecord(params)) throw v3Error('VSCODE_INVALID_PARAMS', 'confirm/ask params must be an object');
      const kind = params.kind === 'input' || params.kind === 'warning' ? params.kind : 'pick';
      const prompt = requireString(params.prompt, 'prompt');
      let answer;
      if (kind === 'input') {
        answer = await withTimeout(vscode.window.showInputBox({ prompt }), CONFIRM_TIMEOUT_MS);
      } else if (kind === 'warning') {
        const choice = await withTimeout(vscode.window.showWarningMessage(prompt, { modal: false }, 'Confirm'), CONFIRM_TIMEOUT_MS);
        answer = choice === 'Confirm' ? 'confirmed' : undefined;
      } else {
        const items = Array.isArray(params.items) ? params.items.filter((item) => typeof item === 'string').slice(0, 8) : [];
        const choice = await withTimeout(vscode.window.showQuickPick(items.length > 0 ? items : ['OK']), CONFIRM_TIMEOUT_MS);
        answer = typeof choice === 'string' ? choice : undefined;
      }
      if (answer === undefined) {
        return { approved: false, value: null, reason: 'timeout-or-dismissed' };
      }
      return { approved: true, value: answer };
    };
  }

  // ---- changes/push (L2 gate: dsh.features.changes-review) -------------------
  // Not-approved paths return a model-visible result instead of throwing, so
  // the DSH agent can report the user's decision without a bridge error.
  if (getFlag('features.changes-review')) {
    const tracker = changeTracker || createChangeTracker({ storageUri: null, vscode });
    const sessionApprovals = new Set();

    handlers['vscode/changes/push'] = async (params) => {
      if (!isRecord(params)) throw v3Error('VSCODE_INVALID_PARAMS', 'changes/push params must be an object');
      if (params.sessionId !== undefined && typeof params.sessionId !== 'string') {
        throw v3Error('VSCODE_INVALID_PARAMS', 'changes/push sessionId must be a string');
      }
      if (params.label !== undefined) {
        if (typeof params.label !== 'string' || params.label.length > MAX_LABEL_CHARS) {
          throw v3Error('VSCODE_INVALID_PARAMS', `changes/push label must be a string of at most ${MAX_LABEL_CHARS} characters`);
        }
      }
      if (params.mode !== undefined && params.mode !== 'ask' && params.mode !== 'session') {
        throw v3Error('VSCODE_INVALID_PARAMS', "changes/push mode must be 'ask' or 'session'");
      }
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
      const label = typeof params.label === 'string' ? params.label : '';
      const mode = params.mode === 'session' ? 'session' : 'ask';
      const edits = validateWireEdits(params.edits, vscode);

      if (mode === 'session' && sessionId.length > 0 && sessionApprovals.has(sessionId)) {
        const before = await tracker.snapshotBefore(edits);
        const entry = await tracker.record({ sessionId, label, edits: stringifyEdits(edits), before });
        return { applied: false, approved: true, pending: true, changeIds: [entry.id] };
      }

      const files = new Set(edits.map((edit) => String(edit.uri))).size;
      const detail = `${files} file(s), ${edits.length} edit(s)` + (label.length > 0 ? ` — ${label}` : '');
      const message = `DSH requests workspace edits (${detail})`;
      const choice = await withTimeout(
        vscode.window.showWarningMessage(message, { modal: true }, 'Allow Once', 'Allow Session', 'Reject'),
        CONFIRM_TIMEOUT_MS,
      );

      if (choice === 'Allow Session') {
        if (sessionId.length > 0) sessionApprovals.add(sessionId);
      } else if (choice !== 'Allow Once') {
        return {
          applied: false,
          approved: false,
          reason: choice === 'Reject' ? 'user-rejected' : 'timeout-or-dismissed',
        };
      }

      // B1: approval only journals the change as pending; the tree's Accept
      // command is what writes it to disk (tracker.applyEdits).
      const before = await tracker.snapshotBefore(edits);
      const entry = await tracker.record({ sessionId, label, edits: stringifyEdits(edits), before });
      return { applied: false, approved: true, pending: true, changeIds: [entry.id] };
    };
  }

  // ---- mcp/* (L2 gate: dsh.features.mcp-consume) -----------------------------
  // The manager is created in L0 and resolved lazily: when its construction
  // degraded to null the methods stay advertised (feature on) and fail with
  // a visible VSCODE_MCP_UNAVAILABLE error instead of silently vanishing.
  if (getFlag('features.mcp-consume')) {
    const requireMcpManager = () => {
      const manager = resolveMcpManager();
      if (!manager) {
        throw v3Error('VSCODE_MCP_UNAVAILABLE', 'The MCP consume support is unavailable (manager construction failed on this host)');
      }
      return manager;
    };
    handlers['vscode/mcp/listServers'] = async () => requireMcpManager().listServers();
    handlers['vscode/mcp/listTools'] = async (params) => {
      if (!isRecord(params)) throw v3Error('VSCODE_INVALID_PARAMS', 'mcp/listTools params must be an object');
      return requireMcpManager().listTools(requireString(params.server, 'server'));
    };
    handlers['vscode/mcp/callTool'] = async (params) => {
      if (!isRecord(params)) throw v3Error('VSCODE_INVALID_PARAMS', 'mcp/callTool params must be an object');
      const server = requireString(params.server, 'server');
      const tool = requireString(params.tool, 'tool');
      return requireMcpManager().callTool(server, tool, params.arguments);
    };
  }

  return handlers;
}

function stringifyEdits(edits) {
  return edits.map((edit) => {
    const clone = { ...edit, uri: String(edit.uri) };
    return clone;
  });
}

module.exports = {
  CALL_EXPORT_TIMEOUT_MS,
  CONFIRM_TIMEOUT_MS,
  DEFAULT_FIND_FILES_EXCLUDE,
  FIND_FILES_TIMEOUT_MS,
  MAX_FIND_FILES,
  MAX_PROGRESS,
  MAX_TERMINALS,
  PROGRESS_AUTO_END_MS,
  RING_BYTES,
  createV3Handlers,
};
