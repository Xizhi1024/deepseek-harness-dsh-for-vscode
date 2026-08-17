# Known Issues / 问题记录

> 记录日期：2026-08-17
> 环境：macOS 本地 VS Code 扩展开发宿主测试
> 对应分支：`master`（已合入 0.6 B0-B4 与两个修复分支）
> 状态：**下面两个问题已在 0.6.0 修复（release/0.6.0），修复后行为待 F5 人工验收；0.6 新特性验收项仍在下文待办。**

## 修复汇总（0.6.0）

| 问题 | 修复方式 | 测试 |
|---|---|---|
| 编辑器空白行右键没有 `dsh.addFileToThread` | `package.json` 的 `menus.editor/context` 增加 `dsh.addFileToThread`，`when: resourceScheme == file`（不依赖 `editorHasSelection`），分组 `dsh@1`；契约测试同步更新 | `test/contracts.test.js` |
| 工作区之外的文件无法添加 | `attachActiveFile({ allowOutsideWorkspace: true })` 仅对 `dsh.addFileToThread` 放开受信任 `file://` URI；已批准的显式附件可经 `openAttachment` 在本窗口重新打开；桥的 `open`/`openDiff`/显式 diagnostics 仍保持工作区内限制 | `test/editorContext.test.js`、`test/unit/addFileToThread.test.js` |

## 1. 文件无法通过右键菜单添加到对话内（空行右键 / 未选中文字时）

- **复现步骤**
  1. 打开一个文件，不选中任何文字。
  2. 在编辑器正文空白行处右键。
  3. 在右键菜单中找不到“将文件添加到 DSH 对话 / Add File to DSH Thread”。

- **实际结果**
  - 编辑器正文区域的右键菜单没有 `dsh.addFileToThread` 入口。
  - 该命令目前只注册在：
    - Explorer 文件右键菜单（`explorer/context`）
    - 编辑器标签页标题右键菜单（`editor/title/context`）
    - 命令面板

- **预期结果**
  - 即使没有选中文字，也能通过编辑器正文右键菜单把当前文件加入 DSH 对话。

- **怀疑原因**
  - `package.json` 的菜单贡献没有添加 `editor/context` 条目。
  - 当前 `editor/context` 只有 `dsh.addSelectionToThread`，且带 `editorHasSelection` 条件，所以未选中文字时菜单里不会出现任何 DSH 文件入口。

- **建议修复方向**
  - 在 `package.json` 的 `menus.editor/context` 增加 `dsh.addFileToThread`，`when` 取消对 `editorHasSelection` 的依赖（例如 `resourceScheme == file`）。
  - 注意与 `dsh.addSelectionToThread` 在菜单中的分组/排序，避免两个入口混淆。
  - 补充 contract/unit 测试，断言编辑器正文右键菜单在无选区时也注册文件添加入口。

- **状态：0.6.0 已修复** —— `editor/context` 现有两条 DSH 入口：`dsh.addFileToThread`（`dsh@1`，仅要求 `resourceScheme == file`）与 `dsh.addSelectionToThread`（`dsh@10`，要求选区）。

## 2. 工作区之外的文件无法被添加

- **复现步骤**
  1. 在 VS Code 中打开一个工作区文件夹。
  2. 打开一个位于该工作区之外的本地文件（例如直接 `File > Open File...` 打开别的目录文件）。
  3. 尝试通过命令或菜单把该文件加入 DSH 对话。

- **实际结果**
  - 添加失败，提示类似：`URI is outside the workspace`。

- **预期结果**
  - 用户显式打开的文件应可被添加到 DSH 对话，不因位于当前工作区之外而被拒绝。

- **怀疑原因**
  - `src/editorContext.js` 的 `assertDocumentUriSafe()` 会调用 `assertUriInWorkspace()`，强制要求文件 URI 必须属于当前某个 workspace folder。
  - 该限制对旧有的“显式编辑器附件”安全模型是合理的，但对于“用户主动添加文件到对话”场景过严。

- **建议修复方向**
  - 单独为 `dsh.addFileToThread` 建立“显式用户操作”路径，允许 workspace 外的 `file://` URI，但仍拒绝 `untitled`、`git`、`vscode` 等非 `file` scheme。
  - 保持 `Add Active File / Add Active Selection / Add Problems` 的 workspace 内限制不变，避免扩大隐式附件的安全面。
  - 补充测试：workspace 外 `file://` URI 可添加；非 `file://` scheme 仍被拒绝。

- **状态：0.6.0 已修复** —— 仅 `dsh.addFileToThread` 使用 `allowOutsideWorkspace: true`；该显式附件被标记并可经草稿链接在本窗口重新打开；非 `file` scheme 与不受信任工作区仍拒绝；`open`/`openDiff`/显式 diagnostics 保持工作区门禁。

---

## 待测试：0.6.0 其他新特性

以下新特性本次尚未在 macOS 本地完整测试，可按提示逐项验收。

### A. `Add File to DSH Thread` 的其他入口
- 在 **Explorer 文件上右键** → 应出现“将文件添加到 DSH 对话”。
- 在 **编辑器标签页标题上右键** → 应出现同一命令。
- 通过 **命令面板** 执行 `Add File to DSH Thread` → 应聚焦侧栏并把当前文件链接加入草稿。
- 点击草稿中的文件链接 → 应在当前 VS Code 窗口打开该文件。
- 验证文件较大时、文件为 dirty/未保存时是否符合预期。

### B. `ctrl+alt+b` 快捷键
- 非终端聚焦状态下按 `ctrl+alt+b` → 应聚焦 DSH 侧栏。
- 终端聚焦状态下按该快捷键 → 不应抢焦点（`when: !terminalFocus`）。
- 若本机已有冲突快捷键，观察 VS Code 是否提示冲突。

### C. `dsh.capabilities` / `dsh.diagnose`
- 执行 `DSH: Capabilities` → 应展示能力目录/类别。
- 执行 `DSH: Diagnose` → 应展示 DSH 插件摘要、binding 状态、配置根等信息。

### D. 工作区绑定（0.6 B1）
- 同一个 VS Code 窗口从一个文件夹切换到另一个文件夹，确认 DSH 子进程不被 kill/重启（进程 PID 不变）。
- 多根工作区中，切换活动编辑器到不同 root 时，确认绑定跟随活动编辑器目录。
- 打开无文件夹窗口时，确认保持 unbound，不报错。

### E. Webview 握手 / 协议（0.6 B2）
- 正常启动后观察状态栏是否出现“桥版本不匹配”提示。
- 使用旧版 DSH client 时，确认 2 秒后回退到 v1 直通，不影响基本使用。

### F. CH1 v1/v2 通知（0.6 B3）
- 在编辑器中移动光标/切换活动编辑器/产生 Diagnostics 时，确认 DSH 侧能收到对应通知。
- 快速连续切换/编辑时，确认通知合并器不丢消息、不出现明显卡顿或错误。

### G. 本地 runtime 发现（修复分支）
- 从 **Finder 直接启动 VS Code**（不走终端），确认使用了 nvm / Homebrew / fnm 等安装的 DSH 和 Node 时，扩展仍能自动发现并启动。
- 终端启动 VS Code 也应保持可用。
- 设置 `dsh.local.packageRoot` / `dsh.local.nodePath` 后，确认自定义路径优先生效。