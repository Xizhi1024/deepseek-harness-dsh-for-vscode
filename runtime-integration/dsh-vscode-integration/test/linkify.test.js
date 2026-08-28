'use strict';

// B3 (issue #6) reply-path linkify: pure text -> target extraction (file:///
// URLs incl. Windows drive form, workspace-relative paths with :line and
// :line:col) plus a minimal-DOM harness verifying the client wraps matches in
// clickable anchors and a click POSTs the parsed payload to the open-link
// route. Negative cases pin the anti-false-positive rules (plain English,
// https:// URLs, node:fs, versions, and/or).

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
// Minimal fake DOM (only the surface client.js touches).
// ---------------------------------------------------------------------------

function makeTextNode(text) {
  return { nodeType: 3, nodeValue: String(text), parentNode: null, parentElement: null };
}

function makeElement(tagName) {
  const el = {
    nodeType: 1,
    tagName: String(tagName).toUpperCase(),
    childNodes: [],
    parentNode: null,
    parentElement: null,
    _attrs: {},
  };
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
  el.replaceChild = (next, prev) => {
    const index = el.childNodes.indexOf(prev);
    if (index === -1) return prev;
    const insert = next.nodeType === 11 ? [...next.childNodes] : [next];
    el.childNodes.splice(index, 1, ...insert);
    for (const node of insert) {
      node.parentNode = el;
      node.parentElement = el;
    }
    prev.parentNode = null;
    prev.parentElement = null;
    return prev;
  };
  el.setAttribute = (key, value) => { el._attrs[key] = String(value); };
  el.getAttribute = (key) => (key in el._attrs ? el._attrs[key] : null);
  el.closest = (selector) => {
    const wantsAnchorClass = selector.includes('.dsh-vscode-file-link');
    const tagNames = new Set(selector.split(',').map((part) => part.trim().split('.')[0].toUpperCase()));
    let node = el;
    while (node) {
      if (node.tagName && tagNames.has(node.tagName)) {
        if (!wantsAnchorClass || (node.getAttribute('class') || '').includes('dsh-vscode-file-link')) return node;
      }
      node = node.parentElement;
    }
    return null;
  };
  Object.defineProperty(el, 'textContent', {
    get() { return el.childNodes.filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join(''); },
    set(value) {
      const text = makeTextNode(value);
      text.parentNode = el;
      text.parentElement = el;
      el.childNodes = [text];
    },
  });
  return el;
}

function createDomShim() {
  const clickListeners = [];
  const observerInstances = [];
  const document = {
    activeElement: null,
    body: makeElement('body'),
    head: makeElement('head'),
    createElement: (tag) => makeElement(tag),
    createDocumentFragment: () => makeElement('#document-fragment'),
    createTextNode: (text) => makeTextNode(text),
    addEventListener(type, listener, capture) {
      if (type === 'click' && capture) clickListeners.push(listener);
    },
    removeEventListener(type, listener, capture) {
      if (type !== 'click' || !capture) return;
      const index = clickListeners.indexOf(listener);
      if (index !== -1) clickListeners.splice(index, 1);
    },
    execCommand() { return false; },
  };
  class MutationObserver {
    constructor(callback) {
      this.callback = callback;
      observerInstances.push(this);
    }
    observe() {}
    disconnect() {}
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
  return {
    window,
    document,
    navigator: { platform: 'Win32' },
    clickListeners,
    observerInstances,
  };
}

function plainClient() {
  const shim = createDomShim();
  const client = loadClient(shim);
  return { shim, client };
}

function anchorIn(container) {
  const anchors = [];
  const visit = (node) => {
    if (node.nodeType === 1) {
      if ((node.getAttribute && node.getAttribute('class')) === 'dsh-vscode-file-link') anchors.push(node);
      for (const child of node.childNodes) visit(child);
    }
  };
  visit(container);
  return anchors;
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
// DOM + click payload tests (fake DOM, fetch spy).
// ---------------------------------------------------------------------------

test('apply wraps targets in anchors and a click POSTs the parsed payload', async () => {
  const shim = createDomShim();
  const client = loadClient(shim);
  const paragraph = makeElement('p');
  paragraph.appendChild(makeTextNode('edit hello.js and src/x.js:42 and file:///D:/x.js:7 ok'));
  shim.document.body.appendChild(paragraph);

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => {
    calls.push({ url, options });
    return Promise.resolve({ ok: true });
  };
  try {
    client.apply({ effect: (fn) => { fn(); return () => {}; } });
    const anchors = anchorIn(shim.document.body);
    assert.strictEqual(anchors.length, 3, 'three targets must be wrapped');
    assert.deepStrictEqual(
      anchors.map((a) => [a.getAttribute('data-dsh-link-path'), a.getAttribute('data-dsh-link-line'), a.getAttribute('data-dsh-link-col')]),
      [
        ['hello.js', null, null],
        ['src/x.js', '42', null],
        ['D:/x.js', '7', null],
      ],
    );
    assert.strictEqual(anchors[0].textContent, 'hello.js');
    assert.strictEqual(anchors[1].textContent, 'src/x.js:42');
    assert.strictEqual(anchors[2].textContent, 'file:///D:/x.js:7');

    // Click the middle anchor (target = its inner text node's element chain).
    let stopped = false;
    let prevented = false;
    const event = {
      button: 0,
      defaultPrevented: false,
      target: anchors[1],
      preventDefault() { prevented = true; this.defaultPrevented = true; },
      stopImmediatePropagation() { stopped = true; },
    };
    // The linkify listener is registered after the legacy a[href] handler;
    // feed only the linkify listener by simulating its position (last).
    shim.clickListeners[shim.clickListeners.length - 1](event);
    assert.ok(prevented, 'click must be claimed');
    assert.ok(stopped, 'propagation must stop before the a[href] handler');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, '/api/vscode/open-link');
    assert.strictEqual(calls[0].options.method, 'POST');
    assert.strictEqual(calls[0].options.headers['X-DSH-VSCode-Linkify'], '1');
    assert.deepStrictEqual(JSON.parse(calls[0].options.body), { path: 'src/x.js', line: 42 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('clicking a file:/// anchor sends the decoded path with line and col', async () => {
  const shim = createDomShim();
  const client = loadClient(shim);
  const paragraph = makeElement('p');
  paragraph.appendChild(makeTextNode('open file:///D:/code/a%20b.ts:3:9 now'));
  shim.document.body.appendChild(paragraph);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => { calls.push(JSON.parse(options.body)); return Promise.resolve({ ok: true }); };
  try {
    client.apply({ effect: (fn) => { fn(); return () => {}; } });
    const [anchor] = anchorIn(shim.document.body);
    assert.ok(anchor, 'one anchor expected');
    shim.clickListeners[shim.clickListeners.length - 1]({
      button: 0, defaultPrevented: false, target: anchor,
      preventDefault() {}, stopImmediatePropagation() {},
    });
    await Promise.resolve();
    assert.deepStrictEqual(calls, [{ path: 'D:/code/a b.ts', line: 3, col: 9 }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('text inside existing anchors and negatives are never wrapped', () => {
  const shim = createDomShim();
  const client = loadClient(shim);
  const existing = makeElement('a');
  existing.setAttribute('href', 'https://example.com/hello.js');
  existing.textContent = 'hello.js';
  const paragraph = makeElement('p');
  paragraph.appendChild(makeTextNode('visit https://example.com/index.js and/or read node:fs docs, version 1.2.3'));
  shim.document.body.appendChild(existing);
  shim.document.body.appendChild(paragraph);
  client.apply({ effect: (fn) => { fn(); return () => {}; } });
  assert.strictEqual(anchorIn(shim.document.body).length, 0);
});

test('newly added message subtrees are linkified through the MutationObserver', () => {
  const shim = createDomShim();
  const client = loadClient(shim);
  client.apply({ effect: (fn) => { fn(); return () => {}; } });
  assert.ok(shim.observerInstances.length >= 1, 'observer must be installed');
  const message = makeElement('div');
  message.appendChild(makeTextNode('done: fixed hello.js'));
  // Simulate the observer callback for an added element subtree.
  shim.observerInstances[0].callback([{ addedNodes: [message] }]);
  const anchors = anchorIn(message);
  assert.strictEqual(anchors.length, 1);
  assert.strictEqual(anchors[0].getAttribute('data-dsh-link-path'), 'hello.js');
  // Feeding the anchor back through the observer must not re-wrap it.
  shim.observerInstances[0].callback([{ addedNodes: [anchors[0]] }]);
  assert.strictEqual(anchorIn(message).length, 1);
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
