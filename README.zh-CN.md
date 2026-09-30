# DeepSeek Harness (DSH) for VS Code

[简体中文](README.zh-CN.md) · [English](README.md)

在 VS Code 辅助侧栏嵌入 DSH Web UI，附加编辑器上下文、审阅变更，并通过 `@dsh` 使用本地 DSH 会话。

## 1.2.0 候选版本状态

当前为 **1.2.0 候选版本**，捆绑集成包 **0.10.0**，尚未完成全部发布验收，也未作为 1.2.0 发布到市场。安装态 VSIX 验证正在进行；最终证据及剩余验收项以 [HANDOFF-1.2.0-VALIDATION.md](HANDOFF-1.2.0-VALIDATION.md) 为准。

目前已通过真实 DSH 运行时及浏览器 UI 验证：三种宽度下共 60 轮搜索、IME 输入、prompt/流式输出/cancel、read/write/edit 工具链、包含断流重连的 601 秒稳态运行，以及 10 次启动/停止。运行时 prompt/工具探针使用可控本地 provider，不代表所有远程供应商和可选功能均已认证。

本候选保留 1.1.8 的文件监听与焦点修复，增加经过认证的运行时接口、共享且有界的会话订阅、基于确认事件的编辑归属，以及不依赖重载 iframe 的会话桥。

## 兼容性

| 项目 | 要求 |
|---|---|
| VS Code | ≥ 1.106，桌面版；不支持远程、虚拟及不受信任工作区 |
| 目标 DSH | 精确版本 `0.2.0-rc.1` 或 `0.2.0-rc.2`（每版本独立精确适配）；安装命令为 `npm i -g @deepseek-ai/dsh@0.2.0-rc.2` |
| 旧版 DSH | 精确版本 `0.1.2-rc.1`，使用独立 legacy 适配器 |
| 目标子进程 Node.js | `^22.19.0 \|\| >=24.0.0`；检查实际选择的可执行文件，不以 VS Code 内置 Node 代替；可设置 `dsh.local.nodePath` |
| 集成包 | 本候选捆绑 `dsh-vscode-integration@0.10.0` |

其他 DSH 版本尚未验证，不能进入受管集成链路。缺少已验证集成握手的外部实例仅供浏览：会话命令与写操作不可用，扩展不会停止该外部进程。

目标版本通过扩展自有、经过认证的 `/api/vscode/v1` 门面通信；旧 REST 路由归 legacy 适配器。带认证的自有子进程通过宿主回环代理嵌入，由代理携带启动 cookie。

## 使用与当前限制

1. 按 `Ctrl+Alt+B` 打开侧栏并连接运行时。
2. **添加到 DSH 对话**将文件、选区、文件夹或 Problems 的紧凑链接加入 **主 Conversation** 草稿，不自动发送。请先收起 DSH 内部右侧栏：展开时明确拒绝插入，因此多输入区域验收 A07 仍为 **partial**。
3. 在 VS Code Chat 使用 `@dsh`。目标适配器显示生成进度，只追加已经提交的助手正文，避免无法撤回的临时回复残留；嵌入的 DSH 原生 UI 保留流式显示。
4. 在 DSH Changes 中查看 diff、接受或撤销。原生工具编辑在执行并确认后记录，此视图不是所有 DSH 工具的执行前审批关卡。

![将 VS Code 选区以紧凑链接附加到 DSH 对话](media/add-to-dsh-thread-example.png)

本候选**尚未认证**非文本 file/image prompt 上传、FIM Tab 补全及完整可选功能矩阵。附加草稿链接不等于上传非文本 prompt parts。Ctrl+K/Ctrl+I、LM 路由、MCP 消费及终端/UI 桥仍是可选功能，打开设置不代表目标版本兼容性已经认证。

## 安装

已有发布版本可从 [Marketplace](https://marketplace.visualstudio.com/items?itemName=Xizhi1024.dsh-vs-sidebar) 或 [Releases](https://github.com/Xizhi1024/deepseek-harness-dsh-for-vscode/releases) 获取，这不代表 1.2.0 候选已发布。本轮候选测试使用独立构建的 VSIX 与隔离的 VS Code 用户数据、扩展目录，不替换日常安装。

## 配置

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `dsh.port` | 3080 | 配置的 DSH Web 端口 |
| `dsh.autoStart` | true | VS Code 启动时拉起自有服务 |
| `dsh.home.mode` | shared | `shared` 使用官方 `~/.dsh`；`isolated` 使用扩展独立 home |
| `dsh.profile` | vscode | 基础 profile；目标追加 `-dsh020rc1` 后缀 |
| `dsh.runtime.version` | 空 | 可选的精确版本选择 |
| `dsh.executablePath` | 空 | 指定可执行文件、包目录或 shim |
| `dsh.closePolicy` | onVscodeExit | 自有服务生命周期策略 |
| `dsh.features.changes-review` | true | 变更审阅树 |
| `dsh.features.chat-participant` | true | `@dsh` 聊天参与者 |
| `dsh.features.ctrl-k` / `ctrl-i` | false | 可选内联编辑命令 |
| `dsh.features.lm-route` / `mcp-consume` | false | 可选 LM/MCP 集成 |
| `dsh.features.tab-completion` | false | 尚未认证的 FIM 概念验证 |
| `dsh.fim.baseUrl` | 空 | 上游 FIM 端点；密钥通过 **DSH: Set FIM API Key** 设置 |
| `dsh.keybindings.ctrlL` | false | Ctrl+L 附加选区 |
| `dsh.bridge.terminal` / `editorRead` / `ui` | false | 可选桥接能力的同意开关 |

完整设置见 `package.json`；通过 **DSH: Diagnose** 查看实际运行时。

### Profile 与数据范围

目标 DSH 运行时下，默认 profile `vscode` 分别变为 `vscode-dsh020rc1` / `vscode-dsh020rc2`，使插件树及 patch 配置与 legacy 分离。**Profile 不隔离 home 级会话与凭据**：使用同一 home 的进程仍共享这些数据；需要独立数据时应使用 isolated home。首次建立 profile 可以继承 donor 模块配置；重启与停止只作用于扩展自有子进程。

## License

[MIT](LICENSE)
