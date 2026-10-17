'use strict';

// Published-package declaration and manifest diff, following the community
// dsh-plugin-upgrade/scripts/diff-api.sh method. No install or source mutation.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const PACKAGES = ['dsh-api-session-controller', 'dsh-api-workspace-controller',
  'dsh-client-ui-workspace', 'dsh-client-ui-session', 'dsh-client-ui-layout',
  'dsh-client-ui-conversation', 'dsh-client-ui-sidebar-right', 'dsh-llm'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function packageDirectory(root, name) {
  const candidates = [path.join(path.dirname(root), name), path.join(root, 'node_modules/@deepseek-ai', name)];
  const found = candidates.find(directory => fs.existsSync(path.join(directory, 'package.json')));
  assert.ok(found, `Missing published package @deepseek-ai/${name}`);
  return found;
}
function declarations(root, prefix = '') {
  return fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'node_modules') return [];
    const relative = path.posix.join(prefix, entry.name);
    return entry.isDirectory() ? declarations(root, relative) : entry.name.endsWith('.d.ts') ? [relative] : [];
  });
}
function compare(fromRoot, toRoot, output) {
  const manifest = root => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const from = manifest(fromRoot), to = manifest(toRoot);
  assert.equal(from.name, '@deepseek-ai/dsh'); assert.equal(to.name, from.name);
  fs.mkdirSync(output, { recursive: true });
  const patches = [], packages = [];
  for (const name of PACKAGES) {
    const left = packageDirectory(fromRoot, name), right = packageDirectory(toRoot, name);
    const a = manifest(left), b = manifest(right);
    assert.equal(a.version, from.version, `Mixed source cohort: ${name}`);
    assert.equal(b.version, to.version, `Mixed target cohort: ${name}`);
    const files = [];
    for (const file of [...new Set([...declarations(left), ...declarations(right)])].sort()) {
      const oldFile = path.join(left, file), newFile = path.join(right, file);
      const old = fs.existsSync(oldFile) ? fs.readFileSync(oldFile) : null;
      const next = fs.existsSync(newFile) ? fs.readFileSync(newFile) : null;
      if (old && next && old.equals(next)) continue;
      files.push({ file, beforeSha256: old && sha256(old), afterSha256: next && sha256(next) });
      if (old && next) {
        const diff = spawnSync('git', ['diff', '--no-index', '--no-ext-diff', '--', oldFile, newFile], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
        assert.ok(diff.status === 0 || diff.status === 1, diff.stderr);
        patches.push(diff.stdout);
      } else patches.push(`\n${name}/${file}: ${old ? 'removed' : 'added'} declaration\n${(old || next).toString('utf8')}\n`);
    }
    const metadata = value => ({ exports: value.exports, peerDependencies: value.peerDependencies,
      dependencies: value.dependencies, dsh: value.dsh });
    packages.push({ name: a.name, declarations: files, beforeManifest: metadata(a), afterManifest: metadata(b) });
  }
  const report = { from: from.version, to: to.version, packages,
    limitations: ['Declaration and manifest differences require semantic review and real runtime/UI verification.'] };
  fs.writeFileSync(path.join(output, 'api.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'api.diff'), patches.join(''));
  return report;
}
if (require.main === module) {
  const [from, to, output] = process.argv.slice(2);
  assert.ok(from && to && output, 'Usage: node scripts/diff-runtime-api.js <from-dsh-root> <to-dsh-root> <output-directory>');
  const report = compare(path.resolve(from), path.resolve(to), path.resolve(output));
  console.log(JSON.stringify({ from: report.from, to: report.to, changedDeclarations: report.packages.reduce((n, p) => n + p.declarations.length, 0) }));
}
module.exports = { compare };
