'use strict';

const { execFile } = require('node:child_process');

const TARGET_VERSION = '0.2.0-rc.2';
const LEGACY_VERSION = '0.1.2-rc.1';
const NODE_RANGE = '^22.19.0 || >=24.0.0';

/**
 * Exact version descriptors: one entry per runtime this extension has a
 * verified adapter for. `line` selects the launch path ('target' uses the
 * runtime supervisor and facade; 'legacy' the manager path), `profileSuffix`
 * separates target plugin copies so they never overwrite each other, and
 * `adapterId` is the identity pair half reported by capabilities and the
 * browser handshake. Unknown versions map to no descriptor and are rejected.
 */
const RUNTIME_DESCRIPTORS = Object.freeze({
  '0.1.2-rc.1': Object.freeze({ adapterId: 'legacy-0.1.2-rc.1', line: 'legacy', profileSuffix: '' }),
  '0.2.0-rc.1': Object.freeze({ adapterId: 'dsh-0.2.0-rc.1', line: 'target', profileSuffix: '-dsh020rc1' }),
  '0.2.0-rc.2': Object.freeze({ adapterId: 'dsh-0.2.0-rc.2', line: 'target', profileSuffix: '-dsh020rc2' }),
});

const TARGET_VERSIONS = Object.freeze(Object.entries(RUNTIME_DESCRIPTORS)
  .filter(([, descriptor]) => descriptor.line === 'target').map(([version]) => version));
const SUPPORTED_VERSIONS = Object.freeze(Object.keys(RUNTIME_DESCRIPTORS));
const TARGET_ADAPTERS = Object.freeze(TARGET_VERSIONS.map((version) => RUNTIME_DESCRIPTORS[version].adapterId));

/** Descriptor for one exact version, or null when the version has no adapter. */
function runtimeDescriptor(version) {
  return Object.prototype.hasOwnProperty.call(RUNTIME_DESCRIPTORS, version) ? RUNTIME_DESCRIPTORS[version] : null;
}

function portError(code, message, retryable = false, effect = 'none') {
  return Object.assign(new Error(message), { code, retryable, effect });
}

/** Exact adapters are a selection policy, not a claim of completed E2E certification. */
function runtimeCompatibility(version) {
  const descriptor = runtimeDescriptor(version);
  if (descriptor) return Object.freeze({ state: 'available', adapterId: descriptor.adapterId });
  return Object.freeze({ state: 'unverified', adapterId: null, reason: 'This exact DSH version has no verified adapter.' });
}

function isTargetRuntimeVersion(version) {
  return runtimeDescriptor(version)?.line === 'target';
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
    throw portError('UNSUPPORTED_RUNTIME', `Target DSH runtimes require Node ${NODE_RANGE}.`);
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
  TARGET_VERSION, LEGACY_VERSION, TARGET_VERSIONS, SUPPORTED_VERSIONS, TARGET_ADAPTERS,
  TARGET_ADAPTER: RUNTIME_DESCRIPTORS[TARGET_VERSION].adapterId, LEGACY_ADAPTER: RUNTIME_DESCRIPTORS[LEGACY_VERSION].adapterId,
  RUNTIME_DESCRIPTORS, NODE_RANGE,
  runtimeDescriptor, runtimeCompatibility, isTargetRuntimeVersion, portError, supportsTargetNode, verifyNodeRuntime, assertCapabilityIdentity,
};
