# DeepSeek Harness Sidebar (DSH)

[简体中文](README.zh-CN.md) · [English](README.md)

把本地 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）Web 界面嵌入 VS Code 辅助侧边栏（右侧栏，与 Copilot Chat 同排）。默认情况下，每个 VS Code 窗口都会以当前工作区为 cwd 单独启动并持有一个 `dsh web` 子进程，再以紧凑的全屏 iframe 渲染。

## 安装需求

| 项 | 要求 |
|---|---|
| VS Code | ≥ 1.90，仅桌面版 |
| DSH CLI | 全局安装 `dsh` |
| DSH profile | 已配置，`dsh web` 可启动 |

## 安装

- 开发调试：打开本仓库 → `F5` → **Run Extension**
- 打包安装：`npm i -g @vscode/vsce && vsce package --no-dependencies` → `code --install-extension dsh-vs-sidebar-0.3.1.vsix`

## 使用

- `Ctrl+Alt+B` 打开辅助侧边栏 → **DeepSeek Harness (DSH)** 标签
- 命令：**在浏览器中打开 DSH** · **重启 DSH 服务** · **停止 DSH 服务** · **聚焦 DSH 侧边栏**
- `dsh.autoStart` 开启时，VS Code 启动即拉取服务，即使侧边栏从未打开

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `dsh.port` | 3080 | 探测/启动 DSH Web 服务的端口 |
| `dsh.host` | 127.0.0.1 | 当前 DSH Web profile 要求使用的固定回环地址 |
| `dsh.autoStart` | true | 为当前 VS Code 窗口单独启动 DSH 子进程（false = 只复用配置端点上的用户自管实例）；开启时 VS Code 启动即拉起 |
| `dsh.closePolicy` | `onVscodeExit` | 何时停止扩展自己拉起的服务（见下表） |

`dsh.closePolicy` 取值：

| 值 | 行为 |
|---|---|
| `onVscodeExit` | 仅在 VS Code 退出时停止自管服务（默认） |
| `onViewClose` | 关闭侧边栏视图时也停止自管服务 |
| `never` | 永不自动停止——请使用「停止 DSH 服务」命令 |

任何策略或命令都不会停止被复用的（非自管）实例。

## 兼容性

- VS Code ≥ 1.90（`secondarySidebar`）；显式 `activationEvents`；`extensionKind: [workspace]`
- Windows / macOS / Linux
- 每个扩展自管 DSH 子进程都会收到经鉴权的回环桥接 URL/token；支持此约定的 DSH 版本会把配置路径 POST 回所属扩展宿主，再由 `vscode.window.showTextDocument` 在该扇窗口内打开。`DSH_TEXT_EDITOR=vscode` 仅保留为旧版 DSH 的 CLI 回退；被复用的外部服务仍遵循自身编辑器策略
- iframe 会收到 `dsh_embed=vscode`；支持此约定的 DSH 版本会隐藏内部侧边栏、详情栏和拖动手柄，而「在浏览器中打开」仍保持普通完整布局
- GUI 启动导致 PATH 被截断时自动补齐：`%APPDATA%\npm`（Windows）；已存在的 npm 全局 bin（POSIX）
- 进程清理：`taskkill /T /F` 树杀（Windows——强制终止，非优雅停止）；detached 启动 + `kill(-pid)` 进程组 SIGTERM（POSIX）
- 不受信任 / 虚拟工作区**不支持**（会启动本地进程并操作工作区文件）——已通过 `capabilities` 声明
- 容器/视图 ID `dsh-sidebar` / `dsh.webview` 是**持久化契约**——发布版不可变更（否则用户侧边栏布局重置）
- 界面语言随 VS Code 切换（中/英）：manifest 走 `package.nls.*.json`，运行期文案走 `vscode.l10n`（`l10n/bundle.l10n.*.json`）
- CI：ubuntu / macos / windows 三平台跑 `node src/serverManager.js` 自测

## 实现原理

| 文件 | 职责 |
|---|---|
| `src/extension.js` | 激活、视图提供者、命令、工作区/配置跟随、关闭策略 |
| `src/serverManager.js` | 探测 / 复用 / 启动 / 注册表 / 清理 |
| `src/webviewHtml.js` | iframe 页与状态页 |
| `src/types.js` | 契约常量（端口、BOOT 标记、视图 ID） |

关键行为：

- 探测 `GET /` 响应中的 `__DSH_BOOT__` 标记（3s 超时、3 次重试——DSH 忙时不会误判为不存在而重复拉起）
- 默认 `autoStart` 模式绝不接管其他窗口的进程：端口被占用时最多顺延扫描 50 个端口，每个扩展宿主持有自己的子进程；`dsh-instances.json` 仅保留用于陈旧条目清理与诊断
- cwd = 当前工作区（多根取活动编辑器所在目录；无工作区则继承父进程目录，不回退用户主目录）
- 远程（WSL / Remote-SSH）：`vscode.env.asExternalUri` 端口转发
- 浏览器命令与 iframe 使用同一个 externalized URL，远程会话和连接失败页同样适用
- 仅 iframe URL 增加 `dsh_embed=vscode` 紧凑布局标记；浏览器 URL 不作修改
- 工作区切换：只停旧根下本扩展拉起的实例，再按新 cwd 重新探测
- `onStartupFinished` 激活：`dsh.autoStart` 开启时 VS Code 启动即拉取服务（未打开 webview 时同样安全）
- 默认 `onVscodeExit` 策略下，扩展停用会取消待启动操作、等待串行生命周期队列结算，并树杀期间可能刚出现的子进程；关闭一个 VS Code 窗口不会影响另一个窗口的子进程
- 生命周期流转（连接 / 停止 / 工作区重绑 / 配置协调）统一走一条串行队列，连接期间到来的视图销毁不会误杀刚重绑拉起的进程
- `dsh.stopServer` 与关闭策略**只停自管进程**；被复用的外部实例永不终止
- 注册表清理只过滤死亡条目、不会杀死存活进程；`onVscodeExit` 会在扩展宿主关闭时停止自管子进程，而 `never` 会让它继续运行，直至用户显式停止

## 常见问题

- **DSH 设置里「DeepSeek 官方 API」的密钥是只读的？**
  这是 DSH 的设计：启动环境提供的 `DEEPSEEK_API_KEY` 被视为只读（否则写入会被环境变量静默覆盖）。修复：在启动 dsh web（或 VS Code）的终端里 unset 该变量后重启——`~/.dsh/.credentials.yaml` 中已存的密钥会接管，设置项即可编辑。

## License

MIT © Xizhi1024
