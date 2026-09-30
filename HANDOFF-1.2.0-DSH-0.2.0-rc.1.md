# 给实现 AI 的交接：扩展 1.2.0 / DSH 0.2.0-rc.1

这是原实施任务与后续交接入口。方案日期 2026-09-29；2026-09-30 已派发并执行三条实现线。当前实现与改约见 [契约报告](HANDOFF-1.2.0-CONTRACTS.md)，候选产物及剩余发布缺口见 [验收报告](HANDOFF-1.2.0-VALIDATION.md)。下方任务保留为验收要求，不代表需要从零重做。

## 可直接复制的任务

```text
请在 D:\Coding\DSH\deepseek-harness-dsh-for-vscode 实现插件 1.2.0，
精确适配 @deepseek-ai/dsh@0.2.0-rc.1，内置 dsh-vscode-integration 目标 0.10.0。

先读取 AGENTS.md、codemap.md、PLAN-1.2.0-ARCHITECTURE-CONTRACTS.md、
PLAN-1.2.0-DSH-0.2.0-rc.1.md，再读取涉及目录的 codemap.md。
按计划 M0–M6 执行，更新阶段状态和证据；不能只改版本号或仅做模块拆分。

上游基线必须锁定 tag dsh-v0.2.0-rc.1，
commit 4878cdabd87d4041bdaff61d04c966883b9fd07a。
不得用 master/latest 或本机含改动的 DSH 源码代替该版本。

当前工作树保留未提交的 1.1.8 修复；先保存并纳入实施基线。
仅从 HEAD 建 worktree 会丢失这些修复。不要清理、覆盖、整体暂存用户文件。
特别不要动 .dsh-accept-test/、.dsh-repair/、.vscode/tasks.json、
thinking-effort-loaded.json，也不要在 D:\Coding 父仓库提交插件内容。

先做真实 contract spike：公开 session controller 方法、uiWorkspace 导航、
当前可见会话观测、retain/release、草稿插入、assistant-stream、workspace feed、
工具观察和运行时启动鉴权。未决接口先查锁定源码并实测，不靠猜测或私有字段。

模块、接口和抽象已约定，按架构契约 v1 实现：目标版 /api/vscode/v1 facade、
RuntimeSupervisor、SessionCoordinator、SessionFeedHub、BrowserSessionPort。
M1验证上游映射，不重新选择传输或让worker各定义一套接口。
重连采用snapshot-reconcile，不发明恢复cursor；prompt结果未知不能自动重发。
当前会话unknown时附件安全失败，不能把禁用默认功能算验收通过。

Runtime、Host/协议、Client/UI 可在契约冻结后并行。
主集成人独占 extension.js、dshIntegration.js、manifest/lock 和发布门禁。
保留已有事件有界、取消、焦点稳定和编辑区域保护回归。

在独立 user-data/extensions 目录安装候选 VSIX，用独立 DSH home/profile、
明确的 Node/DSH 路径和一次性工作区验收。不要全局升级 DSH、写入用户 ~/.dsh，
或自动使用个人 API key。真实 E2E 必须经过目标 DSH，不以 mock 扩展响应代替。

完成计划的命令门禁及 A01–A13 验收，交付 VSIX、SHA-256、源码提交、
契约报告、真实验收结果和回滚说明。缺证据则记录 FAIL/BLOCKED，不能宣称完成。
不自行发布市场或替换用户日常安装；先交付可审阅的结果。
```

## 优先核对的已知断点

1. `sessions.open()` 和 `SessionListState.current` 在目标版本契约中不存在；导航改用公开 `uiWorkspace.openSession`，当前会话来源另行验证。
2. 不再从私有 `sessionController.commands` 取 create/rename/prompt；适配公开入口及准确请求形状。
3. `session/event` 与旧 `assistant/chunk` 路径不足以覆盖新的 assistant-stream；验证增量、取消、重连和去重。
4. `scope()` 不持有会话生命周期；异步附件须验证 retain/release 和插入 revision，不能覆盖草稿。
5. 新集成文件须加入 `src/dshIntegration.js` 的 allow-list；否则打进 VSIX 也不一定被部署。

详证和固定源码链接都在 [主计划第 3、11 节](PLAN-1.2.0-DSH-0.2.0-rc.1.md)。

模块边界、端口签名、wire 信封、错误码、取消语义、插入事务与预算见 [架构与接口契约 v1](PLAN-1.2.0-ARCHITECTURE-CONTRACTS.md)。

## 测试不能混淆

- `npm run check:w0` 不包含集成子包测试；另跑 `npm --prefix runtime-integration/dsh-vscode-integration test`。
- `test:extension-host`、`installed-smoke.js` 现有覆盖主要是激活与命令注册；不能当作 DSH 或搜索/输入 UI 测试。
- package gate 要求 runtime-integration 与 HEAD 相同，暂存也不够。只提交确认过的候选代码，在干净 checkout 验证；不要绕过门禁。
- 以主计划的 A01–A13 和实际证据判定完成，不以历史测试数量判定。

## 最终回复应包含

实际安装验证的版本组合；完成阶段；产物与哈希；测试/真实 UI 证据；未验证功能；回滚步骤。若存在核心 BLOCKED，明确交付为候选版本，不写“全部完成”。
