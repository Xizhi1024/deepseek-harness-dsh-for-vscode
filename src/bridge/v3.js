"use strict";

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
 * Deliberately NOT mounted yet (frozen in METHODS_V3, later D slices):
 * vscode/changes/push (R14S1), vscode/mcp/* (R22).
 */

const MAX_TERMINALS = 8;
const RING_BYTES = 8 * 1024;
const MAX_FIND_FILES = 500;
const MAX_PROGRESS = 2;
const PROGRESS_AUTO_END_MS = 120000;
const CONFIRM_TIMEOUT_MS = 120000;

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
 * @returns {object} method name -> handler.
 */
function createV3Handlers({ vscode, getFlag, appendOutputLine = () => {}, changeTracker = null, mcpManager = null }) {
  if (!vscode || !vscode.window || !vscode.workspace) {
    throw new TypeError('createV3Handlers requires a vscode facade');
  }
  if (typeof getFlag !== 'function') {
    throw new TypeError('createV3Handlers requires a getFlag(key) setting reader');
  }
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
  handlers['vscode/workspace/findFiles'] = async (params) => {
    if (!isRecord(params)) throw v3Error('VSCODE_INVALID_PARAMS', 'findFiles params must be an object');
    const include = requireString(params.include, 'include');
    const exclude = typeof params.exclude === 'string' && params.exclude.length > 0 ? params.exclude : undefined;
    const requested = Number.isInteger(params.maxResults) && params.maxResults > 0 ? params.maxResults : MAX_FIND_FILES;
    const maxResults = Math.min(requested, MAX_FIND_FILES);
    const uris = await vscode.workspace.findFiles(include, exclude, maxResults);
    return { files: (Array.isArray(uris) ? uris : []).map((uri) => String(uri)).slice(0, maxResults), capped: uris.length >= maxResults };
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

  // ---- extensions (declared surface, no callExport in v3a) ------------------
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
        await tracker.applyEdits(edits);
        const entry = await tracker.record({ sessionId, label, edits: stringifyEdits(edits), before });
        return { applied: true, approved: true, changeIds: [entry.id] };
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

      const before = await tracker.snapshotBefore(edits);
      await tracker.applyEdits(edits);
      const entry = await tracker.record({ sessionId, label, edits: stringifyEdits(edits), before });
      return { applied: true, approved: true, changeIds: [entry.id] };
    };
  }

  // ---- mcp/* (L2 gate: dsh.features.mcp-consume) -----------------------------
  // The manager is created in L0 (no side effects) and wired by the L2 setup;
  // when the manager is absent these methods stay unadvertised.
  if (getFlag('features.mcp-consume') && mcpManager) {
    handlers['vscode/mcp/listServers'] = async () => mcpManager.listServers();
    handlers['vscode/mcp/listTools'] = async (params) => {
      if (!isRecord(params)) throw v3Error('VSCODE_INVALID_PARAMS', 'mcp/listTools params must be an object');
      return mcpManager.listTools(requireString(params.server, 'server'));
    };
    handlers['vscode/mcp/callTool'] = async (params) => {
      if (!isRecord(params)) throw v3Error('VSCODE_INVALID_PARAMS', 'mcp/callTool params must be an object');
      const server = requireString(params.server, 'server');
      const tool = requireString(params.tool, 'tool');
      return mcpManager.callTool(server, tool, params.arguments);
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
  CONFIRM_TIMEOUT_MS,
  MAX_FIND_FILES,
  MAX_PROGRESS,
  MAX_TERMINALS,
  PROGRESS_AUTO_END_MS,
  RING_BYTES,
  createV3Handlers,
};
