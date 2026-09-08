# 重构计划 · dsh-vs-sidebar（基于 2026-09 codemap 架构梳理）

> 目标：可读性/可维护性、可测试性、性能、为后续功能铺路。全程保持用户可见行为兼容，每阶段以 `npm run check:w0`（lint + 96 个测试文件 + 打包门禁 + 密钥门禁）为验收底线。

## 现状结论（来自 codemap）

- 架构整体健康：DI 工厂 + vscodeFacade 注入、协议契约冻结（src/protocol）、表驱动分类法（startupErrors/dshCompat）、分层特性注册（featureRegistry L0–L2）已是成熟模式，测试覆盖广（776 用例）。
- 主要债务集中在三处：
  1. **src/extension.js（~3100 行）**：自称 "wiring layer only"，实际聚合装配 + 命令注册 + 状态栏 + 重试编排 + 各特性 glue code，是所有模块的唯一消费者，认知负担与合并冲突热点。
  2. **runtime 边界管理碎片化**：home/profile（dshHome、profileScaffold、embedOverlay、hmrGuard、dshIntegration）、版本协商（dshCompat、runtimeResolver、localRuntimeResolver、shimResolver、launchMethodResolver）、子进程所有权（serverManager、processDiscovery、managedRuntimeLaunch）分属 ~14 个文件，无统一"runtime 身份"概念——README 路线图已明确此方向。
  3. **少数巨型域文件**：serverManager.js（1428）、changeTree.js（867）、editorContext.js（748）、changeTracker.js（735）、sessionNavigation.js（688）、dshChatClient.js（617）。

## Phase 1 — extension.js 瘦身（可读性/可测试性，风险低）

把组合根拆成与 featureRegistry 对齐的装配模块，extension.js 只保留 activate/deactivate 与顶层装配：

- `src/wiring/serverFeatures.js` —— openInBrowser/restartServer/stopServer/focusSidebar 命令 + 状态栏 + closePolicy/reconcile 逻辑
- `src/wiring/sessionCommands.js` —— New/Switch Session、sessionNavigation 装配、reveal 侧栏
- `src/wiring/bridgeFeatures.js` —— versionedBridgeServer + bridge/v3 + ch1/notifier + editorContext + providerDetector 装配
- `src/wiring/chatFeatures.js` —— chatParticipant + dshChatClient + sessionTitler + exportsFace + lmRoute + inlineCompletion
- `src/wiring/changeFeatures.js` —— changeTracker/changeTree/changeWatcher/editEventProjector 装配
- `src/wiring/mcpFeatures.js` —— mcp manager + consent 装配
- 每个装配模块导出 `createXxxWiring(ctx)` 返回 dispose 列表，纳入 featureRegistry LIFO teardown（模式已存在，照搬即可）
- 顺手落地 USABILITY-AUDIT U1（状态栏 command 一行）、U2（注入类配置变更提示重启）、U5（会话命令 reveal）

验收：extension.js ≤ 600 行；现有测试全绿；新增 wiring 层装配顺序测试。

## Phase 2 — Runtime Identity 统一（对齐 README 路线图，内部破坏性/行为兼容）

引入 `RuntimeIdentity` 冻结值对象，贯穿 prepare → spawn → authenticated readiness → teardown：

- `src/runtime/identity.js`：{home, profile, version, source(managed|local|command), executable, expectedApiSurface, instanceKey}
- 归并目录 `src/runtime/`：provisioner/resolver/downloader/installer/artifact/archive + dshHome/profileScaffold/embedOverlay/hmrGuard/dshIntegration + serverManager/processDiscovery/managedRuntimeLaunch（保持文件内聚，只移目录 + 统一入参为 identity）
- serverManager 拆分：spawn/health/closePolicy/registry 各自成模块（1428 行 → 4×~400）
- 端口发现、startup URL/token、健康检查全部挂到 identity 上，Diagnose 直接报告 identity 快照

验收：identity 单一来源；serverManager ≤ 500 行；startupStorm/cleanRestart/multiInstance 测试全绿。

## Phase 3 — 巨型域文件拆分（可读性，按需逐个）

- changeTracker：journal 持久化 / 状态机 / 快照恢复 三模块
- changeTree：tree provider / preview scheme / 命令 三模块；顺带 U6（viewsWelcome 空态）
- editorContext：按附件类型（file/selection/folder/problems）拆 handler 文件，共享预算工具
- sessionNavigation：transport（JSON-RPC POST）与 QuickPick UI 分离，transport 供 ch2 复用（已部分复用）
- dshChatClient：SSE 解析器独立成纯模块（lmRoute/fimRoutes 同型 SSE 代码在 runtime-integration/lib 也有一份，抽公共模式文档化）

## Phase 4 — 性能与打磨

- 启动路径审计：activate 里可延迟项（inlineCompletion、lmRoute、mcp、exportsFace）确认全部在 L1/L2 惰性层
- editorContext/diagnose 的 budgets 常量集中到一处配置
- bridge/v3（843 行）按资源域拆 terminal/tasks/debug/git/changes 子文件（handler map 合并即可）
- U7（Diagnose 人话化）、U8（findFiles 超时）、U9（端口 tooltip）

## 执行纪律

- 每阶段一个独立 PR/commit 序列，先测后改（现有 776 测试是安全网，Phase 1 前先补 extension.js 行为快照测试）
- 遵守仓库约定：CommonJS、零 npm 依赖、DI 工厂、冻结值对象
- 重构期间 codemap 增量维护：`node ~/.config/opencode/skills/codemap/scripts/codemap.mjs changes --root ./`
