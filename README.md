# DeepSeek Harness Sidebar (DSH)

[English](README.md) · [简体中文](README.zh-CN.md)

Embeds the local [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) web UI in the VS Code auxiliary sidebar (right rail, alongside Copilot Chat). By default, every VS Code window starts and owns one `dsh web` child with the current workspace as cwd, then renders it in a compact full-screen iframe.

## Requirements

| Item | Requirement |
|---|---|
| VS Code | ≥ 1.90, desktop only |
| DSH CLI | globally installed `dsh` |
| DSH profile | configured; `dsh web` starts |

## Install

- Dev: open this repo → `F5` → **Run Extension**
- Package: `npm i -g @vscode/vsce && vsce package --no-dependencies` → `code --install-extension dsh-vs-sidebar-0.3.1.vsix`

## Usage

- `Ctrl+Alt+B` opens the auxiliary sidebar → **DeepSeek Harness (DSH)** tab
- Commands: **Open DSH in Browser** · **Restart DSH Server** · **Stop DSH Server** · **Focus DSH Sidebar**
- With `dsh.autoStart` on, the server is started at VS Code startup even if the sidebar is never opened

## Configuration

| Key | Default | Description |
|---|---|---|
| `dsh.port` | 3080 | Port to probe/start the DSH web server on |
| `dsh.host` | 127.0.0.1 | Fixed loopback bind required by the current DSH Web profile |
| `dsh.autoStart` | true | Start one DSH child for this VS Code window (false = reuse only the configured user-managed endpoint); also starts at VS Code startup |
| `dsh.closePolicy` | `onVscodeExit` | When to stop the extension-owned server (see below) |

`dsh.closePolicy` values:

| Value | Behavior |
|---|---|
| `onVscodeExit` | Stop the owned server only when VS Code exits (default) |
| `onViewClose` | Also stop the owned server when the sidebar view is closed |
| `never` | Never stop automatically — use the **Stop DSH Server** command |

A reused (non-owned) instance is never stopped by any policy or command.

## Compatibility

- VS Code ≥ 1.90 (`secondarySidebar`); explicit `activationEvents`; `extensionKind: [workspace]`
- Windows / macOS / Linux
- Each managed DSH child receives an authenticated loopback bridge URL/token; supported DSH builds POST configuration paths back to the owning extension host, which opens them through `vscode.window.showTextDocument` in that exact window. `DSH_TEXT_EDITOR=vscode` remains only as an older-DSH CLI fallback; reused external servers keep their own editor policy
- The iframe receives `dsh_embed=vscode`, which supported DSH builds use to hide their internal sidebar, details column, and resize handles; **Open in Browser** keeps the normal full layout
- PATH fallback when VS Code is GUI-launched with a trimmed PATH: `%APPDATA%\npm` (Windows); existing npm-global bins (POSIX)
- Cleanup: `taskkill /T /F` tree-kill (Windows — force-terminated, not a graceful stop); detached spawn + `kill(-pid)` process-group SIGTERM (POSIX)
- Untrusted / virtual workspaces **unsupported** (spawns local processes, touches workspace files) — declared via `capabilities`
- Container/view IDs `dsh-sidebar` / `dsh.webview` are **persistent contracts** — never change them in a release (resets the user's sidebar layout)
- UI language follows VS Code (zh/en): manifest via `package.nls.*.json`, runtime via `vscode.l10n` (`l10n/bundle.l10n.*.json`)
- CI: `node src/serverManager.js` self-test on ubuntu / macos / windows

## Implementation

| File | Responsibility |
|---|---|
| `src/extension.js` | activation, view provider, commands, workspace/config tracking, close policy |
| `src/serverManager.js` | probe / reuse / start / registry / cleanup |
| `src/webviewHtml.js` | iframe + status pages |
| `src/types.js` | contract constants (port, boot marker, view ID) |

Key behaviors:

- Probe `GET /` for the `__DSH_BOOT__` marker (3s timeout, 3 retries — a busy DSH is never misjudged as absent)
- Default `autoStart` mode never adopts another window's process: occupied ports are scanned forward (up to 50) and each extension host owns its child; `dsh-instances.json` is retained only for stale-entry cleanup and diagnostics
- cwd = current workspace (multi-root: active editor's folder; none: inherit parent cwd, no home fallback)
- Remote (WSL / Remote-SSH): `vscode.env.asExternalUri` port forwarding
- Browser commands use the same externalized URL as the iframe, including remote sessions and connection-error fallback pages
- Only the iframe URL gains the `dsh_embed=vscode` compact-layout marker; browser URLs remain unmodified
- Workspace switch: stop only the owned instance for the old root, re-probe for the new one
- `onStartupFinished` activation: with `dsh.autoStart` on, the server starts at VS Code startup (null-safe when no webview is open)
- With the default `onVscodeExit` policy, extension deactivation cancels pending startup, waits for the serialized lifecycle queue, and tree-kills any child that appeared; closing one VS Code window does not affect another window's child
- Lifecycle transitions (connect / stop / workspace rebind / config reconcile) run through one serialized queue, so a dispose arriving during connect cannot kill a process a rebind just started
- `dsh.stopServer` and the close policy stop **only** owned processes; a reused external instance is never killed
- Registry pruning only removes dead entries and never kills a live process; `onVscodeExit` stops an owned child during extension-host shutdown, while `never` intentionally lets it survive until explicitly stopped

## FAQ

- **"DeepSeek official API" key is read-only in DSH settings?**
  DSH deliberately treats `DEEPSEEK_API_KEY` supplied by the launching environment as read-only (writes would be silently shadowed). Fix: unset it in the shell that starts dsh web (or VS Code) and restart — the key already stored in `~/.dsh/.credentials.yaml` takes over and the field becomes editable.

## License

MIT © Xizhi1024
