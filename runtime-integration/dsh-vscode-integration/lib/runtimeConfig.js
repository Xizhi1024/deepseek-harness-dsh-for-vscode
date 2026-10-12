// ---------------------------------------------------------------------------
// Live bridge configuration store (2026-09-19, known-issue #1 fix).
//
// The plugin's bridge routes used to be mounted ONLY when their feature env
// keys (DSH_LM_BRIDGE_TOKEN / DSH_FIM_* / DSH_VSCODE_OPEN_*) were present in
// the DSH spawn env. That env is a SPAWN-TIME snapshot: when a feature is
// enabled later, or a window adopts an instance another window spawned, the
// running plugin never learns the new keys — the route never mounts and the
// request falls through to the /api fetch bridge, which answers a bare
// "404 not found" (live-confirmed 2026-09-19 against dsh 0.1.5-rc.2). LM
// routing / tab completion / open-link then read as silently broken.
//
// This store is the fix's plugin half: the routes are ALWAYS mounted and read
// their configuration from this mutable store, which starts as a snapshot of
// the spawn env (backward compatible with older extensions) and is then
// updated at runtime by the extension over POST /api/vscode/configure (see
// configureRoute.js) — the same route pattern the registry's authToken uses
// to let sibling windows adopt a fenced instance.
//
// Merge semantics (multiple VS Code windows of one shared instance may push):
//   - fim.tokens / lm.tokens: UPSERT (a window adds its own per-window
//     bearer token; a closed window's token stays valid until the instance
//     restarts — the registry resets then).
//   - fim.baseUrl / fim.apiKey / fim.template / fim.maxTokens: REPLACE
//     (machine-scope settings, identical across windows).
//   - links: REPLACE (null disables editor-links outright).
//   - configureToken: never mutable here — it bootstraps from env only; a
//     configure push cannot hand itself new authority.
// ---------------------------------------------------------------------------

const DEFAULT_FIM_TEMPLATE = '<｜fim▁begin｜>{prefix}<｜fim▁hole｜>{suffix}<｜fim▁end｜>';
const DEFAULT_FIM_MAX_TOKENS = 256;
const MAX_FIM_TOKENS = 64;

function envString(env, key) {
  const value = env && typeof env[key] === 'string' ? env[key] : '';
  return value;
}

/** A usable bearer token: non-empty after trim, bounded (never a whole env dump). */
function usableToken(value) {
  return typeof value === 'string' && (value = value.trim()).length > 0 && value.length <= 512 ? value : null;
}

/**
 * Create the live configuration store.
 *
 * @param {object} [deps]
 * @param {object} [deps.env] - env source (default process.env); the spawn-env
 *   bootstrap snapshot.
 * @returns {object} store with `lm`, `fim`, `links`, `configureToken` and
 *   `applyConfigure(body)` (throws TypeError on a malformed patch).
 */
function createRuntimeConfig({ env = process.env } = {}) {
  const lmTokens = new Set();
  const fimTokens = new Set();
  const lmBootstrap = usableToken(envString(env, 'DSH_LM_BRIDGE_TOKEN'));
  if (lmBootstrap) lmTokens.add(lmBootstrap);
  const fimBootstrap = usableToken(envString(env, 'DSH_FIM_BRIDGE_TOKEN'));
  if (fimBootstrap) fimTokens.add(fimBootstrap);

  const fim = {
    tokens: fimTokens,
    baseUrl: envString(env, 'DSH_FIM_BASE_URL'),
    apiKey: envString(env, 'DSH_FIM_API_KEY'),
    template: envString(env, 'DSH_FIM_TEMPLATE').includes('{prefix}')
      ? envString(env, 'DSH_FIM_TEMPLATE')
      : DEFAULT_FIM_TEMPLATE,
    maxTokens: parseMaxTokens(envString(env, 'DSH_FIM_MAX_TOKENS')),
  };

  const openUrl = envString(env, 'DSH_VSCODE_OPEN_URL');
  const openToken = envString(env, 'DSH_VSCODE_OPEN_TOKEN');
  // Holder indirection: the patch appliers are module-level functions that
  // receive `config`, so the mutable links state lives ON the config object
  // (the `links` getter below reads it) instead of in a closure they cannot
  // reach.
  const linksHolder = { value: openUrl.length > 0 && openToken.length > 0
    ? Object.freeze({ openUrl, openToken })
    : null };

  return {
    lm: { tokens: lmTokens },
    fim,
    // Internal mutable holder for the editor-links config; read via `links`.
    _linksHolder: linksHolder,
    get links() {
      return linksHolder.value;
    },
    // The configure authority is env-only by design (see header).
    configureToken: envString(env, 'DSH_VSCODE_CONFIGURE_TOKEN'),
    DEFAULT_FIM_TEMPLATE,
    DEFAULT_FIM_MAX_TOKENS,
    applyConfigure(body) {
      return applyConfigurePatch(this, body);
    },
  };
}

function parseMaxTokens(raw) {
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 1024 ? parsed : DEFAULT_FIM_MAX_TOKENS;
}

/**
 * Apply one configure patch to the store. Pure-ish: throws TypeError on a
 * malformed patch (the route turns that into 400), never partially applies a
 * rejected field set — validation happens before any mutation.
 *
 * Accepted shape (all fields optional, unknown fields rejected):
 * {
 *   fim?: {
 *     addTokens?: string[],        // upsert into fim.tokens
 *     baseUrl?: string,            // replace ('' clears)
 *     apiKey?: string,             // replace ('' clears)
 *     template?: string,           // replace; must contain {prefix}
 *     maxTokens?: number,          // replace; 1..1024
 *   } | null,                      // null = clear tokens (keep scalars)
 *   lm?: { addTokens?: string[] } | null,
 *   editorLinks?: { openUrl: string, openToken: string } | null,
 * }
 */
function applyConfigurePatch(config, body) {
  if (body === undefined || body === null) return { applied: emptyApplied(config) };
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new TypeError('configure body must be an object');
  }
  const allowed = new Set(['fim', 'lm', 'editorLinks']);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new TypeError(`unknown configure field: ${key}`);
  }

  const applied = { fim: null, lm: null, editorLinks: null };

  if (body.fim !== undefined) {
    const fimApplied = applyFimPatch(config, body.fim);
    if (fimApplied) applied.fim = fimApplied;
  }
  if (body.lm !== undefined) {
    const lmApplied = applyLmPatch(config, body.lm);
    if (lmApplied) applied.lm = lmApplied;
  }
  if (body.editorLinks !== undefined) {
    applied.editorLinks = applyLinksPatch(config, body.editorLinks);
  }
  return { applied };
}

function applyFimPatch(config, patch) {
  if (patch === null) {
    config.fim.tokens.clear();
    return { tokensCleared: true, tokens: config.fim.tokens.size };
  }
  if (typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('fim patch must be an object or null');
  }
  const allowed = new Set(['addTokens', 'baseUrl', 'apiKey', 'template', 'maxTokens']);
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) throw new TypeError(`unknown fim patch field: ${key}`);
  }
  const added = addTokens(config.fim.tokens, patch.addTokens, MAX_FIM_TOKENS, 'fim');
  if (patch.baseUrl !== undefined) {
    if (typeof patch.baseUrl !== 'string') throw new TypeError('fim.baseUrl must be a string');
    config.fim.baseUrl = patch.baseUrl.trim();
  }
  if (patch.apiKey !== undefined) {
    if (typeof patch.apiKey !== 'string') throw new TypeError('fim.apiKey must be a string');
    config.fim.apiKey = patch.apiKey;
  }
  if (patch.template !== undefined) {
    if (typeof patch.template !== 'string' || !patch.template.includes('{prefix}')) {
      throw new TypeError('fim.template must be a string containing {prefix}');
    }
    config.fim.template = patch.template;
  }
  if (patch.maxTokens !== undefined) {
    if (!Number.isInteger(patch.maxTokens) || patch.maxTokens < 1 || patch.maxTokens > 1024) {
      throw new TypeError('fim.maxTokens must be an integer between 1 and 1024');
    }
    config.fim.maxTokens = patch.maxTokens;
  }
  return { tokensAdded: added, tokens: config.fim.tokens.size, baseUrlSet: config.fim.baseUrl.length > 0, keySet: config.fim.apiKey.length > 0 };
}

function applyLmPatch(config, patch) {
  if (patch === null) {
    config.lm.tokens.clear();
    return { tokensCleared: true, tokens: config.lm.tokens.size };
  }
  if (typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('lm patch must be an object or null');
  }
  for (const key of Object.keys(patch)) {
    if (key !== 'addTokens') throw new TypeError(`unknown lm patch field: ${key}`);
  }
  const added = addTokens(config.lm.tokens, patch.addTokens, MAX_FIM_TOKENS, 'lm');
  return { tokensAdded: added, tokens: config.lm.tokens.size };
}

function applyLinksPatch(config, patch) {
  if (patch === null) {
    config._linksHolder.value = null;
    return { disabled: true };
  }
  if (typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('editorLinks patch must be an object or null');
  }
  for (const key of Object.keys(patch)) {
    if (key !== 'openUrl' && key !== 'openToken') throw new TypeError(`unknown editorLinks patch field: ${key}`);
  }
  const openUrl = typeof patch.openUrl === 'string' ? patch.openUrl.trim() : '';
  const openToken = typeof patch.openToken === 'string' ? patch.openToken : '';
  if (openUrl.length === 0 || openToken.length === 0) {
    throw new TypeError('editorLinks requires non-empty openUrl and openToken');
  }
  config._linksHolder.value = Object.freeze({ openUrl, openToken });
  return { enabled: true };
}

/** Validate + insert bearer tokens; returns how many NEW tokens were added. */
function addTokens(target, values, limit, label) {
  if (values === undefined) return 0;
  if (!Array.isArray(values)) throw new TypeError(`${label}.addTokens must be an array of strings`);
  let added = 0;
  for (const value of values) {
    const token = usableToken(value);
    if (!token) throw new TypeError(`${label}.addTokens entries must be non-empty strings (max 512 chars)`);
    if (!target.has(token)) {
      if (target.size >= limit) throw new TypeError(`${label} token set exceeds the ${limit} token limit`);
      target.add(token);
      added += 1;
    }
  }
  return added;
}

function emptyApplied(config) {
  return {
    fim: { tokens: config.fim.tokens.size, baseUrlSet: config.fim.baseUrl.length > 0, keySet: config.fim.apiKey.length > 0 },
    lm: { tokens: config.lm.tokens.size },
    editorLinks: { enabled: config.links !== null },
  };
}

export {
  DEFAULT_FIM_MAX_TOKENS,
  DEFAULT_FIM_TEMPLATE,
  MAX_FIM_TOKENS,
  applyConfigurePatch,
  createRuntimeConfig,
  usableToken,
};
