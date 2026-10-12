'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const {
  EMBED_CAPABILITY_PARAM,
  isLoopbackHostHeader,
  isTrustedProxyRequest,
  presentsEmbedCapability,
  startEmbedProxy,
  upstreamHeaders,
  withoutEmbedCapability,
} = require('../../src/embedProxy');

const TOKEN = 'launch-token';
const COOKIE = 'dsh-auth-test=good';
const CAPABILITY = 'gate-capability-for-tests';

/** The header set a Chromium webview sends for the embedded iframe's load. */
const WEBVIEW_NAVIGATION_HEADERS = Object.freeze({
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Code/1.104 Chrome/140 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'upgrade-insecure-requests': '1',
  'sec-fetch-site': 'cross-site',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'iframe',
  referer: 'vscode-webview://0a1b2c3d-4e5f-6789-abcd-ef0123456789/index.html',
});

/**
 * Fenced dsh stand-in: 401 without the browser cookie, index/API with it, and
 * a WebSocket upgrade behind the same cookie. `token` drives the token
 * exchange (`GET /?token=…` → 303 + set-cookie), so the proxy's minting path
 * is exercised for real.
 */
function createFencedUpstream({ acceptToken = TOKEN, cookieValue = COOKIE, requireCookieOnce = false } = {}) {
  const seen = [];
  let cookieRequired = true;
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://upstream.invalid');
    if (req.method === 'GET' && url.searchParams.get('token') !== null) {
      if (url.searchParams.get('token') !== acceptToken) {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('dsh web authentication required; reopen the URL printed by dsh web.\n');
        return;
      }
      res.writeHead(303, { 'location': '/', 'set-cookie': `${cookieValue}; Path=/; HttpOnly; SameSite=Strict` });
      res.end();
      return;
    }
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    const authenticated = cookieRequired && req.headers.cookie === cookieValue;
    if (!authenticated) {
      if (requireCookieOnce) cookieRequired = false; // first hit fails, retry must succeed
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('dsh web authentication required; reopen the URL printed by dsh web.\n');
      return;
    }
    if (url.pathname === '/echo') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><script>window.__DSH_BOOT__={}</script>');
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (req, socket) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, upgrade: true });
    if (req.headers.cookie !== cookieValue) {
      socket.end('HTTP/1.1 401 Unauthorized\r\ncontent-type: text/plain\r\n\r\nunauthorized');
      return;
    }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n');
    socket.on('data', (chunk) => socket.write(chunk)); // echo
  });
  /** Hard stop: an upgraded socket is not covered by closeAllConnections(). */
  server.destroyAll = () => {
    for (const socket of sockets) {
      try { socket.destroy(); } catch { /* already gone */ }
    }
    sockets.clear();
  };
  return { server, seen };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve) => {
    server.destroyAll?.();
    if (!server.listening) return resolve();
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

test('headers helper strips hop-by-hop headers and re-points Host/Origin upstream', () => {
  const out = upstreamHeaders(
    {
      host: '127.0.0.1:5000',
      origin: 'http://127.0.0.1:5000',
      referer: 'http://127.0.0.1:5000/index.html',
      connection: 'keep-alive',
      'transfer-encoding': 'chunked',
      'content-type': 'application/json',
    },
    '127.0.0.1:3080',
    '127.0.0.1:5000',
    COOKIE
  );
  assert.strictEqual(out.host, '127.0.0.1:3080');
  assert.strictEqual(out.origin, 'http://127.0.0.1:3080');
  assert.strictEqual(out.referer, 'http://127.0.0.1:3080/index.html');
  assert.strictEqual(out.cookie, COOKIE);
  assert.strictEqual(out.connection, undefined);
  assert.strictEqual(out['transfer-encoding'], undefined);
  assert.strictEqual(out['content-type'], 'application/json');
});

test('proxy request trust mirrors the browser-trust fence', () => {
  assert.strictEqual(isLoopbackHostHeader('127.0.0.1:5000'), true);
  assert.strictEqual(isLoopbackHostHeader('localhost'), true);
  assert.strictEqual(isLoopbackHostHeader('[::1]:5000'), true);
  assert.strictEqual(isLoopbackHostHeader('evil.example:5000'), false);
  assert.strictEqual(isTrustedProxyRequest({ host: '127.0.0.1:5000' }), true);
  assert.strictEqual(isTrustedProxyRequest({ host: '127.0.0.1:5000', origin: 'http://127.0.0.1:5000' }), true);
  assert.strictEqual(isTrustedProxyRequest({ host: 'evil.example', origin: 'https://evil.example' }), false);
  assert.strictEqual(isTrustedProxyRequest({ host: '127.0.0.1:5000', 'sec-fetch-site': 'cross-site' }), false);
  assert.strictEqual(
    isTrustedProxyRequest({ host: 'evil.example:5000' }),
    false,
    'DNS rebinding: a foreign Host must never authenticate through the proxy'
  );
  assert.strictEqual(isTrustedProxyRequest({ host: 'evil.example:6000' }), false);
  assert.strictEqual(
    isTrustedProxyRequest({ host: 'evil.example:5000' }, true),
    false,
    'DNS rebinding: the embed capability must not excuse a foreign Host either'
  );
});

test('the Origin must name the authority the request was addressed to', () => {
  // VS Code port forwarding (WSL / Remote-SSH) re-addresses the proxy as
  // localhost:<forwarded-port>, so the proxy's own listen port is NOT what the
  // browser sees. The request's Host is.
  assert.strictEqual(
    isTrustedProxyRequest({
      host: 'localhost:61234',
      origin: 'http://localhost:61234',
      'sec-fetch-site': 'same-origin',
    }),
    true,
    'a forwarded authority is the same-origin authority'
  );
  assert.strictEqual(
    isTrustedProxyRequest({
      host: '127.0.0.1:5000',
      origin: 'http://127.0.0.1:5001',
      'sec-fetch-site': 'same-site',
    }),
    false,
    'same-site-but-cross-origin (another loopback server on a different port) must not ride the proxy'
  );
  assert.strictEqual(
    isTrustedProxyRequest({ host: '127.0.0.1:5000', origin: 'vscode-webview://abc' }),
    false,
    'a webview origin without the capability is not the same origin'
  );
});

test('the embed capability is read from the query or the referer, and stripped upstream', () => {
  assert.strictEqual(
    presentsEmbedCapability({}, `/?${EMBED_CAPABILITY_PARAM}=${CAPABILITY}&dsh_embed=vscode`, CAPABILITY),
    true
  );
  assert.strictEqual(
    presentsEmbedCapability({ referer: `http://127.0.0.1:5000/?${EMBED_CAPABILITY_PARAM}=${CAPABILITY}` }, '/', CAPABILITY),
    true,
    'a reload after the app rewrote its URL still carries the capability in the referer'
  );
  assert.strictEqual(presentsEmbedCapability({}, '/?dsh_embed=vscode', CAPABILITY), false);
  assert.strictEqual(presentsEmbedCapability({}, `/?${EMBED_CAPABILITY_PARAM}=other`, CAPABILITY), false);
  assert.strictEqual(presentsEmbedCapability({}, '/', null), false);

  assert.strictEqual(
    withoutEmbedCapability(`/?${EMBED_CAPABILITY_PARAM}=${CAPABILITY}&dsh_embed=vscode&dsh_session=s-1`),
    '/?dsh_embed=vscode&dsh_session=s-1',
    'the capability must never reach the DSH server, other markers must survive verbatim'
  );
  assert.strictEqual(withoutEmbedCapability(`/?${EMBED_CAPABILITY_PARAM}=${CAPABILITY}`), '/');
  assert.strictEqual(withoutEmbedCapability('/api/session/list'), '/api/session/list');
  assert.strictEqual(withoutEmbedCapability('/'), '/');
});

test('embedded UI loads through the proxy with the minted cookie and keeps query markers', async (t) => {
  const upstream = createFencedUpstream();
  await listen(upstream.server);
  t.after(() => close(upstream.server));

  const proxy = await startEmbedProxy({
    upstreamUrl: `http://127.0.0.1:${upstream.server.address().port}`,
    token: TOKEN,
  });
  t.after(() => proxy.close());

  const response = await fetch(`${proxy.url}&dsh_embed=vscode&dsh_session=s-1`);
  const body = await response.text();
  assert.strictEqual(response.status, 200, 'the caller carries no cookie at all');
  assert.ok(body.includes('__DSH_BOOT__'));

  const request = upstream.seen.at(-1);
  assert.strictEqual(request.url, '/?dsh_embed=vscode&dsh_session=s-1', 'markers survive (no token redirect)');
  assert.strictEqual(request.headers.cookie, COOKIE, 'the proxy injects the launch-token cookie');
  assert.strictEqual(request.headers.host, `127.0.0.1:${upstream.server.address().port}`);
});

test('API calls through the proxy are authenticated and same-origin upstream', async (t) => {
  const upstream = createFencedUpstream();
  await listen(upstream.server);
  t.after(() => close(upstream.server));

  const proxy = await startEmbedProxy({
    upstreamUrl: `http://127.0.0.1:${upstream.server.address().port}`,
    token: TOKEN,
  });
  t.after(() => proxy.close());

  const response = await fetch(`${proxy.origin}/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: proxy.origin },
    body: '{"type":"client-request"}',
  });
  assert.strictEqual(response.status, 200);
  const echoed = await response.json();
  assert.strictEqual(echoed.method, 'POST');
  assert.strictEqual(echoed.headers.cookie, COOKIE);
  assert.strictEqual(echoed.headers.origin, `http://127.0.0.1:${upstream.server.address().port}`,
    'dsh Host/Origin fence must see its own authority');
});

test('the embedded iframe loads cross-site through the proxy, capability included', async (t) => {
  const upstream = createFencedUpstream();
  await listen(upstream.server);
  t.after(() => close(upstream.server));

  const proxy = await startEmbedProxy({
    upstreamUrl: `http://127.0.0.1:${upstream.server.address().port}`,
    token: TOKEN,
    capability: CAPABILITY,
  });
  t.after(() => proxy.close());
  assert.ok(
    proxy.url.includes(`${EMBED_CAPABILITY_PARAM}=${CAPABILITY}`),
    'the embed URL must carry the capability callers embed verbatim'
  );

  // A VS Code webview document is `vscode-webview://<id>`: the iframe load is
  // cross-site, which is exactly what used to be answered with "forbidden".
  const response = await fetch(`${proxy.url}&dsh_embed=vscode&dsh_session=s-1`, {
    headers: WEBVIEW_NAVIGATION_HEADERS,
  });
  assert.strictEqual(response.status, 200);
  assert.ok((await response.text()).includes('__DSH_BOOT__'));

  const request = upstream.seen.at(-1);
  assert.strictEqual(request.url, '/?dsh_embed=vscode&dsh_session=s-1', 'markers survive, capability stripped');
  assert.strictEqual(request.headers.cookie, COOKIE);
});

test('the proxy rejects cross-site and foreign-origin requests before touching upstream', async (t) => {
  const upstream = createFencedUpstream();
  await listen(upstream.server);
  t.after(() => close(upstream.server));

  const proxy = await startEmbedProxy({
    upstreamUrl: `http://127.0.0.1:${upstream.server.address().port}`,
    token: TOKEN,
    capability: CAPABILITY,
  });
  t.after(() => proxy.close());
  const seenBefore = upstream.seen.length;

  // A hostile page cannot hold the capability, so its requests arrive without
// it: those keep the plain browser-trust fence.
  const evilOrigin = await fetch(`${proxy.origin}/`, { headers: { origin: 'https://evil.example' } });
  assert.strictEqual(evilOrigin.status, 403);
  // The capability is what admits a cross-site load; without it — a hostile
  // page's iframe, form post or CORS call — the request is refused.
  const crossSite = await fetch(`${proxy.origin}/echo`, {
    method: 'POST',
    headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.strictEqual(crossSite.status, 403);
  const crossSiteNavigation = await fetch(`${proxy.origin}/`, { headers: WEBVIEW_NAVIGATION_HEADERS });
  assert.strictEqual(crossSiteNavigation.status, 403, 'a capability-free cross-site load is not our iframe');
  const wrongCapability = await fetch(`${proxy.origin}/?${EMBED_CAPABILITY_PARAM}=guessed`, {
    headers: WEBVIEW_NAVIGATION_HEADERS,
  });
  assert.strictEqual(wrongCapability.status, 403);
  assert.strictEqual(upstream.seen.length, seenBefore, 'rejected requests never reach dsh');
});

test('the app keeps working when port forwarding re-addresses the proxy', async (t) => {
  // WSL / Remote-SSH: asExternalUri hands the webview `localhost:<forwarded>`
  // while the proxy listens on its own loopback port behind the forwarder, so
  // the app's same-origin calls carry a Host/Origin pair naming neither the
  // listen port nor 127.0.0.1.
  const upstream = createFencedUpstream();
  await listen(upstream.server);
  t.after(() => close(upstream.server));

  const proxy = await startEmbedProxy({
    upstreamUrl: `http://127.0.0.1:${upstream.server.address().port}`,
    token: TOKEN,
    capability: CAPABILITY,
  });
  t.after(() => proxy.close());

  const forwarded = 'localhost:61234';
  const response = await new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: proxy.port,
      path: '/echo',
      method: 'POST',
      headers: {
        host: forwarded,
        origin: `http://${forwarded}`,
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'content-type': 'application/json',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end('{"type":"client-request"}');
  });

  assert.strictEqual(response.status, 200, 'the forwarded authority is the same-origin authority');
  assert.strictEqual(
    JSON.parse(response.body).headers.cookie,
    COOKIE,
    'the authenticated call still reaches dsh'
  );
});

test('a stale cookie is re-minted once and the request retried', async (t) => {
  const upstream = createFencedUpstream({ requireCookieOnce: true });
  await listen(upstream.server);
  t.after(() => close(upstream.server));

  const proxy = await startEmbedProxy({
    upstreamUrl: `http://127.0.0.1:${upstream.server.address().port}`,
    token: TOKEN,
  });
  t.after(() => proxy.close());

  const response = await fetch(proxy.url);
  assert.strictEqual(response.status, 200, 'the 401 must heal through a forced re-exchange');
  assert.ok((await response.text()).includes('__DSH_BOOT__'));
});

test('WebSocket streams tunnel through the proxy with the injected cookie', async (t) => {
  const upstream = createFencedUpstream();
  await listen(upstream.server);
  t.after(() => close(upstream.server));

  const proxy = await startEmbedProxy({
    upstreamUrl: `http://127.0.0.1:${upstream.server.address().port}`,
    token: TOKEN,
  });
  t.after(() => proxy.close());

  const received = await new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: proxy.port,
      path: '/api/remote.mux',
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        origin: proxy.origin,
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13',
      },
    });
    request.on('upgrade', (response, socket) => {
      socket.write('ping-frame');
      socket.once('data', (chunk) => {
        socket.destroy();
        resolve({ status: response.statusCode, echoed: chunk.toString() });
      });
    });
    request.on('response', (response) => reject(new Error(`upgrade rejected with ${response.statusCode}`)));
    request.on('error', reject);
    request.end();
  });

  assert.strictEqual(received.status, 101);
  assert.strictEqual(received.echoed, 'ping-frame', 'data flows through the tunnel');
  const upgrade = upstream.seen.find((entry) => entry.upgrade === true);
  assert.strictEqual(upgrade.headers.cookie, COOKIE, 'the upgrade carries the cookie');
});

test('close() stops listening and unsupported upstreams are refused', async (t) => {
  const upstream = createFencedUpstream();
  await listen(upstream.server);
  t.after(() => close(upstream.server));

  const proxy = await startEmbedProxy({
    upstreamUrl: `http://127.0.0.1:${upstream.server.address().port}`,
    token: TOKEN,
  });
  assert.strictEqual((await fetch(proxy.url)).status, 200);
  proxy.close();
  await assert.rejects(fetch(proxy.url));

  await assert.rejects(
    startEmbedProxy({ upstreamUrl: 'http://example.com:3080', token: TOKEN }),
    /loopback/
  );
  await assert.rejects(
    startEmbedProxy({ upstreamUrl: `http://127.0.0.1:${upstream.server.address().port}`, token: '' }),
    /launch token/
  );
});