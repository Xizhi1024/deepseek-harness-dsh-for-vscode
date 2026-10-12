'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const net = require('node:net');

const {
  WebSocketStreamError,
  buildWebSocketKey,
  verifyWebSocketAccept,
  encodeClientFrame,
  encodeBinaryClientFrame,
  parseServerFrames,
  remoteMuxUrlFromBaseUrl,
  createTypertStream,
} = require('../../src/wsStreamClient');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Decode the mask XOR used in a masked client frame. */
function decodeMaskedFrame(buf) {
  const first = buf[0];
  const fin = (first & 0x80) === 0x80;
  const opcode = first & 0x0f;
  const b1 = buf[1];
  let len = b1 & 0x7f;
  let cursor = 2;
  if (len === 126) {
    len = buf.readUInt16BE(cursor);
    cursor += 2;
  } else if (len === 127) {
    len = Number(buf.readBigUInt64BE(cursor));
    cursor += 8;
  }
  const maskKey = buf.slice(cursor, cursor + 4);
  cursor += 4;
  const masked = buf.slice(cursor, cursor + len);
  const out = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i += 1) out[i] = masked[i] ^ maskKey[i & 3];
  return { fin, opcode, payload: out };
}

// ---------------------------------------------------------------------------
// handshake pieces
// ---------------------------------------------------------------------------

test('buildWebSocketKey returns a base64 key decoding to 16 bytes', () => {
  for (let i = 0; i < 10; i += 1) {
    const key = buildWebSocketKey();
    assert.strictEqual(Buffer.from(key, 'base64').length, 16);
  }
});

test('verifyWebSocketAccept matches the RFC 6455 accept derivation', () => {
  const key = buildWebSocketKey();
  const expected = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  assert.strictEqual(verifyWebSocketAccept(key, expected), true);
  assert.strictEqual(verifyWebSocketAccept(key, 'wrong'), false);
  assert.strictEqual(verifyWebSocketAccept(null, expected), false);
  assert.strictEqual(verifyWebSocketAccept(key, null), false);
});

test('remoteMuxUrlFromBaseUrl maps loopback http(s) to the ws mux route', () => {
  assert.strictEqual(
    remoteMuxUrlFromBaseUrl('http://127.0.0.1:3080'),
    'ws://127.0.0.1:3080/api/remote.mux'
  );
  assert.strictEqual(
    remoteMuxUrlFromBaseUrl('http://localhost:9000/api/ignored'),
    'ws://localhost:9000/api/remote.mux'
  );
  assert.strictEqual(
    remoteMuxUrlFromBaseUrl('https://127.0.0.1:9443'),
    'wss://127.0.0.1:9443/api/remote.mux'
  );
});

test('remoteMuxUrlFromBaseUrl rejects non-loopback and malformed URLs', () => {
  for (const bad of ['http://example.com:3080', 'http://127.0.0.1', '', 'not a url', 'ws://127.0.0.1:1/x']) {
    assert.throws(
      () => remoteMuxUrlFromBaseUrl(bad),
      (err) => err instanceof WebSocketStreamError
        && (err.code === 'WS_STREAM_MALFORMED_URL' || err.code === 'WS_STREAM_NOT_LOOPBACK')
    );
  }
});

// ---------------------------------------------------------------------------
// RFC 6455 framing
// ---------------------------------------------------------------------------

test('encodeClientFrame produces a masked text frame for short/16-bit/64-bit payloads', () => {
  for (const text of ['', 'hello', 'x'.repeat(125), 'y'.repeat(126), 'z'.repeat(65_536)]) {
    const frame = encodeClientFrame(text);
    const decoded = decodeMaskedFrame(frame);
    assert.strictEqual(decoded.fin, true);
    assert.strictEqual(decoded.opcode, 0x1, 'text opcode');
    assert.strictEqual(decoded.payload.toString('utf8'), text);
  }
  const big = encodeClientFrame('b'.repeat(70_000));
  assert.strictEqual(decodeMaskedFrame(big).payload.length, 70_000);
  assert.strictEqual(big[1] & 0x7f, 127, '64-bit length indicator');
});

test('encodeClientFrame supports unmasked and fragmented frames', () => {
  const plain = encodeClientFrame('plain', { mask: false });
  assert.strictEqual(plain[1] & 0x80, 0, 'no mask bit');
  assert.strictEqual(plain[1] & 0x7f, 5);

  const fragment = encodeClientFrame('part', { fin: false, opcode: 0x1 });
  const decoded = decodeMaskedFrame(fragment);
  assert.strictEqual(decoded.fin, false);
  assert.strictEqual(decoded.payload.toString('utf8'), 'part');
});

test('encodeBinaryClientFrame emits masked binary/pong/close frames', () => {
  for (const opcode of [0x2, 0xa, 0x8, 0x9]) {
    const frame = encodeBinaryClientFrame(Buffer.from([0x01, 0x02, 0x03]), opcode);
    const decoded = decodeMaskedFrame(frame);
    assert.strictEqual(decoded.opcode, opcode);
    assert.deepStrictEqual(decoded.payload, Buffer.from([0x01, 0x02, 0x03]));
  }
});

test('parseServerFrames decodes unmasked text, ping, pong and close frames', () => {
  const make = (opcode, payload) => {
    const bytes = Buffer.from(payload);
    return Buffer.concat([Buffer.from([0x80 | opcode, bytes.length]), bytes]);
  };
  const text = make(0x1, Buffer.from('{"a":1}'));
  const ping = make(0x9, Buffer.from('hmm'));
  const pong = make(0xa, Buffer.from('hmm'));
  const close = Buffer.concat([Buffer.from([0x88, 0x04]), Buffer.from([0x03, 0xe8, 0x6f, 0x6b])]);

  const { frames, rest } = parseServerFrames(Buffer.concat([text, ping, pong, close]));
  assert.strictEqual(rest.length, 0);
  assert.deepStrictEqual(frames, [
    { type: 'text', text: '{"a":1}' },
    { type: 'ping', payload: Buffer.from('hmm') },
    { type: 'pong', payload: Buffer.from('hmm') },
    { type: 'close', code: 1000, reason: 'ok' },
  ]);
});

test('parseServerFrames parses masked server frames and 16-bit lengths, preserving the tail', () => {
  const mask = Buffer.from([1, 2, 3, 4]);
  const payload = Buffer.from('masked-payload');
  const masked = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i & 3];
  const short = Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
  const { frames: shortFrames } = parseServerFrames(short);
  assert.strictEqual(shortFrames[0].text, 'masked-payload');

  const header = Buffer.alloc(4);
  Buffer.from([0x81, 0x80 | 126]).copy(header, 0);
  header.writeUInt16BE(280, 2);
  const masked16 = Buffer.alloc(280);
  for (let i = 0; i < 280; i += 1) masked16[i] = (i & 0xff) ^ mask[i & 3];
  // Trailing bytes must begin with a valid-but-incomplete frame header; an
  // invalid start (e.g. literal "tail") is a protocol error and rightly throws.
  const partial = Buffer.from([0x81, 0x86, 0x01, 0x02]); // masked text, 6-byte payload, only 2 given
  const sixteen = Buffer.concat([header, mask, masked16, partial]);
  const parsed16 = parseServerFrames(sixteen);
  assert.strictEqual(parsed16.frames[0].text.length, 280);
  // masked16[i] = (i & 0xff) ^ mask[i & 3], so a correct unmask restores i.
  assert.strictEqual(parsed16.frames[0].text.charCodeAt(3), 3);
  assert.deepStrictEqual(parsed16.rest, partial);
});

test('parseServerFrames reassembles continuation fragments', () => {
  const state = { partial: null, partialOpcode: 0 };
  const fragment = (fin, opcode, text) => {
    const bytes = Buffer.from(text);
    return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, bytes.length]), bytes]);
  };
  const stream = Buffer.concat([
    fragment(false, 0x1, 'hello '),
    fragment(false, 0x0, 'wo'),
    fragment(true, 0x0, 'rld'),
    fragment(true, 0x1, 'next'),
  ]);

  const { frames, state: after } = parseServerFrames(stream, state);
  assert.deepStrictEqual(frames.map((f) => f.text), ['hello world', 'next']);
  assert.strictEqual(after.partial, null);
});

test('parseServerFrames refuses RSV bits, unknown opcodes and orphan continuations', () => {
  assert.throws(
    () => parseServerFrames(Buffer.from([0xc1, 0x00])),
    (err) => err instanceof WebSocketStreamError && err.code === 'WS_STREAM_PROTOCOL'
  );
  assert.throws(
    () => parseServerFrames(Buffer.from([0x83, 0x00])),
    (err) => err instanceof WebSocketStreamError && err.code === 'WS_STREAM_PROTOCOL'
  );
  assert.throws(
    () => parseServerFrames(Buffer.from([0x80, 0x00])),
    (err) => err instanceof WebSocketStreamError && err.code === 'WS_STREAM_PROTOCOL'
  );
});

test('parseServerFrames tolerates byte-by-byte frame delivery', () => {
  const full = Buffer.concat([Buffer.from([0x81, 0x07]), Buffer.from('1234567')]);
  const state = { partial: null, partialOpcode: 0 };
  let rest = Buffer.alloc(0);
  const texts = [];
  for (let i = 0; i < full.length; i += 1) {
    rest = Buffer.concat([rest, Buffer.from([full[i]])]);
    const result = parseServerFrames(rest, state);
    rest = result.rest;
    for (const frame of result.frames) texts.push(frame.text);
  }
  assert.deepStrictEqual(texts, ['1234567']);
  assert.strictEqual(rest.length, 0);
});

test('parseServerFrames enforces the text message size cap', () => {
  const size = 32 * 1024 * 1024 + 1;
  const payload = Buffer.alloc(size, 0x61);
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 0x7f;
  header.writeBigUInt64BE(BigInt(size), 2);
  const frame = Buffer.concat([header, payload]);
  assert.throws(
    () => parseServerFrames(frame),
    (err) => err instanceof WebSocketStreamError && err.code === 'WS_STREAM_PROTOCOL'
  );
});

// ---------------------------------------------------------------------------
// loopback remote.mux server + createTypertStream
// ---------------------------------------------------------------------------

/**
 * Minimal loopback WebSocket server that performs the RFC 6455 handshake and
 * lets the test observe client frames and push server frames.
 */
function startMuxServer() {
  let onFrame = null;
  let onHandshake = null;
  let onServerError = null;
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let handshakeDone = false;
    let buffer = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshakeDone) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const head = buffer.subarray(0, headerEnd).toString('utf8');
        buffer = buffer.subarray(headerEnd + 4);
        if (onHandshake) onHandshake(head);
        const keyMatch = /sec-websocket-key:\s*([^\r\n]+)/i.exec(head);
        const accept = crypto
          .createHash('sha1')
          .update((keyMatch ? keyMatch[1].trim() : '') + WS_GUID)
          .digest('base64');
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\n'
          + 'Upgrade: websocket\r\n'
          + 'Connection: Upgrade\r\n'
          + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
        );
        handshakeDone = true;
        return;
      }
      // Parse masked client frames. Cursor only advances past COMPLETE
      // frames, so a partial frame's bytes survive into the next chunk.
      let cursor = 0;
      for (;;) {
        if (buffer.length - cursor < 2) break;
        const frameStart = cursor;
        const opcode = buffer[frameStart] & 0x0f;
        const b1 = buffer[frameStart + 1];
        const masked = (b1 & 0x80) === 0x80;
        let len = b1 & 0x7f;
        let headerSize = 2;
        if (len === 126) {
          if (buffer.length - frameStart < 4) break;
          len = buffer.readUInt16BE(frameStart + 2);
          headerSize = 4;
        } else if (len === 127) {
          if (buffer.length - frameStart < 10) break;
          len = Number(buffer.readBigUInt64BE(frameStart + 2));
          headerSize = 10;
        }
        if (masked) {
          if (buffer.length - frameStart < headerSize + 4) break;
          headerSize += 4;
        }
        if (buffer.length - frameStart < headerSize + len) break;
        const payloadStart = frameStart + headerSize;
        const payload = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i += 1) {
          payload[i] = buffer[payloadStart + i]
            ^ (masked ? buffer[frameStart + headerSize - 4 + (i & 3)] : 0);
        }
        cursor = payloadStart + len;
        if (onFrame) onFrame(payload, socket);
      }
      buffer = buffer.subarray(cursor);
    });
  });
  server.on('error', (err) => {
    if (onServerError) onServerError(err);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve({
        port: server.address().port,
        setFrame(fn) { onFrame = fn; },
        setHandshake(fn) { onHandshake = fn; },
        setServerError(fn) { onServerError = fn; },
        close: () => new Promise((res) => {
          for (const socket of sockets.values()) socket.destroy();
          server.close(() => res());
        }),
      });
    });
  });
}

function sendServerText(socket, text) {
  const payload = Buffer.from(text, 'utf8');
  const header = payload.length < 126
    ? Buffer.from([0x81, payload.length])
    : (() => {
        const h = Buffer.alloc(4);
        h[0] = 0x81;
        h[1] = 126;
        h.writeUInt16BE(payload.length, 2);
        return h;
      })();
  socket.write(Buffer.concat([header, payload]));
}

test('createTypertStream performs the handshake and demuxes item/end frames (loopback round-trip)', async () => {
  const mux = await startMuxServer();
  const frames = [];
  let clientHandshake = null;
  mux.setHandshake((head) => { clientHandshake = head; });
  mux.setFrame((payload, socket) => {
    const message = JSON.parse(payload.toString('utf8'));
    frames.push(message);
    if (message.type === 'open') {
      // Reply in the open-frame arrival tick (deterministic ordering: the
      // client's open frame always lands one tick after `await` resolves).
      sendServerText(socket, JSON.stringify({
        type: 'item', streamId: message.streamId,
        value: { type: 'snapshot', header: {}, cursor: 0, records: [], hasMore: false, projections: {} },
      }));
      sendServerText(socket, JSON.stringify({
        type: 'item', streamId: message.streamId,
        value: { type: 'event', event: { type: 'tool/call', data: { name: 'edit' } } },
      }));
      sendServerText(socket, JSON.stringify({ type: 'end', streamId: message.streamId }));
    }
  });

  let values = [];
  const handle = await createTypertStream({
    baseUrl: `http://127.0.0.1:${mux.port}`,
    endpoint: 'session/follow',
    args: { request: { address: { kind: 'session', sessionId: 's1' }, assistantStream: true } },
    onValue: (v) => values.push(v),
  });

  try {
    const outcome = await handle.done;
    assert.deepStrictEqual(outcome, { reason: 'end' });

    // The open frame is guaranteed recorded before `done` settled it drove
    // the whole reply, so every assertion is race-free at this point.
    assert.ok(clientHandshake, 'a WebSocket handshake must reach the server');
    assert.match(clientHandshake, /Upgrade:\s*websocket/i);
    assert.ok(/Sec-WebSocket-Version:\s*13/i.test(clientHandshake), 'must speak version 13');

    assert.strictEqual(values.length, 2);
    assert.strictEqual(values[0].type, 'snapshot');
    assert.strictEqual(values[1].event.type, 'tool/call');

    const openFrame = frames[0];
    assert.strictEqual(openFrame.type, 'open', 'the server reply is driven by the open frame');
    assert.strictEqual(openFrame.streamId, handle.streamId);
    assert.strictEqual(openFrame.endpoint, 'session/follow');
    assert.deepStrictEqual(openFrame.payload.args, {
      request: { address: { kind: 'session', sessionId: 's1' }, assistantStream: true },
    });
  } finally {
    handle.cancel(); // no-op after settle; guards the connection on assertion failure
    await mux.close();
  }
});

test('createTypertStream routes error frames into done and sends cancel frames on cancel()', async () => {
  // error path: reply with an error frame when the open frame arrives
  const mux = await startMuxServer();
  mux.setFrame((payload, socket) => {
    const message = JSON.parse(payload.toString('utf8'));
    if (message.type === 'open') {
      sendServerText(socket, JSON.stringify({
        type: 'error', streamId: message.streamId,
        error: { code: 'SESSION_GONE', message: 'nope', details: {} },
      }));
    }
  });
  try {
    const handle = await createTypertStream({
      baseUrl: `http://127.0.0.1:${mux.port}`,
      endpoint: 'session/follow',
      args: { request: { address: { kind: 'session', sessionId: 's1' } } },
      onValue: () => {},
    });
    const outcome = await handle.done;
    assert.deepStrictEqual(outcome, { reason: 'error', error: { code: 'SESSION_GONE', message: 'nope', details: {} } });
  } finally {
    await mux.close();
  }

  // cancel path on a fresh stream
  const mux2 = await startMuxServer();
  const frames2 = [];
  let resolveCancelSeen = null;
  const cancelSeen = new Promise((resolve) => { resolveCancelSeen = resolve; });
  mux2.setFrame((payload) => {
    const message = JSON.parse(payload.toString('utf8'));
    frames2.push(message);
    if (message.type === 'cancel') resolveCancelSeen();
  });
  try {
    const handle2 = await createTypertStream({
      baseUrl: `http://127.0.0.1:${mux2.port}`,
      endpoint: 'session/follow',
      args: { request: { address: { kind: 'session', sessionId: 's2' } } },
      onValue: () => {},
    });
    const streamId = handle2.streamId;
    handle2.cancel();
    await cancelSeen; // cancel() sends the frame before closing the socket
    assert.ok(frames2.some((f) => f.type === 'open'), 'the cancel path still negotiates an open frame');
    const cancelFrame = frames2.find((f) => f.type === 'cancel');
    assert.ok(cancelFrame, 'cancel() must send a cancel frame');
    assert.strictEqual(cancelFrame.streamId, streamId);
    const closed = await handle2.done;
    assert.strictEqual(closed.reason, 'closed');
  } finally {
    await mux2.close();
  }
});

test('createTypertStream settles aborted immediately for a pre-aborted signal', async () => {
  const controller = new AbortController();
  controller.abort();
  const handle = await createTypertStream({
    baseUrl: 'http://127.0.0.1:3080',
    endpoint: 'session/follow',
    args: { request: { address: { kind: 'session', sessionId: 's1' } } },
    signal: controller.signal,
    onValue: () => {},
  });
  assert.deepStrictEqual(await handle.done, { reason: 'aborted' });
});

test('createTypertStream rejects malformed base URLs and non-loopback hosts', async () => {
  await assert.rejects(
    createTypertStream({
      baseUrl: 'http://evil.example.com:3080',
      endpoint: 'session/follow',
      args: { request: { address: { kind: 'session', sessionId: 's1' } } },
    }),
    (err) => err instanceof WebSocketStreamError && err.code === 'WS_STREAM_NOT_LOOPBACK'
  );
  await assert.rejects(
    createTypertStream({
      baseUrl: 'http://127.0.0.1:3080',
      endpoint: '',
      args: {},
    }),
    (err) => err instanceof TypeError
  );
});

test('createTypertStream settles closed when the server drops the connection', async () => {
  const mux = await startMuxServer();
  let resolveOpenSeen = null;
  const openSeen = new Promise((resolve) => { resolveOpenSeen = resolve; });
  mux.setFrame((payload, socket) => {
    const message = JSON.parse(payload.toString('utf8'));
    if (message.type === 'open') {
      resolveOpenSeen();
      socket.destroy();
    }
  });
  try {
    const handle = await createTypertStream({
      baseUrl: `http://127.0.0.1:${mux.port}`,
      endpoint: 'session/follow',
      args: { request: { address: { kind: 'session', sessionId: 's1' } } },
      onValue: () => {},
    });
    // `done` settles as the close caused by the open-arrival drop, so openSeen
    // is resolved by then; awaiting it guarantees the drop came from open.
    await openSeen;
    assert.deepStrictEqual(await handle.done, { reason: 'closed' });
  } finally {
    await mux.close();
  }
});

test('createTypertStream routes a consumer onValue throw to consumer-error and cancels', async () => {
  const mux = await startMuxServer();
  const frames = [];
  let resolveCancelSeen = null;
  const cancelSeen = new Promise((resolve) => { resolveCancelSeen = resolve; });
  mux.setFrame((payload, socket) => {
    const message = JSON.parse(payload.toString('utf8'));
    frames.push(message);
    if (message.type === 'open') {
      sendServerText(socket, JSON.stringify({
        type: 'item', streamId: message.streamId, value: { type: 'event', event: {} },
      }));
    } else if (message.type === 'cancel') {
      resolveCancelSeen();
    }
  });
  try {
    const handle = await createTypertStream({
      baseUrl: `http://127.0.0.1:${mux.port}`,
      endpoint: 'session/follow',
      args: { request: { address: { kind: 'session', sessionId: 's1' } } },
      onValue: () => { throw new Error('consumer blew up'); },
    });
    const outcome = await handle.done;
    assert.strictEqual(outcome.reason, 'consumer-error');
    assert.match(outcome.error.message, /consumer blew up/);
    await cancelSeen;
    const cancelFrame = frames.find((f) => f.type === 'cancel');
    assert.ok(cancelFrame, 'a consumer error must cancel the stream');
    assert.strictEqual(cancelFrame.streamId, handle.streamId);
  } finally {
    await mux.close();
  }
});