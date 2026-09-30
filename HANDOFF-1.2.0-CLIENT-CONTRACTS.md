# 1.2.0 Client / UI 契约映射与验证

更新：2026-09-30。范围：精确 `@deepseek-ai/dsh@0.2.0-rc.1`，commit `4878cdabd87d4041bdaff61d04c966883b9fd07a`。本文区分源码/产物核对、对象层探针和真实 UI 验收；尚未完成的 UI 用例不能记为 PASS。

## 已证实的公开接口

| 扩展职责 | 上游公开来源 | 用法与限制 |
|---|---|---|
| 主 Conversation 观测 | `ctx.uiSession.adapter.current: HostObservable<StandardSourceBinding>` | 订阅 `subscribe`，读取 `getSnapshot().key` 和 `props.sessionId`，无需读取 `UiSession` 私有 `current` 或 `UiWorkspace` 私有 selection |
| 面板可见性 | `ctx.layout.panelInfo` | `activePanelId !== null` 表示主区当前不是 Conversation，目标归为 none |
| 导航 | `ctx.uiWorkspace.openSession(sessionId)` | 调用后等公开 observable 的目标确认；方法返回不作 UI 已到位证据 |
| 插入生命周期 | `ctx.sessions.retain(id,{source:'vscodeInsertion',signal})` | 捕获时持有精确 Client generation，结束 release 一次；不使用 `mainView` 来源，不改变上游选中态 |
| 插入源 | `ctx.uiSession.bindingSource(reference).getSnapshot().props.inputActions` | 公开 `bindingSource` 校验 reference 属于活动 generation；使用 `captureInsertion()`/`insertText(text,span)` |
| 版本保护 | `InputActions` revision guarded token | span 留在 adapter 内存，不穿 postMessage；编辑或 submit 锁定时 insertText=false，返回 CONFLICT；不调用整段 setDraft |
| 模块加载 | `factory(require)` 的 `require.async('./client.NAME.js')` | 上游仅允许同包平铺 `client.*.js` chunk，因此原设计的子目录落点调整为 `lib/client.dsh020rc1.js`、`lib/client.sessionBridge.js`；不新增构建链或运行时依赖 |

固定版本源码：

- [UiSession：公开 adapter、bindingSource、provide](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/packages/client/ui-session/src/client/index.ts)
- [StandardSourceBinding / SlotScopeAdapter](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/packages/client/ui-slots/src/renderer.ts)
- [Conversation 提供 inputActions](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/packages/client/ui-conversation/src/client/apply.ts)
- [InputActions：revision 保护的捕获和插入](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/packages/client/ui-conversation/src/client/contract/input.ts)
- [UiWorkspace 导航](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/packages/client/ui-workspace/src/client/navigation.ts)
- [布局公开状态](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/packages/client/ui-layout/src/client/service.ts)
- [Session retain / binding 契约](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/packages/api/session-controller/src/client/contract/sessions.ts)

同时核对隔离 npm 产物中的 `dsh-client-ui-session/lib/types/client/index.d.ts`、`dsh-client-ui-slots/lib/types/renderer.d.ts`、`dsh-client-ui-conversation/lib/types/client/contract/input.d.ts` 和上述包的 `lib/client.js`。精确 manifest 版本为 `0.2.0-rc.1`。

## Client 的目标语义与边界

每个 VS Code webview surface 对应一个 DSH iframe，目标是该 iframe **主 Conversation** 的公开 binding。sidebar 与额外 VS Code panel 有独立 surfaceId/epoch，A→B→A 增加 generation；切到 settings 等非 Conversation 主面板时不允许插入。重建 iframe 增加 epoch，并废弃旧请求和 ticket。

DSH 内部另有 embedded / rightbar Conversation，公开 `uiSession.adapter.current` 不代表它们的 focused composer。当前实现不会通过 DOM/fiber 猜其会话。M5 必须验证内部右栏、子会话、全屏覆盖场景：若仍有可能让用户以为附件指向右栏而实际指向主区，此项保持发布阻断，需经约定后的显式主会话目标提示或公开 surface 选择能力解决。对象层主会话验证不覆盖该 UI 问题。

`dsh_session` 只执行一次初始导航，不作永久 current。目标版只走 ticket 插入；旧 `dshThreadAttach` 在目标版不处理。目标版不启动 legacy `sessions.open` / `list.current` 轮询和全页 linkify MutationObserver；原版搜索/编辑保护仍保留给 legacy。

## host / iframe 握手与接线

1. root 向 `framePage` 提供 `runtimeVersion:'0.2.0-rc.1'`、`surfaceIdentity`；没有显式版本时保留 legacy。
2. framePage 为这一 shell 创建 128-bit 随机 nonce，写入 iframe URL；每次 iframe load 先向 host 通知 `hello-init` 分配结果，再向 iframe 发同一 init。首次用传入 epoch，后续 load 增加 epoch。
3. host 收到自己 shell 发出的 init 时创建 `createBrowserSessionProxy`、注册 surface，并把后续 ack/result/targetChanged 交 proxy 的消息订阅。iframe 的 init 必须来自 parent 且 nonce 匹配；首次锁定 parent origin，后续严格校验。shell 对 iframe 校验准确 source/origin。
4. proxy 只在准确版本/身份的合法 ack 后发请求。握手 5 秒、每 250ms 有界重发；失败不自动重载 iframe。
5. `request.cancel` 只终止等待/尚未交出的 capture；不调用 DSH session cancellation。发送过的 commit 无法确认时为 OUTCOME_UNKNOWN，同 ticket 回执重试不会重复插入。

新增同步/打包清单：`lib/client.dsh020rc1.js`、`lib/client.sessionBridge.js`、共享 contracts（主集成人负责）。

manifest 的 `dsh.client.inject` 包依赖：`@deepseek-ai/dsh-api-session-controller`、`@deepseek-ai/dsh-client-ui-session`、`@deepseek-ai/dsh-client-ui-layout`、`@deepseek-ai/dsh-client-ui-workspace`、`@deepseek-ai/dsh-client-ui-conversation`。已只读确认五包在本机 legacy `0.1.2-rc.1` npm 安装也存在。包依赖不是 service 名称；原 apply services 仍为 `conversation,sessions`，目标路径另通过 `ctx.inject` 等待 `uiSession,uiWorkspace,layout,sessions,conversation`，不迫使 legacy 等待新服务。

附件命令统一注入 `useSessionBridge()` 与 `insertTargetAttachment(prepare)`。后者由 root 选择命令开始时的 VS Code surface，并委托 coordinator 在调用 prepare 之前 capture。Ctrl+I 的查找/QuickPick/读取、Ctrl+K 的 InputBox、Folder 读取均在 prepare 内；同步 active-file/selection 可先快照，避免改变 VS Code 焦点后丢失上下文。取消必须释放 ticket 并静默结束。

## 已执行验证

| 验证 | 结果 | 证据范围 |
|---|---|---|
| 浏览器 adapter/bridge 专属测试 | 10 PASS | A-B-A、revision 拒绝、ticket 回执、容量、retain/release、nonce/source/origin/epoch、重复 request、取消、目标入口禁用legacy API/DOM observer |
| Host proxy / shell 专属测试 | 5 PASS | ack 前排队、坏响应拒绝、迟到目标拒绝、取消未知结果、bounded host-first handshake、iframe epoch |
| 附件命令新路径测试 | 3 PASS | capture 时序、异步选择/读取、取消不插入 |
| 专属及相关 legacy 命令回归 | 36 PASS | 含上述 5+3；其余为旧路径回归 |
| 集成子包全套（当时快照） | 167 PASS | 含新增 browser 9 tests；不含真实浏览器/VSIX验收 |
| 既有 webviewHtml/webviewMessages/handshake | 26 PASS | 既有壳与交互桥不回归 |
| npm UiSession 对象层探针 | PASS | 执行精确 npm `ui-session/lib/client.js` 的 UiSession；A-B-A 捕获失效、主会话导航确认、公开 bindingSource 获取 inputActions；retain=2/release=2/插入=1 |
| 静态检查（当时快照） | PASS | JS syntax gate；最终版本仍由主集成人统一复跑 |

对象探针位于工作区的隔离 staging `dsh-client-contract-020rc1/probe.cjs`，运行参数依次为隔离 npm 安装目录和本仓库 `lib/client.dsh020rc1.js`。该探针的 Session、renderer、Service 和 notify 边界使用 fixture；不会启动真实浏览器，**不是 A04/A05/A07 的替代**。

## 真实组件 UI 验证（不替代安装态 VSIX）

使用精确 npm runtime、新建 DSH home/profile/workspace、本地 deterministic provider、真实 webEmbedProxy、真实 framePage 和 headless Chrome。未读取用户 API key 或日常浏览器资料。`installedAcceptanceUiServer.js` 启动独立实例；三个 `installedAcceptanceUi*.js` Playwright 脚本操作真实 UI。

| 用例 | 最终组件结果 |
|---|---|
| 初次导航、chunk 与 nonce 握手 | PASS：真实 hello-ack，none → 请求的 alpha session；修复启动前 session list 未 ready 导致导航失败 |
| 320/480/800 px 搜索 | PASS：每宽度 20 次打开、逐键输入 alpha、过滤、两次 Escape；60 次焦点/caret/节点身份保持 |
| 中文输入 | PASS：Chromium 原生 Input.imeSetComposition + Input.insertText，`draft 中文 tail`，焦点保持 |
| Ctrl+Enter / Enter | PASS：真实逐键输入 `line one`、Ctrl+Enter、`line two` 得到精确两行，继续输入的 caret 正确；plain Enter 真实提交到本地 provider。目标版把 chord 完整归一化为 Shift-only，由 Lexical 自身执行换行 |
| 附件 revision guard | PASS：capture 后用户编辑，commit 返回 CONFLICT，草稿原样保留 |
| 成功附件、重放 | PASS：插入一次，同 ticket/text 重放无重复 |
| 手动 alpha→beta、程序导航返回 | PASS：generation 4→5→6；旧 ticket STALE_TARGET；返回后草稿保留 |
| 原生右栏 | PASS（拒绝范围）：展开后 known→unknown，capture 返回 CAPABILITY_UNAVAILABLE/effect none；收起后恢复。A07 整体 PARTIAL |
| 最终集成子包完整测试 | 171 PASS，0 fail |

导航等待公开 sessions.list 的 ready 阶段，并调用 layout.beginNavigation 取消尚未完成的上游初始恢复，避免 cold start 落回空会话。

**最终右栏策略覆盖上文的待定描述**：`sidebarRight.focusedTarget()` 只给 sidebar 宿主 session、pane、tab、occurrence，未证明可取得嵌入 composer 的 session/reference/inputActions。因此本候选明确只支持主 Conversation 插入：只要公开 `sidebarRight.isExpanded()` 为 true，目标为 unknown，capture/commit 拒绝并提示先收起 DSH 右侧栏。实际浏览器已验证拒绝及收起后的恢复；A07 为 PARTIAL，不代表支持右栏插入。显式 session.navigate 会通过公开 toggleExpanded 收起右栏，再导航主会话。没有 DOM/fiber 推断。

focusin/pointerup/keyup 事件只安排一次合并后的公开状态读取，不扫描、不改写 DOM。每次 capture/commit 仍同步重读，事件遗漏不能允许错误插入。sidebarRight 服务只在目标版 ctx.inject 中等待；其包在 legacy0.1.2 中不存在，因此没有加入全局 manifest 依赖。

安装态 harness `installed-smoke.js` 使用 fresh user-data/extensions/home/storage，安装明确的候选 VSIX，校验每个归档文件 hash 与两个版本，产品不作为 extensionDevelopmentPath。唯一 development extension 是隔离目录中 `local-test.dsh-installed-acceptance-driver` 空驱动，不包含或转发产品源码。ZIP/hash 验证辅助模块最终 38 项合成归档测试通过。

## 正式候选安装态验收结果

正式候选 SHA-256：`e8d61199cb800eec31e4ad53ae3eeb58be8bd933381040800bea94e54f136458`。以下证据全部使用此文件；较早候选的诊断运行不计入结果。

| 范围 | VS Code 1.106.0 | VS Code 1.133.0 |
|---|---|---|
| 独立 VSIX 安装、产品加载路径 | PASS | PASS |
| 扩展 1.2.0、integration 0.10.0 | PASS | PASS |
| 安装文件核验 | 132 个文件逐一 SHA-256 相等，package.json 另按内容比较（忽略安装器 __metadata） | 同左 |
| 激活、8 个启用命令注册 | PASS | PASS |
| 扩展自有启动精确 DSH 0.2.0-rc.1 | PASS | PASS |
| 真实 exports、本地 provider、两个新会话 | PASS，两次响应 | PASS，两次响应 |
| 安装态 nonce ack、动态 chunk 执行、搜索/IME/附件 UI | BLOCKED：验收驱动无法枚举 Electron vscode-webview OOPIF | 同左 |
| 自有 DSH、Code、UI helper 清理 | PASS | PASS |

原始 CDP 目标列表能看到隔离 DSH iframe，但 Playwright `page.frames()` 仅列出 workbench，因此不能可靠取得安装态 ack 和交互证据。测试专用目标元数据适配也没有解除该阻碍，已移除实验适配，没有为验收修改产品字节。此项是验收驱动阻塞，不据此断言产品成功或失败。harness 保存激活/exports 的中间 proof，UI 不通过时保留明确 BLOCKED，避免丢失已完成证据。

最终隔离运行标识为 `installed-1.106.0-PwLJbE` 和 `installed-1.133.0-nVlUwg`，各自 `proof.json` 记录路径、版本、候选 hash、空驱动身份和清理状态；机器专用 profile/日志留在 staging，不加入仓库。suite 执行 stopServer 后退出，另核验本轮隔离目录对应的 Code/node/Chrome 进程为空。没有修改用户日常 VS Code 安装或资料。

因此 A01 可标 PASS，A02/A03 为 PARTIAL；A04/A05 的真实组件结果 PASS，安装态 UI 仍 BLOCKED。A07 仍是上文的主会话限定 PARTIAL。跨 VS Code panel、完整键盘组合、生命周期压力、泄漏和隔离 1.1.8 回退安装仍未完成，不计入本次通过范围。
