# Changelog / 更新日志

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。
All notable changes to this project are documented here, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.3] - 2026-08-15

### Changed / 变更

- **VS Code 启动时自动拉起本机官方 DSH**：`dsh.autoStart=true` 现在默认自动发现 npm 全局安装的 `@deepseek-ai/dsh` 与 Node.js，不再要求预先下载托管 runtime；每次都以扩展专属的持久化 `.dsh` 和固定 `web` profile 启动。首次激活即创建 `.dsh`，官方 DSH 首次启动时用内置 `web` 模板生成仅含官方插件的默认配置，后续由用户维护并被扩展持续复用。非标准安装可用 `dsh.local.packageRoot` / `dsh.local.nodePath` 指定。
  Auto-start the local official DSH with VS Code: `dsh.autoStart=true` now discovers the globally installed npm `@deepseek-ai/dsh` and Node.js by default instead of requiring a pre-downloaded managed runtime. Every launch uses the extension-owned persistent `.dsh` and fixed `web` profile. The extension creates `.dsh` on first activation; official DSH seeds the first profile from its bundled official-only `web` template, after which the user maintains it and the extension keeps reusing it. Non-standard installs can use `dsh.local.packageRoot` / `dsh.local.nodePath`.

- **所有扩展入口统一使用 DeepSeek 官方标识**：Marketplace/扩展列表图标使用 DeepSeek 官网 `favicon.ico` 中鲸鱼的透明度遮罩二值化生成纯黑 PNG，Activity Bar、Secondary Sidebar 与编辑器标题栏使用同一鲸鱼轮廓的主题自适应 SVG；旧 DSH 虎鲸素材不再打包。
  Every extension entry now uses the DeepSeek brand mark: the Marketplace/extension-list icon is a pure-black PNG produced by binarizing the whale alpha mask from DeepSeek's official-site `favicon.ico`, while the Activity Bar, Secondary Sidebar, and editor-title actions use the same whale silhouette as a theme-aware SVG. The former DSH orca assets are no longer packaged.

- **编辑器标题栏只保留一个常驻 DSH 图标入口**：`editor/title` 仅注册 `dsh.focusSidebar` 一条（`navigation@40`），并为该命令配置 `media/deepseek.svg` 图标，因此标题栏只显示鲸鱼图标而不显示文字。`navigation` 组整体排在 VS Code 内置 `4_split`（拆分编辑器）组之前，使图标尽可能位于 Claude Code / Codex 等第三方图标之后、拆分编辑器按钮之前。
  Editor title bar keeps one persistent icon-only DSH entry: `editor/title` registers only `dsh.focusSidebar` (`navigation@40`) with the `media/deepseek.svg` icon, so the title bar shows just the whale icon and no text. The `navigation` group as a whole sorts before VS Code's built-in `4_split` (split editor) group, placing the icon as close as VS Code ordering permits after Claude Code / Codex third-party icons and before the split-editor button.

- **七个上下文命令不再占用任何标题栏**：`Add Active File` / `Add Active Selection` / `Add Problems` / `New Session` / `Switch Session` / `Capabilities and Integrations` / `Diagnose` 从 `view/title` 移除，仅保留在命令面板，不会再以长文本按钮铺在 DSH 视图顶部。点击 DSH 图标复用现有 `dsh.focusSidebar` 实现（打开并聚焦已有的 DSH 视图容器/视图，不创建重复视图）。
  The seven context commands no longer occupy any title bar: Add Active File / Add Active Selection / Add Problems / New Session / Switch Session / Capabilities and Integrations / Diagnose are removed from `view/title` and remain available from the command palette, so they cannot render as long text buttons above the DSH view. The DSH icon reuses the existing `dsh.focusSidebar` implementation, which reveals and focuses the existing DSH view container/view without creating duplicates.

### Fixed / 修复

- **F5 调试宿主不再永久停在“正在启动”**：健康检查改用有 3 秒超时和 5 MiB 上限的原始 TCP HTTP 探测，避开 VS Code F5 Extension Host 的 Node experimental network inspector 在 `node:http` 响应上反复抛出 `Missing dataLength in event`、导致 Promise 永不结束的问题；仍严格要求 HTTP 200 与 `__DSH_BOOT__` 标记。
  F5 debugging no longer remains on “Starting” forever: health checks now use a raw TCP HTTP probe bounded by a 3-second timeout and 5 MiB limit, avoiding the VS Code F5 Extension Host's Node experimental network inspector repeatedly throwing `Missing dataLength in event` on `node:http` responses and leaving the Promise unsettled. HTTP 200 plus the `__DSH_BOOT__` marker is still required.

- **README 顶部增加配置隔离/模块“消失”警告**：明确独立 DSH 的 `%USERPROFILE%\.dsh` 与扩展 global storage 下的 `.dsh` 默认互不继承；旧模块、skills、provider 配置、凭据和会话通常仍在旧目录，并给出迁移或 Windows Junction 绑定边界，避免把新官方空 profile 误判为数据丢失。
  Add a top-level configuration-isolation/module “disappearance” warning: standalone `%USERPROFILE%\.dsh` and the extension's global-storage `.dsh` do not inherit from each other by default. Old modules, skills, provider settings, credentials, and sessions usually remain in the old directory; the README now explains migration or Windows Junction binding so the fresh official-only profile is not mistaken for data loss.

## [0.4.2] - 2026-08-15

### Changed / 变更

- **编辑器标题栏只保留一个 DSH 图标入口**：`editor/title` 仅注册 `dsh.focusSidebar` 一条（`navigation@40`，仅 file/untitled 编辑器显示），并为该命令配置 `media/dsh.svg` 图标，因此标题栏只显示鲸鱼图标而不显示文字。`navigation` 组整体排在 VS Code 内置 `4_split`（拆分编辑器）组之前，所以图标位于 Claude Code / Codex 等第三方图标之后、拆分编辑器按钮之前。
  Editor title bar keeps a single icon-only DSH entry: `editor/title` registers only `dsh.focusSidebar` (`navigation@40`, file/untitled editors only) with the `media/dsh.svg` icon, so the title bar shows just the whale icon and no text. The `navigation` group as a whole sorts before VS Code's built-in `4_split` (split editor) group, placing the icon after Claude Code / Codex third-party icons and before the split-editor button.

- **七个上下文命令不再进入编辑器标题栏**：`Add Active File` / `Add Active Selection` / `Add Problems` / `New Session` / `Switch Session` / `Capabilities and Integrations` / `Diagnose` 只保留在 DSH 视图标题栏（`view/title`，`view == dsh.webview`）和命令面板，不会以长文本按钮的形式出现在编辑器标题栏。点击 DSH 图标复用现有 `dsh.focusSidebar` 实现（打开并聚焦已有的 DSH 视图容器/视图，不创建重复视图）。
  The seven context commands never enter the editor title bar: Add Active File / Add Active Selection / Add Problems / New Session / Switch Session / Capabilities and Integrations / Diagnose stay available only in the DSH view title bar (`view/title`, `view == dsh.webview`) and the command palette — never as long text buttons in the editor title bar. The DSH icon reuses the existing `dsh.focusSidebar` implementation, which reveals and focuses the existing DSH view container/view without creating duplicates.

## [0.4.1] - 2026-08-15

### Fixed / 修复

- **移除全局编辑器标题栏鲸鱼按钮（回退 PR #2 的 `editor/title` 注册）**：`dsh.focusSidebar` 不再出现在任意文件/untitled 编辑器的标题栏，DSH 操作按钮只注册在 DSH 自己的 `view/title`（`view == dsh.webview`），因此不会再泄漏到 Claude Code 等其他侧边栏/编辑器宿主。
  Remove the global editor-title whale button (revert PR #2's `editor/title` registration): `dsh.focusSidebar` no longer appears in every file/untitled editor title bar, and DSH actions are only contributed to DSH's own `view/title` (`view == dsh.webview`), so they cannot leak into other sidebar/editor hosts such as Claude Code.

- **托管运行时缺失时可复用已运行的 DSH 实例**：`dsh.autoStart=true` 且 managed runtime 解析/安装失败时，若配置端点（如浏览器已打开的 `http://127.0.0.1:3080`）探测为 DSH，扩展改为复用该外部实例并进入正常 iframe，而不是停在「请设置 dsh.runtime.manifestUrl」错误页；复用实例仍永不停止，也绝不回退 PATH 上的 `dsh`。
  Reuse a running DSH instance when the managed runtime is unavailable: with `dsh.autoStart=true`, if runtime resolution/provisioning fails but the configured endpoint (e.g. `http://127.0.0.1:3080` already open in a browser) probes as DSH, the extension adopts it as a reused external instance and shows the iframe instead of the `dsh.runtime.manifestUrl` error page; adopted instances are still never stopped, and there is still no PATH `dsh` fallback.

- **失败状态页的「在浏览器中打开」按钮可用**：连接失败后按钮真正打开配置端点（仅 http/https），无效 URL 不再渲染死按钮；`dsh.openInBrowser` 命令仍保持「未连接不打开」语义。
  Make the failed-status-page "Open in browser" button work: after a failed connect the button opens the configured endpoint (http/https only), invalid URLs no longer render a dead button, and the `dsh.openInBrowser` command keeps its no-connection guard.

## [0.4.0] - 2026-08-15

> 本节内容已随 0.4.0 发布；其中编辑器标题栏鲸鱼按钮已在 0.4.1 回退。
> This section shipped with 0.4.0; the editor-title whale button was reverted in 0.4.1.

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

- **命令与验证基线**：命令面板共 11 条命令；单元测试 123 pass / 0 fail / 1 skip；Extension Host 激活 smoke 默认在 VS Code 1.106 运行（`secondarySidebar` 贡献点自该版本起受支持）。
  Command & verification baseline: 11 commands in the command palette; unit tests 123 pass / 0 fail / 1 skip; the Extension Host activation smoke runs on VS Code 1.106 by default (`secondarySidebar` is supported from that version onward).

- **密钥扫描门禁（W6-4/W6-5 本地部分）**：新增 `scripts/check-secrets.js` 与 `npm run test:secrets`，扫描将进入 VSIX 的源码/文档（不扫 `node_modules`、`.git`、`.vscode-test`），检测硬编码 DSH 桥接 token 字面量、`Authorization: Bearer` 凭据、OpenAI/AWS key、私钥与密码字面量；示例/测试 fixture 使用显式 `// allow-secret-scan` 注释放行；`check:w0` 末尾纳入该门禁。
  Secret-scan gate (local part of W6-4/W6-5): add `scripts/check-secrets.js` and `npm run test:secrets` to scan the source/docs that will enter the VSIX (never `node_modules`, `.git`, or `.vscode-test`), detecting hardcoded DSH bridge token literals, `Authorization: Bearer` credentials, OpenAI/AWS keys, private keys, and password literals; example/test fixtures are released with an explicit `// allow-secret-scan` comment; `check:w0` now runs this gate.

- **自管实例自动绑定工作区（PR #2）**：扩展自管（owned）DSH 实例启动后自动通过 `ensureWorkspaceSession` 复用/创建当前工作区 cwd 的 blank 根会话，iframe 携带 `dsh_session` 打开正确工作区；reused 外部实例绝不触碰。绑定失败/超时仅跳过，不影响连接。
  Owned-instance workspace auto-binding (PR #2): after an owned DSH instance starts, the extension auto-reuses/creates a blank root session for the current workspace cwd via `ensureWorkspaceSession` and passes `dsh_session` to the iframe; reused external instances are never touched, and binding failures/timeouts only skip the binding.

- **同进程 fresh-origin 端口（PR #2）**：同一 `ServerManager` 实例每次 spawn 都从上次使用端口之后扫描，确保每次启动使用全新 origin，避免 DSH 按 origin 缓存旧工作区；跨 VS Code 重启仍优先配置端口。
  Same-process fresh-origin ports (PR #2): each spawn in the same `ServerManager` scans from after the previously used port, giving every launch a fresh origin so DSH does not cache the previous workspace under one origin; across VS Code restarts the configured port is still preferred.

### Changed / 变更

- **测试入口标准化**：`ServerManager` 的内嵌自测迁移到 `node:test`，由 `npm test` 在本地和三平台 CI 运行；运行时代码不再包含直接执行分支。
  Standardize tests: move the embedded `ServerManager` self-test to `node:test`, run it through `npm test` locally and in the three-platform CI matrix, and remove the direct-execution branch from runtime code.

- **W0 回归骨架**：新增可注入 VS Code facade、Webview 消息路由、持久化 ID、生命周期、工作区单元门禁；CI 同时校验 VSIX 文件清单并运行真实 Extension Host 激活 smoke。
  W0 regression foundation: add unit gates for the injectable VS Code facade, Webview routing, persistent IDs, lifecycle, and workspace behavior; CI also checks the VSIX file list and runs a real Extension Host activation smoke.

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

- **Webview 外壳 CSP 与嵌入 URL 白名单**：status/frame 两页均加入 CSP meta（`default-src 'none'`，iframe 仅允许 `http:`/`https:`）；`withVscodeEmbedMode` 拒绝 `javascript:`、`data:` 等非 http(s) scheme，不再把这类 URL 追加嵌入参数。
  Webview shell CSP and embed URL whitelist: both generated pages now carry a CSP meta (`default-src 'none'`, iframe restricted to `http:`/`https:`); `withVscodeEmbedMode` rejects non-http(s) schemes such as `javascript:` or `data:` instead of appending embed parameters.

- **关停路径加固**：扩展停用会 abort 仍在进行的 runtime provisioning（不触碰已就绪的 owned 子进程）；Windows `taskkill` 增加 5s 超时兜底，避免停止/退出被挂起的 taskkill 永久阻塞。
  Shutdown hardening: deactivation aborts in-flight runtime provisioning (never touching a ready owned child); Windows `taskkill` gains a 5s timeout so a stuck killer cannot block stop/deactivation forever.

- **Runtime 版本号白名单**：`dshVersion` 统一限制为 1–64 位字母数字与 `._+-`，解析 manifest 与读取 current/last-good 指针时都先校验，杜绝版本串参与 `path.join` 时的路径穿越纵深缺口。
  Runtime version whitelist: `dshVersion` is restricted to 1–64 alphanumeric/`._+-` characters and validated in both manifest parsing and current/last-good pointer reads, closing the defense-in-depth gap where a version string feeds `path.join`.

- **openInBrowser 失败保护**：连接失败时该命令改为显示 `DSH: unavailable`，不再打开一个必定的死 fallback URL。
  openInBrowser failure guard: after a failed connect the command now shows `DSH: unavailable` instead of opening the guaranteed-dead fallback URL.

- **移除未接线的 PATH 修复**：删除从未被调用的 `runtimeEnvironment.js`（`ensureDshOnPath`）及其测试与文档条目；`autoStart=false` 只复用端点、从不 spawn，因此该代码无实际作用。
  Remove the unwired PATH helper: delete the never-called `runtimeEnvironment.js` (`ensureDshOnPath`) plus its tests and doc entries; `autoStart=false` only reuses an endpoint and never spawns, so the helper had no effect.

- **Rollback 恢复闭环**：无 `last-good.json` 时 rollback 改为移除 `current.json`（首次 promote 失败也能恢复）；promote 后 `resolveCurrent()` 失败会自动 best-effort rollback 并保留原始错误，下次带 `manifestUrl` 启动可重新 provision。
  Rollback recovery loop: with no `last-good.json`, rollback removes `current.json` so even a failed first promote can recover; a failed `resolveCurrent()` right after promote now triggers a best-effort rollback while preserving the original error, letting the next manifest-URL run provision again.

- **Text-document 桥 realpath 门禁**：工作区包含判断改用 realpath（候选文件不存在时解析父目录），防止工作区内的符号链接/目录联接把 DSH 指向工作区外文件。
  Text-document bridge realpath gate: workspace containment now resolves realpaths (or the parent dir for not-yet-existing files), so a symlink/junction inside the workspace can no longer point DSH at files outside it.

- **Rollback 跨窗口保护**：`RuntimeInstaller.rollback()` 只在当前指针仍是本次 promote 的候选时回滚/删除；`last-good.json` 损坏时 best-effort 移除 `current.json`，并给 `cleanup()` 补上 `dshVersion` 白名单。
  Cross-window rollback guard: `RuntimeInstaller.rollback()` only rolls back when the current pointer still matches the candidate this installer promoted; a corrupt `last-good.json` best-effort removes `current.json`, and `cleanup()` now enforces the `dshVersion` whitelist.

- **Webview URL 无效输入硬化**：无法解析 / 非 http(s) / 协议相对的嵌入 URL 统一返回 `about:blank`；frame fallback 链接同样安全化；statusPage 的 openBrowser 消息仅在确有可用 server 时打开浏览器。
  Webview invalid-URL hardening: unparseable, non-http(s), and protocol-relative embed URLs become `about:blank`; the frame fallback link is sanitized the same way, and the statusPage openBrowser message only opens a browser when a usable server exists.

- **taskkill 超时二次树杀**：Windows 停止服务时若 taskkill 挂起，超时后补发 detached `taskkill /T /F` 并放行退出；`onStatus('error')` 即使无 message 也清空残留状态。
  taskkill timeout retry: on Windows a hung taskkill is followed by a detached `taskkill /T /F` retry and stop() proceeds; `onStatus('error')` now clears stale state even without a message.

- **发布卫生**：installed-smoke 固定到 VS Code 1.106；publish workflow 的 marketplace token 改为 step 级 env 注入（不再出现在命令行参数）；`.agents/` 加入 `.gitignore`；移除 CHANGELOG 中已删除的 PATH 门禁表述。
  Release hygiene: the installed-smoke targets VS Code 1.106; marketplace tokens are injected via step-level env (no longer command-line arguments); `.agents/` is gitignored; stale PATH-gate wording removed from the changelog.

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

[0.4.2]: https://github.com/Xizhi1024/dsh-vs-sidebar/releases/tag/v0.4.2
[0.4.1]: https://github.com/Xizhi1024/dsh-vs-sidebar/releases/tag/v0.4.1
[0.4.0]: https://github.com/Xizhi1024/dsh-vs-sidebar/releases/tag/v0.4.0
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

