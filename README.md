# DeepSeek Harness(dsh) for VS Code

[English](README.md) · [简体中文](README.zh-CN.md)

Embeds the full DSH web UI in the VS Code auxiliary sidebar: every window automatically starts and owns a local `dsh web` service (cwd = current workspace), so your modules, skills, MCP servers, credentials and sessions all just work. It also exposes VS Code tools to DSH:

- **Chat in the sidebar**: `Ctrl+Alt+B` opens it; copy/paste/context menu, file jumps and theme following are all native
- **VS Code tools**: DSH can open workspace files and diffs, read diagnostics, and inspect editor metadata. Additional capabilities use the settings below.
- **Context attachment**: right-click a file / selection / folder / Problems to append a compact link to the DSH draft — source text is never pasted, nothing is ever auto-sent

## ⚠️ Compatibility

| Item | Requirement |
|---|---|
| VS Code | ≥ 1.106, desktop only; remote / virtual / untrusted workspaces not supported |
| DSH CLI | An existing installation is detected automatically. With default settings, a missing DSH runtime is installed on macOS, Windows, and Linux (x64 and arm64). |
| Node.js | Automatic DSH installation includes a private Node.js runtime. For a manually installed DSH, set `dsh.local.nodePath` if discovery misses your Node.js. |

## 📦 Install

- **Marketplace (recommended)**: search **DeepSeek Harness** (publisher Xizhi1024) in the Extensions view, or `code --install-extension Xizhi1024.dsh-vs-sidebar`
- **VSIX**: download from [Releases](https://github.com/Xizhi1024/deepseek-harness-dsh-for-vscode/releases) → `Extensions: Install from VSIX...`

With `dsh.autoStart` enabled, the extension checks for DSH when VS Code starts. On a first install it downloads Node.js and the official `@deepseek-ai/dsh` package into VS Code’s extension storage, then starts `dsh web`. A failed download can be retried from the sidebar. Set `dsh.runtime.version` to an exact npm version to pin the automatic installation.

## 🚀 Usage

1. Press `Ctrl+Alt+B` — the extension starts (or reuses) the local `dsh web` and loads the UI
2. Select code → right-click **Add to DSH Thread**; the draft receives a compact `file:line` link, press Enter to send

Commands include focusing the sidebar, opening DSH in the browser, restarting or stopping the service, and diagnostics.

If startup fails, DSH stays paused while you switch editors or reopen the sidebar. Use **Retry**, **Restart DSH Server**, or change the relevant DSH settings to make another attempt.

![Add selected VS Code ranges to a DSH conversation as compact links](media/add-to-dsh-thread-example-en.png)

## ⚙️ Configuration

| Key | Default | Description |
|---|---|---|
| `dsh.port` | 3080 | Port for the DSH web server |
| `dsh.autoStart` | true | Start the service when VS Code opens |
| `dsh.home.mode` | shared | shared = official ~/.dsh; isolated = extension-private home |
| `dsh.profile` | web | DSH profile directory name |
| `dsh.executablePath` | (empty) | Explicit DSH executable / package dir / shim; takes precedence over discovery |
| `dsh.closePolicy` | onVscodeExit | When to stop the owned server |
| `dsh.features.mcp-consume` | false | Let DSH consume VS Code-side MCP servers |
| `dsh.keybindings.ctrlL` | true | Ctrl+L adds the selection to the thread (never sends) |
| `dsh.bridge.terminal` / `editorRead` / `ui` | false | Terminal / editor-read / UI surface bridges (consent switches) |
| `dsh.features.call-export` | false | Allow DSH to call a VS Code extension export after confirmation |

Full key list in `package.json`; run **DSH: Diagnose** for a health summary.

## License

[MIT](LICENSE)
