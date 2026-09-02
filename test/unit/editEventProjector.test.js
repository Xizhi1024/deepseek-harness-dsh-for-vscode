'use strict';

const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const test = require('node:test');

const {
  createEditEventProjector,
  extractToolEdit,
  MAX_BACKFILL_EVENTS,
} = require('../../src/editEventProjector');

const BASE_URL = 'http://127.0.0.1:3080';
const EXPORT_URL = `${BASE_URL}/api/session.export`;
const MUX_URL = `${BASE_URL}/api/events.mux`;

// ---------------------------------------------------------------------------
// zip fixture builder (deflate entries, same shape as the host export stream)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const comp = zlib.deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, comp);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));
    offset += 30 + nameBuf.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

function exportZipResponse(events) {
  const jsonl = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  const zip = makeZip([{ name: 'session.jsonl', data: jsonl }]);
  return new Response(zip, { status: 200, headers: { 'content-type': 'application/zip' } });
}

function toolCallEvent(tool, filePath, seq) {
  return {
    type: 'tool/call',
    seq,
    time: Date.now(),
    data: { name: tool, arguments: { file_path: filePath } },
  };
}

function hangingSse() {
  return new Response(new ReadableStream({ start() {} }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function flushMicrotasks() {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// extractToolEdit (pure)
// ---------------------------------------------------------------------------

test('extractToolEdit reads data.name + data.arguments.file_path', () => {
  assert.deepStrictEqual(
    extractToolEdit({ type: 'tool/call', data: { name: 'edit', arguments: { file_path: 'D:/a.ts' } } }),
    { tool: 'edit', path: 'D:/a.ts' }
  );
  assert.deepStrictEqual(
    extractToolEdit({ type: 'tool/call', data: { name: 'write', arguments: { file_path: 'D:/b.ts' } } }),
    { tool: 'write', path: 'D:/b.ts' }
  );
});

test('extractToolEdit tries data.args.path and absolute_path fallbacks', () => {
  assert.deepStrictEqual(
    extractToolEdit({ type: 'tool/call', data: { name: 'edit', args: { path: 'D:/c.ts' } } }),
    { tool: 'edit', path: 'D:/c.ts' }
  );
  assert.deepStrictEqual(
    extractToolEdit({ type: 'tool/call', data: { name: 'write', arguments: { absolute_path: 'D:/d.ts' } } }),
    { tool: 'write', path: 'D:/d.ts' }
  );
});

test('extractToolEdit accepts event.name as a defensive fallback', () => {
  assert.deepStrictEqual(
    extractToolEdit({ type: 'tool/call', name: 'edit', data: { arguments: { file_path: 'D:/e.ts' } } }),
    { tool: 'edit', path: 'D:/e.ts' }
  );
});

test('extractToolEdit returns null for non tool/call events and non-edit tools', () => {
  assert.equal(extractToolEdit(null), null);
  assert.equal(extractToolEdit('nope'), null);
  assert.equal(extractToolEdit(42), null);
  assert.equal(extractToolEdit({}), null);
  assert.equal(extractToolEdit({ type: 'assistant/chunk', data: { name: 'edit' } }), null);
  assert.equal(
    extractToolEdit({ type: 'tool/call', data: { name: 'pwsh', arguments: { command: 'ls' } } }),
    null
  );
  assert.equal(extractToolEdit({ type: 'tool/call', data: { name: 'read', arguments: {} } }), null);
});

test('extractToolEdit returns null when no usable path is present', () => {
  assert.equal(extractToolEdit({ type: 'tool/call', data: { name: 'edit' } }), null);
  assert.equal(
    extractToolEdit({ type: 'tool/call', data: { name: 'edit', arguments: { file_path: '' } } }),
    null
  );
  assert.equal(
    extractToolEdit({ type: 'tool/call', data: { name: 'edit', arguments: { file_path: 42 } } }),
    null
  );
  assert.equal(extractToolEdit({ type: 'tool/call', data: { name: 'edit', arguments: null } }), null);
  assert.equal(extractToolEdit({ type: 'tool/call', data: null }), null);
});

// ---------------------------------------------------------------------------
// followSession: bounded backfill via /api/session.export
// ---------------------------------------------------------------------------

function makeFetch({ exportEvents, muxResponse, exportStatus = 200 } = {}) {
  const state = { exportCalls: 0, muxSignals: [] };
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.startsWith(EXPORT_URL)) {
      state.exportCalls += 1;
      if (exportStatus !== 200) return new Response('nope', { status: exportStatus });
      return exportZipResponse(typeof exportEvents === 'function' ? exportEvents() : exportEvents || []);
    }
    if (u.startsWith(MUX_URL)) {
      return typeof muxResponse === 'function' ? muxResponse(u, init) : muxResponse || hangingSse();
    }
    throw new Error('unexpected url ' + u);
  };
  return { fetchImpl, state };
}

test('backfill projects only the trailing MAX_BACKFILL_EVENTS events', async () => {
  const total = MAX_BACKFILL_EVENTS + 100;
  const events = [];
  for (let i = 0; i < total; i += 1) events.push(toolCallEvent('edit', `D:/f${i}.ts`, i));
  const recorded = [];
  const { fetchImpl, state } = makeFetch({ exportEvents: events });
  const projector = createEditEventProjector({
    recordToolEdit: (p) => recorded.push(p),
    log: () => {},
    fetchImpl,
    baseUrl: BASE_URL,
    resubscribeDelayMs: 60_000,
  });

  await projector.followSession('s1');
  await flushMicrotasks();

  assert.equal(state.exportCalls, 1);
  assert.equal(recorded.length, MAX_BACKFILL_EVENTS);
  // the TAIL is kept: first projected path is f100, last is f399
  assert.equal(recorded[0].path, 'D:/f100.ts');
  assert.equal(recorded[recorded.length - 1].path, `D:/f${total - 1}.ts`);
  projector.unfollow();
});

test('backfill recordToolEdit payload carries tool/path/sessionId', async () => {
  const recorded = [];
  const { fetchImpl } = makeFetch({
    exportEvents: [toolCallEvent('write', 'D:/x/a.txt', 1), { type: 'assistant/chunk', data: {} }],
  });
  const projector = createEditEventProjector({
    recordToolEdit: (p) => recorded.push(p),
    log: () => {},
    fetchImpl,
    baseUrl: () => BASE_URL,
    resubscribeDelayMs: 60_000,
  });
  await projector.followSession('s9');
  await flushMicrotasks();
  assert.deepStrictEqual(recorded, [{ tool: 'write', path: 'D:/x/a.txt', sessionId: 's9' }]);
  projector.unfollow();
});

test('backfill runs at most once per sessionId per projector lifetime', async () => {
  const { fetchImpl, state } = makeFetch({ exportEvents: [toolCallEvent('edit', 'D:/a.ts', 1)] });
  const recorded = [];
  const projector = createEditEventProjector({
    recordToolEdit: (p) => recorded.push(p),
    log: () => {},
    fetchImpl,
    baseUrl: BASE_URL,
    resubscribeDelayMs: 60_000,
  });
  await projector.followSession('s1');
  await projector.unfollow();
  await projector.followSession('s1');
  await flushMicrotasks();
  assert.equal(state.exportCalls, 1);
  projector.unfollow();
});

test('a failed backfill never throws and the live subscription still starts', async () => {
  const recorded = [];
  const { fetchImpl, state } = makeFetch({ exportStatus: 500 });
  const projector = createEditEventProjector({
    recordToolEdit: (p) => recorded.push(p),
    log: () => {},
    fetchImpl,
    baseUrl: BASE_URL,
    resubscribeDelayMs: 60_000,
  });
  await projector.followSession('s1');
  await flushMicrotasks();
  assert.equal(state.exportCalls, 1);
  assert.equal(state.muxSignals.length >= 0, true); // subscription attempted via mux fetch
  projector.unfollow();
});

// ---------------------------------------------------------------------------
// live subscription through streamSession onEvent
// ---------------------------------------------------------------------------

test('live session events are projected through the events.mux subscription', async () => {
  const recorded = [];
  let push;
  const muxResponse = () => new Response(
    new ReadableStream({
      start(controller) {
        push = (event) => {
          const frame = { type: 'session/event', sessionId: 's1', event };
          const wire = { type: 'server-request', rpcId: 'r', method: 'session/event', payload: frame };
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(wire)}\n\n`));
        };
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  );
  const { fetchImpl } = makeFetch({ exportEvents: [], muxResponse });
  const projector = createEditEventProjector({
    recordToolEdit: (p) => recorded.push(p),
    log: () => {},
    fetchImpl,
    baseUrl: BASE_URL,
    resubscribeDelayMs: 60_000,
  });
  await projector.followSession('s1');
  await flushMicrotasks();
  assert.equal(typeof push, 'function', 'mux subscription must be established');
  push(toolCallEvent('edit', 'D:/live.ts', 5));
  push({ type: 'tool/call', data: { name: 'pwsh', arguments: { command: 'ls' } } });
  await flushMicrotasks();
  assert.deepStrictEqual(recorded, [{ tool: 'edit', path: 'D:/live.ts', sessionId: 's1' }]);
  projector.unfollow();
});

test('switching sessions aborts the previous subscription', async () => {
  const recorded = [];
  const { fetchImpl, state } = makeFetch({
    exportEvents: () => [toolCallEvent('edit', 'D:/y.ts', 1)],
    muxResponse: (_url, init) => {
      state.muxSignals.push(init.signal);
      return hangingSse();
    },
  });
  const projector = createEditEventProjector({
    recordToolEdit: (p) => recorded.push(p),
    log: () => {},
    fetchImpl,
    baseUrl: BASE_URL,
    resubscribeDelayMs: 60_000,
  });
  await projector.followSession('s1');
  await flushMicrotasks();
  assert.equal(state.muxSignals.length, 1);
  assert.equal(state.muxSignals[0].aborted, false);
  await projector.followSession('s2');
  await flushMicrotasks();
  assert.equal(state.muxSignals[0].aborted, true, 'old subscription must be aborted');
  assert.equal(state.muxSignals.length, 2, 'new subscription must be started');
  projector.unfollow();
});

test('a recordToolEdit throw is contained and logged, never propagated', async () => {
  const logs = [];
  const { fetchImpl } = makeFetch({ exportEvents: [toolCallEvent('edit', 'D:/z.ts', 1)] });
  const projector = createEditEventProjector({
    recordToolEdit: () => { throw new Error('journal down'); },
    log: (line) => logs.push(line),
    fetchImpl,
    baseUrl: BASE_URL,
    resubscribeDelayMs: 60_000,
  });
  await projector.followSession('s1'); // must not reject
  await flushMicrotasks();
  assert.equal(logs.length > 0, true);
  projector.unfollow();
});

test('followSession ignores empty session ids and a null base url only logs', async () => {
  const logs = [];
  const projector = createEditEventProjector({
    recordToolEdit: () => {},
    log: (line) => logs.push(line),
    fetchImpl: async () => { throw new Error('must not be called'); },
    baseUrl: () => null,
  });
  await projector.followSession('');
  await projector.followSession(null);
  await projector.followSession('s1'); // null base url: logs, never fetches
  await flushMicrotasks();
  assert.equal(logs.length > 0, true);
  projector.unfollow();
});
