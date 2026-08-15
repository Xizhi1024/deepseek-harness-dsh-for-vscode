# Changelog / 更新日志

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。
All notable changes to this project are documented here, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

> 本节条目已实现但尚未随任何版本发布，也未提交到 Git 仓库；相关改动仅存在于工作区。
> Everything in this section is implemented but unreleased and uncommitted; the changes exist only in the working tree.

### Added / 新增

- **编辑器显式附件（W3）**：新增 Add Active File / Add Active Selection / Add Problems 三条命令，只把用户明确选择的文件、选区与 Problems 附加到 DSH 上下文；版本化桥暴露 `vscode/editor/open`、`vscode/editor/openDiff`、`vscode/workspace/getDiagnostics`，且只接受受信任工作区内的 `file` URI。
  W3 explicit editor attachments: add Add Active File / Add Active Selection / Add Problems so only explicitly selected files, selections, and Problems are attached to DSH context; the versioned bridge exposes `vscode/editor/open`, `vscode/editor/openDiff`, and `vscode/workspace/getDiagnostics`, and only accepts `file` URIs inside a trusted workspace.

- **会话导航（W3）**：QuickPick 新建 / 切换会话，复用 DSH 本地会话 API；切换会话后 iframe 带 `dsh_session` 查询参数重载，DSH 服务仍是会话树的唯一数据源。
  W3 session navigation: New Session / Switch Session QuickPicks built on DSH's local session API; switching reloads the iframe with the `dsh_session` query parameter, and the DSH server remains the single source of truth for the session tree.

- **能力目录与检测框架（W4）**：新增 `dsh.capabilities` / `dsh.diagnose` 命令、受控 provider 目录与检测器；4 个第三方候选（Remote WSL/SSH、GitHub、Browser 占位）全部标记为 `manual-assist`，因稳定接口审计（G3）未关闭而不标记任何 `integrated`；`vscode/extensions/openDetails` 只打开目录受控的扩展详情页或官方文档，绝不安装。
  W4 capability catalog & detection: add `dsh.capabilities` / `dsh.diagnose`, a controlled provider catalog, and a detector; all four third-party candidates (Remote WSL/SSH, GitHub, Browser placeholder) are `manual-assist` — none is marked `integrated` because the stable-interface audit (G3) is still open; `vscode/extensions/openDetails` only opens catalog-controlled extension detail pages or official documentation and never installs.

- **托管运行时与嵌入底座（W1/W2 既有）**：managed runtime（解析 / 下载 / 校验 / 安装）与 VersionedBridgeServer 支撑嵌入与桥接；自管子进程附加动态生成的 `--patch` overlay，禁用 `better-sidebar`、`ui-dsh-aionui-panel`，避免嵌入模式重复叠加侧边栏/面板。
  W1/W2 managed runtime & embed foundation: the managed runtime (resolve / download / verify / install) and VersionedBridgeServer back the embed and bridge; managed children receive a generated `--patch` overlay that disables `better-sidebar` and `ui-dsh-aionui-panel` so embed mode never duplicates sidebar/panel chrome.

- **托管运行时接入激活路径（W1-6/W1-7）**：扩展激活时在 `globalStorageUri/runtime` 下创建运行时存储；每次 `autoStart` 前 `connectNow` 先经 `RuntimeResolver` 解析并校验 runtime，再通过 `ServerManager.setResolvedRuntime()` 交给启动器。新增 `dsh.runtime.manifestUrl`（HTTPS 发布清单）与 `dsh.runtime.version`（可选锁定）：本地无 verified runtime 时按清单下载/安装/promote，失败一律 fail closed 并在状态页展示错误，绝不回退 PATH 上的 `dsh`；`autoStart=false` 路径不变。
  Managed runtime wired into activation (W1-6/W1-7): activation creates runtime storage under `globalStorageUri/runtime`; every autoStart resolves and verifies the runtime through `RuntimeResolver` and hands it to `ServerManager.setResolvedRuntime()` before spawning. New `dsh.runtime.manifestUrl` (HTTPS release manifest) and `dsh.runtime.version` (optional pin) provision missing/pinned runtimes through the existing downloader/installer; all failures fail closed on the status page and never fall back to a PATH `dsh`; `autoStart=false` behavior is unchanged.

- **命令与验证基线**：命令面板共 11 条命令；单元测试 101 pass / 0 fail / 1 skip；Extension Host 激活 smoke 默认在 VS Code 1.106 运行（`secondarySidebar` 贡献点自该版本起受支持）。
  Command & verification baseline: 11 commands in the command palette; unit tests 101 pass / 0 fail / 1 skip; the Extension Host activation smoke runs on VS Code 1.106 by default (`secondarySidebar` is supported from that version onward).

- **密钥扫描门禁（W6-4/W6-5 本地部分）**：新增 `scripts/check-secrets.js` 与 `npm run test:secrets`，扫描将进入 VSIX 的源码/文档（不扫 `node_modules`、`.git`、`.vscode-test`），检测硬编码 DSH 桥接 token 字面量、`Authorization: Bearer` 凭据、OpenAI/AWS key、私钥与密码字面量；示例/测试 fixture 使用显式 `// allow-secret-scan` 注释放行；`check:w0` 末尾纳入该门禁。
  Secret-scan gate (local part of W6-4/W6-5): add `scripts/check-secrets.js` and `npm run test:secrets` to scan the source/docs that will enter the VSIX (never `node_modules`, `.git`, or `.vscode-test`), detecting hardcoded DSH bridge token literals, `Authorization: Bearer` credentials, OpenAI/AWS keys, private keys, and password literals; example/test fixtures are released with an explicit `// allow-secret-scan` comment; `check:w0` now runs this gate.

### Changed / 变更

- **测试入口标准化**：`ServerManager` 的内嵌自测迁移到 `node:test`，由 `npm test` 在本地和三平台 CI 运行；运行时代码不再包含直接执行分支。
  Standardize tests: move the embedded `ServerManager` self-test to `node:test`, run it through `npm test` locally and in the three-platform CI matrix, and remove the direct-execution branch from runtime code.

- **W0 回归骨架**：新增可注入 VS Code facade、Webview 消息路由、持久化 ID、生命周期、工作区与 PATH 单元门禁；CI 同时校验 VSIX 文件清单并运行真实 Extension Host 激活 smoke。
  W0 regression foundation: add unit gates for the injectable VS Code facade, Webview routing, persistent IDs, lifecycle, workspace and PATH behavior; CI also checks the VSIX file list and runs a real Extension Host activation smoke.

### Fixed / 修复

- **嵌入 iframe 剪贴板权限**：iframe 增加 `allow="clipboard-write"`，修复跨源嵌入时 DSH UI 复制按钮被 Permissions Policy 拦截的问题。
  Embedded iframe clipboard permission: add `allow="clipboard-write"` so DSH UI copy buttons are not blocked by the cross-origin Permissions Policy.

- **崩溃后状态僵死与重启门禁**：DSH 子进程 ready 后意外退出时清空 `currentServer` / `currentExternalUrl` / `currentSessionId` / `boundCwd` 并渲染带 Retry 的错误页；`dsh.restartServer` 不再把崩溃残留句柄误判为“复用实例”而拒绝重启。
  Crash-after-ready state reconciliation: clear stale server/session state and render a Retry status page when an owned DSH child exits unexpectedly; `dsh.restartServer` no longer misclassifies a stale crashed handle as a reused instance and refuses to restart.

- **Text-document 桥工作区门禁**：DSH 通过 text-document bridge 打开的路径现在必须是受信任工作区内某个文件夹下的绝对路径，拒绝任意盘符/工作区外文件。
  Text-document bridge workspace gate: DSH-opened paths must be absolute paths inside a trusted workspace folder; paths outside the workspace are rejected.

- **VS Code 引擎基线 1.106**：`engines.vscode` 与 `@types/vscode` 提升到 `^1.106.0`，Extension Host smoke 默认改用 1.106，文档同步移除 `<1.106` 降级说明。
  VS Code engine baseline 1.106: bump `engines.vscode` and `@types/vscode` to `^1.106.0`, default the Extension Host smoke to 1.106, and remove the pre-1.106 fallback notes from docs.

- **会话 id 校验**：New Session / Switch Session 在写入 `currentSessionId` 前使用 `sessionIdFromValue`，超长或含 NUL 的 id 不再出现“UI 提示已切换但 iframe 静默丢弃”的不一致。
  Session id validation: New Session / Switch Session validate ids through `sessionIdFromValue` before use, so over-long or NUL-containing ids cannot silently diverge from the iframe URL.

## [0.3.1] - 2026-08-15

### Added / 新增

- **VS Code 嵌入约定**：iframe 增加 `dsh_embed=vscode`，兼容版本的 DSH 会隐藏内部左右栏；每窗口回环桥接以随机 token 鉴权，把 DSH 配置路径交回所属扩展宿主并由 VS Code API 在准确窗口打开。`DSH_TEXT_EDITOR=vscode` 仅作为旧版 CLI 回退；浏览器入口和被复用的外部实例保持原行为。
  VS Code embed contract: the iframe adds `dsh_embed=vscode` so compatible DSH builds hide their internal side columns; a random-token loopback bridge returns DSH configuration paths to the owning extension host, whose VS Code API opens the exact window. `DSH_TEXT_EDITOR=vscode` remains only as an older CLI fallback; browser entry points and reused external instances keep their original behavior.

- **VS Code 启动即拉取**：新增 `onStartupFinished` 激活事件；`dsh.autoStart` 开启时扩展在 VS Code 启动阶段即确保 DSH 服务存在（未打开侧边栏视图时同样安全，视图稍后打开再接管渲染）。
  Start DSH at VS Code startup: `onStartupFinished` activation ensures the server exists when `dsh.autoStart` is on, even if the sidebar view is never opened (null-safe; a later-resolved view takes over rendering).

- **新增命令 `dsh.stopServer`**：只停止本扩展实例自管（spawn）的进程；被复用的外部实例绝不终止。
  New `dsh.stopServer` command: stops only a process this extension instance owns; a reused external instance is never killed.

- **关闭策略 `dsh.closePolicy`**：新增配置键，取值 `onVscodeExit`（默认）/ `onViewClose` / `never`；默认保守——关闭视图不停止服务，除非用户显式选择 `onViewClose`。
  New `dsh.closePolicy` setting: `onVscodeExit` (default) / `onViewClose` / `never`; conservative default keeps the server alive across view close unless the user opts into `onViewClose`.

### Changed / 变更

- **每窗口独占进程**：默认 `dsh.autoStart=true` 不再接管其他 VS Code 窗口或手动启动的 DSH；每个扩展宿主在独立端口启动自己的子进程，并由默认 `onVscodeExit` 在该窗口关闭时清理。`autoStart=false` 仍提供显式的用户自管端点复用模式。
  One process per window: default `dsh.autoStart=true` no longer adopts DSH from another VS Code window or a manual launch; every extension host starts its own child on an independent port and default `onVscodeExit` cleans it up with that window. `autoStart=false` remains the explicit user-managed endpoint reuse mode.

- **进程所有权与取消修复**：同端点重新确保时保留自管所有权；视图销毁与扩展停用会取消尚未 spawn 的连接，并在队列结算后再次清理可能刚拉起的子进程；重启命令不再对被复用实例给出误导性成功反馈。
  Process ownership and cancellation fixes: re-ensuring the same endpoint preserves managed ownership; view disposal and extension deactivation invalidate pending pre-spawn connections and re-check for a just-created child after the lifecycle queue settles; restart no longer reports misleading success for a reused instance.

- **生命周期串行化**：连接 / 停止 / 工作区重绑 / 配置协调统一走一条串行队列，连接期间到达的视图销毁不会误杀重绑刚拉起的进程（反之亦然）；`dsh.host` / `dsh.port` / `dsh.autoStart` / `dsh.closePolicy` 变更经单一协调器合并，杜绝并发重启。
  Serialized lifecycle: connect / stop / workspace rebind / config reconcile share one queue so a dispose during connect can never kill a process a rebind just started; host/port/autoStart/closePolicy changes are coalesced by a single reconciler (no parallel restarts).

- **决策函数独立可测**：关闭策略判定、所有权/停止判定、配置协调判定抽为 `serverManager.js` 内的纯函数并导出，`node src/serverManager.js` 自测覆盖命令可见行为（“仅自管才停止”）。
  Decision logic extracted into pure, exported functions in `serverManager.js` (close-policy gate, ownership/stop check, config reconcile) covered by the standalone self-test, including command-visible behavior ("stop only when owned").

- **文档同步**：README / README.zh-CN / CHANGELOG / package.nls.* / l10n 打包同步新命令、新配置与策略语义；明确 Windows 侧 `taskkill /T /F` 为强制终止（非优雅停止）。
  Docs synced across README / README.zh-CN / CHANGELOG / package.nls.* / l10n bundles; the Windows `taskkill /T /F` force-terminate (not graceful) behavior is stated explicitly.

## [0.3.0] - 2026-08-14

### Fixed / 修复

- 修复同工作区 DSH 位于顺延端口时无法复用、连接失败页“在浏览器打开”无响应，以及 Remote-SSH / WSL 浏览器命令未使用转发 URL 的问题；实例注册表改用扩展全局存储。
  Reuse workspace-matched DSH instances on scanned-forward ports, make the unavailable-page browser action functional, use forwarded URLs for Remote-SSH / WSL browser commands, and store the instance registry in extension-global storage.

- 发布流水线移入 `.github/workflows/`；VSIX 排除 `.agents`、旧 `ci` 目录和已有 `.vsix` 产物；侧栏与命令分类字符串全部接入本地化。
  Move the release workflow under `.github/workflows/`, exclude `.agents`, legacy `ci`, and existing `.vsix` artifacts from packages, and route view/category strings through localization.

### Changed / 变更

- **界面语言跟随 VS Code**：manifest（含 `displayName`、`configuration.title`、设置项/命令/capabilities 描述）全部走 `package.nls.json` + `package.nls.zh-cn.json`；运行期文案走 `vscode.l10n`（`l10n/bundle.l10n.*.json`）；中英随 VS Code 显示语言自动切换，不再中英混写。
  UI language follows VS Code: every manifest string (incl. `displayName`, `configuration.title`, and all setting/command/capability descriptions) now lives in `package.nls.json` + `package.nls.zh-cn.json`; runtime copy goes through `vscode.l10n` (`l10n/bundle.l10n.*.json`); switches with the VS Code display language, no more mixed zh/en.

- **文案精简**：所有用户可见描述压成一句话（如不受信任工作区提示、`dsh.host` 说明）；`serverManager` 状态消息改为「英文模板 + 参数」，由扩展侧按当前语言渲染。
  Concise copy: every user-facing description is one short line (e.g. untrusted-workspace notice, `dsh.host` hint); `serverManager` status messages are "English template + params", rendered by the extension in the current UI language.

- **README 双语拆分**：原中英对照堆叠的单文件改为 `README.md`（英文）+ `README.zh-CN.md`（中文），顶部互链切换；各节表格化、去冗余补注。
  README split into two single-language files: `README.md` (en) + `README.zh-CN.md` (zh) with a top-of-file language toggle, replacing the old interleaved zh/en blob; sections are table-driven with padding trimmed.

## [0.2.1] - 2026-08-14

### Changed / 变更

- **图标换为官方 DeepSeek 品牌图标**：media/dsh.svg 改用官方 24×24 品牌鲸鱼图标（deepseek.svg，currentColor 单色、符合 VS Code 视图容器图标规范）；media/dsh.png 为官方 logo（deepseek-logo.webp，WIC 解码 + GDI+ 合成）生成的 512×512 黑鲸鱼，SVG 与 PNG 均出自 DeepSeek 官方素材。
  Icon replaced with the official DeepSeek 24×24 brand whale (media/dsh.svg, monochrome currentColor per VS Code view-container icon spec); media/dsh.png stays a 512×512 black whale rendered from the official logo (deepseek-logo.webp via WIC + GDI+) — both files come from official DeepSeek artwork.

- **跨平台（Windows / macOS / Linux）**：PATH 袒底扩展到 POSIX —— macOS（Finder/Dock 启动）、Linux（桌面启动）被精简时自动补入存在的常见 npm 全局 bin（~/.npm-global/bin、~/.local/bin、/usr/local/bin、/opt/homebrew/bin 等）；POSIX 下 dsh 以 detached 启动，清理时对进程组 SIGTERM（kill(-pid)），子进程一起清理；CI 新增 ubuntu / macos / windows 三平台自测矩阵（node src/serverManager.js）。
  Cross-platform (Windows / macOS / Linux): PATH fallback extended to POSIX — macOS (Finder/Dock launch) and Linux (desktop launch) get the common npm-global bin dirs appended when missing (~/.npm-global/bin, ~/.local/bin, /usr/local/bin, /opt/homebrew/bin, existing dirs only); on POSIX dsh is spawned detached and cleanup SIGTERMs the whole process group (kill(-pid)) so worker children die too; CI gained a ubuntu/macos/windows self-test matrix (node src/serverManager.js).

- **向上/向下兼容（按 VS Code 开发者手册）**：显式声明 activationEvents（onView + 三条命令，不依赖自动生成）；extensionKind 固定为 workspace（远程场景扩展随工作区侧运行，DSH 进程与文件同侧）；capabilities 明确不支持不受信任工作区与虚拟工作区（扩展会启动本地进程并操作工作区文件）；容器/视图 ID（dsh-sidebar / dsh.webview）标注为持久化契约——升级时不可变更，否则用户侧边栏布局会丢失。
  Forward/backward compatibility per the VS Code developer docs: explicit activationEvents (onView + 3 commands, no reliance on auto-generation); extensionKind fixed to workspace (remote sessions run the extension on the workspace side so the DSH process and files stay on the same side); capabilities declare untrusted and virtual workspaces as unsupported (the extension spawns a local process and touches workspace files); container/view ids (dsh-sidebar / dsh.webview) documented as a persistent contract — never change them in a release or users lose their sidebar layout.

## [0.2.0] - 2026-08-14

### Added / 新增

- **侧边栏随工作区更新**：工作区文件夹增删或活动编辑器切换目录（多根工作区）时，侧边栏自动停止旧工作区的实例（仅限本扩展拉起的，复用实例不动）并按新 cwd 重新探测/拉起/渲染（rebindToWorkspace / scheduleRebind，见 src/extension.js）。
  Sidebar follows the workspace: on folder add/remove or active-editor moves to another root (multi-root), the sidebar stops the old workspace's owned instance and re-probes/re-spawns for the new cwd (rebindToWorkspace / scheduleRebind in src/extension.js).

### Changed / 变更

- **名称与图标**：扩展显示名改为 **DeepSeek Harness Sidebar (DSH)**，侧边栏标签改为 **DeepSeek Harness (DSH)**；图标换成 DeepSeek Harness 官方黑鲸鱼（media/dsh.svg 为官方 favicon 图形、currentColor 适配主题，media/dsh.png 为官方 logo 的 512x512 PNG）。
  Name & icon: display name is now **DeepSeek Harness Sidebar (DSH)**, sidebar tab label is **DeepSeek Harness (DSH)**; icons replaced with the official DeepSeek Harness black whale (media/dsh.svg = official favicon artwork, theme-adaptive currentColor; media/dsh.png = 512x512 PNG from the official logo).

- **README 精简**：只保留安装需求、使用/配置要点与实现说明（实现透明，便于其他 AI 发现 bug）。
  README slimmed down to install requirements, key usage/config and the implementation notes (transparency for AI bug-hunting).

[Unreleased]: https://github.com/Xizhi1024/dsh-vs-sidebar
[0.3.1]: https://github.com/Xizhi1024/dsh-vs-sidebar/releases/tag/v0.3.1
[0.3.0]: https://github.com/Xizhi1024/dsh-vs-sidebar/releases/tag/v0.3.0
[0.2.0]: https://github.com/Xizhi1024/dsh-vs-sidebar/releases/tag/v0.2.0
[0.1.0]: https://github.com/Xizhi1024/dsh-vs-sidebar/releases/tag/v0.1.0

### Added / 新增

- **辅助侧边栏嵌入**：以全屏 iframe 把本地 DeepSeek Harness (DSH) web UI 嵌入 VS Code 辅助侧边栏（secondarySidebar 容器，与 Copilot Chat 同处右侧栏）。
  Embed the local DeepSeek Harness (DSH) web UI via a full-bleed iframe inside the VS Code auxiliary sidebar (secondarySidebar container, same rail as Copilot Chat).

- **按工作区匹配实例**：实例注册表 `dsh-instances.json` 记录每个由扩展拉起的实例（pid/端口/cwd）；只复用 cwd 与本窗口工作区一致的实例，其余情况为本窗口拉起独立实例。
  Per-workspace instance matching: the `dsh-instances.json` registry records every instance the extension spawned (pid/port/cwd); only instances whose cwd matches the current workspace are reused, otherwise the window gets its own instance.

- **自动拉起 / 复用 dsh web**：端口探测（默认 `dsh.port`=3080）以响应体中的 `__DSH_BOOT__` 标记识别 DSH 实例；探测带重试（防止 DSH 繁忙时误判导致多开）；端口被占用时自动向后寻找空闲端口。
  Auto-start / reuse of dsh web: port probing (default `dsh.port`=3080) identifies a DSH instance by the `__DSH_BOOT__` marker in the response body; probes retry so a busy DSH is never misjudged as absent (which would spawn a duplicate instance); occupied ports are scanned forward for a free one.

- **cwd 绑定当前 VS Code 工作区**：以当前工作区作为 DSH 的工作区根（多根工作区优先活动编辑器所在目录）；未打开工作区时进程 cwd 空置（继承父进程目录，不回退用户主目录）。
  cwd bound to the current VS Code workspace: the workspace root becomes the DSH workspace root (in multi-root setups the active editor's folder wins); with no workspace open the spawned process cwd is left unset (inherits the parent's cwd, no fallback to the home directory).

- **Windows PATH 修复**：Windows 下从开始菜单/资源管理器启动 VS Code 时 PATH 常被截断，现自动把 npm 全局 bin 目录（`%APPDATA%\npm`）补进 PATH，确保能找到 `dsh` 命令。
  Windows PATH fix: VS Code launched from the Start menu/Explorer often gets a truncated PATH; the npm global bin dir (`%APPDATA%\npm`) is now appended if missing so the `dsh` command can be found.

- **远程场景支持**：WSL / Remote-SSH 下通过 `vscode.env.asExternalUri` 自动建立端口转发，侧边栏可访问远端 DSH web。
  Remote support: in WSL / Remote-SSH scenarios the extension uses `vscode.env.asExternalUri` to set up port forwarding so the sidebar can reach the remote DSH web.

- **三条命令与三项配置**：命令 `dsh.openInBrowser`（浏览器打开）、`dsh.restartServer`（重启本扩展启动的服务）、`dsh.focusSidebar`（聚焦侧栏）；配置 `dsh.port`、`dsh.host`、`dsh.autoStart`。
  Three commands and three settings: commands `dsh.openInBrowser`, `dsh.restartServer`, `dsh.focusSidebar`; settings `dsh.port`, `dsh.host`, `dsh.autoStart`.

- **安全的实例清理**：关闭 VS Code 时只清理本扩展自行启动的进程（Windows 用 `taskkill /T` 树级清理）；注册表清理只删除已死进程的条目，绝不杀死其他窗口复用的存活实例。
  Safe instance cleanup: on VS Code close only processes this extension spawned are stopped (tree-kill via `taskkill /T` on Windows); registry cleanup deletes only dead entries and never kills live instances reused by other windows.

[Unreleased]: https://github.com/Xizhi1024/dsh-vs-sidebar
[0.1.0]: https://github.com/Xizhi1024/dsh-vs-sidebar/releases/tag/v0.1.0
