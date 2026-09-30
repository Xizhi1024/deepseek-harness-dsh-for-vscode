'use strict';

const { execFile } = require('node:child_process');

const TARGET_VERSION = '0.2.0-rc.1';
const LEGACY_VERSION = '0.1.2-rc.1';
const TARGET_ADAPTER = 'dsh-0.2.0-rc.1';
const LEGACY_ADAPTER = 'legacy-0.1.2-rc.1';
const NODE_RANGE = '^22.19.0 || >=24.0.0';

function portError(code, message, retryable = false, effect = 'none') {
  return Object.assign(new Error(message), { code, retryable, effect });
}

/** Exact adapters are a selection policy, not a claim of completed E2E certification. */
function runtimeCompatibility(version) {
  if (version === TARGET_VERSION) return Object.freeze({ state: 'available', adapterId: TARGET_ADAPTER });
  if (version === LEGACY_VERSION) return Object.freeze({ state: 'available', adapterId: LEGACY_ADAPTER });
  return Object.freeze({ state: 'unverified', adapterId: null, reason: 'This exact DSH version has no verified adapter.' });
}

function supportsTargetNode(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(version || '').trim());
  if (!match) return false;
  const [major, minor] = match.slice(1).map(Number);
  return major >= 24 || (major === 22 && minor >= 19);
}

/** Probe the selected executable, never the extension host's Node version. */
async function verifyNodeRuntime(executablePath, { execFileFn = execFile, signal, timeoutMs = 5000 } = {}) {
  if (signal?.aborted) throw portError('CANCELLED', 'Runtime verification was cancelled.');
  const version = await new Promise((resolve, reject) => {
    execFileFn(executablePath, ['--version'], {
      windowsHide: true, timeout: Math.min(5000, Math.max(1, timeoutMs)),
      maxBuffer: 4096, ...(signal ? { signal } : {}),
    }, (error, stdout) => {
      if (error) {
        reject(portError(signal?.aborted ? 'CANCELLED' : 'UNSUPPORTED_RUNTIME', 'The selected Node executable could not be verified.'));
        return;
      }
      resolve(String(stdout || '').trim());
    });
  });
  if (!supportsTargetNode(version)) {
    throw portError('UNSUPPORTED_RUNTIME', `DSH ${TARGET_VERSION} requires Node ${NODE_RANGE}.`);
  }
  return version;
}

function assertCapabilityIdentity(report, identity, instanceId) {
  if (!report || report.protocolVersion !== 1 || report.runtimeInstanceId !== instanceId
      || report.runtimeVersion !== identity.runtimeVersion || report.integrationVersion !== identity.integrationVersion
      || report.adapterId !== identity.adapterId || report.reconnectMode !== 'snapshot-reconcile') {
    throw portError('PROTOCOL_MISMATCH', 'The runtime capability identity does not match this launch.');
  }
  for (const name of ['workspaces', 'sessions', 'prompt', 'follow', 'cancelSession']) {
    if (report.features?.[name]?.state !== 'available') {
      throw portError('CAPABILITY_UNAVAILABLE', `The runtime capability ${name} is unavailable.`);
    }
  }
  return report;
}

module.exports = {
  TARGET_VERSION, LEGACY_VERSION, TARGET_ADAPTER, LEGACY_ADAPTER, NODE_RANGE,
  portError, runtimeCompatibility, supportsTargetNode, verifyNodeRuntime, assertCapabilityIdentity,
};
