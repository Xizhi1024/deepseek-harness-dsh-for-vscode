# DSH VS Code 扩展 1.1.0 · 会话交接 v2（本文取代 v1）

## 上轮会话（上下文恢复入口）
- **会话 id：`session-5f3403fe-1d34-4f23-85fa-b5a1e908a11f`**
- 日志：`C:/Users/MSI/.dsh/sessions/--D-Coding-DSH-deepseek-harness-dsh-for-vscode--/session-5f3403fe-1d34-4f23-85fa-b5a1e908a11f/session.jsonl.zstd`
- 历史 API（共享 home，3080/3081 同库）：POST /api/session.history `{sessionId}`；全量导出走 /api/session.export ZIP
- 关联现场会话：`session-757bce63`（B2 标题键实验）、`session-dc8bcbd1`（F5 HMR 事故）、`session-20222508`（3081 写入复测）

## 事实基线（勿推断，直接采信）
- 仓库 D:\Coding\DSH\deepseek-harness-dsh-for-vscode，分支 feature/1.1.0，HEAD `efad8e5`，已推送 origin
- 本轮 9 提交：`1a7e1ea`(B2 会话治理) `032695e`(D1 断点桥,方法表 32→35——计划文档的"34"是笔误) `9039f57`(D2 Diagnose) `6954962`(D3 onboarding) `06974df`(F-f 端口释放等待) `4ad2780`(D5 发版准备) `332cc10`(标题键名修复) `d882375`(打包加固) `efad8e5`(HMR 抖动止损)
- 测试基线：check:w0 全绿（~715 tests/1 skip 既有）、extension-host proof verified、插件侧 node --test 99/99
- 版本 1.1.0；CHANGELOG 已定稿（2026-09-02）；`dsh-vs-sidebar-1.1.0.vsix` 已产出（107 files/1.62MB，含全部修复）
- **上游 dsh 源码仓库已更新（用户告知）**；本地 npm 安装仍 0.1.1-rc.2（08-23 装），双前缀热修（剥前导 session-）在位

## 架构定案（用户裁定，勿复议）
1. 权限单源=DSH 沙箱（三档在 DSH 侧）；扩展只添砖（追踪/归因/审计/Undo），不自设任何门
2. changes/push=直写通道（校验→快照→applyEdit→journal，无弹窗无工作区边界）
3. 追踪=全源三层：bridge 直写 / tool-intercept（C2 拦截+C2.5 投影双路，幂等合并）/ external（C1 watcher 熔断降级）
4. 变更树默认跟随当前侧边栏会话（dsh.changes.toggleScope 切全局）
5. 安全网=快照+树 Undo；人是 Reviewer 不是守门员
6. Codex=设计北极星；worktree 隔离与 hunk 级操作远期

## 本轮新知识（硬证据，勿重查）
1. **session.list 标题键 = `projections.values.title`（纯字符串）**；旧 `sessionTitle.title` 包装已废。`rootSessionItems.readableSessionTitle` 已双形状兼容（332cc10）
2. **session.list 投影列行级 fail-soft 缺失**（实测 384 行中 ~234 行 projections=null，history 里 title 存在）→ 显式 `session.rename` 可强制恢复列（757bce63 实验证实，seq 5009 前后对比）。上游 issue 素材齐
3. **HMR 热重载窗口打崩所有工具调用**（`Cannot read properties of undefined (reading 'kind')`，连无工具调用的 run_code 都死）→ 窗口后自愈（3081 复测 run_code+tools.write 成功）。止损：installDshIntegration 已内容感知（字节一致跳过，efad8e5）；窗口崩溃本身是 cordis-plugin-hmr/dsh-tools 上游问题
4. `D:\Coding\DSH\dsh-vscode-integration` 是用户独立检出（**非 git 仓库**），symlink 进 profile web/node_modules；扩展每次激活会同步覆写它（已告知用户 git init 或改 junction）
5. 权限档位 workspace-write 下 tools.write 实测正常（cwd 小写盘符 `d:\` 也过）——F5 事故与权限/沙箱无关
6. 3080=本 harness 实例、3081=用户 VS Code 窗口扩展子进程（17:46 起），同 home 同会话库；实例角色会漂移，用 Get-NetTCPConnection 现查
7. 仓库根 `dsh-write-probe.txt` 是变更树验收素材（deliberately 未删）

## 剩余工作（优先级序）
1. **上游 dsh 更新落地核对**：`git -C D:/Coding/DSH/deepseek-harness pull && git log` 看更新内容；对照重验三件事——①双前缀导出命名（官方修了就能撤本地热修）②list 投影列缺失 ③HMR 窗口崩溃——修了关 issue 素材，没修整理最小复现报上游；评估扩展侧 runtime manifestUrl/最低版本是否要动
2. A10 FIM 手动复测（需人工 F5，清单在 PLAN-1.1.0-REMAINING.md：幽灵文本/Tab/Esc/503 指引/api 日志）
3. 发版决策（用户拍板）：vsce publish / 打 v1.1.0 tag / 合 PR——产物就绪
4. 可选：变更树端到端验收（素材已落盘，用户新窗口确认 dsh-write-probe.txt 归因分组）

## 踩坑必读（本轮新增，叠加 v1 仍有效的）
- **pwsh 命令里 Windows 反斜杠路径会被传输层吞**（`C:\Users\MSI` → `C:UsersMSI`）→ 一律正斜杠 `C:/Users/...`
- JSON bundle 手工追加结尾**别带尾逗号**（本轮犯两次）；改前 Select-String 查键名冲突
- run_code 里模板字符串含反引号会炸整个程序解析 → 行数组 join；pwsh 工具的 stdout 是对象不是字符串
- edit 工具要求目标文件"近期被 read 过"——提交/他改后需重读再编辑
- git commit -m 内嵌双引号会断命令（本轮丢过一次提交）→ 消息里不用双引号
- vsce 会打进一切未被 .vscodeignore/.gitignore 挡住的文件（.dsh-repair 2MB 泄漏事故）→ 新禁止类已进 check-package-contents.js（.dsh-* 目录、PLAN-*、USABILITY-AUDIT）
- **并行领地勿动**：`.dsh-repair/`（用户日志修复工作区）、`.dsh-accept-test/`、`.vscode/launch.json+tasks.json` 本地改动——均不提交
- git 前 Remove-Item Env:GIT_CONFIG_*；npm 用 npm.cmd+落盘取证

## 开工动作
1. `git log --oneline -12` 对照上面的提交链核基线 → `git -C D:/Coding/DSH/deepseek-harness` 拉上游更新做核对（剩余工作#1）
2. 背景补充可读 v1（PLAN-1.1.0-HANDOFF.md）；冲突时以本文为准
3. 取件纪律：派发五段式（事实基线/锚点/允许文件集/验收/纪律）；全绿跑完整门禁再提交