# DSH for VS Code 1.2.0：面向 DSH 0.2.0-rc.1 的实施计划

制定日期：2026-09-29；执行更新：2026-09-30。状态：**M0/M1 已完成，M2–M4 主体已实现，M5 已取得部分真实验收证据，M6 候选已生成；完整发布验收未通过。** 逐项证据与缺口见 [验收报告](HANDOFF-1.2.0-VALIDATION.md)。

交接入口：[HANDOFF-1.2.0-DSH-0.2.0-rc.1.md](HANDOFF-1.2.0-DSH-0.2.0-rc.1.md)。必读的 [架构与接口契约 v1](PLAN-1.2.0-ARCHITECTURE-CONTRACTS.md) 固定模块职责、ports、消息、错误、取消/重连和资源预算；接口冲突以该文档为准。本计划的版本目标和执行顺序优先于通用 [REFACTOR-PLAN.md](REFACTOR-PLAN.md)；后者的拆文件、行数目标不是本次发布条件。

## 1. 版本定义与范围

| 项目 | 当前基线 | 本次目标 |
|---|---|---|
| VS Code 扩展 | `Xizhi1024.dsh-vs-sidebar`，本地修复版 `1.1.8` | `1.2.0`，ID、命令 ID、用户配置键保持兼容 |
| 内置 DSH 集成包 | `dsh-vscode-integration@0.9.2` | `0.10.0`，随 VSIX 一起发布 |
| DSH 运行时 | 本机 npm 包为 `0.1.2-rc.1` | 精确 `@deepseek-ai/dsh@0.2.0-rc.1` |
| 上游源码 | 本地 DSH checkout 含其他改动，不能作目标版本证据 | tag `dsh-v0.2.0-rc.1`，commit `4878cdabd87d4041bdaff61d04c966883b9fd07a` |
| VS Code | manifest 下限 `1.106.0` | 保留下限；实测下限及用户当前版本，记录准确版本 |
| 首要验收平台 | Windows x64 | Windows x64；未实测的平台明确标注 |
| 最终产物 | `dsh-vs-sidebar-1.1.8.vsix` | `dsh-vs-sidebar-1.2.0.vsix`、SHA-256、源码提交、兼容性报告 |

版本选择：新增一个明确支持的运行时适配，保留现有扩展对外契约，故使用 minor 版本 `1.2.0`。若实施发现必须破坏公开配置、命令或导出 API，先记录方案调整，不能把破坏性更改悄悄塞入这个版本。候选构建也使用数字版本 `1.2.0`，以隔离目录、源码 SHA 和产物哈希区分；不要在尚未验收时发布到市场。

只承诺本表中的精确 DSH 版本，不能把它写成 `>=0.2.0`、`latest` 或“兼容全部 0.2”。旧 `0.1.2-rc.1` 路径保留现有实现并做基础回归；其他历史版本不在本轮扩展支持范围。未知或更新的运行时必须显示“未验证”；核心契约探测失败时停止相关启动/绑定链路，附明确诊断，不能循环重试或默默换到另一份 DSH。

本次必须完成：运行时身份与隔离、目标版本 host/client 适配、会话/事件生命周期、搜索和输入区域回归、安装产物验证。可复用现有 DI 工厂、featureRegistry、桥接协议及验证器、鉴权/传输、变更日志和测试基础。暂不做全仓语言迁移、重写全部 UI、为缩短文件而搬家、无关功能扩展。

## 2. 基线与工作区保护

- 本仓库：`D:\Coding\DSH\deepseek-harness-dsh-for-vscode`。它是独立 Git 仓库；不要在 `D:\Coding` 父控制仓库暂存其内容，也不要进入当前 IDE 的 CS_SE 学习计划。
- 开始前读 `AGENTS.md`、`codemap.md`、相关目录 `codemap.md`，再检查 `git status --short`、diff 和当前版本。扩展侧是 CommonJS；内置 runtime 集成包是 ESM；遵循现有 DI、dispose、超时及零 npm 运行时依赖约定。
- **1.1.8 修复位于当前工作树，尚未提交。仅从 HEAD 创建 worktree 会漏掉这些修复。** 先记录已有改动，采用只包含确认过文件的基线提交，或复制工作树到独立 checkout 并保留来源记录。不得 `reset --hard`、`clean -fd`、整体 stash/revert，或直接 `git add .` 把用户文件一起提交。
- 已知用户未跟踪内容：`.dsh-accept-test/`、`.dsh-repair/`、`.vscode/tasks.json`、`thinking-effort-loaded.json`。它们不是本轮实现输入，不清理、不打包、不提交。
- 不丢失 1.1.8 的修复：watcher 提前排除/有界队列/串行 flush；projector 取消旧回填和订阅；`enqueueLatest`；焦点变化保留工作区；React/编辑区域 DOM 保护；稳定 VS Code proposed API 降级。
- 已有回归入口：`test/unit/changeWatcher.test.js`、`test/unit/editEventProjector.test.js`、`test/lifecycle.test.js`、`test/workspaceContext.test.js`、`test/extension.test.js`、集成子包 `test/linkifyIsolation.test.js`。
- 上一轮证据为根套件 795 项（794 通过、1 跳过）、集成子包 158 通过和扩展宿主激活验证；它们**不证明 DSH 0.2 的真实链路**。`VERSIONS.md` 有更旧的版本/测试记录，需据新证据更新，不照抄其支持范围。

## 3. 已核实的目标版本变化

以下来自精确上游 SHA 的源码核对；执行阶段已启动隔离的目标运行时，动态映射见 [契约报告](HANDOFF-1.2.0-CONTRACTS.md)。固定源码来源见第 11 节。

| 编号 | 当前依赖 | 0.2.0-rc.1 的证据 | 实施动作与尚待验证项 |
|---|---|---|---|
| C1 | `compatSessionRoutes.js` 调用 `sessionController.commands.create/rename/prompt` | controller 的 `commands` 为 private，公开 `create`、`rename`、`prompt`；`list` 仍存在 [S3] | 改走公开入口，逐项核对 payload、返回值、取消、错误，不只替换字段名 |
| C2 | `client.js` 调用 `sessions.open()` 并读取 `list.getSnapshot().current` | `ISessions` 没有 `open`；列表状态没有 `current`；公开导航为 `uiWorkspace.openSession(target)` [S4–S6] | 替换导航；当前会话观测另做契约验证，**禁止改读 uiWorkspace 私有 selection** |
| C3 | 附件通过当前会话 ID 后直接 `sessions.scope(id)` 写入草稿 | `scope` 只借用已经 retain 的 generation；存在 `retain/using/release`；输入仍有 `input.for(actx)`、draft、setDraft，并提供带 revision 保护的插入能力 [S4,S7] | 明确持有/释放关系；优先验证 `captureInsertion/insertText`；异步附件不得覆盖用户新输入或误入新会话 |
| C4 | compat SSE 只转发 `session/event`，扩展解析 `assistant/chunk → text-delta` | `SessionFollowFrame` 包含 snapshot、event entries、assistant-stream；history 有独立 assistant stream，跟随需请求 `assistantStream:true` [S8,S9] | 核对公共 `sessionController.follow` 的 request/address 和帧格式，翻译增量、终态、取消、重连；“SSE 已连通”不足以验收 |
| C5 | workspace 一次性消费 `follow().next()` | `create` 和 `follow` 存在；baseline 含 items、archivedSessionIds、pinnedSessionIds；返回契约为异步可迭代 [S10,S11] | 经 `Symbol.asyncIterator` 取迭代器，成功/异常/取消均释放；只读列表不能遗留订阅 |
| C6 | 集成包 `dsh.client.inject: []`，动态碰运气等客户端服务 | 模块 loader 和 client manifest 骨架仍存在；manifest inject 为包依赖，区别于运行时服务注入名 [S12,S13] | 根据新 adapter 的真实依赖声明加载顺序；不能混用包名和服务名 |
| C7 | 插件从 PATH/设置解析 Node 与 DSH | 目标源码 Node 要求 `^22.19.0 || >=24.0.0` [S2] | 验证真正启动 child 的 Node；VS Code 内置 Node 或终端的 `node --version` 不能代替它 |

核心未决项必须在 M1 解决：公开“当前可见会话”观测、session follow 的地址/恢复游标/终态、导出/历史回填、CLI 参数与鉴权启动、工具观察 API，以及搜索在窄侧栏中的真实可达性。不能根据“仍有同名服务”宣布兼容。

## 4. 实现边界与必须保持的行为

本节是架构摘要；名称、签名和语义以 [架构与接口契约 v1](PLAN-1.2.0-ARCHITECTURE-CONTRACTS.md) 为准。这些是待实现的扩展设计，不代表上游提供同名 API。M1 验证上游映射；改约由主集成人同步文档、schema、两端和契约测试，不允许各 worker 自定接口。

### 4.1 统一运行时身份

拟新增 `src/runtime/identity.js`，在现有 normalize/resolve seam 上形成唯一快照：runtimeVersion、Node 可执行文件、entrypoint/packageRoot、来源、home、profile、integrationVersion、adapterId；实例启动后另持有 ownerWindowId、PID、实际端口和生命周期代次。

- prepare、spawn、鉴权就绪、诊断、停机消费同一份身份，禁止各模块再次从 PATH 猜版本。
- token/cookie 只保存在内存中，不写入可展示 identity、日志、实例注册表、测试报告。
- 版本选择配置必须说明作用域；不能仅设置 `dsh.runtime.version` 就假定 PATH/local/command 模式已锁定成功。验证最终选中的包和启动进程。
- 检测不匹配时不自动全局升级 npm、不更改用户默认 DSH home，不静默回退到旧版成功伪装。
- 测试中 home/profile/集成包目录与其他窗口彻底隔离。生产路径保留已有用户配置；跨版本集成包同步必须按版本隔离或拒绝覆盖正在使用的不匹配目录。

### 4.2 一个目标版本协议适配器

在内置集成包设置精确版本 adapter（建议 `lib/adapters/dsh020rc1.js`），归一化 workspace、session、follow、工具观测和 capability 结果。扩展侧的 sessionNavigation/dshChatClient/ch2 只消费内部契约，不散布 0.2 的服务访问。

传输已约定：目标版本通过内置插件实现的 `/api/vscode/v1` facade 调用上游公开服务。旧 REST shim 只属于 legacy adapter；本轮不并行实现 native remote 客户端。一次 runtime lease 只选一个 adapter，不能双路消费或在业务模块复制 Typert 细节。

按已约定的归一化事件契约补真实映射样本，再改消费者。区分持久序号、临时 assistant 流身份和连接投递序号；目标版本固定 snapshot-reconcile，不编造恢复游标，不自动重发 prompt。取消等待、取消订阅、取消 session 是不同操作。

### 4.3 客户端适配与会话所有权

client 适配集中完成 navigate、observeVisibleSession、retain/release、appendAttachment。一个 Webview 实例维护一个可见会话标识和代次；改变焦点本身不能改变会话。附加面板有独立路由，不得用一个全局 current 覆盖所有面板。

上游公开导航和 store/生命周期优先。若找不到可靠的当前会话公开观测，M1 交付受控导航/显式选择的替代方案，并证明手动切换仍能被正确处理。目标 unknown 时附件安全失败；这种降级不算 A07 通过，无法提供可靠目标则保持候选状态。不能读取 React fiber、私有 selection，或重新全页轮询 DOM。

界面增强限制在明确的非编辑展示区域；新路径不依赖全页 MutationObserver 改写搜索、输入器、菜单或框架管理节点。能用原生文件提及/链接机制时移除相应 DOM 后处理。保留 Enter、Shift+Enter、Ctrl/Cmd+Enter、IME composition 语义及现有附件目标行为。

### 4.4 事件与生命周期约束

- 每个窗口正常模式至多一个自管 server；显式复用的外部 server 永不被停止/杀掉。
- 对每个逻辑消费者/会话只存在一条有效 follow 链路；多个客户端功能可共享同一连接。每个 surface 的 retain 有配对 release。
- 切换代次后，旧异步结果不能重绑 UI、插入草稿、记录事件或创建重连定时器。
- 队列有显式上限；同类配置/工作区事件合并，但运行中仍保留一个读取最新状态的后继任务。
- 网络断开后重连必须有上限/退避，恢复后回到基线订阅数；prompt 不因重连自动重放。
- 工具观察不能阻断工具执行；若目标版本仍为 waterfall，恒委托 next；若契约变更，用目标公开观察点替换。

## 5. 阶段、依赖与交付件

| 阶段 | 主要任务 | 文件责任范围（新增路径以架构契约为准） | 完成条件 |
|---|---|---|---|
| M0 基线 | 保存当前修复、隔离目录、记录源码与 VSIX hash，复跑基线并记录跳过原因 | 工作树/测试记录；不改变用户安装 | 1.1.8 可还原，测试环境不会写入用户 home |
| M1 契约 spike | 锁定上游与 npm 产物、核实 C1–C7、启动准确 runtime，验证既定 facade/ports 的映射及当前会话来源 | `dshCompat.js`、runtime/client 契约；候选 `test/fixtures/dsh020rc1/`、契约报告 | 启动身份确证；每项契约有源码位置、脱敏样本、实测状态；无核心 unknown 被当作支持 |
| M2 运行时 | identity、版本/Node 验证、profile 同步隔离、启动鉴权/健康/所有权/退避 | `localRuntimeResolver.js`、`launchMethodResolver.js`、`managedRuntimeLaunch.js`、`serverManager.js`、`dshHome.js`、`profileScaffold.js`、`embedOverlay.js`、`hmrGuard.js`，新增 runtime 模块 | 精确版本实际启动，错误有界，两个窗口及外部实例互不伤害 |
| M3 Host/协议 | C1/C4/C5，规范化事件与回填，工具/LM/FIM 适配和能力降级 | 集成 `lib/index.js`、`compatSessionRoutes.js`、`tools.js`、`editObserver.js`、`lmRoute.js`、`fimRoutes.js`；`sessionNavigation.js`、`dshChatClient.js`、`ch2/workspaceClient.js`、`editEventProjector.js` | 请求、增量、终态、取消、恢复均有真实目标版本证据；旧 adapter 基础回归 |
| M4 Client/UI | C2/C3/C6，导航、观测、输入、附件、主题/剪贴板和多面板生命周期 | 集成 `lib/client.js` 及拆出的 client adapter；对应子包测试 | 搜索/输入可达可用；无焦点重载、草稿覆盖、错误会话附件和泄漏 |
| M5 组装与验收 | 唯一 session/lifecycle ownership，安装态测试入口，真实压力/UI用例 | `extension.js`、`context/workspaceBinding.js`、`workspaceContext.js`、`webviewHtml.js`、`webviewMessages.js`；测试 harness | 第 7 节全部发布阻断项通过，有证据文件 |
| M6 交付 | 更新版本/文档、干净候选提交门禁、打包、安装态核对、回滚演练 | `package*.json`、集成 package.json、`dshIntegration.js`、打包脚本、版本台账/README/CHANGELOG/codemap | 一个可追溯的 1.2.0 VSIX 与完整验收报告 |

依赖：M0 → M1；M1 契约冻结后 M2/M3/M4 可并行；M5 依赖三者；M6 依赖 M5。真实 runtime 契约测试应随 M2/M3/M4 持续运行，不能全部拖到 M5 才第一次启动。

M1 报告为 `HANDOFF-1.2.0-CONTRACTS.md`；验收报告为 `HANDOFF-1.2.0-VALIDATION.md`。两者已创建，按实测证据更新，不能预写 PASS。

## 6. 多 AI 所有权

| 角色 | 独占修改 | 对其他角色的交接 |
|---|---|---|
| 主集成人 | `src/extension.js`、`src/dshIntegration.js`、`src/session/coordinator.js`、workspaceBinding/workspaceContext、共享 schemas/协议常量、所有 package/lock 文件、manifest、本计划状态、发布门禁/文档 | 统一装配、版本、配置、契约 fixtures、测试入口与最终候选提交 |
| Runtime | M2；`src/runtime/supervisor.js`、`identity.js`、`compatibility.js` 与对应测试；不含 client.js | identity 输入/输出、spawn/readiness/dispose 接口 |
| Host/协议 | M3；`src/runtime/client.js`、`src/session/feedHub.js`、`transcript.js`；集成 `lib/index.js`/runtimeFacade/host adapter 由该角色独占 | 规范化 session/event/capability 契约；schema/入口改动向主集成人提交说明 |
| Client/UI | M4；`src/session/browserProxy.js`、webviewHtml/webviewMessages 与对应测试 | current-session 观测、导航、附件、握手和 client manifest 依赖要求 |
| 验收角色 | 专属 E2E harness/fixtures/证据文件 | 对真实 VSIX 跑第 7 节，不替实现者重写业务代码 |

每个 worker 都必须被告知“共享工作树中还有其他执行者，不回退他人改动”。测试文件也应分配所有权；共享测试文件由主集成人统一改。若只有一个 AI，按同样顺序串行完成。涉及跨模块的契约变化先通知对应负责人，不自行维持第二套契约。

## 7. 验收标准（全部是计划，尚未执行）

每例记录：case ID、候选 SHA/VSIX hash、runtimeVersion/来源、VS Code/Node/OS、前置条件、动作、期望、实际结果、日志/截图路径、PASS/FAIL/BLOCKED。不能把未执行写成 SKIP 后仍标“全功能兼容”。

| ID | 场景 | 必须验证 |
|---|---|---|
| A01 | 安装真实 VSIX | 产品不能作为 extensionDevelopmentPath；实际 extension path 位于隔离安装目录，版本为 1.2.0，集成包 0.10.0。除 package.json 安装元数据外，其余归档文件 hash 对应候选；manifest 去掉 VS Code 的 __metadata 后语义一致。测试宿主若要求 developmentPath，只允许单独的空验收 driver，记录其身份/路径，不能携带产品源码 |
| A02 | 新建 home 冷启动 | runtime 精确 0.2.0-rc.1、Node 合规；profile/插件加载、鉴权代理、健康检查和页面成功，无权限/模块注入循环错误 |
| A03 | workspace 与 session | 创建/列表/重命名/恢复、单根/多根、B→搜索→无编辑器和队列忙时 B→无编辑器，绑定最终正确；外部文件聚焦不跳根 |
| A04 | 真正的搜索控件 | 区分 VS Code 顶部搜索、DSH 会话搜索、聊天输入；侧栏宽 320/480/800px，搜索入口可达；原生窄栏可折叠为图标但必须能打开；20 次输入/清空/切换/隐藏显示后仍可用，无不预期 iframe reload |
| A05 | 草稿、键盘、IME | 普通 Enter、Shift+Enter、Ctrl/Cmd+Enter、中文 IME、选区/剪贴板；焦点与主题变化保持草稿；异步附件返回时不会覆盖期间新输入 |
| A06 | 流式回复与取消 | 通过真实 DSH 到已配置测试 provider 或独立本地兼容 provider 得到至少两个分离增量与终态；文本仅一次，取消结束正确；不能只断言 SSE 200/keepalive |
| A07 | 快速切会话/面板 | A 回填未完成切 B，再回 A；同 ID 重复 follow；销毁时回填待返回；无旧订阅复活/错会话输出/重复历史；sidebar 和额外 panel 附件各入正确会话 |
| A08 | 工具与 Changes | 通过真实 DSH 工具调度在一次性目录执行 read/edit/write 及现有非编辑工具，bridge 通知/变更归因/预览/accept/undo 正确；一处 edit 只记一条；observer 不影响其他工具 |
| A09 | 生命周期与共存 | 10 次启停/重连，双 VS Code 窗口及独立外部 DSH 共存；停 A 不伤 B/外部；关闭/取消后无孤儿 child、监听或定时器；显式 closePolicy 行为保持 |
| A10 | 事件风暴 | 忽略目录 10,000 次事件不入队；10,000 个有效变化触发有界合并/熔断；排队中的配置/工作区突发最终读取最新状态；不会重复拉起进程或抢焦点 |
| A11 | 断连与稳态 | 10 分钟稳态及受控断连恢复，采样 PID、重连、活跃订阅/retain、队列峰值、RSS；无意外重启/持续重连，资源回基线；RSS 无持续单调增长，记录实测而非编造通用阈值 |
| A12 | 功能开关与降级 | 默认功能全部通过；对 LM route、chat participant、FIM、MCP、Ctrl+K/I、exports、终端等逐项记录配置及支持结果；未测不宣称支持，缺能力有明确说明，无隐藏失败 |
| A13 | 版本与回滚 | 目标版本通过；旧 0.1.2-rc.1 基础路径回归；未知版本准确标未验证；1.1.8 + 原运行时 + 独立旧 profile 回滚演练，不用旧运行时打开已迁移的新数据 |

A01–A11、A13 和 A12 中默认开启功能为发布阻断项。关闭的可选功能可记录为未认证，但启用时必须明确告知限制；不以删除失败功能或关闭用户功能作为“修复通过”。任何核心场景因环境/凭据缺失而 BLOCKED，交付应明确是候选构建，不能宣布 1.2.0 已完成验收。

本地可控 provider 仅代替模型后端；必须经过真实目标 DSH 的 prompt、agent/tool、事件和 UI 链路，不能直接 mock 扩展响应充当 E2E。远程付费请求使用明确授权的测试配置；不自动读取个人密钥。若没有可用 provider，先完成无需模型的工作并如实记录模型链路阻塞。

## 8. 环境隔离、现有命令和门禁

所有命令在本插件仓库运行。本轮已在专属 staging 安装精确 DSH 并测试；未升级用户全局 DSH。

### 8.1 固定运行时

- 在专属测试目录安装精确 `@deepseek-ai/dsh@0.2.0-rc.1`（例如 `npm install --prefix <isolated-runtime-dir> --save-exact @deepseek-ai/dsh@0.2.0-rc.1`），保存 lockfile、npm 包 integrity/来源及 `npm ls`；不要 `npm install -g ...@latest`。
- 检查协议相关子包的实际解析版本：只锁 CLI 顶层版本不等于整个依赖图固定。构建测试必须可从相同 lockfile 重现。
- 若改用源码构建，使用独立 clone/checkout 的完整 SHA，并按该 SHA 的 AGENTS/build 指令构建；不拿本机含大量修改的 DSH checkout 冒充 release。
- 独立 VS Code `--user-data-dir`、`--extensions-dir`、DSH home/profile、storage、workspace、日志和端口；显式设置该测试进程的 `DSH_HOME`、`DSH_VSCODE_STORAGE_ROOT`、测试启动路径。验证实际身份，不依赖默认 PATH。
- 现有测试 fixture 只有 `dsh.autoStart:false`，不足以隔离 home。测试启动器须显式配置 `dsh.home.mode/path` 与运行时位置，并确认两种设置/环境变量的有效优先级。

### 8.2 开发验证（已有命令）

```powershell
npm run lint
npm run test:unit
npm --prefix runtime-integration/dsh-vscode-integration test
npm run test:secrets
```

修改范围内有针对性的行为回归先跑，通过后再完整运行。每次失败记录原因，不依靠反复重跑隐藏间歇问题。

### 8.3 干净候选提交与打包

`scripts/check-package-contents.js` 要求每个 runtime-integration 文件的 `git status --porcelain` 为空，**暂存仍不能通过，必须与 HEAD 一致**。确认自己的变更后创建候选提交，在干净候选 checkout 跑以下门禁；不要删除或绕过此检查，也不要把用户其他文件提交进去。

```powershell
npm run check:w0
npm --prefix runtime-integration/dsh-vscode-integration test
npm run test:extension-host
npx --no-install vsce package --no-dependencies --out dsh-vs-sidebar-1.2.0.vsix
```

`check:w0` 不包含子包测试和 extension-host，故三条均需要。运行 extension-host 前完成隔离配置。新增集成文件必须更新 `src/dshIntegration.js` 的 `INTEGRATION_FILES` 及相关测试，否则 VSIX 中存在的 adapter 也可能不被同步。拆分 client 入口时保留有效装载路径；若改变 `startEmbeddedSessionFollow` canary，应以等价的行为/打包证明替换，不能只删断言。

### 8.4 真实运行与安装态（现有入口及缺口）

```powershell
# 现有真实 runtime 基础检查，参数必须是已验证的包根目录。
node scripts/smoke-runtime.js <absolute-dsh-package-root>

# 先在隔离 user-data/extensions 目录安装候选 VSIX，再运行现有安装态测试。
node test/extension-host/installed-smoke.js <absolute-isolated-acceptance-profile.json>
```

第一条目前覆盖基础绑定/list/rename/events/reuse，不包含完整 VS Code bridge 或 UI。第二条要求 `.vscode-test/installed-smoke-profile.json` 的 userDataDir/extensionsDir，硬编码 1.106.0 测试 Code 路径，且只检查激活/命令；执行前阅读脚本，补齐参数化、安装版本/path/hash 断言和隔离设置。新增专用 E2E runner 覆盖 A01–A13，并记录其真实命令；**不要把上述 smoke 结果当成完整 E2E**。

候选 VSIX 必须安装在独立目录验收；验证产物内文件与候选 SHA 对应，再核对安装目录字节。发布文档不得包含 token、cookie、API key、真实会话正文或本机敏感路径。

## 9. 交付与回滚

交付清单：

- `dsh-vs-sidebar-1.2.0.vsix`、SHA-256、对应源码提交；内置集成版本和文件清单核对。
- 目标 runtime 的包版本、源码 SHA、安装来源、lockfile/integrity、实际 Node/VS Code/OS。
- `HANDOFF-1.2.0-CONTRACTS.md`：C1–C7 的最终映射、能力表、待决项处理及证据。
- `HANDOFF-1.2.0-VALIDATION.md`：命令/退出码、通过/失败/跳过/阻塞及原因、A01–A13 结果、脱敏日志/截图与资源采样位置。
- README/CHANGELOG/VERSIONS/codemap 与实现一致；注明验证过的精确版本/平台和可选功能限制。
- 回滚说明与实测：保留原 1.1.8 VSIX、原 runtime 配置和**升级前** profile/data 副本；测试在副本上做。回滚停止的只能是已确认归属的实例，再恢复匹配的版本组合。1.1.8 仅是本次修复基线，不因保留安装包而被称为全功能认证版本。

最终安装到用户日常 VS Code 与外部发布不属于本次“制定计划”的动作。执行 AI 应先交付可审阅的构建及证据，是否安装/发布按当时用户授权处理。

## 10. 执行状态与停止条件

本表由执行 AI 更新；当前没有实施阶段被标为完成。

| 阶段 | 状态 | 完成证据/阻塞原因 |
|---|---|---|
| M0 | TODO | 待记录工作树修复基线与隔离环境 |
| M1 | TODO | 本文有静态差异核对；真实 contract spike 待做 |
| M2 | TODO | 待实现 |
| M3 | TODO | 待实现 |
| M4 | TODO | 待实现 |
| M5 | TODO | 待完整安装态 E2E |
| M6 | TODO | 待候选提交、产物及交付报告 |

遇到上游没有必要公开契约、无法固定运行时依赖、真实链路不可用或测试存在数据污染时，记录问题和可选处理，并继续不受阻的任务。不得用“单测全绿”、改版本号、截取一张主页截图代替兼容性完成。发布阻断项未通过时停止发布，不伪造证据。

## 11. 上游来源（固定版本）

- [S1 发布页](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.1)；[完整 release commit](https://github.com/deepseek-ai/deepseek-harness/commit/4878cdabd87d4041bdaff61d04c966883b9fd07a)；[CLI manifest](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/apps/cli/package.json)。
- [S2 根 manifest / Node engines](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/package.json)。
- [S3 session controller](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/packages/api/session-controller/src/index.ts)。
- [S4 sessions contract / retain 生命周期](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/packages/api/session-controller/src/client/contract/sessions.ts)。
- [S5 session list state](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/packages/api/session-controller/src/client/sessions/service.ts)。
- [S6 uiWorkspace navigation](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/packages/client/ui-workspace/src/client/navigation.ts)。
- [S7 conversation input contract](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/packages/client/ui-conversation/src/client/contract/input.ts)。
- [S8 session history producer](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/packages/api/session-controller/src/history.ts)。
- [S9 session wire types](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/packages/api/session-controller/src/types.ts)。
- [S10 workspace controller](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/packages/api/workspace-controller/src/index.ts)。
- [S11 workspace feed](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/packages/api/workspace-controller/src/feed.ts)。
- [S12 client manifest contract](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/packages/client/modules/src/client/manifest.ts)。
- [S13 官方 conversation client manifest 示例](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/packages/client/ui-conversation/package.json)。
