'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createCommandShell, NullAdapter } = require('../../src/commands/shell');

function fakeVscode(options = {}) {
  const commands = new Map();
  const infoMessages = [];
  const api = {
    ...(options.l10n ? { l10n: options.l10n } : {}),
    commands: {
      registerCommand(id, handler) {
        commands.set(id, handler);
        return { dispose() {} };
      },
    },
    window: {
      async showInformationMessage(message) {
        infoMessages.push(message);
      },
    },
  };
  return { api, commands, infoMessages };
}

test('createCommandShell requires a router with get()', () => {
  assert.throws(() => createCommandShell(), TypeError);
  assert.throws(() => createCommandShell({ router: {} }), TypeError);
  assert.throws(() => createCommandShell({ router: { get: 'not-a-function' } }), TypeError);
});

test('shell shows capability unavailable and skips run for NullAdapter', async () => {
  const { api, commands, infoMessages } = fakeVscode();
  let runCalls = 0;
  const shell = createCommandShell({ router: { get: () => NullAdapter } });
  const disposable = shell.register(api, 'dsh.test', 'cap.test', () => { runCalls += 1; });

  assert.strictEqual(typeof disposable.dispose, 'function');
  const result = await commands.get('dsh.test')();
  assert.strictEqual(runCalls, 0);
  assert.deepStrictEqual(infoMessages, ['Capability unavailable']);
  assert.strictEqual(result, undefined);
});

test('shell treats null and undefined as unavailable', async () => {
  for (const missing of [null, undefined]) {
    const { api, commands, infoMessages } = fakeVscode();
    let runCalls = 0;
    const shell = createCommandShell({ router: { get: () => missing } });
    shell.register(api, 'dsh.test', 'cap.test', () => { runCalls += 1; });
    await commands.get('dsh.test')();
    assert.strictEqual(runCalls, 0);
    assert.deepStrictEqual(infoMessages, ['Capability unavailable']);
  }
});

test('shell runs the command body when a real adapter is resolved', async () => {
  const adapter = { id: 'fake-adapter' };
  const { api, commands, infoMessages } = fakeVscode();
  const calls = [];
  const shell = createCommandShell({
    router: {
      get(capabilityId) {
        assert.strictEqual(capabilityId, 'cap.real');
        return adapter;
      },
    },
  });

  shell.register(api, 'dsh.real', 'cap.real', (...args) => {
    calls.push(args);
    return 'ok';
  });

  const result = await commands.get('dsh.real')('a', 1);
  assert.deepStrictEqual(calls, [['a', 1]]);
  assert.strictEqual(result, 'ok');
  assert.deepStrictEqual(infoMessages, []);
});

test('shell uses vscode.l10n when available', async () => {
  const { api, commands, infoMessages } = fakeVscode({
    l10n: { t: (template) => `localized:${template}` },
  });
  let runCalls = 0;
  const shell = createCommandShell({ router: { get: () => NullAdapter } });
  shell.register(api, 'dsh.l10n', 'cap.l10n', () => { runCalls += 1; });

  await commands.get('dsh.l10n')();
  assert.strictEqual(runCalls, 0);
  assert.deepStrictEqual(infoMessages, ['localized:Capability unavailable']);
});
