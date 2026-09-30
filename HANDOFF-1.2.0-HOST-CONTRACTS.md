# 1.2.0 Host 契约实施记录

目标：`@deepseek-ai/dsh@0.2.0-rc.1`，上游提交 `4878cdabd87d4041bdaff61d04c966883b9fd07a`。本记录区分源码映射、单测与真实运行时证据；没有把单测等同于安装态验收。

## 核实来源

精确 npm 包只读位置：`D:/Coding/.codex-staging/dsh-020rc1-runtime/node_modules/@deepseek-ai/`。版本和 lockfile/integrity 由运行时工作流记录。以下相对路径均相对于该目录；JS 和 `.d.ts` 随实际 npm 包提供。

| 契约 | 来源与映射 |
|---|---|
| public commands | `dsh-api-session-controller/lib/types/index.{js,d.ts}`：`list({},signal)`, `create({workspaceId})`, `rename({sessionId,title})`, `prompt(request,signal)`, `cancel({sessionId})`；目标 adapter 不访问 private `commands` |
| prompt | `dsh-api-session-controller/lib/types/commands.js`：`mode==='steer'` 调用 `agent.steer`，否则 `agent.followup`；`requestId` 写入 `source.rpcId`；保持相同 clientRequestId |
| 部分输入缺口 | `types/types.d.ts` 的 `PromptContentPart`：text；image `{mediaType,data,name?}`；file `{receiptId}`。现有计划的 file/image uri 不能直接映射。目标文本 prompt 可用；未经明确授权的 URI 不读取/下载，非文本输入明确拒绝，附件 prompt 兼容性尚未认证 |
| 重复请求 | `commands.js/hasPromptRequest` 扫描 inbox 与 user/message；这不足以证明所有并发/失败情形幂等。传输超时不重发修改，不自动重发 prompt |
| cancel | `commands.js/cancel`：作用于活动 session turn，`keepInbox:true`。取消 HTTP 等待/释放 follow 不调用此方法 |
| workspace | `dsh-api-workspace-controller/lib/types/{types,feed,index}.{js,d.ts}`：`follow(signal)` 为 AsyncIterable，先取 Symbol.asyncIterator，再读一次 baseline，finally return；create `{path}` 返回 `{workspace,created}` |
| session summary | `types/types.d.ts`：sessionId、updatedAt 数值；title 来源是 `projections.values.title`（`dsh-session-title/lib/types/types.d.ts`），缺失为 null。workspaceId 由同次 workspace baseline 的 sessionIds 归属确定，不以 cwd 猜 |
| follow | `dsh-api-session-controller/lib/types/history.js`：`{address:{kind:'session',sessionId},maxMessages:200,assistantStream:true}`；无恢复 cursor 请求字段，始终新 snapshot |
| history | `types/types.d.ts`：snapshot.records 是 `{type:'event',event}`，cursor 是含 -1 的持久水位；-1 归一化为 null。后续 event.seq 必须连续 |
| human transcript | `dsh-session/lib/types/surface.d.ts/isAppendSurfaceEvent` 明确 human transcript 来自 append-origin，模型 surface replacement 不应抹去用户已见会话。因此 replacement 发空 changes 并推进 durable 水位，不伪造成删除用户文本 |
| transient revision | `dsh-api-session-controller/lib/types/assistant-stream.js`：source revision 对每个 start/chunk/end 递增；source index 包含 block/usage/tool 等非文本块。adapter 分别检查二者连续性 |
| normalized revision | 经主集成人确认：本连接首次观察该 attempt 的 source revision 作为固定 revision；opening 用 baseline.revision，正常 start 用 frame.revision。后续归一化 chunk/end 保持此值；跨连接由 epoch 分离，不声称 revision 不变 |
| normalized index | 仅 answer/reasoning delta 增加自己的 dense index；源 index 仍逐帧检查，不能因过滤非文本帧而跳过源缺口 |
| compact baseline | `dsh-llm/lib/types/assistant-stream.d.ts`：text-chunks/reasoning-chunks/tool-call-chunks/chunk 四种；先恢复并核对 nextIndex，再交付 start 和文本增量 |
| settlement | `types/types.d.ts`：assistant-end committed 带 eventType/seq，abandoned 不带；adapter 收到匹配 turn/step 的 durable settlement 时先退休临时投影再 upsert 文本，随后校验 source end，避免同时显示两份文本；attempt 结束不冒充 turn completion |
| turn | `dsh-session/lib/types/types.d.ts`：turn/start、turn/end.reason。completed→completed、aborted→cancelled，其余明确非成功→failed；只有单一可靠 user source.rpcId 时才关联请求，多请求/无来源用 null |
| direct tools | 同上：tool/call `{callId,name,arguments:string}` 与 tool/result `message.toolCallId/isError`；成功 edit/write 提供 confirmed，失败不产生修改成功证据 |
| PTC tools | `dsh-tools/lib/types/types.d.ts`：tool/ptc-dispatch 是嵌套调用持久结算，含 subCallId/name/arguments(object)/isError；直接据此确认内层 edit/write。tool/ptc-dispatch-start 仅尝试，不确认 |
| observer | `dsh-tools/lib/types/index.d.ts`：tools/pre-execute 仍是 waterfall，ToolExecution.agent/name/arguments 均公开。现有 observer 始终 next，通知只作 pre-execute；不以此写入成功账目 |

固定提交公开链接：[controller](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/packages/api/session-controller/src/index.ts)、[commands](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/packages/api/session-controller/src/commands.ts)、[history](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/packages/api/session-controller/src/history.ts)。

## 已实现的边界

- `src/runtime/client.js`：固定自有 facade，Bearer token，不跟随 redirect，不重试修改；JSON/SSE 限额。openFeed 缓存首个 snapshot，建连 deadline 完成后换成 stall；注释心跳更新存活状态。
- `lib/runtimeFacade.js`：鉴权先于读取 body/分配 stream，Origin 请求拒绝，方法白名单，共享 schema，bounded 请求及 SSE 写缓冲，关闭时 abort + return；正常 feed 没有 RPC 30 秒寿命。
- `src/session/transcript.js` / `feedHub.js`：每 instance/session 一条 follow，原子当前 baseline，消费者独立 release，最后引用关闭；新 epoch 清理临时状态；有界退避与投影内存。
- target integration 仅注册自有 facade，不同时挂旧 session REST。旧 adapter 保留；修复 workspace baseline AsyncIterable 的取 iterator 方式。
- wrapper 保留原函数入口，注入 runtimeApi/provider 时走新链路。target rename 回执 `seq:null` 明示未知；workspace.ensure wrapper 的 `created:null` 不伪造是否新建；target 自动 workspace 绑定不创建会话。
- Changes 以 confirmed 证据进入同一 observe sink；pre-execute 保留为有限候选。目标 CH1 通知新增可选 toolCallId（旧通知名及必填字段不变），按 runtime/session/callId 精确配对 beforeText，允许确认先到；路径/工具也须一致，不按时间窗猜。稳定 observationId + session + durableSeq 写入 journal，重启回填可去重；旧 journal 仍沿用原兼容路径。journal.before 持久保存原文，preview/Undo 优先使用它，晚到精确快照可补齐，不覆盖已有快照。
- VS Code `@dsh` 的 markdown 是只能追加的输出：临时 assistant 帧仅显示 progress，已提交 assistant 正文才进入 markdown，每个 durable record 只追加一次。代价是正文按提交后的消息到达，而原生 DSH UI/feed 仍逐 token 流式；abandoned attempt 不会留下重复正文。

## 测试与证据

`test/unit/runtimeFacade120.test.js` 覆盖：投影身份/缺口、共享订阅当前状态、首 snapshot、建连 deadline 撤销、取消清理、未知 admission 不重发、public controller/steer/parts拒绝、source revision/index、settlement、replacement、confirmed Changes、持久 journal 去重、token/Origin 拒绝。

运行时工作流首次真实 facade probe：`D:/Coding/.codex-staging/dsh-020rc1-runtime/facade-probes/run-px2H38/evidence.json`。已确认准确运行时认证、能力、workspace ensure/list/reuse、session create/list/rename、follow 首帧和 return 后新 epoch、idle cancel、同 PID；此路径为本机证据，后续发布报告应汇总脱敏结果，不把机器路径放入产品运行逻辑。

最新定向回归通过 116 项（runtimeFacade120、changeTracker、changeTree、chatParticipant、dshChatClient、editEventProjector），包括 abandoned progress/committed-only、通道乱序快照补齐与真实文件 Undo 优先级。后续修改以最终总体验证报告为准。

真实模型与工具链路证据：`D:/Coding/.codex-staging/dsh-020rc1-runtime/facade-probes/run-6PCmIs/evidence.json`，由运行时工作流执行真实 DSH + 本地确定性 LlmAdapter：两个分离 chunk、一个 durable assistant、completed，活动 turn cancel→cancelled，read/write/edit 真工具写一次性目录，两个 confirmed 各有 callId/sourceDurableSeq。该配置暴露 native 工具，PTC 分支仍需单独真实配置验收。

## 尚需完整验收的限制

1. file/image prompt 的新上传契约没有实现；不能把文本通道成功说成所有 parts 兼容。浏览器附件 ticket 是另一条已经单独设计的路径。
2. LM route/FIM 保持可选且报告 unverified，等待真实 provider 验证；不凭方法存在承诺可用。
3. Changes confirmed 证明成功执行及持久来源。带可靠 callId 的 beforeText/Undo 已实现且有文件级测试，仍需安装态真实工具、预览、accept/undo 全链路验收；没有可靠关联时保留 unknown。
4. chat participant 已采用 progress + committed-only 策略消除 abandoned 重复正文；多 prompt 并行、复合 requestId 的真实语义仍须额外验收。无法关联请求时不结束其他请求。
5. 所有 A01–A13 UI、十分钟稳态、完整 VSIX 安装和回滚证据仍由集成/验收工作流负责，本记录不宣布发布通过。
