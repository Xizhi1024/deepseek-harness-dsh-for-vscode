'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');

// node test/extension-host/installed-pair.js <installed-profile.json> <output-root>
// Each Code window discovers the product only from an installed VSIX. The
// native UI in B must still send/receive after the entire A Code process exits.
async function main(profileFile = process.argv[2], outputRoot = process.argv[3]) {
  assert.ok(path.isAbsolute(profileFile || '') && path.isAbsolute(outputRoot || ''));
  const base = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
  fs.mkdirSync(outputRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(outputRoot, 'pair-'));
  const coordinationRoot = path.join(root, 'coordination');
  const repoRoot = path.resolve(__dirname, '../..');
  async function run(role) {
    const profile = { ...base, isolationRoot: path.join(root, role), coordinationRoot, windowRole: role,
      uiScope: 'basic', colorTheme: role === 'a' ? 'Default Light Modern' : 'Default Dark Modern' };
    const file = path.join(root, `profile-${role}.json`);
    fs.writeFileSync(file, JSON.stringify(profile, null, 2));
    const log = fs.createWriteStream(path.join(root, `${role}.log`));
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(__dirname, 'installed-smoke.js'), file],
        { cwd: repoRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
      child.once('error', reject); child.once('close', resolve);
    });
    log.end();
    assert.equal(code, 0, `Window ${role} failed; see ${path.join(root, `${role}.log`)}`);
    const closed = JSON.parse(fs.readFileSync(path.join(coordinationRoot, `${role}-closed.json`), 'utf8'));
    const proof = JSON.parse(fs.readFileSync(closed.proofPath, 'utf8'));
    assert.equal(proof.runtimeUiAcceptance.status, 'PASS'); assert.equal(proof.ownedRuntimeStopped, true);
    return { ...closed, proof };
  }
  const [a, b] = await Promise.all([run('a'), run('b')]);
  assert.equal(a.proof.vsixSha256, b.proof.vsixSha256);
  assert.equal(b.proof.runtimeUiAcceptance.pairedWindows.responseAfterPeerWindowClosed, true);
  const evidence = { status: 'PASS', runtimeVersion: base.runtimeVersion, vsixSha256: a.proof.vsixSha256,
    scope: 'Two installed Code windows; distinct workspace/process/endpoint/Session; B native UI responds after A Code exits',
    a: a.proofPath, b: b.proofPath, finishedAt: new Date().toISOString() };
  const evidencePath = path.join(root, 'evidence.json');
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ ...evidence, evidencePath }));
  return evidence;
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
