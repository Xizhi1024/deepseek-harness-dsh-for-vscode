'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME_MODES = Object.freeze({
  SHARED: 'shared',
  ISOLATED: 'isolated',
});

const MIGRATION_STATE_KEY = 'dsh.home.v0.5.0.migrated';

function normalizeHomeMode(value) {
  return value === HOME_MODES.ISOLATED ? HOME_MODES.ISOLATED : HOME_MODES.SHARED;
}

function validateConfiguredHome(value) {
  const candidate = String(value || '').trim();
  if (candidate === '') return '';
  if (candidate.includes('\0') || !path.isAbsolute(candidate)) {
    const error = new Error('dsh.home.path must be an absolute path');
    error.code = 'CONFIG_HOME_PATH_INVALID';
    throw error;
  }
  return path.resolve(candidate);
}

/** Resolve the DSH user-data root independently from the runtime binary. */
function resolveDshHome({
  mode = HOME_MODES.SHARED,
  configuredPath = '',
  globalStoragePath,
  env = process.env,
  homedir = os.homedir,
} = {}) {
  if (typeof globalStoragePath !== 'string' || !path.isAbsolute(globalStoragePath)) {
    throw new Error('VS Code global storage path must be absolute');
  }
  const normalizedMode = normalizeHomeMode(mode);
  if (normalizedMode === HOME_MODES.ISOLATED) {
    return Object.freeze({
      mode: normalizedMode,
      path: path.join(path.resolve(globalStoragePath), '.dsh'),
      source: 'extension-global-storage',
    });
  }

  const explicit = validateConfiguredHome(configuredPath);
  if (explicit) {
    return Object.freeze({ mode: normalizedMode, path: explicit, source: 'setting' });
  }
  const inherited = String(env.DSH_HOME || '').trim();
  if (inherited) {
    if (inherited.includes('\0')) {
      const error = new Error('DSH_HOME must not contain NUL');
      error.code = 'CONFIG_HOME_PATH_INVALID';
      throw error;
    }
    return Object.freeze({
      mode: normalizedMode,
      path: path.resolve(inherited),
      source: 'environment',
    });
  }
  return Object.freeze({
    mode: normalizedMode,
    path: path.join(path.resolve(homedir()), '.dsh'),
    source: 'official-default',
  });
}

async function realpathOrResolved(value) {
  try {
    return await fs.promises.realpath(value);
  } catch {
    return path.resolve(value);
  }
}

async function sameHome(left, right, platform = process.platform) {
  const [a, b] = await Promise.all([realpathOrResolved(left), realpathOrResolved(right)]);
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function directoryHasEntries(directory) {
  try {
    return (await fs.promises.readdir(directory)).length > 0;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function hasExplicitSetting(settings, setting) {
  if (!settings || typeof settings.inspect !== 'function') return false;
  const inspected = settings.inspect(setting);
  if (!inspected || typeof inspected !== 'object') return false;
  return [
    'globalValue',
    'globalLanguageValue',
    'workspaceValue',
    'workspaceLanguageValue',
    'workspaceFolderValue',
    'workspaceFolderLanguageValue',
  ].some((key) => inspected[key] !== undefined);
}

function hasExplicitHomeMode(settings) {
  return hasExplicitSetting(settings, 'home.mode');
}

/**
 * One-time 0.4.x compatibility guard. Existing non-empty isolated homes are
 * preserved unless the user explicitly selected a mode. Nothing is copied or
 * merged. Junctions/symlinks already targeting the shared home are treated as
 * shared, so the temporary 0.4.3 workaround upgrades cleanly.
 */
async function migrateLegacyHomeMode({ vscode, context, sharedHome, isolatedHome } = {}) {
  if (!context || !context.globalState || typeof context.globalState.get !== 'function') {
    return Object.freeze({ changed: false, reason: 'state-unavailable' });
  }
  if (context.globalState.get(MIGRATION_STATE_KEY, false)) {
    return Object.freeze({ changed: false, reason: 'already-migrated' });
  }

  const settings = vscode.workspace.getConfiguration('dsh');
  let changed = false;
  let reason = 'shared-default';
  if (!hasExplicitHomeMode(settings) && !hasExplicitSetting(settings, 'home.path')) {
    const legacyHasData = await directoryHasEntries(isolatedHome);
    const aliasesShared = legacyHasData && await sameHome(isolatedHome, sharedHome);
    if (legacyHasData && !aliasesShared && typeof settings.update === 'function') {
      const target = vscode.ConfigurationTarget ? vscode.ConfigurationTarget.Global : 1;
      await settings.update('home.mode', HOME_MODES.ISOLATED, target);
      changed = true;
      reason = 'legacy-isolated-preserved';
    }
  } else {
    reason = 'explicit-setting';
  }
  if (typeof context.globalState.update === 'function') {
    await context.globalState.update(MIGRATION_STATE_KEY, true);
  }
  return Object.freeze({ changed, reason });
}

/** Attach the selected user-data home to a verified runtime payload. */
function bindRuntimeHome(runtime, dshHome) {
  if (!runtime || typeof runtime !== 'object') throw new Error('DSH runtime is unavailable');
  if (typeof dshHome !== 'string' || !path.isAbsolute(dshHome)) {
    throw new Error('DSH home must be absolute');
  }
  const resolvedHome = path.resolve(dshHome);
  return Object.freeze({
    ...runtime,
    dshHome: resolvedHome,
    profileHome: path.join(resolvedHome, 'profiles', 'web'),
    profileName: 'web',
  });
}

module.exports = {
  HOME_MODES,
  MIGRATION_STATE_KEY,
  bindRuntimeHome,
  directoryHasEntries,
  hasExplicitHomeMode,
  migrateLegacyHomeMode,
  normalizeHomeMode,
  resolveDshHome,
  sameHome,
  validateConfiguredHome,
};
