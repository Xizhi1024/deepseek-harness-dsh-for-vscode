# 1.1.0 完整迭代计划（唯一主计划）

> 自包含：本文吸收全部验收发现（.dsh-accept-test/ACCEPTANCE-REPORT.md）、可用性审计
> （USABILITY-AUDIT.md）、变更追踪设计（PLAN-1.1.0-changes-tracker.md，细节仍可参考原文）。
> 新会话从本文开工即可，无需回读历史会话。
> 基线：master = 1.0.2（b085bab）。里程碑：M-A 快改 → M-B 语义修正 → M-C 变更追踪 → M-D 收尾发版。

## 零、全局设计原则

1. **零输入**：任何能点选的不得要求手输（7 处 showInputBox 裁定见 USABILITY-AUDIT.md 专节）。
2. **同意门保持**：一切可执行/可变更能力挂显式开关；默认开启的仅限审批保护下的低风险项。
3. **测试先行**：每项改动先写/改单测；发布前跑 check:w0 + extension-host + F5 冒烟。

## 一、Milestone A：快改批（1 天，全部 ≤ 几十行）

| # | 任务 | 来源 | 实现 | 验收 |
|---|---|---|---|---|
| A1 | 状态栏可点击 | U1 | `statusBar.command='dsh.focusSidebar'` + tooltip（Restart/Stop/Diagnose/新实例） | 点击开关侧边栏 |
| A2 | 设置变更重启提示 | U2 | onDidChangeConfiguration 白名单补 `dsh.fim.*`/`features.*`/`bridge.*` → 信息弹窗 "Restart now?" | 改 FIM 设置弹提示，确认即重启生效 |
| A3 | MCP forget 下拉化 | U4 | extension.js:2466 showInputBox → showQuickPick（列 consent 记录）；Forget 后复调须再询问的 bug 一并修 | 全程无手输 |
| A4 | 会话命令 reveal | U5 | newSession/switchSession 成功路径追加 focusSidebar | 命令后侧边栏可见 |
| A5 | 变更树空态引导 | U6 | contributes.viewsWelcome："DSH 通过桥推送编辑时出现在这里" | 空树显示引导文案 |
| A6 | 端口可见 | U9 | 实际端口 ≠ 3080 时 tooltip 标注 | 冲突降级后 tooltip 可见端口 |
| A7 | 主视图入口三层 | U13 | ①view/title "在编辑器中打开" 图标 ②editor/title DSH 图标 ③multiInstance.entry 默认 true + Ctrl+Alt+N | 三入口均能开新实例；面板可分栏停靠（=U12 交付） |
| A8 | 终端回读 | issue #7 | terminal/create 时订阅 `window.onDidWriteTerminalData` 写 ring（容量/裁剪沿用） | sendText `node -e "console.log(42)"` 后 read 含 `42` |
| A9 | dshVersion 探测 | issue #5 | localRuntimeResolver 读包 version 失败路径补全（兼容性 WARN 根因）；theme/toolsV3 门控随之恢复 | Diagnose 无 unknown WARN；M1 主题跟随可验 |
| A10 | FIM 翻案重测 | 验收 M8 | 不改代码：pull≥1.0.2 + tab-completion 开 + baseUrl/key 配齐 + Restart 后按 M8 清单复测 | 幽灵文本出现/Tab 接受；仍失败才另立案 |

## 二、Milestone B：语义与体验修正（2 天）

### B1 变更评审语义重排（issue #3）
- 现状缺陷：push 即 applyEdit 落盘；Accept 仅记账；undo 反向 WorkspaceEdit 被 applyEdit 拒（changeTracker.js:434）。
- 方案：
  1. `vscode/changes/push` 改为 **pending**：journal 记录 + 树刷新，**不写盘**；
  2. Accept = 才执行 applyEdit（成功后状态 accepted；失败弹错并保持 pending）；
  3. Undo：pending 条目直接丢弃（无盘上影响）；已 accepted 条目走 checkpoint 反向还原——先修 434 行反向区间构造（用快照整文件替换式 WorkspaceEdit 替代增量反向，规避区间漂移）。
- 验收：推送后文件未变 → Accept 后变 → Undo 还原；applyEdit 失败有可见错误。

### B2 @dsh 参与者三连修（issue #4）
1. 会话路由：resolveCommand 复用当前 workspace 活跃会话（dshChatClient 已有枚举），无则建且缓存 per-workspace，不得每条消息新建（根治 session 爆炸）；
2. 裸 UUID：新建会话立即 patch 标题（"VS Code @dsh · <workspace 名>"）；
3. `session-session-` 双前缀：会话 id 派生处（dshChatClient/workspaceBinding）去重前缀拼接；
4. 流式断链：核对 session.prompt queue 模式的 delta 订阅 → chat response转发链路。
- 验收：连发 3 条消息只增 0 个会话；聊天视图有流式回复；会话标题可读。

### B3 回复路径 linkify（issue #6）
- 位置：runtime-integration/dsh-vscode-integration/lib/client.js（DSH 侧客户端插件，DOM 后处理）。
- 对消息容器内 `file:///` 与工作区相对路径（含 :line）包可点元素 → postMessage 到 frame 壳 → 复用 text-document 桥 open。
- 验收：`hello.js` / `src/x.js:42` / `file:///D:/…` 三形态可点且在本窗口打开。

### B4 findFiles 防护（U8）
- 桥 handler 加超时（默认 5s）+ 默认 exclude（node_modules/.git/dist/out）；超时返回带提示空结果。

### B5 快捷键策略（U3）
- Ctrl+L 默认开（仅加草稿不发送，低风险）；Ctrl+K 保持 opt-in 但 onboarding 提供"启用并绑定键位"一键项。

## 三、Milestone C：变更追踪三层（2.5 天，PLAN-1.1.0-changes-tracker.md 全文仍有效）

### C1 journal v2 + watcher 兜底（先做，零风险）
- entry 增 `source: bridge|tool-intercept|external`；旧数据读入补 'bridge'；
- `createFileSystemWatcher('**/*')` + 500ms 去抖 + git 对账（复用 vscode/git/getStatus|getDiff 逻辑）；尊重 files.watcherExclude；
- 去重：与桥内/拦截记录按 (path, mtime±1s) 合并；
- 树分组改 (source, sessionId?)：三组=桥内审批/工具拦截/外部变更；
- undo：external 条目优先 beforeSnapshot，无快照且 git 干净基线时 `git checkout -- <file>`（带确认弹窗）。

### C2 工具层拦截（P0 spike 定可行性）
- dsh-vscode-integration 已 inject tools 服务；spike 验证：调用事件钩子 or 注册期 wrap edit/write；
- 捕获 {tool, path, sessionId, beforeText}（≤1MiB 快照，超限标记）；
- 通知 `vscode/dshEditObserved`（元数据 only；schema bump 走 v2 notifications 扩展）；
- `dsh.changes.mode: review|observe|off`（默认 observe）：review = 工具调用暂挂 ≤30s 等审批，超时按 observe 降级并记日志。

### C3 MCP env 密钥联动（零输入 ⚠️ 项）
- manager.js:65 askInput 前：先查 VS Code secretStorage 同名 key（如 OPENAI_API_KEY）→ 命中免问；key 名含 KEY/TOKEN/SECRET 时 password:true；问完存 secretStorage。

## 四、Milestone D：收尾（1 天）

1. **断点桥**（issue #8）：`vscode/debug/listBreakpoints|addBreakpoints|removeBreakpoints`；官方 API `vscode.debug.breakpoints` / `addBreakpoints([new SourceBreakpoint(new Location(uri, new Position(line,0)))])`；参数 1-based 入口转 0-based；**勿用** customRequest('setBreakpoints')（替换语义绕过 UI 簿记）；v3 方法表 32→34 + 契约测试。
2. **Diagnose 改版**（U7）：QuickPick 分区（服务/桥/兼容性/插件）；错误码→人话+建议动作；JSON 留 OutputChannel。
3. **onboarding 改版**（U11）：profile 步改 QuickPick 列已有 profiles（接 profileProbe）；feature 步加 description；新增可选 "Tab 补全配置" 步（端点下拉+key+重启三并一，即零输入 FIM 命令，也可独立命令先做）。
4. **文档**（U10）：README 兼容性表加 WSL 默认终端坑；Diagnose 检测默认终端 WSL 时提示。
5. 版本 1.1.0、CHANGELOG、README 配置表补 `dsh.changes.mode`、全量验证（check:w0 + extension-host + F5 全矩阵冒烟）。

## 五、明确不做（本轮）

- Container MCP（验收"附"失败项）：文档说明即可。
- dsh-std 对齐：触发条件未满足（见 2026-08-28 评估），仅保持观察。
- 上游 DSH Web UI 的修改（linkify 已绕开：走 client 插件 DOM 层）。

## 六、风险与回退

| 风险 | 缓解 |
|---|---|
| cordis tools 拦截 API 不稳定 | C2 独立于 C1，spike 失败则 1.1.0 只发 C1（watcher 已覆盖 90% 价值），C2 转 1.2.0 |
| pending 语义改变破坏现有用户预期 | CHANGELOG 置顶说明 + 迁移提示；树内对旧 journal 条目显示 legacy 标记 |
| watcher 大仓库性能 | 尊重 watcherExclude + git 对账节流 + 熔断（单窗口事件 >N/s 时降级为 git 轮询） |
| 1.0.x 用户设置漂移 | 全部新默认值只影响未显式设置的用户（VS Code 配置语义天然保证） |

## 七、issue 映射

#3→B1 · #4→B2 · #5→A9 · #6→B3 · #7→A8 · #8→D1 · #9→A1-A7/B4/B5/C3/D2-D4（对应关系见各任务"来源"列）
