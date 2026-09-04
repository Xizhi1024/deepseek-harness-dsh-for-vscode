'use strict'; // (标记为文档，无代码)
# HANDOFF-3 · 变更树调试移交档案（2026-09-04 深夜会话）

> 移交对象：下一会话（直接接收本对话记录）。本文是仓库侧的持久档案，含全部已修项、两个未解 bug 的证据与假设、环境坑与测试方法。

## 0. 一页结论

- **会话主线**：审计 → 架构梳理 → 三轮实测排障（kind 事故 → 变更树三连 bug → before 快照链）。
- **已落地**：11 个修复（下文 §2），新增测试 33 例，全绿（changeTree 20 / changeTracker 23 / editObserver 12 / hmrGuard 7 / syncGuard 6 / sessionFollow 6 / extension 37 / 桥 dshEditObserved 8 / webviewMessages 6 / toolEditAttribution 4）。
- **未解两个 bug**（§3）：① 部分条目打开差异仍报 "This file has been deleted"；② 撤销变更无反应。
- **本机环境关键事实**（§5）：三个扩展版本共存互写、DSH 沙箱命名管道限制的测试跑法。

## 1. 时间线（本轮会话）

1. 六路 subagent 审计（轨迹/边界/版本/平台/测试/F5）→ 主报告见对话；docs/dev 三个被引用目录实际缺失。
2. 架构梳理（三路 subagent）：激活链 L0/L1/L2×16 特性、运行时供给双指针、桥 35 方法+7 事件、变更三源汇流、台账 11 处。
3. 实测排障：
   - a) kind 事故（session-984d0aad 全工具 0ms 失败）：取证链 = 会话 zstd 解码 6/6 全败、实例启动即坏、0.9.3/1.0.0/1.1.1dev 三版本互写 profile 集成包（INTEGRATION_FILES 5 vs 8）。**观察器侧真正机理由用户自行发现并修复**：`tools/pre-execute` 监听器不调用 `next()` 会短路 cordis waterfall → dsh-tools 读 `gate.kind` of undefined（editObserver.js 现有注释 + editObserver.test.js:90 回归测试为权威表述）。
   - b) 变更树三连 bug 修复（§2 F4-F8）。
   - c) before 快照链落地（§2 F9）。

## 2. 已落地修复清单（全部有测试）

| # | 修复 | 文件 | 测试 |
|---|---|---|---|
| F1 | 集成包同步版本守卫：`.vscode-sync.json` marker + 外来文件清扫 + versionChanged/foreignRemoved 诊断 | src/dshIntegration.js | syncGuard 6 |
| F2 | hmrGuard.ensureHmrDisabled + ServerManager `runtimeProfileGuard` spawn 前自动止血（防重复条目、原子写、备份） | src/hmrGuard.js(新), serverManager.js, extension.js | hmrGuard 7 |
| F3 | 会话视图纳入会话期间 external 条目（`external-session` 分组，setActiveSession 时间窗 +1ms 确定性） | src/changeTree.js | changeTree 内含 |
| F4 | 删除文件 openDiff：有快照→只读开快照；无快照→明确提示，不再把缺失路径交给 vscode.open | src/changeTree.js | changeTree 内含 |
| F5 | recordToolEdit 漏斗路径归一化：相对路径按 [boundCwd+工作区根] 绝对化（存在性优先） | src/changeTracker.js(normalizeToolEditPath), extension.js:1626 漏斗 | toolEditAttribution 4 |
| F6 | watcher 去重 sameFsPath（resolve+win32 大小写/分隔符不敏感）——消灭同一写入双记账 | src/changeWatcher.js | toolEditAttribution 内含 |
| F7 | iframe 内切换对话反向通知链：client.js 轮询 sessions 镜像 current(800ms,unref) → 壳层 dshSessionChanged → sessionChanged → 变更树/绑定/投影器跟随（不重载 iframe） | client.js, webviewHtml.js, webviewMessages.js, extension.js(两处 handler + handleSessionChangedFromWeb) | sessionFollow 6, webviewMessages 6 |
| F8 | 相对路径条目目标解析（entryTargetFsPath 按工作区根绝对化）——修复存在文件被误报 deleted | src/changeTree.js | changeTree 内含 |
| F9 | beforeText 全链：观察器 pre-execute 携带真前置内容（≤1MiB，超限纯元数据）→ 桥验证 → 漏斗落快照 → openDiff 真 diff（快照 vs 当前）→ Undo 恢复真前置 | editObserver.js, versionedBridgeServer.js, extension.js, changeTree.js | editObserver 12, 桥 8, changeTree 20 |

CHANGELOG.md [Unreleased] 已记录 F1-F9；VERSIONS.md 有 Round 2026-09-04 条目（事故取证链）。

## 3. 未解 bug（✅ 均已由接手会话于 2026-09-05 修复，见 CHANGELOG [Unreleased]「移交档案 HANDOFF-3 两个未解 bug」；changeTree 22/22 含新增回归：跨窗口注入根解析 / undo 静默分支反馈。以下为原始取证记录）

### ① 打开差异仍报 "This file has been deleted; there is nothing to diff or open"

**现象**：Reload 后点击（推测为旧 journal 的）条目仍出此提示。

**已知机制**（changeTree.entryTargetFsPath → openDiff deleted 分支）。

**主假设——跨窗口相对路径**：旧 tool-intercept 条目 path 是 `deepseek-harness-dsh-for-vscode\...`（相对 D:\Coding\DSH 实例 cwd）。若当前窗口工作区根是**扩展仓库**（F5 窗口），相对路径 resolve 到 <仓库>\deepseek-harness-dsh-for-vscode\... 不存在 → 回退 roots[0] 仍不存在 → 误报 deleted。F5 窗口的 workspaceFolders 不含 D:\Coding\DSH。
**修法建议**：changeTree 的 workspaceRoots() 同样并入 `boundCwd`（extension 侧把 boundCwd 传给 createChangeTree，或 changeTree 增加可选 roots 注入）；顺带把 D:\Coding\DSH 作为多根场景验证。
**次假设**：条目本来就是测试"删"产生的（合法提示，但应同时显示快照——若快照存在却没走快照分支，查 F4 分支顺序：deleted 分支在 diff 分支之前，快照存在时已回退展示；若用户看到的条目无快照则符合预期，仅需文案区分"已删除（测试删除产物）"）。
**排查**：读 journal 尾部（路径见 §4）确认点击条目的 source/path/beforeSnapshotPath；在 entryTargetFsPath 临时加 appendDiagnostic 打印 roots 与 resolve 结果。

### ② 撤销变更无反应

**现象**：树节点右键 Undo 无任何可见反馈。

**已知机制**（changeTree.undo → undoAttributed，changeTracker.js undo/accept）。
**候选假设（按可能性）**：
1. 静默短路：entry.status 已是 undone/discarded → 返回 {undone:false, reason:'already-undone'}，**无任何 UI 提示**（树描述可能不显眼）。修法：各静默分支补 showInformationMessage/更新描述。
2. 相对路径残留：undoAttributed 的 targetPath 解析失败 → {undone:false,'no-target-path'} 同样静默（F8 修了 openDiff 的解析，undo 走同一 entryTargetFsPath——已绝对化，应连带修好；但旧条目跨窗口场景同 bug①）。
3. 确认对话框语言：showWarningMessage 按钮 loc('Undo') 本地化为中文，choice 比较一致应无误；但若用户没点对话框而点了别处 → cancelled 静默。
4. git 路径失败有 showErrorMessage，不应"无反应"——故更可能是 1/2 的静默分支。
**排查**：在 undo/undoAttributed 每个 return 点前加 appendDiagnostic；检查被点条目的 status 与 beforeSnapshotPath。

**建议补的测试**：undo 静默分支的用户反馈（fake messages 断言）；跨窗口相对路径 roots 注入。

## 4. 调试资源坐标（本机）

- 真实 journal：`C:\Users\MSI\AppData\Roaming\Code\User\globalStorage\xizhi1024.dsh-vs-sidebar\changes\journal.json`（+ snapshots/chg-*）
- 实例注册表/心跳/服务器日志：同目录 `dsh-instances.json`、`heartbeat\dsh-w-*.json`、`dsh-server-<port>-<pid>.log`
- DSH home：`C:\Users\MSI\.dsh`（profiles/web/cordis.patch.yml 已有 hmr disabled 行 + vscode-integration insert）
- 会话解码：`node .dsh-accept-test/zstd-walk.js <session.jsonl.zstd> out.jsonl`（Node24 zstdDecompressSync；会话目录 ~/.dsh/sessions/<工作区slug>/）
- 扩展安装目录：`C:\Users\MSI\.vscode\extensions\xizhi1024.dsh-vs-sidebar-{0.9.3,1.0.0}` 仍共存

## 5. 环境坑（下一会话必读）

1. **测试跑法**：本 DSH 沙箱禁止 pwsh 直接以管道拉起外部程序（EPERM "拒绝访问"/named pipe）。跑测试用：
   `$p = Start-Process node -ArgumentList '<file>' -NoNewWindow -PassThru -RedirectStandardOutput out.log -RedirectStandardError err.log; $p.WaitForExit(30000)` 然后读 log。
   `node --test` 会 spawn 子进程同样被拒——直接单文件执行。scripts/lint.js 用 spawnSync 同样跑不了（环境问题，非代码问题）。
2. ExitCode 在 CLM 下可能读不到——用输出里的 `pass/fail` 计数判断。
3. pwsh 命令里不要混入直接 node 调用（整条命令会被拒）。
4. **运维待办（用户侧）**：卸载 0.9.3/1.0.0 旧扩展；多版本开发期避免 shared home 并存。

## 6. 本会话改动文件清单

src/: dshIntegration.js(重写+守卫), hmrGuard.js(新), serverManager.js, extension.js, changeTree.js, changeTracker.js, changeWatcher.js, webviewHtml.js, webviewMessages.js, versionedBridgeServer.js
runtime-integration/dsh-vscode-integration/lib/: client.js, editObserver.js
test/: unit/dshIntegrationSyncGuard.test.js(新), unit/hmrGuard.test.js(新), unit/toolEditAttribution.test.js(新), unit/changeTree.test.js(+4 例/改 2 处), webviewMessages.test.js(+1), runtime-integration .../test/editObserver.test.js(期望更新)
docs: CHANGELOG.md, VERSIONS.md, 本文件
