'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createExportsFace, DshExportError } = require('../../src/exportsFace');

const BASE_URL = 'http://127.0.0.1:3210';

function fakeUri(uriString) {
  return {
    scheme: 'file',
    toString() {
      return uriString;
    },
  };
}

function editorContextError(code, message) {
  const err = new Error(message);
  err.name = 'EditorContextError';
  err.bridgeCode = code;
  return err;
}

function isExportError(code) {
  return (err) => Boolean(err) && err instanceof DshExportError && err.name === 'DshExportError' && err.code === code;
}

function makeDeps(overrides = {}) {
  const calls = {
    prompt: [],
    listSessions: [],
    attachFiles: [],
    attachFolder: [],
  };
  const deps = {
    isEnabled: () => true,
    chatClient: {
      async prompt(args) {
        calls.prompt.push(args);
        return { accepted: true, sessionId: args.sessionId };
      },
    },
    resolveSessionId: async () => 'ws-session-1',
    listSessionsFn: async ({ signal }) => {
      calls.listSessions.push({ signal });
      return [
        { sessionId: 's2', updatedAt: 2 },
        { sessionId: 's1', updatedAt: 1 },
      ];
    },
    getBaseUrl: () => BASE_URL,
    editorContext: {
      async attachFiles(uris, options) {
        calls.attachFiles.push({ uris, options });
        return [{ id: 'ctx-file-1', kind: 'file', uri: uris[0].toString() }];
      },
      attachFolder(uri, options) {
        calls.attachFolder.push({ uri, options });
        return { id: 'ctx-folder-1', kind: 'folder', uri: uri.toString() };
      },
    },
    vscode: {
      Uri: {
        parse(value) {
          return fakeUri(value);
        },
        isUri(value) {
          return Boolean(
            value
            && typeof value === 'object'
            && typeof value.toString === 'function'
            && value.scheme !== undefined
          );
        },
      },
    },
    ...overrides,
  };
  return { deps, calls };
}

test('createExportsFace accepts the real vscode.Uri class form (statics on a function)', () => {
  // The real vscode.Uri is a class: typeof 'function', with parse/isUri as
  // static members. The face must not reject that container shape.
  const { deps } = makeDeps();
  const UriClass = function Uri(value) {
    this.scheme = value.startsWith('file:') ? 'file' : 'other';
    this.toString = () => value;
  };
  UriClass.parse = (value) => new UriClass(value);
  UriClass.isUri = (value) => Boolean(value && typeof value.toString === 'function');
  deps.vscode = { Uri: UriClass };
  const face = createExportsFace(deps);
  assert.equal(face.version, '1');
});

test('createExportsFace returns a frozen v1 face with ask, listSessions, addContext', () => {
  const { deps } = makeDeps();
  const face = createExportsFace(deps);

  assert.equal(face.version, '1');
  assert.equal(typeof face.ask, 'function');
  assert.equal(typeof face.listSessions, 'function');
  assert.equal(typeof face.addContext, 'function');
  assert.equal(Object.isFrozen(face), true);
});

test('feature off: methods still exist and each call rejects with DSH_EXPORT_DISABLED', async () => {
  const { deps } = makeDeps({ isEnabled: () => false });
  const face = createExportsFace(deps);

  assert.equal(typeof face.ask, 'function');
  assert.equal(typeof face.listSessions, 'function');
  assert.equal(typeof face.addContext, 'function');

  const pending = [
    face.ask('hello'),
    face.listSessions(),
    face.addContext('file:///ws/a.ts'),
  ];
  for (const operation of pending) {
    await assert.rejects(
      operation,
      (err) => isExportError('DSH_EXPORT_DISABLED')(err)
        && /enable dsh\.features\.exports in settings/.test(err.message)
    );
  }
});

test('disabled message is localized through the injected loc helper', async () => {
  const { deps } = makeDeps({
    isEnabled: () => false,
    loc: (template) => `[i18n] ${template}`,
  });
  const face = createExportsFace(deps);

  await assert.rejects(
    face.ask('hello'),
    (err) => err.code === 'DSH_EXPORT_DISABLED'
      && err.message === '[i18n] DSH export is disabled; enable dsh.features.exports in settings'
  );
});

test('ask rejects empty, non-string, and overlong prompts', async () => {
  const { deps } = makeDeps();
  const face = createExportsFace(deps);

  await assert.rejects(face.ask(''), isExportError('DSH_EXPORT_INVALID_PROMPT'));
  await assert.rejects(face.ask(42), isExportError('DSH_EXPORT_INVALID_PROMPT'));
  await assert.rejects(face.ask('a'.repeat(100001)), isExportError('DSH_EXPORT_INVALID_PROMPT'));
});

test('ask accepts a prompt of exactly 100000 characters', async () => {
  const { deps } = makeDeps();
  const face = createExportsFace(deps);

  const result = await face.ask('a'.repeat(100000));
  assert.deepEqual(result, { accepted: true, sessionId: 'ws-session-1' });
});

test('ask rejects non-string or empty explicit sessionId', async () => {
  const { deps } = makeDeps();
  const face = createExportsFace(deps);

  await assert.rejects(face.ask('hello', { sessionId: '' }), isExportError('DSH_EXPORT_INVALID_PROMPT'));
  await assert.rejects(face.ask('hello', { sessionId: 42 }), isExportError('DSH_EXPORT_INVALID_PROMPT'));
});

test('ask rejects modes other than queue or steer', async () => {
  const { deps } = makeDeps();
  const face = createExportsFace(deps);

  await assert.rejects(face.ask('hello', { mode: 'fast' }), isExportError('DSH_EXPORT_INVALID_PROMPT'));
});

test('ask rejects with DSH_EXPORT_NO_SERVER when getBaseUrl returns empty', async () => {
  const { deps } = makeDeps({ getBaseUrl: () => '' });
  const face = createExportsFace(deps);

  await assert.rejects(face.ask('hello'), isExportError('DSH_EXPORT_NO_SERVER'));
});

test('ask resolves the workspace session when sessionId is omitted', async () => {
  const { deps, calls } = makeDeps();
  const face = createExportsFace(deps);

  const result = await face.ask('hello');

  assert.deepEqual(result, { accepted: true, sessionId: 'ws-session-1' });
  assert.equal(calls.prompt.length, 1);
  assert.deepEqual(calls.prompt[0], {
    sessionId: 'ws-session-1',
    content: 'hello',
    mode: 'queue',
    signal: undefined,
  });
});

test('ask uses the explicit sessionId and mode without resolving', async () => {
  let resolveCalls = 0;
  const { deps, calls } = makeDeps({
    resolveSessionId: async () => {
      resolveCalls += 1;
      return 'should-not-be-used';
    },
  });
  const face = createExportsFace(deps);

  const result = await face.ask('hello', { sessionId: 'explicit-1', mode: 'steer' });

  assert.equal(resolveCalls, 0);
  assert.deepEqual(result, { accepted: true, sessionId: 'explicit-1' });
  assert.deepEqual(calls.prompt[0], {
    sessionId: 'explicit-1',
    content: 'hello',
    mode: 'steer',
    signal: undefined,
  });
});

test('ask forwards opts.signal to chatClient.prompt', async () => {
  const controller = new AbortController();
  const { deps, calls } = makeDeps();
  const face = createExportsFace(deps);

  await face.ask('hello', { signal: controller.signal });

  assert.equal(calls.prompt.length, 1);
  assert.equal(calls.prompt[0].signal, controller.signal);
});

test('ask lets resolveSessionId errors propagate unchanged', async () => {
  const sentinel = new Error('workspace session resolve failed');
  const { deps } = makeDeps({
    resolveSessionId: async () => {
      throw sentinel;
    },
  });
  const face = createExportsFace(deps);

  await assert.rejects(face.ask('hello'), (err) => err === sentinel);
});

test('ask lets chatClient.prompt errors propagate unchanged', async () => {
  const sentinel = new Error('session api down');
  sentinel.code = 'DSH_SESSION_API_UNAVAILABLE';
  const { deps } = makeDeps({
    chatClient: {
      async prompt() {
        throw sentinel;
      },
    },
  });
  const face = createExportsFace(deps);

  await assert.rejects(face.ask('hello'), (err) => err === sentinel);
});

test('listSessions rejects with DSH_EXPORT_NO_SERVER when getBaseUrl is null', async () => {
  const { deps } = makeDeps({ getBaseUrl: () => null });
  const face = createExportsFace(deps);

  await assert.rejects(face.listSessions(), isExportError('DSH_EXPORT_NO_SERVER'));
});

test('listSessions forwards signal and returns the listSessionsFn result', async () => {
  const controller = new AbortController();
  const sessions = [
    { sessionId: 's2', updatedAt: 2 },
    { sessionId: 's1', updatedAt: 1 },
  ];
  const { deps, calls } = makeDeps({
    listSessionsFn: async ({ signal }) => {
      calls.listSessions.push({ signal });
      return sessions;
    },
  });
  const face = createExportsFace(deps);

  const result = await face.listSessions({ signal: controller.signal });

  assert.equal(result, sessions);
  assert.equal(calls.listSessions.length, 1);
  assert.equal(calls.listSessions[0].signal, controller.signal);
});

test('addContext parses a file URI string and attaches it as a file', async () => {
  const { deps, calls } = makeDeps();
  const face = createExportsFace(deps);

  const result = await face.addContext('file:///ws/a.ts');

  assert.deepEqual(result, { id: 'ctx-file-1', kind: 'file', uri: 'file:///ws/a.ts' });
  assert.equal(calls.attachFiles.length, 1);
  assert.equal(calls.attachFolder.length, 0);
  assert.equal(calls.attachFiles[0].uris.length, 1);
  assert.equal(calls.attachFiles[0].uris[0].toString(), 'file:///ws/a.ts');
  assert.deepEqual(calls.attachFiles[0].options, { range: undefined });
});

test('addContext accepts a vscode.Uri object and forwards it untouched', async () => {
  const uri = fakeUri('file:///ws/b.ts');
  const { deps, calls } = makeDeps();
  const face = createExportsFace(deps);

  const result = await face.addContext(uri);

  assert.deepEqual(result, { id: 'ctx-file-1', kind: 'file', uri: 'file:///ws/b.ts' });
  assert.equal(calls.attachFiles[0].uris[0], uri);
});

test('addContext rejects non-file scheme URI strings', async () => {
  const { deps } = makeDeps({
    vscode: {
      Uri: {
        parse(value) {
          return { scheme: 'http', toString: () => value };
        },
        isUri() {
          return false;
        },
      },
    },
  });
  const face = createExportsFace(deps);

  await assert.rejects(face.addContext('http://example.com/a'), isExportError('DSH_EXPORT_INVALID_URI'));
});

test('addContext maps Uri.parse failures to DSH_EXPORT_INVALID_URI', async () => {
  const { deps } = makeDeps({
    vscode: {
      Uri: {
        parse() {
          throw new Error('bad uri');
        },
        isUri() {
          return false;
        },
      },
    },
  });
  const face = createExportsFace(deps);

  await assert.rejects(face.addContext('::::'), isExportError('DSH_EXPORT_INVALID_URI'));
});

test('addContext rejects objects that are not vscode.Uri', async () => {
  const { deps } = makeDeps();
  const face = createExportsFace(deps);

  await assert.rejects(face.addContext({ not: 'a uri' }), isExportError('DSH_EXPORT_INVALID_URI'));
});

test('addContext rejects Uri objects with a non-file scheme', async () => {
  const uri = { scheme: 'http', toString: () => 'http://example.com/a' };
  const { deps } = makeDeps();
  const face = createExportsFace(deps);

  await assert.rejects(face.addContext(uri), isExportError('DSH_EXPORT_INVALID_URI'));
});

test('addContext routes trailing-slash URIs to attachFolder', async () => {
  const { deps, calls } = makeDeps();
  const face = createExportsFace(deps);

  const result = await face.addContext('file:///ws/folder/');

  assert.deepEqual(result, { id: 'ctx-folder-1', kind: 'folder', uri: 'file:///ws/folder/' });
  assert.equal(calls.attachFiles.length, 0);
  assert.equal(calls.attachFolder.length, 1);
  assert.equal(calls.attachFolder[0].uri.toString(), 'file:///ws/folder/');
});

test('addContext passes a valid range through to attachFiles', async () => {
  const range = { start: { line: 1, character: 2 }, end: { line: 3, character: 4 } };
  const { deps, calls } = makeDeps();
  const face = createExportsFace(deps);

  await face.addContext('file:///ws/a.ts', range);

  assert.deepEqual(calls.attachFiles[0].options, { range });
});

test('addContext rejects malformed ranges with DSH_EXPORT_INVALID_URI', async () => {
  const { deps } = makeDeps();
  const face = createExportsFace(deps);

  const badRanges = [
    null,
    { start: { line: 0, character: 0 } },
    { end: { line: 0, character: 0 } },
    { start: { line: -1, character: 0 }, end: { line: 0, character: 0 } },
    { start: { line: 0, character: 0.5 }, end: { line: 0, character: 1 } },
    { start: { line: '0', character: 0 }, end: { line: 0, character: 1 } },
  ];
  for (const range of badRanges) {
    await assert.rejects(face.addContext('file:///ws/a.ts', range), isExportError('DSH_EXPORT_INVALID_URI'));
  }
});

test('addContext maps VSCODE_URI_OUTSIDE_WORKSPACE to DSH_EXPORT_OUTSIDE_WORKSPACE', async () => {
  const outside = editorContextError(
    'VSCODE_URI_OUTSIDE_WORKSPACE',
    'URI is outside the workspace: file:///ws/a.ts'
  );
  const { deps } = makeDeps({
    editorContext: {
      async attachFiles() {
        throw outside;
      },
      attachFolder() {
        throw outside;
      },
    },
  });
  const face = createExportsFace(deps);

  await assert.rejects(
    face.addContext('file:///ws/a.ts'),
    (err) => err instanceof DshExportError
      && err.name === 'DshExportError'
      && err.code === 'DSH_EXPORT_OUTSIDE_WORKSPACE'
      && err.message === outside.message
  );
});

test('addContext maps attachFolder outside-workspace errors too', async () => {
  const outside = editorContextError(
    'VSCODE_URI_OUTSIDE_WORKSPACE',
    'URI is outside the workspace: file:///outside/'
  );
  const { deps } = makeDeps({
    editorContext: {
      async attachFiles() {
        throw outside;
      },
      attachFolder() {
        throw outside;
      },
    },
  });
  const face = createExportsFace(deps);

  await assert.rejects(
    face.addContext('file:///outside/'),
    (err) => err.code === 'DSH_EXPORT_OUTSIDE_WORKSPACE' && err.message === outside.message
  );
});

test('addContext maps TOO_LARGE bridge codes to DSH_EXPORT_TOO_LARGE', async () => {
  const tooLarge = editorContextError(
    'VSCODE_ATTACHMENT_TOO_LARGE',
    'Editor attachment exceeds the 1048576 byte limit'
  );
  const { deps } = makeDeps({
    editorContext: {
      async attachFiles() {
        throw tooLarge;
      },
      attachFolder() {
        throw tooLarge;
      },
    },
  });
  const face = createExportsFace(deps);

  await assert.rejects(
    face.addContext('file:///ws/a.ts'),
    (err) => err.code === 'DSH_EXPORT_TOO_LARGE' && err.message === tooLarge.message
  );
});

test('addContext maps budget-limit messages to DSH_EXPORT_TOO_LARGE', async () => {
  const tooLarge = editorContextError(
    'VSCODE_ATTACHMENT_LIMIT',
    'Editor attachment exceeds the 1048576 byte limit'
  );
  const { deps } = makeDeps({
    editorContext: {
      async attachFiles() {
        throw tooLarge;
      },
      attachFolder() {
        throw tooLarge;
      },
    },
  });
  const face = createExportsFace(deps);

  await assert.rejects(
    face.addContext('file:///ws/a.ts'),
    (err) => err.code === 'DSH_EXPORT_TOO_LARGE' && err.message === tooLarge.message
  );
});

test('addContext rethrows unrelated EditorContextError values unchanged', async () => {
  const other = editorContextError('VSCODE_WORKSPACE_UNTRUSTED', 'VS Code workspace is not trusted');
  const { deps } = makeDeps({
    editorContext: {
      async attachFiles() {
        throw other;
      },
      attachFolder() {
        throw other;
      },
    },
  });
  const face = createExportsFace(deps);

  await assert.rejects(face.addContext('file:///ws/a.ts'), (err) => err === other);
});

test('addContext rethrows plain non-EditorContextError errors unchanged', async () => {
  const plain = new Error('plain boom');
  const { deps } = makeDeps({
    editorContext: {
      async attachFiles() {
        throw plain;
      },
      attachFolder() {
        throw plain;
      },
    },
  });
  const face = createExportsFace(deps);

  await assert.rejects(face.addContext('file:///ws/a.ts'), (err) => err === plain);
});
