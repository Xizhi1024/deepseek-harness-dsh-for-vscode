"use strict";

/**
 * Loopback forwarder for the embedded DSH web UI in VS Code webviews.
 *
 * DSH 0.1.2-rc.1+ authenticates the browser with a SameSite=Strict cookie
 * minted from the one-shot launch token. Inside a webview the DSH iframe is a
 * third-party frame (top-level origin vscode-webview://), so Chromium both
 * refuses to store that cookie and refuses to send it — the sidebar renders
 * the DSH 401 body no matter how valid the token is. This proxy removes the
 * browser from the trust chain: the iframe talks to the proxy with no
 * credentials at all, and the proxy attaches the cookie it exchanged in the
 * extension-host process (Node fetch never applies SameSite).
 *
 * Header discipline comes from the child's own browser-trust fence
 * (isTrustedApiRequest): Host must be the child's authority, Origin (when
 * present) must match it, and Sec-Fetch-Site: cross-site is rejected. The
 * iframe sends the proxy's authority in Origin and cross-site fetch markers,
 * so the proxy rewrites/strips exactly those; everything else passes through
 * untouched, bodies and chunked streaming included (events.mux is SSE, the
 * Typert remote channel is a WebSocket at /api/remote.mux and relays as raw
 * sockets).
 *
 * Boundary: the proxy is an unauthenticated loopback door to the extension-
 * owned child — same trust level as the child's pre-auth index. It binds
 * 127.0.0.1 on an ephemeral port, lives for the window, and is replaced on
 * every rebind so it never outlives its target.
 */

const http = require("node:http");
const net = require("node:net");
const { exchangeLaunchCookie } = require("./loopbackAuth");

// Hop-by-hop headers and browser-context markers never forwarded to the child.
const DROP_REQUEST_HEADERS = [
  "host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "cookie", "referer",
  "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "sec-fetch-user",
];
const DROP_RESPONSE_HEADERS = [
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
];

// WebSocket handshake headers relayed verbatim for the Typert remote channel
// (ws://…/api/remote.mux); connection/upgrade are hop-by-hop elsewhere but
// carry the handshake here.
const RELAY_UPGRADE_HEADERS = [
  "upgrade", "connection", "sec-websocket-version", "sec-websocket-key",
  "sec-websocket-protocol", "sec-websocket-extensions", "sec-websocket-compress",
];

/**
 * True for a RunningServer this extension owns whose ready URL carries the
 * per-process launch token (authenticated runtimes). Only those need (and can
 * use) the proxy: reused or tokenless endpoints keep the direct iframe URL.
 * @param {*} server - RunningServer handle.
 * @returns {boolean}
 */
function needsEmbedProxy(server) {
  if (!server || server.owned !== true || typeof server.url !== "string") return false;
  try {
    const parsed = new URL(server.url);
    if (parsed.username || parsed.password || parsed.hash) return false; // same strictness as _readOwnedStartupUrl
    return parsed.searchParams.has("token");
  } catch {
    return false;
  }
}

/**
 * @param {object} [deps] Injectable seams for tests.
 * @param {Function} [deps.fetchImpl] fetch used for the token exchange.
 * @param {object} [deps.httpImpl] http module (request factory).
 * @param {Function} [deps.log] Diagnostic sink for non-fatal failures.
 */
function createWebEmbedProxy({ fetchImpl = globalThis.fetch, httpImpl = http, netImpl = net, log = () => {} } = {}) {
  let server = null;
  let target = null; // { port, authority, origin, launchUrl }
  let cookie = "";
  let refreshInFlight = null;

  function listen() {
    return new Promise((resolve, reject) => {
      const pending = httpImpl.createServer(handle);
      pending.once("error", reject);
      pending.listen(0, "127.0.0.1", () => {
        pending.removeListener("error", reject);
        pending.once("error", () => {}); // post-start errors surface per-request
        if (typeof pending.on === "function") pending.on("upgrade", handleUpgrade);
        resolve(pending);
      });
    });
  }

  /**
   * Relay a WebSocket upgrade (Typert remote channel) as raw sockets: forward
   * the handshake with rewritten fence inputs, then pipe both directions so
   * frames — including permessage-deflate — pass through untouched.
   */
  function handleUpgrade(req, socket, head) {
    if (!target) {
      socket.destroy();
      return;
    }
    const lines = [`${req.method} ${req.url} HTTP/1.1`, `host: ${target.authority}`];
    for (const name of RELAY_UPGRADE_HEADERS) {
      const value = req.headers[name];
      if (value !== undefined) lines.push(`${name}: ${Array.isArray(value) ? value.join(", ") : value}`);
    }
    if (req.headers.origin) lines.push(`origin: ${target.origin}`);
    if (cookie) lines.push(`cookie: ${cookie}`);
    const upstream = netImpl.connect({ host: "127.0.0.1", port: target.port }, () => {
      upstream.write(lines.join("\r\n") + "\r\n\r\n");
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  }

  function refreshCookie() {
    if (!target) return Promise.resolve();
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = exchangeLaunchCookie(target.launchUrl, fetchImpl)
      .then((value) => { cookie = value; })
      .catch((error) => {
        log(`dsh web embed proxy: cookie exchange failed: ${error && error.message}`);
      })
      .finally(() => { refreshInFlight = null; });
    return refreshInFlight;
  }

  function forwardHeaders(req) {
    const headers = { ...req.headers };
    for (const name of DROP_REQUEST_HEADERS) delete headers[name];
    headers.host = target.authority; // cookie audience + loopback fence
    if (req.headers.origin) headers.origin = target.origin; // same-origin marker
    if (cookie) headers.cookie = cookie;
    return headers;
  }

  function handle(req, res) {
    if (!target) {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      res.end("dsh web embed proxy: no target\n");
      return;
    }
    const upstream = httpImpl.request(
      { host: "127.0.0.1", port: target.port, method: req.method, path: req.url, headers: forwardHeaders(req) },
      (up) => {
        const headers = { ...up.headers };
        for (const name of DROP_RESPONSE_HEADERS) delete headers[name];
        res.writeHead(up.statusCode, headers);
        up.pipe(res);
        // The cookie dies with a child restart; re-mint so the requests after
        // this one recover while this response still surfaces the 401.
        if (up.statusCode === 401) refreshCookie();
      },
    );
    upstream.on("error", (error) => {
      if (res.headersSent) res.destroy();
      else {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end(`dsh web embed proxy: upstream unavailable (${error && error.code || "error"})\n`);
      }
    });
    req.pipe(upstream);
  }

  return {
    /** Proxy origin once started (null before). */
    get url() {
      return server ? `http://127.0.0.1:${server.address().port}` : null;
    },
    /** Bind the loopback listener and point it at the child launch URL. */
    async start(launchUrl) {
      if (server) throw new Error("dsh web embed proxy already started");
      server = await listen();
      await this.setTarget(launchUrl);
      return this.url;
    },
    /** Retarget (child restart moved port/token) and re-exchange the cookie. */
    async setTarget(launchUrl) {
      const base = new URL(launchUrl);
      target = {
        port: Number(base.port),
        authority: base.host,
        origin: base.origin,
        launchUrl: base.toString(),
      };
      cookie = "";
      await refreshCookie();
    },
    close() {
      if (!server) return;
      try {
        if (typeof server.closeAllConnections === "function") server.closeAllConnections();
        server.close();
      } catch {
        // already closing
      }
      server = null;
      target = null;
      cookie = "";
    },
  };
}

module.exports = { createWebEmbedProxy, needsEmbedProxy };
