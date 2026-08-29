import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createEditObserver } from '../lib/editObserver.js';
import { BridgeGeneration } from '../lib/tools.js';

const SNAPSHOT_MAX_BYTES = 1024 * 1024;

function fakeCtx() {
  const handlers = new Map();
  return {
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        const current = handlers.get(event) || [];
        const index = current.indexOf(handler);
        if (index >= 0) current.splice(index, 1);
      };
    },
    fire(event, exec) {
      return [...(handlers.get(event) || [])].map((handler) => handler(exec));
    },
  };
}

function tempFile(content) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-edit-observer-'));
  const path = join(dir, 'target.txt');
  writeFileSync(path, content, 'utf8');
  return { dir, path };
}

test('editObserver: edit tool with exec.arguments.file_path notifies the contract payload', () => {
  const { path } = tempFile('héllo wörld'); // multi-byte: byte length != char length
  const ctx = fakeCtx();
  const payloads = [];
  const observer = createEditObserver({
    ctx,
    notify: (payload) => payloads.push(payload),
  });
  const results = ctx.fire('tools/pre-execute', {
    name: 'edit',
    arguments: { file_path: path, old_string: 'a', new_string: 'b' },
    agent: { session: { id: 'sess-1' } },
  });
  assert.deepStrictEqual(payloads, [{
    tool: 'edit',
    path,
    sessionId: 'sess-1',
    size: Buffer.byteLength('héllo wörld', 'utf8'),
    truncated: false,
  }]);
  // observe-only: the handler must never gate the waterfall.
  assert.deepStrictEqual(results, [undefined]);
  observer.dispose();
});

test('editObserver: write tool with exec.args.path and agent.id fallback session', () => {
  const { path } = tempFile('abc');
  const ctx = fakeCtx();
  const payloads = [];
  createEditObserver({ ctx, notify: (payload) => payloads.push(payload) });
  ctx.fire('tools/pre-execute', {
    name: 'write',
    args: { path, content: 'new' },
    agent: { id: 'agent-7' },
  });
  assert.deepStrictEqual(payloads, [{
    tool: 'write',
    path,
    sessionId: 'agent-7',
    size: 3,
    truncated: false,
  }]);
});

test('editObserver: non edit/write tool names never notify', () => {
  const { path } = tempFile('abc');
  const ctx = fakeCtx();
  const payloads = [];
  createEditObserver({ ctx, notify: (payload) => payloads.push(payload) });
  ctx.fire('tools/pre-execute', { name: 'read', arguments: { file_path: path } });
  ctx.fire('tools/pre-execute', { name: 'bash', arguments: { command: 'ls' } });
  ctx.fire('tools/pre-execute', {});
  ctx.fire('tools/pre-execute', null);
  assert.strictEqual(payloads.length, 0);
});

test('editObserver: unrecognized argument shape is skipped silently', () => {
  const ctx = fakeCtx();
  const payloads = [];
  createEditObserver({ ctx, notify: (payload) => payloads.push(payload) });
  ctx.fire('tools/pre-execute', { name: 'edit', arguments: { mystery: true } });
  ctx.fire('tools/pre-execute', { name: 'write', arguments: 'not-an-object' });
  ctx.fire('tools/pre-execute', { name: 'edit' });
  assert.strictEqual(payloads.length, 0);
});

test('editObserver: unreadable file notifies nothing and never throws', () => {
  const ctx = fakeCtx();
  const payloads = [];
  createEditObserver({
    ctx,
    notify: (payload) => payloads.push(payload),
    readFileSyncFn: () => { throw new Error('ENOENT'); },
  });
  let result;
  assert.doesNotThrow(() => {
    result = ctx.fire('tools/pre-execute', {
      name: 'edit',
      arguments: { file_path: '/definitely/missing/file.txt' },
    })[0];
  });
  assert.strictEqual(payloads.length, 0);
  assert.strictEqual(result, undefined);
});

test('editObserver: oversized beforeText is truncated at 1 MiB and flagged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-edit-observer-big-'));
  const path = join(dir, 'big.bin');
  writeFileSync(path, Buffer.alloc(SNAPSHOT_MAX_BYTES + 10, 0x61));
  const ctx = fakeCtx();
  const payloads = [];
  createEditObserver({ ctx, notify: (payload) => payloads.push(payload) });
  ctx.fire('tools/pre-execute', { name: 'write', arguments: { file_path: path, content: 'x' } });
  assert.deepStrictEqual(payloads, [{
    tool: 'write',
    path,
    sessionId: '',
    size: SNAPSHOT_MAX_BYTES,
    truncated: true,
  }]);
  rmSync(dir, { recursive: true, force: true });
});

test('editObserver: a throwing notify sink is contained (tool execution unaffected)', () => {
  const { path } = tempFile('abc');
  const ctx = fakeCtx();
  let result;
  assert.doesNotThrow(() => {
    const observer = createEditObserver({
      ctx,
      notify: () => { throw new Error('sink down'); },
    });
    result = ctx.fire('tools/pre-execute', { name: 'edit', arguments: { file_path: path } })[0];
    observer.dispose();
  });
  assert.strictEqual(result, undefined);
});

test('editObserver: dispose removes the listener', () => {
  const { path } = tempFile('abc');
  const ctx = fakeCtx();
  const payloads = [];
  const observer = createEditObserver({ ctx, notify: (payload) => payloads.push(payload) });
  observer.dispose();
  ctx.fire('tools/pre-execute', { name: 'edit', arguments: { file_path: path } });
  assert.strictEqual(payloads.length, 0);
});

test('BridgeGeneration.notify writes an id-less JSON-RPC notification frame', () => {
  const written = [];
  const socket = { destroyed: false, write: (text) => written.push(text) };
  const gen = new BridgeGeneration({ socket, timeoutMs: 1000 });
  const sent = gen.notify('vscode/dshEditObserved', { tool: 'edit', path: '/a', sessionId: '', size: 1, truncated: false });
  assert.strictEqual(sent, true);
  assert.strictEqual(written.length, 1);
  const frame = JSON.parse(written[0]);
  assert.strictEqual(frame.jsonrpc, '2.0');
  assert.strictEqual(frame.method, 'vscode/dshEditObserved');
  assert.strictEqual('id' in frame, false);
  assert.strictEqual(frame.params.tool, 'edit');
  assert.ok(written[0].endsWith(String.fromCharCode(10)), 'frames are newline-delimited');
});

test('BridgeGeneration.notify silently drops on a dead or destroyed socket', () => {
  const written = [];
  const dead = new BridgeGeneration({ socket: { destroyed: true, write: (t) => written.push(t) }, timeoutMs: 1000 });
  assert.strictEqual(dead.notify('vscode/dshEditObserved', { tool: 'edit' }), false);
  const throwing = new BridgeGeneration({ socket: { destroyed: false, write: () => { throw new Error('EPIPE'); } }, timeoutMs: 1000 });
  assert.strictEqual(throwing.notify('vscode/dshEditObserved', { tool: 'edit' }), false);
  assert.strictEqual(written.length, 0);
});
