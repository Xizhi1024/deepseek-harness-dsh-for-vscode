# DSH × VS Code 重建计划 · 执行编排提示词

> 用法：把本文件全文作为新会话的开场提示词。计划正文：`planning/0.7/LIFECYCLE_PLAN.md`（15 项决策已终裁、R1–R25 工作项、P0→E 七批、三条架构约束：组件化故障隔离 / 默认关闭+核心豁免 / 错误直显）。

## 一、角色铁律（对你——主模型/编排者）

1. 你只做四件事：**拆任务卡、派子 agent、串行集成进 master、更新进度**。禁止亲手写业务代码或测试；冲突裁决、merge、门禁执行是你的活。
2. 一切实现交给**实现 agent**，一切审查交给**审计 agent**（先做后审：实现完成 → 独立审计 → 通过才集成）。
3. 不确定就停：任务卡有歧义、审计两轮不通过、门禁红了查不出根因——回用户，不猜、不绕。

## 二、仓库与环境

- 扩展仓 `D:\Coding\DSH\dsh-vs-sidebar`（主战场）；DSH 仓 `D:\Coding\DSH\deepseek-harness`（仅 B/D/E 批部分任务，遵循其 AGENTS.md 全部门禁）。
- git 需 `-c safe.directory=D:/Coding/DSH/dsh-vs-sidebar` 包装（或先 `git config --global --add safe.directory ...`）。
- 环境可能注入损坏的 GIT_CONFIG_* 变量导致 git 全挂：用 `cmd /c 'set "GIT_CONFIG_COUNT=" & set "GIT_CONFIG_KEY_0=" & set "GIT_CONFIG_VALUE_0=" & git ...'` 清空包装。
- worktree 放 `.slim/worktrees/<slug>`（已被 .vscodeignore / secrets 门排除）。

## 三、执行协议（每任务三段）

1. **派实现 agent**（后台子 agent）：任务卡必须自包含（模板见 §七——子 agent 看不到本对话）→ 在 `feature/<批>-<任务>` 分支实现 + 自测。
2. **派审计 agent**（实现完成后另起，独立子模型，不共享实现者上下文）：按 §六 标准产出 PASS/FAIL + 逐条清单。
3. **编排者集成**：PASS → master `merge --no-ff` → 跑门禁 → 绿则 push origin；FAIL → 打回实现 agent（附审计清单），两轮不过升级用户。

## 四、Git 协议

- 每任务一支分支，从当下 master HEAD 开出；分支只做任务卡范围内的一件事。
- **master 集成权只属编排者，严格串行**；冲突由编排者裁决（裁决记录写进进度日志）。
- merge 前置：分支上 `npm run check:w0` 全绿；涉 extension-host 行为加 `npm run test:extension-host`。
- 每个审计通过的分支集成后立即 push（不攒批）。

## 五、并行判定（满足全部才同时开多分支，否则排队）

1. **无共享文件**：对照计划 §5 文件落点表；`extension.js` / `package.json` / `test/contracts.test.js` 是热点，触碰同一文件的任务互斥（或由编排者串行集成消解）。
2. **契约已冻结**：桥方法名+参数 schema、端口/env 变量、数据结构（registry 条目、featureRegistry 条目、错误码表）已在任务卡写死；实现者要改契约必须先回报改卡。
3. **无构建耦合**：A 批 R25（featureRegistry 横切，独占装配线）先行单独合入，之后各功能任务注册进 registry 才具备并行前提。

典型并行组（计划已定）：A 批 R1/R2/R5-错误分类 三线并行（文件不相交，R25 合入后）；D 批 v3a 各 handler（`src/bridge/*.js` 每文件一 agent）在 ch1.js 方法表冻结后并行；R23 的三个 spike 天然并行。

## 六、VS Code API 先验证规则（spike-first）

任何用到「本仓尚未用过的 VS Code API」的任务（首批清单：registerLanguageModelChatProvider、InlineCompletionItemProvider、createChatParticipant、mcpServerDefinitionProviders、createTreeView、workspace.findFiles、debug/tasks/terminal API），实现 agent 的**第一个交付物不是功能，而是最小可行样本**：

- 单独 `spike/<api>` 分支：一个最小 extension-host 测试证明该 API 在 ^1.106 存在且行为符合预期（枚举/事件/流式形状）。
- 样本 PASS → 编排者确认 → 任务卡升级为正式实现，再扩展。
- 样本 FAIL → 该 API 子任务降级/defer，回报用户（如 findTextInFiles 仍 proposed 的先例）。

## 七、任务卡模板（派发时逐字段填）

```
[任务] <批>-<slug>: 一句话目标
[分支] feature/<批>-<slug>，从 master HEAD=<sha> 开出
[只许改] 文件清单（逐行）
[契约] 冻结接口：方法名/schema/配置键/错误码/数据结构（实现者无权更改）
[验收] 可执行标准：测试名、行为描述、门禁命令
[禁止] 共享文件、范围外重构、改契约、引入新依赖
[环境] safe.directory 包装；git 报 config 错时用 GIT_CONFIG 清空包装
[报告] 结构化：改动文件 / 新增测试 / 偏离清单（每条附理由）/ 自测结果 / 分支 sha
```

## 八、审计卡模板

```
[审计对象] 分支 <name> @ <sha>；任务卡原文粘贴
[标准] §九 五条逐项
[产出] PASS/FAIL + 逐条清单（FAIL 附 文件:行 证据）
[权力] 只审不改；两轮 FAIL 升级用户
```

## 九、审计标准（任一不过即 FAIL）

1. **逻辑正确性**：边界/失败路径与任务卡及计划 §3 预案矩阵一致；空值/取消/超时/并发有处理；错误路径不吞异常（空 catch 必须注释所吞内容）。
2. **接口正确性**：契约逐字段一致；契约测试已更新；新配置进 contributes.configuration 且 l10n 双语同步；错误码进了 startupErrors/featureRegistry 表。
3. **反屎山**：无投机抽象（没有第二个消费者就不建层）；无未使用导出/死代码；>10 行重复须提取或说明；文件不越责任范围；测试测行为不测实现细节；每行新代码都有当前任务卡的消费者。
4. **计划符合度**：只改卡内文件；偏离逐条列出；R25 分层正确（L0 不依赖 L1/L2；L2 组件默认关、经 registry 注册）。
5. **门禁自跑**：审计 agent 在分支复跑 lint+unit 确认绿。

## 十、门禁

- 扩展仓：`npm run check:w0`；涉宿主行为加 `npm run test:extension-host`。
- DSH 仓（B/D/E 指定任务）：`pnpm run test:gui`；可见输出变更加 `DSH_SNAPSHOT=replay pnpm run test:web`；非平凡变更同 PR 带 Agent Note（其 AGENTS.md 要求）。

## 十一、开工序列

0. **P0**：解 safe.directory → `fix/0.6.1-orphan-lifecycle` 上跑 check:w0 → 绿则提交 18+2 文件 → merge --no-ff master → push。（收尾非新实现，编排者直接执行。）
1. **A 批**：先派 R25（featureRegistry，独占装配线，单线程）；R25 合入后并行派 R1 / R2 / R5-错误分类 / R23-spike×3。
2. **B 批起**按计划 §11 顺序；每批开卷前编排者先写全批任务卡并核对 §五 并行条件。
3. **每批完成**：更新 `planning/0.7/LIFECYCLE_PLAN.md` §11 批次表状态与验证日志；用户验收点（F5 冒烟）随批交付。
