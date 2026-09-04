# DeepSeek Harness(dsh) for VS Code

[English](README.md) · [简体中文](README.zh-CN.md)

**A Cursor-like AI coding experience inside VS Code — powered by your own DeepSeek Harness (DSH) agent.**

Embeds the full DSH web UI in the VS Code auxiliary sidebar: every window automatically starts and owns a local `dsh web` service (cwd = current workspace), so your modules, skills, MCP servers, credentials and sessions all just work. On top of that it adds the IDE integration layer:

- **Chat in the sidebar**: `Ctrl+Alt+B` opens it; copy/paste/context menu, file jumps and theme following are all native
- **Context attachment**: right-click a file / selection / folder / Problems to append a compact link to the DSH draft — source text is never pasted, nothing is ever auto-sent
- **DSH Changes review**: workspace edits pushed by DSH land in a dedicated tree with diff / accept / undo; every write needs explicit approval (on by default)
- **@dsh chat participant**: type `@dsh` in the native VS Code chat to talk to your local DSH session with streaming replies — zero Copilot quota (on by default)
- **Advanced, opt-in**: Ctrl+K / Ctrl+I inline edit, model routing into the VS Code LM picker, MCP consumption, terminal / UI bridges, FIM tab completion — every capability behind an explicit consent switch (FIM tab completion is a POC and was **not end-to-end verified** in this release, see the table note)

## ⚠️ Compatibility

| Item | Requirement |
|---|---|
| VS Code | ≥ 1.106, desktop only; remote / virtual / untrusted workspaces not supported |
| DSH CLI | `npm i -g @deepseek-ai/dsh`, ≥ 0.1.0-rc.7 recommended (older runtimes auto-retry degraded, some features limited) |
| Node.js | auto-detected; set `dsh.local.nodePath` for non-standard locations |
| Windows + WSL | when the workspace lives in WSL, set the default terminal profile to a **Windows** shell (PowerShell/cmd) — a WSL default profile makes extension-host terminals and the terminal bridge unreliable; Diagnose warns when it detects a WSL default terminal |

The extension reads the installed official DSH package version before launch. Versions before `0.1.2-rc.1` are expected to expose the legacy `apiProxy` host and native session REST routes; `0.1.2-rc.1+` is expected to expose `sessionController`, so the bundled integration restores the removed REST surface. The version selects the diagnostic expectation only: live capability negotiation claims whichever service actually exists, keeping forks and prereleases fail-open instead of blocking plugin activation.

## 📦 Install

- **Marketplace (recommended)**: search **DeepSeek Harness** (publisher Xizhi1024) in the Extensions view, or `code --install-extension Xizhi1024.dsh-vs-sidebar`
- **VSIX**: download from [Releases](https://github.com/Xizhi1024/deepseek-harness-dsh-for-vscode/releases) → `Extensions: Install from VSIX...`

## 🚀 Usage

1. Press `Ctrl+Alt+B` — the extension starts (or reuses) the local `dsh web` and loads the UI
2. Select code → right-click **Add to DSH Thread**; the draft receives a compact `file:line` link, press Enter to send (Ctrl+Enter / Cmd+Enter inserts a line break)
3. Type `@dsh` + your question in the VS Code chat — replies stream from your local DSH session
4. Let DSH propose an edit through the bridge: it lands in the **DSH Changes** view for diff / accept / undo — nothing is written without approval

![Add selected VS Code ranges to a DSH conversation as compact links](media/add-to-dsh-thread-example-en.png)

Common commands (palette, `DSH:` prefix): New / Switch Session · Open Session History · Restart / Stop Server · Open in Browser · New DSH Instance · Diagnose · Restart Cleanly · Set DSH FIM API Key.

## ⚙️ Configuration

| Key | Default | Description |
|---|---|---|
| `dsh.port` | 3080 | Port for the DSH web server |
| `dsh.autoStart` | true | Start the service when VS Code opens |
| `dsh.home.mode` | shared | shared = official ~/.dsh; isolated = extension-private home |
| `dsh.profile` | vscode | Extension-owned profile, separate from a terminal `dsh web` (see note below) |
| `dsh.executablePath` | (empty) | Explicit DSH executable / package dir / shim; takes precedence over discovery |
| `dsh.closePolicy` | onVscodeExit | When to stop the owned server |
| `dsh.features.changes-review` | true | DSH changes review (approval-gated writes) |
| `dsh.features.chat-participant` | true | @dsh chat participant |
| `dsh.features.ctrl-k` / `ctrl-i` | false | Inline edit commands (Ctrl+K / Ctrl+I) |
| `dsh.features.lm-route` | false | Expose DSH models in the VS Code LM picker |
| `dsh.features.mcp-consume` | false | Let DSH consume VS Code-side MCP servers |
| `dsh.features.tab-completion` | false | FIM tab completion — needs `dsh.fim.baseUrl` + **DSH: Set FIM API Key**, then restart the DSH server. ⚠️ POC status: not end-to-end verified in this release (1.1.2) — the completion chain was never exercised against a real upstream; if it does not work once configured, please open an [issue](https://github.com/Xizhi1024/deepseek-harness-dsh-for-vscode/issues) |
| `dsh.fim.baseUrl` | (empty) | Upstream FIM endpoint (full URL of an OpenAI-compatible completions API) |
| `dsh.keybindings.ctrlL` | false | Ctrl+L adds the selection to the thread |
| `dsh.bridge.terminal` / `editorRead` / `ui` | false | Terminal / editor-read / UI surface bridges (consent switches) |

Full key list in `package.json`; run **DSH: Diagnose** for a health summary.

### Dedicated profile

The extension launches its DSH child on its own profile (`vscode` by default), fully separate from the `web` profile a terminal `dsh web` uses — separate plugin tree, separate cordis patch layer, separate server instance. When the profile directory does not exist yet, the extension scaffolds it once (manifest with the web app bundles, empty patch layer, pnpm settings). Clean-restart (**Restart-Clean**) only restarts the extension's own child and never touches a terminal `dsh web`. To share one profile again, set `"dsh.profile": "web"` and reload the window.

## License

[MIT](LICENSE)
