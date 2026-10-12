'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { mintCookiePair } = require('./dshWebAuth');

/**
 * Embedded-UI transport proxy for fenced DSH runtimes (SM-3).
 *
 * dsh 0.1.2+ authenticates the browser with a signed cookie minted from the
 * launch token (`GET /?token=…` → 303 + `set-cookie`) and marks it
 * `SameSite=Strict`. A VS Code webview serves its HTML from
 * `vscode-webview://<id>`, so the embedded DSH iframe is a CROSS-SITE context:
 * the browser refuses to store/send that cookie there, and the iframe lands on
 * dsh's 401 body ("dsh web authentication required; reopen the URL printed by
 * dsh web"). The token-in-URL variant cannot help either — dsh answers every
 * request carrying a `token` parameter with a 303 to a clean `/`, so the
 * `dsh_embed` / `dsh_session` / `dsh_theme` markers never reach the app.
 *
 * This proxy is the extension host's own loopback server in front of the DSH
 * web server: every request it forwards carries the launch-token cookie and
 * the upstream authority dsh's Host/Origin fence expects, so the browser is
 * never asked to hold a credential. Because the proxy serves `/` directly, the
 * query markers survive into the web app.
 *
 * The iframe is NOT same-origin with the proxy — `vscode-webview://<id>` is
 * cross-site to `http://127.0.0.1:<port>`, so the document load arrives with
 * `sec-fetch-site: cross-site`, the one request shape dsh's own `/api` fence
 * rejects outright (see lib/types/api-request-trust.js in
 * `@deepseek-ai/dsh-client-connection`). That fence can afford to: it guards
 * `/api` for a document dsh itself served, so every legitimate call is
 * same-origin. The proxy cannot copy it verbatim — its own document load is
 * the cross-site request — so the document is instead authenticated with a
 * per-proxy capability (below), exactly as dsh authenticates its own index
 * with the launch token rather than with the `/api` fence.
 *
 * Access control: loopback bind only. The Host header must name a loopback
 * authority (a DNS-rebinding page reaching 127.0.0.1 still carries its own
 * name there). A request presenting the embed capability — the random value
 * the extension host puts in the embed URL, which no other page can know — is
 * the extension's own iframe and is admitted. Everything else keeps dsh's
 * `/api` posture: browser-declared cross-site requests (`sec-fetch-site:
 * cross-site`) and an `Origin` that does not name the authority the request
 * was addressed to are rejected. Since the app is served from the proxy, its
 * own API/XHR/WebSocket traffic is same-origin and stays inside that fence.
 *
 * The capability travels in the embed URL's query (`dsh_gate=…`) and is
 * stripped before the upstream hop, so the DSH server never sees it.
 */

/**
 * Query parameter carrying the per-proxy embed capability. It rides the embed
 * URL the extension host hands the webview and is stripped before the upstream
 * hop, so it never reaches the DSH server.
 */
const EMBED_CAPABILITY_PARAM = 'dsh_gate';

/** Hop-by-hop headers never forwarded in either direction (RFC 9110 §7.6.1). */
const HOP_BY_HOP_HEADERS = Object.freeze([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * True for Host header values naming a loopback authority.
 *
 * @param {string} host - Raw Host header (`host`, `host:port`, `[::1]:port`).
 * @returns {boolean} True when the hostname is loopback.
 */
function isLoopbackHostHeader(host) {
  if (typeof host !== 'string' || host.length === 0) return false;
  const name = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : host.split(':', 1)[0];
  const lowered = name.toLowerCase();
  return lowered === '127.0.0.1' || lowered === 'localhost' || lowered === '[::1]';
}

/**
 * Canonical `host[:port]` of a Host/Origin authority, or null when unparsable.
 * Both sides go through WHATWG parsing so case and a written default port
 * never decide trust.
 *
 * @param {string} authority - Raw authority (`host`, `host:port`, `[::1]:port`).
 * @returns {string|null}
 */
function canonicalAuthority(authority) {
  try {
    return new URL(`http://${String(authority).trim()}`).host;
  } catch {
    return null;
  }
}

/**
 * Whether one request presents the proxy's embed capability, in its query (the
 * document navigation, which carries the embed URL verbatim) or in the Referer
 * (a reload after the app rewrote its own URL still sends the full same-origin
 * referer).
 *
 * @param {object} headers - Node request headers.
 * @param {string} url - Request URL as received (`/…?…`).
 * @param {string|null} capability - Capability of this proxy, or null.
 * @returns {boolean}
 */
function presentsEmbedCapability(headers, url, capability) {
  if (typeof capability !== 'string' || capability.length === 0) return false;
  const referer = (headers || {}).referer;
  if (typeof referer === 'string' && referer.includes(capability)) return true;
  return typeof url === 'string' && url.includes(capability);
}

/**
 * Drop the embed capability from a request URL before the upstream hop.
 *
 * @param {string} url - Request URL as received.
 * @returns {string} The same URL without the capability parameter.
 */
function withoutEmbedCapability(url) {
  const match = /^([^?#]*)\?([^#]*)$/.exec(String(url === undefined || url === null ? '' : url));
  if (match === null) return url;
  const kept = match[2]
    .split('&')
    .filter((pair) => pair.split('=', 1)[0] !== EMBED_CAPABILITY_PARAM);
  const path = match[1].length > 0 ? match[1] : '/';
  return kept.length > 0 ? `${path}?${kept.join('&')}` : path;
}

/**
 * Decide whether one incoming browser request may use the proxy.
 *
 * @param {object} headers - Node request headers.
 * @param {boolean} [carriesEmbedCapability=false] - Whether the request
 *   presents this proxy's embed capability (see presentsEmbedCapability).
 * @returns {boolean} True when the request is a trusted loopback request.
 */
function isTrustedProxyRequest(headers, carriesEmbedCapability = false) {
  const head = headers || {};
  const host = head.host;
  // The embedded iframe addresses this proxy as loopback, and a DNS-rebinding
  // page cannot: its Host carries the attacker's name (even when the packet
  // lands on 127.0.0.1), so the loopback requirement is what keeps the proxy
  // from becoming an authenticated gateway for a foreign page. It binds every
  // request below, capability or not.
  if (!isLoopbackHostHeader(host)) return false;
  // The capability exists nowhere but the embed URL the extension host minted,
  // so presenting it is proof this is our iframe. Its document load is
  // cross-site by nature (`vscode-webview://<id>` → loopback) and is the one
  // request dsh's own fence shape cannot cover.
  if (carriesEmbedCapability) return true;
  if (head['sec-fetch-site'] === 'cross-site') return false;
  const origin = head.origin;
  if (typeof origin === 'string' && origin.length > 0 && origin !== 'null') {
    // A browser always sends Origin for API POSTs. Mirroring dsh's own fence,
    // the Origin must name the authority this request was addressed to (the
    // Host), not the proxy's listen port: under VS Code port forwarding (WSL,
    // Remote-SSH) asExternalUri re-addresses the proxy as
    // `localhost:<forwarded-port>`, so the listen port is not what the browser
    // sees. Same-site-but-cross-origin pages (another loopback dev server on a
    // different port) miss on the port and are rejected.
    let originHost = null;
    try { originHost = new URL(origin).host; } catch { originHost = null; }
    if (originHost === null || originHost !== canonicalAuthority(host)) return false;
  }
  return true;
}

/**
 * Copy request headers for the upstream hop: hop-by-hop headers dropped, Host
 * re-pointed at the DSH authority, and the browser's Origin/Referer rewritten
 * so dsh's Host/Origin fence sees its own authority (it 403s otherwise).
 *
 * @param {object} headers - Incoming headers.
 * @param {string} upstreamAuthority - `host:port` of the DSH server.
 * @param {string} hostHeader - Incoming Host header.
 * @param {string} cookie - Cookie header value, or '' to attach none.
 * @returns {object} Headers for the upstream request.
 */
function upstreamHeaders(headers, upstreamAuthority, hostHeader, cookie) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.includes(key.toLowerCase())) continue;
    out[key] = value;
  }
  out.host = upstreamAuthority;
  const upstreamOrigin = `http://${upstreamAuthority}`;
  if (typeof out.origin === 'string' && out.origin.length > 0) out.origin = upstreamOrigin;
  if (typeof out.referer === 'string' && typeof hostHeader === 'string' && hostHeader.length > 0) {
    out.referer = out.referer.replace(`http://${hostHeader}`, upstreamOrigin);
  }
  if (cookie) out.cookie = cookie;
  else delete out.cookie;
  return out;
}

/**
 * Copy response headers for the browser hop (hop-by-hop headers dropped).
 *
 * @param {object} headers - Upstream response headers.
 * @returns {object} Headers for the browser response.
 */
function downstreamHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.includes(key.toLowerCase())) continue;
    // The proxy is the browser's origin now: an upstream redirect or cookie
    // must never send the browser back to the raw DSH authority.
    if (key.toLowerCase() === 'set-cookie') continue;
    if (key.toLowerCase() === 'location' && typeof value === 'string') {
      out[key] = value.replace(/^http:\/\/[^/]+/, '');
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Start an authenticating loopback proxy for one DSH server.
 *
 * @param {object} options
 * @param {string} options.upstreamUrl - DSH loopback base URL (`http://127.0.0.1:<port>`).
 * @param {string} options.token - Launch token of that DSH process.
 * @param {Function} [options.fetchImpl] - Fetch used for the token exchange
 *   (defaults to `globalThis.fetch`).
 * @param {object} [options.httpImpl] - `node:http` seam for tests.
 * @param {number} [options.port=0] - Listen port; 0 picks a free one.
 * @param {string} [options.host='127.0.0.1'] - Listen host.
 * @param {string} [options.capability] - Embed capability to require on the
 *   iframe's cross-site document load; minted at random when absent (tests
 *   pin it, the extension never does).
 * @param {(message: string) => void} [options.log] - Optional diagnostics sink.
 * @returns {Promise<object>} Frozen handle `{ url, origin, port, close }`. The
 *   `url` is the embed URL and carries the capability, so embed it verbatim
 *   (it already has a query: append with `&`, never `?`); build anything else —
 *   API paths, probes, the "open in browser" target — from `origin`.
 * @throws {TypeError} When the upstream URL or token is missing/unsupported.
 */
async function startEmbedProxy({
  upstreamUrl,
  token,
  fetchImpl = globalThis.fetch,
  httpImpl = http,
  port = 0,
  host = '127.0.0.1',
  capability = null,
  log = null,
} = {}) {
  let upstream;
  try {
    upstream = new URL(String(upstreamUrl || ''));
  } catch {
    throw new TypeError('embed proxy requires a DSH loopback base URL');
  }
  if (upstream.protocol !== 'http:' || !isLoopbackHostHeader(upstream.host)) {
    throw new TypeError('embed proxy upstream must be an http loopback URL');
  }
  if (typeof token !== 'string' || token.length === 0) {
    throw new TypeError('embed proxy requires the launch token');
  }
  const upstreamAuthority = upstream.host;
  const upstreamOrigin = `http://${upstreamAuthority}`;
  const diagnostics = typeof log === 'function' ? log : () => {};
  // Per-proxy capability: what tells our iframe's cross-site document load
  // apart from any other page that can reach loopback.
  const embedCapability = typeof capability === 'string' && capability.length > 0
    ? capability
    : crypto.randomBytes(24).toString('base64url');

  let cookie = null; // Minted lazily; re-minted once after an upstream 401.
  let minted = false;

  /**
   * Current Cookie header value. Minting is idempotent until `force` is set,
   * which is what heals a cookie the server-side session dropped (dsh restart,
   * expiry) without restarting the proxy.
   */
  async function currentCookie(force = false) {
    if (minted && !force) return cookie;
    cookie = await mintCookiePair({ origin: upstreamOrigin, token, fetchImpl });
    minted = true;
    if (cookie === null) diagnostics('embed proxy: token exchange did not yield a cookie');
    return cookie;
  }

  /** Live sockets (including upgraded tunnels) so close() is decisive. */
  const sockets = new Set();
  const tunnels = new Set();

  const trusts = (req) => isTrustedProxyRequest(
    req.headers,
    presentsEmbedCapability(req.headers, req.url, embedCapability)
  );

  const server = httpImpl.createServer((req, res) => {
    if (!trusts(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('forbidden');
      return;
    }
    forward(req, res, 0);
  });

  /**
   * Forward one HTTP request upstream, retrying exactly once with a freshly
   * minted cookie when dsh answers 401.
   */
  function forward(req, res, attempt) {
    void (async () => {
      const injected = await currentCookie();
      const upstreamRequest = httpImpl.request({
        host: upstream.hostname,
        port: upstream.port,
        method: req.method,
        path: withoutEmbedCapability(req.url),
        headers: upstreamHeaders(req.headers, upstreamAuthority, req.headers.host, injected || ''),
      }, (upstreamResponse) => {
        if (upstreamResponse.statusCode === 401 && attempt === 0) {
          upstreamResponse.resume();
          void currentCookie(true).then(() => forward(req, res, 1));
          return;
        }
        res.writeHead(upstreamResponse.statusCode, downstreamHeaders(upstreamResponse.headers));
        upstreamResponse.pipe(res);
      });
      upstreamRequest.on('error', (error) => {
        diagnostics(`embed proxy: upstream error ${error && error.message ? error.message : String(error)}`);
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('bad gateway');
      });
      req.pipe(upstreamRequest);
    })();
  }

  server.on('upgrade', (req, socket, head) => {
    if (!trusts(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    tunnels.add(socket);
    socket.on('close', () => tunnels.delete(socket));
    const upstreamRequest = httpImpl.request({
      host: upstream.hostname,
      port: upstream.port,
      method: req.method,
      path: withoutEmbedCapability(req.url),
      headers: {
        ...upstreamHeaders(req.headers, upstreamAuthority, req.headers.host, ''),
        connection: 'Upgrade',
        upgrade: req.headers.upgrade || 'websocket',
      },
    });
    void currentCookie().then((injected) => {
      if (injected) upstreamRequest.setHeader('cookie', injected);
      upstreamRequest.end();
    });
    upstreamRequest.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
      tunnels.add(upstreamSocket);
      upstreamSocket.on('close', () => tunnels.delete(upstreamSocket));
      // A tunnel is one unit: either half closing must tear down the peer, or
      // the upstream keeps a half-open socket and never finishes shutting down.
      socket.on('close', () => upstreamSocket.destroy());
      upstreamSocket.on('close', () => socket.destroy());
      const lines = [`HTTP/1.1 ${upstreamResponse.statusCode} ${upstreamResponse.statusMessage}`];
      for (const [key, value] of Object.entries(upstreamResponse.headers)) {
        lines.push(`${key}: ${value}`);
      }
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      if (upstreamHead && upstreamHead.length > 0) socket.write(upstreamHead);
      if (head && head.length > 0) upstreamSocket.write(head);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });
    upstreamRequest.on('response', (upstreamResponse) => {
      // The fence rejected the upgrade (e.g. a stale cookie): surface it as-is.
      const lines = [`HTTP/1.1 ${upstreamResponse.statusCode} ${upstreamResponse.statusMessage}`];
      for (const [key, value] of Object.entries(upstreamResponse.headers)) {
        lines.push(`${key}: ${value}`);
      }
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      upstreamResponse.pipe(socket);
    });
    upstreamRequest.on('error', () => socket.destroy());
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const listeningPort = server.address().port;
  const origin = `http://${host}:${listeningPort}`;

  return Object.freeze({
    // The embed URL carries the capability: callers embed it verbatim and must
    // not hand out a capability-free variant (it would be refused).
    url: `${origin}/?${EMBED_CAPABILITY_PARAM}=${embedCapability}`,
    origin,
    port: listeningPort,
    /** Stop listening and drop every open connection (idempotent). */
    close() {
      for (const socket of tunnels) {
        try { socket.destroy(); } catch { /* already gone */ }
      }
      tunnels.clear();
      for (const socket of sockets) {
        try { socket.destroy(); } catch { /* already gone */ }
      }
      sockets.clear();
      try { server.close(); } catch { /* already closed */ }
    },
  });
}

module.exports = {
  EMBED_CAPABILITY_PARAM,
  HOP_BY_HOP_HEADERS,
  canonicalAuthority,
  isLoopbackHostHeader,
  isTrustedProxyRequest,
  presentsEmbedCapability,
  startEmbedProxy,
  upstreamHeaders,
  withoutEmbedCapability,
};