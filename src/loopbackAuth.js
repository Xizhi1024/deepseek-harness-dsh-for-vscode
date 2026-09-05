'use strict';

/** Exchange the owned launch URL for an authority-bound cookie, kept in memory
 * for this request only. Never follow redirects or send credentials off-origin. */

function assertLoopbackLaunchUrl(baseUrl) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(base.hostname)
      || base.username || base.password) {
    throw new Error('DSH authentication requires the same loopback origin');
  }
  return base;
}

/** Extract the session cookie pair from a launch-URL login response. */
function cookieFromLoginResponse(login) {
  if (login.status === 303) {
    if (login.headers.get('location') !== '/') throw new Error('Unexpected DSH authentication redirect');
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    if (!cookie || /[\r\n]/.test(cookie)) throw new Error('DSH authentication cookie missing');
    return cookie;
  }
  if (login.status === 200) return ''; // Older/fork runtimes serve the index at the launch URL.
  throw new Error(`DSH authentication failed: HTTP ${login.status}`);
}

/** Perform the one-shot launch-token → session-cookie exchange against the
 * loopback DSH instance and return the "name=value" cookie pair (empty string
 * when a pre-auth runtime serves the index directly at the launch URL).
 * Runs outside any browser, so SameSite never applies to the holder. */
async function exchangeLaunchCookie(baseUrl, fetchImpl = globalThis.fetch, signal = undefined) {
  const base = assertLoopbackLaunchUrl(baseUrl);
  const login = await fetchImpl(base.toString(), {
    method: 'GET',
    redirect: 'manual',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
      : AbortSignal.timeout(5000),
  });
  const cookie = cookieFromLoginResponse(login);
  await login.body?.cancel();
  return cookie;
}

async function loopbackFetch(baseUrl, apiPath, init = {}, fetchImpl = globalThis.fetch) {
  const base = assertLoopbackLaunchUrl(baseUrl);
  const target = new URL(apiPath || '/', base);
  if (target.origin !== base.origin) throw new Error('DSH authentication requires the same loopback origin');
  if (!base.searchParams.has('token')) return fetchImpl(target.toString(), init);
  const login = await fetchImpl(base.toString(), {
    method: 'GET',
    redirect: 'manual',
    signal: init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(5000)])
      : AbortSignal.timeout(5000),
  });
  // Pre-auth runtimes serve the index AT the launch URL; a null apiPath caller
  // (health probe) wants exactly that response rather than a tokenless re-fetch.
  if (login.status === 200 && apiPath === null) return login;
  const cookie = cookieFromLoginResponse(login);
  await login.body?.cancel();
  const headers = { ...init.headers, ...(cookie ? { cookie } : {}) };
  return fetchImpl(target.toString(), { ...init, headers, redirect: 'manual' });
}

module.exports = { loopbackFetch, exchangeLaunchCookie };
