"use strict";

/**
 * Per-extension-host loopback bridge for opening a DSH-owned text document
 * in the exact VS Code window that owns the managed DSH child.
 *
 * DSH cannot call vscode.window APIs directly, and `code --reuse-window`
 * cannot identify one window when several profiles/remotes are active. This
 * bridge binds an ephemeral loopback port, requires a random bearer token,
 * and delegates the validated absolute path to an injected VS Code callback.
 */
const http = require("node:http");
const crypto = require("node:crypto");
const path = require("node:path");

const ROUTE = "/open-text-document";
const MAX_BODY_BYTES = 64 * 1024;

function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function tokenMatches(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function respond(res, status, message = "") {
  const body = message ? Buffer.from(message, "utf8") : Buffer.alloc(0);
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": String(body.length),
    "Connection": "close",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function readRequestBody(req) {
  const declared = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    const err = new Error("request body too large");
    err.status = 413;
    throw err;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const err = new Error("request body too large");
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Start one authenticated bridge.
 * @param {object} options
 * @param {(absolutePath: string) => Promise<void>} options.openTextDocument
 * @param {string} [options.token] deterministic seam for standalone tests.
 * @returns {Promise<{env: object, close: () => Promise<void>}>}
 */
async function startTextDocumentBridge({ openTextDocument, token } = {}) {
  if (typeof openTextDocument !== "function") {
    throw new TypeError("openTextDocument callback is required");
  }
  const bearer = token || crypto.randomBytes(32).toString("base64url");

  const server = http.createServer(async (req, res) => {
    try {
      if (!isLoopback(req.socket.remoteAddress)) {
        respond(res, 403, "loopback requests only");
        return;
      }
      const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
      if (pathname !== ROUTE) {
        respond(res, 404, "not found");
        return;
      }
      if (req.method !== "POST") {
        respond(res, 405, "POST required");
        return;
      }
      const authorization = req.headers.authorization || "";
      const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      if (!tokenMatches(supplied, bearer)) {
        respond(res, 401, "invalid bridge token");
        return;
      }

      let payload;
      try {
        payload = JSON.parse(await readRequestBody(req));
      } catch (err) {
        respond(res, Number(err && err.status) || 400, "invalid request body");
        return;
      }
      if (!payload || typeof payload.path !== "string" || !path.isAbsolute(payload.path)) {
        respond(res, 400, "an absolute path is required");
        return;
      }

      await openTextDocument(payload.path);
      respond(res, 204);
    } catch (err) {
      console.error("dsh-vs-sidebar: text-document bridge failed:", err);
      if (!res.headersSent) respond(res, 500, "open failed");
      else res.end();
    }
  });
  server.on("clientError", (_err, socket) => {
    try { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); } catch (_) { /* closed */ }
  });

  await new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
  server.unref();
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("text-document bridge did not receive a TCP address");
  }

  let closing = null;
  return Object.freeze({
    env: Object.freeze({
      DSH_VSCODE_OPEN_URL: `http://127.0.0.1:${address.port}${ROUTE}`,
      DSH_VSCODE_OPEN_TOKEN: bearer,
    }),
    close() {
      if (closing) return closing;
      if (!server.listening) return Promise.resolve();
      closing = new Promise((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
      return closing;
    },
  });
}

module.exports = { startTextDocumentBridge, isLoopback, tokenMatches };

if (require.main === module) {
  const assert = require("node:assert");
  (async () => {
    const opened = [];
    const bridge = await startTextDocumentBridge({
      token: "test-token",
      openTextDocument: async (value) => { opened.push(value); },
    });
    const absolute = path.resolve(process.cwd(), "settings.yaml");

    const unauthorized = await fetch(bridge.env.DSH_VSCODE_OPEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: absolute }),
    });
    assert.strictEqual(unauthorized.status, 401);

    const relative = await fetch(bridge.env.DSH_VSCODE_OPEN_URL, {
      method: "POST",
      headers: {
        "Authorization": "Bearer test-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path: "settings.yaml" }),
    });
    assert.strictEqual(relative.status, 400);

    const accepted = await fetch(bridge.env.DSH_VSCODE_OPEN_URL, {
      method: "POST",
      headers: {
        "Authorization": "Bearer test-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path: absolute }),
    });
    assert.strictEqual(accepted.status, 204);
    assert.deepStrictEqual(opened, [absolute]);

    await bridge.close();
    console.log("Text-document bridge self-test passed.");
  })().catch((err) => {
    console.error("Text-document bridge self-test FAILED:", err);
    process.exitCode = 1;
  });
}
