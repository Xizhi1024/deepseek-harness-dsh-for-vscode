# Version Ledger / 版本台账

> 每轮开发会话的版本更变记录（扩展版本 ↔ 验证过的 DSH runtime 范围 ↔ 上游问题状态）。
> Per-round version changes: extension version, verified DSH runtime range, upstream issue status.
> 本文件不进 VSIX（check-package-contents 阻断）。Not shipped in the VSIX.

## 当前支持范围 / Current support envelope

| 项 / Item | 值 / Value |
|---|---|
| 扩展版本 / Extension | 1.1.1 |
| DSH runtime 下限 / floor | `0.1.0-rc.7`（--no-open 启动旗标要求；更早版本在健康探测前退出） |
| 实测基线 / verified installs | `0.1.1-rc.2`（本地 npm 全局安装，2026-08-23） |
| 上游核对基线 / verified upstream | master `49a606bc5b` = `0.1.2-alpha.5`（2026-09-02 fetch） |
| 线协议兼容 / wire compat | `session.list` / `session.create` / `session.rename` / `session.prompt` / `GET /api/session.export` 信封、载荷、行键在 0.1.0-rc.7 .. 0.1.2-alpha.x 全程不变（2026-09-02 逐面核实） |

## 轮次记录 / Rounds

### Round 2026-09-02 · 1.1.0（session-5f3403fe，HEAD 36a5991）

- 扩展 1.0.2 → 1.1.0：B2 会话治理 / D1 断点桥(32→35) / D2 Diagnose 改版 / D3 onboarding / F-f 端口释放 / D5 发版准备 + 三实测后续修复（标题键名 332cc10、打包加固 d882375、HMR 抖动止损 efad8e5）。
- DSH runtime：本地 `0.1.1-rc.2`；上游源码仓已更新（用户告知），本地未核对。
- 已知上游问题（三件，本轮实测取证）：①双前缀导出命名 ②session.list 投影列缺失 ③HMR 窗口工具崩溃。

### Round 2026-09-03 · 1.1.1（本会话，兼容/适配轮）

- 扩展 1.1.0 → 1.1.1。
- **上游核对结论**（vs master 49a606bc5b = 0.1.2-alpha.5，修复均落在 0.1.2-alpha.1）：
  - ① 双前缀导出命名：**未修**。`sessionLogZipFilename` 移至 `packages/session-query/session-log-export/src/archive.ts:277` + `client/controller.ts:31`，仍拼 `dsh-session-` + 完整 sessionId；测试只覆盖 `a/b→a_b`，无双前缀用例。本地全局安装热修保留；复现与建议修法见 `docs/dev/upstream-issues.md`。
  - ② session.list 投影列缺失：**已修**（`cdb4cc3c68`→`49df707c86`，per-session projection cache 冷读种子 + 创建期 checkpoint + 跨版本读兼容；0.1.1-rc.2 不含）。注意：投影列仍为可选列（缓存缺失 + 大会话跳过 probe 时整列省略）——双形状标题读取器继续有效。
  - ③ HMR 窗口工具崩溃：**默认暴露已移除**（`fd814589fb` module HMR 全面 opt-in，shipped profiles 全关；vendored hmr 源码本身 1.0.16→1.0.17 仅版本号变更）。旧 runtime（≤0.1.1-rc.2）仍暴露——内容感知同步（efad8e5）继续作为扩展侧防线。
- **兼容层**：`dshCompat.js` 新增 `deriveRuntimeIssues`（supported / exportDoublePrefix / sparseProjectionTitles / moduleHmrWindowCrash 四旗标，诊断专用）+ 三个版本常量；Diagnose 报告 compat 区渲染。
- **适配**：`managedRuntimeLaunch.compareDshVersions` 支持 `-alpha.N`/`-beta.N` 预发布（此前 `0.1.2-alpha.5` 解析为 null，全部版本门控落入乐观路径——本轮修复的 bug）；上游包更名注释化（apiproxy → session-controller，双版本注记）。

**同轮事故处置（00:41 开发测试失败）**：session-49fad0a7 里所有工具调用（含无工具 run_code）0ms 即报 `Cannot read properties of undefined (reading 'kind')`——即问题③在 0.1.1-rc.2 的实测复现。取证链：profile `node_modules/dsh-vscode-integration/lib/` 文件在 00:19:37 与 01:18:29 两次被扩展激活同步改写 → rc.2 base 以 `id: hmr` 启用 cordis-plugin-hmr（module HMR 默认开）→ fiber 热重载 → `tools/pre-execute` waterfall 返回 undefined → `gate.kind` 抛错（dsh-tools lib/index.js:3105-3106）。**本地止血（对齐上游 fd814589fb 方向）**：`~/.dsh/profiles/web/cordis.patch.yml` 追加 `id: hmr` disabled 行（备份 cordis.patch.yml.bak-20260903）；杀掉 3081 旧子进程（17:46 起、已污染）；一次性实例 3099 以修补后 profile 端到端复测原测试——run_code 写盘 + node 执行全通、kind 错误 0 次。后续扩展同步集成文件不再触发模块重载；窗口 runtime 由扩展按需重生（自动带新 profile）。

### Round 2026-09-03 深夜 · 1.1.1 P0 修复（reading-kind 事故闭环 + 发版门禁）

- **根因（984d0aad/49fad0a7 等 reading-kind 全灭事故）**：runtime-integration/lib/editObserver.js 的 tools/pre-execute 监听器返回值不调 next()——cordis waterfall 语义为「不调 next() 即以返回值短路整条链」（上游 AGENTS.md 明文），于是 gate=undefined → dsh-tools 读 gate.kind 崩溃 → 该子进程内所有工具调用 0ms 报错（run_code 也是工具）。挂载条件 = 扩展子进程且 versioned bridge 成功启动（index.js:389），故 API 直连探针与无 bridge 实例全部健康、用户侧栏会话必死——「时好时坏」表象由此而来。事故起点 2026-09-02 00:19（C2 文件首次进 profile），今日 21:23/21:59 两轮复现同一根因。
- **次生根因（输入框消失 / #6 回归）**：1.0.0 VSIX 从落后于提交树的脏工作区打包，捆绑 client.js 缺 startEmbeddedSessionFollow；1.0.0 窗口每次激活把回归字节同步进 profile junction，与 F5 dev-host（同步仓库正确字节）乒乓互覆。
- **修复**：① editObserver 恒 return next()（回归测试覆盖全部工具名与抛错路径）；② 发版门禁新增「打包树==git HEAD 逐文件 + sessionFollow 金丝雀」；③ junction 已恢复为仓库字节（editObserver 5823B 修复版在位）。
- **运维事实**：rc.2 不支持 --patch（PATCH_OVERLAY_MIN=0.1.0 断言错误）——扩展子进程全部经 patch-drop 自愈启动，embed overlay 在 rc.2 上从不生效；双窗口（1.0.0 + F5 dev-host）争夺子进程/端口（3082 四次重生、3080 于 21:52 被抢占重生）。F5 测试期间建议禁用 1.0.0 扩展窗口。
- 门禁：integration 101/101、editObserver 12/12、check:w0 全绿后提交。
## 上游版本 → 扩展行为速查 / Runtime behavior matrix

| DSH runtime | supported | sparseTitles | moduleHmrWindowCrash | 备注 |
|---|---|---|---|---|
| < 0.1.0-rc.7 | no | — | — | 拒启动旗标，spawn 前自愈重试兜底 |
| 0.1.0-rc.7 .. 0.1.1-rc.2 | yes | yes | yes | 本轮实测基线；标题靠 one-shot rename 兜底 |
| 0.1.2-alpha.1 .. alpha.5 | yes | no | no | projection cache + HMR opt-in 生效 |
| 任意已发布版本 | — | — | — | exportDoublePrefix 恒为 yes（上游未修） |

