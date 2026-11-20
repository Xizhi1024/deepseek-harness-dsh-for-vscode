function preserveEmbedParameters(url) {
  const params = new URLSearchParams({ dsh_embed: 'vscode' });
  const theme = url.searchParams.get('dsh_theme');
  if (theme === 'light' || theme === 'dark') params.set('dsh_theme', theme);
  const session = url.searchParams.get('dsh_session');
  if (session) params.set('dsh_session', session);
  return `./?${params}`;
}

/** Keep DSH's signed session within the VS Code top-level site's cookie partition. */
function installEmbedAuth(connection) {
  // Cordis returns a new context-bound proxy for each method read. Patch the
  // service instance so its other consumers see the same method and disposal
  // can restore the original.
  const service = connection[Symbol.for('cordis.original')] ?? connection;
  const authorizeIndex = service.authorizeIndex;
  if (typeof authorizeIndex !== 'function') return () => {};

  function authorizeEmbeddedIndex(request, response, ...args) {
    const headers = request.headers;
    const header = (name) => typeof headers?.get === 'function' ? headers.get(name) : headers?.[name];
    if (request.method !== 'GET' || !/^127\.0\.0\.1:\d+$/.test(header('host') || '')
      || header('sec-fetch-dest') !== 'iframe') {
      return authorizeIndex.call(this, request, response, ...args);
    }
    const url = URL.parse(request.url, 'http://127.0.0.1');
    if (url?.pathname !== '/' || url.searchParams.get('dsh_embed') !== 'vscode' || !url.searchParams.has('token')) {
      return authorizeIndex.call(this, request, response, ...args);
    }

    const writeHead = response.writeHead;
    response.writeHead = function writeEmbeddedHead(status, headers, ...extra) {
      if (status === 303 && headers?.location === './' && typeof headers['set-cookie'] === 'string'
        && /;\s*SameSite=Strict(?:;|$)/i.test(headers['set-cookie'])) {
        // Chromium accepts Secure cookies on loopback. Partitioning confines
        // the signed DSH cookie to the top-level site that opened the iframe.
        const cookie = headers['set-cookie']
          .replace(/;\s*(?:SameSite=Strict|Secure|Partitioned)(?=;|$)/gi, '');
        headers = {
          ...headers,
          'set-cookie': `${cookie}; SameSite=None; Secure; Partitioned`,
          location: preserveEmbedParameters(url),
        };
      }
      return writeHead.call(this, status, headers, ...extra);
    };
    try {
      return authorizeIndex.call(this, request, response, ...args);
    } finally {
      response.writeHead = writeHead;
    }
  }

  service.authorizeIndex = authorizeEmbeddedIndex;
  return () => {
    if (service.authorizeIndex === authorizeEmbeddedIndex) service.authorizeIndex = authorizeIndex;
  };
}

export { installEmbedAuth };
