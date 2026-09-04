'use strict';

// Regression tests for the embedded composer Ctrl/Cmd+Enter newline bridge in
// dsh-vscode-integration client.js. Upstream DSH (dffe955ed2) repurposed the
// chord as accelerated submit/steer, which reads as "the composer emptied
// itself" while writing a multi-line reply over an attachment. The bridge
// claims Ctrl/Cmd+Enter on the focused chat composer with a non-empty draft
// and inserts a newline through the DOM input path instead.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadClient(shim) {
  let source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
  source = source.replace(/^﻿/, '');
  const head = 'window.__ModuleLoader__.load(';
  assert.ok(source.startsWith(head), 'client.js must start with the module loader call');
  assert.ok(source.trimEnd().endsWith('});'), 'client.js must end with the loader call');
  const objectLiteral = '(' + source.slice(head.length).trimEnd().slice(0, -2) + ')';
  // eslint-disable-next-line no-new-func
  const loaded = new Function('window', 'navigator', 'document', 'URLSearchParams', 'TextEncoder', 'return ' + objectLiteral)(shim.window, shim.navigator, shim.document, URLSearchParams, TextEncoder);
  const moduleExports = loaded.factory();
  return moduleExports;
}

function createComposerTextarea() {
  const textarea = {
    value: 'draft line',
    selectionStart: 5,
    selectionEnd: 5,
    disabled: false,
    readOnly: false,
    dispatched: [],
    closest(selector) {
      return selector === '[data-composer-card]' ? composerCard : null;
    },
    setRangeText(text, start, end) {
      this.value = this.value.slice(0, start) + text + this.value.slice(end);
      this.selectionStart = start + text.length;
      this.selectionEnd = start + text.length;
    },
    dispatchEvent(event) {
      this.dispatched.push(event);
    },
  };
  const composerCard = {
    querySelector(selector) {
      return selector === 'textarea' ? textarea : null;
    },
  };
  return { textarea, composerCard };
}

function createShim({
  platform = 'Win32',
  execInsertSucceeds = false,
  activeElement = null,
} = {}) {
  const composer = createComposerTextarea();
  const execCalls = [];
  const keyListeners = [];
  const messageListeners = [];
  const document = {
    activeElement: activeElement === null ? composer.textarea : activeElement,
    addEventListener(type, listener, capture) {
      if (type === 'keydown' && capture) keyListeners.push(listener);
    },
    removeEventListener() {},
    execCommand(command, showUi, value) {
      execCalls.push({ command, showUi, value });
      return command === 'insertText' ? execInsertSucceeds : false;
    },
  };
  const window = {
    location: { search: '?dsh_embed=vscode' },
    addEventListener(type, listener) {
      if (type === 'message') messageListeners.push(listener);
    },
    removeEventListener() {},
    getSelection() {
      return { toString: () => '' };
    },
    URLSearchParams,
    TextEncoder,
  };
  window.parent = {
    postMessage(message) {
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
    window, document, execCalls, keyListeners, messageListeners, composer,
    navigator: { platform },
  };
}

function keydown(overrides = {}) {
  return {
    defaultPrevented: false,
    metaKey: false,
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
    key: 'Enter',
    target: null,
    preventDefault() { this.defaultPrevented = true; },
    stopImmediatePropagation() {},
    ...overrides,
  };
}

// Every registered capture keydown listener sees the event; the bridge under
// test is whichever one claims Enter chords. Dispatch like the DOM would.
function press(shim, event) {
  for (const listener of shim.keyListeners) {
    listener(event);
    if (event.defaultPrevented) break;
  }
  return event;
}

function applyClient(shim) {
  const client = loadClient(shim);
  client.apply({ effect: (fn) => { fn(); return () => {}; } });
  return client;
}

test('Ctrl+Enter on the focused composer with a draft is claimed and inserts a newline', () => {
  const shim = createShim({ execInsertSucceeds: true });
  applyClient(shim);
  const event = press(shim, keydown({ target: shim.composer.textarea }));
  assert.strictEqual(event.defaultPrevented, true, 'the chord must be claimed before the DSH submit handler');
  assert.strictEqual(shim.execCalls.filter((call) => call.command === 'insertText').length, 1);
  const call = shim.execCalls.find((entry) => entry.command === 'insertText');
  assert.strictEqual(call.value, '\n', 'insertText must splice exactly one newline');
});

test('Cmd+Enter (macOS chord) is claimed the same way', () => {
  const shim = createShim({ platform: 'MacIntel', execInsertSucceeds: true });
  applyClient(shim);
  const event = press(shim, keydown({ target: shim.composer.textarea, metaKey: true, ctrlKey: false }));
  assert.strictEqual(event.defaultPrevented, true);
  assert.ok(shim.execCalls.some((call) => call.command === 'insertText' && call.value === '\n'));
});

test('plain Enter is not claimed — the DSH submit gesture keeps working', () => {
  const shim = createShim({ execInsertSucceeds: true });
  applyClient(shim);
  const event = press(shim, keydown({ target: shim.composer.textarea, ctrlKey: false, metaKey: false }));
  assert.strictEqual(event.defaultPrevented, false);
  assert.strictEqual(shim.execCalls.length, 0);
});

test('Shift+Enter stays native (unconditional newline) and is not claimed', () => {
  const shim = createShim({ execInsertSucceeds: true });
  applyClient(shim);
  const event = press(shim, keydown({ target: shim.composer.textarea, ctrlKey: false, metaKey: false, shiftKey: true }));
  assert.strictEqual(event.defaultPrevented, false);
  assert.strictEqual(shim.execCalls.length, 0);
});

test('empty draft passes the chord through — the upstream queue-steer gesture survives', () => {
  const shim = createShim({ execInsertSucceeds: true });
  applyClient(shim);
  shim.composer.textarea.value = '';
  const event = press(shim, keydown({ target: shim.composer.textarea }));
  assert.strictEqual(event.defaultPrevented, false, 'nothing to break a line in: let DSH steer the queue');
  assert.strictEqual(shim.execCalls.length, 0);
});

test('textareas outside the composer card are untouched (queue dock, question inputs)', () => {
  const shim = createShim({ execInsertSucceeds: true });
  const otherTextarea = {
    value: 'some other input',
    selectionStart: 0,
    selectionEnd: 0,
    closest() { return null; },
  };
  shim.document.activeElement = otherTextarea;
  applyClient(shim);
  const event = press(shim, keydown({ target: otherTextarea }));
  assert.strictEqual(event.defaultPrevented, false);
  assert.strictEqual(shim.execCalls.length, 0);
});

test('IME-composing Enter belongs to the engine and is never claimed', () => {
  const shim = createShim({ execInsertSucceeds: true });
  applyClient(shim);
  const composing = press(shim, keydown({ target: shim.composer.textarea, isComposing: true }));
  const legacy = press(shim, keydown({ target: shim.composer.textarea, keyCode: 229 }));
  assert.strictEqual(composing.defaultPrevented, false);
  assert.strictEqual(legacy.defaultPrevented, false);
  assert.strictEqual(shim.execCalls.length, 0);
});

test('Alt-modified variants (Ctrl+Alt+Enter) are left for the host', () => {
  const shim = createShim({ execInsertSucceeds: true });
  applyClient(shim);
  const event = press(shim, keydown({ target: shim.composer.textarea, altKey: true }));
  assert.strictEqual(event.defaultPrevented, false);
  assert.strictEqual(shim.execCalls.length, 0);
});

test('execCommand refusal falls back to setRangeText plus a synthetic input event', () => {
  const shim = createShim({ execInsertSucceeds: false });
  applyClient(shim);
  const textarea = shim.composer.textarea;
  const event = press(shim, keydown({ target: textarea }));
  assert.strictEqual(event.defaultPrevented, true);
  assert.strictEqual(textarea.value, 'draft\n line', 'newline spliced at the caret');
  assert.strictEqual(textarea.selectionStart, 6, 'caret moves past the inserted newline');
  assert.strictEqual(textarea.dispatched.length, 1, 'one synthetic input event for the controlled component');
  assert.strictEqual(textarea.dispatched[0].type, 'input');
  assert.strictEqual(textarea.dispatched[0].bubbles, true);
});

test('disabled or read-only composers are skipped', () => {
  const shim = createShim({ execInsertSucceeds: true });
  applyClient(shim);
  shim.composer.textarea.disabled = true;
  const disabled = press(shim, keydown({ target: shim.composer.textarea }));
  shim.composer.textarea.disabled = false;
  shim.composer.textarea.readOnly = true;
  const readOnly = press(shim, keydown({ target: shim.composer.textarea }));
  assert.strictEqual(disabled.defaultPrevented, false);
  assert.strictEqual(readOnly.defaultPrevented, false);
  assert.strictEqual(shim.execCalls.length, 0);
});

test('defaultPrevented events from earlier capture listeners are respected', () => {
  const shim = createShim({ execInsertSucceeds: true });
  applyClient(shim);
  const event = keydown({ target: shim.composer.textarea });
  event.preventDefault();
  press(shim, event);
  assert.strictEqual(shim.execCalls.length, 0, 'an already-claimed chord must not double-edit');
});
