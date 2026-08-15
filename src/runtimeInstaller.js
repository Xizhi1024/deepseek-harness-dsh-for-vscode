'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { parseRuntimeArtifactManifest, sha256File, verifyRuntimeDirectory } = require('./runtimeArtifact');
const { extractRuntimeTarGz } = require('./runtimeArchive');

async function readJson(filePath) {
  return JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
}

async function writeJsonAtomic(filePath, value) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  try {
    await fs.promises.rename(temporary, filePath);
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
}

class RuntimeInstaller {
  /** @param {{storageRoot: string, platform?: string, arch?: string}} options */
  constructor({ storageRoot, platform = process.platform, arch = process.arch }) {
    if (!path.isAbsolute(storageRoot)) throw new Error('Runtime storageRoot must be absolute');
    this.storageRoot = path.resolve(storageRoot);
    this.platform = platform;
    this.arch = arch;
  }

  /** Install and verify a candidate without changing current or last-good. */
  async installFromArchive({ manifest: input, archivePath, signal }) {
    const manifest = parseRuntimeArtifactManifest(input);
    if (manifest.platform !== this.platform || manifest.arch !== this.arch) {
      throw new Error(`Runtime artifact platform mismatch: expected ${this.platform}-${this.arch}`);
    }
    if (await sha256File(archivePath) !== manifest.archiveSha256) {
      throw new Error('Runtime archive hash mismatch');
    }

    const runtimeBase = path.join(this.storageRoot, 'runtime');
    const finalRoot = path.join(runtimeBase, manifest.dshVersion, `${this.platform}-${this.arch}`);
    const stagingRoot = path.join(runtimeBase, `.staging-${crypto.randomUUID()}`);
    const payloadRoot = path.join(stagingRoot, 'payload');
    await fs.promises.mkdir(runtimeBase, { recursive: true });
    try {
      if (await exists(finalRoot)) {
        const installedManifest = parseRuntimeArtifactManifest(
          await readJson(path.join(finalRoot, 'manifest.json'))
        );
        if (installedManifest.unpackedSha256 !== manifest.unpackedSha256) {
          throw new Error(`Installed runtime version conflicts with candidate: ${manifest.dshVersion}`);
        }
        await verifyRuntimeDirectory(path.join(finalRoot, 'payload'), installedManifest);
        return this._candidate(finalRoot, installedManifest);
      }

      await extractRuntimeTarGz(archivePath, payloadRoot, manifest, { signal });
      await verifyRuntimeDirectory(payloadRoot, manifest);
      await fs.promises.writeFile(
        path.join(stagingRoot, 'manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { flag: 'wx' }
      );
      await fs.promises.mkdir(path.dirname(finalRoot), { recursive: true });
      await fs.promises.rename(stagingRoot, finalRoot);
      return this._candidate(finalRoot, manifest);
    } finally {
      await fs.promises.rm(stagingRoot, { recursive: true, force: true });
    }
  }

  /** Promote a health-checked candidate, retaining the previous current as last-good. */
  async promote(candidate) {
    const pointer = this._pointer(candidate.manifest);
    const stateRoot = path.join(this.storageRoot, 'state');
    const currentPath = path.join(stateRoot, 'current.json');
    if (await exists(currentPath)) {
      await writeJsonAtomic(path.join(stateRoot, 'last-good.json'), await readJson(currentPath));
    }
    await writeJsonAtomic(currentPath, pointer);
  }

  /**
   * Restore current to the previously promoted last-good pointer.
   * When no last-good pointer exists (e.g. the first promote failed before a
   * prior current was recorded), remove current.json so a later provision run
   * sees a missing pointer and can re-provision cleanly.
   */
  async rollback() {
    const stateRoot = path.join(this.storageRoot, 'state');
    const currentPath = path.join(stateRoot, 'current.json');
    const lastGoodPath = path.join(stateRoot, 'last-good.json');
    if (await exists(lastGoodPath)) {
      await writeJsonAtomic(currentPath, await readJson(lastGoodPath));
      return;
    }
    await fs.promises.rm(currentPath, { force: true });
  }

  /** Remove only obsolete runtimes for this platform, preserving active paths. */
  async cleanup({ activeRuntimeRoots = [] } = {}) {
    const runtimeBase = path.join(this.storageRoot, 'runtime');
    if (!await exists(runtimeBase)) return [];
    const keep = new Set(activeRuntimeRoots.map((value) => this._validatedRuntimeRoot(value)));
    for (const pointerName of ['current.json', 'last-good.json']) {
      const pointerPath = path.join(this.storageRoot, 'state', pointerName);
      if (!await exists(pointerPath)) continue;
      const pointer = await readJson(pointerPath);
      if (
        !pointer || typeof pointer.dshVersion !== 'string'
        || pointer.platform !== this.platform || pointer.arch !== this.arch
      ) {
        throw new Error(`Cannot clean runtimes with an invalid ${pointerName} pointer`);
      }
      keep.add(path.resolve(
        runtimeBase,
        pointer.dshVersion,
        `${this.platform}-${this.arch}`
      ));
    }

    const removed = [];
    for (const versionEntry of await fs.promises.readdir(runtimeBase, { withFileTypes: true })) {
      if (!versionEntry.isDirectory() || versionEntry.name.startsWith('.staging-')) continue;
      const candidate = path.resolve(runtimeBase, versionEntry.name, `${this.platform}-${this.arch}`);
      if (!await exists(candidate) || keep.has(candidate)) continue;
      this._validatedRuntimeRoot(candidate);
      const stat = await fs.promises.lstat(candidate);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Refusing to clean an unsafe runtime entry: ${candidate}`);
      }
      await fs.promises.rm(candidate, { recursive: true, force: true });
      removed.push(candidate);
    }
    return removed;
  }

  _pointer(manifest) {
    return {
      dshVersion: manifest.dshVersion,
      platform: manifest.platform,
      arch: manifest.arch,
    };
  }

  _candidate(runtimeRoot, manifest) {
    const payloadRoot = path.join(runtimeRoot, 'payload');
    return Object.freeze({
      runtimeRoot,
      payloadRoot,
      executablePath: path.join(payloadRoot, ...manifest.entrypoint.split('/')),
      manifest,
    });
  }

  _validatedRuntimeRoot(value) {
    const runtimeBase = path.resolve(this.storageRoot, 'runtime');
    const candidate = path.resolve(value);
    const relative = path.relative(runtimeBase, candidate);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Runtime path is outside managed storage: ${value}`);
    }
    return candidate;
  }
}

async function exists(filePath) {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

module.exports = { RuntimeInstaller, writeJsonAtomic };
