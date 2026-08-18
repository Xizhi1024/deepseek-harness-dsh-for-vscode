# DeepSeek Harness(dsh) for VS Code

[English](README.md) · [简体中文](README.zh-CN.md)

Embeds the local [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) web UI in the VS Code auxiliary sidebar (right rail, alongside Copilot Chat). By default, every VS Code window starts and owns one `dsh web` child with the current workspace as cwd, then renders it in a compact full-screen iframe.

## **VS CODE INTERACTION GUARANTEE (0.6.0)**

**In an extension-owned DSH session, model-output Copy uses the VS Code clipboard, `Read …` files—including absolute paths from shared older sessions outside the current workspace—open in the exact owning VS Code window, and HTTP/HTTPS links open in VS Code Simple Browser. Markdown files no longer fall through to Windows file associations such as Typora. Right-click the editor body to add either the whole file (`Add File to DSH Thread`, no selection required) or the current selection (`Add to DSH Thread`); both append only a compact Markdown file/link to the active DSH draft—never the selected source text. Clicking the rendered link reopens that approved file/selection in the owning VS Code window. Nothing is ever auto-sent.**

## Selection-link example

Select one or more code ranges, right-click **Add to DSH Thread**, and the DSH draft receives compact file-and-line Markdown links instead of pasted source code. The screenshot shows two selections queued in the same draft.

![Add selected VS Code ranges to a DSH conversation as compact links](media/add-to-dsh-thread-example-en.png)

## 🚨 **IMPORTANT: ISOLATED MODE CAN MAKE ALL EXISTING MODULES APPEAR TO DISAPPEAR**

> [!IMPORTANT]
> **Version 0.6.0 defaults to `dsh.home.mode: shared` and directly uses the official DSH home (`DSH_HOME`, otherwise `~/.dsh`). Existing modules, skills, providers, credentials, presets, and sessions are therefore shared with standalone DSH.**
>
> Set `dsh.home.mode` to `isolated` only when this VS Code extension needs a completely separate module configuration. Isolated mode uses the extension's private `globalStorage/.dsh`, initially containing only the official `web` profile. Switching modes can therefore make every module appear to disappear, but nothing is deleted—the data remains in the other DSH home. The extension never copies or merges the two homes.
>
> On the first upgrade from 0.4.x, a non-empty legacy isolated home is preserved automatically unless you already selected a mode. Use **DSH: Diagnose** to see the effective mode and path, then switch to `shared` explicitly when ready.

Starting `dsh web` with VS Code when `dsh.autoStart=true` is intentional. Runtime binaries and DSH user data are independent: both the local official npm package and a manifest/SHA-256-verified managed runtime use the selected shared/isolated home.

## Requirements

| Item | Requirement |
|---|---|
| VS Code | ≥ 1.106, desktop only |
| DSH (default auto-start) | `npm install -g @deepseek-ai/dsh`; the extension detects the official package |
| Node.js | auto-detected; set `dsh.local.nodePath` for non-standard locations |
| DSH configuration | no pre-creation needed; shared mode creates/reuses official `~/.dsh`, isolated mode creates the extension-private home |

## Install

- Dev: open this repo → `F5` → **Run Extension**
- Verify: `npm ci` → `npm run check:w0` → `npm run test:extension-host`
- Secret scan: `npm run test:secrets` scans the source/docs that would enter the VSIX (never `node_modules`, `.git`, or `.vscode-test`) and exits 1 on hardcoded bridge tokens, `Authorization: Bearer` credentials, API keys, private keys, or password literals; example/test fixtures are released with an explicit `// allow-secret-scan` comment.
- Package: `npm i -g @vscode/vsce && vsce package --no-dependencies` → `code --install-extension deepseek-harness-dsh-for-vscode-0.6.0.vsix`

## Usage

- `Ctrl+Alt+B` opens the auxiliary sidebar → **DeepSeek Harness (DSH)** tab
- Commands (all 14): **Open DSH in Browser** · **New Session** · **Switch Session** · **Restart DSH Server** · **Stop DSH Server** · **Focus DSH Sidebar** · **Add File to DSH Thread** · **Add to DSH Thread** · **Add Active File to DSH Context** · **Add Active Selection to DSH Context** · **Add Problems to DSH Context** · **Capabilities and Integrations** · **Diagnose** · **Clean Up Orphan DSH Servers**
- With `dsh.autoStart` on, the server is started at VS Code startup even if the sidebar is never opened

## Session navigation

**New Session** / **Switch Session** use DSH's local session API. **Switch Session** shows a QuickPick with each root session's title, workspace path, update time, and running state; selecting one reloads the iframe with the `dsh_session` query parameter so the DSH web UI opens that session. The extension does not keep a second session tree — the DSH server remains the source of truth. **New Session** creates a session for the current workspace root and, when one already exists, reuses a blank session for the same cwd instead of creating a duplicate.

## Editor context (explicit attachment)

Right-click the editor body and choose **Add File to DSH Thread** (no selection required) or, with a selection, **Add to DSH Thread**. Both focus the DSH sidebar and append only a Markdown link such as `[app.js](…)` / `[app.js:5-8](…)`; no source text is pasted into the draft. After the message is rendered, clicking the link reopens the approved file range in the owning VS Code window. Existing draft text is preserved, and the extension does not send automatically.

**Add File to DSH Thread** is the only command that may attach a trusted `file://` document located outside the open workspace folders (for example a file opened via `File > Open File…`). That explicit-user-action approval only applies to the command itself and to the produced attachment link; the versioned bridge's `open`, `openDiff`, and wire-supplied diagnostics requests remain workspace-only, and `Add Active File / Selection / Problems` keep their implicit-attachment workspace gate.

The extension never sends editor content implicitly. The active file, selection, and Problems stay out of DSH until you run one of the **Add …** commands; the resulting attachment is the only thing the `vscode_editor` tool can read back through the versioned bridge.

- File, selection, and Problems attachments are window-memory only and are cleared when the workspace root changes.
- Attachments over 1 MiB (UTF-8) are rejected instead of silently truncated; diagnostics are capped at 1000 items and 2000 chars per message.
- Bridge `open`/`openDiff`/wire-supplied diagnostics only accept `file` URIs inside an open, trusted workspace folder — the bridge exposes no arbitrary command, URI, or file read.
- DSH receives `vscode/contextChanged` notifications carrying revision and attachment ids only, never content. CH1 v2 adds metadata-only `selectionChanged` / `activeEditorChanged` / `diagnosticsChanged` notifications, validated against `V2_NOTIFICATION_SCHEMA` at the host boundary.

## Capabilities & diagnostics

**Capabilities and Integrations** focuses the DSH sidebar and opens the capability center in the DSH web UI. The extension ships a small controlled provider catalog (`src/capabilityCatalog.js`) and a provider detector (`src/providerDetector.js`) that reports install/enable state for four framework candidates only:

- Remote development: `ms-vscode-remote.remote-wsl`, `ms-vscode-remote.remote-ssh`
- GitHub: `GitHub.vscode-pull-request-github`
- Browser: `browser-provider-placeholder` (framework placeholder until the W5 browser provider is selected and verified)

The extension never installs third-party providers. **Every third-party provider is `manual-assist` in this round**; none is marked `integrated` because the stable-interface audit (G3) is still open. `vscode/extensions/openDetails` only opens the catalog-controlled VS Code extension details page or an official `https://` documentation page — there is no install code path.

**Diagnose** reads the `dsh.*` configuration, server state, bridge state, catalog revision, and provider detection results, then shows a single summary message. Full diagnostics output and an OutputChannel are intentionally deferred to a later W4 slice.

## 0.6 capabilities

- **Plugin catalog** (`src/catalog/*`, `src/detection/*`, `src/diagnose/*`): a schema-validated catalog contract describes DSH plugin categories/entries, and the L3 probe detects installed plugins in the selected DSH home. `Diagnose` includes the plugin summary.
- **Workspace registry** (`src/context/workspaceBinding.js`, `src/ch2/workspaceClient.js`): the sidebar binds VS Code workspace roots through DSH's `workspace.list/create` API. Switching the active workspace root rebinds the DSH session through the registry — the owned child process is **not** killed or restarted. Owned servers auto-create the workspace record; reused servers ask for consent.
- **CH1 v2** (`src/protocol/ch1.js`, `src/ch1/notifier.js`): the versioned bridge negotiates protocol v1/v2 and adds metadata-only `selectionChanged` / `activeEditorChanged` / `diagnosticsChanged` notifications, coalesced by a 150 ms notifier and validated against `V2_NOTIFICATION_SCHEMA`.
- **Command shell** (`src/commands/shell.js`, `src/commands/addFileToThread.js`): a capability-router gate for commands; `dsh.addFileToThread` is the first command wired through it.

Provider state is refreshed through `vscode.extensions.onDidChange`, which emits `vscode/providerStatesChanged` notifications on the versioned bridge. Detection re-reads `vscode.extensions` on every call and never caches state across workspaces.

## VS Code bridge capabilities & roadmap (0.6+)

The versioned bridge (`versionedBridgeServer` + CH1 protocol) is the channel DSH uses to reach the VS Code window. It is intentionally narrow today: read-only, explicit-attachment oriented, and guarded by workspace trust and loopback tokens.

### Currently exposed to DSH

| Type | Exposed methods / notifications |
|---|---|
| Editor read | `vscode/editor/getContext` |
| Open file | `vscode/editor/open` |
| Open diff | `vscode/editor/openDiff` |
| Diagnostics | `vscode/workspace/getDiagnostics` |
| Extension / provider | `vscode/extensions/getProviderStates` · `vscode/extensions/openDetails` |
| Notifications (v1) | `vscode/contextChanged` · `vscode/providerStatesChanged` · `vscode/workspaceChanged` |
| Notifications (v2) | + `vscode/editor/selectionChanged` · `vscode/editor/activeEditorChanged` · `vscode/diagnosticsChanged` |

### Not exposed yet

- Debugging: start/stop sessions, breakpoints, call stack, variables
- Integrated terminal: create/write/read
- Tasks: run `tasks.json` / npm scripts / test runners
- File editing: `applyEdits` / direct workspace file mutation
- Git / SCM: stage, commit, apply diff
- User interaction UI: QuickPick, input box, permission confirmations
- Workspace search: `findFiles` / symbols / LSP results

### Roadmap to Cursor / Claude Code-style experience

Achieving a Cursor/Claude Code-like experience requires both sides of the bridge:

1. **Extend CH1 to a v3 method set**, for example:
   ```text
   vscode/editor/applyEdit
   vscode/debug/start
   vscode/debug/stop
   vscode/debug/breakpoints
   vscode/debug/getStack
   vscode/debug/step
   vscode/terminal/create
   vscode/terminal/write
   vscode/terminal/read
   vscode/tasks/run
   vscode/git/stage
   vscode/git/commit
   vscode/workspace/findFiles
   vscode/window/showInputBox
   vscode/window/showQuickPick
   vscode/window/showConfirm
   ```
   Each method needs a handler in the extension host, security checks (`file://`, workspace trust, token auth), version negotiation, and tests.

2. **Add matching tools in the DSH runtime**, such as `vscode_apply_edit`, `vscode_run_debug`, `vscode_terminal_exec`, `vscode_run_task`, `vscode_git_commit`, `vscode_ask_user`.

3. **Add a permission / approval / diff-review layer**:
   - sensitive operations (edit files, run commands, debug, commit) require explicit user confirmation
   - show proposed diffs and operation history
   - allow apply / reject / rollback

4. **Build the agent-loop UX**:
   - multi-file editing and applying changes
   - automatic feedback from diagnostics and test runs
   - streaming terminal output back to the conversation
   - debugger state (stack/variables) readback
   - in-editor progress and accept/reject UI for model suggestions

**Current status:** the extension exposes a small read-only VS Code surface. Full Cursor/Claude Code parity is not implemented yet and is a multi-milestone roadmap, not part of the 0.6 batch.

## Configuration

| Key | Default | Description |
|---|---|---|
| `dsh.port` | 3080 | Port to probe/start the DSH web server on |
| `dsh.host` | 127.0.0.1 | Fixed loopback bind required by the current DSH Web profile |
| `dsh.autoStart` | true | At VS Code startup, launch the official DSH with the selected home and `web` profile; reuse the configured endpoint if runtime resolution fails (false = reuse only) |
| `dsh.home.mode` | `shared` | `shared` uses the official DSH home; `isolated` uses extension-private `globalStorage/.dsh` and a separate module configuration |
| `dsh.home.path` | (empty) | Machine-scoped absolute override for shared mode; empty follows `DSH_HOME`, then `~/.dsh` |
| `dsh.profile` | `web` | Window-scoped DSH profile directory under the selected home; must match `^[A-Za-z0-9._-]{1,64}$` |
| `dsh.closePolicy` | `onVscodeExit` | When to stop the extension-owned server (see below) |
| `dsh.local.packageRoot` | (empty) | Optional absolute official `@deepseek-ai/dsh` package root; empty auto-detects the global npm installation |
| `dsh.local.nodePath` | (empty) | Optional absolute Node.js executable path; empty auto-detects it |
| `dsh.runtime.manifestUrl` | (empty) | Optional HTTPS runtime release manifest; empty uses the local official npm DSH, non-empty opts into manifest/SHA-256-verified managed-runtime provisioning |
| `dsh.runtime.version` | (empty) | Optional managed-runtime version pin; only applies with a manifest URL |
| `dsh.features.clipboard-bridge` | true | Embedded copy/paste bridge between the DSH iframe and the VS Code clipboard (L1 feature, off = DSH copy buttons write to the webview clipboard) |
| `dsh.features.thread-attachment` | true | Add the active file/selection/problems to the DSH conversation (L1 feature, off = Add to Thread commands are not registered) |
| `dsh.features.editor-links` | true | Open DSH Read… and draft attachment links in this VS Code window (L1 feature, off = text document bridge is not started) |
| `dsh.features.statusbar-basic` | true | Basic DSH status indicator in the status bar (L1 feature, off = the L0 `$(error)` fallback still surfaces on failure) |

`dsh.closePolicy` values:

| Value | Behavior |
|---|---|
| `onVscodeExit` | Stop the owned server only when VS Code exits (default) |
| `onViewClose` | Also stop the owned server when the sidebar view is closed |
| `never` | Never stop automatically — use the **Stop DSH Server** command; after a window crash, survivors are listed by **Clean Up Orphan DSH Servers** |

A reused (non-owned) instance is never stopped by any policy or command.

## Compatibility

- VS Code ≥ 1.106 (`secondarySidebar`); explicit `activationEvents`; `extensionKind: [workspace]`
- Windows / macOS / Linux
- Each managed DSH child receives an authenticated loopback bridge URL/token; supported DSH builds POST configuration paths back to the owning extension host, which opens them through `vscode.window.showTextDocument` in that exact window. `DSH_TEXT_EDITOR=vscode` remains only as an older-DSH CLI fallback; reused external servers keep their own editor policy
- The iframe receives `dsh_embed=vscode`, which supported DSH builds use to hide their internal sidebar, details column, and resize handles; **Open in Browser** keeps the normal full layout
- Managed children receive a generated `--patch` overlay at `DSH_HOME/.integrations/vscode-sidebar/vscode-embed.overlay.yml`. It disables plugins known to duplicate embedded chrome (`better-sidebar`, `ui-dsh-aionui-panel`) without editing DSH sources, profiles, or the user's `cordis.patch.yml`
- Default autoStart accepts only a local npm package whose identity is `@deepseek-ai/dsh`, resolving the real package, entrypoint, and Node executable to absolute paths; it never executes an identity-unknown `dsh` shim from PATH. With an explicit manifest URL, the managed runtime still verifies its pointer, manifest, and payload SHA-256. Either path tries to reuse a DSH already serving the configured endpoint before showing an error
- Cleanup: `taskkill /T /F` tree-kill (Windows — force-terminated, not a graceful stop); detached spawn + `kill(-pid)` process-group SIGTERM (POSIX)
- Untrusted / virtual workspaces **unsupported** (spawns local processes, touches workspace files) — declared via `capabilities`
- Container/view IDs `dsh-sidebar` / `dsh.webview` are **persistent contracts** — never change them in a release (resets the user's sidebar layout)
- UI language follows VS Code (zh/en): manifest via `package.nls.*.json`, runtime via `vscode.l10n` (`l10n/bundle.l10n.*.json`)
- Release verification is local: `npm run check:w0` plus `npm run test:extension-host`; the repository intentionally carries no GitHub Actions workflow.

## Security & trust model

The extension runs **two bridges with two different trust scopes**, and the boundary is deliberate:

- **Versioned CH1 bridge** (`src/versionedBridgeServer.js`, authenticated by a per-window random token in `DSH_VSCODE_BRIDGE_*` env): `open`, `openDiff`, and wire-supplied diagnostics accept **only `file://` URIs inside open, trusted workspace folders**, plus attachments the user explicitly approved. This is the model-driven (`vscode_editor`) surface.
- **Text document bridge** (`src/textDocumentBridge.js`, separate per-process token in `DSH_VSCODE_OPEN_TOKEN`): intentionally **opens any absolute local path** in the owning VS Code window after a trusted-workspace check, so `Read …` links from older shared-home sessions whose cwd lies outside the current workspace keep working. The token is only injected into this extension's owned DSH child, but DSH is an agent harness: anything a model inside that child decides to open is equivalent to the user opening it. It is an *open-in-editor* path only — it reads no file content back to DSH and cannot execute commands — yet it can still steal window focus (`showTextDocument(preserveFocus: false)`).
- **`dsh.addFileToThread`** is a middle ground: an explicit user command may attach a trusted workspace-outside `file://` document; the resulting attachment link reopens through the approved-attachment path only.

If you use shared-home DSH sessions with a model you do not fully trust, keep workspace trust on and treat the embedded DSH like an agent with editor-open capability — not like a sandboxed webview.

## Known limitations

- **Real browser provider not integrated**: the capability catalog only lists `browser-provider-placeholder`; provider selection and verification are deferred to W5.
- **Extension Host smoke version**: the smoke test currently runs against VS Code 1.106 by default.
- **Spawn output goes to a per-spawn log, not the OutputChannel**: the DSH child's stdout/stderr is captured in `<globalStorage>/dsh-server-<port>-<pid>.log` (truncated on each spawn) when the instance registry is writable; unexpected crashes still surface primarily as exit codes on the status page. A VS Code OutputChannel view is a later hardening item.
- **Crash leftovers require one manual cleanup step**: after a VS Code crash or `closePolicy: never`, a surviving owned DSH is deliberately not auto-killed (it may still be in use). Run **Clean Up Orphan DSH Servers** to list registry entries with live pids; it probes each endpoint and only terminates processes that still answer as DSH, otherwise it offers record-only removal.
- **Configured local paths are trusted verbatim (cross-platform validation gap)**: `dsh.local.packageRoot` / `dsh.local.nodePath` accept any value that passes `path.isAbsolute`. On win32 a POSIX absolute path (`/Users/…/nvm/…`) also passes, and a configured root replaces automatic discovery entirely — a value synced from another machine then reports "Official DSH is not installed" even when the package IS installed. The configured-root error now names the offending path (0.5.3 hardening); the durable fix — win32 drive-letter validation (`/^[A-Za-z]:[\\/]/`) for configured absolute paths and `scope: "machine"` — is tracked in Troubleshooting.
- **Startup failures are only partially classified**: 0.6.0 gives configuration-only failures (host/port invalid, `autoStart=false` with no server, invalid configured root/node/home) stable codes and hides the Retry button because retrying cannot help. Runtime/spawn/download failures remain free-text with Retry. The full per-class switch-case startup detection (stable codes + per-class messages + Retry behavior for every failure class) is tracked in Troubleshooting.
- **Version-manager discovery is not exhaustive**: nvm (POSIX), fnm (macOS), asdf, and n are discovered; Volta, fnm on Windows, and nvm-windows custom roots are not yet in the candidate list. Use `dsh.local.packageRoot` / `dsh.local.nodePath` on those layouts.
- **Some DSH copy buttons may still fail**: the bridge only replaces `navigator.clipboard.writeText`; a DSH UI fallback that uses `document.execCommand('copy')` writes to the webview clipboard instead of the VS Code clipboard and belongs to the DSH UI side. Model-output Copy through the standard clipboard API works.

## Implementation

| File | Responsibility |
|---|---|
| `src/extension.js` | extension-host assembly and DSH connection orchestration |
| `src/editorContext.js` | explicit editor attachments, open/openDiff, diagnostics, workspace URI gate |
| `src/threadAttachment.js` | acknowledged Webview bridge for appending an editor selection to the active DSH draft |
| `src/capabilityCatalog.js` | controlled W4 provider catalog, URI whitelist, catalog revision |
| `src/providerDetector.js` | provider install/enable/health detection, bridge handlers, diagnostic snapshot |
| `src/versionedBridgeServer.js` | versioned loopback bridge (editor, diagnostics, extensions) |
| `src/textDocumentBridge.js` | per-window token loopback bridge for opening DSH-owned text documents |
| `src/bridgeWorkspace.js` | bridge workspace identity and trust classification |
| `src/embedOverlay.js` | generated `--patch` overlay for the managed DSH child |
| `src/dshHome.js` | shared/isolated home resolution, 0.4.x migration guard, runtime/home binding |
| `src/lifecycle.js` | serialized lifecycle queue and shutdown gate |
| `src/localRuntimeResolver.js` | discovers/verifies the local official npm DSH and prepares the selected DSH home |
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
| `src/protocol/webview.js` | webview bridge constants/validators (request-id rule shared by shell, host, client) |
| `src/protocol/ch1.js` | CH1 v1/v2 method/notification contract and `V2_NOTIFICATION_SCHEMA` enforcement |
| `src/ch1/notifier.js` | metadata notification coalescer with v2 schema validation |
| `src/ch2/workspaceClient.js` | DSH workspace registry API client |
| `src/context/workspaceBinding.js` | workspace registry binding state machine |
| `src/commands/shell.js` | capability-router command shell |
| `src/commands/addFileToThread.js` | `dsh.addFileToThread` command body |
| `src/catalog/catalogSchema.js` | plugin catalog schema validation |
| `src/catalog/pluginCatalog.js` | installed-plugin catalog snapshot |
| `src/detection/pluginDetector.js` | L3 installed-plugin probe |
| `src/detection/profileProbe.js` | DSH profile/entry probing |
| `src/detection/probeTypes.js` | probe result/state contracts |
| `src/diagnose/pluginSummary.js` | diagnose plugin summary |
| `src/adapters/contract.js` | capability adapter contract |
| `src/workspaceContext.js` | settings, workspace root, registry path |
| `src/types.js` | contract constants (port, boot marker, view ID) |

Key behaviors:

- Probe `GET /` for the `__DSH_BOOT__` marker (3s timeout, 3 retries — a busy DSH is never misjudged as absent)
- Before every autoStart spawn, `connectNow` resolves the selected shared/isolated home independently, re-discovers and verifies the local official `@deepseek-ai/dsh`, then launches `--profile web`; the SHA-256-verified managed-runtime path is used only when `dsh.runtime.manifestUrl` is explicitly configured and is rebound to the same selected home
- Default `autoStart` mode does not adopt another window's process: occupied ports are scanned forward (up to 50) and each extension host owns its child; only a local-runtime resolution failure triggers reuse of an existing configured endpoint
- cwd = current workspace (multi-root: active editor's folder; none: inherit parent cwd, no home fallback)
- Remote (WSL / Remote-SSH): `vscode.env.asExternalUri` port forwarding
- Browser commands use the same externalized URL as the iframe, including remote sessions and connection-error fallback pages
- Only the iframe URL gains the `dsh_embed=vscode` compact-layout marker; browser URLs remain unmodified
- Workspace switch: rebind the DSH session through the workspace registry without killing or restarting the owned child (PID stays the same)
- `onStartupFinished` activation: with `dsh.autoStart` on, the server starts at VS Code startup (null-safe when no webview is open)
- With the default `onVscodeExit` policy, extension deactivation cancels pending startup, waits for the serialized lifecycle queue, and tree-kills any child that appeared; closing one VS Code window does not affect another window's child
- Lifecycle transitions (connect / stop / workspace rebind / config reconcile) run through one serialized queue, so a dispose arriving during connect cannot kill a process a rebind just started
- `dsh.stopServer` and the close policy stop **only** owned processes; a reused external instance is never killed
- Registry pruning only removes dead entries and never kills a live process; `onVscodeExit` stops an owned child during extension-host shutdown, while `never` intentionally lets it survive until explicitly stopped
- Editor bridge requests reject non-`file` URIs, URIs outside `workspace.getWorkspaceFolder`, and untrusted workspaces; remote URIs are never converted to local paths

## FAQ

- **"DeepSeek official API" key is read-only in DSH settings?**
  DSH deliberately treats `DEEPSEEK_API_KEY` supplied by the launching environment as read-only (writes would be silently shadowed). Fix: unset it in the shell that starts dsh web (or VS Code) and restart — the key already stored in `~/.dsh/.credentials.yaml` takes over and the field becomes editable.

## Troubleshooting

### "Official DSH is not installed" while the global package IS installed (2026-08-17)

Symptom: the sidebar reports `Official DSH is not installed …` (status page shows `http://127.0.0.1:3080`) while `npm ls -g` lists `@deepseek-ai/dsh`.

Cause: Settings Sync carried the Mac's machine-specific values into the Windows user settings:

```json
"dsh.local.packageRoot": "/Users/zhengduojie/.nvm/versions/node/v24.18.1/lib/node_modules/@deepseek-ai/dsh",
"dsh.local.nodePath": "/Users/zhengduojie/.nvm/versions/node/v24.18.1/bin/node",
```

On win32 these POSIX paths pass `path.isAbsolute` (drive-relative), so the resolver treated the configured root as authoritative, searched only it, found nothing, and fell through to the generic install message. Automatic discovery (`%APPDATA%\npm\node_modules\@deepseek-ai\dsh`) was never consulted.

Fix: remove `dsh.local.packageRoot` and `dsh.local.nodePath` from the affected machine's user settings (or set machine-correct values) and reload the window. Automatic discovery then finds the installed package and Node from PATH.

Planned hardening (recorded here, not yet implemented):

- **Complete switch-case startup classification**: 0.6.0 already codes configuration-only failures and hides Retry for them. Runtime resolution / connect / spawn / health failures still need stable per-class codes, messages, diagnose entries, and Retry behavior — no free-text matching.
- **`scope: "machine"`** for `dsh.local.packageRoot` / `dsh.local.nodePath`, so Settings Sync stops shipping machine paths across devices (matching `dsh.home.path`).
- **win32 drive-letter validation** for configured absolute paths (`/^[A-Za-z]:[\\/]/`), rejecting POSIX-style paths before candidate search instead of after search falls through.
- **Version-manager discovery parity**: add Volta (`~/.volta/tools/image/node/*`), fnm on Windows (`%APPDATA%\fnm\node-versions`), and nvm-windows custom roots.

## License

MIT © Xizhi1024
