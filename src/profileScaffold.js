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

// The extension assembles and syncs its own dsh-vscode-integration copy via
// overlays (src/dshIntegration.js + embedOverlay); inheriting the donor's
// dependency/bundle entry would race that mechanism, so it is dropped.
const EXTENSION_MANAGED_PACKAGES = new Set(['dsh-vscode-integration']);

// Default donor profile whose module config (dependencies, bundle list,
// patch-layer disables) a freshly scaffolded custom profile inherits.
const DEFAULT_DONOR_PROFILE = 'web';

const CORDIS_PATCH_TEMPLATE = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries (id-targeted config',
  '# overrides, disables, and insert lists; `!!js` expressions allowed).',
  '[]',
  '',
].join('\n');

const PNPM_WORKSPACE_YAML = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n';

function readJsonIfExists(file, deps) {
  try {
    if (!deps.existsSync(file)) return null;
    return JSON.parse(deps.readFileSync(file, 'utf8'));
  } catch (_) {
    return null; // a malformed donor manifest must never block scaffolding
  }
}

function readTextIfExists(file, deps) {
  try {
    if (!deps.existsSync(file)) return null;
    return deps.readFileSync(file, 'utf8');
  } catch (_) {
    return null;
  }
}

/**
 * Merge the donor profile's module config into a fresh scaffold manifest:
 * dependencies are inherited verbatim (minus extension-managed packages),
 * the bundle list keeps the base composition first, then donor bundles in
 * their original order, deduplicated.
 */
function inheritManifest(donorManifest) {
  const dependencies = {};
  const donorDeps = (donorManifest && donorManifest.dependencies && typeof donorManifest.dependencies === 'object')
    ? donorManifest.dependencies
    : {};
  for (const [name, spec] of Object.entries(donorDeps)) {
    if (EXTENSION_MANAGED_PACKAGES.has(name)) continue;
    if (typeof spec !== 'string' || spec.length === 0) continue;
    dependencies[name] = spec;
  }
  const donorBundles = Array.isArray(donorManifest && donorManifest.dsh
    && donorManifest.dsh.profile && donorManifest.dsh.profile.bundles)
    ? donorManifest.dsh.profile.bundles
    : [];
  const bundles = [...SCAFFOLD_BUNDLES];
  for (const bundle of donorBundles) {
    if (typeof bundle !== 'string' || bundle.length === 0) continue;
    if (EXTENSION_MANAGED_PACKAGES.has(bundle)) continue;
    if (!bundles.includes(bundle)) bundles.push(bundle);
  }
  return { dependencies, bundles };
}

/**
 * Ensure a custom profile directory exists with the manifest, user patch
 * layer, and pnpm settings the runtime's initProfile writes for its shipped
 * profile names. DSH only auto-initializes built-in names; any other name —
 * like the extension-owned 'vscode' profile — must exist before
 * `--profile <name>` boots, or dsh exits with
 * `profile "<name>" does not exist`. Mirrors initProfile semantics: files
 * are created only when missing, so an initialized profile is never touched.
 *
 * Inheritance: when a profile is created FRESH and a donor profile (default
 * 'web' — what a terminal `dsh web` bootstrapped on first run) exists in
 * the same home, the new profile inherits the donor's module config: its
 * package.json dependencies, its dsh.profile.bundles list, and — verbatim —
 * its cordis.patch.yml (module disables, guards, inserts). This keeps the
 * embedded sidebar feature-equivalent to the user's terminal DSH instead of
 * booting an empty plugin tree. An existing profile is never re-inherited.
 *
 * @param {{dshHome: string, profileName: string, donorProfileName?: string, deps?: object}} input
 * @returns {{profileName: string, created: string[], skipped: boolean, inheritedFrom: string|null}}
 *   `skipped` marks runtime-template names left to the runtime itself;
 *   `inheritedFrom` names the donor profile copied from, or null.
 */
function ensureProfileScaffold({ dshHome, profileName, donorProfileName = DEFAULT_DONOR_PROFILE, deps = {} } = {}) {
  if (typeof dshHome !== 'string' || !path.isAbsolute(dshHome)) {
    throw new Error('Profile scaffold requires an absolute dshHome');
  }
  assertValidProfileName(profileName);
  if (RUNTIME_TEMPLATE_PROFILES.has(profileName)) {
    return { profileName, created: [], skipped: true, inheritedFrom: null };
  }
  const {
    existsSync = fs.existsSync,
    mkdirSync = fs.mkdirSync,
    writeFileSync = fs.writeFileSync,
    readFileSync = fs.readFileSync,
  } = deps;
  const fsDeps = { existsSync, readFileSync };
  const homeRoot = path.resolve(dshHome);
  const profileDir = path.join(homeRoot, 'profiles', profileName);
  mkdirSync(profileDir, { recursive: true });
  const created = [];
  let inheritedFrom = null;
  // Donor lookup only matters when files will actually be created; resolve it
  // lazily so an already-initialized profile never touches donor state.
  const manifestPath = path.join(profileDir, 'package.json');
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  const needsManifest = !existsSync(manifestPath);
  const needsPatch = !existsSync(patchPath);
  let donorDir = null;
  if ((needsManifest || needsPatch) && typeof donorProfileName === 'string' && donorProfileName.length > 0) {
    const candidate = path.join(homeRoot, 'profiles', donorProfileName);
    if (existsSync(candidate)) donorDir = candidate;
  }
  if (needsManifest) {
    const donorManifest = donorDir ? readJsonIfExists(path.join(donorDir, 'package.json'), fsDeps) : null;
    const inherited = donorManifest ? inheritManifest(donorManifest) : { dependencies: {}, bundles: [...SCAFFOLD_BUNDLES] };
    if (donorManifest) inheritedFrom = donorProfileName;
    const manifest = {
      name: `dsh-profile-${profileName}`,
      private: true,
      dependencies: inherited.dependencies,
      dsh: { profile: { bundles: inherited.bundles, patchReload: 'live' } },
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    created.push('package.json');
  }
  if (needsPatch) {
    // Inherit the donor's patch layer verbatim: it carries the module
    // disables/guards the user curated (which modules exist, which are off).
    // The hmrGuard still runs afterwards and enforces its own hmr disable.
    const donorPatch = donorDir ? readTextIfExists(path.join(donorDir, 'cordis.patch.yml'), fsDeps) : null;
    if (donorPatch !== null && donorPatch.trim().length > 0) {
      writeFileSync(patchPath, donorPatch, 'utf8');
      if (inheritedFrom === null) inheritedFrom = donorProfileName;
    } else {
      writeFileSync(patchPath, CORDIS_PATCH_TEMPLATE, 'utf8');
    }
    created.push('cordis.patch.yml');
  }
  const workspacePath = path.join(profileDir, 'pnpm-workspace.yaml');
  if (!existsSync(workspacePath)) {
    writeFileSync(workspacePath, PNPM_WORKSPACE_YAML, 'utf8');
    created.push('pnpm-workspace.yaml');
  }
  return { profileName, created, skipped: false, inheritedFrom };
}

module.exports = {
  ensureProfileScaffold,
  RUNTIME_TEMPLATE_PROFILES,
  SCAFFOLD_BUNDLES,
  DEFAULT_DONOR_PROFILE,
};
