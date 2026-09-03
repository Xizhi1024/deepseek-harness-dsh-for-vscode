# Known Issues / 问题记录

> 更新日期：2026-09-03 · 对应版本：**1.1.1** · 扩展侧**无未修复已知问题**；下列两项为 **DSH runtime 依赖的已知行为**（诊断旗标可见，详见 `VERSIONS.md` 与 `docs/dev/upstream-issues.md`）
> Updated 2026-09-03 · tracks release **1.1.1** · **no open extension-side issues**; the two items below are **runtime-dependent known behaviors** (visible as diagnose flags; see VERSIONS.md and docs/dev/upstream-issues.md)

| # | 问题 / Issue | 影响范围 / Scope |
|---|---|---|
| 7 | 会话导出 ZIP 文件名双前缀 `dsh-session-session-<uuid>.zip`（DSH 运行时导出命名，上游未修；本地热修在位，重装 dsh 会回滚）/ session export archives save with a doubled prefix — DSH runtime naming, unfixed upstream | 所有已发布 runtime / every released runtime（纯观感，不影响功能 / cosmetic, no functional impact） |
| 8 | 冷会话标题缺失显示裸 UUID + HMR 窗口工具崩溃暴露 / cold sessions show bare-UUID titles and the HMR window tool-crash exposure | 仅 DSH < 0.1.2-alpha.1（0.1.2-alpha.1 起上游已修/默认关闭）/ only below DSH 0.1.2-alpha.1 |
| 9 | 1.0.0 VSIX 捆绑了过期的 runtime-integration 快照（client.js 缺 dsh_session 跟随桥）：每次激活把回归文件同步进 DSH profile，侧栏丢失会话路由、输入框异常 / the 1.0.0 VSIX bundled a stale runtime-integration snapshot whose client.js lost the dsh_session follow bridge; activations re-synced the regressed files into the DSH profile | 修复于 1.1.1：发版门禁强制打包树==提交树 + sessionFollow 金丝雀；F5 测试期间请禁用装着的 1.0.0 扩展 / fixed in 1.1.1 (packaging gate + canary); disable the installed 1.0.0 extension while F5-testing |
| 10 | editObserver 监听器不调 next() 即返回，短路 tools/pre-execute waterfall → 桥接子进程内所有工具调用（含 run_code）报 reading 'kind' / the editObserver listener returned without delegating next(), short-circuiting the pre-execute waterfall — every tool call on bridge-attached children failed with reading 'kind' | 修复于 1.1.1（监听器恒委托 next()，回归测试覆盖全部工具名）/ fixed in 1.1.1 (listener always delegates; regression tests cover every tool name) |

历史问题与修复索引（复现细节见 [CHANGELOG.md](CHANGELOG.md) 与 [docs/dev/](docs/dev/)）：
Past issues and their fixes (details in the changelog and dev notes):

| # | 问题 / Issue | 修复版本 / Fixed in |
|---|---|---|
| 1 | 编辑器空白行右键没有“将文件添加到 DSH 对话”入口 / no editor-body context entry for Add File to DSH Thread | 0.6.0 |
| 2 | 工作区之外的文件无法添加到对话 / files outside the workspace could not be attached | 0.6.0 |
| 3 | macOS 嵌入侧栏内 ⌘C/⌘X 复制剪切失效（VS Code Edit 菜单不转发进嵌套 iframe，microsoft/vscode#129178；旧桥只接管了 ⌘V） / ⌘C/⌘X copy-cut dead inside the embedded iframe on macOS | 0.9.0 |
| 4 | 颜色跟随操作系统而非 VS Code 主题（扩展端 dsh_theme/dshThemeChanged 链路早已就绪，DSH 端消费方缺失，主题服务仍按 prefers-color-scheme 解析 system）/ colors followed the OS instead of the VS Code theme — the DSH-side consumer was missing | 0.9.0 |
| 5 | 默认配置下侧边栏报「没有可提供视图数据的已注册数据提供程序」：dsh.changes 视图无条件声明但提供程序仅在 changes-review 开启时挂载 / "no registered data provider" placeholder for dsh.changes under default settings | 0.9.4 |
| 6 | 切换 VS Code 工作区后侧栏不跟随：扩展端经工作区注册表重绑并以 `?dsh_session=` 重载 iframe，但 DSH Web 端只恢复自己持久化的当前会话、无任何 dsh_session 消费方 / after a workspace switch the sidebar kept the old conversation: the DSH web app restores its own persisted current session and nothing consumed dsh_session | 0.9.3 |

## 验收提示 / Verification notes（issue 3/4）

- 修复位于 DSH 侧 `dsh-vscode-integration/client.js`，由扩展在每次激活时同步进所选 DSH home；**升级扩展后必须完全退出并重启 VS Code**（⌘Q），旧扩展宿主与旧 client.js 不会热替换。
  The fix ships in the DSH-side `dsh-vscode-integration/client.js`, which the extension re-syncs into the selected DSH home on every activation; after upgrading, fully quit and restart VS Code — nothing hot-swaps.
- ⌘C 验收：侧栏消息文字内选中 → ⌘C → 任意编辑器 ⌘V；再在聊天输入框内选中自己输入的文字 → ⌘C。
  Verify ⌘C with a selection over message text, and again with a selection inside the chat composer.
- 主题验收：切换 VS Code 亮/暗主题，DSH 侧栏应实时跟随；卸载/禁用扩展后 DSH 恢复其自身主题偏好。
  Verify theme-follow by toggling the VS Code light/dark theme; on dispose the DSH preference is restored.

## 验收提示 / Verification notes（issue 6）

- 修复同样位于 DSH 侧 `dsh-vscode-integration/client.js`，扩展每次激活时同步进所选 DSH home；**升级扩展后必须完全退出并重启 VS Code**（⌘Q），并重启 DSH 实例使新 client.js 生效。
  The fix likewise ships in the DSH-side `dsh-vscode-integration/client.js` re-synced on every activation; fully quit and restart VS Code after upgrading, and restart the DSH instance.
- 验收：打开文件夹 A → 侧栏绑定 A 的会话；`File → Open Folder` 切到文件夹 B（或多根工作区里把活动编辑器移到另一根）→ 侧栏应重载并自动切到 B 的空白会话，会话工具的工作区根随之为 B；自管 DSH 子进程 PID 全程不变。
  Verify by opening folder A, then `File → Open Folder` to folder B (or focusing an editor from another multi-root folder): the sidebar reloads onto B's blank session, tool sandboxes root at B, and the owned child PID never changes.

## 内部开发文档 / Internal dev notes

实现笔记、QA findings 与批次计划移至 `docs/dev/`（不进 VSIX）：
Implementation notes, QA findings and batch planning live under `docs/dev/` (excluded from the VSIX):

- `docs/dev/impl-notes/` — B0–B4 批次实现笔记
- `docs/dev/qa-findings/` — B2/B3 QA 记录
- `docs/dev/planning/` — 0.7 生命周期计划
