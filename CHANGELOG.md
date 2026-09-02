# Changelog / 更新日志

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。
All notable changes to this project are documented here, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-09-02

> ⚠️ **迁移提示 / Migration note（F-d，Codex 对齐）**：`vscode/changes/push` 改为**直写**——扩展自设的审批弹窗（Allow Once/Session/Reject）与工作区边界拒绝已**删除**；哪条路径可写、要不要批，由 DSH 沙箱单源决定（read-only / workspace-write / full-access 三档在 DSH 侧）。安全网 = 落盘前类型化校验（结构 + 活文档坐标范围）+ journal before-快照 + 变更树文件级 **Undo**（快照整文件还原）——人是 Reviewer，不是守门员。过渡期早前构建产生的 pending 条目仍可在树上 Accept/丢弃；1.0.x 旧条目以 legacy 标记显示。
> `vscode/changes/push` is now a **direct write** channel: the extension-side approval modal (Allow Once/Session/Reject) and the workspace-boundary rejection are REMOVED - which paths are writable and whether to approve is single-sourced from the DSH sandbox (its read-only / workspace-write / full-access tiers). The safety net is typed validation before landing (structure + live-document ranges), a before-snapshot in the journal, and file-level **Undo** in the changes tree (whole-file snapshot restore) - humans are reviewers, not gatekeepers. Pending entries from interim builds remain Accept/discard-able in the tree; 1.0.x entries render with a legacy marker.

### Added / 新增

- **全源变更追踪（journal v2 + watcher 兜底 + 工具拦截观测）**：变更树三分组——经桥编辑 / DSH 工具写入 / 外部变更。DSH 侧 `tools/pre-execute` waterfall 观测 edit/write 工具调用（只归因不拦截，`dsh.changes.observe-tools` 默认开），经桥通知 `vscode/dshEditObserved` 入 journal；FileSystemWatcher 兜底捕获一切不经桥的落盘（500ms 去抖、watcherExclude 尊重、>20 事件/s 熔断降级 git 轮询、快照可回滚）；外部条目 Undo 走快照还原或确认后 git checkout。
  Full-source change tracking: the tree groups entries into via-bridge edits / DSH tool writes / external changes. The DSH-side tools/pre-execute waterfall observes edit/write calls (attribution only, never gating; dsh.changes.observe-tools defaults on) and notifies vscode/dshEditObserved into the journal; a FileSystemWatcher fallback captures every on-disk write that bypassed both (500ms debounce, watcherExclude respected, >20 events/s circuit breaker degrading to git polling, snapshot-backed undo); external entries undo via snapshot restore or, after confirmation, git checkout.
- **MCP env 密钥联动 secretStorage**：MCP server 需要 env 密钥时先查 VS Code secretStorage 同名 key，命中免问；key 名含 KEY/TOKEN/SECRET 时输入框密码化，问完回存。
  MCP env secrets now check VS Code secretStorage first (same-name key skips the prompt); secret-looking keys prompt with password masking and are stored back into secretStorage.
- **调试器断点桥（D1，#8）**：v3 方法表 32→35——`vscode/debug/listBreakpoints|addBreakpoints|removeBreakpoints` 全部走官方 `vscode.debug` API（breakpoints / addBreakpoints / removeBreakpoints + SourceBreakpoint 构造；不使用 customRequest('setBreakpoints') 的替换语义，避免绕过 UI 断点簿记）；桥侧 1-based 行列与 0-based API 位置在边界转换；批量上限 50；remove 支持 uri（±line）匹配或 all:true。
  Debugger breakpoint bridge (D1, #8): the v3 method table grows 32->35 - vscode/debug/listBreakpoints|addBreakpoints|removeBreakpoints on the official vscode.debug API only (no customRequest setBreakpoints replace semantics); 1-based wire lines/columns convert to 0-based API positions at the boundary; batch cap 50; remove matches by uri (plus optional line) or all:true.
- **回复路径 linkify**：聊天消息里的 `file:///...` 与工作区相对路径（含 `:line`）可点击，经 text-document 桥在本窗口打开。
  Clickable file links in chat replies: `file:///...` and workspace-relative paths (with `:line`) open in the current window via the text-document bridge.
- **主视图入口三层**：视图标题栏"在编辑器中打开"图标 + 编辑器标题栏 DSH 图标 + `Ctrl+Alt+N` 新实例（`dsh.multiInstance.entry` 默认开）。
  Three entries to the main view: view-title open-in-editor icon, editor-title DSH icon, and `Ctrl+Alt+N` for a new instance (`dsh.multiInstance.entry` defaults on).
- **Diagnose 改版（D2）**：分区 QuickPick（服务/桥/兼容性/插件/警报）取代单条巨型消息；启动错误码→人话+建议动作（经 STARTUP_ERRORS 分类表：文本+提示+可重试性），警报带一键动作（重启 DSH / 重载窗口 / 打开终端默认配置）；完整 JSON 报告写入 DSH OutputChannel；兑现 README 兼容性承诺——默认终端为 WSL shell 时告警（仅 win32）。
  Diagnose redesign (D2): a sectioned QuickPick (service / bridge / compat / plugins / alerts) replaces the single mega-toast; startup error codes humanize through the STARTUP_ERRORS taxonomy (text + hint + retryability) with one-click actions (restart DSH, reload window, open the terminal profile setting); the full JSON report goes to the DSH OutputChannel; the README compatibility promise is honoured - a WSL default terminal warns on win32.
- **Onboarding 改版（D3）**：profile 步零输入优先——探测 DSH home 下已有 profiles 即下拉选择（当前项置顶标记），"新名称"项回退校验输入框，无可探测时维持原输入框；功能开关步骤全量补充描述（B5 ctrl-k 描述保留）；新增 Tab 补全可选配置屏（端点下拉：DeepSeek / 自定义 http(s) 校验 / 跳过 + API key 直存 secretStorage + 重启提示，三并一），仅在 tab-completion 开关启用后出现且不占步骤编号。
  Onboarding redesign (D3): the profile step is zero-typing first - detected profiles become a QuickPick (current first, marked), the new-name entry falls back to the validated InputBox; every feature switch gains a description (B5 ctrl-k wording kept); a new optional Tab-completion screen (endpoint dropdown: DeepSeek / custom with http(s) validation / skip + API key straight into secretStorage + restart hint, three-in-one) appears only when the switch ends up enabled, without consuming a step number.

### Fixed / 修复

- **终端回读**：桥创建的终端在宿主暴露该提案时订阅 `onDidWriteTerminalData`（proposed API，try/catch 安全探测——未启用提案的宿主上属性访问本身会抛 "CANNOT use API proposal"，曾致激活失败）写入 ring buffer；`sendText` 后的输出可被 read 读回；提案不可用的宿主优雅降级为仅 sendText 回显。
  Terminal readback: bridged terminals subscribe to `onDidWriteTerminalData` (a proposed API, probed safely — on hosts without the proposal the property access itself throws "CANNOT use API proposal", which once broke activation) into the ring buffer when available; hosts without the proposal degrade gracefully to the sendText echo only.
- **dshVersion 探测**：本地 DSH 包 version 读取的失败路径补全，兼容性 WARN 消除，theme/toolsV3 门控恢复正确。
  dshVersion probing: local DSH package version read failure paths fixed — no more unknown compatibility WARN, theme/toolsV3 gating restored.
- **MCP forget**：改为下拉选择 consent 记录（零输入），并修复 forget 后复调不再询问 consent 的 bug。
  MCP forget: now a QuickPick over consent records (zero typing), fixing the bug where a post-forget invocation was not re-prompted for consent.
- **@dsh 参与者会话治理（B2，#4）**：会话复用改为 sticky——绑定工作区**最近更新的根会话**（子代理/子会话排除；sessionIds 或同 cwd 成员判定），窗口重载/服务器重启/重绑不再繁殖会话（3 条消息 0 新会话）；`dsh.newSession`/`dsh.switchSession` 现在同步 pin 绑定缓存，@dsh 提示词跟随用户正在看的会话；会话标题经官方 `session.rename` 从首条 prompt 派生（首行、控制字符剥离、空白折叠、60 码点截断、每会话一次），API 创建的会话不再以裸 UUID 示人。（"session-session-" 双前缀为 DSH 运行时导出命名问题，已在运行时热修待上游。）
  @dsh participant session hygiene (B2, #4): session reuse is sticky - the binding re-uses the workspace's most recently updated ROOT session (subagent/child excluded), so reloads/restarts/rebinds stop multiplying sessions (3 messages -> 0 new); dsh.newSession/dsh.switchSession now pin the binding cache so @dsh follows the session the user is looking at; session titles derive from the first prompt via the official session.rename (first line, control-strip, whitespace collapse, 60-codepoint cap, once per session) - API-created sessions stop showing bare UUIDs. (The session-session- double prefix was a DSH runtime export-naming bug, hot-fixed locally pending upstream.)
- **findFiles 防护**：桥 handler 加 5s 超时 + 默认 exclude（node_modules/.git/dist/out），超时返回带提示的空结果。
  findFiles guard: 5s timeout + default excludes (node_modules/.git/dist/out); timeouts return an empty result with a hint.
- **undo 反向区间**：已接受条目的 undo 改用快照整文件替换式 WorkspaceEdit，规避多 edit 行号漂移导致的拒绝。
  Undo for accepted entries now uses whole-file snapshot replacement WorkspaceEdits, avoiding rejections from range drift across multiple edits.
- **服务重启端口抢跑（F-f）**：`stop()` 杀掉子进程后有界等待（100ms 轮询、上限 3s）旧端口显式拒绝连接，再进入探测/扫描——杜绝旧 listener 未释放导致的端口悄悄漂移（+1）或新子进程 bind 竞争偶发早退。
  Restart port race (F-f): stop() now waits (bounded: 100ms polls, 3s cap) for the old port to explicitly refuse connections before the next probe/scan - no more silent port+1 drift or sporadic bind-race early exits from a dying listener.
- **会话列表标题键名（B2 后续，实测发现）**：现行 DSH 运行时 session.list 投影的标题键是 `projections.values.title`（纯字符串；旧版为 `sessionTitle.title` 包装）——扩展此前只读旧形状，**所有运行时已命名的会话在侧边栏/切换列表/followups 仍显示裸 UUID**。现双形状兼容（现行优先）。另实证：部分行的投影列在运行时侧 fail-soft 缺失（history 里标题存在而 list 行为 null），该场景回退 id 显示，待上游修复。
  Session-list title key mismatch (B2 follow-up, found live): the current DSH runtime emits the title as a plain `projections.values.title` string (older builds wrapped it as `sessionTitle.title`); reading only the legacy shape made every runtime-titled session still render as a bare UUID in the sidebar/switch list/followups. Both shapes are now accepted (current first). Also verified live: some rows serve without the projection column at all (title exists in history but the list row is null - runtime fail-soft); those fall back to the bare id pending an upstream fix.
- **F5 写入失败（实测定位：HMR 热重载窗口打崩工具调用）**：F5 激活时 `installDshIntegration` 把全部插件文件（含未变更者）重写入共享 DSH home，经 symlink+cordis-plugin-hmr 触发热重载——**重载窗口期内所有工具调用（含 run_code）报 `Cannot read properties of undefined (reading 'kind')`**，窗口过后自愈（已实测验证）。同步改为内容感知：字节一致即跳过（返回 copied/skipped 计数），真实变更照常落盘重载。上游问题：热重载窗口期在途工具调用崩溃，待报 dsh 仓库。
  F5 write failures (found live: the HMR reload window breaks tool calls): F5 activation rewrote every integration plugin file - unchanged ones included - into the shared DSH home, and the symlinked profile's cordis-plugin-hmr reloaded; during the reload window every tool call (run_code included) failed with "Cannot read properties of undefined (reading 'kind')" and recovered afterwards (verified live). The sync is now content-aware: bytes-identical destinations are skipped (copied/skipped counts returned); real changes still land and reload as before. Upstream: in-flight tool calls crashing during the HMR window - to be reported to the dsh repo.

### Changed / 变更

- **状态栏可点击**（toggle 侧边栏）+ 实际端口 ≠ 配置端口时 tooltip 标注；设置变更（`dsh.fim.*`/`features.*`/`bridge.*`）弹 "Restart now?" 提示。
  Clickable status bar item (toggles the sidebar) with the actual port annotated in the tooltip on conflict downgrade; setting changes now offer a "Restart now?" prompt.
- **Ctrl+L 默认开启**（仅加草稿不发送）；Ctrl+K 保持 opt-in，onboarding 提供一键启用项。
  Ctrl+L defaults on (add draft only, low risk); Ctrl+K stays opt-in with a one-click enable item in onboarding.

## [1.0.2] - 2026-08-28

### Fixed / 修复

- **FIM 路由从未被同步进 DSH home（1.0.1 回归）**：`src/dshIntegration.js` 的 `INTEGRATION_FILES` 清单漏列 `lib/fimRoutes.js`——扩展每次激活同步插件时永远不带这个文件，DSH 侧 `/api/fim` 路由无从挂载，Tab 补全服务端形同虚设。现已加入清单，并在升级后首次激活时自动补齐运行副本。
  The plugin sync list omitted `lib/fimRoutes.js`, so the DSH-side `/api/fim` route never materialized; the file list now includes it and the running copy self-heals on the next activation.

## [1.0.1] - 2026-08-28

### Added / 新增

- **FIM Tab 补全服务端补齐（`/api/fim`）**：此前 tab-completion 只有扩展侧客户端——每次补全请求打到 DSH 后 404 静默返回空。1.0.1 在 DSH 侧 `dsh-vscode-integration` 插件内实现 `POST /api/fim`：Bearer 桥令牌鉴权（timing-safe）、调用 OpenAI 兼容 completions 上游（DeepSeek-Coder FIM 模板，可用 `DSH_FIM_TEMPLATE` 覆盖）、流式增量以客户端约定的 `data: {"text":...}` + `[DONE]` 帧回传、8s 上游超时、全程故障围栏（WebRoute 内异常绝不逃逸）。
  FIM tab completion previously shipped a client only — every request 404'd silently. 1.0.1 implements the missing `POST /api/fim` inside the DSH-side integration plugin: timing-safe bearer auth, an OpenAI-compatible completions upstream (DeepSeek-Coder FIM template, overridable via `DSH_FIM_TEMPLATE`), streamed deltas re-emitted in the client's `data: {"text":...}` + `[DONE]` frame format, an 8s upstream timeout, and full fault containment.
- **新设置 `dsh.fim.baseUrl`**（machine scope）：上游 FIM 端点完整 URL，与 `Set DSH FIM API Key`（secretStorage）一起经 spawn env 注入（`DSH_FIM_BASE_URL`/`DSH_FIM_API_KEY`）；两者齐备并重启 DSH 服务后 Tab 补全真正可用，缺失时 `/api/fim` 返回带指引的 503。
  New `dsh.fim.baseUrl` setting (machine scope): full upstream FIM endpoint URL, injected alongside the secretStorage API key into the DSH spawn env; tab completion becomes actually usable once both are set and the DSH server restarted, otherwise /api/fim answers a guided 503.

### Changed / 变更

- **README 精简为产品视角**：一句话定位 + 能力 bullet + 兼容性 + 安装 + 使用 + 配置表，删除全部面向开发者的长文（交互保证/隔离模式/桥接矩阵/exports/错误码/FAQ/实现原理）。
  READMEs slimmed to a product-first structure: one-line pitch, capability bullets, compatibility, install, usage, and the config table; all developer-facing long-form sections removed.

## [1.0.0] - 2026-08-28

合并 0.9.4（视图修复 + 推荐预设 + README 展示优先重构）与 feature/1.0.0（启动与自愈大改），版本统一为 1.0.0。
Merges 0.9.4 (view fix + recommended preset + showcase-first READMEs) with feature/1.0.0 (launch & self-healing overhaul); unified version 1.0.0.

### Fixed / 修复

- **--no-open 按运行时版本门控**：低于 0.1.0-rc.7 的 DSH 运行时不再因未知旗标导致托管启动必死；仍拒绝该旗标的老运行时会自动去掉它重试（serverNoOpenSelfHeal）。
  `--no-open` is now gated on the runtime version; older runtimes that still reject the flag retry without it automatically.
- （继承 0.9.4）`dsh.changes` 视图「无数据提供程序」占位错误：`when` 可见性门控 + L0 常驻 fallback provider。
  (from 0.9.4) the `dsh.changes` "no registered data provider" placeholder: `when` visibility gate + an always-registered L0 fallback provider.

### Added / 新增

- **Windows 发现范围扩大**：自动发现新增 PATH shim 扫描（`dsh.cmd` / `dsh.ps1`）与 pnpm/yarn 全局目录（`shimResolver` / `processDiscovery`）。
  Windows discovery now scans PATH shims (`dsh.cmd` / `dsh.ps1`) and pnpm/yarn global directories.
- **可配置启动**：新设置 `dsh.executablePath`（包目录、`lib/bin.js` 或 Windows shim 文件，优先于自动发现）与启动方式解析（`launchMethodResolver`）。
  Configurable launch: new `dsh.executablePath` setting (package dir, `lib/bin.js`, or a Windows shim; takes precedence over discovery) plus a launch-method resolver.
- **连接看门狗**：侧栏连接后持续监测服务端点；失联（崩溃、休眠唤醒、端口被占）时显示连接丢失页并支持一键重试，不再留死白框。
  Connection watchdog: the service endpoint is monitored once the sidebar connects; on loss the sidebar shows a reconnect page instead of a dead frame.
- **更智能的复用**：配置端口静默但其它端口已有 `dsh web` 在跑时自动复用。
  Smarter reuse: a silent configured port falls back to an already-running `dsh web` on another port.
- （继承 0.9.4）推荐预设：`dsh.features.changes-review` 与 `dsh.features.chat-participant` 默认开启。
  (from 0.9.4) recommended preset: changes-review and @dsh chat-participant default to on.

### Changed / 变更

- （继承 0.9.4）README 重构为功能展示优先（功能亮点 / 五分钟上手 / 面向开发者分隔）；内部实现笔记与规划文档移出仓库。
  (from 0.9.4) READMEs restructured showcase-first; internal impl notes and planning docs removed from the repository.

## [0.9.4] - 2026-08-27

### Fixed / 修复

- **`dsh.changes` 视图报「没有可提供视图数据的已注册数据提供程序」**：该 tree 视图在 `package.json` 中无条件声明，但数据提供程序只在 `dsh.features.changes-review` 开启时挂载，默认配置下每个用户都会看到 VS Code 的占位错误。现在 ① 视图加了 `when: config.dsh.features.changes-review` 可见性门控；② L0 阶段始终注册一个空 fallback provider，即使部分激活失败也不再出现占位错误（changes-review 开启时真 provider 重新注册并取代 fallback）。
  The `dsh.changes` tree view was declared unconditionally in `package.json` but its data provider was only mounted when `dsh.features.changes-review` was on, so every default install showed VS Code's "no registered data provider" placeholder. Now (1) the view carries a `when: config.dsh.features.changes-review` visibility gate and (2) an empty fallback provider is always registered at L0, so a partially failed activation never renders the placeholder either (the real provider re-registers and supersedes the fallback when changes-review is on).

### Changed / 变更

- **推荐预设：两个安全的 L2 特性默认开启**——`dsh.features.changes-review`（DSH 变更评审：每次写文件前仍需显式审批）与 `dsh.features.chat-participant`（@dsh 聊天参与者：只消费 DSH 会话，绝不使用 Copilot 配额）自 0.9.4 起默认 `true`，首装用户 5 分钟内即可体验变更评审树与 @dsh 流式对话。显式设为 `false` 的用户不受影响；onboarding 向导的预勾选改用目录真实默认值（顺带修复了向导把未显式设置的开关一律视为开启的旧问题）。
  Recommended preset: two safe L2 features now default to on — `dsh.features.changes-review` (every file write still needs explicit approval) and `dsh.features.chat-participant` (DSH sessions only, never Copilot quota). Existing users who explicitly set them to false are unaffected; the onboarding wizard now pre-picks real catalog defaults (also fixing the old bug that treated every unset switch as on).

- **README 重构为「功能展示优先」**：两份 README 顶部新增功能亮点（开箱即用 / 推荐开启 / 高级可选三档）、五分钟上手与 Marketplace 安装入口，原实现细节章节整体移入「面向开发者」分隔线下；同时修复中文版使用章节三条 bullet 重复的旧问题。
  READMEs restructured showcase-first: a features section (out of the box / recommended / advanced), a 5-minute quick start, and Marketplace install now lead both READMEs, with the implementation details moved under a "For developers" divider; a pre-existing triple-bullet duplication in the Chinese usage section was also fixed.

## [0.9.3] - 2026-08-20

### Fixed / 修复

- **工作区切换后侧栏不跟随（dsh_session 无消费方）**：扩展端早已通过工作区注册表把新 VS Code 工作区重绑到对应 DSH 会话，并以 `?dsh_session=<id>` 重新加载侧栏 iframe；但 DSH Web 端启动时恢复的是**自己持久化的当前会话**，官方客户端没有任何代码消费 `dsh_session` 参数——于是切工作区后侧栏仍停留在旧工作区的对话。与 0.9.0 主题跟随（issue #4）同病：扩展端就绪、DSH 端消费方缺失。现于 `dsh-vscode-integration/client.js` 新增会话跟随消费方：等目标会话进入 sessions 列表镜像（异步加载，100ms 轮询上限 5s）后经 `sessions.open()` 切换——与用户点击会话行完全同路径；目标已是当前会话则不动、无参数/旧版 DSH 无 `sessions.open` 时静默降级、effect dispose 即停。已加 6 项回归测试（出现即切、无参不动、已是当前不重开、dispose 后不再导航、旧版降级、无 sessions 服务不抛错）。
  Workspace switch left the sidebar behind (no dsh_session consumer): the extension side already rebound the new VS Code workspace through the workspace registry and reloaded the sidebar iframe with `?dsh_session=<id>`; but the DSH web app restores its own persisted current session on boot and no official client consumed the param — so after switching workspaces the sidebar kept showing the previous workspace's conversation. Same disease as the 0.9.0 theme-follow fix (issue #4): extension side ready, DSH-side consumer missing. `dsh-vscode-integration/client.js` now ships a session-follow consumer that waits for the target session to enter the sessions list mirror (async load; 100ms polling, 5s cap) and switches via `sessions.open()` — the exact path of a user click on the session row. No-ops when the target is already current; degrades silently without the param or on older builds lacking `sessions.open`; disposal stops the loop. Six regression tests cover the matrix.

## [0.9.2] - 2026-08-20

### Fixed / 修复

- **启动即自动打开系统浏览器**：DSH 运行时（dsh-web-app ≥ 0.1.0-rc.7）默认在 Web 服务就绪后把 URL 移交给系统默认浏览器。扩展此前托管的每次拉起（auto-start、侧栏连接、重启、干净重启）都没传 `--no-open`，因此 VS Code 里嵌着侧栏的同时还会弹出一个浏览器页面。现在 `buildManagedLaunchSpec` 在所有托管启动参数末尾固定追加 `--no-open`——嵌入的侧栏就是 UI，无需浏览器交接。已加回归测试（普通与 --patch 两种 spawn 都必须恰含一个 `--no-open`）。
  Startup no longer opens a system browser: the DSH runtime (dsh-web-app >= 0.1.0-rc.7) defaults to handing the Web URL to the default browser once the server is ready, and the extension's managed spawns never passed `--no-open`, so launching the sidebar also popped a browser page. `buildManagedLaunchSpec` now appends `--no-open` to every managed launch — the embedded sidebar IS the UI. Regression tests cover both plain and `--patch` spawns.

## [0.9.1] - 2026-08-20

### Fixed / 修复

- **发布包泄漏内部计划文档**：0.9.0 的 VSIX 意外带入了 `planning/0.7/` 两份内部编排文档；内部实现笔记（B0–B4）、QA findings 与批次计划现统一移至 `docs/dev/`，并以深度通配加固 `.vscodeignore`（`**/planning/**`、`**/*_IMPL_NOTES.md` 等），发布包复验零泄漏（92 文件）。
  Release-package hygiene: the 0.9.0 VSIX accidentally shipped the internal `planning/0.7/` documents. Implementation notes, QA findings and batch planning now live under `docs/dev/`, with hardened `.vscodeignore` depth globs; the repackaged VSIX is verified leak-free (92 files).

- **文档整理**：`KNOWN_ISSUES.md` 重写为当前状态索引（4 个历史问题均已修复，附 0.9.0 剪贴板/主题修复的验收提示）；两份 README 的陈旧 0.6 版本引用全部更新，交互保证补充原生 ⌘C/⌘X/⌘V 与主题跟随，Implementation 章节新增仓库结构说明。
  Documentation tidy-up: `KNOWN_ISSUES.md` rewritten as a current-state index (all four historical issues fixed, with verification notes); stale 0.6 references refreshed across both READMEs, the interaction guarantee now covers native ⌘C/⌘X/⌘V and theme-follow, and the Implementation section documents the repository layout.

- **README 能力矩阵与实现对齐**：桥接能力表此前仍把终端/任务/调试/Git/搜索/UI 标为「尚未暴露」，而 v3 桥实际已实现并按同意开关交付。两份 README 重写为三段式——常开只读方法表、`dsh.bridge.*`/`dsh.features.*` 同意开关后的 v3 能力族表（terminal、ui、editorRead、changes-review、mcp、call-export、tasks/debug、git 读取）、以及仅剩的真实未实现项（applyEdit、断点/单步、Git 写）；Usage 补模型路由 / MCP 消费 / 变更评审条目，配置表补 `dsh.features.call-export`，onboarding 撤销「后续版本提供」陈旧声明，路线图收敛为剩余工作。
  README capability matrix aligned with the implementation: the bridge tables previously listed terminals/tasks/debug/Git/search/UI as "not exposed" although the v3 bridge already ships them behind consent switches. Both READMEs now carry a three-part matrix — always-on read-only methods, the consent-gated v3 families (terminal, ui, editorRead, changes-review, mcp, call-export, tasks/debug, git read), and the genuinely remaining gaps (applyEdit, breakpoints/stepping, git writes); Usage gains model-routing / MCP / changes-review entries, the configuration table documents `dsh.features.call-export`, the onboarding copy drops the stale "coming later" wording, and the roadmap shrinks to the actual remainder.

## [0.9.0] - 2026-08-20

0.7/0.8 为过渡性内部构建未单独立档，本条目汇总 0.6.0 以来的全部用户可见变更。
0.7/0.8 were interim internal builds without their own entries; this entry consolidates all user-visible changes since 0.6.0.

### Added / 新增

- **MCP 服务器消费（L2，默认关闭）**：`dsh.features.mcp-consume` 汇入 DSH 配置中的 MCP 服务器——stdio/HTTP 双传输、零依赖 JSON-RPC、变量展开与同意门（consent gate）、`dsh.mcp.refresh` / `dsh.mcp.forgetConsent` 命令，桥 v3 新增 `mcp/*` 方法族。
  MCP server consumption (L2, default off): `dsh.features.mcp-consume` mounts MCP servers from DSH config — stdio/HTTP transports, zero-dependency JSON-RPC, variable expansion with a consent gate, `dsh.mcp.refresh` / `dsh.mcp.forgetConsent` commands, and the `mcp/*` method family on bridge v3.

- **DSH 模型路由（L2，默认关闭）**：`dsh.lm.route`（off/fixed/dynamic）通过桥令牌鉴权的 `/api/lm` models+chat WebRoutes，把 VS Code 侧请求路由到 DSH 模型；`dsh.features.lm-route` 提供开关。
  DSH model routing (L2, default off): `dsh.lm.route` (off/fixed/dynamic) exposes bridge-token-authenticated `/api/lm` models+chat WebRoutes; gated by `dsh.features.lm-route`.

- **可编程 Exports API（L2，默认关闭）**：`dsh.features.exports` 开启后 `activate()` 返回冻结的 v1 编程面——`ask(prompt, opts)` 入队提示、`listSessions()` 列会话、`addContext(uri, range?)` 附加上下文；含稳定错误码（`DSH_EXPORT_*`）。
  Programmatic exports API (L2, default off): with `dsh.features.exports` enabled, `activate()` returns the frozen v1 face — `ask`, `listSessions`, `addContext` — with stable `DSH_EXPORT_*` error codes.

- **callExport 桥方法（L2，默认关闭）**：`vscode/extensions/callExport`（桥 v3）让 DSH 侧经同意门调用其他扩展暴露的 exports 面，带调用日志。
  callExport bridge method (L2, default off): `vscode/extensions/callExport` (bridge v3) lets the DSH side call other extensions' exports faces behind the consent gate, with a call journal.

- **Edit with DSH Files（Ctrl+I，L2，默认关闭）**：`dsh.ctrlIEdit` 在 QuickPick 中选 1–8 个工作区文件，多文件上下文块送入 DSH 对话。
  Edit with DSH Files (Ctrl+I, L2, default off): `dsh.ctrlIEdit` picks 1–8 workspace files and sends the multi-file context block to the DSH conversation.

- **Chat participant @dsh（L2，默认关闭）**：在 VS Code 聊天视图输入 `@dsh` + 提示词，参与者解析当前工作区会话、入队提示并流式回传 DSH 文本增量；`dsh.openSessionHistory` 一键继续最近会话。不读取 `request.model`，不消耗 vscode.lm/Copilot 配额。
  Chat participant @dsh (L2, default off): type `@dsh` + prompt in the VS Code chat view; the participant enqueues into the workspace session and streams DSH text deltas back. Never reads `request.model` nor consumes vscode.lm quota.

- **Tab 补全 FIM（POC，L2，默认关闭）**：`dsh.features.tab-completion` 注册行内补全提供者，按窗口注入 `DSH_FIM_BRIDGE_TOKEN`；API Key 经 **Set DSH FIM API Key** 存入 secretStorage，绝不落 `dsh.*` 配置。
  Tab completion FIM (POC, L2, default off): `dsh.features.tab-completion` registers an inline completion provider with a per-window bridge token; the API key lives in secretStorage via **Set DSH FIM API Key**, never in `dsh.*` settings.

- **粘贴读取失败提示**：`dsh.bridge.ui` 开启时，粘贴读剪贴板失败会在界面弹出警告（静默门控与 v3 UI 相同）。
  Paste read failure notice: with `dsh.bridge.ui` on, a failed clipboard read surfaces a UI warning.

### Fixed / 修复

- **macOS 嵌入 iframe 内 ⌘C/⌘X 复制剪切失效**：VS Code 原生 Edit 菜单持有 ⌘C/⌘X 且不转发进嵌套 webview iframe（microsoft/vscode#129178）；旧桥只接管了 ⌘V。快捷键桥现捕获 C/X/V，仅当选区位于本文档内才接管，且能识别 input/textarea（聊天输入框）内的选区——`window.getSelection()` 对其返回空的问题一并修复。
  macOS ⌘C/⌘X copy/cut inside the embedded iframe: VS Code's native Edit menu owns the shortcuts and never forwards them into nested webview iframes (#129178); the old bridge only claimed ⌘V. The shortcut bridge now captures C/X/V, claims copy/cut only while the selection lives in this document, and recognizes selections inside input/textarea (the chat composer), which `window.getSelection()` misses.

- **主题跟随（颜色跟随系统而非 VS Code）**：扩展端早已在 iframe URL 标记 `dsh_theme` 并转发 `dshThemeChanged`，但 DSH 端消费方缺失，DSH 主题服务仍按 `prefers-color-scheme` 跟随操作系统。DSH 侧 client 现消费两者并经 `ctx.theme.setTheme` 生效（`ctx.get('theme')` 可选查找，主题服务缺席时优雅降级，不影响剪贴板/链接桥）；卸载时恢复原 DSH 主题偏好。
  Theme follow (colors followed the OS, not VS Code): the extension already stamped `dsh_theme` on the iframe URL and forwarded `dshThemeChanged`, but no DSH-side consumer existed, so the DSH theme service kept resolving `system` via `prefers-color-scheme`. The DSH-side client now consumes both through `ctx.theme.setTheme` (optional `ctx.get('theme')` lookup; degrades silently without ui-theme, never blocking the clipboard/link bridges) and restores the durable preference on unload.

- **F5 真实运行时四轮修复**：`collectModels` 误用 llm 服务契约并吞掉 rejected promise；v3 initialize 崩溃被 void 化分发吞没；工具描述符不符合真实 ToolRuntime `register()` 契约；`/api/lm/models` 故障会击穿整个 DSH 进程——均已修复，WebRoute 处理器现具备故障隔离。
  Four F5 real-runtime fixes: `collectModels` misused the llm service contract and dropped a rejection; a v3 initialize crash was swallowed by void-ed dispatch; tool descriptors violated the real ToolRuntime `register()` contract; a `/api/lm/models` fault crashed the whole DSH process — all fixed, WebRoute handlers are now fault-contained.

- **FIM 防抖修正**：最新调用始终赢得防抖窗口，行首 no-op 取消过期的 pending 请求。
  FIM debounce: the newest call always wins the window; a line-start no-op cancels stale pending requests.

- **跨平台测试套件**：测试中的 Windows 专属绝对路径与 win32 fixture 权限位改为平台无关写法，macOS 上全量测试转绿（此前 3 败）。
  Cross-platform test suite: Windows-only absolute paths and win32 fixture mode bits replaced with platform-neutral equivalents; the full suite is green on macOS (was 3 failures).

## [0.6.0] - 2026-08-18

### Added / 新增

- **插件目录与检测（B0）**：新增 schema 校验的插件 catalog 契约、L3 已安装插件探针、profile 探测与诊断插件摘要。
  Plugin catalog and detection (B0): add the schema-validated plugin catalog contract, an L3 installed-plugin probe, profile probing, and a diagnose plugin summary.

- **工作区注册表绑定（B1）**：侧边栏通过 DSH `workspace.list/create` API 绑定 VS Code 工作区根；切换工作区只重绑会话，不 kill/重启自管子进程。
  Workspace registry binding (B1): the sidebar binds workspace roots through the DSH `workspace.list/create` API; workspace switches rebind the session without killing the owned child.

- **Webview 协议单一来源与握手（B2）**：`src/protocol/webview.js` 统一通道/版本/消息类型常量与 request-id 规则；iframe 增加 READY/HELLO 握手，旧客户端 2 秒内回退 v1 直通。
  Single-source webview protocol and handshake (B2): `src/protocol/webview.js` owns channel/version/message constants and the request-id rule; the iframe gains a READY/HELLO handshake with a 2-second v1 passthrough fallback.

- **CH1 v1/v2 协商与元数据通知（B3）**：版本化桥同时服务 v1/v2 客户端，新增 `selectionChanged` / `activeEditorChanged` / `diagnosticsChanged` 纯元数据通知与 150ms 合并器；`V2_NOTIFICATION_SCHEMA` 在 `notify()` 与 `push()` 边界强制执行，携带 `content`/`body` 的非法载荷被拒绝。
  CH1 v1/v2 negotiation and metadata notifications (B3): the versioned bridge serves v1 and v2 clients, adds metadata-only `selectionChanged` / `activeEditorChanged` / `diagnosticsChanged` notifications with a 150 ms coalescer; `V2_NOTIFICATION_SCHEMA` is enforced at the `notify()` and `push()` boundaries and content/body-bearing payloads are rejected.

- **manifest 壳层与命令薄壳（B4）**：新增 capability-router 命令薄壳；`dsh.addFileToThread` 作为首个接入命令，编辑器正文右键（无需选区）、标签页右键与 Explorer 右键均可将当前文件链接追加到 DSH 草稿。
  Manifest shell and command thin shell (B4): add a capability-router command shell; `dsh.addFileToThread` is the first wired command and is available from the editor-body context menu (no selection required), the editor-title context menu, and the Explorer context menu.

- **显式外部文件附加**：`dsh.addFileToThread` 可附加工作区之外受信任的 `file://` 文档（如 `File > Open File…`），点击草稿链接可在本窗口重新打开；桥的 `open` / `openDiff` / 显式 diagnostics 仍保持工作区内限制。
  Explicit outside-workspace file attachment: `dsh.addFileToThread` can attach a trusted `file://` document outside the workspace (e.g. `File > Open File…`) and the draft link reopens it in this window; bridge `open` / `openDiff` / wire-supplied diagnostics stay workspace-only.

- **孤儿 DSH 清理命令**：新增 `dsh.cleanupOrphans`（清理孤儿 DSH 服务），列出实例注册表中 pid 仍存活的条目；仅终止经探测确认仍以 DSH 身份应答的进程，其余只提供“移除记录”，本窗口自管子进程永不列出。
  Orphan DSH cleanup command: add `dsh.cleanupOrphans`, which lists registry entries with live pids, terminates only endpoints that still answer as DSH, offers record-only removal for the rest, and never lists this window's own child.

### Fixed / 修复

- **Webview 桥前置校验（B2-01/B2-02）**：外壳不再转发超长/NUL `requestId` 的 `dshBridge`/thread 消息；DSH client 对非法 THREAD_ATTACH `requestId` 静默丢弃，不再回传失败结果。
  Webview bridge pre-validation (B2-01/B2-02): the shell no longer forwards `dshBridge`/thread messages with overlong/NUL request ids, and the DSH client silently drops malformed THREAD_ATTACH ids instead of echoing a failure.

- **启动错误页 Retry 门控**：纯配置类失败（host/port 非法、`autoStart=false` 且无服务、配置根/node/home 无效）获得稳定 code，状态页不再显示无效的 Retry 按钮。
  Startup error-page Retry gating: configuration-only failures (invalid host/port, `autoStart=false` with no server, invalid configured root/node/home) carry stable codes and no longer render a pointless Retry button.

- **VSIX 发布卫生**：`KNOWN_ISSUES.md`、`*_IMPL_NOTES.md`、QA findings 与清理笔记不再进入 VSIX；`check-package-contents` 补全 0.6 新增文件的必检清单。
  VSIX release hygiene: `KNOWN_ISSUES.md`, `*_IMPL_NOTES.md`, QA findings and cleanup notes are excluded from the package; `check-package-contents` now requires all 0.6 source files.

- **Extension Host 命令矩阵补齐**：smoke 期望命令从 11 条补到 14 条，覆盖 `dsh.addFileToThread`、`dsh.addSelectionToThread` 与 `dsh.cleanupOrphans`。
  Extension Host command matrix: smoke expectations grow from 11 to 14 commands, covering `dsh.addFileToThread`, `dsh.addSelectionToThread`, and `dsh.cleanupOrphans`.

- **运行时迁移提示去版本化**：0.4.x 隔离目录保护提示不再硬编码 `0.5.0`。
  Version-free migration notice: the legacy isolated-home notice no longer hardcodes `0.5.0`.

- **端口探测区分超时与拒绝**：`probe()` 对 `reachable:false` 增加 `reason`（`refused` = 空闲；`timeout` = 有监听但不应答）。端口扫描与 spawn 决策只把 `refused` 当空闲，避免把忙碌服务误判为可用端口后报出误导性的 “process exited early”。
  Probe distinguishes timeout from refusal: `probe()` now reports `reason` for unreachable ports (`refused` = free; `timeout` = silent listener). Port scanning and spawn decisions treat only `refused` as free, avoiding the misleading “process exited early” error caused by misjudging a busy service as a free port.

- **`closePolicy: never` 语义修正**：注释不再声称“可通过实例注册表再次接管”——注册表只做记账/诊断，崩溃或 `never` 留下的存活进程统一由 `dsh.cleanupOrphans` 显式处理。
  Corrected `closePolicy: never` semantics: the comment no longer claims registry-based re-adoption — the registry is bookkeeping/diagnostics only, and survivors of crashes or `never` are handled explicitly by `dsh.cleanupOrphans`.

- **Spawn 日志落盘**：子进程 stdout/stderr 不再直接丢弃，注册表可写时捕获到 `<globalStorage>/dsh-server-<port>-<pid>.log`（每次 spawn 截断），注册表条目记录日志路径。
  Spawn log capture: child stdout/stderr is no longer simply discarded — when the registry is writable it goes to `<globalStorage>/dsh-server-<port>-<pid>.log` (truncated per spawn), and the registry entry records the log path.

- **README 文档同步**：命令数更正为 14；安装命令指向 0.6.0 VSIX；工作区切换描述与 B1 实现一致；中英文补齐 0.6 新能力、安全与信任模型、Known limitations 与 Troubleshooting。
  README synchronization: 14 commands, the 0.6.0 VSIX install command, workspace-switch wording matching B1, and full 0.6 capabilities / Security & trust model / Known limitations / Troubleshooting in both languages.

## [0.5.3] - 2026-08-16

### Changed / 变更

- **更新 Marketplace 英文示例图**：README 现使用全英文、大尺寸 DSH 侧栏截图，清晰展示“Add to DSH Thread”和文本附件链接；截图不包含历史会话列表或真实对话标题。
  Refresh the Marketplace English example: the README now uses a fully English screenshot with a large DSH sidebar, clearly showing **Add to DSH Thread** and the text attachment link without exposing session history or real conversation titles.

## [0.5.2] - 2026-08-16

### Changed / 变更

- **选区改为文本超链接**：编辑器右键“添加到 DSH 对话”不再粘贴代码正文，只向草稿追加 `[文件名:起始行-结束行](…)` Markdown 链接。选区内容仍作为当前窗口内的显式附件保存；消息渲染后点击链接，由版本化交互桥在所属 VS Code 窗口打开文件并恢复选区。工作区变化或窗口重启后附件失效，旧链接会安全地返回“附件已不可用”。
  Represent selections as text links: **Add to DSH Thread** no longer pastes source text and appends only a `[file:start-end](…)` Markdown link. The selection remains an explicit in-memory attachment; clicking the rendered link uses the versioned interaction bridge to reopen the file range in its owning VS Code window. Attachments expire on workspace change or window restart, and stale links fail closed.

## [0.5.1] - 2026-08-16

### Changed / 变更

- **精简 Git/GitHub 仓库维护面**：删除整个 `docs/` 目录及其中的架构图、图片和旧问题说明；通过 `.gitignore` 明确不再跟踪该目录，正式说明集中维护在 README 与 CHANGELOG。
  Reduce the Git/GitHub maintenance surface: remove the complete `docs/` tree, including architecture sources, images, and the former upstream-issue note. `.gitignore` now prevents the tree from being tracked again; maintained product documentation lives in README and CHANGELOG.

- **取消 GitHub Actions 发布目录**：删除 `.github/workflows/publish.yml` 并忽略该目录，0.5.1 起使用本地 `check:w0`、Extension Host smoke 与 VSIX 打包流程。保留 `.vscode/launch.json` 作为开发者 F5 调试必需入口，同时删除已失效且引用旧绝对路径的 `.vscode/tasks.json`。
  Retire the GitHub Actions publishing directory: remove `.github/workflows/publish.yml` and ignore that directory; 0.5.1 uses the local `check:w0`, Extension Host smoke, and VSIX packaging flow. Keep `.vscode/launch.json` because it is required for developer F5 debugging, while deleting the obsolete `.vscode/tasks.json` that referenced an old absolute path.

## [0.5.0] - 2026-08-16

### Added / 新增

- **Codex 风格“添加到 DSH 对话”**：编辑器选中代码后，右键菜单可把带源文件 URI、行号和语言标识的 fenced code block 直接追加到当前 DSH 输入草稿；保留已有草稿、聚焦 DSH 侧栏且绝不自动发送。扩展、Webview 外壳和 DSH client integration 使用带 request id 与结果确认的版本化消息桥，避免仅存入不可见的窗口附件。
  Codex-style **Add to DSH Thread**: select editor code and use the context menu to append a fenced code block with source URI, line range, and language to the active DSH input draft. Existing draft text is preserved, the sidebar is focused, and nothing is auto-sent. A versioned request/acknowledgement bridge spans the extension, Webview shell, and DSH client integration instead of storing only an invisible window attachment.

### Changed / 变更

- **扩展与仓库品牌统一**：Marketplace/VS Code 显示名改为 **DeepSeek Harness(dsh) for VS Code**，GitHub 仓库改名为 `deepseek-harness-dsh-for-vscode`。为保证现有安装能原位升级，内部扩展标识仍保持 `Xizhi1024.dsh-vs-sidebar`，视图/命令 ID 也保持不变。
  Unify extension and repository branding: the Marketplace/VS Code display name is now **DeepSeek Harness(dsh) for VS Code**, and the GitHub repository is renamed to `deepseek-harness-dsh-for-vscode`. The internal extension identity remains `Xizhi1024.dsh-vs-sidebar`, with stable view/command IDs, so existing installations upgrade in place.

- **确认当前文件夹工作区语义**：对照 `liumin1128/deepseek-harness-for-vscode` 的实现，继续以 VS Code 当前工作区目录作为 `dsh web` 的进程 cwd；本扩展还会在多根工作区中优先取活动编辑器所在目录，并在工作区变化时串行重绑服务与 DSH 会话。
  Confirm current-folder workspace semantics: after comparison with `liumin1128/deepseek-harness-for-vscode`, `dsh web` continues to receive the current VS Code workspace as its process cwd. This extension additionally prefers the active editor's folder in multi-root workspaces and serially rebinds the service and DSH session when that root changes.

- **默认共享官方 DSH_HOME**：新增机器级 `dsh.home.mode`（`shared` / `isolated`）与 `dsh.home.path`。全新安装默认 `shared`，按显式路径、环境变量 `DSH_HOME`、`~/.dsh` 的顺序解析，因此独立 DSH 原有模块、skills、providers、凭据、预设和会话直接可见；只有需要单独模块配置时才启用 `isolated`。
  Share the official DSH_HOME by default: add machine-scoped `dsh.home.mode` (`shared` / `isolated`) and `dsh.home.path`. Fresh installs default to `shared`, resolving an explicit path, inherited `DSH_HOME`, then `~/.dsh`, so standalone modules, skills, providers, credentials, presets, and sessions remain visible. Use `isolated` only for a separate module configuration.

- **runtime 与用户配置目录解耦**：本机官方 npm DSH 和 manifest/SHA-256 校验的托管 runtime 现在都绑定到同一套所选 DSH_HOME；下载或切换 runtime 不再隐式切换模块目录。
  Decouple runtime binaries from user configuration: both the local official npm DSH and manifest/SHA-256-verified managed runtimes bind to the selected DSH_HOME, so changing or downloading a runtime no longer silently changes module storage.

- **嵌入配置归入 DSH 内部命名空间**：生成的 VS Code 专用 overlay 移至 `DSH_HOME/.integrations/vscode-sidebar/vscode-embed.overlay.yml`，使用临时文件加 rename 原子更新并尽可能限制权限；它仍只通过 `--patch` 生效，不修改用户 `cordis.patch.yml`。
  Move the embed configuration into a DSH-internal namespace: the generated VS Code-only overlay now lives at `DSH_HOME/.integrations/vscode-sidebar/vscode-embed.overlay.yml`, is atomically replaced with restrictive permissions where supported, and remains a launch-only `--patch` without editing the user's `cordis.patch.yml`.

### Fixed / 修复

- **修复共享旧会话的文件链接**：经进程级随机令牌认证的 `Read …` 绝对路径，即使其会话 cwd 位于当前 VS Code 工作区之外，也会在拥有 DSH 子进程的 VS Code 窗口中打开；F5 调试宿主不再静默拒绝这类路径。
  Fix file links from shared older sessions: an absolute `Read …` path authenticated by the per-process random token now opens in the VS Code window that owns the DSH child even when that session's cwd is outside the current VS Code workspace. F5 development hosts no longer reject those paths silently.

- **修复模型输出交互**：复制通过 VS Code 剪贴板完成；`Read …` 文件通过带认证的 owning-window 文档桥打开，不再进入 Typora 等系统默认程序；HTTP/HTTPS 链接在 VS Code Simple Browser 中打开。
  Fix model-output interactions: Copy uses the VS Code clipboard, `Read …` files use the authenticated owning-window document bridge instead of default applications such as Typora, and HTTP/HTTPS links open in VS Code Simple Browser.

- **0.4.x 升级保护**：首次升级时，若旧扩展隔离目录非空且用户尚未明确选择模式，自动保留 `isolated` 并提示；已有 Junction/符号链接若实际指向共享目录则直接进入 `shared`。扩展从不复制、合并或删除两个目录中的数据。
  Protect 0.4.x upgrades: a non-empty legacy isolated home is preserved with a one-time notice when no mode was explicitly selected; a Junction/symlink already resolving to the shared home upgrades directly to `shared`. The extension never copies, merges, or deletes either home's data.

- **诊断显示实际配置根**：`DSH: Diagnose` 现在报告生效的 shared/isolated 模式与绝对 DSH_HOME，便于定位“模块看似消失”问题。
  Diagnose the effective configuration root: `DSH: Diagnose` now reports the effective shared/isolated mode and absolute DSH_HOME to identify apparent module disappearance.

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

[0.4.2]: https://github.com/Xizhi1024/deepseek-harness-dsh-for-vscode/releases/tag/v0.4.2
[0.4.1]: https://github.com/Xizhi1024/deepseek-harness-dsh-for-vscode/releases/tag/v0.4.1
[0.4.0]: https://github.com/Xizhi1024/deepseek-harness-dsh-for-vscode/releases/tag/v0.4.0
[0.3.1]: https://github.com/Xizhi1024/deepseek-harness-dsh-for-vscode/releases/tag/v0.3.1
[0.3.0]: https://github.com/Xizhi1024/deepseek-harness-dsh-for-vscode/releases/tag/v0.3.0
[0.2.0]: https://github.com/Xizhi1024/deepseek-harness-dsh-for-vscode/releases/tag/v0.2.0
[0.1.0]: https://github.com/Xizhi1024/deepseek-harness-dsh-for-vscode/releases/tag/v0.1.0

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

