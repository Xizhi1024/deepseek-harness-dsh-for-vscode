'use strict';

// Regression tests for the embedded composer Ctrl/Cmd+Enter newline bridge in
// dsh-vscode-integration client.js. Upstream DSH (dffe955ed2) repurposed the
// chord as accelerated submit/steer, which reads as "the composer emptied
// itself" while writing a multi-line reply over an attachment. The bridge
// restores the chord embed-only: on the Lexical contenteditable composer of
// released runtimes it rewrites the keydown as Shift+Enter (shiftKey shadowed
// on the event instance) and lets it propagate — the app's own Shift+Enter
// handling inserts the newline through the editor stack; the textarea
// composer of newer dev builds has no native default for the chord, so there
// the bridge claims the event and inserts via execCommand's input pipeline.

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

/**
 * Fake editor node standing in for the DSH composer input.
 * @param {'contenteditable'|'textarea'} kind - released runtime vs dev build.
 */
function createComposerEditor({ kind = 'contenteditable' } = {}) {
  const isTextarea = kind === 'textarea';
  const editor = {
    tagName: isTextarea ? 'TEXTAREA' : 'DIV',
    isContentEditable: !isTextarea,
    ...(isTextarea
      ? { value: 'draft line', selectionStart: 5, selectionEnd: 5, textContent: undefined }
      : { value: undefined, textContent: 'draft line' }),
    disabled: false,
    readOnly: false,
    dispatched: [],
    closest(selector) {
      if (selector === '[data-composer-card]') return composerCard;
      const parts = selector.split(',').map((part) => part.trim());
      const matches = parts.some((part) => {
        if (part === 'textarea') return isTextarea;
        if (part === '[contenteditable="true"]' || part === '[data-composer-input="true"]') return !isTextarea;
        return false;
      });
      return matches ? this : null;
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
  const composerCard = { querySelector: () => null };
  return { editor, composerCard };
}

function createShim({
  platform = 'Win32',
  execInsertSucceeds = false,
  activeElement = null,
  editorKind = 'contenteditable',
} = {}) {
  const composer = createComposerEditor({ kind: editorKind });
  const execCalls = [];
  const keyListeners = [];
  const messageListeners = [];
  const document = {
    activeElement: activeElement === null ? composer.editor : activeElement,
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

for (const editorKind of ['contenteditable', 'textarea']) {
  test(`[${editorKind}] Ctrl+Enter on the focused composer with a draft never submits`, () => {
    const shim = createShim({ execInsertSucceeds: true, editorKind });
    applyClient(shim);
    const event = press(shim, keydown({ target: shim.composer.editor }));
    if (editorKind === 'contenteditable') {
      assert.strictEqual(event.shiftKey, true, 'the chord is rewritten as Shift+Enter and keeps propagating');
      assert.strictEqual(event.defaultPrevented, false, 'the app\'s own Shift+Enter path must run');
      assert.strictEqual(shim.execCalls.length, 0, 'no side-channel inserts on a Lexical editor');
    } else {
      assert.strictEqual(event.defaultPrevented, true, 'textarea: the chord must be claimed before the DSH submit handler');
      const call = shim.execCalls.find((entry) => entry.command === 'insertText');
      assert.ok(call, 'insertText must run');
      assert.strictEqual(call.value, '\n', 'insertText must splice exactly one newline');
    }
  });

  test(`[${editorKind}] Cmd+Enter (macOS chord) is handled the same way`, () => {
    const shim = createShim({ platform: 'MacIntel', execInsertSucceeds: true, editorKind });
    applyClient(shim);
    const event = press(shim, keydown({ target: shim.composer.editor, metaKey: true, ctrlKey: false }));
    if (editorKind === 'contenteditable') {
      assert.strictEqual(event.shiftKey, true);
      assert.strictEqual(event.defaultPrevented, false);
    } else {
      assert.strictEqual(event.defaultPrevented, true);
      assert.ok(shim.execCalls.some((call) => call.command === 'insertText' && call.value === '\n'));
    }
  });

  test(`[${editorKind}] plain Enter is untouched — the DSH submit gesture keeps working`, () => {
    const shim = createShim({ execInsertSucceeds: true, editorKind });
    applyClient(shim);
    const event = press(shim, keydown({ target: shim.composer.editor, ctrlKey: false, metaKey: false }));
    assert.strictEqual(event.defaultPrevented, false);
    assert.strictEqual(event.shiftKey, false, 'plain Enter must not be rewritten');
    assert.strictEqual(shim.execCalls.length, 0);
  });

  test(`[${editorKind}] Shift+Enter itself is never rewritten`, () => {
    const shim = createShim({ execInsertSucceeds: true, editorKind });
    applyClient(shim);
    const event = press(shim, keydown({ target: shim.composer.editor, ctrlKey: false, metaKey: false, shiftKey: true }));
    assert.strictEqual(event.defaultPrevented, false);
    assert.strictEqual(shim.execCalls.length, 0);
  });

  test(`[${editorKind}] empty draft passes the chord through — the upstream queue-steer gesture survives`, () => {
    const shim = createShim({ execInsertSucceeds: true, editorKind });
    applyClient(shim);
    if (editorKind === 'textarea') shim.composer.editor.value = '';
    else shim.composer.editor.textContent = '';
    const event = press(shim, keydown({ target: shim.composer.editor }));
    assert.strictEqual(event.defaultPrevented, false, 'nothing to break a line in: let DSH steer the queue');
    assert.strictEqual(event.shiftKey, false, 'no rewrite either');
    assert.strictEqual(shim.execCalls.length, 0);
  });

  test(`[${editorKind}] IME-composing Enter belongs to the engine and is never claimed`, () => {
    const shim = createShim({ execInsertSucceeds: true, editorKind });
    applyClient(shim);
    const composing = press(shim, keydown({ target: shim.composer.editor, isComposing: true }));
    const legacy = press(shim, keydown({ target: shim.composer.editor, keyCode: 229 }));
    assert.strictEqual(composing.defaultPrevented, false);
    assert.strictEqual(composing.shiftKey, false);
    assert.strictEqual(legacy.defaultPrevented, false);
    assert.strictEqual(shim.execCalls.length, 0);
  });

  test(`[${editorKind}] Alt-modified variants (Ctrl+Alt+Enter) are left for the host`, () => {
    const shim = createShim({ execInsertSucceeds: true, editorKind });
    applyClient(shim);
    const event = press(shim, keydown({ target: shim.composer.editor, altKey: true }));
    assert.strictEqual(event.defaultPrevented, false);
    assert.strictEqual(event.shiftKey, false);
    assert.strictEqual(shim.execCalls.length, 0);
  });

  test(`[${editorKind}] defaultPrevented events from earlier capture listeners are respected`, () => {
    const shim = createShim({ execInsertSucceeds: true, editorKind });
    applyClient(shim);
    const event = keydown({ target: shim.composer.editor });
    event.preventDefault();
    press(shim, event);
    assert.strictEqual(shim.execCalls.length, 0, 'an already-claimed chord must not be double-handled');
    assert.strictEqual(event.shiftKey, false, 'no rewrite on a dead event');
  });
}

test('editors outside the composer card are untouched (queue dock, question inputs)', () => {
  const shim = createShim({ execInsertSucceeds: true });
  const otherEditor = {
    value: 'some other input',
    textContent: 'some other input',
    isContentEditable: true,
    selectionStart: 0,
    selectionEnd: 0,
    closest() { return null; },
  };
  shim.document.activeElement = otherEditor;
  applyClient(shim);
  const event = press(shim, keydown({ target: otherEditor }));
  assert.strictEqual(event.defaultPrevented, false);
  assert.strictEqual(event.shiftKey, false);
  assert.strictEqual(shim.execCalls.length, 0);
});

test('contenteditable drafts are read from textContent, not value', () => {
  const shim = createShim({ execInsertSucceeds: true });
  applyClient(shim);
  const editor = shim.composer.editor;
  assert.strictEqual(editor.value, undefined, 'sanity: the released-runtime shape has no value');
  const event = press(shim, keydown({ target: editor }));
  assert.strictEqual(event.shiftKey, true, 'textContent draft must be recognized as non-empty');
});

test('execCommand refusal falls back to setRangeText plus a synthetic input event (textarea builds)', () => {
  const shim = createShim({ execInsertSucceeds: false, editorKind: 'textarea' });
  applyClient(shim);
  const editor = shim.composer.editor;
  const event = press(shim, keydown({ target: editor }));
  assert.strictEqual(event.defaultPrevented, true);
  assert.strictEqual(editor.value, 'draft\n line', 'newline spliced at the caret');
  assert.strictEqual(editor.selectionStart, 6, 'caret moves past the inserted newline');
  assert.strictEqual(editor.dispatched.length, 1, 'one synthetic input event for the controlled component');
  assert.strictEqual(editor.dispatched[0].type, 'input');
  assert.strictEqual(editor.dispatched[0].bubbles, true);
});

test('disabled or read-only composers are skipped', () => {
  const shim = createShim({ execInsertSucceeds: true });
  applyClient(shim);
  shim.composer.editor.disabled = true;
  const disabled = press(shim, keydown({ target: shim.composer.editor }));
  shim.composer.editor.disabled = false;
  shim.composer.editor.readOnly = true;
  const readOnly = press(shim, keydown({ target: shim.composer.editor }));
  assert.strictEqual(disabled.defaultPrevented, false);
  assert.strictEqual(disabled.shiftKey, false);
  assert.strictEqual(readOnly.defaultPrevented, false);
  assert.strictEqual(shim.execCalls.length, 0);
});
