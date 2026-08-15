# DeepSeek Harness Sidebar (DSH)

[简体中文](README.zh-CN.md) · [English](README.md)

把本地 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）Web 界面嵌入 VS Code 辅助侧边栏（右侧栏，与 Copilot Chat 同排）。默认情况下，每个 VS Code 窗口都会以当前工作区为 cwd 单独启动并持有一个 `dsh web` 子进程，再以紧凑的全屏 iframe 渲染。

## 安装需求

| 项 | 要求 |
|---|---|
| VS Code | ≥ 1.90，仅桌面版 |
| 托管运行时（`dsh.autoStart=true`） | VS Code global storage 下已有校验通过的运行时，或配置 `dsh.runtime.manifestUrl` 进行安装 |
| DSH CLI（仅 `dsh.autoStart=false`） | 全局安装 `dsh` |
| DSH profile（复用模式） | 已配置，`dsh web` 可启动 |

## 安装

- 开发调试：打开本仓库 → `F5` → **Run Extension**
- 验证：`npm ci` → `npm run check:w0` → `npm run test:extension-host`
- 密钥扫描：`npm run test:secrets` 扫描将进入 VSIX 的源码/文档（不扫 `node_modules`、`.git`、`.vscode-test`），命中硬编码桥接 token、`Authorization: Bearer` 凭据、API key、私钥或密码字面量时以 1 退出；示例/测试 fixture 使用显式 `// allow-secret-scan` 注释放行。
- 打包安装：`npm i -g @vscode/vsce && vsce package --no-dependencies` → `code --install-extension dsh-vs-sidebar-0.3.1.vsix`

## 使用

- `Ctrl+Alt+B` 打开辅助侧边栏 → **DeepSeek Harness (DSH)** 标签
- 命令（全部 11 条）：**在浏览器中打开 DSH** · **新建会话** · **切换会话** · **重启 DSH 服务** · **停止 DSH 服务** · **聚焦 DSH 侧边栏** · **将活动文件添加到 DSH 上下文** · **将活动选区添加到 DSH 上下文** · **将 Problems 添加到 DSH 上下文** · **能力与集成** · **诊断**
- `dsh.autoStart` 开启时，VS Code 启动即拉取服务，即使侧边栏从未打开

## 会话切换

**新建会话** / **切换会话** 使用 DSH 本地会话 API。**切换会话** 通过 QuickPick 展示每个根会话的标题、工作区路径、更新时间与运行状态；选中后 iframe 会带上 `dsh_session` 查询参数重载，DSH Web 界面据此打开对应会话。扩展不维护第二份会话树——DSH 服务本身始终是会话数据的唯一来源。**新建会话** 会为当前工作区根目录创建会话；若同 cwd 下已存在 blank 会话，则优先复用而不是重复创建。

## 编辑器上下文（显式附加）

扩展不会隐式发送任何编辑器内容。活动文件、选区与 Problems 只有在你执行「将 … 添加到 DSH 上下文」命令后才进入 DSH；之后 `vscode_editor` 工具只能经版本化桥读回这些已批准的附件。

- 文件、选区与 Problems 附件只存在于窗口内存，工作区根目录变化时自动清空。
- 超过 1 MiB（UTF-8）的附件直接拒绝而不是静默截断；诊断上限为 1000 条、每条消息 2000 字符。
- 只有受信任且位于已打开工作区文件夹内的 `file` URI 才能被附加、打开、Diff 或查询诊断——桥不暴露任意命令、URI 或文件读取。
- 发往 DSH 的 `vscode/contextChanged` 通知只携带 revision 与 attachment id，永不携带内容。

## 能力与诊断

**能力与集成** 会聚焦 DSH 侧边栏，并在 DSH Web 界面中打开能力中心。扩展内置一个受控的小型 provider 目录（`src/capabilityCatalog.js`）与 provider 检测器（`src/providerDetector.js`），本轮只报告四个框架候选的安装/启用状态：

- 远程开发：`ms-vscode-remote.remote-wsl`、`ms-vscode-remote.remote-ssh`
- GitHub：`GitHub.vscode-pull-request-github`
- 浏览器：`browser-provider-placeholder`（在 W5 选定并验证浏览器 provider 之前的框架占位）

扩展从不安装第三方 provider。**本轮所有第三方 provider 均为 `manual-assist`**；由于稳定接口审计（G3）尚未关闭，任何条目都不会被标记为 `integrated`。`vscode/extensions/openDetails` 只会打开目录受控的 VS Code 扩展详情页或官方 `https://` 文档页——不存在任何安装代码路径。

**诊断** 会读取 `dsh.*` 配置、服务状态、桥接状态、目录 revision 与 provider 检测结果，并显示一条摘要消息。完整诊断输出与 OutputChannel 有意留到后续 W4 切片。

provider 状态通过 `vscode.extensions.onDidChange` 刷新，并在版本化桥上发送 `vscode/providerStatesChanged` 通知。检测器每次调用都会重新读取 `vscode.extensions`，绝不跨工作区缓存状态。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `dsh.port` | 3080 | 探测/启动 DSH Web 服务的端口 |
| `dsh.host` | 127.0.0.1 | 当前 DSH Web profile 要求使用的固定回环地址 |
| `dsh.autoStart` | true | 为当前 VS Code 窗口单独启动 DSH 子进程（false = 只复用配置端点上的用户自管实例）；开启时 VS Code 启动即拉起 |
| `dsh.closePolicy` | `onVscodeExit` | 何时停止扩展自己拉起的服务（见下表） |
| `dsh.runtime.manifestUrl` | （空） | 运行时发布清单（`schemaVersion: 1`，`artifacts` 内嵌运行时 manifest）的 HTTPS URL。留空 = 仅使用 VS Code global storage 下已安装且校验通过的运行时 |
| `dsh.runtime.version` | （空） | 可选的 DSH 运行时版本锁定。留空 = 使用已安装的当前版本；需要通过 manifest URL 安装时则选择最新的匹配 artifact |

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
- 自管子进程还会收到扩展在 VS Code global storage 下动态生成的 `--patch` overlay，用于禁用已知会在嵌入模式重复叠加侧边栏/右面板的第三方插件（`better-sidebar`、`ui-dsh-aionui-panel`）。未安装这些插件时 overlay 不产生效果；该补丁不修改 DSH 源码、profile 或 `cordis.patch.yml`
- 托管 autoStart 每次 spawn 前都会解析并校验运行时（指针、manifest、payload SHA-256）。清单缺失、哈希错误、无平台匹配、`dsh.runtime.manifestUrl` 为空且未安装等一律 fail closed，通过侧边栏状态页展示错误——扩展**绝不回退到 PATH 上的 `dsh`**
- GUI 启动导致 PATH 被截断时自动补齐：`%APPDATA%\npm`（Windows）；已存在的 npm 全局 bin（POSIX）——仅与 `dsh.autoStart=false` 复用模式相关
- 进程清理：`taskkill /T /F` 树杀（Windows——强制终止，非优雅停止）；detached 启动 + `kill(-pid)` 进程组 SIGTERM（POSIX）
- 不受信任 / 虚拟工作区**不支持**（会启动本地进程并操作工作区文件）——已通过 `capabilities` 声明
- 容器/视图 ID `dsh-sidebar` / `dsh.webview` 是**持久化契约**——发布版不可变更（否则用户侧边栏布局重置）
- 界面语言随 VS Code 切换（中/英）：manifest 走 `package.nls.*.json`，运行期文案走 `vscode.l10n`（`l10n/bundle.l10n.*.json`）
- CI：ubuntu / macos / windows 三平台执行静态检查、`node:test`、VSIX 内容门禁与 Extension Host 激活 smoke

## 已知限制

- **VS Code `< 1.106`**：不支持 `secondarySidebar` 视图容器贡献点。扩展仍能激活，Extension Host smoke 在 1.90 上通过，但 VS Code 会记录 `secondarySidebar` 贡献点警告，DSH 视图可能回退到 Explorer 侧边栏。
- **真实 browser provider 尚未接入**：能力目录当前仅列出 `browser-provider-placeholder`，provider 选定与验证留待 W5。
- **Extension Host smoke 版本**：smoke 测试目前固定运行在 VS Code 1.90 上。

## 实现原理

| 文件 | 职责 |
|---|---|
| `src/extension.js` | 扩展宿主组装与 DSH 连接协调 |
| `src/editorContext.js` | 显式编辑器附件、打开/打开 Diff、诊断与工作区 URI 门禁 |
| `src/capabilityCatalog.js` | 受控 W4 provider 目录、URI 白名单、目录 revision |
| `src/providerDetector.js` | provider 安装/启用/健康检测、桥接 handler、诊断快照 |
| `src/versionedBridgeServer.js` | 版本化回环桥（编辑器、诊断、扩展） |
| `src/textDocumentBridge.js` | 每窗口 token 回环桥，用于打开 DSH 拥有的文本文件 |
| `src/bridgeWorkspace.js` | 桥接工作区身份与信任分类 |
| `src/embedOverlay.js` | 为自管 DSH 子进程动态生成 `--patch` overlay |
| `src/lifecycle.js` | 生命周期串行队列与停用门禁 |
| `src/runtimeEnvironment.js` | GUI 启动 PATH 修复 |
| `src/managedRuntimeLaunch.js` | 已验证托管运行时启动规格、profile/路径归一化、`--patch` 透传 |
| `src/runtimeResolver.js` | 托管运行时解析与 current/last-good 指针校验 |
| `src/runtimeProvisioner.js` | 发布清单解析、artifact 选择、解析或安装编排 |
| `src/runtimeArtifact.js` | 运行时 manifest 校验、SHA-256 校验、运行时目录校验 |
| `src/runtimeArchive.js` | 托管运行时的 tar.gz 安全解包 |
| `src/runtimeDownloader.js` | HTTPS 运行时下载（带重定向上限与 SHA-256 校验） |
| `src/runtimeInstaller.js` | current/last-good 运行时安装、指针切换、原子写入 |
| `src/serverManager.js` | 探测 / 复用 / 启动 / 注册表 / 清理 |
| `src/sessionNavigation.js` | DSH 会话列表/创建 API 客户端与 QuickPick 映射 |
| `src/vscodeFacade.js` | 可注入的 VS Code API 表面 |
| `src/webviewHtml.js` | iframe 页与状态页 |
| `src/webviewMessages.js` | 固定 Webview 消息路由 |
| `src/workspaceContext.js` | 设置、工作区根与注册表路径 |
| `src/types.js` | 契约常量（端口、BOOT 标记、视图 ID） |

关键行为：

- 探测 `GET /` 响应中的 `__DSH_BOOT__` 标记（3s 超时、3 次重试——DSH 忙时不会误判为不存在而重复拉起）
- 每次 autoStart spawn 前，`connectNow` 都会解析并校验托管运行时（缺失时按 `dsh.runtime.manifestUrl` 安装、版本锁定不匹配时重新安装），再通过 `ServerManager.setResolvedRuntime()` 交给启动器；每次连接都重新校验，失败直接显示在状态页而不是 spawn
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
- 编辑器桥请求拒绝非 `file` URI、`workspace.getWorkspaceFolder` 之外 URI 与不受信任工作区；远程 URI 从不被转换成本地路径

## 常见问题

- **DSH 设置里「DeepSeek 官方 API」的密钥是只读的？**
  这是 DSH 的设计：启动环境提供的 `DEEPSEEK_API_KEY` 被视为只读（否则写入会被环境变量静默覆盖）。修复：在启动 dsh web（或 VS Code）的终端里 unset 该变量后重启——`~/.dsh/.credentials.yaml` 中已存的密钥会接管，设置项即可编辑。

## License

MIT © Xizhi1024
