'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { ServerManager } = require('../../src/serverManager');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('probe: 303 answering a tokened GET identifies dsh 0.1.2+', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/?token=good')) {
      res.writeHead(303, { location: '/' });
      res.end();
    } else {
      res.writeHead(401);
      res.end('unauthorized');
    }
  });
  const port = await listen(server);
  t.after(() => close(server));
  const manager = new ServerManager({ onStatus: () => {} });

  const noToken = await manager.probe('127.0.0.1', port);
  assert.strictEqual(noToken.reachable, true);
  assert.strictEqual(noToken.isDsh, false, 'plain GET / answers 401 without the marker');

  const withToken = await manager.probe('127.0.0.1', port, { token: 'good' });
  assert.strictEqual(withToken.reachable, true);
  assert.strictEqual(withToken.isDsh, true, 'the tokened GET answers the 303 cookie redirect');

  const badToken = await manager.probe('127.0.0.1', port, { token: 'bad' });
  assert.strictEqual(badToken.reachable, true);
  assert.strictEqual(badToken.isDsh, false, 'a rejected token still answers 401');
});

test('probe: 303 without a token is NOT dsh (foreign redirect service)', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(303, { location: '/elsewhere' });
    res.end();
  });
  const port = await listen(server);
  t.after(() => close(server));
  const manager = new ServerManager({ onStatus: () => {} });
  const result = await manager.probe('127.0.0.1', port);
  assert.strictEqual(result.reachable, true);
  assert.strictEqual(result.isDsh, false);
});

test('probe: legacy dsh (200 + BOOT_MARKER) stays detected without a token', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><script>window.__DSH_BOOT__ = true</script></html>');
  });
  const port = await listen(server);
  t.after(() => close(server));
  const manager = new ServerManager({ onStatus: () => {} });
  const result = await manager.probe('127.0.0.1', port);
  assert.strictEqual(result.reachable, true);
  assert.strictEqual(result.isDsh, true);
});
