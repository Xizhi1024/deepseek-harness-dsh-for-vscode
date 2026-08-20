'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { EditorContextError, createEditorContext } = require('../../src/editorContext');

function fakeUri(scheme, value) {
  return {
    scheme,
    toString() {
      return value;
    },
    fsPath: value,
  };
}

function uriText(uri) {
  return typeof uri.toString === 'function' ? uri.toString() : String(uri);
}

function createHarness(options = {}) {
  const workspaceUri = fakeUri('file', 'file:///ws');
  const state = {
    trusted: Object.prototype.hasOwnProperty.call(options, 'trusted') ? options.trusted : true,
    workspaceFolders: Object.prototype.hasOwnProperty.call(options, 'workspaceFolders')
      ? options.workspaceFolders
      : [{ uri: workspaceUri, name: 'ws', index: 0 }],
  };

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
      return Promise.resolve({ uri, getText: () => 'opened text' });
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
    workspace,
    window: { activeTextEditor: undefined, showTextDocument() {} },
    languages: { getDiagnostics() { return []; } },
    commands: { executeCommand() {} },
  };

  return { vscode, state };
}

async function rejectsWith(promise, bridgeCode) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof EditorContextError, `expected EditorContextError, got ${error && error.constructor && error.constructor.name}`);
    assert.strictEqual(error.bridgeCode, bridgeCode);
    return true;
  });
}

test('attachFiles reads workspace files and returns file attachments in input order', async () => {
  const { vscode } = createHarness();
  const documents = new Map([
    ['file:///ws/a.ts', {
      uri: fakeUri('file', 'file:///ws/a.ts'),
      languageId: 'typescript',
      version: 3,
      isDirty: false,
      getText: () => 'alpha',
    }],
    ['file:///ws/b.ts', {
      uri: fakeUri('file', 'file:///ws/b.ts'),
      languageId: 'javascript',
      version: 9,
      isDirty: true,
      getText: () => 'beta',
    }],
  ]);
  vscode.workspace.openTextDocument = (uri) => Promise.resolve(documents.get(uriText(uri)));
  const ctx = createEditorContext({ vscode });
  const uris = [fakeUri('file', 'file:///ws/a.ts'), fakeUri('file', 'file:///ws/b.ts')];

  const attachments = await ctx.attachFiles(uris);

  assert.strictEqual(attachments.length, 2);
  assert.deepStrictEqual(attachments.map((attachment) => attachment.kind), ['file', 'file']);
  assert.deepStrictEqual(attachments.map((attachment) => attachment.content), ['alpha', 'beta']);
  assert.match(attachments[0].id, /^ctx-\d+$/);
  assert.strictEqual(typeof attachments[0].createdAt, 'string');
  assert.deepStrictEqual(attachments[0].document, {
    uri: 'file:///ws/a.ts',
    languageId: 'typescript',
    version: 3,
    dirty: false,
  });
  assert.deepStrictEqual(attachments[1].document, {
    uri: 'file:///ws/b.ts',
    languageId: 'javascript',
    version: 9,
    dirty: true,
  });
  assert.strictEqual(ctx.revision, 3);
});

test('attachFiles rejects invalid uris, bad counts, outside-workspace uris, and oversized content', async () => {
  const { vscode } = createHarness();
  const ctx = createEditorContext({ vscode });

  await rejectsWith(ctx.attachFiles(), 'VSCODE_INVALID_PARAMS');
  await rejectsWith(ctx.attachFiles([]), 'VSCODE_INVALID_PARAMS');
  await rejectsWith(ctx.attachFiles(Array(9).fill(fakeUri('file', 'file:///ws/a.ts'))), 'VSCODE_INVALID_PARAMS');
  await rejectsWith(ctx.attachFiles([fakeUri('untitled', 'untitled:a')]), 'VSCODE_UNSUPPORTED_DOCUMENT');
  await rejectsWith(ctx.attachFiles([fakeUri('file', 'file:///other/a.ts')]), 'VSCODE_URI_OUTSIDE_WORKSPACE');

  vscode.workspace.openTextDocument = (uri) => Promise.resolve({ uri, getText: () => 'x'.repeat(5) });
  const capped = createEditorContext({ vscode, limits: { maxAttachmentBytes: 4 } });
  await rejectsWith(capped.attachFiles([fakeUri('file', 'file:///ws/a.ts')]), 'VSCODE_ATTACHMENT_TOO_LARGE');
  assert.strictEqual(capped.revision, 1);
});

test('attachFiles rejects untrusted workspaces', async () => {
  const { vscode } = createHarness({ trusted: false });
  const ctx = createEditorContext({ vscode });
  await rejectsWith(ctx.attachFiles([fakeUri('file', 'file:///ws/a.ts')]), 'VSCODE_WORKSPACE_UNTRUSTED');
});
