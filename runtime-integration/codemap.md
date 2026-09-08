# runtime-integration/

## Responsibility

Container directory with no source files of its own. It hosts vendored side-packages that the extension syncs into the DSH runtime (per-home profile) at activation time. Its single child, `dsh-vscode-integration/`, is a DSH-side plugin that restores/extends IDE integration inside the DSH web child process (see its own codemap.md).

## Design Patterns

- **Vendored snapshot / overlay**: the extension treats this tree as the source of truth and overlays it onto the active DSH home profile (packaging gate `scripts/check-package-contents.js` pins the file list; issue #9 in KNOWN_ISSUES.md historically involved a stale bundled snapshot).
- Version noted as `dsh-vscode-integration` 0.8.0 in KNOWN_ISSUES.md (embed-only Ctrl/Cmd+Enter→newline bridge).

## Data & Control Flow

No runtime flow originates here. `src/dshIntegration.js` (extension side) reads files from this tree and writes them into the selected DSH home on activation; the DSH child then loads the synced plugin from its profile.

## Integration Points

- Consumed by: `src/dshIntegration.js` (sync), packaging allowlist, test canaries (e.g. sessionFollow canary).
- Contains: `dsh-vscode-integration/` (own codemap.md).
