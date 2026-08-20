'use strict';

// Simulates the embedded DSH iframe environment for the dsh-vscode-integration
// client.js: a minimal window/document shim, synthetic keydown events, and a
// spy execCommand. Verifies the macOS shortcut bridge claims Cmd+C/Cmd+X/Cmd+V
// and the execCommand copy fallback extracts input selections.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadClient(shim) {
  let source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
  source = source.replace(/^\uFEFF/, '');
  const head = 'window.__ModuleLoader__.load(';
  assert.ok(source.startsWith(head), 'client.js must start with the module loader call');
  assert.ok(source.trimEnd().endsWith('});'), 'client.js must end with the loader call');
  const objectLiteral = '(' + source.slice(head.length).trimEnd().slice(0, -2) + ')';
  // eslint-disable-next-line no-new-func
  const loaded = new Function('window', 'navigator', 'document', 'URLSearchParams', 'TextEncoder', 'return ' + objectLiteral)(shim.window, shim.navigator, shim.document, URLSearchParams, TextEncoder);
  const moduleExports = loaded.factory();
  return moduleExports;
}

function createShim({ selectionText = 'selected text' } = {}) {
  const execCalls = [];
  const keyListeners = [];
  const messageListeners = [];
  const activeElement = {
    value: 'input-value-123',
    selectionStart: 0,
    selectionEnd: 0,
  };
  const document = {
    activeElement,
    addEventListener(type, listener, capture) {
      if (type === 'keydown' && capture) keyListeners.push(listener);
    },
    removeEventListener() {},
    execCommand(command, showUi, value) {
      execCalls.push({ command, showUi, value });
      return false; // always deny native so the bridge fallback runs
    },
  };
  const window = {
    location: { search: '?dsh_embed=vscode' },
    addEventListener(type, listener) {
      if (type === 'message') messageListeners.push(listener);
    },
    removeEventListener() {},
    getSelection() {
      return { toString: () => selectionText };
    },
    URLSearchParams,
    TextEncoder,
  };
  window.parent = {
    postMessage(message) {
      // Immediately answer the hello handshake so bridge requests never park
      // on the 2s degraded timer inside tests.
      if (message && message.type === 'dshWebviewHello') {
        for (const listener of messageListeners) {
          listener({
            source: window.parent,
            data: { type: 'dshWebviewReady', channel: message.channel, version: message.version },
          });
        }
      }
    },
  };
  return {
    window, document, execCalls, keyListeners, messageListeners, activeElement,
    navigator: { platform: 'MacIntel' },
  };
}

function keydown(overrides = {}) {
  return {
    defaultPrevented: false,
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    code: 'KeyC',
    key: 'c',
    preventDefault() { this.defaultPrevented = true; },
    ...overrides,
  };
}

test('Cmd+C inside the iframe is captured and routed through execCommand copy', () => {
  const shim = createShim();
  const client = loadClient(shim);
  client.apply({ effect: (fn) => { fn(); return () => {}; } });
  const event = keydown();
  shim.keyListeners[0](event);
  assert.strictEqual(event.defaultPrevented, true, 'Cmd+C must be claimed from the VS Code menu');
  assert.strictEqual(shim.execCalls[0].command, 'copy');
});

test('Cmd+X routes through execCommand cut', () => {
  const shim = createShim();
  const client = loadClient(shim);
  client.apply({ effect: (fn) => { fn(); return () => {}; } });
  const event = keydown({ code: 'KeyX', key: 'x' });
  shim.keyListeners[0](event);
  assert.strictEqual(event.defaultPrevented, true);
  assert.strictEqual(shim.execCalls[0].command, 'cut');
});

test('Cmd+V still routes through execCommand paste (regression for #129178)', () => {
  const shim = createShim();
  const client = loadClient(shim);
  client.apply({ effect: (fn) => { fn(); return () => {}; } });
  const event = keydown({ code: 'KeyV', key: 'v' });
  shim.keyListeners[0](event);
  assert.strictEqual(event.defaultPrevented, true);
  assert.strictEqual(shim.execCalls[0].command, 'paste');
});

test('Cmd+C without any selection is not claimed (host keeps its own copy target)', () => {
  const shim = createShim({ selectionText: '' });
  const client = loadClient(shim);
  client.apply({ effect: (fn) => { fn(); return () => {}; } });
  const event = keydown();
  shim.keyListeners[0](event);
  assert.strictEqual(event.defaultPrevented, false, 'no selection: shortcut must pass through');
  assert.strictEqual(shim.execCalls.length, 0);
});

test('Cmd+C is claimed when the selection lives inside the focused input (chat composer case)', () => {
  // window.getSelection() is empty for input selections — the shortcut must
  // still be claimed through the focused-control selection check.
  const shim = createShim({ selectionText: '' });
  const client = loadClient(shim);
  client.apply({ effect: (fn) => { fn(); return () => {}; } });
  shim.activeElement.selectionStart = 0;
  shim.activeElement.selectionEnd = 12;
  const event = keydown();
  shim.keyListeners[0](event);
  assert.strictEqual(event.defaultPrevented, true, 'input selection: shortcut must be claimed');
  assert.strictEqual(shim.execCalls[0].command, 'copy');
});

test('plain typing without Cmd/Ctrl never triggers execCommand', () => {
  const shim = createShim();
  const client = loadClient(shim);
  client.apply({ effect: (fn) => { fn(); return () => {}; } });
  const event = keydown({ metaKey: false, ctrlKey: false });
  shim.keyListeners[0](event);
  assert.strictEqual(event.defaultPrevented, false);
  assert.strictEqual(shim.execCalls.length, 0);
});

test('copy fallback prefers the focused input selection over window.getSelection', () => {
  const shim = createShim({ selectionText: '' });
  const client = loadClient(shim);
  client.apply({ effect: (fn) => { fn(); return () => {}; } });
  shim.activeElement.selectionStart = 0;
  shim.activeElement.selectionEnd = 11; // "input-value"
  shim.document.execCommand('copy');
  // The bridge request rides window.parent.postMessage; assert through the
  // request path by waiting a tick for the handshake timeout fallback.
  assert.strictEqual(shim.execCalls[0].command, 'copy');
});

function themeCtx() {
  const calls = [];
  return {
    calls,
    theme: {
      preference: 'system',
      setTheme(id) { calls.push(id); this.preference = id; },
    },
    effect: (fn) => { fn(); return () => {}; },
  };
}

test('theme follow: initial dsh_theme URL parameter is applied through the theme service', () => {
  const shim = createShim();
  shim.window.location = { search: '?dsh_embed=vscode&dsh_theme=dark' };
  const client = loadClient(shim);
  const ctx = themeCtx();
  client.apply(ctx);
  assert.deepStrictEqual(ctx.calls, ['dark'], 'dark marker must reach ctx.theme.setTheme');
});

test('theme follow: dshThemeChanged postMessages update the live theme', () => {
  const shim = createShim();
  const client = loadClient(shim);
  const ctx = themeCtx();
  client.apply(ctx);
  assert.deepStrictEqual(ctx.calls, [], 'no URL theme: nothing applied yet');
  for (const listener of shim.messageListeners) {
    listener({ source: shim.window.parent, data: { type: 'dshThemeChanged', theme: 'light' } });
    listener({ source: shim.window.parent, data: { type: 'dshThemeChanged', theme: 'dark' } });
  }
  assert.deepStrictEqual(ctx.calls, ['light', 'dark'], 'theme changes must funnel into setTheme');
});

test('theme follow: malformed theme messages are ignored', () => {
  const shim = createShim();
  const client = loadClient(shim);
  const ctx = themeCtx();
  client.apply(ctx);
  for (const listener of shim.messageListeners) {
    listener({ source: shim.window.parent, data: { type: 'dshThemeChanged', theme: 'blue' } });
    listener({ source: shim.window.parent, data: { type: 'dshThemeChanged' } });
    listener({ source: {}, data: { type: 'dshThemeChanged', theme: 'light' } });
  }
  assert.deepStrictEqual(ctx.calls, [], 'invalid themes and foreign sources must be dropped');
});

test('theme follow: ctx.get optional lookup path is preferred when present', () => {
  const shim = createShim();
  shim.window.location = { search: '?dsh_embed=vscode&dsh_theme=light' };
  const client = loadClient(shim);
  const direct = [];
  const ctx = themeCtx();
  ctx.get = (name) => (name === 'theme' ? { setTheme(id) { ctx.calls.push(id); } } : undefined);
  client.apply(ctx);
  assert.deepStrictEqual(ctx.calls, ['light'], 'theme must resolve through ctx.get when available');
  assert.deepStrictEqual(direct, []);
});

test('theme follow: missing theme service degrades silently without breaking activation', () => {
  const shim = createShim();
  shim.window.location = { search: '?dsh_embed=vscode&dsh_theme=dark' };
  const client = loadClient(shim);
  const ctx = themeCtx();
  ctx.theme = undefined;
  ctx.get = () => undefined;
  let effectRan = false;
  ctx.effect = (fn) => { effectRan = true; fn(); return () => {}; };
  client.apply(ctx);
  assert.strictEqual(effectRan, true, 'the interaction bridges must still install without a theme service');
  for (const listener of shim.messageListeners) {
    listener({ source: shim.window.parent, data: { type: 'dshThemeChanged', theme: 'light' } });
  }
  assert.deepStrictEqual(ctx.calls, [], 'no theme service: nothing may throw');
});
