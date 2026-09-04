'use strict';

// dsh 0.1.2-rc.1 added a browser-auth layer to the web UI: the spawned
// process prints an authenticated URL (`dsh web: http://127.0.0.1:PORT/?token=…`)
// and a GET of `/?token=…` mints a session cookie that all later /api calls
// must carry. Older runtimes print a plain URL and accept unauthenticated
// requests. This module bridges both: given a token it exchanges it for the
// cookie once and transparently attaches (and re-mints on 401) the Cookie
// header on every fetch it wraps, so API clients stay auth-agnostic.

/** How long a successfully exchanged cookie is reused before re-minting. */
const COOKIE_TTL_MS = 60 * 60 * 1000;
/** How long a failed exchange is remembered before trying again. */
const FAILURE_TTL_MS = 30 * 1000;

/**
 * Extract the `token` query parameter from a launch URL, or null.
 *
 * @param {string} url - URL that may carry `?token=…`.
 * @returns {string|null}
 */
function tokenFromUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return null;
  try {
    const value = new URL(url).searchParams.get('token');
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * First `name=value` pair of a Set-Cookie header value (the session cookie
// dsh mints); other attributes are irrelevant for re-sending.
 *
 * @param {string} setCookie - Raw Set-Cookie header value.
 * @returns {string|null} Cookie request-header value.
 */
function cookiePairFromSetCookie(setCookie) {
  if (typeof setCookie !== 'string') return null;
  const pair = setCookie.split(';', 1)[0].trim();
  if (pair.length === 0 || !pair.includes('=')) return null;
  return pair;
}

/**
 * Origin of a fetch input (string, URL, or Request-like object).
 *
 * @param {*} input - fetch() first argument.
 * @returns {string|null}
 */
function originOfInput(input) {
  try {
    const url = typeof input === 'string' || input instanceof URL
      ? new URL(input)
      : new URL(input && typeof input.url === 'string' ? input.url : String(input));
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

/**
 * Wrap a fetch implementation with dsh web authentication.
 *
 * The returned function forwards to `fetchImpl`, attaching the Cookie header
 * for the current token's session whenever one has been minted. A 401
 * response triggers exactly one forced re-exchange and retry, so a cookie
 * that expired server-side heals on the next request instead of failing the
 * sidebar until restart.
 *
 * @param {object} [options]
 * @param {Function} [options.fetchImpl=globalThis.fetch] - Fetch-compatible
 *   function to wrap (injected in tests).
 * @param {Function} [options.tokenProvider] - Synchronous () => string|null
 *   returning the CURRENT launch token (e.g. reads the running server
 *   handle); null/absent on old runtimes disables auth transparently.
 * @param {Function} [options.now=Date.now] - Clock seam for tests.
 * @returns {Function} Auth-aware fetch-compatible function.
 */
function createAuthedFetch({ fetchImpl = globalThis.fetch, tokenProvider = null, now = Date.now } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('createAuthedFetch requires a fetchImpl');
  if (tokenProvider !== null && typeof tokenProvider !== 'function') {
    throw new TypeError('tokenProvider must be a function when provided');
  }
  let cache = null; // { token, origin, cookie, at, ok }

  const exchange = async (token, origin) => {
    const response = await fetchImpl(`${origin}/?token=${encodeURIComponent(token)}`, {
      redirect: 'manual',
      headers: { accept: 'text/html' },
    });
    // Consume the body so the socket is released before any retry.
    try { await response.arrayBuffer(); } catch { /* already consumed or empty */ }
    if (!response || response.status !== 303) return null;
    const setCookie = typeof response.headers.get === 'function'
      ? response.headers.get('set-cookie')
      : null;
    return cookiePairFromSetCookie(setCookie);
  };

  const cookieFor = async (token, origin, force = false) => {
    if (token === null || origin === null) return null;
    if (!force && cache && cache.token === token && cache.origin === origin) {
      const ttl = cache.ok ? COOKIE_TTL_MS : FAILURE_TTL_MS;
      if (now() - cache.at < ttl) return cache.ok ? cache.cookie : null;
    }
    let cookie = null;
    try {
      cookie = await exchange(token, origin);
    } catch {
      cookie = null;
    }
    cache = { token, origin, cookie, at: now(), ok: cookie !== null };
    return cookie;
  };

  return async (input, init) => {
    const token = typeof tokenProvider === 'function' ? tokenProvider() : null;
    if (token === null || token === undefined || token === '') {
      return fetchImpl(input, init); // old runtime: no auth layer to satisfy
    }
    const origin = originOfInput(input);
    const cookie = await cookieFor(token, origin);
    const withCookie = (base, value) => ({
      ...(base || {}),
      headers: { ...(base && base.headers ? base.headers : {}), cookie: value },
    });
    const response = cookie
      ? await fetchImpl(input, withCookie(init, cookie))
      : await fetchImpl(input, init);
    if (response && typeof response.status === 'number' && response.status === 401 && cookie) {
      // Only re-mint when a minted cookie was actually rejected (server-side
      // expiry); with no cookie at all the exchange already failed and its
      // failure is cached, so surface the 401 instead of amplifying traffic.
      const reminted = await cookieFor(token, origin, true);
      if (reminted && reminted !== cookie) {
        return fetchImpl(input, withCookie(init, reminted));
      }
    }
    return response;
  };
}

module.exports = {
  COOKIE_TTL_MS,
  FAILURE_TTL_MS,
  cookiePairFromSetCookie,
  createAuthedFetch,
  originOfInput,
  tokenFromUrl,
};
