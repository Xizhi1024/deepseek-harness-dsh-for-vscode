# DeepSeek Harness(dsh) for VS Code

[简体中文](README.zh-CN.md) · [English](README.md)

**把 Cursor 式的 AI 编程体验带进 VS Code——底层跑的是你自己的 DeepSeek Harness (DSH) Agent。**

在 VS Code 辅助侧边栏嵌入完整 DSH Web UI：每个窗口自动启动并持有一个本地 `dsh web` 服务（cwd = 当前工作区），你的模块、技能、MCP、凭据、会话全部可用。在此之上补齐 IDE 集成层：

- **侧边栏即对话**：`Ctrl+Alt+B` 打开；复制/粘贴/右键菜单、文件跳转、主题跟随全部原生
- **上下文附加**：右键把文件 / 选区 / 文件夹 / Problems 以紧凑链接加入对话草稿，绝不粘贴源码、绝不自动发送
- **DSH 变更评审**：DSH 推送的工作区编辑进入专门树视图，diff / 接受 / 撤销，写文件前必须审批（默认开启）
- **@dsh 聊天参与者**：VS Code 原生聊天里输入 `@dsh` 直连本地 DSH 会话，流式回复，不占 Copilot 配额（默认开启）
- **进阶可选**：Ctrl+K / Ctrl+I 内联编辑、模型路由进 VS Code 选择器、MCP 消费、终端 / UI 桥、FIM Tab 补全——全部挂在显式同意开关后（FIM Tab 补全为 POC，本轮发版**未做端到端检测**，见下表注）

## ⚠️ 兼容性

扩展会在启动前读取已安装官方 DSH 包的版本。`0.1.2-rc.1` 之前预期使用旧 `apiProxy` 主机和原生 session REST 路由；`0.1.2-rc.1+` 预期使用 `sessionController`，由内置集成包补回已移除的 REST 面。版本号只决定诊断预期，最终仍以运行时服务探测为准，因此 fork 与预发布版本不会因静态等待不存在的服务而阻塞启动。

带认证的运行时（`0.1.2-rc.1+`）用 `SameSite=Strict` cookie 保护浏览器面——普通浏览器标签页能持有它，webview 里的 iframe（第三方上下文）不能。自 1.1.6 起扩展会自动经扩展宿主持有的回环转发器嵌入这类子进程（HTTP、SSE 与 Typert WebSocket 全部在宿主侧转发），无需任何配置，新旧行为时侧边栏体验一致。

| 项 | 要求 |
|---|---|
| VS Code | ≥ 1.106，仅桌面版；不支持远程 / 虚拟 / 不受信任工作区 |
| DSH CLI | `npm i -g @deepseek-ai/dsh`，建议 ≥ 0.1.0-rc.7（更老的运行时会自动降级重试，但部分功能受限） |
| Node.js | 自动发现；非标准位置设 `dsh.local.nodePath` |
| Windows + WSL | 工作区在 WSL 内时，请把默认终端配置设为 **Windows** shell（PowerShell/cmd）——WSL 默认终端会让扩展宿主终端与终端桥不稳定；Diagnose 检测到 WSL 默认终端时会提示 |

## 🧪 本版本状态（1.1.6）

**本轮已验证**：面向真实 `0.1.2-rc.1` 子进程的侧边栏嵌入端到端链路（首页、会话创建/列表、SSE 事件流、WebSocket 远程通道与工作区列表，全部经嵌入转发器在第三方 iframe 语境下验证）；窗口端口行为；完整单元测试套件（776 项）。

**未验证 / 已知缺口**：

- 在**开发隔离家目录**（`.vscode-test/f5/`）里对真实模型供应商跑完整对话往返：UI、工作区树与模型目录已验证，但发消息需要先把该家目录的供应商密钥存入（网页版模型设置页写入）或导出环境变量——凭据库按家目录隔离。
- **添加到 DSH 对话**在 F5 实测中出现过一次超时；在忠实复刻的第三方 iframe 环境中整条消息链（扩展 → shell → iframe 客户端 → 应答）验证无误且超时未能复现。若再次出现，请附上具体操作序列提 [issue](https://github.com/Xizhi1024/deepseek-harness-dsh-for-vscode/issues)。
- FIM Tab 补全仍为 POC，未做端到端检测（见上表注）。

**路线图**：下一个大版本将重构运行时边界管理——home/profile 选择、运行时版本协商、子进程所有权、端口/实例发现、启动 URL/token、健康检查与安装版/开发版协调将统一由一份 runtime identity 派生，贯穿 prepare → spawn → 认证就绪 → teardown 全链路；内部会有破坏性变更，用户侧行为保持兼容。

## 📦 安装

- **Marketplace（推荐）**：扩展视图搜索 **DeepSeek Harness**（发布者 Xizhi1024），或 `code --install-extension Xizhi1024.dsh-vs-sidebar`
- **VSIX**：从 [Releases](https://github.com/Xizhi1024/deepseek-harness-dsh-for-vscode/releases) 下载 → `Extensions: Install from VSIX...`

## 🚀 使用

1. 按 `Ctrl+Alt+B` 打开侧边栏——扩展自动启动（或复用）本地 `dsh web` 并加载 UI
2. 编辑器里选中代码 → 右键 **添加到 DSH 对话**，草稿收到 `文件:行号` 紧凑链接，回车发送（Ctrl+Enter / ⌘+Enter 换行）
3. VS Code 聊天视图输入 `@dsh` + 问题，回复来自本地 DSH 会话
4. 让 DSH 经桥提议编辑：变更进入 **DSH 变更** 视图，diff / 接受 / 撤销，未批准不写文件

![将 VS Code 选区以紧凑链接添加到 DSH 对话](media/add-to-dsh-thread-example.png)

常用命令（命令面板 `DSH:` 前缀）：新建/切换会话 · 打开会话历史 · 重启/停止服务 · 在浏览器打开 · 新建 DSH 实例 · 诊断 · 干净重启 · 设置 DSH FIM API Key。

## ⚙️ 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `dsh.port` | 3080 | DSH Web 服务端口 |
| `dsh.autoStart` | true | VS Code 启动即拉起服务 |
| `dsh.home.mode` | shared | shared=共享官方 ~/.dsh；isolated=扩展私有目录 |
| `dsh.profile` | vscode | 扩展专用 profile，与终端 `dsh web` 隔离（见下方备注） |
| `dsh.executablePath` | (空) | 手动指定 DSH 可执行文件/包目录/shim，优先于自动发现 |
| `dsh.closePolicy` | onVscodeExit | 何时停止自有服务 |
| `dsh.features.changes-review` | true | DSH 变更评审（写前审批） |
| `dsh.features.chat-participant` | true | @dsh 聊天参与者 |
| `dsh.features.ctrl-k` / `ctrl-i` | false | 内联编辑命令（Ctrl+K / Ctrl+I） |
| `dsh.features.lm-route` | false | DSH 模型进 VS Code 语言模型选择器 |
| `dsh.features.mcp-consume` | false | DSH 消费 VS Code 侧 MCP 服务器 |
| `dsh.features.tab-completion` | false | FIM Tab 补全——需设置 `dsh.fim.baseUrl` + **DSH: 设置 FIM API Key** 并重启 DSH 服务。⚠️ POC 状态：本轮发版（1.1.2）未做端到端检测（未连接真实上游验证补全链路），配置后若不生效请提 [issue](https://github.com/Xizhi1024/deepseek-harness-dsh-for-vscode/issues) |
| `dsh.fim.baseUrl` | (空) | 上游 FIM 端点（OpenAI 兼容 completions API 完整 URL） |
| `dsh.keybindings.ctrlL` | false | Ctrl+L 把选区加入对话 |
| `dsh.bridge.terminal` / `editorRead` / `ui` | false | 终端 / 编辑器读取 / UI 表面桥（同意开关） |

完整键列表见 `package.json`；诊断用命令 **DSH: Diagnose**。

### 独立 profile

扩展拉起的 DSH 子进程使用自己的 profile（默认 `vscode`），与终端 `dsh web` 所用的 `web` profile 完全隔离——插件树、cordis patch 层、服务实例互不共享。profile 目录不存在时，扩展会自动脚手架一次（web app bundles 清单 + 空 patch 层 + pnpm 设置）。干净重启只作用于扩展自己的子进程，绝不影响终端里跑的 `dsh web`。想改回共用：把 `dsh.profile` 设为 `"web"` 后重载窗口。

## License

[MIT](LICENSE)
