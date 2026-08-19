'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createLmRoute,
  estimateTokenCount,
  mapDshModels,
  parseSseBuffer,
} = require('../../src/lmRoute');

class FakeLanguageModelError extends Error {
  static NoPermissions(message) {
    const error = new FakeLanguageModelError(message);
    error.code = 'NoPermissions';
    return error;
  }

  static Blocked(message) {
    const error = new FakeLanguageModelError(message);
    error.code = 'Blocked';
    return error;
  }

  static NotFound(message) {
    const error = new FakeLanguageModelError(message);
    error.code = 'NotFound';
    return error;
  }
}

class FakeLanguageModelTextPart {
  constructor(text) {
    this.text = text;
  }
}

function fakeVscode() {
  const registrations = [];
  return {
    registrations,
    LanguageModelError: FakeLanguageModelError,
    LanguageModelTextPart: FakeLanguageModelTextPart,
    lm: {
      registerLanguageModelChatProvider(vendor, provider) {
        const record = { vendor, provider, disposed: false };
        registrations.push(record);
        return {
          dispose() {
            record.disposed = true;
          },
        };
      },
    },
  };
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

function streamResponse(lines) {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        for (const line of lines) controller.enqueue(encoder.encode(line));
        controller.close();
      },
    }),
  };
}

test('mapDshModels prefixes ids with dsh- and carries routing metadata', () => {
  const models = mapDshModels([
    { id: 'deepseek-chat', provider: 'deepseek-official', name: 'DeepSeek Chat', family: 'deepseek', version: '1.0', maxInputTokens: 64000, maxOutputTokens: 8192, toolCalling: true },
  ]);
  assert.strictEqual(models.length, 1);
  assert.strictEqual(models[0].id, 'dsh-deepseek-chat');
  assert.strictEqual(models[0].dsh.model, 'deepseek-chat');
  assert.strictEqual(models[0].dsh.provider, 'deepseek-official');
  assert.strictEqual(models[0].capabilities.toolCalling, true);
});

test('estimateTokenCount is finite, positive and char-based for non-empty text', () => {
  assert.strictEqual(estimateTokenCount(''), 0);
  assert.strictEqual(estimateTokenCount('abcd'), 1);
  assert.strictEqual(estimateTokenCount('12345678'), 2);
  assert.strictEqual(estimateTokenCount({ role: 'user', content: [{ text: 'abcdefgh' }] }), 2);
});

test('parseSseBuffer extracts data: text deltas and keeps incomplete tails', () => {
  const deltas = [];
  const remaining = parseSseBuffer('data: {"text":"he"}\n\n', deltas);
  assert.deepStrictEqual(deltas, ['he']);
  assert.strictEqual(remaining, '');
  const deltas2 = [];
  parseSseBuffer('event: ping\ndata: [DONE]\ndata: {"text":"llo"}', deltas2, true);
  assert.deepStrictEqual(deltas2, ['llo']);
});

test('createLmRoute registers a dsh provider and serves fixed cached models', async () => {
  const vscode = fakeVscode();
  const fetchCalls = [];
  const route = createLmRoute({
    vscode,
    baseUrlProvider: () => 'http://127.0.0.1:3080',
    token: 'tok',
    mode: 'fixed',
    fetchImpl: async (url) => {
      fetchCalls.push(url);
      return jsonResponse({ models: [{ id: 'm1', provider: 'p1' }] });
    },
  });
  assert.strictEqual(vscode.registrations.length, 1);
  assert.strictEqual(vscode.registrations[0].vendor, 'dsh');
  const models = await vscode.registrations[0].provider.provideLanguageModelChatInformation({ silent: true }, {});
  assert.strictEqual(models[0].id, 'dsh-m1');
  const cached = await vscode.registrations[0].provider.provideLanguageModelChatInformation({ silent: true }, {});
  assert.strictEqual(cached, models, 'fixed mode must cache the first model list');
  assert.strictEqual(fetchCalls.length, 1);
  route.disposable.dispose();
  assert.strictEqual(vscode.registrations[0].disposed, true);
});

test('provideLanguageModelChatResponse streams SSE text deltas through progress', async () => {
  const vscode = fakeVscode();
  let chatBody = null;
  const route = createLmRoute({
    vscode,
    baseUrlProvider: () => 'http://127.0.0.1:3080',
    token: 'tok',
    mode: 'off',
    fetchImpl: async (url, options) => {
      if (url.endsWith('/api/lm/chat')) {
        chatBody = JSON.parse(options.body);
        return streamResponse([
          'data: {"text":"hel"}\n\n',
          'data: {"text":"lo"}\n\n',
          'data: [DONE]\n\n',
        ]);
      }
      return jsonResponse({ models: [] });
    },
  });
  const model = { id: 'dsh-m1', dsh: { provider: 'p1', model: 'm1' } };
  const parts = [];
  await vscode.registrations[0].provider.provideLanguageModelChatResponse(
    model,
    [{ role: 'user', content: 'hi' }],
    { modelOptions: { maxTokens: 10, temperature: 0.5 } },
    { report(part) { parts.push(part); } },
    {},
  );
  assert.deepStrictEqual(parts.map((part) => part.text), ['hel', 'lo']);
  assert.strictEqual(chatBody.provider, 'p1');
  assert.strictEqual(chatBody.model, 'm1');
  assert.strictEqual(chatBody.maxTokens, 10);
  assert.strictEqual(chatBody.temperature, 0.5);
  route.disposable.dispose();
});

test('provideLanguageModelChatResponse maps HTTP errors to LanguageModelError codes', async () => {
  const vscode = fakeVscode();
  const route = createLmRoute({
    vscode,
    baseUrlProvider: () => 'http://127.0.0.1:3080',
    token: 'tok',
    mode: 'off',
    fetchImpl: async () => ({ ok: false, status: 401 }),
  });
  const model = { id: 'dsh-m1', dsh: { provider: 'p1', model: 'm1' } };
  await assert.rejects(
    vscode.registrations[0].provider.provideLanguageModelChatResponse(
      model,
      [{ role: 'user', content: 'hi' }],
      {},
      { report() {} },
      {},
    ),
    (error) => error && error.code === 'NoPermissions',
  );
  route.disposable.dispose();
});

test('provideTokenCount delegates to the estimator', async () => {
  const vscode = fakeVscode();
  const route = createLmRoute({
    vscode,
    baseUrlProvider: () => 'http://127.0.0.1:3080',
    token: 'tok',
    mode: 'off',
    fetchImpl: async () => jsonResponse({ models: [] }),
  });
  const count = await vscode.registrations[0].provider.provideTokenCount({}, 'abcdefgh', {});
  assert.strictEqual(count, 2);
  route.disposable.dispose();
});

test('createLmRoute rejects when vscode.lm is unavailable', () => {
  assert.throws(
    () => createLmRoute({ vscode: {}, baseUrlProvider: () => '', token: 'x', mode: 'off' }),
    /registerLanguageModelChatProvider/,
  );
});
