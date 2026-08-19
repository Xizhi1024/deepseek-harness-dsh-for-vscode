import { timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// DSH side of R23 model routing: /api/lm/models and /api/lm/chat exact
// WebRoutes. Auth = Authorization: Bearer <DSH_LM_BRIDGE_TOKEN>, which the
// extension injects into the DSH spawn env. The key never reaches VS Code.
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 1024 * 1024;

function safeTokenEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  if (leftBytes.length !== rightBytes.length) return false;
  try {
    return timingSafeEqual(leftBytes, rightBytes);
  } catch {
    let diff = 0;
    for (let i = 0; i < leftBytes.length; i += 1) diff |= leftBytes[i] ^ rightBytes[i];
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

async function readRequestBody(request, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    request.on('data', (chunk) => {
      total += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), 'utf8');
      if (total > maxBytes) {
        reject(new Error('request body exceeds the 1 MiB limit'));
        return;
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
    });
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(body.length === 0 ? {} : JSON.parse(body));
      } catch {
        reject(new Error('request body must be valid JSON'));
      }
    });
    request.on('error', reject);
  });
}

function collectModels(ctx) {
  const raw = ctx && ctx.llm && typeof ctx.llm.listModels === 'function'
    ? ctx.llm.listModels()
    : [];
  const models = [];
  const visit = (entry, inheritedProvider) => {
    if (!entry) return;
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item, inheritedProvider);
      return;
    }
    if (typeof entry === 'object') {
      const provider = typeof entry.provider === 'string' && entry.provider.length > 0
        ? entry.provider
        : inheritedProvider;
      if (Array.isArray(entry.models)) {
        visit(entry.models, provider);
        return;
      }
      if (typeof entry.id === 'string' && entry.id.length > 0) {
        models.push(provider ? { ...entry, provider } : entry);
      }
    }
  };
  visit(raw, '');
  return models;
}

function mapModel(entry) {
  return {
    id: entry.id,
    name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : entry.id,
    family: typeof entry.family === 'string' && entry.family.length > 0 ? entry.family : 'dsh',
    version: typeof entry.version === 'string' && entry.version.length > 0 ? entry.version : '1.0.0',
    maxInputTokens: Number.isInteger(entry.maxInputTokens) && entry.maxInputTokens > 0 ? entry.maxInputTokens : 128000,
    maxOutputTokens: Number.isInteger(entry.maxOutputTokens) && entry.maxOutputTokens > 0 ? entry.maxOutputTokens : 8192,
    provider: typeof entry.provider === 'string' ? entry.provider : '',
    imageInput: Boolean(entry.imageInput),
    toolCalling: Boolean(entry.toolCalling),
  };
}

function chunkText(chunk) {
  if (!chunk) return '';
  if (typeof chunk === 'string') return chunk;
  if (typeof chunk.text === 'string') return chunk.text;
  if (typeof chunk.delta === 'string') return chunk.delta;
  if (typeof chunk.content === 'string') return chunk.content;
  if (Array.isArray(chunk.choices) && chunk.choices.length > 0) {
    return chunkText(chunk.choices[0]);
  }
  return '';
}

async function writeSseChunk(response, payload) {
  const body = `data: ${JSON.stringify(payload)}\n\n`;
  const writable = response.write(body);
  if (writable === false) {
    await new Promise((resolve) => response.once('drain', resolve));
  }
}

/**
 * @param {object} deps
 * @param {object} deps.env - env source (DSH_LM_BRIDGE_TOKEN).
 * @param {object} deps.ctx - DSH plugin context ({ webServer, llm }).
 * @returns {{dispose: Function, routes: Array<{path: string, disposer: Function|null}>}}
 */
function createLmRoutes({ env = process.env, ctx = null } = {}) {
  if (!ctx || !ctx.webServer || typeof ctx.webServer.register !== 'function') {
    throw new TypeError('createLmRoutes requires ctx.webServer.register');
  }
  const token = env && typeof env.DSH_LM_BRIDGE_TOKEN === 'string' ? env.DSH_LM_BRIDGE_TOKEN : '';
  const disposers = [];

  function registerRoute(path, handler) {
    const disposer = ctx.webServer.register({ kind: 'exact', path, handler });
    if (typeof disposer === 'function') disposers.push(disposer);
    else if (disposer && typeof disposer.dispose === 'function') disposers.push(() => disposer.dispose());
  }

  function authorized(request, response) {
    if (token.length === 0 || !safeTokenEqual(readBearerToken(request), token)) {
      writeJson(response, 401, { error: 'unauthorized', message: 'DSH model bridge token required' });
      return false;
    }
    return true;
  }

  registerRoute('/api/lm/models', (request, response) => {
    if (!authorized(request, response)) return;
    if (request.method !== 'GET') {
      writeJson(response, 405, { error: 'method-not-allowed' });
      return;
    }
    const models = collectModels(ctx).map(mapModel);
    writeJson(response, 200, { models });
  });

  registerRoute('/api/lm/chat', async (request, response) => {
    if (!authorized(request, response)) return;
    if (request.method !== 'POST') {
      writeJson(response, 405, { error: 'method-not-allowed' });
      return;
    }
    let body;
    try {
      body = await readRequestBody(request);
    } catch (error) {
      writeJson(response, 400, { error: 'bad-request', message: error && error.message ? error.message : String(error) });
      return;
    }
    if (!body || typeof body.model !== 'string' || body.model.length === 0) {
      writeJson(response, 400, { error: 'bad-request', message: 'model is required' });
      return;
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      writeJson(response, 400, { error: 'bad-request', message: 'messages must be a non-empty array' });
      return;
    }
    if (!ctx.llm || typeof ctx.llm.stream !== 'function') {
      writeJson(response, 501, { error: 'not-implemented', message: 'ctx.llm.stream is unavailable' });
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    try {
      const stream = ctx.llm.stream({
        provider: typeof body.provider === 'string' ? body.provider : '',
        model: body.model,
        messages: body.messages,
        maxTokens: Number.isInteger(body.maxTokens) && body.maxTokens > 0 ? body.maxTokens : undefined,
        temperature: Number.isFinite(body.temperature) ? body.temperature : undefined,
      });
      if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
        for await (const chunk of stream) {
          const text = chunkText(chunk);
          if (text.length > 0) await writeSseChunk(response, { text });
        }
      } else if (stream && typeof stream.on === 'function') {
        await new Promise((resolve, reject) => {
          stream.on('data', async (chunk) => {
            try {
              const text = chunkText(chunk);
              if (text.length > 0) await writeSseChunk(response, { text });
            } catch (error) {
              reject(error);
            }
          });
          stream.on('end', resolve);
          stream.on('error', reject);
        });
      }
      response.write('data: [DONE]\n\n');
      response.end();
    } catch (error) {
      try {
        response.write(`event: error\ndata: ${JSON.stringify({ message: error && error.message ? error.message : String(error) })}\n\n`);
      } catch {
        // the response may already be closed
      }
      response.end();
    }
  });

  return {
    routes: [{ path: '/api/lm/models' }, { path: '/api/lm/chat' }],
    dispose() {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // best-effort cleanup
        }
      }
      disposers.length = 0;
    },
  };
}

export {
  MAX_BODY_BYTES,
  chunkText,
  collectModels,
  createLmRoutes,
  mapModel,
  readBearerToken,
  safeTokenEqual,
};
