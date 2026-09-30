# 1.2.0 Runtime 实测与接线交接

验证日期：2026-09-30（Australia/Sydney）。本报告覆盖 Runtime worker 的 M1/M2 与真实 DSH facade contract probe；**不代表安装态 VSIX、浏览器 UI 或完整发布验收通过**。

## 1. 固定运行时证据

| 项目 | 实测 |
|---|---|
| npm CLI 包 | `@deepseek-ai/dsh@0.2.0-rc.1` |
| CLI `--version` | `0.2.0-rc.1` |
| Node / npm / 平台 | Node `v24.11.1`、npm `11.6.2`、Windows x64 |
| 目标源码锚点 | 实施计划固定的 `4878cdabd87d4041bdaff61d04c966883b9fd07a`；此次启动对象是 npm 安装包，未把有修改的源码 checkout 当成构建证据 |
| 安装位置 | 工作区根下 `.codex-staging/dsh-020rc1-runtime/`；未全局升级 |
| lockfile SHA-256 | `4a3ec29934e2c7fbe86567de6c0529c43e75f8e5d56a84f4f5d20642901c23af` |
| CLI tarball integrity | `sha512-F6hKNVoGgBDIzSiyRaIlobq4UD6cwxUjh+nwXqcDmufDh87TE1izsYzs8L5cZNpF2JmPnFM1mXRNnRJ0cs43ng==` |
| CLI tarball | `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.0-rc.1.tgz` |

`npm ls` 确认 session-controller、workspace-controller、ui-workspace、ui-conversation 均实际解析为 `0.2.0-rc.1`。完整依赖锁定在上述独立目录的 `package-lock.json`，共安装 544 packages；扩展没有因此新增运行时 npm 依赖。

无插件、全新 `web` profile 的启动 probe 证据为该 staging 目录的 `runtime-probe-evidence.json`：未认证 root 为 401；启动 URL 兑换 cookie 后 root 为 200 且含 `__DSH_BOOT__`；无集成插件时 facade 为 404；重复 ensure 保留同 PID；stop 后无 owned child。

## 2. 发现并修复的实际差异

目标版的启动 token 兑换返回 `303 Location: ./`。原 `loopbackAuth.js` 仅接受 `/`，导致服务已启动而健康检查始终失败。本次允许 `/` 和 `./` 两个精确根重定向形式，继续拒绝其他路径、绝对地址和跨 origin；不跟随任意重定向、不把 token 放入 API URL。

运行时 client 现由其自身统一调用 `loopbackFetch` 处理上游 cookie，随后使用独立 facade bearer；调用方不再自行包一层 cookie fetch。真实 probe 已使用该默认路径通过。

## 3. M2 已实现边界

- `src/runtime/identity.js`：公开 identity 不包含 token/PID/endpoint；冻结精确版本/adapter/profile/path。`createRuntimeIdentityFromResolved(runtime,{integrationVersion,source})` 验证实际官方 manifest 和精确版本；缺 packageRoot 时最多上溯 4 层，拒绝无法验证的直接 binary 布局。
- `src/runtime/compatibility.js`：仅精确 `0.2.0-rc.1` 与 legacy `0.1.2-rc.1` 有 adapter；目标 Node 范围为 `^22.19.0 || >=24.0.0`，实际探测选定 executable 的版本。Node 23 和过旧 Node 22 被拒绝。
- `src/runtime/supervisor.js`：同 identity 并发 ensure 共享启动；不同 identity 串行；30 秒启动/30 秒失败冷却；显式 restart 可越过冷却；stop/dispose 使旧 generation 失效；capabilities 必须精确匹配 instance/runtime/integration/adapter。重复 ready ensure 重新核对 capability identity。
- owned 启动私下注入独立 `DSH_VSCODE_API_TOKEN`、`DSH_VSCODE_RUNTIME_INSTANCE_ID`、`DSH_VSCODE_RUNTIME_VERSION`。borrowed 需要调用方提供可信 token/instance，不读外部日志、不注入、不准备 profile、不 restart/stop 外部进程。
- supervisor 独立记录它是否接管了 manager 生命周期；未执行 target ensure 的 supervisor dispose 不会停止同 manager 的 legacy child。
- `ServerManager.detach()` 为 `closePolicy=never` 清理本地健康观察、child 监听并 unref，不停止进程。factory 可选 `getClosePolicy()` 在 dispose 时读取最新配置，避免只改策略不重启时沿用旧值。
- `deriveRuntimeProfileName(configuredProfile,version)` 位于 `profileScaffold.js`：目标 profile 加 `-dsh020rc1`；超长名称截断加 hash 并保持 64 字符上限；legacy 名称不变。配置继承仍通过明确的 donorProfileName。
- local/command resolver 返回真实 packageRoot；home binder、launch normalizer 和 identity 转换保留此 metadata。`dshCompat.js` 不再因版本号大于某下界就宣布未来版本兼容。

轻量 DI 增补：`createRuntimeSupervisor` 可选 `getClosePolicy`；仅为实时读取配置，不改变冻结的 RuntimeSupervisor methods 或 wire 协议。root 负责注入 `() => hostContext.config().closePolicy`。

**独立 profile 只隔离插件目录和配置，不隔离同一个 DSH_HOME 下的持久 sessions。** 日常配置的 home 保持显式语义；测试和回滚必须另建 home，不能让旧 runtime 打开已由新 runtime 迁移的数据。此次全部运行在新建测试 home/workspace；没有复制个人凭据或会话。

## 4. 真实 facade、生成与工具证据

运行入口：

```powershell
node scripts/probe-dsh020rc1.js <absolute-isolated-dsh-package-root> <absolute-evidence-directory>
node scripts/probe-dsh020rc1.js <absolute-isolated-dsh-package-root> <absolute-evidence-directory> --with-local-provider
```

脚本每次建立新的 home/profile/workspace，使用正式 `installDshIntegration` 同步，检查每个 lib/contracts 文件均在 `INTEGRATION_FILES`，逐文件核对源/安装 hash。child 仅继承运行所需系统环境与本次生成的测试认证值；不继承个人 provider keys。

最新完整 probe：staging 下 `facade-probes/run-1rGRvI/evidence.json`，exit code 0，扩展候选 `1.2.0`、集成 `0.10.0`，实际同步 17 项文件。该 JSON 记录全部集成文件 SHA-256。早期失败与此前通过的 runs 均保留，未以删除失败记录制造通过。

| 检查 | 结果 |
|---|---|
| 新 profile 启动、授权健康 | PASS |
| cookie-only / wrong bearer / browser Origin | 分别 401 / 401 / 403，PASS |
| facade capabilities 的精确版本与实例 | PASS |
| workspace ensure/list/reuse | PASS，同 root 重复 ensure 返回同 ID |
| session create/list/rename | PASS，title 与 workspace ID 正确 |
| follow opening snapshot、iterator.return、再次 follow | PASS，首帧 seq=1，新连接使用新 epoch |
| idle session cancel | PASS，只验证 admission |
| 同 manager 重复 ensure | PASS，同 PID |
| 真实 DSH prompt/agent/stream | PASS，2 个分离 answer chunks，拼成一次响应，1 条持久 assistant record，turn completed |
| 活动 turn cancel | PASS，首 chunk 后显式 session.cancel，终态 cancelled |
| 真实 read/write/edit | PASS，一次性文件 before → middle → after；工具结果均 succeeded |
| confirmed edit observation | PASS，write/edit 各一条；均含 toolCallId 与 sourceDurableSeq |
| 结束清理 | PASS，manager 无 owned child 且实际 owned PID 已退出 |

生成后端是 `scripts/fixtures/dsh020rc1-provider.mjs` 中 test-only 的公共 `LlmAdapter` 注册实现，只替换模型生成。prompt admission、agent 调度、session persistence、工具执行及 facade/SSE 都是精确目标 DSH 的真实路径。没有直接 mock 扩展响应，也没有访问付费 API。

第一次工具 fixture 错把 DSH 附加的末尾 user message 当作原始任务，导致未执行工具；原失败记录保留。修正为定位 synthetic probe marker 后，原有工具断言全部通过。最终实际工具呈现为 native read/write/edit；PTC `run_code` 分支有 fixture 支持，但此报告不把未实际触发的 PTC 路径宣称通过。

## 5. 测试及范围限制

Runtime 相关测试命令覆盖 launch/local resolver/serverManager/profile/HMR/overlay/command resolver/identity/supervisor/compatibility/cookie auth。最新完整批次 89 tests：88 PASS、0 FAIL、1 既有 Windows symlink SKIP；随后新增实时 closePolicy 用例，需随集成候选全量测试再汇总。所有失败修复后只重跑受影响用例或新的真实契约检查。

以下仍交给主验收，不在上述 PASS 的含义内：安装态 VSIX 身份、真实 iframe 搜索/IME/附件、跨 surface 导航、Changes accept/undo UI、双窗口 UI 共存、旧版回滚、真实生产模型网络与可选 LM/FIM/MCP。第 6 节补充了 10 分钟 Runtime 资源采样和 10 次启停/多实例所有权的组件证据；第 7 节补充真实 CH1 工具通知、Changes 归因和临时文件效果。它们不替代安装态或双窗口 UI 验收。Capabilities 中 LM/FIM 保持 unverified；它们没有因为默认 facade 成功就获得认证。

本轮没有安装到用户日常 VS Code、全局升级 DSH、发布或提交用户工作树。

## 6. M5 Runtime 生命周期补充验收

新增可复验入口 `scripts/probe-dsh020rc1-lifecycle.js`：

```powershell
node scripts/probe-dsh020rc1-lifecycle.js <absolute-isolated-dsh-package-root> <absolute-evidence-directory> lifecycle
node scripts/probe-dsh020rc1-lifecycle.js <absolute-isolated-dsh-package-root> <absolute-evidence-directory> steady
```

脚本使用正式 `RuntimeSupervisor → ServerManager → DshRuntimeClient`，订阅稳态另接正式 `SessionFeedHub`。每个 owner 使用新 home/profile/workspace；只继承 allowlist 环境变量。证据记录所加载 Runtime/FeedHub/ServerManager 源码及同步集成文件 SHA-256，不把后续工作树变更冒充为已测字节。

生命周期最终证据为 staging 下 `lifecycle-probes/lifecycle-PXXP08/evidence.json`，exit code 0：

| 检查 | 实测 |
|---|---|
| 同 supervisor 连续 10 次启动/停止 | 10 个不同 PID、instance ID、fresh-origin port；每次重复 ensure 保留当次 instance；全部 PID 已退出 |
| stop 后资源 | 无 owned child，manager health timer 归零 |
| 两个独立 owned runtime 共存 | PID、port、instance 均不同；停止 A 后 B 仍可握手 |
| trusted borrowed 与 owner 共存 | borrowed 连接真实 B；拒绝 restart；stop/dispose 不调用 manager.stop、prepare 或 Node 检查，B 仍可握手 |
| unknown `0.2.0-rc.2` | `UNSUPPORTED_RUNTIME`，prepare/spawn 均为 0 |
| 不存在的 Node executable | 实际 executable 探测返回 `UNSUPPORTED_RUNTIME`，prepare/spawn 均为 0 |
| 最终清理 | 所有测试自有 PID 已退出 |

borrowed 用例通过显式测试 DI 将本次 owner 私有启动 endpoint/bearer 交给 borrowed supervisor；`ServerManager` 的 probe/ensure 与 client 握手均走真实网络。它验证可信凭据已提供时的所有权规则，**不表示生产插件能发现任意外部进程的凭据**，也没有读取其他进程日志。首轮 `lifecycle-DX6IN7` 的启停/共存也通过，但测试误期待 Node 错误码 `NODE_UNAVAILABLE`；按既有契约修为 `UNSUPPORTED_RUNTIME` 后完整重跑通过，失败证据保留。

10 分钟稳态证据为 staging 下 `lifecycle-probes/steady-DECztC/evidence.json`，exit code 0。真实墙钟采样 **601137 ms**，共 30 点，没有加速时钟；每次采样通过真实 facade 重新查询 capabilities、sessions，并再次调用 supervisor.ensure 验证同 instance。

| 观测 | 结果 |
|---|---|
| 进程身份 | PID `65860`、同 instance；整个稳态仅启动 1 次，结束后 PID 已退出 |
| 固定消费者 | 2 个 consumers 共用 1 个 hub key 和 1 条真实 SSE |
| 临时订阅 churn | 600 次注册/释放；consumer 峰值 3，没有为临时消费者额外开 SSE |
| 真实断连 | 第 127911 / 320808 ms 中止实际 fetch 连接；1011 / 1007 ms 后得到新 snapshot epoch |
| transport | 累计 3 open、3 close；active 峰值 1；终止错误 0 |
| timer 与 dispatch | reconnect timer 峰值 1；同步 consumer dispatch 深度峰值 1 |
| 最后 consumer 释放 | transports、consumers、reconnect timers 均为 0 |
| 本次最大 update | 283 bytes；本次是空会话/heartbeat/RPC/订阅 churn 负载，不是高吞吐模型压测 |
| Runtime RSS | 启动样本 211.21 MiB，最低 143.22 MiB，最终 146.79 MiB；未强制 GC |
| 120 秒后 RSS | 144.84 → 146.79 MiB，净增约 1.95 MiB，期间有小幅下降，未持续单调增长 |

RSS 是该负载下的 10 分钟样本，不能证明任意长期负载都没有泄漏。生产端口未暴露上游内部队列占用，因此没有把 transport 数、dispatch 深度或 timer 峰值冒充为服务端 queue depth；服务端队列上限仍由独立 bounded SSE 单测提供证据。脚本另记录配置界限：frame 1 MiB、projection 4 MiB、最多 32 个 feed keys。

新增 probe 通过 `node --check`；全仓 static check 为 199 JavaScript / 6 JSON 文件通过。本轮 M5 只新增专属 probe 和更新此报告，没有改动生产源文件、安装日常 VS Code 或发布候选。

## 7. M5 A08 Changes 真实链路补充

入口为 `scripts/probe-dsh020rc1-changes.js <absolute-isolated-dsh-package-root> <absolute-evidence-directory>`。最终证据为 staging 下 `changes-probes/changes-bgoevF/evidence.json`，exit code 0；此前 `changes-xUUd8G` 也通过，最终版本另增加实际历史 replay 和 tree model 状态断言。

此 probe 启动新的隔离 DSH 和真实 `VersionedBridgeServer`，只使用本次生成的 bearer 与 CH1 token。确定性本地 `LlmAdapter` 驱动真实 DSH 工具；CH1 初始化/通知/RPC、facade/SSE、FeedHub、editEventProjector、changeTracker、changeTree 都使用正式实现。VS Code 的 Uri/document/applyEdit/command 部分由专属文件 API facade 提供，实际读写隔离 workspace，**不是安装态 extension-host 或可见 UI 证据**。

| 检查 | 实测 |
|---|---|
| CH1 握手 | 真实连接协商 v3，通过 |
| 原生工具 | 真实 read → write → edit：`before\n` → `middle\n` → `after\n` |
| CH1 + facade 汇合 | 2 条真实 pre-execute 通知与 2 条 confirmed observation 按 session/toolCallId 汇合，恰好 1 write + 1 edit journal entry |
| before 原文 | write 为 `before\n`，edit 为 `middle\n`；均与相同 toolCallId 的真实 CH1 payload 一致；不是事后从磁盘反推 |
| Changes model | 当前 session 一个 group、两个叶节点，其中 edit 恰好一条，contextValue 为 accepted |
| replay 去重 | 真正重新打开 SSE，实际收到 2 条历史 confirmed observation，再显式重复 observe；journal 和 record 调用数均不增加 |
| 工具 diff/Accept/Undo | diff 左侧 middle、右侧 after；已应用工具的 Accept 幂等且不 applyEdit；Undo edit 回 middle，再 Undo write 回 before |
| 真实 `vscode_changes_push` | DSH 执行工具，经真实 CH1 handler 调用文件 facade applyEdit，before → bridge；journal accepted 且 session 归因正确；Undo 再经 applyEdit 恢复 before |
| pending preview/Accept/Undo | 显式构造 pending journal：preview 返回 accepted 文本但目标文件仍 before、applyEdit 数不变；Accept 真实写入 accepted；Undo 恢复 before，状态变 undone |
| 清理 | 自有 DSH PID 已退出，hub keys 和 CH1 sockets 均为 0 |

上述两种 Accept 语义分别验证：真实 `changes/push` 当前立即应用并记录 accepted；原生工具也已在磁盘生效。pending proposal 单独通过 `tracker.record` 创建，不能把它伪称为 DSH bridge 的延迟应用结果。两条实际 apply/undo 路径共调用文件 facade `applyEdit` 4 次；工具原文恢复使用 changeTree 正式 snapshot restore 分支。

证据包含生产模块/集成文件 SHA-256 和 synthetic before 原文，不包含测试认证值。未覆盖可见 TreeView 点击、命令注册到 UI 的接线、真实编辑器 dirty buffer/撤销栈、用户 UI 操作、安装态身份、PTC 工具或生产模型；这些范围继续保留给主验收。新增脚本通过 `node --check`，本轮无生产源码修改。

## 8. M5 A13 旧基线与旧 runtime 回退来源

A13 此处仍为 **PARTIAL**：准备并验证了隔离回退来源、旧 runtime 的全新数据目录启动和会话操作；实际 VSIX 安装回退 UI 由主验收另行完成。未用旧 runtime 打开候选 home，也未做持久 session 数据降级。

回退包来源是隔离的 1.1.8 baseline commit `54675af689c1cd75f52801ccb2a5db490e783292`，构建前后 `git status --porcelain` 均为空；没有为了通过检查修改基线。产物位于 workspace staging 的 `dsh-118-rollback-probe/dsh-vs-sidebar-1.1.8-rollback-only.vsix`，大小 **1762737 bytes**，SHA-256：

```text
f5081c46e213f32c6f063cac6fb4e447c774edfa2f35a90c0f5310b17f160d42
```

VSIX 内标识为 `Xizhi1024.dsh-vs-sidebar@1.1.8`；已解读 ZIP 并逐字节核对其中 98 个 `src/` 与 `runtime-integration/` 文件均与该 baseline 一致。它是 **rollback-only 测试来源，不是通过完整门禁的正式 release**：

| 旧基线门禁 | 结果 |
|---|---|
| static | PASS：178 JavaScript / 6 JSON |
| package-content | PASS：116 files；打包产生 118 ZIP entries，包含 VSIX 自身 metadata |
| secrets | PASS：247 files / 61207 lines |
| 原样 `npm run check:w0` | FAIL：795 tests，792 PASS / 2 FAIL / 1 SKIP |
| 单独重跑 `test/extension.test.js` | 同两项 waitFor 超时复现，因此不能仅归因于全并行负载 |

失败 fixture 是 `test/extension.test.js:1074` 的 `failed-connect status page can open the configured endpoint in browser`，以及 `:1268` 的 `error status without a message still clears stale state and shows Retry`。两者错误均为 `waitFor condition was not met before timeout`。前者等待 unavailable 页面、browser 按钮及 openExternal；后者等待 iframe，再等待无 message 的 error 状态清空 iframe 并显示 Retry。现有堆栈未指出具体哪个 predicate 超时，也不足以确定底层根因；没有通过改 fixture 或延长超时把基线染绿。

失败日志保留于 `dsh-118-rollback-probe/baseline-gates.log` 和 `baseline-extension-recheck.log`。完整产物/门禁/逐文件 hash ledger 为该目录的 `rollback-evidence.json`，生成脚本与旧 smoke 也仅存 staging。

旧 runtime 来自只读的既有 global 官方 `@deepseek-ai/dsh` 包；manifest 和实际 Node CLI `--version` 均为 **0.1.2-rc.1**，无需重新下载。只在全新 home/profile/workspace 中安装 baseline 集成 **0.9.2**，child 继承系统环境 allowlist，不继承个人 provider key。最终 `legacy-cwNzJB/evidence.json` 为 PASS：

- 基线 ServerManager 真实启动、owned 健康检查通过。
- 旧 API workspace/session 创建、list、rename、重复 binding 均通过。
- 真实 `/api/events.mux` 返回流并收到字节；重复 ensure 保留 PID，self-heal 为 0。
- 自有 PID 已退出、无 owned child；global CLI manifest/entrypoint 在测试前后 hash 一致。

第一次 smoke 错读旧 session.list 的顶层 title 字段；修正为调用基线 `rootSessionItems` 的公开投影后通过，失败 run `legacy-PpRDnr` 保留且 PID 已清理。这里未安装日常 VS Code、未修改 global 包或个人配置、未发布 VSIX，未宣称回退 UI 或旧版完整门禁通过。上述 rollback-only 产物与证据已冻结。
