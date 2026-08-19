'use strict';

/**
 * R23 extension-side model routing: registers a `dsh` language-model chat
 * provider that serves DSH models through the loopback web server endpoints
 * `/api/lm/models` and `/api/lm/chat` (registered by the DSH-side integration
 * package). Stable VS Code API only (1.104+): LanguageModelResponsePart,
 * LanguageModelChatRequestMessage, LanguageModelTextPart, LanguageModelError.
 */

const TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4;
const SSE_TIMEOUT_MS = 120000;

function languageModelError(vscode, factory, message) {
  if (vscode && vscode.LanguageModelError && typeof vscode.LanguageModelError[factory] === 'function') {
    return vscode.LanguageModelError[factory](message);
  }
  const error = new Error(message);
  error.code = factory;
  return error;
}

function textPart(vscode, text) {
  if (vscode && typeof vscode.LanguageModelTextPart === 'function') {
    return new vscode.LanguageModelTextPart(text);
  }
  return { type: 'text', text };
}

/**
 * Very small token estimator (4 chars ≈ 1 token, the harness token-meter
 * approximation). Always returns a finite positive integer for non-empty text.
 *
 * @param {string|object} text - Text or a chat message.
 * @returns {number} Estimated token count.
 */
function estimateTokenCount(text) {
  let value = '';
  if (typeof text === 'string') {
    value = text;
  } else if (text && typeof text === 'object' && Array.isArray(text.content)) {
    for (const part of text.content) {
      if (part && typeof part.text === 'string') value += part.text;
      else if (typeof part === 'string') value += part;
    }
  } else if (text && typeof text === 'object' && typeof text.content === 'string') {
    value = text.content;
  }
  if (value.length === 0) return 0;
  return Math.max(1, Math.ceil(value.length / TOKEN_ESTIMATE_CHARS_PER_TOKEN));
}

/**
 * Map a DSH `/api/lm/models` payload into VS Code LanguageModelChatInformation
 * objects. Each model keeps its DSH identity in the `dsh` field so the chat
 * request can route back to the right provider/model.
 *
 * @param {Array<object>} models - DSH model descriptors.
 * @returns {Array<object>} VS Code model information objects.
 */
function mapDshModels(models) {
  return (Array.isArray(models) ? models : []).map((model) => {
    const id = model && typeof model.id === 'string' ? model.id : String(model && model.id ? model.id : 'model');
    const provider = model && typeof model.provider === 'string' ? model.provider : '';
    return {
      id: 'dsh-' + id,
      name: model && typeof model.name === 'string' && model.name.length > 0 ? model.name : 'dsh-' + id,
      family: model && typeof model.family === 'string' && model.family.length > 0 ? model.family : 'dsh',
      version: model && typeof model.version === 'string' && model.version.length > 0 ? model.version : '1.0.0',
      maxInputTokens: Number.isInteger(model && model.maxInputTokens) && model.maxInputTokens > 0 ? model.maxInputTokens : 128000,
      maxOutputTokens: Number.isInteger(model && model.maxOutputTokens) && model.maxOutputTokens > 0 ? model.maxOutputTokens : 8192,
      capabilities: {
        imageInput: Boolean(model && model.imageInput),
        toolCalling: Boolean(model && model.toolCalling),
      },
      dsh: { provider, model: id },
    };
  });
}

/**
 * Parse one SSE event stream chunk into emitted text deltas.
 *
 * @param {string} buffer - Accumulated SSE text.
 * @param {Array<string>} deltas - Output array of text deltas.
 * @returns {string} Remaining (incomplete) buffer.
 */
function parseSseBuffer(buffer, deltas, flush = false) {
  let remaining = buffer;
  let newline = remaining.indexOf('\n');
  while (newline !== -1) {
    const line = remaining.slice(0, newline);
    remaining = remaining.slice(newline + 1);
    processSseLine(line, deltas);
    newline = remaining.indexOf('\n');
  }
  if (flush && remaining.length > 0) {
    processSseLine(remaining, deltas);
    remaining = '';
  }
  return remaining;
}

function processSseLine(line, deltas) {
  if (!line.startsWith('data:')) return;
  const payload = line.slice('data:'.length).trim();
  if (payload.length === 0 || payload === '[DONE]') return;
  try {
    const parsed = JSON.parse(payload);
    if (parsed && typeof parsed.text === 'string' && parsed.text.length > 0) {
      deltas.push(parsed.text);
    }
  } catch {
    // non-JSON SSE line: ignore
  }
}

/**
 * @param {object} deps
 * @param {object} deps.vscode - VS Code facade ({ lm, LanguageModelTextPart, LanguageModelError }).
 * @param {Function} deps.baseUrlProvider - () => string loopback DSH base URL.
 * @param {string} deps.token - DSH_LM_BRIDGE_TOKEN.
 * @param {'off'|'fixed'|'dynamic'} deps.mode - Model refresh mode.
 * @param {Function} [deps.fetchImpl] - Injectable fetch seam.
 * @param {Function} [deps.now] - Time source for AbortSignal.timeout fallback.
 * @param {Function} [deps.onModelsChanged] - Optional callback after each model refresh.
 * @returns {object} { provider, disposable, refreshModels }
 */
function createLmRoute({
  vscode,
  baseUrlProvider,
  token,
  mode = 'off',
  fetchImpl = null,
  onModelsChanged = null,
} = {}) {
  if (!vscode || !vscode.lm || typeof vscode.lm.registerLanguageModelChatProvider !== 'function') {
    throw new TypeError('createLmRoute requires vscode.lm.registerLanguageModelChatProvider');
  }
  if (typeof baseUrlProvider !== 'function') {
    throw new TypeError('createLmRoute requires baseUrlProvider');
  }
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : fetch;
  let cachedModels = [];
  let disposed = false;

  async function fetchModels() {
    const base = baseUrlProvider();
    if (typeof base !== 'string' || base.length === 0) {
      throw languageModelError(vscode, 'NotFound', 'DSH server URL is unavailable');
    }
    const response = await fetchFn(base + '/api/lm/models', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + token,
      },
    });
    if (!response.ok) {
      throw languageModelError(
        vscode,
        response.status === 401 || response.status === 403 ? 'NoPermissions' : 'NotFound',
        'DSH model list failed with HTTP ' + response.status,
      );
    }
    const payload = await response.json();
    const models = mapDshModels(Array.isArray(payload && payload.models) ? payload.models : []);
    return models;
  }

  const provider = {
    async provideLanguageModelChatInformation(options, cancellationToken) {
      if (mode === 'fixed' && cachedModels.length > 0) return cachedModels;
      const models = await fetchModels();
      cachedModels = models;
      if (typeof onModelsChanged === 'function') {
        try {
          onModelsChanged(models);
        } catch {
          // advisory callback
        }
      }
      return models;
    },

    async provideLanguageModelChatResponse(model, messages, options, progress, cancellationToken) {
      const base = baseUrlProvider();
      if (typeof base !== 'string' || base.length === 0) {
        throw languageModelError(vscode, 'NotFound', 'DSH server URL is unavailable');
      }
      if (!model || !model.dsh || typeof model.dsh.model !== 'string') {
        throw languageModelError(vscode, 'NotFound', 'The selected DSH model is no longer available');
      }
      const controller = new AbortController();
      const onCancel = cancellationToken && cancellationToken.onCancellationRequested
        ? cancellationToken.onCancellationRequested(() => controller.abort())
        : null;
      const timer = setTimeout(() => controller.abort(), SSE_TIMEOUT_MS);
      if (timer && typeof timer.unref === 'function') timer.unref();
      try {
        const body = {
          provider: model.dsh.provider,
          model: model.dsh.model,
          messages: (Array.isArray(messages) ? messages : []).map((message) => ({
            role: message && message.role ? message.role : 'user',
            content: message && message.content !== undefined ? message.content : '',
          })),
        };
        if (options && options.modelOptions && Number.isFinite(options.modelOptions.maxTokens)) {
          body.maxTokens = options.modelOptions.maxTokens;
        }
        if (options && options.modelOptions && Number.isFinite(options.modelOptions.temperature)) {
          body.temperature = options.modelOptions.temperature;
        }
        const response = await fetchFn(base + '/api/lm/chat', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw languageModelError(
            vscode,
            response.status === 401 || response.status === 403
              ? 'NoPermissions'
              : (response.status === 404 ? 'NotFound' : 'Blocked'),
            'DSH chat failed with HTTP ' + response.status,
          );
        }
        if (!response.body || typeof response.body.getReader !== 'function') {
          throw languageModelError(vscode, 'Blocked', 'DSH chat returned a non-streaming response');
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          const deltas = [];
          buffer = parseSseBuffer(buffer + decoder.decode(chunk.value, { stream: true }), deltas);
          for (const delta of deltas) {
            progress.report(textPart(vscode, delta));
          }
        }
        const trailing = [];
        parseSseBuffer(buffer + decoder.decode(), trailing, true);
        for (const delta of trailing) {
          progress.report(textPart(vscode, delta));
        }
      } finally {
        clearTimeout(timer);
        if (onCancel && typeof onCancel.dispose === 'function') onCancel.dispose();
      }
    },

    async provideTokenCount(model, text, cancellationToken) {
      return estimateTokenCount(text);
    },
  };

  const registration = vscode.lm.registerLanguageModelChatProvider('dsh', provider);
  const disposable = {
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        registration?.dispose?.();
      } catch {
        // best-effort
      }
      cachedModels = [];
    },
  };

  return Object.freeze({
    disposable,
    provider,
    refreshModels: async () => {
      const models = await fetchModels();
      cachedModels = models;
      return models;
    },
  });
}

module.exports = {
  TOKEN_ESTIMATE_CHARS_PER_TOKEN,
  createLmRoute,
  estimateTokenCount,
  languageModelError,
  mapDshModels,
  parseSseBuffer,
};
