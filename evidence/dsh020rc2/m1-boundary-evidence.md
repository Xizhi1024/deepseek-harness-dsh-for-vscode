# M1 接口差异证据：DSH 0.2.0-rc.1 → 0.2.0-rc.2

日期：2026-09-30。方法：对两棵完整官方包树做逐文件 SHA-256 对比，再对全部有真实代码差异的包做内容 diff。机器可读清单见 [m1-package-diff.json](m1-package-diff.json)；对比工具 [tools/compare-runtime-trees.py](tools/compare-runtime-trees.py)。

- rc.1 树：`D:\Coding\.codex-staging\dsh-020rc1-runtime\node_modules\@deepseek-ai\`（288 包，dsh@0.2.0-rc.1）
- rc.2 树：`C:\Users\MSI\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`（287 包，dsh@0.2.0-rc.2，全局安装）
- 包名集合完全一致（rc.1 树多出的 `dsh` 自身即 CLI 外层包）；227/288 个包仅有 package.json 版本号变化。

结论先行：**扩展消费的全部上游边界在 rc.2 中字节不变或纯加法扩展**。rc.2 的实际改动是「用户提问/计划审查」（user-questions）新功能、Desktop 载体的 `dsh plugin --profile desktop` 支持、以及若干 UI 包内部重构；无任何扩展所依赖接口的破坏性变更。适配工作是版本身份贯通（M2），不是接口重写（M3 最小化）。

## 按边界核对（对应计划 §3 表）

| 边界 | rc.1 → rc.2 事实 | 对适配的影响 |
|---|---|---|
| CLI/启动 | `lib/bin.js`：`parseDshArgs(argv, version, manageDesktopProfile=false)` 与 `runCli(options={})` 新增可选参，默认行为逐字节等价；`profile-boot.js`、`dump-config*.js` 不变。`lib/plugin-*.js`（哈希名变更）：新增 desktop 保留 profile 守卫与 `packageManager` 注入，非 desktop profile 走原 `runPluginCommand` 路径。两版 package.json 均无 `engines`/`gitHead`（Node 门槛仍是扩展自身策略，见 compatibility.js NODE_RANGE）。 | 无。扩展 spawn `node lib/bin.js` 的方式与参数不变。 |
| Host 插件 | `dsh-host-webserver`、`dsh-web-app`、`dsh-app-boot`、`dsh-sdk-app`、`dsh-client-ui-cordis`、`dsh-api-workspace-controller`、`dsh-settings`、`dsh-plugin-manager`、`dsh-authorization`：仅 package.json。`dsh-api-session-controller/lib/index.js` 不变（仅 typert 生成物变化，见会话操作行）。`dsh-api-gateway/lib/index.js`：纯加法（`hasLiveClient()`、client 记录加 `signal` 字段）。`dsh-cordis-host-runner/lib/index.js`：CordisInspectRegistryService（模型侧 inspect 工具）快速失败/诊断改进，非扩展边界。 | 无。sessionController/workspaceController/webServer 注入名与方法签名不变。 |
| 会话操作 | `dsh-session`（28 文件）、`dsh-session-projection`、`dsh-session-query`：仅 package.json。`dsh-api-session-controller` typert schema 在 control/follow 结果中新增 **`userQuestions` 可选字段**（zod `.optional()`，open/continued/settled 三态），对应新功能「用户提问」。adapter 只读取已知字段（projections.values.title 等），未知字段忽略。 | 无破坏。rc.2 会话中可能出现扩展不认识的 question 事件/记录：adapter 对未知事件类型产出空 durable 变更，记录为已确认限制（侧栏不渲染 user-questions UI）。 |
| follow | `dsh-session` 不变 → durable 事件流语义、assistantStream revision/index、compact chunks（`dsh-llm` 的 index.js 不变）全部不变。`userQuestions` 仅出现在 RPC 结果 schema，不在事件负载中强制。 | 无。 |
| 工具观察 | `dsh-tool-fs`（read/write/edit）不变；`dsh-agent-tool-presentation` 仅 package.json。`dsh-tools` 仅 package.json。变化的是 `dsh-tool-ask-user`（+1 文件，user-questions 的提问工具）、`dsh-tool-cordis`（inspect 联动）——均为新增工具，不触及 editObserver 的 `tool/call`+`tool/result` 关联。 | 无。 |
| Browser | `dsh-host-frontend-static` 不变；`dsh-web-frontend/dist` 重建（仅 bundle 哈希名变化，vendor 不变；embed 走 `--patch` overlay，按插件 id，与资产名无关）。扩展平铺 chunk 消费的公开服务逐一核对：`uiWorkspace.openSession`（workspace 包仅快捷键改动）、`uiSession.adapter.current`/`bindingSource`（owner `dsh-client-ui-session` 字节不变）、`layout.panelInfo`（不变）、`sessions.retain/binding/list`（不变）、`conversation.input`+`inputActions.captureInsertion/insertText`（conversation 包仅 locale+slot 重构）、`sidebarRight.isExpanded/toggleExpanded/focusedTarget`（内部重构为 on-screen 命名模型，公开方法三件套保留）、composer 标记 `data-composer-card`/`data-composer-input`（conversation 包内，两版同位）。`dsh-client-ui-chat` 216 行变化为 CSS/whale-tail/turn-process 视图与 locale，Enter/keydown 处理无 diff。新增 chat 节点 kind `question-reply` 与 slot `sidebar.right.tab.files.actions` 为加法。 | 无接口破坏。IME/Ctrl+Enter 桥按原样适用。 |
| 数据 | `dsh-session-persistence-jsonl`、`dsh-session-format`（含 v0→v4 全部迁移器）、`dsh-storage*`：仅 package.json。 | 无格式迁移。回退 rc.1 读 rc.2 写入的数据无新风险（同格式）；home 级会话仍按计划 §M5 用独立/备份 home 防护。 |

## rc.2 新增且扩展不消费的能力（记录边界）

- user-questions 全家（`dsh-user-questions`、`dsh-client-ui-user-questions`、`dsh-tool-ask-user`、conversation locale `ask.*`、chat 节点 `question-reply`、session-controller 结果的 `userQuestions`）。
- `dsh plugin --profile desktop` Desktop 载体管理（`manageDesktopProfile`、`runProfilePnpm`）。
- api-gateway `hasLiveClient()`；cordis-host-runner inspect 快速失败。
- 若干 client-ui 内部重构（sidebar-right 模型、renderer useMemo 修复、open-in-app occupant 改名 `SessionOpenInAppAction`）。

## 验证用例映射（→ M2/M4）

| 接口点 | 适配改动 | 验证 |
|---|---|---|
| compatibility/dshCompat/identity/extension 版本门 | 描述表加 rc.2（adapterId `dsh-0.2.0-rc.2`） | 单元：三版本 available、unknown 拒绝、配对校验 |
| profileScaffold 后缀 | `-dsh020rc2`（≤64 字符界） | 单元：rc.1/rc.2/legacy 后缀回归 |
| integration adapters | 共享工厂 + rc.1/rc.2 薄包装；index.js 显式选择 | 单元 + facade 测试：capabilities 返回真实身份 |
| client.js `targetRuntime()` | `dsh_runtime` ∈ {rc.1, rc.2} | chunk 选择 + ctrl-enter/thread 行为不变 |
| sessionBridge `ack()` | 注入真实身份，不再硬编码 rc.1 | 单元：rc.2 ack 通过校验、rc.1 回归 |
| browserProxy/webviewHtml hello-ack | 按 lease 期望对校验，错配拒绝 | 单元：错配/旧集成拒绝 |
| contracts adapterId | runtime-v1 enum+rc.2；session-bridge-v1 const→enum | 契约校验器 + fixtures |
| 同步/打包 allowlist | 新 chunk/adapter 文件入 INTEGRATION_FILES 与 VSIX 清单 | sync guard 测试 + package-contents 门禁 |
| 真实运行时 | probe 参数化 `--target 0.2.0-rc.2`（llmModule 从嵌套 node_modules 解析） | probe 跑 rc.2 全链路 + rc.1 回归 |
