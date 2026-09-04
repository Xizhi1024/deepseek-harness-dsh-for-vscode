'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  cookiePairFromSetCookie,
  createAuthedFetch,
  originOfInput,
  tokenFromUrl,
} = require('../../src/dshWebAuth');

function response({ status = 200, setCookie = null } = {}) {
  const headers = new Map();
  if (setCookie !== null) headers.set('set-cookie', setCookie);
  return {
    status,
    headers: { get: (name) => (headers.has(name) ? headers.get(name) : null) },
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

test('tokenFromUrl extracts the token or yields null', () => {
  assert.strictEqual(tokenFromUrl('http://127.0.0.1:3080/?token=abc'), 'abc');
  assert.strictEqual(tokenFromUrl('http://127.0.0.1:3080/'), null);
  assert.strictEqual(tokenFromUrl('not a url'), null);
  assert.strictEqual(tokenFromUrl(''), null);
});

test('cookiePairFromSetCookie takes the first name=value pair', () => {
  assert.strictEqual(cookiePairFromSetCookie('dsh_session=abc; Path=/; HttpOnly'), 'dsh_session=abc');
  assert.strictEqual(cookiePairFromSetCookie('no-equals'), null);
  assert.strictEqual(cookiePairFromSetCookie(null), null);
});

test('originOfInput handles strings, URL objects, and Request-like inputs', () => {
  assert.strictEqual(originOfInput('http://127.0.0.1:3080/api/x'), 'http://127.0.0.1:3080');
  assert.strictEqual(originOfInput(new URL('http://127.0.0.1:3080/api/x')), 'http://127.0.0.1:3080');
  assert.strictEqual(originOfInput({ url: 'http://127.0.0.1:3080/api/x' }), 'http://127.0.0.1:3080');
  assert.strictEqual(originOfInput('junk'), null);
});

test('createAuthedFetch passes through untouched when no token is available', async () => {
  const calls = [];
  const inner = async (input, init) => {
    calls.push({ input, init });
    return response({ status: 200 });
  };
  const fetch = createAuthedFetch({ fetchImpl: inner, tokenProvider: () => null });
  const out = await fetch('http://127.0.0.1:3080/api/session.prompt', { method: 'POST' });
  assert.strictEqual(out.status, 200);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].init.method, 'POST');
});

test('createAuthedFetch exchanges the token once and attaches the cookie', async () => {
  const seen = [];
  const inner = async (input, init) => {
    const url = String(input);
    const cookie = init && init.headers ? init.headers.cookie : undefined;
    seen.push({ url, cookie });
    if (url.includes('/?token=')) return response({ status: 303, setCookie: 'dsh_session=s3; Path=/' });
    return response({ status: 200 });
  };
  let token = 'launch-token';
  const fetch = createAuthedFetch({ fetchImpl: inner, tokenProvider: () => token });
  await fetch('http://127.0.0.1:3080/api/session.prompt', { method: 'POST' });
  await fetch('http://127.0.0.1:3080/api/events.mux');
  // exactly one exchange, both API calls carry the minted cookie
  assert.strictEqual(seen.filter((c) => c.url.includes('/?token=')).length, 1);
  assert.strictEqual(seen[1].cookie, 'dsh_session=s3');
  assert.strictEqual(seen[2].cookie, 'dsh_session=s3');
});

test('createAuthedFetch re-mints exactly once on a 401 and retries', async () => {
  let exchangeCount = 0;
  let apiCount = 0;
  const inner = async (input) => {
    const url = String(input);
    if (url.includes('/?token=')) {
      exchangeCount += 1;
      return response({ status: 303, setCookie: `dsh_session=gen${exchangeCount}; Path=/` });
    }
    apiCount += 1;
    // first API call arrives with gen1 and is rejected; the retry with gen2 passes
    return response({ status: apiCount === 1 ? 401 : 200 });
  };
  const fetch = createAuthedFetch({ fetchImpl: inner, tokenProvider: () => 't' });
  const first = await fetch('http://127.0.0.1:3080/api/x');
  assert.strictEqual(first.status, 200);
  assert.strictEqual(exchangeCount, 2);
  assert.strictEqual(apiCount, 2);
});

test('createAuthedFetch caches a failed exchange briefly instead of hammering', async () => {
  let exchangeCount = 0;
  let now = 0;
  const inner = async (input) => {
    if (String(input).includes('/?token=')) {
      exchangeCount += 1;
      return response({ status: 404 });
    }
    return response({ status: 401 });
  };
  const fetch = createAuthedFetch({ fetchImpl: inner, tokenProvider: () => 't', now: () => now });
  await fetch('http://127.0.0.1:3080/api/x');   // exchange fails (cached), no cookie -> 401 surfaces
  await fetch('http://127.0.0.1:3080/api/y');   // failure still cached, no re-exchange
  assert.strictEqual(exchangeCount, 1);
  now = 31 * 1000;                              // failure TTL expires
  await fetch('http://127.0.0.1:3080/api/z');
  assert.strictEqual(exchangeCount, 2);
});
