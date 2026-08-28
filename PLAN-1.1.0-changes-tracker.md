# DSH Changes 升级方案（1.1.0）：全源变更追踪

## 现状缺口

变更树只覆盖一条链路：VS Code 侧边栏会话 → agent 调用 `vscode/changes/push` → 树 + 审批。
其余一切写入（DSH Web GUI、CLI、其它机器/客户端、以及任何不经桥的 agent 工具调用）对树不可见。
本次升级目标：**追踪 DSH 工具层发出的 edit 类命令 + 兜底捕获全部磁盘变更**，让"DSH 变更"成为工作区 AI 改动的统一审计视图。

## 三层设计

### L1 · 工具层主动归因（准确、可前置审批）

在 DSH 侧 `dsh-vscode-integration` 插件内拦截工具执行。插件已 inject `tools` 服务。

- 拦截点（按可行性排序）：
  1. cordis tools 服务的调用事件/中间件（若提供 `tool/before-execute` 类钩子，首选）；
  2. 包装已注册工具的 execute（注册期 wrap，同名同 schema，内层调原实现）；
  3. 兜底：不拦截，仅靠 L3 观测（P0 spike 先验证 1/2）。
- 捕获对象：`edit` / `write`（以及未来新增的落盘类工具）。记录
  `{ tool, path, sessionId, beforeText, ts }`；before 快照在调用前读盘（≤1MiB，超限标记 truncated）。
- 通道：经版本化桥发元数据通知 `vscode/dshEditObserved`（notifications 走 v2+ schema，新增类型需 schema bump；只带 path/size/rev，不带正文，正文由扩展侧自行读 journal 文件或 L1 落盘快照）。
- 审批语义（对齐 Codex 的 suggest 模式）：`dsh.changes.mode: review` 时，L1 可选择 **pre-approval**——工具调用被暂挂，扩展弹审批，拒绝则返回拒绝给工具层（agent 收到"用户拒绝写入"继续对话）。这是与 Codex `--ask-for-approval on-request` 等价的能力。

### L2 · 桥内审批（现状，保持不变）

`vscode/changes/push`（vscode_changes_push 工具）继续作为"侧边栏 agent 显式推送编辑"的第一优先通道，语义与 1.0.x 完全兼容。

### L3 · FileSystemWatcher 兜底（全源覆盖，学 Codex 的"落盘后靠 git 审"哲学）

Codex 的做法：沙箱内直接落盘（workspace-write），**不逐笔拦**，审查靠 git diff / SCM 视图的 hunk 级 stage/discard。我们借鉴为兜底层：

- `workspace.createFileSystemWatcher('**/*')` + 500ms 去抖合并；
- 与 git 状态对账（内置 Git 扩展 API，桥里 `vscode/git/getStatus|getDiff` 已有现成实现可复用）：只收 workspace 内、受信任目录、非 .git 的变更；
- journal 记录 `{ path, source: 'external', gitDirty: bool }`；
- **去重**：与 L1/L2 记录按 (path, mtime±1s) 合并——同一次写入若已被 L1 归因，则 watcher 只补 mtime，不重复建条目。

## Journal v2（changeTracker 演进）

```
entry = {
  id, ts,
  source: 'bridge' | 'tool-intercept' | 'external',
  sessionId?: string,          // L1/L2 有；L3 无
  tool?: 'edit' | 'write' | 'vscode_changes_push',
  path, before?, edits?, status: pending|accepted|undone,
  beforeSnapshotPath?,         // globalStorage 下的快照文件（undo 用）
}
```
迁移：读旧 journal 时缺 source 字段补 `'bridge'`。

## 树视图升级

- 分组键从 sessionId 改为 `(source, sessionId?)`：三个顶层组——桥内审批 / 工具拦截 / 外部变更（含 Web GUI 等）。
- 动作不变：openDiff（before 快照 vs 磁盘当前）/ accept（清除 pending）/ undo：
  - L1/L2：精确还原（beforeText / 快照）；
  - L3：有 beforeSnapshotPath 用快照；否则 git 有该文件历史时 `git checkout -- <file>`（需一次确认弹窗，防止丢弃手改）。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `dsh.changes.mode` | observe | review=工具级前置审批；observe=全源只记录不拦（推荐起步值）；off=退回 1.0 行为（仅桥内） |

observe 为默认的理由：拦截工具调用对 DSH 各版本 cordis 服务的兼容性是本方案最大风险（P0 spike 决定 review 何时放开），watcher 层则零风险先行。

## Codex 对照（为什么这样设计）

| 维度 | Codex | 本方案 |
|---|---|---|
| 落盘方式 | 沙箱内直接写（Seatbelt/Landlock 限 workspace） | 桥内审批前置 / 工具拦截前置 / watcher 事后 |
| 审查 UI | git diff + SCM hunk 级 stage/discard；IDE 扩展内联 diff accept/reject | 变更树 diff/accept/undo（等价于 hunk 级的文件级简化版） |
| 审批模式 | suggest / auto-read / full-auto 三档 | review / observe / off 三档 |
| 归因 | 单一 agent 进程，无需归因 | 多客户端生态，L1 归因是差异化能力 |

## 分期

- **P0 spike（0.5d）**：验证 cordis tools 拦截可行性（事件钩子？注册期 wrap？）；产出决定 review 模式时序。
- **P1（1d）**：journal v2 + watcher + 去重合并 + 树分组 external。
- **P2（1d）**：L1 拦截 + `vscode/dshEditObserved` 通知 + review/observe 开关。
- **P3（0.5d）**：undo 语义（快照/git checkout + 确认弹窗）、README、契约测试更新。

## 风险

1. cordis tools 拦截 API 不稳定 → observe 默认 + L3 兜底已覆盖 90% 价值；
2. watcher 在大仓库的性能 → 复用 git 对账节流 + 忽略规则同 LSP（node_modules 等由 files.watcherExclude 尊重）；
3. pre-approval 暂挂工具调用可能超时 → 暂挂上限 30s，超时按 observe 处理并记日志。
