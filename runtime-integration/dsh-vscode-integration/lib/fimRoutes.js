import { timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// DSH side of tab completion: POST /api/fim exact WebRoute.
// Auth = Authorization: Bearer <DSH_FIM_BRIDGE_TOKEN> (injected into the DSH
// spawn env by the extension's tab-completion feature).
// Upstream = an OpenAI-compatible *completions* endpoint (DSH_FIM_BASE_URL,
// full URL, e.g. https://api.deepseek.com/beta/completions) called with a FIM
// prompt; the streamed deltas are re-emitted as SSE frames
// (data: {"text": ...} ... data: [DONE]) that the extension-side
// inlineCompletion parser understands.
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 256 * 1024;
const MAX_UPSTREAM_TOKENS = 256;
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
 * @param {object} deps.env - env source (DSH_FIM_BRIDGE_TOKEN, DSH_FIM_BASE_URL,
 *   DSH_FIM_API_KEY, optional DSH_FIM_TEMPLATE / DSH_FIM_MAX_TOKENS).
 * @param {object} deps.ctx - DSH plugin context ({ webServer }).
 * @param {Function} [deps.fetchImpl] - injectable fetch (tests).
 * @returns {{dispose: Function, routes: Array<{path: string}>}}
 */
export function createFimRoutes({ env = process.env, ctx = null, fetchImpl = globalThis.fetch } = {}) {
  if (!ctx || !ctx.webServer || typeof ctx.webServer.register !== 'function') {
    throw new TypeError('createFimRoutes requires ctx.webServer.register');
  }
  const token = env && typeof env.DSH_FIM_BRIDGE_TOKEN === 'string' ? env.DSH_FIM_BRIDGE_TOKEN : '';
  const disposers = [];
  const routes = [];
  if (token.length === 0) {
    // Tab completion disabled on the extension side: mount nothing.
    return { dispose: () => { for (const d of disposers) { try { d(); } catch { /* best-effort */ } } }, routes };
  }

  const baseUrl = typeof env.DSH_FIM_BASE_URL === 'string' ? env.DSH_FIM_BASE_URL : '';
  const apiKey = typeof env.DSH_FIM_API_KEY === 'string' ? env.DSH_FIM_API_KEY : '';
  const template = typeof env.DSH_FIM_TEMPLATE === 'string' && env.DSH_FIM_TEMPLATE.includes('{prefix}')
    ? env.DSH_FIM_TEMPLATE
    : DEFAULT_FIM_TEMPLATE;
  const maxTokensRaw = Number.parseInt(String(env.DSH_FIM_MAX_TOKENS ?? ''), 10);
  const maxTokens = Number.isInteger(maxTokensRaw) && maxTokensRaw > 0 && maxTokensRaw <= 1024 ? maxTokensRaw : MAX_UPSTREAM_TOKENS;

  function registerRoute(path, handler) {
    const disposer = ctx.webServer.register({ kind: 'exact', path, handler });
    routes.push({ path });
    if (typeof disposer === 'function') disposers.push(disposer);
    else if (disposer && typeof disposer.dispose === 'function') disposers.push(() => disposer.dispose());
  }

  registerRoute('/api/fim', async (request, response) => {
    try {
      if (token.length === 0 || !safeTokenEqual(readBearerToken(request), token)) {
        writeJson(response, 401, { error: 'unauthorized', message: 'DSH FIM bridge token required' });
        return;
      }
      if (request.method !== 'POST') {
        writeJson(response, 405, { error: 'method-not-allowed' });
        return;
      }
      if (baseUrl.length === 0 || apiKey.length === 0) {
        writeJson(response, 503, {
          error: 'fim-not-configured',
          message: 'Set dsh.fim.baseUrl and the DSH FIM API key on the extension side, then restart the DSH server',
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
        upstream = await fetchImpl(baseUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model, prompt: buildPrompt(template, prefix, suffix), max_tokens: maxTokens, temperature: 0, stream: true }),
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
