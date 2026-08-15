const inject = ['apiProxy'];
const name = 'dsh-vscode-integration';

function failure(request, message) {
  return {
    rpcId: request.rpcId,
    result: {
      ok: false,
      error: { code: 'internal', message, details: {} },
    },
  };
}

async function openThroughBridge(path, signal, env = process.env) {
  const rawUrl = env.DSH_VSCODE_OPEN_URL;
  const token = env.DSH_VSCODE_OPEN_TOKEN;
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || typeof token !== 'string' || token.length === 0) {
    throw new Error('VS Code text-document bridge is unavailable');
  }
  const endpoint = new URL(rawUrl);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password) {
    throw new Error('VS Code text-document bridge endpoint is invalid');
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ path }),
    signal,
  });
  if (!response.ok) throw new Error(`VS Code rejected the file-open request (${response.status})`);
}

function apply(ctx) {
  ctx.effect(() => {
    const host = ctx.apiProxy.host;
    const original = host.openPath;
    host.openPath = async (request, signal) => {
      const target = request && request.payload && request.payload.path;
      if (typeof target !== 'string' || target.length === 0) {
        return failure(request, 'path open failed: a path is required');
      }
      try {
        await openThroughBridge(target, signal);
        return { rpcId: request.rpcId, result: { ok: true, value: { opened: true } } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failure(request, `path open failed: ${message}`);
      }
    };
    return () => { host.openPath = original; };
  }, 'dsh-vscode-integration: host.openPath bridge');
}

export { apply, inject, name, openThroughBridge };
