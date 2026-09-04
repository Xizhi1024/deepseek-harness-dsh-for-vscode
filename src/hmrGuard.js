'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Aligns the profile with upstream fd814589fb (DSH 0.1.2-alpha.1): shipped
// profiles disable server module HMR there. Below that version the
// enabled-by-default cordis-plugin-hmr reloads break every in-flight tool
// call ("Cannot read properties of undefined (reading 'kind')", live
// incidents 2026-09-03 / 2026-09-04). Redundant but harmless on newer
// runtimes, so the guard applies regardless of the detected version.
const HMR_GUARD_COMMENT = [
  '',
  '# dsh-vs-sidebar hmr guard: disable server module HMR (upstream',
  '# fd814589fb / DSH 0.1.2-alpha.1 shipped-profile default). Module reloads',
  '# on older runtimes break every in-flight tool call until instance restart;',
  '# redundant but harmless on newer runtimes.',
].join('\n');

const HMR_ENTRY = [
  '- id: hmr',
  '  name: "@deepseek-ai/cordis-plugin-hmr"',
  '  disabled: true',
].join('\n');

function replaceEmptySequenceDocument(text, replacement) {
  const semanticLines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  if (semanticLines.length !== 1 || semanticLines[0] !== '[]') {
    return null;
  }
  return String(text).replace(/^\s*\[\]\s*$/m, replacement);
}

function ensureHmrDisabled({ dshHome, profileName, dshVersion = null, fsOps = {} } = {}) {
  if (typeof dshHome !== 'string' || dshHome.length === 0) {
    throw new TypeError('ensureHmrDisabled requires dshHome');
  }
  if (typeof profileName !== 'string' || profileName.length === 0) {
    throw new TypeError('ensureHmrDisabled requires profileName');
  }
  const {
    existsSync = fs.existsSync,
    readFileSync = fs.readFileSync,
    writeFileSync = fs.writeFileSync,
    renameSync = fs.renameSync,
    mkdirSync = fs.mkdirSync,
    copyFileSync = fs.copyFileSync,
  } = fsOps;
  const patchPath = path.join(dshHome, 'profiles', profileName, 'cordis.patch.yml');

  let text = null;
  if (existsSync(patchPath)) {
    text = readFileSync(patchPath, 'utf8');
    // Duplicate loader entry ids crash dsh at boot, so the guard NEVER
    // appends a second hmr entry: any existing `id: hmr` reference - or a
    // @deepseek-ai/cordis-plugin-hmr name reference in any shape - counts as
    // "already handled" and leaves the file byte-identical.
    if (/^\s*-\s*id:\s*hmr\s*$/m.test(text)) {
      return { applied: false, reason: 'already-present', patchPath, dshVersion };
    }
    if (/@deepseek-ai\/cordis-plugin-hmr/.test(text)) {
      return { applied: false, reason: 'already-present', patchPath, dshVersion };
    }
  }

  const entry = HMR_GUARD_COMMENT + '\n' + HMR_ENTRY + '\n';
  const temporary = patchPath + '.dshext-' + process.pid + '.tmp';
  mkdirSync(path.dirname(patchPath), { recursive: true });
  if (text === null) {
    writeFileSync(temporary, '# Your patch layer for this dsh profile.\n' + entry, 'utf8');
    renameSync(temporary, patchPath);
    return { applied: true, created: true, patchPath, dshVersion };
  }
  const backup = patchPath + '.bak-dshext';
  if (!existsSync(backup)) {
    try {
      copyFileSync(patchPath, backup);
    } catch {
      // best-effort backup: the atomic replace below is the real safety net
    }
  }
  // A freshly scaffolded custom profile uses `[]` as its complete empty YAML
  // document. Appending a list item after it creates two top-level values and
  // makes DSH abort while parsing the profile. Replace that sentinel instead;
  // existing non-empty patch lists still use the append path below.
  const replacement = entry.replace(/^\n/, '');
  const emptyDocumentReplacement = replaceEmptySequenceDocument(text, replacement);
  const nextText = emptyDocumentReplacement === null
    ? (text.endsWith('\n') ? text : text + '\n') + entry
    : emptyDocumentReplacement;
  writeFileSync(temporary, nextText, 'utf8');
  renameSync(temporary, patchPath);
  return { applied: true, created: false, patchPath, dshVersion };
}

module.exports = {
  ensureHmrDisabled,
  HMR_ENTRY,
};
