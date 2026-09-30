# DSH 0.2.0-rc.2 适配与发布计划

日期：2026-09-30。状态：待实施；本文不代表 rc.2 已兼容或已通过验收。

## 1. 目标与事实边界

目标：让 dsh-vs-sidebar 在精确选择官方 DSH `0.2.0-rc.2` 后，能够在真实安装的 VS Code 中启动侧栏、操作会话、发送与取消消息、观察工具修改，并正确释放自身资源。

已确认：

- 本机官方 `@deepseek-ai/dsh` 的 package.json 为 `0.2.0-rc.2`。
- 已安装扩展为 `1.2.0`；当前窗口日志记录运行时版本检查拒绝，DSH 未由该次启动成功拉起。
- 现有实现与测试只认可 target `0.2.0-rc.1` 和 legacy `0.1.2-rc.1`；rc.2 被拒绝是当前策略的结果。
- 限制存在于 extension、compatibility、host adapter、client、browser proxy、webview、schema 和 profile 命名，不能只扩大入口白名单。
- 已修改源码错误提示以显示实际版本和 `dsh.local.packageRoot` 配置入口；相关四项测试通过，未替换日常安装。

未确认：rc.2 的具体接口差异、真实运行兼容性，以及日志中的扩展宿主短时无响应是否还有独立原因。版本拒绝解释启动失败，不能据此宣称全部卡顿都已定位。

范围：完成 rc.2 适配及相关发布验收；不同时实施完整 IDE 扩展计划。原有发布缺口继续按 HANDOFF-1.2.0-VALIDATION.md 跟踪，不因 rc.2 启动成功自动关闭。

## 2. M0：冻结基线与隔离环境

1. 保存当前工作树的文件清单、差异与 hash；从包含现有未提交修改的快照建立独立构建基线，不能仅从旧 HEAD 构建。
2. 固定 rc.1/rc.2 官方包、依赖树与选定 Node；记录来源、版本、关键文件 hash。当前 rc.2 manifest 未提供 engines/gitHead，需从随包依赖或对应官方源码核实，不能将缺失解释为无 Node 限制。
3. 使用独立 DSH home、profile、workspace、VS Code user-data/extensions 目录；测试模型用确定性的本地 provider。
4. 新建 rc.2 evidence 目录，记录源码身份、环境、运行参数、结果和退出清理；不记录密钥与个人会话正文。

完成条件：rc.1 基线可复现，rc.2 资产可追溯；日常安装与个人 home 未被试验写入。

## 3. M1：核对上游接口差异

对照实际发布包及对应源码，形成“rc.1 接口 → rc.2 接口 → 适配改动 → 验证用例”表：

| 边界 | 必查内容 |
|---|---|
| CLI/启动 | bin、Node 要求、profile 初始化、web 参数、启动 cookie、服务就绪与鉴权 |
| Host 插件 | sessionController/workspaceController/webServer 的注入名称、方法签名、插件生命周期 |
| 会话操作 | list/create/rename、workspace 归属、queue/steer、cancel 的范围及队列语义 |
| follow | baseline、durable event、临时 assistant stream、revision/index、compact chunks、终止与重连 |
| 工具观察 | pre-execute 与 durable tool result 的关联、toolCallId、成功/失败和 before 原文 |
| Browser | module loader、平铺 client chunks、公开导航/当前会话/composer 服务、IME 和输入提交 |
| 数据 | session/storage 的格式变化、迁移触发条件、旧版本能否读取新数据 |

完成条件：所有实际调用点都有证据；未知项明确列出。接口相同允许复用实现，存在差异则局限在 adapter 内，不让 domain 直接处理上游版本字段。

## 4. M2：贯通精确版本身份与协议

采用一个显式版本描述表，至少包含 runtimeVersion、adapterId、profileSuffix 和 adapter 选择。未知版本仍拒绝；不接受 `>=0.2.0` 或 `latest`。

| 变更范围 | 实施要求 |
|---|---|
| src/runtime/compatibility.js、identity.js、dshCompat.js、extension.js | 新增精确 rc.2 映射；启动选择和诊断由同一策略派生，保留实际 runtimeVersion |
| src/profileScaffold.js | rc.2 使用独立后缀（建议 `-dsh020rc2`）；覆盖 64 字符上限与稳定命名，保留 rc.1 路径 |
| integration lib/index.js、adapters/ | 显式选择 rc.2 adapter，capabilities 返回 rc.2 真实身份；共享代码通过薄包装复用，不把 rc.2 冒充 rc.1 |
| contracts/、src/protocol/runtime.js | 同步 adapterId 合法值、校验器、共享 fixtures；校验版本与 adapter 配对 |
| client.js、client.sessionBridge.js、client.dsh020rc1.js 或新平铺 chunk | rc.2 分支使用真实选定身份，握手不得硬编码返回 rc.1；保持公开 browser 服务边界 |
| src/session/browserProxy.js、src/webviewHtml.js | 按当前 lease 的预期版本/adapter 握手，同时校验 origin、surface、epoch，拒绝错误配对及旧消息 |
| src/dshIntegration.js、打包清单 | 新增文件均进入同步和 VSIX allowlist；修改文件确实更新到 profile |

原则：保留 rc.1 和 legacy 的精确分支及回归。若 M1 证明无法兼容，必须先记录支持范围变更及迁移方案，不能在适配中静默删除。

协议版本：若只是合法身份扩展且同一 VSIX 同步部署两端，可维持 v1，但旧/新集成混用必须明确失败；若改变信封或行为语义，则升级相应协议并更新两端，不只改 schema。

完成条件：rc.2 身份从解析、spawn、capabilities 到浏览器握手全程一致；错配/unknown 在产生写入前拒绝，已有 owned child 的所有权不被失败切换破坏。

## 5. M3：Host、Browser 与启动诊断修复

1. 按 M1 证据实现 workspace/session/prompt/cancel/follow 映射；维持快照恢复、持久事件去重、临时流与持久结果分离。
2. 验证取消等待与取消会话的区别；prompt/cancel 等修改结果未知时不自动重发。
3. 验证主会话附件插入、导航确认和 stale ticket 拒绝。内部右栏、文件/图片等已有缺口保留明确状态，不能算作已通过。
4. 增加可定位的启动阶段日志：运行时解析、准备、spawn、认证就绪、browser handshake；提供阶段耗时和失败原因，不输出令牌或会话正文。
5. 用本次升级路径复现侧栏故障，并分别检查扩展激活耗时、同步进程探测、Changes journal 加载和已启用可选功能；只有证据确认的独立卡顿才纳入修复。
6. 错误页必须结束加载状态，显示检测到/支持的版本及修复入口；配置修复后重试应可恢复。实际启动无响应时提供有界超时，不无限等待。

完成条件：隔离真实 rc.2 运行时与浏览器通过核心交互；故障能定位到阶段并在 UI 中呈现。

## 6. M4：分层验证

先运行变更相关测试，再完成项目门禁：

```text
npm run check:w0
npm --prefix runtime-integration/dsh-vscode-integration test
npm run test:extension-host
```

将现有 rc.1 probe 参数化为明确目标版本，或添加 rc.2 probe；保留 rc.1 的精确断言，不以简单替换原证据的版本号生成 rc.2 结论。

| 测试层 | 必须取得的证据 |
|---|---|
| 单元/契约 | 三个已声明版本、unknown、manifest 不一致、adapter 不一致、Node 不满足、超时/取消、旧集成混用 |
| 真实 runtime | workspace/session 新建与切换、rename、queue/steer、两个独立流 chunk、单次 durable 提交、active cancel、断线恢复 |
| 工具/Changes | read/write/edit、成功/失败归因、CH1、before 原文、重放去重、Accept/Undo 的文件效果 |
| 生命周期 | 10 次启停、重复 ensure 不重复 spawn、自有/借用区分、至少沿用 10 分钟稳态与断线恢复、最终资源清理 |
| 已安装 VSIX | 最低支持 VS Code 与用户当前版本；校验包内文件 hash；真实 webview 握手和可见 UI，而不只调用 exports |
| 升级复现 | 1.2.0 + rc.2 的旧失败状态 → 修复 VSIX；既有扩展配置和启用功能组合的脱敏副本；错误提示与重试恢复 |
| UI/多窗口 | 搜索焦点、中文 IME、发送/取消、A→B→A、多面板隔离、重启重绑、关闭一窗口不影响另一窗口 |

安装态 OOPIF 驱动需先修复；如改为人工验收，必须记录具体版本、步骤和截图/日志。驱动无法操作页面只能记 BLOCKED，不能用 runtime/API 成功代替 UI PASS。

完成条件：rc.2 核心链路真实通过；继承的 A07/A12/A13 等发布阻塞项逐项关闭或形成经明确确认的产品范围决定。不得为了通过而静默关掉用户已启用的功能。

## 7. M5：版本、交付与回退

1. 使用新扩展版本（若 1.2.0 已发布，建议 1.2.1），更新 integration 版本以确保同步；最终版本取决于实际改动范围。
2. 更新 package/package-lock、CHANGELOG、README、VERSIONS、codemap、契约和验收报告，注明精确支持矩阵与剩余限制。
3. 从冻结且通过门禁的源码构建 VSIX，生成 SHA-256、build manifest 和逐文件核对记录；安装测试必须使用这一最终 VSIX。
4. 交付 VSIX、rc.1→rc.2 差异表、测试矩阵、升级/回退步骤、未决问题；本文不授权直接上传 Marketplace。
5. 回退同时锁定扩展与 runtime，使用升级前 home 备份或独立旧 home。不同 profile 不隔离 home 级 sessions，不能让旧 runtime 直接读取可能迁移过的数据。

发布条件：适配完成、真实安装验收通过、既有发布阻塞项处理完毕。只修改错误提示、只通过单元测试、只启动后端都不满足条件。

## 8. 执行顺序和交付物

顺序：M0 → M1 → M2 → M3 → M4 → M5。M1 的差异结论决定实现规模；在此之前不承诺“只改白名单”或固定工期。

交付物：

- rc.1/rc.2 接口差异与源码证据表。
- 版本描述表、两端 adapter/协议/握手实现及回归测试。
- rc.2 真实运行与安装态验收报告，含原卡死场景的复现与恢复证据。
- 可复验的 VSIX/hash/build manifest，以及安全的数据回退说明。

现有依据：[架构契约](PLAN-1.2.0-ARCHITECTURE-CONTRACTS.md)、[运行时报告](HANDOFF-1.2.0-RUNTIME-CONTRACTS.md)、[发布验收](HANDOFF-1.2.0-VALIDATION.md)。历史报告保留原有 rc.1 结论，不覆写为 rc.2 通过。
