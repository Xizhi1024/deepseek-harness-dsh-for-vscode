import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

function element(tagName, attrs = {}) {
  const node = {
    nodeType: 1, tagName: tagName.toUpperCase(), childNodes: [], parentNode: null,
    parentElement: null, attrs: { ...attrs },
    getAttribute(name) { return this.attrs[name] ?? null; },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    appendChild(child) {
      this.childNodes.push(child);
      child.parentNode = child.parentElement = this;
      return child;
    },
    removeChild(child) {
      const index = this.childNodes.indexOf(child);
      assert.notEqual(index, -1, 'framework-owned child must remain attached');
      this.childNodes.splice(index, 1);
      child.parentNode = child.parentElement = null;
    },
    replaceChild(next, prev) {
      const index = this.childNodes.indexOf(prev);
      assert.notEqual(index, -1);
      const replacements = next.nodeType === 11 ? [...next.childNodes] : [next];
      this.childNodes.splice(index, 1, ...replacements);
      for (const replacement of replacements) replacement.parentNode = replacement.parentElement = this;
      prev.parentNode = prev.parentElement = null;
    },
    closest(selector) {
      const tags = new Set(selector.split(',').map((item) => item.trim().toUpperCase()));
      for (let current = this; current; current = current.parentElement) {
        if (tags.has(current.tagName)) return current;
      }
      return null;
    },
  };
  return node;
}

function text(value) {
  return { nodeType: 3, nodeValue: value, parentNode: null, parentElement: null };
}

function harness() {
  let client;
  let observer;
  let dispose;
  const document = {
    body: element('body'), head: element('head'),
    createElement: element,
    createTextNode: text,
    createDocumentFragment() { return { ...element('fragment'), nodeType: 11 }; },
    addEventListener() {}, removeEventListener() {},
  };
  const window = {
    location: { search: '?dsh_embed=vscode' },
    parent: { postMessage() {} },
    addEventListener() {}, removeEventListener() {},
    __ModuleLoader__: { load(module) { client = module.factory(); } },
    MutationObserver: class {
      constructor(callback) { observer = callback; }
      observe() {}
      disconnect() {}
    },
  };
  vm.runInNewContext(source, {
    window, document, navigator: {}, URLSearchParams, TextEncoder,
    fetch: async () => ({ ok: true }), setTimeout: () => 1, clearTimeout() {},
  });
  return {
    document,
    apply() { client.apply({ effect(fn) { dispose = fn(); } }); },
    mutate(nodes) { observer([{ addedNodes: nodes }]); },
    dispose() { dispose(); },
  };
}

for (const [label, tagName, attrs] of [
  ['contenteditable editor', 'div', { contenteditable: 'true' }],
  ['inherited empty contenteditable editor', 'div', { contenteditable: '' }],
  ['plaintext editor', 'div', { contenteditable: 'plaintext-only' }],
  ['textarea', 'textarea', {}],
  ['search form', 'form', {}],
  ['search region', 'div', { role: 'search' }],
  ['search result tree', 'div', { role: 'tree' }],
  ['composer card', 'div', { 'data-composer-card': '' }],
]) {
  test(`linkify leaves new text and nested subtrees inside ${label} untouched`, () => {
    const app = harness();
    const control = app.document.body.appendChild(element(tagName, attrs));
    app.apply();
    const direct = control.appendChild(text('src/search.ts'));
    const nested = control.appendChild(element('span'));
    const nestedText = nested.appendChild(text('src/query.ts'));
    app.mutate([direct, nested]);
    assert.equal(direct.parentNode, control, 'added text remains owned by its control');
    assert.equal(nestedText.parentNode, nested, 'nested input text remains owned by its control');
    app.dispose();
  });
}

for (const key of ['__reactFiber$test', '__reactInternalInstance$legacy']) {
  test(`linkify preserves ${key} text so React can update and remove it`, () => {
    const app = harness();
    const row = app.document.body.appendChild(element('span'));
    const owned = row.appendChild(text('src/search.ts'));
    owned[key] = {};
    app.apply();
    owned.nodeValue = 'src/updated.ts';
    app.mutate([owned]);
    row.removeChild(owned);
    assert.equal(row.childNodes.length, 0);
    app.dispose();
  });
}

for (const nested of [false, true]) {
  test(`linkify preserves React single-string children${nested ? ' inside a nested span' : ''}`, () => {
    const app = harness();
    const row = app.document.body.appendChild(element('div'));
    const parent = nested ? row.appendChild(element('span')) : row;
    parent.__reactProps$test = { children: 'src/search.ts' };
    const owned = parent.appendChild(text('src/search.ts'));
    app.apply();
    assert.equal(owned.parentNode, parent);
    owned.nodeValue = 'src/updated.ts';
    app.mutate([parent]);
    parent.removeChild(owned);
    assert.equal(parent.childNodes.length, 0);
    app.dispose();
  });
}

test('one mutation delivery has a shared scan budget across added roots', () => {
  const app = harness();
  app.apply();
  const nodes = [];
  for (let index = 0; index < 2100; index += 1) {
    const parent = app.document.body.appendChild(element('p'));
    nodes.push(parent.appendChild(text(`src/file${index}.ts`)));
  }
  app.mutate(nodes);
  const replaced = nodes.filter((node) => node.parentNode === null).length;
  assert.equal(replaced, 2000, 'a busy render must not reset the budget per text node');
  app.dispose();
});

test('overlapping mutation roots are visited only once per delivery', () => {
  const app = harness();
  app.apply();
  const parent = app.document.body.appendChild(element('p'));
  const child = parent.appendChild(text('ordinary reply text'));
  let reads = 0;
  Object.defineProperty(child, 'nodeValue', { get() { reads += 1; return 'ordinary reply text'; } });
  app.mutate([...Array(100).fill(parent), child]);
  assert.equal(reads, 1);
  app.dispose();
});

test('unmanaged reply text under a React HTML container still receives file links', () => {
  const app = harness();
  const container = app.document.body.appendChild(element('div'));
  container.__reactProps$test = { dangerouslySetInnerHTML: { __html: '<p>src/reply.ts</p>' } };
  const paragraph = container.appendChild(element('p'));
  const original = paragraph.appendChild(text('src/reply.ts'));
  app.apply();
  assert.equal(original.parentNode, null);
  assert.equal(paragraph.childNodes[0].getAttribute('data-dsh-link-path'), 'src/reply.ts');
  app.dispose();
});
