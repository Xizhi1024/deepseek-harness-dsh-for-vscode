"use strict";

const {
  CHANNELS,
  MESSAGE_TYPES,
  REQUEST_ID,
  VERSIONS,
} = require("./protocol/webview");
const { DSH_THEME_CHANGED } = require("./webviewMessages");

/**
 * Escapes a value for safe interpolation into HTML text content or an
 * attribute value (prevents markup injection from server-provided strings).
 *
 * @param {*} value - Value to escape; null/undefined become an empty string.
 * @returns {string} HTML-escaped string.
 */
function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * JSON string suitable for embedding in an inline <script> block. `<` is
 * escaped so a constant value can never terminate the script element.
 */
function safeScriptJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * Content Security Policy meta tag used by both generated webview pages.
 *
 * The policy intentionally keeps the existing inline <style>/<script> blocks
 * working while denying everything not needed by the webview shell:
 *   - default-src 'none'  -> no network/image/font/connect/etc. by default
 *   - base-uri 'none'     -> no <base> URL rewriting
 *   - style-src 'unsafe-inline' -> inline styles used by the status/frame pages
 *   - script-src 'unsafe-inline' -> inline script used to wire webview buttons
 *   - frame-src http: https: -> the embedded DSH iframe must keep working in
 *     local (http://127.0.0.1) and remote/asExternalUri (https://...) scenarios
 *   - img-src data:       -> allow the minimal data-image case if a caller
 *     supplies a data: image; the current pages do not rely on it
 *
 * This CSP governs only the webview shell document; it does not apply to the
 * DSH content inside the iframe (the iframe has its own origin/response).
 */
const WEBVIEW_CSP_META = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; base-uri \'none\'; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'; frame-src http: https:; img-src data:;">';

/**
 * Returns a URL only when it is absolute http(s); otherwise returns the safe
 * `about:blank` sentinel. Used before embedding or linking so a malformed or
 * non-http(s) value (e.g. `javascript:`, `data:`, protocol-relative) can never
 * become an active iframe/link target.
 *
 * @param {*} value - Candidate URL.
 * @returns {string} The original http(s) URL or `about:blank`.
 */
function safeHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return String(value || "");
    }
  } catch {
    // fall through to about:blank
  }
  return "about:blank";
}

/**
 * Adds the DSH compact-layout marker to an iframe URL while preserving any
 * existing query parameters and fragment. When a valid session id is supplied
 * the `dsh_session` query parameter is added as well; invalid session ids are
 * ignored so the iframe simply opens the DSH default session. When a valid
 * theme (`dark` or `light`) is supplied the `dsh_theme` query parameter is
 * added so the DSH web UI can follow the VS Code color theme; any other value
 * is ignored so older DSH builds keep their existing URL exactly. Invalid or
 * non-http(s) URLs are returned as `about:blank` so the webview's normal
 * fallback UI remains responsible for the failure.
 *
 * @param {string} url - Externalized DSH URL.
 * @param {string} [sessionId] - Optional DSH session id.
 * @param {string} [theme] - Optional `dark` or `light` theme marker.
 * @returns {string} URL carrying the VS Code embed marker.
 */
function withVscodeEmbedMode(url, sessionId = undefined, theme = undefined) {
  const safe = safeHttpUrl(url);
  if (safe === "about:blank") return safe;
  try {
    const parsed = new URL(safe);
    parsed.searchParams.set("dsh_embed", "vscode");
    if (
      typeof sessionId === "string"
      && sessionId.length > 0
      && sessionId.length <= 200
      && !sessionId.includes("\0")
    ) {
      parsed.searchParams.set("dsh_session", sessionId);
    }
    if (theme === "dark" || theme === "light") {
      parsed.searchParams.set("dsh_theme", theme);
    }
    return parsed.toString();
  } catch {
    return "about:blank";
  }
}

/**
 * Renders a full HTML document that shows a centered status card
 * (loading / error / retry states) inside the DSH sidebar webview.
 *
 * The card is dark-theme friendly: it uses CSS variables from the VS Code
 * theme when available and falls back to neutral colors otherwise. Buttons
 * are optional and post a message back to the extension through the VS Code
 * webview API:
 *   - { type: "openBrowser" }  -> ask the extension to open DSH in a browser
 *   - { type: "retry" }        -> ask the extension to retry connecting
 *
 * @param {object} options
 * @param {string} options.title - Heading shown on the card.
 * @param {string} options.detail - Secondary detail text under the heading.
 * @param {string} [options.url] - DSH URL to display on the card (optional).
 * @param {boolean} [options.showOpenBrowser] - Render the "open in browser" button.
 * @param {boolean} [options.showRetry] - Render the "retry" button.
 * @param {string} [options.openBrowserLabel] - Label of the open-in-browser button.
 * @param {string} [options.retryLabel] - Label of the retry button.
 * @param {string} [options.lang] - HTML lang attribute (default "en").
 * @returns {string} Complete standalone HTML document.
 */
function statusPage({
  title,
  detail,
  url,
  showOpenBrowser = false,
  showRetry = false,
  openBrowserLabel = "Open in browser",
  retryLabel = "Retry",
  lang = "en",
} = {}) {
  const buttons = [];
  if (showOpenBrowser) {
    buttons.push('<button type="button" class="btn" id="btn-open-browser">' + escapeHtml(openBrowserLabel) + "</button>");
  }
  if (showRetry) {
    buttons.push('<button type="button" class="btn" id="btn-retry">' + escapeHtml(retryLabel) + "</button>");
  }
  const urlLine = url
    ? '<code class="url">' + escapeHtml(url) + "</code>"
    : "";

  return `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${WEBVIEW_CSP_META}
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    display: flex; align-items: center; justify-content: center;
    font-family: var(--vscode-font-family, -apple-system, "Segoe UI", sans-serif);
    background: transparent;
    color: var(--vscode-foreground, #cccccc);
  }
  .card {
    max-width: 420px; margin: 16px; padding: 24px;
    border: 1px solid var(--vscode-panel-border, #3c3c3c);
    border-radius: 8px;
    background: var(--vscode-editor-background, #1e1e1e);
    text-align: center;
  }
  h1 { margin: 0 0 8px; font-size: 16px; font-weight: 600; }
  p { margin: 0 0 10px; font-size: 13px; opacity: 0.85; word-break: break-word; white-space: pre-wrap; }
  code.url {
    display: inline-block; margin-bottom: 12px;
    font-size: 12px; opacity: 0.7; word-break: break-all;
  }
  .btn {
    margin: 4px 6px; padding: 6px 14px; font-size: 13px;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 4px; cursor: pointer;
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #ffffff);
  }
  .btn:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
</style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(detail)}</p>
    ${urlLine}
    <div class="actions">${buttons.join("")}</div>
  </div>
  <script>
    const v = acquireVsCodeApi();
    const openBtn = document.getElementById("btn-open-browser");
    const retryBtn = document.getElementById("btn-retry");
    if (openBtn) {
      openBtn.addEventListener("click", () => v.postMessage({ type: "openBrowser" }));
    }
    if (retryBtn) {
      retryBtn.addEventListener("click", () => v.postMessage({ type: "retry" }));
    }
  </script>
</body>
</html>`;
}

/**
 * Renders a full HTML document that embeds the DSH web UI in a full-screen
 * iframe inside the sidebar webview.
 *
 * The iframe is replaced by a fallback message when it fails to load, either
 * on the iframe's "error" event or when no "load" event fires within
 * LOAD_TIMEOUT_MS (about 10 seconds). The fallback shows:
 *   - an "open in browser" link (href = url, target = _blank), and
 *   - a "retry" button that reloads the whole page via location.reload(),
 *     which re-creates the iframe and restarts the load timer.
 *
 * The shell performs an optional Webview handshake: after the iframe loads,
 * the shell sends dshWebviewReady. A modern DSH client answers with
 * dshWebviewHello; the handshake is an enhancement and never a gate, so a
 * v1 client that does not send hello keeps the original passthrough behavior.
 *
 * @param {object} options
 * @param {string} options.url - DSH web URL to embed in the iframe.
 * @param {string} [options.sessionId] - Optional DSH session id for the iframe URL.
 * @param {string} [options.theme] - Optional `dark` or `light` theme marker for the iframe URL.
 * @param {string} [options.failText] - Fallback heading when the iframe cannot load.
 * @param {string} [options.openBrowserLabel] - Label of the open-in-browser link.
 * @param {string} [options.retryLabel] - Label of the retry button.
 * @param {string} [options.lang] - HTML lang attribute (default "en").
 * @returns {string} Complete standalone HTML document.
 */
function framePage({
  url,
  sessionId,
  theme,
  failText = "Failed to load: DSH service unreachable",
  openBrowserLabel = "Open in browser",
  retryLabel = "Retry",
  lang = "en",
} = {}) {
  const safeFrameUrl = escapeHtml(withVscodeEmbedMode(url, sessionId, theme));
  const safeBrowserUrl = escapeHtml(safeHttpUrl(url));
  let frameOrigin = 'null';
  try { frameOrigin = new URL(safeHttpUrl(url)).origin; } catch { /* null sentinel */ }
  const safeFrameOriginScript = JSON.stringify(frameOrigin).replace(/</g, '\\u003c');
  const channelsScript = safeScriptJson(CHANNELS);
  const versionsScript = safeScriptJson(VERSIONS);
  const messageTypesScript = safeScriptJson(MESSAGE_TYPES);
  const requestIdRuleScript = safeScriptJson(REQUEST_ID.source);
  return `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${WEBVIEW_CSP_META}
<style>
  html, body { margin: 0; padding: 0; height: 100%; }
  #frame { position: fixed; inset: 0; width: 100%; height: 100%; border: none; }
  #fallback {
    display: none; position: fixed; inset: 0;
    align-items: center; justify-content: center; flex-direction: column;
    font-family: var(--vscode-font-family, -apple-system, "Segoe UI", sans-serif);
    background: var(--vscode-editor-background, #1e1e1e);
    color: var(--vscode-foreground, #cccccc); text-align: center;
  }
  #fallback.show { display: flex; }
  #fallback p { margin: 0 0 16px; font-size: 14px; }
  #fallback a {
    color: var(--vscode-textLink-foreground, #3794ff);
    text-decoration: none; margin: 0 8px;
  }
  #fallback button {
    margin: 0 8px; padding: 6px 14px; font-size: 13px; cursor: pointer;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 4px;
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #ffffff);
  }
</style>
</head>
<body>
  <iframe id="frame" src="${safeFrameUrl}" allow="clipboard-read; clipboard-write" style="position:fixed;inset:0;width:100%;height:100%;border:none"></iframe>
  <div id="fallback">
    <p>${escapeHtml(failText)}</p>
    <div>
      <a id="fallback-link" href="${safeBrowserUrl}" target="_blank" rel="noopener">${escapeHtml(openBrowserLabel)}</a>
      <button id="fallback-retry" type="button">${escapeHtml(retryLabel)}</button>
    </div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const frame = document.getElementById("frame");
    const fallback = document.getElementById("fallback");
    const CHANNELS = ${channelsScript};
    const VERSIONS = ${versionsScript};
    const MESSAGE_TYPES = ${messageTypesScript};
    const DSH_THEME_CHANGED = ${safeScriptJson(DSH_THEME_CHANGED)};
    const DSH_ORIGIN = ${safeFrameOriginScript};
    const REQUEST_ID = new RegExp(${requestIdRuleScript});
    const BRIDGE_CHANNEL = CHANNELS.INTERACTION;
    const BRIDGE_VERSION = VERSIONS.INTERACTION;
    const THREAD_CHANNEL = CHANNELS.THREAD;
    const THREAD_VERSION = VERSIONS.THREAD;
    const LOAD_TIMEOUT_MS = 10000;
    let loaded = false;
    let helloReceived = false;
    let handshakeMismatch = false;
    const pendingThreadAttachments = new Map();

    function hasValidRequestId(message) {
      return Boolean(message) && typeof message.requestId === 'string' && REQUEST_ID.test(message.requestId);
    }

    function forwardThreadAttachments() {
      if (!loaded || !frame.contentWindow) return;
      for (const message of pendingThreadAttachments.values()) {
        frame.contentWindow.postMessage(message, DSH_ORIGIN);
      }
    }

    function showFallback() {
      if (loaded) { return; }
      frame.remove();
      fallback.classList.add("show");
    }

    function postReady() {
      if (!frame.contentWindow) return;
      frame.contentWindow.postMessage({
        type: MESSAGE_TYPES.READY,
        channel: CHANNELS.INTERACTION,
        version: VERSIONS.INTERACTION,
        capabilities: {},
      }, DSH_ORIGIN);
    }

    frame.addEventListener("load", () => {
      loaded = true;
      postReady();
      forwardThreadAttachments();
    });
    frame.addEventListener("error", showFallback);
    setTimeout(showFallback, LOAD_TIMEOUT_MS);

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (
        event.source === frame.contentWindow
        && event.origin === DSH_ORIGIN
        && message && message.type === MESSAGE_TYPES.HELLO
        && message.channel === CHANNELS.INTERACTION
      ) {
        if (message.version === VERSIONS.INTERACTION) {
          helloReceived = true;
        } else {
          handshakeMismatch = true;
          vscode.postMessage({
            type: MESSAGE_TYPES.HELLO,
            channel: CHANNELS.INTERACTION,
            version: message.version,
            ok: false,
            error: "Webview 桥版本不匹配",
          });
        }
        return;
      }
      if (
        event.source === frame.contentWindow
        && event.origin === DSH_ORIGIN
        && message && message.type === "dshBridge"
        && message.channel === BRIDGE_CHANNEL
        && message.version === BRIDGE_VERSION
        && hasValidRequestId(message)
      ) {
        vscode.postMessage(message);
        return;
      }
      if (
        event.source === frame.contentWindow
        && event.origin === DSH_ORIGIN
        && message && message.type === "dshSessionChanged"
        && typeof message.sessionId === "string"
      ) {
        // In-iframe conversation switch: relay to the host so the changes
        // tree / workspace binding follow without reloading the iframe.
        vscode.postMessage({ type: "dshSessionChanged", sessionId: message.sessionId });
        return;
      }
      if (
        event.source === frame.contentWindow
        && event.origin === DSH_ORIGIN
        && message && message.type === "dshThreadReady"
        && message.channel === THREAD_CHANNEL
        && message.version === THREAD_VERSION
      ) {
        forwardThreadAttachments();
        return;
      }
      if (
        event.source === frame.contentWindow
        && event.origin === DSH_ORIGIN
        && message && message.type === "dshThreadAttachResult"
        && message.channel === THREAD_CHANNEL
        && message.version === THREAD_VERSION
        && hasValidRequestId(message)
      ) {
        pendingThreadAttachments.delete(message.requestId);
        vscode.postMessage(message);
        return;
      }
      if (
        event.source !== frame.contentWindow
        && message && message.type === "dshBridgeResult"
        && message.channel === BRIDGE_CHANNEL
        && message.version === BRIDGE_VERSION
        && hasValidRequestId(message)
      ) {
        frame.contentWindow.postMessage(message, DSH_ORIGIN);
        return;
      }
      if (
        event.source !== frame.contentWindow
        && message && message.type === "dshThreadAttach"
        && message.channel === THREAD_CHANNEL
        && message.version === THREAD_VERSION
        && hasValidRequestId(message)
      ) {
        pendingThreadAttachments.set(message.requestId, message);
        forwardThreadAttachments();
      }
      if (
        event.source !== frame.contentWindow
        && message && message.type === DSH_THEME_CHANGED
        && (message.theme === "dark" || message.theme === "light")
      ) {
        if (!frame.contentWindow) return;
        frame.contentWindow.postMessage({
          type: DSH_THEME_CHANGED,
          theme: message.theme,
        }, DSH_ORIGIN);
        return;
      }
    });

    document.getElementById("fallback-retry").addEventListener("click", () => {
      location.reload();
    });
  </script>
</body>
</html>`;
}

module.exports = {
  statusPage,
  framePage,
  safeHttpUrl,
  withVscodeEmbedMode,
  CHANNELS,
  MESSAGE_TYPES,
  VERSIONS,
};
