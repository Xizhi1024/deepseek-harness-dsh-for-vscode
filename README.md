# DeepSeek Harness Sidebar (DSH)

[English](README.md) · [简体中文](README.zh-CN.md)

Embeds the local [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) web UI in the VS Code auxiliary sidebar (right rail, alongside Copilot Chat). By default, every VS Code window starts and owns one `dsh web` child with the current workspace as cwd, then renders it in a compact full-screen iframe.

## Requirements

| Item | Requirement |
|---|---|
| VS Code | ≥ 1.90, desktop only |
| Managed runtime (`dsh.autoStart=true`) | verified runtime under VS Code global storage, or `dsh.runtime.manifestUrl` to provision one |
| DSH CLI (`dsh.autoStart=false` only) | globally installed `dsh` |
| DSH profile (reuse mode) | configured; `dsh web` starts |

## Install

- Dev: open this repo → `F5` → **Run Extension**
- Verify: `npm ci` → `npm run check:w0` → `npm run test:extension-host`
- Secret scan: `npm run test:secrets` scans the source/docs that would enter the VSIX (never `node_modules`, `.git`, or `.vscode-test`) and exits 1 on hardcoded bridge tokens, `Authorization: Bearer` credentials, API keys, private keys, or password literals; example/test fixtures are released with an explicit `// allow-secret-scan` comment.
- Package: `npm i -g @vscode/vsce && vsce package --no-dependencies` → `code --install-extension dsh-vs-sidebar-0.3.1.vsix`

## Usage

- `Ctrl+Alt+B` opens the auxiliary sidebar → **DeepSeek Harness (DSH)** tab
- Commands (all 11): **Open DSH in Browser** · **New Session** · **Switch Session** · **Restart DSH Server** · **Stop DSH Server** · **Focus DSH Sidebar** · **Add Active File to DSH Context** · **Add Active Selection to DSH Context** · **Add Problems to DSH Context** · **Capabilities and Integrations** · **Diagnose**
- With `dsh.autoStart` on, the server is started at VS Code startup even if the sidebar is never opened

## Session navigation

**New Session** / **Switch Session** use DSH's local session API. **Switch Session** shows a QuickPick with each root session's title, workspace path, update time, and running state; selecting one reloads the iframe with the `dsh_session` query parameter so the DSH web UI opens that session. The extension does not keep a second session tree — the DSH server remains the source of truth. **New Session** creates a session for the current workspace root and, when one already exists, reuses a blank session for the same cwd instead of creating a duplicate.

## Editor context (explicit attachment)

The extension never sends editor content implicitly. The active file, selection, and Problems stay out of DSH until you run one of the **Add … to DSH Context** commands; the resulting attachment is the only thing the `vscode_editor` tool can read back through the versioned bridge.

- File, selection, and Problems attachments are window-memory only and are cleared when the workspace root changes.
- Attachments over 1 MiB (UTF-8) are rejected instead of silently truncated; diagnostics are capped at 1000 items and 2000 chars per message.
- Only `file` URIs inside an open, trusted workspace folder can be attached, opened, diffed, or queried for diagnostics — the bridge exposes no arbitrary command, URI, or file read.
- DSH receives `vscode/contextChanged` notifications carrying revision and attachment ids only, never content.

## Capabilities & diagnostics

**Capabilities and Integrations** focuses the DSH sidebar and opens the capability center in the DSH web UI. The extension ships a small controlled provider catalog (`src/capabilityCatalog.js`) and a provider detector (`src/providerDetector.js`) that reports install/enable state for four framework candidates only:

- Remote development: `ms-vscode-remote.remote-wsl`, `ms-vscode-remote.remote-ssh`
- GitHub: `GitHub.vscode-pull-request-github`
- Browser: `browser-provider-placeholder` (framework placeholder until the W5 browser provider is selected and verified)

The extension never installs third-party providers. **Every third-party provider is `manual-assist` in this round**; none is marked `integrated` because the stable-interface audit (G3) is still open. `vscode/extensions/openDetails` only opens the catalog-controlled VS Code extension details page or an official `https://` documentation page — there is no install code path.

**Diagnose** reads the `dsh.*` configuration, server state, bridge state, catalog revision, and provider detection results, then shows a single summary message. Full diagnostics output and an OutputChannel are intentionally deferred to a later W4 slice.

Provider state is refreshed through `vscode.extensions.onDidChange`, which emits `vscode/providerStatesChanged` notifications on the versioned bridge. Detection re-reads `vscode.extensions` on every call and never caches state across workspaces.

## Configuration

| Key | Default | Description |
|---|---|---|
| `dsh.port` | 3080 | Port to probe/start the DSH web server on |
| `dsh.host` | 127.0.0.1 | Fixed loopback bind required by the current DSH Web profile |
| `dsh.autoStart` | true | Start one DSH child for this VS Code window (false = reuse only the configured user-managed endpoint); also starts at VS Code startup |
| `dsh.closePolicy` | `onVscodeExit` | When to stop the extension-owned server (see below) |
| `dsh.runtime.manifestUrl` | (empty) | HTTPS URL of a runtime release manifest (`schemaVersion: 1`, `artifacts` with embedded runtime manifests). Empty = use only the already installed verified runtime under VS Code global storage |
| `dsh.runtime.version` | (empty) | Optional DSH runtime version pin. Empty = installed current version, or the newest matching artifact when provisioning from a manifest URL |

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
- Managed children also receive a generated `--patch` overlay (under VS Code global storage) that disables third-party plugins known to re-add sidebar/panel chrome inside the embed (`better-sidebar`, `ui-dsh-aionui-panel`). If those plugins are not installed the overlay is inert; the patch never edits DSH sources, profiles, or `cordis.patch.yml`
- Managed autoStart resolves/verifies the runtime before every spawn (pointer, manifest, payload SHA-256). Missing manifest, hash mismatch, no platform artifact, and a missing `dsh.runtime.manifestUrl` all fail closed through the sidebar status page — the extension **never falls back to a `dsh` executable on PATH**
- PATH fallback when VS Code is GUI-launched with a trimmed PATH: `%APPDATA%\npm` (Windows); existing npm-global bins (POSIX) — only relevant to `dsh.autoStart=false` reuse mode
- Cleanup: `taskkill /T /F` tree-kill (Windows — force-terminated, not a graceful stop); detached spawn + `kill(-pid)` process-group SIGTERM (POSIX)
- Untrusted / virtual workspaces **unsupported** (spawns local processes, touches workspace files) — declared via `capabilities`
- Container/view IDs `dsh-sidebar` / `dsh.webview` are **persistent contracts** — never change them in a release (resets the user's sidebar layout)
- UI language follows VS Code (zh/en): manifest via `package.nls.*.json`, runtime via `vscode.l10n` (`l10n/bundle.l10n.*.json`)
- CI: static checks, `node:test`, VSIX contents, and an Extension Host activation smoke on ubuntu / macos / windows

## Known limitations

- **VS Code `< 1.106`**: the `secondarySidebar` view-container contribution point is not supported. The extension still activates, and the Extension Host smoke passes on VS Code 1.90, but VS Code logs a `secondarySidebar` contribution-point warning and the DSH view may fall back to the Explorer sidebar.
- **Real browser provider not integrated**: the capability catalog only lists `browser-provider-placeholder`; provider selection and verification are deferred to W5.
- **Extension Host smoke version**: the smoke test currently runs against VS Code 1.90 only.

## Implementation

| File | Responsibility |
|---|---|
| `src/extension.js` | extension-host assembly and DSH connection orchestration |
| `src/editorContext.js` | explicit editor attachments, open/openDiff, diagnostics, workspace URI gate |
| `src/capabilityCatalog.js` | controlled W4 provider catalog, URI whitelist, catalog revision |
| `src/providerDetector.js` | provider install/enable/health detection, bridge handlers, diagnostic snapshot |
| `src/versionedBridgeServer.js` | versioned loopback bridge (editor, diagnostics, extensions) |
| `src/textDocumentBridge.js` | per-window token loopback bridge for opening DSH-owned text documents |
| `src/bridgeWorkspace.js` | bridge workspace identity and trust classification |
| `src/embedOverlay.js` | generated `--patch` overlay for the managed DSH child |
| `src/lifecycle.js` | serialized lifecycle queue and shutdown gate |
| `src/runtimeEnvironment.js` | GUI-launch PATH repair |
| `src/managedRuntimeLaunch.js` | verified managed-runtime launch spec, profile/path normalization, `--patch` passthrough |
| `src/runtimeResolver.js` | managed runtime resolution with current/last-good pointer verification |
| `src/runtimeProvisioner.js` | release-manifest parse, artifact selection, resolve-or-provision orchestration |
| `src/runtimeArtifact.js` | runtime manifest validation, SHA-256 verification, runtime directory verification |
| `src/runtimeArchive.js` | verified tar.gz extraction for the managed runtime |
| `src/runtimeDownloader.js` | HTTPS runtime download with redirect limit and SHA-256 verification |
| `src/runtimeInstaller.js` | current/last-good runtime install, pointer switching, atomic writes |
| `src/serverManager.js` | probe / reuse / start / registry / cleanup |
| `src/sessionNavigation.js` | DSH session list/create API client and QuickPick mapping |
| `src/vscodeFacade.js` | injectable VS Code API surface |
| `src/webviewHtml.js` | iframe + status pages |
| `src/webviewMessages.js` | fixed Webview message routing |
| `src/workspaceContext.js` | settings, workspace root, registry path |
| `src/types.js` | contract constants (port, boot marker, view ID) |

Key behaviors:

- Probe `GET /` for the `__DSH_BOOT__` marker (3s timeout, 3 retries — a busy DSH is never misjudged as absent)
- Before every autoStart spawn, `connectNow` resolves/verifies the managed runtime (and provisions it from `dsh.runtime.manifestUrl` when missing or version-pinned) and hands it to `ServerManager.setResolvedRuntime()`; the runtime is re-verified on every connect, and any failure is shown on the status page instead of spawning
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
- Editor bridge requests reject non-`file` URIs, URIs outside `workspace.getWorkspaceFolder`, and untrusted workspaces; remote URIs are never converted to local paths

## FAQ

- **"DeepSeek official API" key is read-only in DSH settings?**
  DSH deliberately treats `DEEPSEEK_API_KEY` supplied by the launching environment as read-only (writes would be silently shadowed). Fix: unset it in the shell that starts dsh web (or VS Code) and restart — the key already stored in `~/.dsh/.credentials.yaml` takes over and the field becomes editable.

## License

MIT © Xizhi1024
