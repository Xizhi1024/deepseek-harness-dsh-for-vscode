'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { statusPage, framePage, withVscodeEmbedMode } = require('../src/webviewHtml');

test('framePage allows clipboard-write on the embedded iframe', () => {
  const html = framePage({ url: 'http://127.0.0.1:3080' });
  assert.match(html, /<iframe[^>]*allow="clipboard-write"/);
});

test('statusPage escapes user-provided script content', () => {
  const html = statusPage({
    title: '<script>alert(1)</script>',
    detail: '<img src=x onerror=alert(1)>',
  });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('withVscodeEmbedMode adds dsh_embed and a valid dsh_session', () => {
  const url = withVscodeEmbedMode('http://127.0.0.1:3080/', 'abc-123');
  const parsed = new URL(url);
  assert.strictEqual(parsed.searchParams.get('dsh_embed'), 'vscode');
  assert.strictEqual(parsed.searchParams.get('dsh_session'), 'abc-123');
});

test('withVscodeEmbedMode ignores over-long and NUL session ids', () => {
  const overLong = 'x'.repeat(201);
  assert.strictEqual(
    new URL(withVscodeEmbedMode('http://127.0.0.1:3080/', overLong)).searchParams.get('dsh_session'),
    null
  );
  assert.strictEqual(
    new URL(withVscodeEmbedMode('http://127.0.0.1:3080/', 'bad\0id')).searchParams.get('dsh_session'),
    null
  );
});
