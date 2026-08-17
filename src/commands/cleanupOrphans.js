'use strict';

/**
 * `dsh.cleanupOrphans` command body.
 *
 * Lists instance-registry entries whose pid is still alive (typically DSH
 * children left behind by a crashed VS Code window or `closePolicy: never`),
 * verifies each endpoint over the loopback before offering to stop it, and
 * always gives the user a record-only removal option for live pids that no
 * longer answer as DSH. Registry records whose pid is dead are pruned first.
 *
 * Safety rules:
 *  - this window's own child is never listed;
 *  - only an endpoint that answers as DSH is ever terminated;
 *  - everything else is registry bookkeeping only (no process is killed).
 */

const { DEFAULT_HOST } = require('../types');

function defaultLoc(template, params = {}) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? `{${key}}`));
}

/**
 * @param {object} deps - Injected dependencies.
 * @param {object} deps.vscode - VS Code facade (window.createQuickPick,
 *   showInformationMessage, showErrorMessage).
 * @param {() => string} deps.registryFilePath - Registry JSON path provider.
 * @param {(file: string) => Array<object>} deps.listAliveEntries - Alive entries reader.
 * @param {(host: string, port: number) => Promise<object>} deps.probeEntry - DSH endpoint probe.
 * @param {(pid: number) => Promise<void>} deps.terminate - Process-tree terminator.
 * @param {(file: string, pids: number[]) => void} deps.removeEntries - Registry record remover.
 * @param {() => number|null} deps.ownedPid - This window's owned child pid.
 * @param {Function} [deps.loc] - Localization helper.
 * @returns {Function} Async command body.
 */
function createCleanupOrphansCommand({
  vscode,
  registryFilePath,
  listAliveEntries,
  probeEntry,
  terminate,
  removeEntries,
  ownedPid = () => null,
  loc = defaultLoc,
}) {
  for (const [label, value] of Object.entries({
    'vscode.window.createQuickPick': vscode && vscode.window && vscode.window.createQuickPick,
    'vscode.window.showInformationMessage': vscode && vscode.window && vscode.window.showInformationMessage,
    'vscode.window.showErrorMessage': vscode && vscode.window && vscode.window.showErrorMessage,
    registryFilePath,
    listAliveEntries,
    probeEntry,
    terminate,
    removeEntries,
  })) {
    if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  }

  return async function cleanupOrphans() {
    try {
      const file = registryFilePath();
      const entries = listAliveEntries(file);
      if (!Array.isArray(entries) || entries.length === 0) {
        await vscode.window.showInformationMessage(loc('No orphan DSH servers were found'));
        return;
      }

      const ownPid = ownedPid();
      const items = [];
      for (const entry of entries) {
        if (!entry || !Number.isInteger(entry.pid)) continue;
        if (entry.pid === ownPid) continue;
        const host = typeof entry.host === 'string' && entry.host.length > 0 ? entry.host : DEFAULT_HOST;
        const port = Number(entry.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) continue;

        let verifiedDsh = false;
        try {
          const probe = await probeEntry(host, port);
          verifiedDsh = Boolean(probe && probe.reachable && probe.isDsh);
        } catch {
          verifiedDsh = false;
        }

        items.push({
          label: loc('DSH on http://{host}:{port} (pid={pid})', {
            host,
            port: String(port),
            pid: String(entry.pid),
          }),
          description: verifiedDsh
            ? loc('verified DSH server; Stop removes the process')
            : loc('not responding as DSH; remove record only'),
          detail: [typeof entry.cwd === 'string' && entry.cwd ? entry.cwd : null,
            typeof entry.log === 'string' && entry.log ? entry.log : null]
            .filter(Boolean)
            .join(' · '),
          entry,
          action: verifiedDsh ? 'stop' : 'record',
        });
      }

      if (items.length === 0) {
        await vscode.window.showInformationMessage(loc('No orphan DSH servers were found'));
        return;
      }

      const picker = vscode.window.createQuickPick();
      picker.canPickMany = true;
      picker.placeholder = loc('Clean Up Orphan DSH Servers');
      picker.items = items;
      const selected = await new Promise((resolve) => {
        picker.onDidAccept(() => resolve([...(picker.selectedItems || [])]));
        picker.onDidHide(() => resolve([]));
        picker.show();
      });

      let stopped = 0;
      let removed = 0;
      const selectedPids = [];
      for (const item of selected) {
        if (!item || !item.entry || !Number.isInteger(item.entry.pid)) continue;
        selectedPids.push(item.entry.pid);
        if (item.action === 'stop') {
          await terminate(item.entry.pid);
          stopped += 1;
        }
        removed += 1;
      }
      if (selectedPids.length > 0) {
        removeEntries(file, selectedPids);
      }
      if (stopped > 0 || removed > 0) {
        await vscode.window.showInformationMessage(loc(
          'Cleaned up {stopped} orphan DSH process(es) and {removed} registry record(s)',
          { stopped: String(stopped), removed: String(removed) }
        ));
      }
    } catch (err) {
      await vscode.window.showErrorMessage(loc('Cleanup orphan DSH servers failed: {message}', {
        message: err && err.message ? err.message : String(err),
      }));
    }
  };
}

module.exports = {
  createCleanupOrphansCommand,
};
