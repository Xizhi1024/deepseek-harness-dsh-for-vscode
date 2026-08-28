# DeepSeek Harness(dsh) for VS Code

[English](README.md) · [简体中文](README.zh-CN.md)

**A Cursor-like AI coding experience inside VS Code — powered by your own DeepSeek Harness (DSH) agent.**

Embeds the full DSH web UI in the VS Code auxiliary sidebar: every window automatically starts and owns a local `dsh web` service (cwd = current workspace), so your modules, skills, MCP servers, credentials and sessions all just work. On top of that it adds the IDE integration layer:

- **Chat in the sidebar**: `Ctrl+Alt+B` opens it; copy/paste/context menu, file jumps and theme following are all native
- **Context attachment**: right-click a file / selection / folder / Problems to append a compact link to the DSH draft — source text is never pasted, nothing is ever auto-sent
- **DSH Changes review**: workspace edits pushed by DSH land in a dedicated tree with diff / accept / undo; every write needs explicit approval (on by default)
- **@dsh chat participant**: type `@dsh` in the native VS Code chat to talk to your local DSH session with streaming replies — zero Copilot quota (on by default)
- **Advanced, opt-in**: Ctrl+K / Ctrl+I inline edit, model routing into the VS Code LM picker, MCP consumption, terminal / UI bridges, FIM tab completion — every capability behind an explicit consent switch

## ⚠️ Compatibility

| Item | Requirement |
|---|---|
| VS Code | ≥ 1.106, desktop only; remote / virtual / untrusted workspaces not supported |
| DSH CLI | `npm i -g @deepseek-ai/dsh`, ≥ 0.1.0-rc.7 recommended (older runtimes auto-retry degraded, some features limited) |
| Node.js | auto-detected; set `dsh.local.nodePath` for non-standard locations |

## 📦 Install

- **Marketplace (recommended)**: search **DeepSeek Harness** (publisher Xizhi1024) in the Extensions view, or `code --install-extension Xizhi1024.dsh-vs-sidebar`
- **VSIX**: download from [Releases](https://github.com/Xizhi1024/deepseek-harness-dsh-for-vscode/releases) → `Extensions: Install from VSIX...`

## 🚀 Usage

1. Press `Ctrl+Alt+B` — the extension starts (or reuses) the local `dsh web` and loads the UI
2. Select code → right-click **Add to DSH Thread**; the draft receives a compact `file:line` link, press Enter to send
3. Type `@dsh` + your question in the VS Code chat — replies stream from your local DSH session
4. Let DSH propose an edit through the bridge: it lands in the **DSH Changes** view for diff / accept / undo — nothing is written without approval

![Add selected VS Code ranges to a DSH conversation as compact links](media/add-to-dsh-thread-example-en.png)

Common commands (palette, `DSH:` prefix): New / Switch Session · Open Session History · Restart / Stop Server · Open in Browser · New DSH Instance · Diagnose · Restart Cleanly.

## ⚙️ Configuration

| Key | Default | Description |
|---|---|---|
| `dsh.port` | 3080 | Port for the DSH web server |
| `dsh.autoStart` | true | Start the service when VS Code opens |
| `dsh.home.mode` | shared | shared = official ~/.dsh; isolated = extension-private home |
| `dsh.profile` | web | DSH profile directory name |
| `dsh.executablePath` | (empty) | Explicit DSH executable / package dir / shim; takes precedence over discovery |
| `dsh.closePolicy` | onVscodeExit | When to stop the owned server |
| `dsh.features.changes-review` | true | DSH changes review (approval-gated writes) |
| `dsh.features.chat-participant` | true | @dsh chat participant |
| `dsh.features.ctrl-k` / `ctrl-i` | false | Inline edit commands (Ctrl+K / Ctrl+I) |
| `dsh.features.lm-route` | false | Expose DSH models in the VS Code LM picker |
| `dsh.features.mcp-consume` | false | Let DSH consume VS Code-side MCP servers |
| `dsh.features.tab-completion` | false | FIM tab completion (POC) |
| `dsh.keybindings.ctrlL` | false | Ctrl+L adds the selection to the thread |
| `dsh.bridge.terminal` / `editorRead` / `ui` | false | Terminal / editor-read / UI surface bridges (consent switches) |

Full key list in `package.json`; run **DSH: Diagnose** for a health summary.

## License

[MIT](LICENSE)
