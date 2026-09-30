# HANDOFF: DSH 0.2.0-rc.2 适配（1.2.1）

日期：2026-09-30。执行计划：[PLAN-DSH-0.2.0-rc.2-ADAPTATION.md](PLAN-DSH-0.2.0-rc.2-ADAPTATION.md)。分支 `adapt/dsh-0.2.0-rc.2`（基线 4e12cca = 1.2.0 候选冻结快照；master 未动）。

本文只声明已验证的事实；安装态 VSIX、浏览器 UI 与升级复现验收未完成，见「未决项」。

## 结论

DSH `0.2.0-rc.2` 已成为受支持的精确目标版本（extension `1.2.1`，integration `0.11.0`）。rc.1 与 legacy 的精确分支、profile 后缀与全部回归保留；未知版本仍拒绝。rc.2 核心链路（真实运行时 + facade + 会话 + 工具/Changes + 生命周期 + 10 分钟稳态）在隔离环境真实通过。

## M1 接口差异（决定适配规模）

逐文件对比两棵官方包树（227/288 包仅 package.json 版本差异）。**扩展消费的全部上游边界代码在 rc.2 中不变**：CLI 启动路径（bin.js 新增可选参，默认行为等价）、host 插件注入、session/workspace controller、follow 事件流、compact chunks、webserver、frontend-static、client-ui-cordis、数据格式。rc.2 的新增（user-questions、Desktop 载体 plugin 管理、inspect 快速失败）均为加法且不在扩展边界上。完整证据：[evidence/dsh020rc2/m1-boundary-evidence.md](evidence/dsh020rc2/m1-boundary-evidence.md) + [m1-package-diff.json](evidence/dsh020rc2/m1-package-diff.json)。

因此 M3 无需接口重写；仅落地两项：supervisor 增加 `verifying-node` 阶段日志；错误页/门禁文案由版本描述表生成（列出全部支持版本 + 实测版本 + `dsh.local.packageRoot` 指引）。

## M2 实施（身份贯通）

- **版本描述表**（`src/runtime/compatibility.js` `RUNTIME_DESCRIPTORS`）：每精确版本一条 {adapterId, line, profileSuffix}；`TARGET_VERSIONS`/`SUPPORTED_VERSIONS` 派生自表。extension 版本门、profileScaffold 后缀（rc.2 → `-dsh020rc2`，64 字符界保留）、dshCompat 诊断、supervisor target 判定全部由表驱动，无散落字面量。
- **Host adapter**：实现移入共享工厂 `lib/adapters/dsh020.js`（迁移经 diff 核对，仅身份相关差异）；`dsh020rc1.js`/`dsh020rc2.js` 为薄包装，各自冻结身份对；`lib/index.js` 显式按 `DSH_VSCODE_RUNTIME_VERSION` 选工厂，未知版本不装 facade。
- **浏览器链**：平铺 chunk 更名 `client.dsh020.js`（target 线共享，身份由 loader 注入）；`client.js` 以 `dsh_runtime` ∈ {rc.1, rc.2} 判 target；`client.sessionBridge.js` 的 hello-ack 上报真实选定身份且校验配对映射，不再硬编码 rc.1。
- **扩展宿主握手**：`createBrowserSessionProxy` 新增必填 `expectedIdentity`（来自当前 lease），hello-ack 配对不匹配即不就绪；webviewHtml 生成的 shell 脚本内嵌期望对，同样拒绝异版本 ack（含 origin/surface/epoch 既有校验不变）。
- **契约 v1**：`runtime-v1.json` CapabilityReport.adapterId 枚举 + rc.2；`session-bridge-v1.json` const→enum；`contracts/validate.cjs` 新增 `ADAPTER_BY_RUNTIME` 跨字段配对（schema 枚举管字段、代码管配对，沿用既有跨字段先例）。旧 1.2.0 集成遇到 rc.2 运行时会明确失败（握手/身份不匹配），不会静默混用。
- **部署清单**：`INTEGRATION_FILES` 与 VSIX 必需文件清单同步新增/更名文件；probe 校验源/部署逐文件 SHA-256 一致。

## M4 验证证据

门禁（全部通过）：

- `npm run check:w0` — 884 tests, 0 fail（含 lint、打包门禁、secrets 门禁）
- `npm --prefix runtime-integration/dsh-vscode-integration test` — 173 tests, 0 fail
- `npm run test:extension-host` — dev 安装激活证明通过

真实运行时 probe（隔离 home/profile/workspace，证据 JSON 在 `evidence/dsh020rc2/probe/`）：

| 探针 | rc.2 | rc.1 回归 |
|---|---|---|
| contract（startup/鉴权/capabilities 真实 rc.2 身份/workspace/session/rename/follow 重开/cancel/同 PID 复用） | PASS | PASS |
| contract + 本地确定性 provider（流式 2 chunk、durable 提交、主动取消、read/write/edit 真实文件效果、2 条 confirmed 观察） | PASS | PASS |
| changes/CH1（before 原文、每工具一条 confirmed、重放去重、Accept/Undo 真实文件、bridge 推送、preview 只读） | PASS | PASS |
| lifecycle（10 次真实启停、双自有共存、受信借用无副作用、unknown 版本/缺 Node 预启动门禁） | PASS | PASS |
| steady（10 分钟稳态、两次真实断流 ~1s 恢复、末消费者释放、owned pid 退出） | PASS | 未复跑（rc.1 已有 1.2.0 验收基线） |

新增回归测试要点：三版本描述表、rc.2 后缀与 64 字符界、rc.2 能力报告与握手配对（含混对拒绝、缺身份构造即失败）、shell 脚本拒绝异版本 ack、rc.2 adapter 包装、契约 fixture 语料新增 rc.2/混对/未知对、同步守卫新文件集、extension 级 rc.2 完整生命周期（含 lease 保持与失效选择不释放已就绪子进程）。

修复的两个既有测试缺陷：`failed-connect status page` 与 `error status without a message` 缺进程扫描注入（真实 PowerShell 扫描超过测试 2s 预算导致偶发超时，基线亦失败）；已按约定注入 no-op 扫描。这同时是 M3.5「同步进程探测」的证据：失败路径上的进程扫描在本机可占秒级时间（有界 8s），会推迟错误页出现——已有界，未再扩大修复范围。

## 未决项（不因本报告关闭）

1. **安装态 VSIX 验收**：`dsh-vs-sidebar-1.2.1.vsix` 已按冻结提交构建并生成 [evidence/dsh020rc2/m5-build-manifest.json](evidence/dsh020rc2/m5-build-manifest.json)（SHA-256、逐关键文件 hash）；但「安装到真实 VS Code + webview 可见 UI + 最低支持版本核对」未执行。沿用 HANDOFF-1.2.0-VALIDATION.md 的 A 系列项跟踪；OOPIF 驱动仍需先修复，否则按 BLOCKED 记录人工步骤。
2. **升级复现**：1.2.0 + rc.2 的旧失败状态 → 安装 1.2.1 → 错误提示与重试恢复，未在真实安装上演练（需要隔离 user-data/extensions 目录）。
3. **UI/多窗口**（IME、搜索焦点、A→B→A、多面板隔离、重启重绑）：rc.2 下未执行；rc.1 结论不自动继承。
4. **rc.2 已知限制**：侧栏不渲染 user-questions（提问/计划审查）新功能 UI；扩展忽略其事件与记录（不破坏，仅不显示）。
5. 原有发布阻塞项（A07 内部右栏附件等）继续按 HANDOFF-1.2.0-VALIDATION.md 跟踪。

## 回退（M5.5）

同时锁定扩展与 runtime：卸载 1.2.1 VSIX、装回 1.2.0 VSIX 并 `npm i -g @deepseek-ai/dsh@0.2.0-rc.1`（或指定 `dsh.local.packageRoot` 指向 rc.1 树）。回退后不要让旧 runtime 读取 rc.2 期间写入的 home：数据格式未变（M1 证据），但按计划要求使用升级前 home 备份或独立 home；不同 profile（`-dsh020rc1`/`-dsh020rc2`）不隔离 home 级会话。
