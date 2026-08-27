# DSH for VS Code — 让 DeepSeek Harness 住进你的编辑器

> 官方 DeepSeek Harness（DSH）智能体的 VS Code 原生入口。
> 代码在左，DSH 在右，一个窗口完成「问 → 改 → 验」闭环。

## 30 秒认识

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 是 DeepSeek 开源的智能体运行时：工具调用、MCP、会话、技能、插件生态一应俱全。**DSH for VS Code** 把它整个嵌进 VS Code 辅助侧边栏——不是截图式的假嵌入，而是逐窗口托管的真服务：

- **每窗口一个托管实例**：打开 VS Code 即自动启动 `dsh web`，以当前工作区为 cwd；关掉窗口服务干净退出，不留孤儿进程
- **零配置发现**：npm / pnpm / yarn / scoop / volta / nvm / fnm 装的 DSH 都能自动找到；找不到还能从 PATH 上的 `dsh` 命令兜底
- **编辑器级集成**：复制走 VS Code 剪贴板、文件链接在当前窗口打开、网页链接进 Simple Browser、主题跟随 VS Code 明暗

## 为什么不是「套壳」

| 能力 | 说明 |
|---|---|
| 选区即上下文 | 右键 **Add to DSH Thread**，选区变成紧凑的 file:line 链接进入草稿——绝不自动发送 |
| Ctrl+K / Ctrl+I | 选中代码下指令，或多文件上下文一次带入 |
| 变更审查树 | DSH 推送的文件改动出现在 **DSH Changes** 树：diff、接受、撤销，全部带审批 |
| LM 路由 | DSH 模型注册进 VS Code 语言模型选择器（vendor `dsh`），其他扩展也能调用 |
| MCP 消费 | VS Code 侧配置的 MCP 服务器经同意门供 DSH 使用 |
| Chat Participant | `@dsh` 直接进 VS Code 聊天框 |
| FIM 补全 | Tab 补全接 DSH 模型（配 API Key 即用） |
| 多实例 | 一个窗口多个 DSH 面板，各自独立会话 |

## 1.0.0 的新东西

- **Windows 发现大修**：PATH shim 扫描 + pnpm/yarn/scoop/volta 布局，非 npm 安装零配置识别
- **启动方式可配**：`dsh.launch.method`（auto/managed/command）+ `dsh.executablePath` + `dsh.extraArgs`
- **自愈**：老运行时拒收 `--no-open` 自动去参重启；连接失联看门狗 + 一键重试；静默端口自动发现机器上在跑的 `dsh web`

## 上手

```bash
npm install -g @deepseek-ai/dsh
```

VS Code 扩展市场搜索 **DSH**（发布者 Xizhi1024），或：

```bash
code --install-extension Xizhi1024.dsh-vs-sidebar
```

`Ctrl+Alt+B` 打开侧栏，完成。

## 链接

- 市场：<https://marketplace.visualstudio.com/items?itemName=Xizhi1024.dsh-vs-sidebar>
- 源码：<https://github.com/Xizhi1024/deepseek-harness-dsh-for-vscode>
- DSH 本体：<https://github.com/deepseek-ai/deepseek-harness>

MIT License · 环回地址边界 · 不读取任何凭据
