'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { loopbackFetch, exchangeLaunchCookie } = require('../../src/loopbackAuth');
const { ServerManager } = require('../../src/serverManager');
const { listSessions } = require('../../src/sessionNavigation');

test('rc.1 cookie exchange works for health and session API; token never reaches API', async (t) => {
  const paths = [];
  const server = http.createServer((req, res) => {
    paths.push(req.url);
    if (req.url === '/?token=synthetic') { // allow-secret-scan
      res.writeHead(303, { location: '/', 'set-cookie': 'dsh-test=cookie; HttpOnly; Path=/' });
    } else if (req.headers.cookie !== 'dsh-test=cookie') {
      res.writeHead(401);
    } else if (req.url === '/api/session.list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result: { ok: true, value: { items: [] } } }));
      return;
    } else {
      res.writeHead(200);
      res.end('__DSH_BOOT__');
      return;
    }
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/?token=synthetic`; // allow-secret-scan
  assert.equal(await new ServerManager().healthCheck(base), true);
  assert.deepEqual(await listSessions(base), []);
  assert.deepEqual(paths, ['/?token=synthetic', '/', '/?token=synthetic', '/api/session.list']); // allow-secret-scan
});

test('authentication never follows foreign redirects or allows foreign API targets', async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls++;
    return new Response(null, { status: 303, headers: { location: 'http://example.com/' } });
  };
  const base = 'http://127.0.0.1:4999/?token=synthetic'; // allow-secret-scan
  await assert.rejects(loopbackFetch(base, null, {}, fakeFetch), /Unexpected/);
  await assert.rejects(loopbackFetch(base, 'http://example.com/api', {}, fakeFetch), /same loopback/);
  assert.equal(calls, 1);
});

test('exchangeLaunchCookie returns the pair, tolerates pre-auth runtimes, rejects the rest', async () => {
  const minted = async () => new Response(null, {
    status: 303, headers: { location: '/', 'set-cookie': 'dsh-x=v1.sig; Path=/; HttpOnly; SameSite=Strict' },
  });
  const direct = async () => new Response('<html></html>', { status: 200 });
  const denied = async () => new Response('no\n', { status: 401 });
  assert.equal(
    await exchangeLaunchCookie('http://127.0.0.1:4999/?token=synthetic', minted), // allow-secret-scan
    'dsh-x=v1.sig',
  );
  assert.equal(
    await exchangeLaunchCookie('http://127.0.0.1:4999/?token=synthetic', direct), // allow-secret-scan
    '',
  );
  await assert.rejects(
    exchangeLaunchCookie('http://127.0.0.1:4999/?token=synthetic', denied), // allow-secret-scan
    /DSH authentication failed: HTTP 401/,
  );
  await assert.rejects(
    exchangeLaunchCookie('http://example.com/?token=synthetic', minted), // allow-secret-scan
    /same loopback/,
  );
});
