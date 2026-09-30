# 1.2.0 候选实施与验收

更新：2026-09-30。本轮执行用户授权的计划，由 Runtime、Host、Client 子 agent 并行实施、主 agent 集成。目标 DSH `0.2.0-rc.1`，扩展 `1.2.0`，integration `0.10.0`。**交付状态为候选；不能宣称 A01–A13 全部通过。**

## 基线与可追溯性

- 主工作树原有 1.1.8 修复已纳入隔离基线，未提交或清理用户主仓库。基线目录：`D:/Coding/.codex-staging/dsh-vscode-1.2.0-baseline-20260930`，commit `54675af`；旁有 SHA-256 文件清单及原 git status。
- 基线 check:w0：795 tests / 794 pass / 1 skip；子包 158 pass。日志位于上述 staging 的 `dsh-vscode-1.2.0-baseline-check.log`、`dsh-vscode-1.2.0-baseline-integration.log`。
- 官方 npm 安装、home/profile、测试工作区、VS Code user-data/extensions/storage 均单独隔离。未升级全局 DSH、替换日常 VS Code 安装、读取个人模型密钥或发布市场。
- 最终构建源码：`D:/Coding/.codex-staging/dsh-vscode-1.2.0-candidate2-20260930`，commit `b142c57868e15a709ae509eb67e02932e62d5713`。主仓库未提交。安装测试只把独立空 driver 作为 developmentPath，产品仍由隔离目录中安装的 VSIX 提供，逐文件校验。

## 最终候选产物与命令门禁

VSIX：`D:/Coding/.codex-staging/dsh-1.2.0-final/dsh-vs-sidebar-1.2.0.vsix`，旁有 `.sha256` 和 `build-manifest.json`。115 个代码/集成文件与构建 checkout、当前主工作树逐字节一致；安装验证对除 manifest 外的文件核对 hash，manifest 剔除 VS Code 加入的 `__metadata` 后做语义全等比较。SHA-256：

```text
e8d61199cb800eec31e4ad53ae3eeb58be8bd933381040800bea94e54f136458
```

| 门禁 | 结果 | 日志（`D:/Coding/.codex-staging/` 下） |
|---|---|---|
| `npm run check:w0` | PASS；880 tests，879 pass，1 skip，0 fail；包清单 133 文件，secrets 289 文件 | `dsh-120-final-check.log` |
| integration 子包 | PASS；171 pass，0 fail | `dsh-120-final-integration.log` |
| `npm run test:extension-host` | PASS；隔离开发宿主 VS Code 1.106.0，实际候选 checkout | `dsh-120-final-extension-host.log` |
| VSIX 构建 | PASS；135 ZIP entries（含两份 VSIX metadata），1.74 MB | 上述产物及源码快照文件清单 |
| 安装态 1.106.0 / 1.133.0 | 身份、激活、真实自有 DSH 启动及两次 exports 会话调用通过；页面交互自动化 BLOCKED | Electron OOPIF 未被 Playwright 正确枚举；不冒充产品失败，也不记 UI PASS |

正式安装证据（均引用上述最终 VSIX hash）：

- `D:/Coding/.codex-staging/dsh-120-installed-acceptance/installed-1.106.0-PwLJbE/proof.json`
- `D:/Coding/.codex-staging/dsh-120-installed-acceptance/installed-1.133.0-nVlUwg/proof.json`

每份证据记录 132 个文件的逐项 hash 验证及单独 manifest 比较、8 个启用命令、两个新会话和两个本地 provider 响应。proof 的 `nodeVersion` 是扩展宿主（分别 22.20.0、24.18.0），不是实际 DSH child 的 Node；child 由明确的外部 Node 路径启动。suite 已执行 stopServer，测试 Code 正常退出，最后核查本轮隔离目录匹配的 Code/node/Chrome/helper 进程为 0。

唯一 skip 是既有 Windows 符号链接创建不可靠的测试限制，同一 regular-file 分支仍有 directory case 覆盖。初版候选的 secret scan 曾把固定字符串 `Bearer invalid-probe`（刻意无效的鉴权测试值）识别为令牌；补上 scanner 约定的 fixture 注释后重跑全门禁通过，未放宽扫描规则。初版候选仅用于发现问题，最终产物以上述 SHA 为准。

最终版本门禁同时覆盖缺失/null/unknown/未支持版本：在准备 profile、变更 live adapter 或启动前拒绝。legacy→target 的失败切换不会提前提交 target 状态，停止/退出仍清理实际持有的 legacy child；成功 ensure 后才切换身份。

## 阶段与验收矩阵

M0/M1 完成；M2–M4 主体及装配完成。M5 具有真实运行时和浏览器证据，但仍有发布阻断缺口；M6 交付隔离候选，不作正式发布。

| 项 | 当前结果 | 已有证据及边界 |
|---|---|---|
| A01 安装身份 | PASS | 两版本的独立安装路径、扩展/integration版本、133 个归档文件校验及激活；产品不作为 developmentPath |
| A02 新 home 冷启动 | PARTIAL | 官方 npm 精确版本、实际 Node、profile、CLI/auth 通过；两版本均由已安装扩展启动自有 DSH；实际 webview 握手/画面自动化未完成 |
| A03 工作区/会话 | PARTIAL | 真实 ensure/list/create/rename；公开导航组件已确认 target；安装态两次 exports 会话成功；完整单/多根 UI 矩阵尚待 |
| A04 搜索 | PARTIAL（真实组件 UI PASS） | 320/480/800 各 20 轮，共 60 轮，真实搜索过滤、同节点/焦点/caret；安装态页面驱动受 OOPIF 阻塞，未等同 VS Code 所有搜索入口 |
| A05 输入 | PARTIAL | 原生中文 IME、draft 保留、capture 后用户编辑拒绝、重复 commit 只一次；实测并修复 Ctrl+Enter 两行输入与 Enter 提交；完整剪贴板/主题/平台键盘矩阵未全部跑完 |
| A06 流与取消 | PASS（真实 DSH） | 确定性本地 LlmAdapter 仅替代模型；真实 prompt/agent/follow 产生两个分离 chunk、单 durable、completed；active cancel 为 cancelled |
| A07 多会话/面板 | PARTIAL / 发布阻断 | 实测手动 A→B→A、stale ticket 拒绝；proxy/coordinator/panel 重启有回归。内部右栏/浮动 composer 不支持附件，展开/聚焦时明确拒绝；完整 installed 多面板未验收 |
| A08 工具/Changes | PASS（真实 DSH + 文件 API facade）；UI PARTIAL | 真实 read/write/edit、CH1 通知、confirmed 汇合、重连重放无重复、精确 before、preview/Accept/Undo 文件效果；安装态 dirty buffer/undo stack/PTC 未验收 |
| A09 生命周期 | PASS（真实 runtime）；双窗口 UI PARTIAL | 10 启停、两个 owned + trusted borrowed 隔离、全部自有 PID 退出；不等同两个真实 VS Code 窗口操作验收 |
| A10 风暴 | PASS（行为回归） | 继承 1.1.8 watcher 10000 事件/排除/有界合并、串行 flush、最新 lifecycle 状态及焦点回归；最终总门禁另列 |
| A11 稳态 | PASS（已观测范围） | 601137 ms、30 点采样、600 次订阅 churn、两次真实断连约 1.01s 恢复、同 PID、active SSE 峰值 1；最终 transport/consumer/timer 全 0 |
| A12 能力矩阵 | PARTIAL / 发布阻断 | 文本与主会话附件有证据；non-text file/image 上传明确 unavailable；FIM、完整 LM/MCP/终端/exports、默认功能安装态矩阵未认证 |
| A13 回滚 | PARTIAL / 发布阻断 | 旧 adapter 回归、旧基线可还原；旧 VSIX 源码字节核验和 0.1.2-rc.1 全新 home 真实会话 probe 通过。旧基线另有两个 status-page fixture 超时，日志保留，旧产物仅供回退演练；完整安装回退 UI 尚未完成 |

## 真实证据位置

所有下列目录均为本机隔离证据，不随 VSIX 打包，不含个人 API key：

- `D:/Coding/.codex-staging/dsh-020rc1-runtime/facade-probes/run-1rGRvI/evidence.json`：facade、prompt、cancel、真实工具链路。
- `D:/Coding/.codex-staging/dsh-020rc1-runtime/lifecycle-probes/lifecycle-PXXP08/evidence.json`：10 次启停与所有权。
- `D:/Coding/.codex-staging/dsh-020rc1-runtime/lifecycle-probes/steady-DECztC/evidence.json`：601 秒稳态。RSS 首次 211.21 MiB，最低 143.22，末次 146.79；120 秒后净增约 1.95 MiB，有升降，不将短时证据称为长期无泄漏。服务端内部 queue depth 无公开测量端口，未伪造 0。
- `D:/Coding/.codex-staging/dsh-020rc1-runtime/changes-probes/changes-bgoevF/evidence.json`：真实 CH1 v3 与 confirmed 去重、文件效果、关闭后 hub keys/CH1 sockets 为 0。
- 浏览器证据与执行细节见 [Client 报告](HANDOFF-1.2.0-CLIENT-CONTRACTS.md)；真实 DSH + Chrome 与安装态 VS Code 分开记录。
- 回退来源：`D:/Coding/.codex-staging/dsh-118-rollback-probe/rollback-evidence.json`。旧产物 `dsh-vs-sidebar-1.1.8-rollback-only.vsix` 的 SHA-256 为 `f5081c46e213f32c6f063cac6fb4e447c774edfa2f35a90c0f5310b17f160d42`；98 个代码/集成文件与基线相同。真实旧 runtime 证据为同目录 `legacy-cwNzJB/evidence.json`。完整旧门禁的两个状态页等待超时未解决，不隐去失败或声称旧 release 门禁通过。

复跑工具：`scripts/probe-dsh020rc1.js`、`scripts/probe-dsh020rc1-lifecycle.js`、`scripts/probe-dsh020rc1-changes.js`、`test/extension-host/installed-smoke.js`。只传专属绝对目录；installed-smoke 要求 profile JSON 明确 VSIX/hash、Code 路径/版本、isolationRoot，可启用 runtimePackageRoot/playwrightModulePath 做真实安装态 UI。

## 回滚边界与后续

本轮未替换日常 1.1.8，无需回滚用户安装。试用候选时保留独立旧 home/profile 及旧 VSIX；结束只停止候选自有进程、退出隔离 VS Code。若今后手工升级日常安装，回退应重新安装旧 VSIX 并指向事先保存的旧 home，不让旧 runtime 打开可能已迁移的新会话数据。

正式发布前必须补齐上表 PARTIAL/BLOCKED 项，优先修复安装态 OOPIF 测试驱动以取得实际 webview 握手和搜索/输入证据，再覆盖内部 composer 目标或明确约定的功能范围、跨面板/双窗口操作、默认功能矩阵与回滚演练。不要以关闭功能、单元测试通过或安装激活成功替代这些验收。
