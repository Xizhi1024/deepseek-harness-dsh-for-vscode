# DSH VS Code 扩展 1.1.0 · 会话交接提示词（上下文压缩）

> 本文是执行会话的完整压缩态，新会话以此为唯一上下文即可无缝续作，无需回读任何历史对话。
> 它取代 PLAN-1.1.0-REMAINING.md（后者反映更早状态，仅作历史参考）。
> 用法：新会话开场粘贴本文全文（或 `@PLAN-1.1.0-HANDOFF.md` 引用）。

## 事实基线（勿推断，直接采信）
- 仓库 `D:\Coding\DSH\deepseek-harness-dsh-for-vscode`，分支 `feature/1.1.0`，HEAD `5060ab6`，已推送 origin。
- 测试基线：根 `npm test` = 677 tests / 676 pass / 0 fail / 1 skip（skip 为既有）；插件侧（runtime-integration/dsh-vscode-integration）`node --test` = 99/99；`node scripts/lint.js` 159 JS + 6 JSON 全过；check-package 过。
- 版本号仍 1.0.2，发版决策未做。
- 提交链（4433a07 计划基线起共 20 个）：A 快改批 → B3 linkify → B 语义波(B1+B4+B5+D4部分) → C3 secretStorage → docs 交接 → A8 激活崩溃修 → B2 根因 docs → 门禁修复批(F-a/b/h, F-k, F-c, F-j/e/i) → **F-d 直写改造** → **C1+C2 全源追踪** → 同步清单崩溃修 → 树会话作用域 → **C2.5 事件流投影**。
- 用户实测过的坑都已修：变更树 id 撞车/越界僵尸/提案预览缺失/FIM 800ms 掐死/503 不可见/env 不重注入/@dsh 原生聊天无输出/DSH 启动崩溃循环。

## 架构定案（用户逐条裁定，勿复议）
1. **权限单源 = DSH 沙箱**（read-only / workspace-write / full-access 三档在 DSH 侧）；扩展在沙箱之上只添砖：追踪、归因、审计、Undo。扩展不自设任何审批门。
2. `vscode/changes/push` = **直写通道**：结构校验 + 活文档范围校验(F-b) → 快照 → applyEdit → journal(accepted)。无弹窗、无工作区边界（`mode` 字段仅形状校验，语义忽略）。
3. **追踪 = 全源**：journal v2 entry 带 `source`：
   - `bridge`：经桥直写（changes/push）
   - `tool-intercept`：C2 插件侧 `tools/pre-execute` waterfall 观测（只归因不拦截，`dsh.changes.observe-tools` 默认开）+ C2.5 事件流投影（streamSession onEvent → /api/session.export 尾部 300 条有界回扫 + live 订阅）双路进 `recordToolEdit`，(path,sessionId,±2s) 幂等合并去重
   - `external`：C1 FileSystemWatcher 兜底（500ms 去抖 / watcherExclude / >20事件每秒熔断降级 git 轮询 / 快照可回滚）
4. **变更树默认跟随当前侧边栏会话**（只显示本会话归因条目；`dsh.changes.toggleScope` 切全局三组视图；空会话有空态引导）。
5. **安全网** = before-快照 + 树 Undo（pending→丢弃；accepted→快照整文件还原；external 无快照→确认后 git checkout——那是破坏性操作确认，不是权限门）。人是 Reviewer 不是守门员。
6. Codex 是设计北极星：沙箱即权限 / diff=审查面 / 类型化补丁。Worktree 多 agent 隔离与 hunk 级操作为远期方向。

## 实现地图（文件→职责）
- `src/bridge/v3.js`：push 直写 handler + findFiles 防护 + 终端桥（A8 双层提案门控）
- `src/changeTracker.js`：journal（id 水位线从 journal 派生 / source+path+tool 字段 / recordToolEdit 幂等 / assertEditsWithinDocuments / 快照还原 Undo）
- `src/changeWatcher.js`：C1 watcher + 熔断降级
- `src/editEventProjector.js`：C2.5 投影（ZIP 解析回扫 + live 订阅）
- `src/dshChatClient.js`：SSE 流（onReady 门控 F-k + onEvent 原始事件缝）
- `src/changeTree.js`：三分组/会话作用域/F-c 预览（dsh-change-preview:// scheme）/contextValue 菜单门控
- `src/extension.js`：全部接线（9 处 currentSessionId 汇聚 followEditProjection + setActiveSession；renderFrame 是会话变化单一汇聚点）
- `runtime-integration/dsh-vscode-integration/`：tools.js（桥工具+描述）/ editObserver.js（C2 拦截）/ linkRoutes.js（B3）/ fimRoutes.js（FIM 服务端）

## 剩余工作（按优先级）
1. **B2 会话爆炸**：流式断链已修（F-k）；剩会话复用（per-workspace 缓存，3 条消息 0 新会话）+ 裸 UUID 标题 patch + 双前缀（根因已勘：运行时导出命名，见 7c2ff6b 提交说明）。锚点：chatParticipant.js / dshChatClient.js / workspaceBinding.js:179 / sessionNavigation.js
2. **D1 断点桥**：v3 方法 32→34（list/add/removeBreakpoints，官方 breakpoints API，1-based 转换；勿用 customRequest('setBreakpoints')）；tools.js METHOD_SCHEMAS 同步 + 契约测试
3. **D2 Diagnose 改版**：QuickPick 分区（服务/桥/兼容性/插件）+ 错误码人话 + WSL 默认终端检测提示（README 条目已有）
4. **D3 onboarding 改版**（profile 步改 QuickPick 列 profileProbe / FIM 三并一步）+ **A10 FIM 复测**（800ms 掐死已修，这次大概率过；清单见 PLAN-1.1.0-REMAINING.md）
5. F-f 服务重启端口抢跑（偶发，低优）
6. **D5 发版**：版本 1.1.0 / CHANGELOG 定稿（大部分暂缓标记已清）/ 全矩阵门禁（check:w0 + 插件 + extension-host + F5 冒烟）/ vsce package
- 明确不做：Container MCP、dsh-std 对齐、上游 Web UI 修改

## 环境与踩坑（必读）
- git 前先 `Remove-Item Env:GIT_CONFIG_* -ErrorAction SilentlyContinue`；npm 用 `npm.cmd` 且输出落盘取证（管道限制会假绿 exit 0）
- **INTEGRATION_FILES 守卫已立**（dshIntegration.test.js：lib/*.js 必须全在同步清单）——新增插件文件忘了加清单会被测试当场拦（此事故已发生三次：fimRoutes/linkRoutes/editObserver）
- proposed API 唯一安全探测 = try/catch（见过两层：throwing getter + VS Code 1.123 的 call-time gate）
- SSE `/api/events.mux` **无回放**（连接即订阅）；回扫用 `/api/session.export`（fflate ZIP，根条目 session.jsonl；投影器已内置零依赖解析）
- interrupt 收割 agent 前必 `node --check` 全部改动文件（半截注释/半行会级联崩溃整棵测试树）
- 注释里勿写字面量 `**/*`（含 */ 会自闭合块注释）；JS 模板字面量内注意反引号
- 子代理模式经验：大任务阅读期可长达十余轮才落盘（正常）；文件集不相交才并行；orchestrator 收割流程 = 定向测试 → node --check → 精确文件切片提交；工作区共享，`git add` 必须列文件清单防扫入他人中间态
- F5 实测提示：扩展宿主激活时自动补齐 DSH home 运行副本（自愈同步）

## 开工动作建议
1. `git log --oneline -22` 对照上面提交链确认无人动过
2. 从「剩余工作」按优先级取件；子代理派发模板沿用本会话模式（事实基线/锚点/允许文件集/验收标准/纪律五段式）
3. 全绿后跑一轮完整门禁（沿用门禁会话的阶段结构：check:w0 → 插件 → extension-host → F5 人工矩阵 → FIM 复测），绿了做 D5 发版决策
