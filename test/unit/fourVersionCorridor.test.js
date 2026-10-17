'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TARGET_VERSION, runtimeDescriptor } = require('../../src/runtime/compatibility');
const { deriveRuntimeProfileName } = require('../../src/profileScaffold');
const { validateCapabilityReport } = require('../../src/protocol/runtime');

const corridor = [
  ['0.2.1-rc.2', 'dsh021rc2', 'createDsh021rc2Adapter'],
  ['0.2.1-rc.1', 'dsh021rc1', 'createDsh021rc1Adapter'],
  ['0.2.0-rc.2', 'dsh020rc2', 'createDsh020rc2Adapter'],
  ['0.2.0-rc.1', 'dsh020rc1', 'createDsh020rc1Adapter'],
];
test('four exact RC identities pair across Host, integration and wire without sharing profiles', async () => {
  assert.equal(TARGET_VERSION, corridor[0][0]);
  const profiles = new Set();
  for (const [version, file, factory] of corridor) {
    const entry = await import(`../../runtime-integration/dsh-vscode-integration/lib/adapters/${file}.js`);
    const create = entry[factory];
    const input = { ctx: {}, runtimeInstanceId: 'probe', integrationVersion: '0.11.0', runtimeVersion: version };
    const report = create(input).capabilities();
    assert.equal(report.adapterId, runtimeDescriptor(version).adapterId);
    assert.equal(validateCapabilityReport(report), true);
    for (const [other] of corridor) if (other !== version) {
      assert.equal(validateCapabilityReport({ ...report, runtimeVersion: other }), false);
      assert.throws(() => create({ ...input, runtimeVersion: other }), { code: 'UNSUPPORTED_RUNTIME' });
    }
    const profile = deriveRuntimeProfileName('sprint1', version);
    assert.ok(!profiles.has(profile)); profiles.add(profile);
  }
  for (const version of ['0.2.1', '0.2.1-rc.3', '0.2.1-alpha.5', '0.2.1-rc.2+fork']) {
    assert.equal(runtimeDescriptor(version), null);
  }
});
