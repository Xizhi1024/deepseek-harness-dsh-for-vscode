'use strict';

/**
 * runtimeEnvironment.js — identifies the OS environment this extension host
 * runs in (Windows vs WSL) and resolves the shared-instance endpoint port.
 *
 * `dsh.share.mode = "environment"` (extension default) converges every VS
 * Code window of one OS environment onto ONE DSH instance: Windows windows
 * use the Windows instance, WSL windows the WSL instance. Detection is
 * extension-host based — a Remote-WSL window runs this code inside WSL, a
 * local Windows window runs it on Windows, and a Windows window that opened
 * a \\wsl$ folder still counts as Windows (its extension host is local),
 * which is exactly the "whose DSH do I talk to" split the user asked for.
 *
 * Why WSL gets its own default port: WSL2 localhost forwarding (Windows→WSL)
 * makes a WSL-side listener reachable from Windows via 127.0.0.1. If both
 * environments probed the same default port, a Windows window that starts
 * before any Windows instance exists could adopt the WSL instance and drive
 * WSL paths from Windows UI. Shifting the WSL default to its own port when
 * the user has not pinned `dsh.port` keeps the two namespaces apart. An
 * explicitly configured port is always honored verbatim (the user owns the
 * topology then), and user-managed mode (autoStart=false) is never shifted
 * for backward compatibility.
 *
 * The same "whose DSH do I talk to" split has a second half: a WSL window must
 * never *launch* (or adopt) a Windows-hosted DSH, because that process sees
 * only Windows paths and rejects every WSL workspace path with
 * `workspace/invalid-path`. WSL interop makes that failure mode easy to reach
 * — a `/mnt/c` pnpm shim spawned from Linux re-execs `node.exe` (its own
 * `uname -a` sees `*WSL2*` and it prefers a Windows node), and the resulting
 * process is visible to this side's `ps` with `/proc/<pid>/comm` = `node.exe`
 * and `/proc/<pid>/exe` -> `/init`. The primitives below identify that class:
 * which mounts belong to another OS (windowsMountRoots/isForeignHostPath) and
 * whether an existing process is a foreign one (detectProcessEnvironment).
 *
 * Zero external dependencies: only Node built-ins are used.
 */

const fs = require('node:fs');

const OS_RELEASE_PATH = '/proc/sys/kernel/osrelease';
const PROC_MOUNTS_PATH = '/proc/mounts';

/** Filesystem types that carry another OS's drives into a Linux mount table. */
const FOREIGN_FS_TYPES = /^(drvfs|9p|virtiofs|v9fs)$/i;

/** Allowed values of the `dsh.share.mode` setting. */
const SHARE_MODES = Object.freeze({
  /** Legacy: every VS Code window probes and spawns its own DSH child. */
  WINDOW: 'window',
  /** All windows of one OS environment (Windows vs WSL) share one instance. */
  ENVIRONMENT: 'environment',
});

/** Default DSH web port for WSL extension hosts in environment-shared mode. */
const WSL_SHARED_DEFAULT_PORT = 3081;

/**
 * Normalize a raw `dsh.share.mode` setting to a known value. Unknown values
 * fall back to `fallback` (the API-level default is WINDOW so direct
 * ServerManager callers keep the legacy semantics; the extension passes
 * ENVIRONMENT as its own default).
 * @param {*} raw - the value read from the config (may be undefined).
 * @param {string} [fallback] - value returned for undefined/unknown input.
 * @returns {string} one of SHARE_MODES.
 */
function normalizeShareMode(raw, fallback = SHARE_MODES.WINDOW) {
  const resolved = raw === SHARE_MODES.WINDOW || raw === SHARE_MODES.ENVIRONMENT
    ? raw
    : fallback;
  return resolved === SHARE_MODES.ENVIRONMENT ? SHARE_MODES.ENVIRONMENT : SHARE_MODES.WINDOW;
}

/** Memoized osrelease read so repeated detections never touch /proc twice. */
const osReleaseCache = new Map();
/** Memoized detection results, keyed by the inputs that can change them. */
const environmentCache = new Map();

/**
 * Read the kernel release file (Linux only in practice). Returns '' when the
 * file is missing or unreadable (non-Linux platforms, hardened containers).
 * Results are memoized per path; `fresh` bypasses the cache for tests.
 * @param {string} osReleasePath - Absolute path of the osrelease file.
 * @param {(path: string) => string} readFile - Sync reader (injectable).
 * @param {boolean} [fresh] - True to bypass the memoization cache.
 * @returns {string}
 */
function readOsRelease(osReleasePath, readFile, fresh = false) {
  if (!fresh && osReleaseCache.has(osReleasePath)) return osReleaseCache.get(osReleasePath);
  let content = '';
  try {
    content = String(readFile(osReleasePath) || '');
  } catch {
    content = '';
  }
  osReleaseCache.set(osReleasePath, content);
  return content;
}

/**
 * Detect the OS environment of this extension host.
 *
 *  - `windows` — the extension host runs on Windows (local folder windows,
 *    including windows that browse WSL files over \\wsl$).
 *  - `wsl`     — the extension host runs inside WSL (Remote-WSL windows):
 *    `WSL_DISTRO_NAME` is set, or the kernel release carries the Microsoft
 *    WSL marker (covers WSL1 where the env var may be absent).
 *  - `linux`   — any other Linux (Remote-SSH, containers, native Linux).
 *  - `other`   — macOS and everything else.
 *
 * The result is frozen and memoized; pass `fresh: true` to recompute.
 *
 * @param {object} [options]
 * @param {string} [options.platform] - Override process.platform.
 * @param {object} [options.env] - Override process.env.
 * @param {string} [options.osReleasePath] - Override the osrelease path.
 * @param {(path: string) => string} [options.readFile] - Sync reader (injectable).
 * @param {boolean} [options.fresh] - Bypass the memoization cache.
 * @returns {{id: string, isWsl: boolean, platform: string}} Frozen environment.
 */
function detectRuntimeEnvironment({
  platform = process.platform,
  env = process.env,
  osReleasePath = OS_RELEASE_PATH,
  readFile = (candidate) => fs.readFileSync(candidate, 'utf8'),
  fresh = false,
} = {}) {
  const distro = String((env && env.WSL_DISTRO_NAME) || '').trim();
  const cacheKey = `${platform}\u0000${distro}\u0000${osReleasePath}`;
  if (!fresh && environmentCache.has(cacheKey)) return environmentCache.get(cacheKey);

  let environment;
  if (platform === 'win32') {
    environment = Object.freeze({ id: 'windows', isWsl: false, platform });
  } else if (platform === 'linux') {
    const release = readOsRelease(osReleasePath, readFile, fresh);
    const isWsl = distro.length > 0 || /microsoft/i.test(release);
    environment = Object.freeze({ id: isWsl ? 'wsl' : 'linux', isWsl, platform });
  } else {
    environment = Object.freeze({ id: 'other', isWsl: false, platform });
  }
  environmentCache.set(cacheKey, environment);
  return environment;
}

/**
 * Resolve the effective DSH endpoint port for one connect pass.
 *
 * The WSL default-port shift applies ONLY when all of these hold:
 *   - share mode is `environment` (shared-instance semantics are active),
 *   - the extension may start/adopt broadly (autoStart true — user-managed
 *     mode keeps the configured port verbatim for backward compatibility),
 *   - the environment is WSL,
 *   - the user did not explicitly set `dsh.port` at any configuration scope.
 * Every other combination returns the configured port unchanged.
 *
 * @param {object} options
 * @param {number} options.port - Configured `dsh.port` value.
 * @param {boolean} [options.portExplicit] - True when dsh.port is set at any scope.
 * @param {string} [options.shareMode] - Normalized share mode.
 * @param {boolean} [options.autoStart] - The dsh.autoStart setting.
 * @param {{isWsl?: boolean}|null} [options.environment] - detectRuntimeEnvironment() output.
 * @returns {number} The effective endpoint port.
 */
function resolveSharedEndpointPort({
  port,
  portExplicit = false,
  shareMode = SHARE_MODES.WINDOW,
  autoStart = true,
  environment = null,
} = {}) {
  if (!Number.isInteger(port)) return port;
  const shift = shareMode === SHARE_MODES.ENVIRONMENT
    && autoStart === true
    && !portExplicit
    && Boolean(environment && environment.isWsl);
  return shift ? WSL_SHARED_DEFAULT_PORT : port;
}

/**
 * Short human-readable label of this extension host's environment, for
 * messages that must tell the user which side of the Windows/WSL split a
 * runtime belongs to ("this WSL window needs a DSH installed for its own OS").
 *
 * @param {object} [options] - Same overrides as detectRuntimeEnvironment.
 * @returns {string} e.g. 'Windows', 'WSL', 'Linux', 'macOS'.
 */
function hostEnvironmentLabel({ platform = process.platform, env = process.env } = {}) {
  const id = detectRuntimeEnvironment({ platform, env }).id;
  if (id === 'windows') return 'Windows';
  if (id === 'wsl') return 'WSL';
  if (id === 'linux') return 'Linux';
  return platform === 'darwin' ? 'macOS' : String(platform);
}

/** Memoized mount-table reads, keyed by mountPath (mirrors osReleaseCache). */
const mountRootsCache = new Map();

/** Decode the octal escapes (/proc/mounts writes `\040` for a space). */
function decodeMountToken(token) {
  return String(token).replace(/\\([0-7]{3})/g, (_, octal) =>
    String.fromCharCode(parseInt(octal, 8))
  );
}

/**
 * Mount points under which another OS's filesystem is reachable.
 *
 * `/proc/mounts` shows a WSL drive mount as
 *   `C:\134 /mnt/c 9p rw,noatime,dirsync,aname=drvfs;path=C:\;uid=1000;…`
 * (the device is the escaped Windows path, `C:\134` being `C:\`). Only
 * drvfs/9p/virtiofs-style mounts whose device is a drive letter count: a plain
 * `/mnt/data` on ext4 is a native Linux mount and must NOT be reported, which
 * is why the mount table — not the `/mnt/<letter>` shape alone — is the
 * primary source. The `/mnt/<letter>` shape is used only as a fallback when
 * the table cannot be read at all (hardened containers), and never off Linux.
 *
 * @param {object} [options]
 * @param {string} [options.mountPath] - Override /proc/mounts.
 * @param {string} [options.platform] - Override process.platform.
 * @param {(path: string) => string} [options.readFile] - Sync reader (injectable).
 * @param {boolean} [options.fresh] - Bypass the memoization cache.
 * @returns {string[]} Absolute mount points, e.g. ['/mnt/c'].
 */
function windowsMountRoots({
  mountPath = PROC_MOUNTS_PATH,
  platform = process.platform,
  readFile = (candidate) => fs.readFileSync(candidate, 'utf8'),
  fresh = false,
} = {}) {
  if (platform !== 'linux') return [];
  if (!fresh && mountRootsCache.has(mountPath)) return mountRootsCache.get(mountPath);
  let content = '';
  try {
    content = String(readFile(mountPath) || '');
  } catch {
    content = '';
  }
  const roots = [];
  for (const line of content.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3) continue;
    const [device, mountPoint, fsType] = fields;
    if (!/^[A-Za-z]:/.test(decodeMountToken(device))) continue;
    if (!FOREIGN_FS_TYPES.test(fsType)) continue;
    const decoded = decodeMountToken(mountPoint);
    if (decoded.startsWith('/') && !roots.includes(decoded)) roots.push(decoded);
  }
  // No usable evidence (unreadable/empty table): fall back to the drive-mount
  // naming convention. `/mnt/wslg` and `/mnt/wsl` deliberately do not match
  // ([a-z] followed by end-or-slash), so only single-letter drives qualify.
  if (roots.length === 0 && content.trim() === '' && fs.existsSync('/mnt/c')) {
    roots.push('/mnt/c');
  }
  const frozen = Object.freeze(roots);
  mountRootsCache.set(mountPath, frozen);
  return frozen;
}

/**
 * Whether an absolute path belongs to the OTHER OS environment: a Windows
 * drive path spelled for a POSIX host, or any path under a foreign mount
 * (see windowsMountRoots). False on win32 and for relative/non-string input,
 * so callers never need to gate the check themselves.
 *
 * @param {*} candidate - Path to classify.
 * @param {object} [options]
 * @param {string} [options.platform] - Override process.platform.
 * @param {string[]} [options.mountRoots] - Override the mount points.
 * @param {string} [options.mountPath] - Override /proc/mounts for the lookup.
 * @param {(path: string) => string} [options.readFile] - Sync reader (injectable).
 * @returns {boolean}
 */
function isForeignHostPath(candidate, {
  platform = process.platform,
  mountRoots = null,
  mountPath = PROC_MOUNTS_PATH,
  readFile,
} = {}) {
  if (platform === 'win32') return false;
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  // A drive-letter spelling can never name a native path off Windows.
  if (/^[A-Za-z]:[\\/]/.test(candidate)) return true;
  if (!candidate.startsWith('/')) return false;
  const roots = mountRoots || windowsMountRoots({ platform, mountPath, readFile });
  for (const root of roots) {
    if (candidate === root || candidate.startsWith(root.endsWith('/') ? root : `${root}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * Environment of an existing process, as far as this side can observe it.
 *
 * WSL interop runs a Windows binary through `/init`, so `/proc/<pid>/comm`
 * ends in `.exe` (e.g. `node.exe`) and `/proc/<pid>/exe` points at `/init`.
 * Anything else — including every process on a non-Linux host, where /proc
 * does not exist — is `unknown`, and callers must treat `unknown` as "not
 * foreign" so adoption is never regressed on platforms we cannot inspect.
 *
 * @param {number} pid - Process id to classify.
 * @param {object} [options]
 * @param {string} [options.platform] - Override process.platform.
 * @param {string} [options.procRoot] - Override /proc.
 * @param {(path: string) => string} [options.readFile] - Sync reader (injectable).
 * @param {(path: string) => string} [options.readlink] - Sync link reader (injectable).
 * @returns {'windows'|'unknown'}
 */
function detectProcessEnvironment(pid, {
  platform = process.platform,
  procRoot = '/proc',
  readFile = (candidate) => fs.readFileSync(candidate, 'utf8'),
  readlink = (candidate) => fs.readlinkSync(candidate),
} = {}) {
  if (platform !== 'linux') return 'unknown';
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown';
  try {
    const comm = String(readFile(`${procRoot}/${pid}/comm`) || '').trim();
    if (/\.exe$/i.test(comm)) return 'windows';
  } catch {
    // fall through to the exe link: a process may exit between the two reads
  }
  try {
    if (String(readlink(`${procRoot}/${pid}/exe`) || '') === '/init') return 'windows';
  } catch {
    // unreadable (permissions, gone): unknown
  }
  return 'unknown';
}

module.exports = {
  SHARE_MODES,
  WSL_SHARED_DEFAULT_PORT,
  normalizeShareMode,
  detectRuntimeEnvironment,
  resolveSharedEndpointPort,
  hostEnvironmentLabel,
  windowsMountRoots,
  isForeignHostPath,
  detectProcessEnvironment,
};
