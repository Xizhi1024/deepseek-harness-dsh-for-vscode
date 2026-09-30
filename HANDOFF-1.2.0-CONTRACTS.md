# 1.2.0 契约实施索引

更新：2026-09-30。精确目标 `@deepseek-ai/dsh@0.2.0-rc.1`，源码 `4878cdabd87d4041bdaff61d04c966883b9fd07a`；扩展 `1.2.0`，内置集成 `0.10.0`。

架构职责、ports、wire v1 和预算见 [架构契约](PLAN-1.2.0-ARCHITECTURE-CONTRACTS.md)。三条实现线已合入工作树，主集成完成统一 schema/fixture、入口装配和版本配置。未覆盖的发布场景见 [验收报告](HANDOFF-1.2.0-VALIDATION.md)。

| 实现线 | 映射及证据 | 主要交付 |
|---|---|---|
| Runtime | [运行时报告](HANDOFF-1.2.0-RUNTIME-CONTRACTS.md) | 不可变身份、精确版本/实际 Node 检查、profile 隔离、Supervisor、鉴权和所有权 |
| Host | [Host 报告](HANDOFF-1.2.0-HOST-CONTRACTS.md) | `/api/vscode/v1`、公开 controller adapter、规范事件、共享 FeedHub、Changes 确认与去重 |
| Client | [Client 报告](HANDOFF-1.2.0-CLIENT-CONTRACTS.md) | 公开主会话观测/导航、retain 与 revision guarded ticket、nonce/epoch 握手、异步附件 |

主集成人接受的 M1 修订（已同步架构、实现与测试）：

1. 上游 loader 仅支持同包 `client.*.js` 动态 chunk，浏览器 adapter/bridge 改为平铺文件。
2. 上游 source revision 每帧递增，归一化 revision 是连接内 attempt 首见值；上游 index 与文本 dense index 分别验证。恢复固定新 snapshot/epoch，不虚构 cursor。
3. human transcript 取 append-origin；模型 surface replacement 不删除用户可见历史，只推进持久水位。
4. `EditObservation.tool` 增补 `edit|write|null`，CH1 原通知增加可选 `toolCallId`，只按确切 runtime/session/call/tool/path 配对 beforeText；pre-execute 不冒充修改成功。
5. `hello-init.nonce` 必填 32 位十六进制串；shell 先向 host 分配 proxy，再向 iframe 发送，来源检查与 epoch 检查并存。
6. file/image 的上游输入需要 receipt/data，旧 URI 不能可靠映射。文本 prompt 可用，非文本明确拒绝且不暗中读取 URI。
7. 公开 `uiSession.adapter.current` 只代表主 Conversation。DSH 内部右栏/浮动输入器没有已经验证的公开 ref/inputActions 映射；展开或聚焦时 fail closed，有明确提示。此限制保持 A07 未完整通过。
8. VS Code 的追加式 markdown 无法撤回 abandoned 增量，`@dsh` 使用 progress + committed 正文；原生 DSH 页面仍逐增量显示。

实际 npm lock SHA-256：`4a3ec29934e2c7fbe86567de6c0529c43e75f8e5d56a84f4f5d20642901c23af`。CLI integrity：`sha512-F6hKNVoGgBDIzSiyRaIlobq4UD6cwxUjh+nwXqcDmufDh87TE1izsYzs8L5cZNpF2JmPnFM1mXRNnRJ0cs43ng==`。测试执行 Node `24.11.1`，未用含其他修改的本地 DSH checkout 替代目标产物。
