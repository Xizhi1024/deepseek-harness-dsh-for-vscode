# 可用性审计（第二批问题）· 2026-08-28

依据：F5 验收报告 §三 轻缺陷 + 源码取证（标注 🔍 的为代码证实）。
分级：P0 = 高频路径/首装即遇；P1 = 明显不便；P2 = 打磨项。

## P0

### U1 🔍 状态栏指示器点击无动作
- 证据：extension.js 无 `statusBar.command` 赋值——指示器纯展示。
- 对比：竞品 Fengze 版四态指示器点击即开关面板。
- 修复：`statusBar.command = 'dsh.focusSidebar'`（一行）+ tooltip 列出 Restart/Stop/Diagnose。

### U2 🔍 注入类设置改了不生效也无提示
- 证据：onDidChangeConfiguration reconcile 只覆盖 host/port/autoStart/launch 等（extension.js:1363-1382）；`dsh.fim.*`、`dsh.features.tab-completion`、`dsh.bridge.*` 改后需手动 Restart Server，但没有任何提示。
- 用户体感：设置了 FIM baseUrl/key → Tab 还是不补全 → 以为坏了。
- 修复：这些键加入 affectsConfiguration 判断 → 弹 "设置需重启 DSH 服务生效，Restart now?" 询问。

### U3 核心肌肉记忆默认全关
- Ctrl+L（选区进对话）、Ctrl+K（内联编辑）、Ctrl+I（多文件）全部默认关且无键位贡献。首装 5 分钟用户只学到 Ctrl+Alt+B。
- 对比 Cursor/Claude Code：Cmd+K/Cmd+L 是产品记忆点。
- 修复：0.9.4 已给 changes-review/chat-participant 默认开；快捷键侧建议 Ctrl+L 默认开（低风险：只往草稿加链接不发送），Ctrl+K 保持 opt-in 但在 onboarding 向导里给出"启用并绑定键位"一键项。

### U4 MCP 同意流程手输服务器名（验收 §三.2）
- 证据：extension.js:2466 `showInputBox({ prompt: "MCP server name..." })`。
- 修复：改 showQuickPick 列出已配置服务器；Forget 后的再次询问逻辑同步修（验收发现 Forget 后复调未再问）。

## P1

### U5 会话命令成功后不 reveal 侧边栏（验收 §三.1）
- New/Switch Session 成功只有 toast，侧边栏可能还折叠着。
- 修复：命令成功路径追加 `focusSidebar`。

### U6 变更树空态无引导
- changes-review 默认开，但树上长期空白，用户不知道它何时会有内容、能干什么。
- 修复：TreeItem 空态显示 welcome content（contributes.viewsWelcome）："DSH 通过桥推送编辑时将出现在这里"，附文档链接。

### U7 Diagnose 输出对普通用户不可读
- 全大写错误码（HEALTH_TIMEOUT 等）被验收人员误认为实错；摘要一行消息信息密度低。
- 修复：Diagnose 弹窗改 QuickPick 分区菜单（服务/桥/兼容性/插件各一项），错误码映射为人话 + 建议动作；详细 JSON 留 OutputChannel。

### U8 findFiles 大仓库桥超时（验收 §三.6）
- 用户体感："让 AI 找个文件它说找不到"。
- 修复：桥侧加超时与默认 exclude（node_modules/.git/dist），超时时返回带提示的空结果而非挂死。

## P2

### U9 端口冲突不可见
- 探测 3080-3082 自动换口，但实际端口只在 Diagnose 里能查。
- 修复：端口非默认时状态栏 tooltip 显示 "port 3081"。

### U10 WSL 默认终端毁掉 node 调试（验收 §四，文档项）
- 默认 profile=wsl.exe 时 launch 的 node 调试退出码 1、getStack 挂起。
- 修复：README 兼容性表 + Diagnose 检测默认终端为 WSL 时给提示。

### U11 onboarding 向导与功能开关脱节
- 向导只列 L1/L2 开关名，没有说明每个开关干什么、开了会怎样；FIM 三步配置（baseUrl/key/restart）向导完全不覆盖。
- 修复：向导 feature 步每项加 description；新增 "Tab 补全配置" 可选步骤。

### U12 侧边栏视图无法参与自由分栏（对标 Codex 的上下/左右组合视图）
- 现状：DSH 主界面是 `viewsContainers.secondarySidebar` 里的 webview **view**。VS Code 对 view 的布局能力天然有限：只能在 侧边栏/辅助侧边栏/面板 之间拖动、同容器内纵向堆叠——**不能**拖进编辑器网格、不能与编辑器/其它面板组成上下左右分栏。
- Codex 的做法：其可停靠面板是编辑器区的 **WebviewPanel**（registerWebviewPanel），天然支持任意编辑器组分栏、split right/down、最大化。
- 修复路径：主界面双形态并存——
  1. 侧边栏 view（现状）：快速访问形态，保持；
  2. 编辑器 Panel（已有 `dsh.newInstance`）：完整可停靠形态，作为"像 Codex 一样布局"的答案。
  配合 U13 把入口做出来即可，**无需新写布局代码**。

### U13 主视图新开 DSH 窗口不便捷
- 现状：`dsh.newInstance` 命令存在且已支持多面板各自会话（关面板只释放自己的 session），但入口默认关（`dsh.multiInstance.entry` false）、无键位、无 view/title 按钮。
- 修复：
  1. `contributes.menus.view/title` 给侧边栏加 "在编辑器中打开" 图标按钮（Copilot Chat 同款交互模式）；
  2. `editor/title` 加 DSH 图标（Fengze 竞品已验证此入口有效）；
  3. `dsh.multiInstance.entry` 默认改 true；
  4. 键位建议 `Ctrl+Alt+N`（与新建文件区隔）。
  与 U1 联动：状态栏点击 = 侧边栏，长按/命令面板 = 新实例。

## 零输入原则（贯穿性设计要求）

**任何能让用户点选的，都不得要求手输。** 全量输入点审计（src/ showInputBox 穷举）：

| 输入点 | 位置 | 裁定 | 替代设计 |
|---|---|---|---|
| MCP forget consent 手输服务器名 | extension.js:2466 | ❌ 违反 | QuickPick 列出 consent 记录中的服务器 |
| MCP server env 缺值询问 | manager.js:65 | ⚠️ 部分正当 | ① 先查 VS Code secretStorage 同名密钥（OPENAI_API_KEY 等）② key 名含 KEY/TOKEN/SECRET 时 password:true ③ 问完存 secretStorage 下次免问 |
| onboarding 手输 profile 名 | onboarding.js:105 | ❌ 违反 | QuickPick 列 DSH home 已有 profiles（profileProbe.js 探测能力现成）+ "web (默认)" |
| FIM baseUrl 在 settings JSON 手填 | package.json 配置 | ❌ 违反 | 新命令 "DSH: 配置 Tab 补全"：QuickPick 常见端点（DeepSeek beta completions / OpenAI / OpenRouter / 自定义…）→ 顺手引导 key + 重启，三步并一步 |
| FIM API key 输入 | extension.js:2063 | ✅ 正当（密钥） | 保持，但 U2 修后补"重启生效"提示 |
| Ctrl+K 指令输入 | ctrlKEdit.js:76 | ✅ 正当（本质是 prompt） | — |
| 桥 confirm ask | v3.js:575 | ✅ 正当（agent 侧询问） | — |

U4（MCP 下拉化）由 1.0.4 **提前到 1.0.3 批**；onboarding profile 下拉化与 FIM 配置命令并入 1.0.4。

## 建议批次

- **1.0.3 快改**（全部一行到几行）：U1 状态栏 command、U2 reconcile+提示、U5 focus、U6 welcome content、U9 tooltip、U4 MCP forget 改 QuickPick、U13 view/editor-title 入口 + multiInstance 默认开（U12 的落地即 U13）。
- **1.0.4**：U3 快捷键策略、U8 findFiles 防护、onboarding profile 下拉化、FIM 一键配置命令、MCP env 密钥联动 secretStorage。
- **1.1.0 随变更追踪一起**：U7 Diagnose 改版、U11 向导改版、U10 文档。
