'use strict';

// B3 (issue #6) reply-path links: pure text -> target extraction (file:///
// URLs incl. Windows drive form, workspace-relative paths with :line and
// :line:col) plus a minimal-DOM harness verifying the client paints ranges
// instead of rewriting nodes, resolves the token under the caret on click and
// POSTs the parsed payload to the open-link route. Negative cases pin the
// anti-false-positive rules (plain English, https:// URLs, node:fs, versions,
// and/or) and the READ-ONLY contract that fixes the "final conclusion is
// invisible in the panel" live bug (2026-09-24): the plugin must never create,
// remove or rewrite a node the DSH web app rendered, because React keeps its
// own reference to every text node it created.

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
  return loaded.factory();
}

// ---------------------------------------------------------------------------
// Minimal fake DOM (only the surface client.js touches). Elements inherit from
// a stand-in Element class so the module's `event.target instanceof Element`
// guard behaves like it does in a browser, and every node knows whether it is
// still attached (the read-only painter checks isConnected).
// ---------------------------------------------------------------------------

class FakeElement {}

function elementMatches(node, selector) {
  // Selector shapes this module uses: "tag", "[attr]", "[attr=\"value\"]",
  // "tag[attr]" and comma-separated lists of those.
  const match = /^([A-Za-z0-9-]*)(?:\[([^\]=]+)(?:="([^"]*)")?\])?$/.exec(String(selector).trim());
  if (!match) return false;
  const tag = match[1];
  const attribute = match[2];
  const attributeValue = match[3];
  if (!tag && !attribute) return false;
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  if (attribute) {
    const value = node.getAttribute ? node.getAttribute(attribute) : null;
    if (value === null) return false;
    if (attributeValue !== undefined && value !== attributeValue) return false;
  }
  return true;
}

function makeTextNode(text) {
  const node = { nodeType: 3, nodeValue: String(text), parentNode: null, parentElement: null };
  Object.defineProperty(node, 'isConnected', {
    get() {
      let current = node;
      while (current.parentNode) current = current.parentNode;
      return current._root === true;
    },
  });
  return node;
}

function makeElement(tagName) {
  const el = Object.assign(new FakeElement(), {
    nodeType: 1,
    tagName: String(tagName).toUpperCase(),
    childNodes: [],
    parentNode: null,
    parentElement: null,
    style: {},
    _attrs: {},
    _root: false,
  });
  el.appendChild = (child) => {
    child.parentNode = el;
    child.parentElement = el;
    el.childNodes.push(child);
    return child;
  };
  el.removeChild = (child) => {
    const index = el.childNodes.indexOf(child);
    if (index !== -1) el.childNodes.splice(index, 1);
    child.parentNode = null;
    child.parentElement = null;
    return child;
  };
  el.setAttribute = (key, value) => { el._attrs[key] = String(value); };
  el.getAttribute = (key) => (key in el._attrs ? el._attrs[key] : null);
  el.closest = (selector) => {
    const parts = String(selector).split(',').map((part) => part.trim()).filter(Boolean);
    let node = el;
    while (node) {
      if (node.nodeType === 1 && parts.some((part) => elementMatches(node, part))) return node;
      node = node.parentElement;
    }
    return null;
  };
  Object.defineProperty(el, 'textContent', {
    get() {
      const collect = (node) => {
        if (node.nodeType === 3) return node.nodeValue;
        return (node.childNodes || []).map(collect).join('');
      };
      return el.childNodes.map(collect).join('');
    },
    set(value) {
      const text = makeTextNode(value);
      text.parentNode = el;
      text.parentElement = el;
      el.childNodes = [text];
    },
  });
  Object.defineProperty(el, 'isConnected', {
    get() {
      let current = el;
      while (current.parentNode) current = current.parentNode;
      return current._root === true;
    },
  });
  return el;
}

function createDomShim() {
  const listeners = new Map();
  const observerInstances = [];
  const ranges = [];
  let caretNode = null;
  let caretOffset = 0;
  let caretResolver = null;
  const document = {
    activeElement: null,
    body: makeElement('body'),
    head: makeElement('head'),
    createElement: (tag) => makeElement(tag),
    createRange: () => {
      const range = {
        startContainer: null,
        startOffset: 0,
        endContainer: null,
        endOffset: 0,
        setStart(node, offset) { range.startContainer = node; range.startOffset = offset; },
        setEnd(node, offset) { range.endContainer = node; range.endOffset = offset; },
      };
      ranges.push(range);
      return range;
    },
    addEventListener(type, listener) {
      const list = listeners.get(type) || [];
      list.push(listener);
      listeners.set(type, list);
    },
    removeEventListener(type, listener) {
      const list = listeners.get(type) || [];
      const index = list.indexOf(listener);
      if (index !== -1) list.splice(index, 1);
    },
    caretPositionFromPoint(x, y) {
      shim.lastCaretQuery = { x, y };
      return caretResolver ? caretResolver(x, y) : (caretNode ? { offsetNode: caretNode, offset: caretOffset } : null);
    },
    execCommand() { return false; },
  };
  document.body._root = true;
  document.head._root = true;
  class MutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      this.observed = null;
      observerInstances.push(this);
    }
    observe(target, options) { this.observed = { target, options }; }
    disconnect() { this.disconnected = true; }
  }
  const window = {
    location: { search: '?dsh_embed=vscode' },
    MutationObserver,
    addEventListener() {},
    removeEventListener() {},
    getSelection() { return { toString: () => '' }; },
    URLSearchParams,
    TextEncoder,
  };
  window.parent = {
    postMessage() {},
  };
  const shim = {
    window,
    document,
    navigator: { platform: 'Win32' },
    listeners,
    observerInstances,
    ranges,
    /** Feed a caret position to the next document.caretPositionFromPoint call. */
    setCaret(node, offset) {
      caretNode = node;
      caretOffset = offset;
      caretResolver = null;
    },
    /** Feed a full caret resolution (e.g. a point over an element, not text). */
    setCaretResolver(resolver) {
      caretResolver = resolver;
      caretNode = null;
    },
    lastCaretQuery: null,
    listenersFor(type) { return listeners.get(type) || []; },
  };
  return shim;
}

/**
 * Install the CSS Custom Highlight API stand-ins on globalThis for the body of
 * `run` (the module reads both lazily at apply time, exactly as it would in a
 * browser page).
 */
function withHighlightApi() {
  const highlights = new Map();
  class Highlight {
    constructor() { this.ranges = new Set(); }
    add(range) { this.ranges.add(range); return this; }
    delete(range) { return this.ranges.delete(range); }
  }
  const previous = { Highlight: globalThis.Highlight, CSS: globalThis.CSS };
  globalThis.Highlight = Highlight;
  globalThis.CSS = { highlights };
  return {
    highlights,
    registered() { return [...highlights.values()]; },
    paintedRanges() {
      return [...highlights.values()].flatMap((highlight) => [...highlight.ranges]);
    },
    restore() {
      if (previous.Highlight === undefined) delete globalThis.Highlight;
      else globalThis.Highlight = previous.Highlight;
      if (previous.CSS === undefined) delete globalThis.CSS;
      else globalThis.CSS = previous.CSS;
    },
  };
}

function plainClient() {
  const shim = createDomShim();
  const client = loadClient(shim);
  return { shim, client };
}

/** Every element in the tree (used to prove no anchors are ever injected). */
function elementsIn(root) {
  const found = [];
  const visit = (node) => {
    if (node.nodeType !== 1) return;
    found.push(node);
    for (const child of node.childNodes) visit(child);
  };
  visit(root);
  return found;
}

function applyClient(client, shim) {
  let cleanup = null;
  client.apply({ effect: (fn) => { cleanup = fn(); return () => {}; } });
  return { cleanup, shim };
}

/** Repainting is coalesced (LINKIFY_FLUSH_MS): wait out one window. */
function flushPaint() {
  return new Promise((resolve) => { setTimeout(resolve, 160); });
}

function clickEvent(overrides = {}) {
  return {
    button: 0,
    detail: 1,
    clientX: 10,
    clientY: 20,
    defaultPrevented: false,
    target: null,
    preventDefault() { this.defaultPrevented = true; },
    stopImmediatePropagation() {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure extraction tests.
// ---------------------------------------------------------------------------

test('extractLinkTargets links a bare workspace file name (hello.js)', () => {
  const { client } = plainClient();
  const targets = client.__linkify.extractLinkTargets('take a look at hello.js first');
  assert.strictEqual(targets.length, 1);
  assert.deepStrictEqual(
    { path: targets[0].path, line: targets[0].line, col: targets[0].col, kind: targets[0].kind },
    { path: 'hello.js', line: undefined, col: undefined, kind: 'workspace-path' },
  );
  assert.strictEqual('take a look at '.length, targets[0].start);
  assert.strictEqual(targets[0].end - targets[0].start, 'hello.js'.length);
});

test('extractLinkTargets links a workspace-relative path with :line (src/x.js:42)', () => {
  const { client } = plainClient();
  const targets = client.__linkify.extractLinkTargets('fixed in src/x.js:42 yesterday');
  assert.strictEqual(targets.length, 1);
  assert.deepStrictEqual(
    { path: targets[0].path, line: targets[0].line, col: targets[0].col },
    { path: 'src/x.js', line: 42, col: undefined },
  );
});

test('extractLinkTargets links :line:col suffixes (lib/util.ts:7:13)', () => {
  const { client } = plainClient();
  const targets = client.__linkify.extractLinkTargets('see lib/util.ts:7:13');
  assert.strictEqual(targets.length, 1);
  assert.deepStrictEqual(
    { path: targets[0].path, line: targets[0].line, col: targets[0].col },
    { path: 'lib/util.ts', line: 7, col: 13 },
  );
});

test('extractLinkTargets links Windows drive file:/// URLs with :line (file:///D:/x.js:7)', () => {
  const { client } = plainClient();
  const targets = client.__linkify.extractLinkTargets('open file:///D:/x.js:7 please');
  assert.strictEqual(targets.length, 1);
  assert.deepStrictEqual(
    { path: targets[0].path, line: targets[0].line, col: targets[0].col, kind: targets[0].kind },
    { path: 'D:/x.js', line: 7, col: undefined, kind: 'file-url' },
  );
});

test('extractLinkTargets links POSIX file:/// URLs and decodes %20', () => {
  const { client } = plainClient();
  const targets = client.__linkify.extractLinkTargets('see file:///home/u/my%20docs/a.py');
  assert.strictEqual(targets.length, 1);
  assert.strictEqual(targets[0].path, '/home/u/my docs/a.py');
  assert.strictEqual(targets[0].kind, 'file-url');
});

test('plain English sentences never link', () => {
  const { client } = plainClient();
  assert.deepStrictEqual(client.__linkify.extractLinkTargets('the quick brown fox jumps over the lazy dog'), []);
});

test('https URL tokens (including their path) never link', () => {
  const { client } = plainClient();
  assert.deepStrictEqual(client.__linkify.extractLinkTargets('see https://example.com/index.js and http://a.b/c.js'), []);
});

test('node:fs, versions, and/or, and dotted prose never link', () => {
  const { client } = plainClient();
  for (const text of ['import node:fs', 'version 1.2.3 shipped', 'read and/or write', 'e.g. etc. cf.']) {
    assert.deepStrictEqual(client.__linkify.extractLinkTargets(text), [], text);
  }
});

test('multiple targets in one text are extracted in order', () => {
  const { client } = plainClient();
  const targets = client.__linkify.extractLinkTargets('start at hello.js then src/x.js:42 and finally file:///D:/y/z.md:3:9');
  assert.strictEqual(targets.length, 3);
  assert.deepStrictEqual(targets.map((t) => [t.path, t.line, t.col]), [
    ['hello.js', undefined, undefined],
    ['src/x.js', 42, undefined],
    ['D:/y/z.md', 3, 9],
  ]);
  for (let index = 1; index < targets.length; index += 1) {
    assert.ok(targets[index].start > targets[index - 1].end, 'targets must not overlap');
  }
});

test('separator-only dotted directory paths link only with a dotted segment (docs/api rejected)', () => {
  const { client } = plainClient();
  assert.deepStrictEqual(client.__linkify.extractLinkTargets('see docs/api for details'), []);
  const targets = client.__linkify.extractLinkTargets('see docs/api.v2/readme data');
  assert.strictEqual(targets.length, 1);
  assert.strictEqual(targets[0].path, 'docs/api.v2/readme');
});

test('over-long text is skipped entirely', () => {
  const { client } = plainClient();
  assert.deepStrictEqual(client.__linkify.extractLinkTargets('x'.repeat(100001) + ' hello.js'), []);
});

// ---------------------------------------------------------------------------
// tokenAtOffset: the pure read side of click resolution.
// ---------------------------------------------------------------------------

test('tokenAtOffset resolves the token a caret offset sits inside', () => {
  const { client } = plainClient();
  const text = 'edit hello.js now';
  const start = text.indexOf('hello.js');
  const target = client.__linkify.tokenAtOffset(text, start + 3);
  assert.ok(target, 'a caret inside the token must resolve it');
  assert.strictEqual(target.path, 'hello.js');
  assert.strictEqual(target.start, start);
  assert.strictEqual(target.end, start + 'hello.js'.length);
});

test('tokenAtOffset accepts both token boundaries (the caret sits between characters)', () => {
  const { client } = plainClient();
  const text = 'edit hello.js now';
  const start = text.indexOf('hello.js');
  const end = start + 'hello.js'.length;
  assert.strictEqual(client.__linkify.tokenAtOffset(text, start).path, 'hello.js');
  assert.strictEqual(client.__linkify.tokenAtOffset(text, end).path, 'hello.js');
  assert.strictEqual(client.__linkify.tokenAtOffset(text, start - 1), null);
  assert.strictEqual(client.__linkify.tokenAtOffset(text, end + 1), null);
});

test('tokenAtOffset carries :line:col and decoded file:/// targets', () => {
  const { client } = plainClient();
  const lineCol = 'see lib/util.ts:7:13';
  const lineTarget = client.__linkify.tokenAtOffset(lineCol, lineCol.indexOf('util'));
  assert.deepStrictEqual(
    { path: lineTarget.path, line: lineTarget.line, col: lineTarget.col },
    { path: 'lib/util.ts', line: 7, col: 13 },
  );
  const fileUrl = 'open file:///home/u/my%20docs/a.py';
  const urlTarget = client.__linkify.tokenAtOffset(fileUrl, fileUrl.indexOf('docs'));
  assert.strictEqual(urlTarget.path, '/home/u/my docs/a.py');
  assert.strictEqual(urlTarget.kind, 'file-url');
});

test('tokenAtOffset is null outside links, on non-link tokens and on bad input', () => {
  const { client } = plainClient();
  assert.strictEqual(client.__linkify.tokenAtOffset('the quick brown fox', 4), null);
  assert.strictEqual(client.__linkify.tokenAtOffset('read and/or write', 6), null);
  assert.strictEqual(client.__linkify.tokenAtOffset('x'.repeat(100001) + ' hello.js', 2), null);
  assert.strictEqual(client.__linkify.tokenAtOffset('hello.js', -1), null);
  assert.strictEqual(client.__linkify.tokenAtOffset('hello.js', 99), null);
  assert.strictEqual(client.__linkify.tokenAtOffset('hello.js', 1.5), null);
});

// ---------------------------------------------------------------------------
// READ-ONLY paint contract: ranges, never node surgery.
// ---------------------------------------------------------------------------

test('apply never rewrites rendered nodes and paints the matches as ranges', () => {
  const api = withHighlightApi();
  try {
    const shim = createDomShim();
    const client = loadClient(shim);
    const paragraph = makeElement('p');
    const text = makeTextNode('edit hello.js and src/x.js:42 and file:///D:/x.js:7 ok');
    paragraph.appendChild(text);
    shim.document.body.appendChild(paragraph);
    const elementsBefore = elementsIn(shim.document.body).length;

    applyClient(client, shim);

    // Not a single node was created, removed or rewritten: React's own
    // references (the text node instance) must survive untouched.
    assert.strictEqual(paragraph.childNodes.length, 1, 'the text node must not be split');
    assert.strictEqual(paragraph.childNodes[0], text, 'the very same text node must still be there');
    assert.strictEqual(text.nodeValue, 'edit hello.js and src/x.js:42 and file:///D:/x.js:7 ok');
    assert.strictEqual(elementsIn(shim.document.body).length, elementsBefore, 'no anchors may be injected');
    assert.deepStrictEqual(elementsIn(shim.document.body).map((el) => el.tagName), ['BODY', 'P']);

    // The affordance is painted as ranges over that same text node.
    const ranges = api.paintedRanges();
    assert.strictEqual(ranges.length, 3, 'three matched paths must be underlined');
    assert.deepStrictEqual(
      ranges.map((range) => text.nodeValue.slice(range.startOffset, range.endOffset)),
      ['hello.js', 'src/x.js:42', 'file:///D:/x.js:7'],
    );
    for (const range of ranges) assert.strictEqual(range.startContainer, text);
  } finally {
    api.restore();
  }
});

test('the mutation observer repaints added subtrees without editing them', async () => {
  const api = withHighlightApi();
  try {
    const shim = createDomShim();
    const client = loadClient(shim);
    applyClient(client, shim);
    assert.strictEqual(shim.observerInstances.length, 1, 'one observer must be installed');

    const message = makeElement('div');
    const text = makeTextNode('done: fixed hello.js');
    message.appendChild(text);
    shim.document.body.appendChild(message);
    shim.observerInstances[0].callback([{ type: 'childList', addedNodes: [message], removedNodes: [] }]);
    await flushPaint();

    assert.strictEqual(message.childNodes.length, 1, 'added content must never be rewritten');
    assert.strictEqual(message.childNodes[0], text);
    const [range] = api.paintedRanges();
    assert.strictEqual(text.nodeValue.slice(range.startOffset, range.endOffset), 'hello.js');
  } finally {
    api.restore();
  }
});

test('characterData updates move the range instead of stacking a stale one', async () => {
  const api = withHighlightApi();
  try {
    const shim = createDomShim();
    const client = loadClient(shim);
    const paragraph = makeElement('p');
    const text = makeTextNode('streaming hello.js');
    paragraph.appendChild(text);
    shim.document.body.appendChild(paragraph);
    applyClient(client, shim);
    assert.strictEqual(api.paintedRanges().length, 1);

    // The app streams more text into the SAME node (React commitTextUpdate).
    text.nodeValue = 'streaming is done, see src/x.js:42 now';
    shim.observerInstances[0].callback([{ type: 'characterData', target: text }]);
    await flushPaint();

    const ranges = api.paintedRanges();
    assert.strictEqual(ranges.length, 1, 'the old range for this node must be dropped');
    assert.strictEqual(text.nodeValue.slice(ranges[0].startOffset, ranges[0].endOffset), 'src/x.js:42');
  } finally {
    api.restore();
  }
});

test('removed subtrees release their painted ranges', async () => {
  const api = withHighlightApi();
  try {
    const shim = createDomShim();
    const client = loadClient(shim);
    const message = makeElement('div');
    const text = makeTextNode('done: fixed hello.js');
    message.appendChild(text);
    shim.document.body.appendChild(message);
    applyClient(client, shim);
    assert.strictEqual(api.paintedRanges().length, 1);

    shim.document.body.removeChild(message);
    shim.observerInstances[0].callback([{ type: 'childList', addedNodes: [], removedNodes: [message] }]);
    await flushPaint();
    assert.deepStrictEqual(api.paintedRanges(), [], 'a removed message must not leak its ranges');
  } finally {
    api.restore();
  }
});

test('runtimes without the Highlight API still resolve clicks (click-only links)', async () => {
  const shim = createDomShim();
  const client = loadClient(shim);
  const paragraph = makeElement('p');
  const text = makeTextNode('edit hello.js now');
  paragraph.appendChild(text);
  shim.document.body.appendChild(paragraph);
  applyClient(client, shim);
  assert.strictEqual(shim.observerInstances.length, 0, 'no painter means no observer work');

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => { calls.push({ url, options }); return Promise.resolve({ ok: true }); };
  try {
    shim.setCaret(text, text.nodeValue.indexOf('hello.js') + 2);
    const event = clickEvent({ target: paragraph });
    shim.listenersFor('click')[shim.listenersFor('click').length - 1](event);
    await Promise.resolve();
    assert.strictEqual(calls.length, 1, 'a click must still open the path');
    assert.deepStrictEqual(JSON.parse(calls[0].options.body), { path: 'hello.js' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// Click resolution: caret hit-test, never an injected anchor.
// ---------------------------------------------------------------------------

test('a click on a path POSTs the parsed payload and claims the event', async () => {
  const shim = createDomShim();
  const client = loadClient(shim);
  const paragraph = makeElement('p');
  const text = makeTextNode('edit hello.js and src/x.js:42 and file:///D:/x.js:7 ok');
  paragraph.appendChild(text);
  shim.document.body.appendChild(paragraph);
  applyClient(client, shim);

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => { calls.push({ url, options }); return Promise.resolve({ ok: true }); };
  try {
    // Caret inside src/x.js:42.
    shim.setCaret(text, text.nodeValue.indexOf('x.js') + 1);
    let prevented = false;
    let stopped = false;
    const event = clickEvent({
      target: paragraph,
      preventDefault() { prevented = true; this.defaultPrevented = true; },
      stopImmediatePropagation() { stopped = true; },
    });
    shim.listenersFor('click')[shim.listenersFor('click').length - 1](event);
    assert.ok(prevented, 'click must be claimed');
    assert.ok(stopped, 'propagation must stop before the a[href] handler');
    assert.deepStrictEqual(shim.lastCaretQuery, { x: 10, y: 20 }, 'the hit test must use the click point');
    await Promise.resolve();
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, '/api/vscode/open-link');
    assert.strictEqual(calls[0].options.method, 'POST');
    assert.strictEqual(calls[0].options.headers['X-DSH-VSCode-Linkify'], '1');
    assert.deepStrictEqual(JSON.parse(calls[0].options.body), { path: 'src/x.js', line: 42 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('clicking a file:/// path sends the decoded path with line and col', async () => {
  const shim = createDomShim();
  const client = loadClient(shim);
  const paragraph = makeElement('p');
  const text = makeTextNode('open file:///D:/code/a%20b.ts:3:9 now');
  paragraph.appendChild(text);
  shim.document.body.appendChild(paragraph);
  applyClient(client, shim);

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => { calls.push(JSON.parse(options.body)); return Promise.resolve({ ok: true }); };
  try {
    shim.setCaret(text, text.nodeValue.indexOf('a%20b') + 1);
    shim.listenersFor('click')[shim.listenersFor('click').length - 1](clickEvent({ target: paragraph }));
    await Promise.resolve();
    assert.deepStrictEqual(calls, [{ path: 'D:/code/a b.ts', line: 3, col: 9 }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('clicks that resolve no link are left to the app', async () => {
  const shim = createDomShim();
  const client = loadClient(shim);
  const paragraph = makeElement('p');
  const text = makeTextNode('read and/or write, version 1.2.3');
  paragraph.appendChild(text);
  shim.document.body.appendChild(paragraph);
  applyClient(client, shim);

  const textarea = makeElement('textarea');
  const typed = makeTextNode('draft hello.js');
  textarea.appendChild(typed);
  shim.document.body.appendChild(textarea);

  const composer = makeElement('div');
  composer.setAttribute('contenteditable', '');
  const draft = makeTextNode('composer draft hello.js');
  composer.appendChild(draft);
  shim.document.body.appendChild(composer);

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => { calls.push(options); return Promise.resolve({ ok: true }); };
  const linkifyClick = shim.listenersFor('click')[shim.listenersFor('click').length - 1];
  try {
    // (a) prose without a path
    shim.setCaret(text, 4);
    let prevented = false;
    linkifyClick(clickEvent({ target: paragraph, preventDefault() { prevented = true; this.defaultPrevented = true; } }));
    assert.strictEqual(prevented, false, 'prose must keep its native click');
    // (b) a path-shaped token that the parser rejects (and/or, version)
    shim.setCaret(text, text.nodeValue.indexOf('and/or') + 1);
    linkifyClick(clickEvent({ target: paragraph }));
    // (c) a double click is a selection gesture
    shim.setCaret(text, text.nodeValue.indexOf('version') + 1);
    linkifyClick(clickEvent({ target: paragraph, detail: 2 }));
    // (d) the app's own editable control is never claimed
    shim.setCaret(typed, typed.nodeValue.indexOf('hello.js') + 1);
    linkifyClick(clickEvent({ target: textarea }));
    // (d2) nor is a contenteditable composer (empty attribute form)
    shim.setCaret(draft, draft.nodeValue.indexOf('hello.js') + 1);
    linkifyClick(clickEvent({ target: composer }));
    // (d3) nor a subtree inheriting editability from an ancestor
    const nested = makeElement('span');
    const nestedText = makeTextNode('nested hello.js');
    nested.appendChild(nestedText);
    composer.appendChild(nested);
    Object.defineProperty(nested, 'isContentEditable', { get: () => true });
    shim.setCaret(nestedText, nestedText.nodeValue.indexOf('hello.js') + 1);
    linkifyClick(clickEvent({ target: nested }));
    // (e) a caret that resolved to an element, not text
    shim.setCaretResolver(() => ({ offsetNode: paragraph, offset: 0 }));
    linkifyClick(clickEvent({ target: paragraph }));
    await Promise.resolve();
    assert.deepStrictEqual(calls, [], 'no fetch may be issued for any of these');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('hovering a painted path claims the pointer cursor and leaving restores it', async () => {
  const shim = createDomShim();
  const client = loadClient(shim);
  const paragraph = makeElement('p');
  const text = makeTextNode('edit hello.js now');
  paragraph.appendChild(text);
  shim.document.body.appendChild(paragraph);
  applyClient(client, shim);

  shim.setCaret(text, text.nodeValue.indexOf('hello.js') + 1);
  shim.listenersFor('pointermove')[0]({ clientX: 3, clientY: 4 });
  await new Promise((resolve) => { setTimeout(resolve, 90); });
  assert.strictEqual(shim.document.body.style.cursor, 'pointer');

  shim.listenersFor('mouseleave')[0]({});
  assert.strictEqual(shim.document.body.style.cursor, '', 'the previous inline cursor must come back');
});

test('the disposer removes listeners, observer, cursor and highlight registration', async () => {
  const api = withHighlightApi();
  try {
    const shim = createDomShim();
    const client = loadClient(shim);
    const paragraph = makeElement('p');
    const text = makeTextNode('edit hello.js now');
    paragraph.appendChild(text);
    shim.document.body.appendChild(paragraph);
    const { cleanup } = applyClient(client, shim);
    assert.strictEqual(api.highlights.size, 1);

    shim.setCaret(text, text.nodeValue.indexOf('hello.js') + 1);
    shim.listenersFor('pointermove')[0]({ clientX: 3, clientY: 4 });
    await new Promise((resolve) => { setTimeout(resolve, 90); });
    assert.strictEqual(shim.document.body.style.cursor, 'pointer');

    cleanup();

    assert.deepStrictEqual(shim.listenersFor('click'), []);
    assert.deepStrictEqual(shim.listenersFor('pointermove'), []);
    assert.ok(shim.observerInstances[0].disconnected, 'the observer must be disconnected');
    assert.strictEqual(api.highlights.size, 0, 'the highlight registry slot must be released');
    assert.strictEqual(shim.document.body.style.cursor, '', 'the claimed cursor must be restored');
  } finally {
    api.restore();
  }
});

test('missing DOM primitives disable linkify without breaking apply', () => {
  // Reuse the bare macShortcuts-style shim: no document.body etc.
  const shim = {
    window: {
      location: { search: '?dsh_embed=vscode' },
      addEventListener() {}, removeEventListener() {},
      getSelection() { return { toString: () => '' }; },
      URLSearchParams, TextEncoder,
    },
    navigator: { platform: 'Win32' },
    document: {
      activeElement: null,
      addEventListener() {}, removeEventListener() {},
      execCommand() { return false; },
    },
  };
  shim.window.parent = { postMessage() {} };
  const client = loadClient(shim);
  client.apply({ effect: (fn) => { fn(); return () => {}; } });
  assert.strictEqual(typeof client.apply, 'function');
});