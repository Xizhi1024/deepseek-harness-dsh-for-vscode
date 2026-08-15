'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Add existing npm-global directories omitted by GUI-launched environments.
 *
 * @param {object} [options]
 * @param {object} [options.env]
 * @param {string} [options.platform]
 * @param {(directory: string) => boolean} [options.existsSync]
 */
function ensureDshOnPath({
  env = process.env,
  platform = process.platform,
  existsSync = fs.existsSync,
} = {}) {
  const parts = (env.PATH || '').split(path.delimiter);
  const append = (directory) => {
    if (directory && !parts.includes(directory)) {
      env.PATH = (env.PATH || '') + path.delimiter + directory;
      parts.push(directory);
    }
  };

  if (platform === 'win32') {
    if (env.APPDATA) append(path.join(env.APPDATA, 'npm'));
    return;
  }
  if (platform !== 'darwin' && platform !== 'linux') return;

  const candidates = [];
  if (env.HOME) {
    candidates.push(path.join(env.HOME, '.npm-global', 'bin'));
    candidates.push(path.join(env.HOME, '.local', 'bin'));
    candidates.push(path.join(env.HOME, '.yarn', 'bin'));
  }
  candidates.push('/usr/local/bin', '/opt/homebrew/bin');
  for (const directory of candidates) {
    try {
      if (existsSync(directory)) append(directory);
    } catch {
      // A failed advisory existence check must not prevent extension activation.
    }
  }
}

module.exports = { ensureDshOnPath };
