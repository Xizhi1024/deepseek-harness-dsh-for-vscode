'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { statusPage, framePage, withVscodeEmbedMode } = require('../src/webviewHtml');

test('framePage allows clipboard read and write on the embedded iframe', () => {
  const html = framePage({ url: 'http://127.0.0.1:3080' });
  assert.match(html, /<iframe[^>]*allow="clipboard-read; clipboard-write"/);
});

test('framePage includes a CSP meta that permits inline assets and http(s) frames', () => {
  const html = framePage({ url: 'http://127.0.0.1:3080' });
  assert.match(html, /<meta http-equiv="Content-Security-Policy"[^>]*>/);
  assert.ok(html.includes("default-src 'none'"));
  assert.ok(html.includes("script-src 'unsafe-inline'"));
  assert.ok(html.includes("frame-src http: https:"));
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

test('statusPage includes a CSP meta', () => {
  const html = statusPage({ title: 'title', detail: 'detail' });
  assert.match(html, /<meta http-equiv="Content-Security-Policy"[^>]*>/);
  assert.ok(html.includes("default-src 'none'"));
  assert.ok(html.includes("style-src 'unsafe-inline'"));
  assert.ok(html.includes("frame-src http: https:"));
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

test('withVscodeEmbedMode maps invalid/non-http(s) URLs to about:blank', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,<h1>hi</h1>', '//evil.com/path']) {
    const out = withVscodeEmbedMode(bad, 's');
    assert.strictEqual(out, 'about:blank');
    assert.ok(!out.includes('dsh_embed'));
  }
});

test('framePage fallback link and iframe become about:blank for unsafe URLs', () => {
  const html = framePage({ url: 'javascript:alert(1)', openBrowserLabel: 'Open' });
  assert.match(html, /<iframe[^>]*src="about:blank"/);
  assert.match(html, /<a id="fallback-link"[^>]*href="about:blank"/);
});

test('withVscodeEmbedMode accepts http and https URLs and adds markers', () => {
  for (const input of ['http://127.0.0.1:3080/', 'https://example.test/path']) {
    const out = withVscodeEmbedMode(input, 's');
    const parsed = new URL(out);
    assert.strictEqual(parsed.searchParams.get('dsh_embed'), 'vscode');
    assert.strictEqual(parsed.searchParams.get('dsh_session'), 's');
  }
});

test('withVscodeEmbedMode adds dsh_theme only for dark/light and never overwrites existing params', () => {
  for (const theme of ['dark', 'light']) {
    const parsed = new URL(withVscodeEmbedMode('http://127.0.0.1:3080/?a=1', 's', theme));
    assert.strictEqual(parsed.searchParams.get('dsh_embed'), 'vscode');
    assert.strictEqual(parsed.searchParams.get('dsh_theme'), theme);
    assert.strictEqual(parsed.searchParams.get('a'), '1');
  }
  for (const bad of [undefined, null, '', 'highContrast', 'Dark', 2]) {
    const parsed = new URL(withVscodeEmbedMode('http://127.0.0.1:3080/', 's', bad));
    assert.strictEqual(parsed.searchParams.get('dsh_theme'), null);
  }
});

test('framePage embeds dsh_theme in the iframe src when a theme is supplied', () => {
  const html = framePage({ url: 'http://127.0.0.1:3080', theme: 'dark' });
  assert.ok(html.includes('dsh_theme=dark'));
  const noTheme = framePage({ url: 'http://127.0.0.1:3080' });
  assert.ok(!noTheme.includes('dsh_theme='));
});

test('framePage shell forwards dshThemeChanged messages to the DSH iframe without reloading', () => {
  const html = framePage({ url: 'http://127.0.0.1:3080', theme: 'light' });
  assert.ok(html.includes('"dshThemeChanged"'));
  assert.ok(html.includes('message.theme === "dark" || message.theme === "light"'));
  assert.ok(html.includes('frame.contentWindow.postMessage'));
});
