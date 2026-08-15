'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  isValidDshVersion,
  parseRuntimeArtifactManifest,
  verifyRuntimeDirectory,
} = require('./runtimeArtifact');

class RuntimeResolver {
  /**
   * @param {object} options
   * @param {string} options.storageRoot
   * @param {string} [options.platform]
   * @param {string} [options.arch]
   */
  constructor({ storageRoot, platform = process.platform, arch = process.arch }) {
    if (!path.isAbsolute(storageRoot)) throw new Error('Runtime storageRoot must be absolute');
    this.storageRoot = path.resolve(storageRoot);
    this.platform = platform;
    this.arch = arch;
  }

  /** Resolve and fully verify the current runtime. */
  async resolveCurrent() {
    return this._resolvePointer('current.json');
  }

  /** Resolve and fully verify the last-known-good runtime. */
  async resolveLastGood() {
    return this._resolvePointer('last-good.json');
  }

  async _resolvePointer(fileName) {
    const pointerPath = path.join(this.storageRoot, 'state', fileName);
    let pointer;
    try {
      pointer = JSON.parse(await fs.promises.readFile(pointerPath, 'utf8'));
    } catch (error) {
      throw new Error(`Failed to read runtime pointer ${pointerPath}: ${String(error)}`);
    }
    if (!pointer || typeof pointer !== 'object' || Array.isArray(pointer)) {
      throw new Error(`Runtime pointer ${pointerPath} must be a JSON object`);
    }
    if (pointer.platform !== this.platform || pointer.arch !== this.arch) {
      throw new Error(`Runtime pointer platform mismatch: expected ${this.platform}-${this.arch}`);
    }
    if (typeof pointer.dshVersion !== 'string' || pointer.dshVersion.trim() === '') {
      throw new Error(`Runtime pointer ${pointerPath} has no dshVersion`);
    }
    if (!isValidDshVersion(pointer.dshVersion)) {
      throw new Error(`Runtime pointer ${pointerPath} has invalid dshVersion`);
    }

    const runtimeRoot = path.join(
      this.storageRoot,
      'runtime',
      pointer.dshVersion,
      `${this.platform}-${this.arch}`
    );
    const manifestPath = path.join(runtimeRoot, 'manifest.json');
    const manifest = parseRuntimeArtifactManifest(
      JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'))
    );
    if (
      manifest.dshVersion !== pointer.dshVersion
      || manifest.platform !== this.platform
      || manifest.arch !== this.arch
    ) {
      throw new Error('Runtime pointer and manifest identity do not match');
    }

    const payloadRoot = path.join(runtimeRoot, 'payload');
    await verifyRuntimeDirectory(payloadRoot, manifest);
    const executablePath = path.resolve(payloadRoot, ...manifest.entrypoint.split('/'));
    const entrypointArgs = manifest.entryScript === null
      ? []
      : [path.resolve(payloadRoot, ...manifest.entryScript.split('/'))];
    return Object.freeze({
      runtimeRoot,
      payloadRoot,
      executablePath,
      entrypointArgs: Object.freeze(entrypointArgs),
      manifestPath,
      manifest,
      profileHome: path.join(this.storageRoot, 'profiles', 'web'),
      dshHome: this.storageRoot,
      profileName: 'web',
    });
  }
}

module.exports = { RuntimeResolver };
