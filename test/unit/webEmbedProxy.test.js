'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { createWebEmbedProxy, needsEmbedProxy } = require('../../src/webEmbedProxy');

/** Minimal authenticated DSH stand-in: token mints a cookie, cookie admits
 * everything else, the browser-trust fence rules are enforced like rc.1. */
function startFakeChild({ onFenceViolation = () => {} } = {}) {
  const state = { cookie: 'dsh-auth=first' };
  const seen = [];
  const server = http.createServer((req, res) => {
    const authority = `127.0.0.1:${server.address().port}`;
    seen.push({ url: req.url, host: req.headers.host, origin: req.headers.origin, cookie: req.headers.cookie });
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      onFenceViolation('sec-fetch-site forwarded');
      res.writeHead(403); res.end(); return;
    }
    if (req.headers.origin && req.headers.origin !== `http://${authority}`) {
      onFenceViolation('origin mismatch forwarded');
      res.writeHead(403); res.end(); return;
    }
    if (req.url.startsWith('/?token=')) {
      res.writeHead(303, { location: '/', 'set-cookie': `${state.cookie}; Path=/; HttpOnly; SameSite=Strict` });
      res.end(); return;
    }
    if (req.headers.cookie !== state.cookie) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('dsh web authentication required; reopen the URL printed by dsh web.\n'); return;
    }
    if (req.url === '/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      state.onStream(res); // test-provided chunk schedule
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>__DSH_BOOT__</html>');
  });
  return { server, state, seen };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, resolve);
    req.on('error', reject);
    req.end(options.body || undefined);
  });
}

function readBody(res) {
  return new Promise((resolve) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

test('proxy forwards the cookie host-side and satisfies the child fence', async (t) => {
  const child = startFakeChild();
  await listen(child.server);
  t.after(() => { child.server.closeAllConnections(); child.server.close(); });
  const authority = `127.0.0.1:${child.server.address().port}`;

  const proxy = createWebEmbedProxy();
  const proxyUrl = await proxy.start(`http://${authority}/?token=synthetic`); // allow-secret-scan
  t.after(() => proxy.close());

  // The iframe-side request carries the proxy authority and browser markers
  // (exactly what a vscode-webview iframe would send) — the child still
  // answers 200 because the proxy rewrites the fence inputs.
  const res = await request(`${proxyUrl}/?dsh_embed=vscode`, {
    headers: {
      host: new URL(proxyUrl).host,
      origin: proxyUrl,
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate',
    },
  });
  assert.equal(res.statusCode, 200);
  assert.match(await readBody(res), /__DSH_BOOT__/);

  const forwarded = child.seen[1]; // [0] is the token login
  assert.equal(forwarded.host, authority, 'Host must be rewritten to the child authority');
  assert.equal(forwarded.origin, `http://${authority}`, 'Origin must be rewritten to the child origin');
  assert.equal(forwarded.cookie, 'dsh-auth=first', 'cookie rides the proxy leg, not the browser');
  assert.ok(!forwarded.url.includes('token'), 'launch token never reaches the iframe-side path');
});

test('proxy streams SSE incrementally instead of buffering the response', async (t) => {
  const child = startFakeChild();
  let firstChunkSeen = null;
  child.state.onStream = (res) => {
    res.write('data: part1\n\n');
    Promise.resolve(firstChunkSeen).then(() => {
      res.write('data: part2\n\n');
      res.end();
    });
  };
  await listen(child.server);
  t.after(() => { child.server.closeAllConnections(); child.server.close(); });

  const proxy = createWebEmbedProxy();
  const proxyUrl = await proxy.start(`http://127.0.0.1:${child.server.address().port}/?token=synthetic`); // allow-secret-scan
  t.after(() => proxy.close());

  let resolveFirst;
  firstChunkSeen = new Promise((resolve) => { resolveFirst = resolve; });
  const res = await request(`${proxyUrl}/stream`, { headers: { host: new URL(proxyUrl).host } });
  assert.match(res.headers['content-type'], /text\/event-stream/);
  const body = await new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', (chunk) => {
      chunks.push(chunk);
      if (chunk.toString().includes('part1')) resolveFirst();
    });
    res.on('end', () => resolve(chunks.join('')));
    res.on('error', reject);
  });
  // part2 only left the child after the client saw part1: a buffering proxy
  // would have deadlocked on firstChunkSeen instead of finishing.
  assert.equal(body, 'data: part1\n\ndata: part2\n\n');
});

test('a 401 re-mints the cookie so later requests recover', async (t) => {
  const child = startFakeChild();
  await listen(child.server);
  t.after(() => { child.server.closeAllConnections(); child.server.close(); });
  const authority = `127.0.0.1:${child.server.address().port}`;

  const proxy = createWebEmbedProxy();
  const proxyUrl = await proxy.start(`http://${authority}/?token=synthetic`); // allow-secret-scan
  t.after(() => proxy.close());

  assert.equal((await request(proxyUrl + '/')).statusCode, 200);
  child.state.cookie = 'dsh-auth=second'; // child restart rotated the secret
  const stale = await request(proxyUrl + '/');
  assert.equal(stale.statusCode, 401, 'the in-flight response still surfaces the 401');
  await new Promise((resolve) => setTimeout(resolve, 50)); // refresh settles
  assert.equal((await request(proxyUrl + '/')).statusCode, 200);
  assert.equal(child.seen[child.seen.length - 1].cookie, 'dsh-auth=second');
});

test('proxy relays the WebSocket upgrade for the Typert remote channel', async (t) => {
  const child = startFakeChild();
  const seenHandshakes = [];
  child.server.on("upgrade", (req, socket, head) => {
    seenHandshakes.push({ url: req.url, host: req.headers.host, origin: req.headers.origin });
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n"
      + "Upgrade: websocket\r\nConnection: Upgrade\r\n"
      + "Sec-WebSocket-Accept: synthetic\r\n\r\n",
    );
    // Echo raw frames back so the relay path is observable end to end.
    socket.pipe(socket);
  });
  await listen(child.server);
  t.after(() => { child.server.closeAllConnections(); child.server.close(); });
  const authority = `127.0.0.1:${child.server.address().port}`;

  const proxy = createWebEmbedProxy();
  const proxyUrl = await proxy.start(`http://${authority}/?token=synthetic`); // allow-secret-scan
  t.after(() => proxy.close());

  const sent = await new Promise((resolve, reject) => {
    const net = require("node:net");
    const socket = net.connect({ host: "127.0.0.1", port: Number(new URL(proxyUrl).port) }, () => {
      socket.write(
        `GET /api/remote.mux HTTP/1.1\r\nhost: ${new URL(proxyUrl).host}\r\n`
        + "upgrade: websocket\r\nconnection: Upgrade\r\n"
        + "sec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
        + `origin: ${proxyUrl}\r\nsec-fetch-site: cross-site\r\n\r\n`,
      );
      setTimeout(() => socket.write("ping-frame"), 100);
    });
    let data = "";
    socket.on("data", (chunk) => { data += chunk.toString("utf8"); });
    socket.setTimeout(1500, () => { socket.destroy(); resolve(data); });
    socket.on("error", reject);
  });

  assert.match(sent, /^HTTP\/1\.1 101 Switching Protocols/, "101 handshake must pass through");
  assert.match(sent, /ping-frame/, "post-handshake bytes must relay both ways");
  assert.equal(seenHandshakes.length, 1);
  assert.equal(seenHandshakes[0].host, authority, "handshake Host must be the child authority");
  assert.equal(seenHandshakes[0].origin, `http://${authority}`, "handshake Origin must be rewritten");
});

test('close releases the loopback listener', async (t) => {
  const child = startFakeChild();
  await listen(child.server);
  t.after(() => { child.server.closeAllConnections(); child.server.close(); });

  const proxy = createWebEmbedProxy();
  const proxyUrl = await proxy.start(`http://127.0.0.1:${child.server.address().port}/?token=synthetic`); // allow-secret-scan
  proxy.close();
  await assert.rejects(
    () => request(proxyUrl + '/'),
    (error) => error.code === 'ECONNREFUSED',
  );
});

test('needsEmbedProxy only matches owned, token-carrying servers', () => {
  assert.equal(needsEmbedProxy({ owned: true, url: 'http://127.0.0.1:3200/?token=x' }), true);
  assert.equal(needsEmbedProxy({ owned: false, url: 'http://127.0.0.1:3200/?token=x' }), false);
  assert.equal(needsEmbedProxy({ owned: true, url: 'http://127.0.0.1:3200/' }), false);
  assert.equal(needsEmbedProxy({ owned: true, url: 'http://127.0.0.1:3200/?token=x#frag' }), false);
  assert.equal(needsEmbedProxy(null), false);
  assert.equal(needsEmbedProxy({ owned: true, url: '::not a url::' }), false);
});
