'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createSessionTitler, deriveSessionTitle } = require('../../src/sessionTitler');

test('deriveSessionTitle takes the first line, collapses whitespace and trims', () => {
  assert.strictEqual(deriveSessionTitle('Fix the login bug\n\nstack trace'), 'Fix the login bug');
  assert.strictEqual(deriveSessionTitle('  spaced   out   words  '), 'spaced out words');
  assert.strictEqual(deriveSessionTitle('tab\tseparated'), 'tab separated');
});

test('deriveSessionTitle strips control characters and returns empty for underivable prompts', () => {
  assert.strictEqual(deriveSessionTitle('\u0007beep\u001b[0m]'), 'beep [0m]');
  assert.strictEqual(deriveSessionTitle(''), '');
  assert.strictEqual(deriveSessionTitle('\n\n  \t '), '');
  assert.strictEqual(deriveSessionTitle(null), '');
  assert.strictEqual(deriveSessionTitle(42), '');
});

test('deriveSessionTitle caps at 60 code points without splitting surrogate pairs', () => {
  const base = 'a'.repeat(59);
  const emoji = '\u{1F600}';
  const title = deriveSessionTitle(base + emoji + 'bbbb');
  assert.strictEqual(Array.from(title).length, 60);
  assert.ok(title.endsWith(emoji));
  assert.strictEqual(title, base + emoji);
});

test('createSessionTitler renames once per session and never throws', async () => {
  const calls = [];
  const titleSession = createSessionTitler(async (sessionId, title) => {
    calls.push({ sessionId, title });
    if (calls.length === 1) throw new Error('title-invalid');
  });

  assert.strictEqual(await titleSession('s1', 'First'), false);
  assert.strictEqual(await titleSession('s1', 'Second'), false);
  assert.strictEqual(await titleSession('s2', 'Second'), true);
  assert.deepStrictEqual(calls, [
    { sessionId: 's1', title: 'First' },
    { sessionId: 's2', title: 'Second' },
  ]);
});

test('createSessionTitler skips empty session ids and titles', async () => {
  const calls = [];
  const titleSession = createSessionTitler(async (sessionId, title) => {
    calls.push({ sessionId, title });
  });
  assert.strictEqual(await titleSession('', 't'), false);
  assert.strictEqual(await titleSession('s1', ''), false);
  assert.strictEqual(await titleSession(null, 't'), false);
  assert.deepStrictEqual(calls, []);
});

test('createSessionTitler requires a function', () => {
  assert.throws(() => createSessionTitler('nope'), /renameFn must be a function/);
});
