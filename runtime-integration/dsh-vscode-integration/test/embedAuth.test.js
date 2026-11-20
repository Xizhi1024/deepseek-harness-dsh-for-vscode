import assert from 'node:assert/strict';
import test from 'node:test';
import { installEmbedAuth } from '../lib/embedAuth.js';

test('embedded navigation partitions only a session that DSH issued after validating the launch token', () => {
  function authorizeIndex(request, response) {
    if (!request.url.includes('token=valid')) {
      response.writeHead(401, {});
      return false;
    }
    response.writeHead(303, {
      location: './',
      'set-cookie': 'session=signed; HttpOnly; SameSite=Strict',
      'referrer-policy': 'no-referrer',
    });
    return false;
  }
  const connection = { authorizeIndex };
  const dispose = installEmbedAuth(connection);
  const request = {
    method: 'GET',
    url: '/?token=valid&dsh_embed=vscode&dsh_theme=dark&dsh_session=abc',
    headers: { host: '127.0.0.1:3080', 'sec-fetch-dest': 'iframe' },
  };
  const calls = [];
  const writeHead = (...args) => calls.push(args);
  const response = { writeHead };

  assert.equal(connection.authorizeIndex(request, response), false);
  assert.deepEqual(calls.pop(), [303, {
    location: './?dsh_embed=vscode&dsh_theme=dark&dsh_session=abc',
    'set-cookie': 'session=signed; HttpOnly; SameSite=None; Secure; Partitioned',
    'referrer-policy': 'no-referrer',
  }]);
  assert.equal(response.writeHead, writeHead);

  const fetchRequest = new Request('http://127.0.0.1:3080' + request.url, { headers: request.headers });
  connection.authorizeIndex(fetchRequest, response);
  assert.match(calls.pop()[1]['set-cookie'], /Partitioned$/);

  connection.authorizeIndex({ ...request, url: '/?token=invalid&dsh_embed=vscode' }, response);
  assert.deepEqual(calls.pop(), [401, {}]);
  connection.authorizeIndex({ ...request, headers: { ...request.headers, 'sec-fetch-dest': 'document' } }, response);
  assert.match(calls.pop()[1]['set-cookie'], /SameSite=Strict$/);
  dispose();
  assert.equal(connection.authorizeIndex, authorizeIndex);
});
