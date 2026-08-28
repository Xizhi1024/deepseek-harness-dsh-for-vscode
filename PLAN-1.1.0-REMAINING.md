# PLAN-1.1.0 剩余工作交接（REMAINING）

> 生成于 1.1.0 执行会话收尾。本分支（feature/1.1.0）已落地 M-A 全部、B1/B3/B4/B5、C3、D4 的 README 部分。
> 以下为未落地项 + 全部已验证的代码锚点/预答结论，新会话/新 agent 可直接从本文开工，无需回读执行会话。

## 已落地（提交链）

```
4433a07  docs(plan) 基线
b76c3b7  feat(A) A1-A9 快改批（17 文件 +548/-16）
49505ee  feat(B3) linkify 回复路径（6 文件 +1307，含 35 新测试）
9806e7d  feat(B) B1 pending 语义 + B4 findFiles 防护 + B5 快捷键策略 + D4 README WSL 条目（16 文件 +419/-86）
ddfb734  feat(C3) MCP env 密钥联动 secretStorage（3 文件 +123）
```

验证状态：npm test 620/619 pass/0 fail/1 skip；lint 155 JS + 6 JSON 干净；插件侧 node --test 89/89。
版本号仍为 1.0.2（发版决策留给维护者：剩余项做完再切 1.1.0，或以当前范围发 1.1.0 并把下面项转 1.2.0）。

## 剩余项（按优先级）

### B2 · @dsh 参与者三连修（issue #4）
两任 agent 均零产出，无代码可参考。锚点：
- src/chatParticipant.js（265 行，resolveCommand ~250 行附近）
- src/dshChatClient.js（562 行，SSE delta 订阅 ~340 行）
- src/context/workspaceBinding.js:179 createSession
- src/sessionNavigation.js（listSessions/createSession；377/429 行附近）
- 双前缀是运行时现象（源码无字面 "session-session-"），沿 id 派生链路实测定位
- 验收：3 条消息 0 新会话；标题可读；流式转发

### C1 · journal v2 + watcher 兜底
- src/changeTracker.js 现状（B1 后）：entry 有 id/ts/sessionId/label/at/status(pending|accepted|undone|discarded)/edits/before
- C1 需要：entry 加 source: 'bridge'|'tool-intercept'|'external'（读旧 journal 补 'bridge'）；
  createFileSystemWatcher('**/*') + 500ms 去抖 + git 对账（复用 v3 里 vscode/git/getStatus|getDiff handler 的实现思路）；
  尊重 files.watcherExclude；单窗口事件 >N/s 熔断降级 git 轮询；
  去重按 (path, mtime±1s)；树分组改 (source, sessionId?) 三组；external undo 优先 beforeSnapshot，无快照且 git 干净时 git checkout -- <file>（确认弹窗）
- src/changeTree.js 245 行，现按 sessionId 分组（81-116 行）

### C2 · 工具层拦截（P0 spike 已预答 ✅）
预答结论（读 DSH 运行时源码得出，位置 C:\Users\MSI\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-tools\lib\index.js）：
- 3105 行：`const gate = await this.ctx.waterfall(carrier, "tools/pre-execute", exec, () => Promise.resolve({ kind: "allow" }));` —— 异步 waterfall，可返回 gate 决策
- 2805 行：`ctx.tools.guard(fn)` 同步拒绝 API（返回字符串即拒绝）
- 3367 行：tools/post-execute 事后观测
- exec 携带 name/callId/agent(→session)/signal/rootCallId
- 实现路径：dsh-vscode-integration 插件 ctx.on('tools/pre-execute') 过滤 exec.name ∈ {edit,write}，读参数快照 beforeText（≤1MiB），经桥发 vscode/dshEditObserved 通知
- 桥侧：src/versionedBridgeServer.js _dispatchFrame(:238) 现只处理请求帧+$/cancelRequest——需补入站通知帧路由（v3 通知白名单）
- review 模式（暂挂 ≤30s 等审批，超时降级 observe）用 waterfall 的异步 gate
- dsh.changes.mode: observe(默认)/review/off 配置，由扩展经 initialize 结果或专用请求下发给插件
- 插件侧工具注册处 runtime-integration/dsh-vscode-integration/lib/tools.js:494-511 有 defineTool 注入缝（只适合包本插件自注册工具，不适合拦核心 edit/write——勿走弯路）

### D1 · 断点桥（issue #8）
- v3 方法表 32→34：vscode/debug/listBreakpoints|addBreakpoints|removeBreakpoints
- 官方 API：vscode.debug.breakpoints / addBreakpoints([new SourceBreakpoint(new Location(uri, new Position(line,0)))])
- 参数 1-based 入口转 0-based；勿用 customRequest('setBreakpoints')（替换语义绕过 UI 簿记）
- 同步改：src/bridge/v3.js debug 区（~238-282 行）、runtime-integration lib/tools.js METHOD_SCHEMAS（~203-214 行）、契约测试、INTEGRATION_FILES 无需动（tools.js 已在清单）
- test/extension-host/run.js 断言精确命令清单——若新增 contributes 命令需同步（本项不加命令，仅桥方法）

### D2 · Diagnose 改版
- QuickPick 分区（服务/桥/兼容性/插件）；错误码→人话+建议动作；JSON 留 OutputChannel
- 顺带：检测默认终端为 WSL 时提示（README 条目已先行落地，文案见 README.md 兼容性表）

### D3 · onboarding 改版 + FIM 零输入命令
- src/onboarding.js（327 行）六步向导：profileStep(104 行,InputBox→改 QuickPick 列 profileProbe 探测的已有 profiles)、featureStep(170 行,加 description)、新增可选 "Tab 补全配置" 步（端点下拉+key+重启三并一）
- FIM 零输入也可独立命令先做（dsh.fim.setApiKey 已存在）
- 注意 B5 已落 ctrl-k 一键项于 featureStep，避免冲突

### A10 · FIM 手动复测（不改代码，需人工 F5）
前置：pull ≥1.0.2 代码（本分支即可）、dsh.features.tab-completion 开、dsh.fim.baseUrl 与 API key 配齐、Restart DSH Server。
清单：① 扩展宿主里打开 .js/.ts 文件光标停住 → 幽灵文本出现；② Tab 接受；③ Esc 拒绝；④ baseUrl 缺失时 /api/fim 503 带指引；⑤ DSH 侧日志有 /api/fim 命中记录。仍失败才另立案。

### D5 · 发版收尾（等上面做完）
版本 1.1.0（或裁决范围后定）、CHANGELOG 去掉暂缓标记中已落地项、README 配置表补 dsh.changes.mode（若 C2 落地）、check:w0 + extension-host + F5 全矩阵冒烟、vsce package。

## 执行环境备忘
- git 需先 `Remove-Item Env:GIT_CONFIG_* -ErrorAction SilentlyContinue`（本机残留变量干扰）
- 测试基线在本分支 = 620 tests/619 pass/1 skip（pre-existing skip）
- 子 agent 模式经验：大任务（≥9 项）单 agent 阅读期可长达十余轮才落盘；写盘后全程锚点式 edit 安全；interrupt 收割前先跑 node --check 全部改动文件（被打断的注释/半行会造成级联语法错误——本轮 v3.js:287 教训）
