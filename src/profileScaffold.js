'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { assertValidProfileName } = require('./managedRuntimeLaunch');

// Profile names the DSH runtime initializes itself on first use
// (PROFILE_TEMPLATES in dsh-app-boot: acp/web/headless/sdk). Scaffolding
// those here would only race the runtime's own initProfile, so they pass
// through untouched.
const RUNTIME_TEMPLATE_PROFILES = new Set(['acp', 'web', 'headless', 'sdk']);

// The web profile template's bundle layer (dsh-app-boot
// PROFILE_TEMPLATES.web): the embed boots the same base + web app
// composition as a terminal `dsh web`.
const SCAFFOLD_BUNDLES = Object.freeze(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);

const CORDIS_PATCH_TEMPLATE = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries (id-targeted config',
  '# overrides, disables, and insert lists; `!!js` expressions allowed).',
  '[]',
  '',
].join('\n');

const PNPM_WORKSPACE_YAML = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n';

/**
 * Ensure a custom profile directory exists with the manifest, user patch
 * layer, and pnpm settings the runtime's initProfile writes for its shipped
 * profile names. DSH only auto-initializes built-in names; any other name —
 * like the extension-owned 'vscode' profile — must exist before
 * `--profile <name>` boots, or dsh exits with
 * `profile "<name>" does not exist`. Mirrors initProfile semantics: files
 * are created only when missing, so an initialized profile is never touched.
 *
 * @param {{dshHome: string, profileName: string, deps?: object}} input
 * @returns {{profileName: string, created: string[], skipped: boolean}}
 *   `skipped` marks runtime-template names left to the runtime itself.
 */
function ensureProfileScaffold({ dshHome, profileName, deps = {} } = {}) {
  if (typeof dshHome !== 'string' || !path.isAbsolute(dshHome)) {
    throw new Error('Profile scaffold requires an absolute dshHome');
  }
  assertValidProfileName(profileName);
  if (RUNTIME_TEMPLATE_PROFILES.has(profileName)) {
    return { profileName, created: [], skipped: true };
  }
  const {
    existsSync = fs.existsSync,
    mkdirSync = fs.mkdirSync,
    writeFileSync = fs.writeFileSync,
  } = deps;
  const profileDir = path.join(path.resolve(dshHome), 'profiles', profileName);
  mkdirSync(profileDir, { recursive: true });
  const created = [];
  const manifestPath = path.join(profileDir, 'package.json');
  if (!existsSync(manifestPath)) {
    const manifest = {
      name: `dsh-profile-${profileName}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...SCAFFOLD_BUNDLES], patchReload: 'live' } },
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    created.push('package.json');
  }
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  if (!existsSync(patchPath)) {
    writeFileSync(patchPath, CORDIS_PATCH_TEMPLATE, 'utf8');
    created.push('cordis.patch.yml');
  }
  const workspacePath = path.join(profileDir, 'pnpm-workspace.yaml');
  if (!existsSync(workspacePath)) {
    writeFileSync(workspacePath, PNPM_WORKSPACE_YAML, 'utf8');
    created.push('pnpm-workspace.yaml');
  }
  return { profileName, created, skipped: false };
}

module.exports = { ensureProfileScaffold, RUNTIME_TEMPLATE_PROFILES, SCAFFOLD_BUNDLES };