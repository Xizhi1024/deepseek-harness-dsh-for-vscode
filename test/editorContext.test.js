'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ATTACHMENT_KINDS,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  DEFAULT_MAX_DIAGNOSTIC_ITEMS,
  DEFAULT_MAX_DIAGNOSTIC_MESSAGE_CHARS,
  EditorContextError,
  createEditorContext,
} = require('../src/editorContext');

function fakeUri(scheme, value) {
  return {
    scheme,
    toString() {
      return value;
    },
    fsPath: value,
  };
}

function fakeRange(startLine, startCharacter, endLine, endCharacter) {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  };
}

function uriText(uri) {
  return typeof uri.toString === 'function' ? uri.toString() : String(uri);
}

function createHarness(options = {}) {
  const workspaceUri = fakeUri('file', 'file:///ws');
  const activeDocument = {
    uri: fakeUri('file', 'file:///ws/a.ts'),
    languageId: 'typescript',
    version: 7,
    isDirty: false,
    getText(range) {
      return range ? 'selected text' : 'full text';
    },
  };
  const activeEditor = {
    document: activeDocument,
    selection: fakeRange(1, 2, 3, 4),
  };

  const state = {
    trusted: Object.prototype.hasOwnProperty.call(options, 'trusted') ? options.trusted : true,
    workspaceFolders: Object.prototype.hasOwnProperty.call(options, 'workspaceFolders')
      ? options.workspaceFolders
      : [{ uri: workspaceUri, name: 'ws', index: 0 }],
    activeTextEditor: Object.prototype.hasOwnProperty.call(options, 'activeTextEditor')
      ? options.activeTextEditor
      : activeEditor,
  };
  const calls = {
    openTextDocument: [],
    showTextDocument: [],
    executeCommand: [],
    getDiagnostics: [],
  };
  const diagnosticsByUri = new Map();
  if (options.diagnostics) {
    for (const [key, value] of options.diagnostics) diagnosticsByUri.set(key, value);
  }

  const workspace = {
    get workspaceFolders() {
      return state.workspaceFolders;
    },
    get isTrusted() {
      return state.trusted;
    },
    getWorkspaceFolder(uri) {
      const text = uriText(uri);
      const folders = state.workspaceFolders || [];
      return folders.find((folder) => {
        const folderText = uriText(folder.uri);
        return text === folderText || text.startsWith(`${folderText}/`);
      });
    },
    openTextDocument(uri) {
      calls.openTextDocument.push(uri);
      return Promise.resolve({ uri, getText: () => 'opened text' });
    },
  };

  const window = {
    get activeTextEditor() {
      return state.activeTextEditor;
    },
    showTextDocument(document, options) {
      calls.showTextDocument.push({ document, options });
      return Promise.resolve(document);
    },
  };

  const languages = {
    getDiagnostics(uri) {
      calls.getDiagnostics.push(uri);
      return diagnosticsByUri.get(uriText(uri)) || [];
    },
  };

  const commands = {
    executeCommand(...args) {
      calls.executeCommand.push(args);
      return Promise.resolve(undefined);
    },
  };

  const vscode = {
    Uri: {
      parse(value) {
        const text = String(value);
        const separator = text.indexOf(':');
        const scheme = separator >= 0 ? text.slice(0, separator) : '';
        return fakeUri(scheme, text);
      },
    },
    Range: fakeRange,
    workspace,
    window,
    languages,
    commands,
  };

  return { vscode, calls, state, diagnosticsByUri, activeDocument, activeEditor };
}

async function rejectsWith(promise, bridgeCode) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof EditorContextError, `expected EditorContextError, got ${error && error.constructor && error.constructor.name}`);
    assert.strictEqual(error.bridgeCode, bridgeCode);
    return true;
  });
}

test('getContext returns only attached attachments, ignores stale ids, and revision increments', async () => {
  const { vscode } = createHarness();
  const changes = [];
  const ctx = createEditorContext({ vscode, onChange: (payload) => changes.push(payload) });

  assert.strictEqual(ctx.revision, 1);
  assert.deepStrictEqual(await ctx.handlers['vscode/editor/getContext']({}, {}), { revision: 1, attachments: [] });

  const file = ctx.attachActiveFile();
  assert.strictEqual(ctx.revision, 2);
  assert.deepStrictEqual(changes, [{ revision: 2, attachmentIds: [file.id] }]);

  const selected = await ctx.handlers['vscode/editor/getContext']({ attachmentIds: [file.id, 'ctx-stale'] }, {});
  assert.strictEqual(selected.revision, 2);
  assert.strictEqual(selected.attachments.length, 1);
  assert.strictEqual(selected.attachments[0].id, file.id);
  assert.strictEqual(selected.attachments[0].kind, 'active-file');
  assert.notStrictEqual(selected.attachments[0], file);

  const stale = await ctx.handlers['vscode/editor/getContext']({ attachmentIds: ['ctx-stale'] }, {});
  assert.deepStrictEqual(stale, { revision: 2, attachments: [] });

  ctx.clearAttachments();
  assert.strictEqual(ctx.revision, 3);
  assert.deepStrictEqual(changes[1], { revision: 3, attachmentIds: [] });
  assert.deepStrictEqual(ctx.attachmentSnapshot(), []);
  assert.deepStrictEqual(await ctx.handlers['vscode/editor/getContext']({}, {}), { revision: 3, attachments: [] });
});

test('attachActiveFile reads full text and includes document metadata', () => {
  const { vscode } = createHarness();
  const ctx = createEditorContext({ vscode });
  const attachment = ctx.attachActiveFile();

  assert.match(attachment.id, /^ctx-\d+$/);
  assert.strictEqual(attachment.kind, 'active-file');
  assert.strictEqual(attachment.content, 'full text');
  assert.deepStrictEqual(attachment.document, {
    uri: 'file:///ws/a.ts',
    languageId: 'typescript',
    version: 7,
    dirty: false,
  });
  assert.strictEqual(attachment.range, undefined);
  assert.strictEqual(typeof attachment.createdAt, 'string');
});

test('attachActiveSelection throws VSCODE_EMPTY_SELECTION for missing or empty selection', () => {
  const empty = createHarness({ activeTextEditor: { document: { uri: fakeUri('file', 'file:///ws/a.ts'), getText: () => '' }, selection: fakeRange(1, 1, 1, 1) } });
  const emptyCtx = createEditorContext({ vscode: empty.vscode });
  assert.throws(
    () => emptyCtx.attachActiveSelection(),
    (error) => error instanceof EditorContextError && error.bridgeCode === 'VSCODE_EMPTY_SELECTION'
  );

  const missing = createHarness({ activeTextEditor: undefined });
  const missingCtx = createEditorContext({ vscode: missing.vscode });
  assert.throws(
    () => missingCtx.attachActiveSelection(),
    (error) => error instanceof EditorContextError && error.bridgeCode === 'VSCODE_EMPTY_SELECTION'
  );
});

test('attachActiveSelection captures selection text and range', () => {
  const { vscode } = createHarness();
  const ctx = createEditorContext({ vscode });
  const attachment = ctx.attachActiveSelection();

  assert.strictEqual(attachment.kind, 'selection');
  assert.strictEqual(attachment.content, 'selected text');
  assert.deepStrictEqual(attachment.range, {
    start: { line: 1, character: 2 },
    end: { line: 3, character: 4 },
  });
  assert.deepStrictEqual(attachment.document, {
    uri: 'file:///ws/a.ts',
    languageId: 'typescript',
    version: 7,
    dirty: false,
  });
});

test('attachProblems projects diagnostics and JSON-encodes them', () => {
  const { vscode } = createHarness({
    diagnostics: [
      ['file:///ws/a.ts', [
        { range: fakeRange(0, 0, 0, 5), severity: 0, message: 'err', source: 'ts', code: '2304' },
        { range: fakeRange(1, 0, 1, 2), severity: 1, message: 'warn', code: 42 },
        { range: fakeRange(2, 0, 2, 2), severity: 2, message: 'info' },
        { range: fakeRange(3, 0, 3, 3), severity: 3, message: 'hint', code: { nested: true } },
        { range: fakeRange(4, 0, 4, 4), severity: 99, message: 'unknown' },
      ]],
    ],
  });
  const ctx = createEditorContext({ vscode });
  const attachment = ctx.attachProblems();

  assert.strictEqual(attachment.kind, 'problems');
  assert.deepStrictEqual(attachment.document, {
    uri: 'file:///ws/a.ts',
    languageId: 'typescript',
    version: 7,
    dirty: false,
  });
  const diagnostics = JSON.parse(attachment.content);
  assert.deepStrictEqual(diagnostics.map((item) => item.severity), ['error', 'warning', 'information', 'hint', 'information']);
  assert.deepStrictEqual(diagnostics[0].document, { uri: 'file:///ws/a.ts' });
  assert.strictEqual(diagnostics[0].source, 'ts');
  assert.strictEqual(diagnostics[0].code, '2304');
  assert.strictEqual(diagnostics[1].code, 42);
  assert.strictEqual('code' in diagnostics[2], false);
  assert.strictEqual('code' in diagnostics[3], false);
  assert.strictEqual('source' in diagnostics[1], false);
});

test('attach methods throw VSCODE_ATTACHMENT_TOO_LARGE when content exceeds byte limit', () => {
  const { vscode } = createHarness({
    diagnostics: [
      ['file:///ws/a.ts', [{ range: fakeRange(0, 0, 0, 5), severity: 0, message: 'problem' }]],
    ],
  });
  const ctx = createEditorContext({ vscode, limits: { maxAttachmentBytes: 4 } });

  assert.throws(
    () => ctx.attachActiveFile(),
    (error) => error instanceof EditorContextError && error.bridgeCode === 'VSCODE_ATTACHMENT_TOO_LARGE' && /4/.test(error.message)
  );
  assert.throws(
    () => ctx.attachActiveSelection(),
    (error) => error instanceof EditorContextError && error.bridgeCode === 'VSCODE_ATTACHMENT_TOO_LARGE' && /4/.test(error.message)
  );
  assert.throws(
    () => ctx.attachProblems(),
    (error) => error instanceof EditorContextError && error.bridgeCode === 'VSCODE_ATTACHMENT_TOO_LARGE' && /4/.test(error.message)
  );
  assert.strictEqual(ctx.revision, 1);
});

test('open opens workspace file uris with preview:false and preserves selection/range', async () => {
  const { vscode, calls } = createHarness();
  const ctx = createEditorContext({ vscode });
  const open = ctx.handlers['vscode/editor/open'];

  assert.deepStrictEqual(await open({ document: { uri: 'file:///ws/a.ts' }, preserveFocus: false }, {}), { opened: true });
  assert.strictEqual(calls.openTextDocument.length, 1);
  assert.strictEqual(uriText(calls.openTextDocument[0]), 'file:///ws/a.ts');
  assert.strictEqual(calls.showTextDocument.length, 1);
  assert.deepStrictEqual(calls.showTextDocument[0].options, { preview: false, preserveFocus: false });

  await open({ document: { uri: 'file:///ws/a.ts' }, range: fakeRange(1, 2, 3, 4), preserveFocus: true }, {});
  assert.strictEqual(calls.showTextDocument.length, 2);
  const shown = calls.showTextDocument[1];
  assert.strictEqual(shown.options.preview, false);
  assert.strictEqual(shown.options.preserveFocus, true);
  assert.deepStrictEqual(shown.options.selection, fakeRange(1, 2, 3, 4));
});

test('open rejects outside-workspace, non-file, and malformed range params', async () => {
  const { vscode } = createHarness();
  const open = createEditorContext({ vscode }).handlers['vscode/editor/open'];

  await rejectsWith(open({ document: { uri: 'file:///other/a.ts' } }, {}), 'VSCODE_URI_OUTSIDE_WORKSPACE');
  await rejectsWith(open({ document: { uri: 'untitled:Untitled-1' } }, {}), 'VSCODE_UNSUPPORTED_DOCUMENT');
  await rejectsWith(open({ document: { uri: 42 } }, {}), 'VSCODE_INVALID_PARAMS');
  await rejectsWith(open({}, {}), 'VSCODE_INVALID_PARAMS');
  await rejectsWith(open({ document: { uri: 'file:///ws/a.ts' }, range: { start: { line: 0, character: 0 } } }, {}), 'VSCODE_INVALID_PARAMS');
  await rejectsWith(open({ document: { uri: 'file:///ws/a.ts' }, range: fakeRange(0, -1, 1, 1) }, {}), 'VSCODE_INVALID_PARAMS');
  await rejectsWith(open({ document: { uri: 'file:///ws/a.ts' }, range: fakeRange(2, 0, 1, 1) }, {}), 'VSCODE_INVALID_PARAMS');
});

test('openDiff executes vscode.diff and rejects invalid uris and titles', async () => {
  const { vscode, calls } = createHarness();
  const openDiff = createEditorContext({ vscode }).handlers['vscode/editor/openDiff'];

  assert.deepStrictEqual(await openDiff({
    left: { uri: 'file:///ws/a.ts' },
    right: { uri: 'file:///ws/b.ts' },
    title: 'Diff',
    preserveFocus: true,
  }, {}), { opened: true });

  assert.strictEqual(calls.executeCommand.length, 1);
  const args = calls.executeCommand[0];
  assert.strictEqual(args[0], 'vscode.diff');
  assert.strictEqual(uriText(args[1]), 'file:///ws/a.ts');
  assert.strictEqual(uriText(args[2]), 'file:///ws/b.ts');
  assert.strictEqual(args[3], 'Diff');
  assert.deepStrictEqual(args[4], { preview: false, preserveFocus: true });

  await rejectsWith(openDiff({
    left: { uri: 'file:///ws/a.ts' },
    right: { uri: 'file:///other/b.ts' },
  }, {}), 'VSCODE_URI_OUTSIDE_WORKSPACE');
  await rejectsWith(openDiff({
    left: { uri: 'untitled:a' },
    right: { uri: 'file:///ws/b.ts' },
  }, {}), 'VSCODE_UNSUPPORTED_DOCUMENT');
  await rejectsWith(openDiff({
    left: { uri: 'file:///ws/a.ts' },
    right: { uri: 'file:///ws/b.ts' },
    title: 'x'.repeat(201),
  }, {}), 'VSCODE_INVALID_PARAMS');
  await rejectsWith(openDiff({
    left: { uri: 'file:///ws/a.ts' },
    right: { uri: 'file:///ws/b.ts' },
    title: '',
  }, {}), 'VSCODE_INVALID_PARAMS');
  await rejectsWith(openDiff({
    left: { uri: 'file:///ws/a.ts' },
    right: { uri: 'file:///ws/b.ts' },
    title: 5,
  }, {}), 'VSCODE_INVALID_PARAMS');
});

test('getDiagnostics maps severities, truncates messages, filters codes, and caps totals', async () => {
  const longMessage = 'x'.repeat(DEFAULT_MAX_DIAGNOSTIC_MESSAGE_CHARS + 100);
  const { vscode } = createHarness({
    diagnostics: [
      ['file:///ws/a.ts', [
        { range: fakeRange(0, 0, 0, 1), severity: 0, message: 'error msg', source: 'ts', code: '2304' },
        { range: fakeRange(1, 0, 1, 1), severity: 1, message: 'warning msg', code: 42 },
        { range: fakeRange(2, 0, 2, 1), severity: 2, message: 'info msg' },
        { range: fakeRange(3, 0, 3, 1), severity: 3, message: 'hint msg', code: { nested: true } },
        { range: fakeRange(4, 0, 4, 1), severity: 8, message: longMessage },
      ]],
    ],
  });
  const ctx = createEditorContext({ vscode });
  const result = await ctx.handlers['vscode/workspace/getDiagnostics']({ uris: ['file:///ws/a.ts'] }, {});

  assert.strictEqual(result.diagnostics.length, 5);
  assert.deepStrictEqual(result.diagnostics.map((item) => item.severity), ['error', 'warning', 'information', 'hint', 'information']);
  assert.deepStrictEqual(result.diagnostics[0].document, { uri: 'file:///ws/a.ts' });
  assert.deepStrictEqual(result.diagnostics[0].range, fakeRange(0, 0, 0, 1));
  assert.strictEqual(result.diagnostics[0].source, 'ts');
  assert.strictEqual(result.diagnostics[0].code, '2304');
  assert.strictEqual(result.diagnostics[1].code, 42);
  assert.strictEqual('code' in result.diagnostics[2], false);
  assert.strictEqual('code' in result.diagnostics[3], false);
  assert.strictEqual(result.diagnostics[4].message, `${'x'.repeat(DEFAULT_MAX_DIAGNOSTIC_MESSAGE_CHARS)}…`);
});

test('getDiagnostics defaults to attached document uris and validates explicit uris', async () => {
  const { vscode, calls, diagnosticsByUri } = createHarness();
  const ctx = createEditorContext({ vscode });

  ctx.attachActiveFile();
  diagnosticsByUri.set('file:///ws/a.ts', [{ range: fakeRange(0, 0, 0, 1), severity: 0, message: 'attached error' }]);

  const byDefault = await ctx.handlers['vscode/workspace/getDiagnostics']({}, {});
  assert.strictEqual(byDefault.diagnostics.length, 1);
  assert.strictEqual(calls.getDiagnostics.length, 1);
  assert.strictEqual(uriText(calls.getDiagnostics[0]), 'file:///ws/a.ts');

  const explicit = await ctx.handlers['vscode/workspace/getDiagnostics']({ uris: ['file:///ws/a.ts'] }, {});
  assert.strictEqual(explicit.diagnostics.length, 1);

  await rejectsWith(ctx.handlers['vscode/workspace/getDiagnostics']({ uris: ['file:///other/a.ts'] }, {}), 'VSCODE_URI_OUTSIDE_WORKSPACE');
  await rejectsWith(ctx.handlers['vscode/workspace/getDiagnostics']({ uris: ['untitled:a'] }, {}), 'VSCODE_UNSUPPORTED_DOCUMENT');
  await rejectsWith(ctx.handlers['vscode/workspace/getDiagnostics']({ uris: 'file:///ws/a.ts' }, {}), 'VSCODE_INVALID_PARAMS');
});

test('getDiagnostics caps total diagnostics across uris', async () => {
  const { vscode } = createHarness({
    diagnostics: [
      ['file:///ws/a.ts', [
        { range: fakeRange(0, 0, 0, 1), severity: 0, message: 'a1' },
        { range: fakeRange(1, 0, 1, 1), severity: 0, message: 'a2' },
      ]],
      ['file:///ws/b.ts', [
        { range: fakeRange(0, 0, 0, 1), severity: 0, message: 'b1' },
        { range: fakeRange(1, 0, 1, 1), severity: 0, message: 'b2' },
      ]],
    ],
  });
  const ctx = createEditorContext({ vscode, limits: { maxDiagnosticItems: 3 } });
  const result = await ctx.handlers['vscode/workspace/getDiagnostics']({ uris: ['file:///ws/a.ts', 'file:///ws/b.ts'] }, {});

  assert.strictEqual(result.diagnostics.length, 3);
  assert.deepStrictEqual(result.diagnostics.map((item) => item.message), ['a1', 'a2', 'b1']);
});

test('untrusted workspace rejects all workspace-reading operations', async () => {
  const { vscode } = createHarness({ trusted: false });
  const ctx = createEditorContext({ vscode });

  await rejectsWith(ctx.handlers['vscode/editor/getContext']({}, {}), 'VSCODE_WORKSPACE_UNTRUSTED');
  await rejectsWith(ctx.handlers['vscode/editor/open']({ document: { uri: 'file:///ws/a.ts' } }, {}), 'VSCODE_WORKSPACE_UNTRUSTED');
  await rejectsWith(ctx.handlers['vscode/editor/openDiff']({ left: { uri: 'file:///ws/a.ts' }, right: { uri: 'file:///ws/b.ts' } }, {}), 'VSCODE_WORKSPACE_UNTRUSTED');
  await rejectsWith(ctx.handlers['vscode/workspace/getDiagnostics']({ uris: ['file:///ws/a.ts'] }, {}), 'VSCODE_WORKSPACE_UNTRUSTED');
  assert.throws(
    () => ctx.attachActiveFile(),
    (error) => error instanceof EditorContextError && error.bridgeCode === 'VSCODE_WORKSPACE_UNTRUSTED'
  );
  assert.throws(
    () => ctx.attachActiveSelection(),
    (error) => error instanceof EditorContextError && error.bridgeCode === 'VSCODE_WORKSPACE_UNTRUSTED'
  );
  assert.throws(
    () => ctx.attachProblems(),
    (error) => error instanceof EditorContextError && error.bridgeCode === 'VSCODE_WORKSPACE_UNTRUSTED'
  );
});

test('aborted signals cancel getContext and open with VSCODE_REQUEST_CANCELLED', async () => {
  const { vscode, calls } = createHarness();
  const ctx = createEditorContext({ vscode });

  const preAborted = new AbortController();
  preAborted.abort(new EditorContextError('VSCODE_REQUEST_CANCELLED', 'cancelled before start'));
  await rejectsWith(ctx.handlers['vscode/editor/getContext']({}, { signal: preAborted.signal }), 'VSCODE_REQUEST_CANCELLED');

  const midFlight = new AbortController();
  vscode.workspace.openTextDocument = (uri) => {
    midFlight.abort(new EditorContextError('VSCODE_REQUEST_CANCELLED', 'cancelled mid-flight'));
    return Promise.resolve({ uri, getText: () => 'opened text' });
  };
  await rejectsWith(ctx.handlers['vscode/editor/open']({ document: { uri: 'file:///ws/a.ts' } }, { signal: midFlight.signal }), 'VSCODE_REQUEST_CANCELLED');
  assert.strictEqual(calls.showTextDocument.length, 0);
});

test('errors expose bridgeCode and public objects are frozen', () => {
  const { vscode } = createHarness();
  const ctx = createEditorContext({ vscode });

  assert.strictEqual(Object.isFrozen(ctx), true);
  assert.strictEqual(Object.isFrozen(ctx.handlers), true);
  assert.strictEqual(Object.isFrozen(ATTACHMENT_KINDS), true);
  assert.deepStrictEqual(ATTACHMENT_KINDS, ['active-file', 'selection', 'problems']);
  assert.strictEqual(DEFAULT_MAX_ATTACHMENT_BYTES, 1 * 1024 * 1024);
  assert.strictEqual(DEFAULT_MAX_DIAGNOSTIC_ITEMS, 1000);
  assert.strictEqual(DEFAULT_MAX_DIAGNOSTIC_MESSAGE_CHARS, 2000);

  const error = new EditorContextError('VSCODE_TEST', 'boom');
  assert.ok(error instanceof Error);
  assert.strictEqual(error.bridgeCode, 'VSCODE_TEST');

  const empty = createHarness({ activeTextEditor: undefined });
  assert.throws(
    () => createEditorContext({ vscode: empty.vscode }).attachActiveFile(),
    (caught) => caught instanceof EditorContextError && caught.bridgeCode === 'VSCODE_NO_ACTIVE_EDITOR'
  );
});

test('createEditorContext validates the vscode facade', () => {
  assert.throws(() => createEditorContext({}), TypeError);
  assert.throws(() => createEditorContext({ vscode: {} }), TypeError);
  assert.throws(() => createEditorContext({
    vscode: {
      Uri: { parse() {} },
      workspace: { workspaceFolders: [], isTrusted: true, getWorkspaceFolder() {}, openTextDocument() {} },
      window: { activeTextEditor: undefined, showTextDocument() {} },
      languages: {},
      commands: { executeCommand() {} },
    },
  }), TypeError);
});
