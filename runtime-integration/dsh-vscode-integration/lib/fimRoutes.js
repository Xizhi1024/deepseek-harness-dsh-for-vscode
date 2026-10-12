import { timingSafeEqual } from 'node:crypto';

import { createRuntimeConfig } from './runtimeConfig.js';

// ---------------------------------------------------------------------------
// DSH side of tab completion: POST /api/fim exact WebRoute.
// Auth = Authorization: Bearer <one of the FIM bridge tokens> (injected into
// the DSH spawn env by the extension's tab-completion feature, updatable at
// runtime via POST /api/vscode/configure — see runtimeConfig.js).
// Upstream = an OpenAI-compatible *completions* endpoint (fim.baseUrl,
// full URL, e.g. https://api.deepseek.com/beta/completions) called with a FIM
// prompt; the streamed deltas are re-emitted as SSE frames
// (data: {"text": ...} ... data: [DONE]) that the extension-side
// inlineCompletion parser understands.
//
// The route is ALWAYS mounted (2026-09-19, known-issue #1 fix): the old
// mount-only-when-env-present behavior left tab completion broken on any
// instance whose spawn predated the feature (adopted/shared instances, later
// toggles) with a bare "404 not found" from the /api fetch bridge. Now an
// unconfigured instance answers 503 fim-not-configured with the same
// guidance the extension already surfaces.
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 256 * 1024;
const UPSTREAM_TIMEOUT_MS = 8000;
const DEFAULT_FIM_TEMPLATE = '<｜fim▁begin｜>{prefix}<｜fim▁hole｜>{suffix}<｜fim▁end｜>';

function safeTokenEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    let diff = 0;
    for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
    return diff === 0;
  }
}

function readBearerToken(request) {
  const header = request && request.headers
    ? (request.headers.authorization || request.headers.Authorization || '')
    : '';
  const prefix = 'Bearer ';
  return header.startsWith(prefix) ? header.slice(prefix.length) : '';
}

function writeJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
  });
  response.end(body);
}

// Fault-contained error reply: a throw escaping a WebRoute handler can
// escalate to a boot-level fatal that kills the whole DSH process.
function respondWithError(response, status, code, error) {
  const message = error && error.message ? error.message : String(error);
  try {
    writeJson(response, status, { error: code, message });
  } catch {
    // response already closed or destroyed
  }
}

function readRequestBody(request, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    request.on('data', (chunk) => {
      total += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), 'utf-8');
      if (total > maxBytes) {
        reject(new Error('request body exceeds the limit'));
        return;
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf-8'));
    });
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      try {
        resolve(body.length === 0 ? {} : JSON.parse(body));
      } catch {
        reject(new Error('request body must be valid JSON'));
      }
    });
    request.on('error', reject);
  });
}

function buildPrompt(template, prefix, suffix) {
  return template.replaceAll('{prefix}', prefix).replaceAll('{suffix}', suffix);
}

/** Extract the text fragment from an upstream (OpenAI-compatible) chunk. */
function upstreamChunkText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const choice = Array.isArray(payload.choices) && payload.choices.length > 0 ? payload.choices[0] : null;
  if (!choice || typeof choice !== 'object') {
    return typeof payload.text === 'string' ? payload.text : '';
  }
  if (typeof choice.text === 'string') return choice.text;
  if (choice.delta && typeof choice.delta.content === 'string') return choice.delta.content;
  if (typeof choice.delta === 'string') return choice.delta;
  return '';
}

async function writeSseFrame(response, payload) {
  const body = `data: ${JSON.stringify(payload)}\n\n`;
  const writable = response.write(body);
  if (writable === false) {
    await new Promise((resolve) => response.once('drain', resolve));
  }
}

/**
 * @param {object} deps
 * @param {object} deps.env - env source (DSH_FIM_* bootstrap).
 * @param {object} [deps.config] - runtimeConfig store; when omitted one is
 *   synthesized from env (bootstrap-only, no runtime reconfiguration).
 * @param {object} deps.ctx - DSH plugin context ({ webServer }).
 * @param {Function} [deps.fetchImpl] - injectable fetch (tests).
 * @returns {{dispose: Function, routes: Array<{path: string}>}}
 */
export function createFimRoutes({ env = process.env, config = null, ctx = null, fetchImpl = globalThis.fetch } = {}) {
  if (!ctx || !ctx.webServer || typeof ctx.webServer.register !== 'function') {
    throw new TypeError('createFimRoutes requires ctx.webServer.register');
  }
  const store = config || createRuntimeConfig({ env });
  const disposers = [];
  const routes = [];

  const baseUrl = () => store.fim.baseUrl;
  const apiKey = () => store.fim.apiKey;
  const template = () => store.fim.template;
  const maxTokens = () => store.fim.maxTokens;
  const hasToken = () => store.fim.tokens.size > 0;
  const tokenMatches = (supplied) => {
    for (const token of store.fim.tokens) {
      if (safeTokenEqual(supplied, token)) return true;
    }
    return false;
  };

  function registerRoute(path, handler) {
    const disposer = ctx.webServer.register({ kind: 'exact', path, handler });
    routes.push({ path });
    if (typeof disposer === 'function') disposers.push(disposer);
    else if (disposer && typeof disposer.dispose === 'function') disposers.push(() => disposer.dispose());
  }

  registerRoute('/api/fim', async (request, response) => {
    try {
      if (!hasToken()) {
        // Tab completion was never enabled on this instance (no FIM bridge
        // token from spawn env or a configure push): 503 with the guidance
        // the extension surfaces, instead of the /api fetch bridge's 404.
        writeJson(response, 503, {
          error: 'fim-not-configured',
          message: 'Tab completion is not enabled on this DSH instance: enable dsh.features.tab-completion and restart the DSH server (command "dsh.restartServer"), or update the extension so it can configure the running instance',
        });
        return;
      }
      if (!tokenMatches(readBearerToken(request))) {
        writeJson(response, 401, { error: 'unauthorized', message: 'DSH FIM bridge token required' });
        return;
      }
      if (request.method !== 'POST') {
        writeJson(response, 405, { error: 'method-not-allowed' });
        return;
      }
      if (baseUrl().length === 0 || apiKey().length === 0) {
        // The message is user-facing guidance: the extension surfaces it in a
        // warning the first time a 503 is observed (F-e), so spell out the
        // exact fix steps.
        writeJson(response, 503, {
          error: 'fim-not-configured',
          message: 'Tab completion is not configured: set dsh.fim.baseUrl and store the DSH FIM API key (command "dsh.fim.setApiKey"), then restart the DSH server (command "dsh.restartServer")',
        });
        return;
      }
      const body = await readRequestBody(request);
      const model = typeof body.model === 'string' ? body.model : '';
      const prefix = typeof body.prefix === 'string' ? body.prefix : '';
      const suffix = typeof body.suffix === 'string' ? body.suffix : '';
      if (model.length === 0) {
        writeJson(response, 400, { error: 'invalid-request', message: 'model is required (dsh.fim.model)' });
        return;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
      request.on('close', () => controller.abort());

      let upstream;
      try {
        upstream = await fetchImpl(baseUrl(), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model, prompt: buildPrompt(template(), prefix, suffix), max_tokens: maxTokens(), temperature: 0, stream: true }),
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        respondWithError(response, 502, 'fim-upstream-unreachable', error);
        return;
      }
      if (!upstream.ok) {
        clearTimeout(timer);
        respondWithError(response, 502, 'fim-upstream-error', new Error(`upstream status ${upstream.status}`));
        return;
      }

      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      try {
        const SPLIT_RE = /\r\n|\n|\r/;
        for await (const chunk of upstream.body) {
          const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
          for (const line of text.split(SPLIT_RE)) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).replace(/^ /, '');
            if (payload.trim() === '[DONE]') continue; // re-emitted after the loop
            let parsed;
            try {
              parsed = JSON.parse(payload);
            } catch {
              continue;
            }
            const fragment = upstreamChunkText(parsed);
            if (fragment.length > 0) await writeSseFrame(response, { text: fragment });
          }
        }
        response.write('data: [DONE]\n\n');
      } catch {
        // client disconnected mid-stream or upstream aborted: best-effort end
      } finally {
        clearTimeout(timer);
        try {
          response.end();
        } catch {
          // already ended
        }
      }
    } catch (error) {
      respondWithError(response, 500, 'fim-internal', error);
    }
  });

  return {
    dispose: () => { for (const d of disposers) { try { d(); } catch { /* best-effort */ } } },
    routes,
  };
}
