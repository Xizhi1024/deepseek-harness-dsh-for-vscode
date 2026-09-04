import test from 'node:test';
import assert from 'node:assert/strict';

import {
  claimOpenPathSurface,
  installOpenPathBridge,
  OPEN_PATH_SURFACES,
} from '../lib/index.js';

const envelopeSurface = OPEN_PATH_SURFACES.find((s) => s.service === 'apiProxy');
const plainSurface = OPEN_PATH_SURFACES.find((s) => s.service === 'sessionController');

function makeOpenImpl() {
  const calls = [];
  return {
    calls,
    impl: async (path, signal) => {
      calls.push({ path, signal });
      if (implMode.reject) throw new Error(implMode.message);
    },
  };
}

let implMode = { reject: false, message: 'boom' };

function resetImpl() {
  implMode = { reject: false, message: 'boom' };
}

test('claimOpenPathSurface wraps the apiProxy envelope host (pre-0.1.2-rc.1 runtimes)', async () => {
  resetImpl();
  const original = async () => ({ rpcId: 'native', result: { ok: true, value: { opened: false } } });
  const host = { openPath: original };
  const ctx = { apiProxy: { host } };
  const { impl, calls } = makeOpenImpl();
  const release = claimOpenPathSurface(ctx, envelopeSurface, impl);
  assert.strictEqual(typeof release, 'function');
  const signal = { marker: 1 };
  const response = await host.openPath({ rpcId: 'r1', payload: { path: 'D:/tmp/a.txt' } }, signal);
  assert.deepStrictEqual(calls, [{ path: 'D:/tmp/a.txt', signal }]);
  assert.deepStrictEqual(response, {
    rpcId: 'r1',
    result: { ok: true, value: { opened: true } },
  });
  release();
  assert.strictEqual(host.openPath, original);
});

test('envelope claim reports bridge failures through the rpc envelope', async () => {
  resetImpl();
  implMode.reject = true;
  const host = { openPath: async () => ({ rpcId: 'native' }) };
  const ctx = { apiProxy: { host } };
  const release = claimOpenPathSurface(ctx, envelopeSurface, makeOpenImpl().impl);
  const response = await host.openPath({ rpcId: 'r2', payload: { path: 'D:/tmp/a.txt' } });
  assert.strictEqual(response.rpcId, 'r2');
  assert.strictEqual(response.result.ok, false);
  assert.match(response.result.error.message, /boom/);
  release();
});

test('envelope claim rejects requests without a string path', async () => {
  resetImpl();
  const host = { openPath: async () => ({ rpcId: 'native' }) };
  const ctx = { apiProxy: { host } };
  const release = claimOpenPathSurface(ctx, envelopeSurface, makeOpenImpl().impl);
  const response = await host.openPath({ rpcId: 'r3', payload: {} });
  assert.strictEqual(response.result.ok, false);
  assert.match(response.result.error.message, /a path is required/);
  release();
});

test('plain claim wraps sessionController (0.1.2-rc.1+ runtimes)', async () => {
  resetImpl();
  let nativeCalls = 0;
  const service = {
    openPath: async () => {
      nativeCalls += 1;
      return 'native-result';
    },
  };
  const release = claimOpenPathSurface({ sessionController: service }, plainSurface, makeOpenImpl().impl);
  const signal = { marker: 2 };
  const result = await service.openPath('D:/tmp/b.txt', signal);
  assert.strictEqual(result, undefined);
  assert.strictEqual(nativeCalls, 0);
  release();
});

test('plain claim falls back to the native opener when the bridge fails', async () => {
  resetImpl();
  implMode.reject = true;
  const seen = [];
  const service = {
    openPath: async (path, signal) => {
      seen.push({ path, signal });
      return 'native-result';
    },
  };
  const release = claimOpenPathSurface({ sessionController: service }, plainSurface, makeOpenImpl().impl);
  const result = await service.openPath('D:/tmp/b.txt');
  assert.strictEqual(result, 'native-result');
  assert.deepStrictEqual(seen, [{ path: 'D:/tmp/b.txt', signal: undefined }]);
  release();
});

test('plain claim routes non-string paths straight to the native opener', async () => {
  resetImpl();
  const seen = [];
  const service = {
    openPath: async (path) => {
      seen.push(path);
      return 'native-result';
    },
  };
  const { impl, calls } = makeOpenImpl();
  const release = claimOpenPathSurface({ sessionController: service }, plainSurface, impl);
  const result = await service.openPath(42);
  assert.strictEqual(result, 'native-result');
  assert.deepStrictEqual(calls, []);
  assert.deepStrictEqual(seen, [42]);
  release();
});

test('claimOpenPathSurface ignores surfaces without an openPath function', () => {
  resetImpl();
  assert.strictEqual(claimOpenPathSurface({ apiProxy: { host: {} } }, envelopeSurface, makeOpenImpl().impl), null);
  assert.strictEqual(claimOpenPathSurface({}, plainSurface, makeOpenImpl().impl), null);
});

function makeRecordingCtx() {
  const registrations = [];
  return {
    registrations,
    inject(deps, callback) {
      registrations.push({ deps, callback });
    },
  };
}

function makeLiveCtx(services) {
  return {
    inject(deps, callback) {
      const service = services[deps[0]];
      if (service !== undefined) callback({ [deps[0]]: service });
    },
  };
}

test('installOpenPathBridge registers both surfaces and claims whichever appears', () => {
  resetImpl();
  const ctx = makeRecordingCtx();
  installOpenPathBridge(ctx, { warnDelayMs: 0 });
  assert.deepStrictEqual(ctx.registrations.map((r) => r.deps), [['apiProxy'], ['sessionController']]);

  const original = async () => ({ rpcId: 'native' });
  const host = { openPath: original };
  ctx.registrations[0].callback({ apiProxy: { host } });
  assert.notStrictEqual(host.openPath, original);
});

test('installOpenPathBridge claims at most one surface even when both services exist', () => {
  resetImpl();
  const originalA = async () => ({ rpcId: 'a' });
  const originalB = async () => 'b';
  const hostA = { openPath: originalA };
  const serviceB = { openPath: originalB };
  const ctx = makeLiveCtx({
    apiProxy: { host: hostA },
    sessionController: serviceB,
  });
  const stop = installOpenPathBridge(ctx, { warnDelayMs: 0 });
  assert.notStrictEqual(hostA.openPath, originalA, 'first surface must be claimed');
  assert.strictEqual(serviceB.openPath, originalB, 'second surface must stay untouched');
  stop();
  assert.strictEqual(hostA.openPath, originalA, 'stop restores the original');
});

test('installOpenPathBridge degrades quietly when no surface ever appears', () => {
  resetImpl();
  const ctx = makeRecordingCtx();
  const stop = installOpenPathBridge(ctx, { warnDelayMs: 0 });
  assert.strictEqual(typeof stop, 'function');
  stop();
});

test('installOpenPathBridge tolerates runtimes without ctx.inject', () => {
  resetImpl();
  const stop = installOpenPathBridge({}, { warnDelayMs: 0 });
  assert.strictEqual(typeof stop, 'function');
  stop();
});