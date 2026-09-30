# VS Code 专用 DSH profile、插件与 IDE 能力契约

制定日期：2026-09-30。状态：**设计契约 v0，尚未实现；P0 核实公开扩展点后冻结 v1**。

本契约落实用户要求：DSH 新增功能和 UI 改动通过插件注入；VS Code 设置负责专用 profile 的启停与功能开关。执行顺序、功能与验收 ID 见 [总计划](PLAN-FULL-IDE-EXPERIENCE.md)。现有 runtime-v1/session-bridge-v1 的语义继续有效；下文 IDE 接口是本项目拟新增接口，不是 DSH 官方 API。

## 1. 部署与唯一所有权

| 对象 | 唯一拥有者 | 约束 |
|---|---|---|
| 设置期望值、文档、编辑器 UI、终端 UI、凭据引用 | VS Code extension host | 不让浏览器读取密钥或任意文件 |
| RuntimeSupervisor | 每 VS Code 窗口一份 | 只管理自己持有的进程；一个活动 child，切换时先停旧再启新 |
| 逻辑 vscode profile recipe | 本扩展发行物 + 用户显式 override | 生成结果版本化；不是共享可变 singleton |
| generation 目录和插件字节 | ProfileManager | 发布后不可变；所有存活实例均以 lease 引用 |
| 会话、Agent、工具、模型服务 | DSH 公开服务 | 优先复用，不能在扩展和插件各执行一次 |
| 通用集成 | dsh-vscode-integration | 保留 facade v1、CH1、基础 browser bridge、精确版本 adapter |
| 新 IDE 能力与专用 UI | 拟新增 dsh-vscode-ide | 使用公开插件扩展点；模块按设置启用/禁用；随同 VSIX 分发 |
| 文档写入 | Host EditTransactionCoordinator | staged 事务唯一实际写入端；原生已落盘工具单独归 observed |

新插件逻辑拆模块，不要求每个模块发布独立 npm 包。依赖/权限/生命周期可分别控制；需要独立版本时才拆包。目标第一版仍锁定 DSH 0.2.0-rc.1。

## 2. 设置及切换语义

以下都是**拟新增**设置，不声称现有安装已经支持。已有 dsh.profile、home、runtime、autoStart、features.* 键保留。

| 键 | 拟定默认 | 语义 |
|---|---|---|
| dsh.vscodeProfile.enabled | true | 是否允许启动受管 vscode profile、注入自有插件并启用集成能力；总开关 |
| dsh.vscodeProfile.plugins.ui | true | 自有 DSH 界面布局/组件；false 使用原生 DSH UI，基础 session bridge 仍由 integration 提供 |
| dsh.vscodeProfile.plugins.tasks | true | 任务状态、恢复、工具过程增强 |
| dsh.vscodeProfile.plugins.attachments | true | 文件/图片收据与附件流程 |
| dsh.vscodeProfile.plugins.edits | true | staged changeset、checkpoint 与审阅事务服务；不会自动批准写入 |
| dsh.vscodeProfile.plugins.context | true | 上下文查询服务；索引构建按实际使用启动，不随开关开启立即全库扫描 |
| dsh.vscodeProfile.plugins.completion | false | FIM/下一处编辑服务；需另有 provider 配置和编辑器功能开关 |
| dsh.vscodeProfile.plugins.models | false | 扩展与 DSH 的额外模型路由/用量集成；关闭不禁用 DSH 原生模型服务 |
| dsh.vscodeProfile.plugins.mcp | false | VS Code 管理的 MCP 集成；不接管用户终端 profile 中的 MCP |
| dsh.vscodeProfile.plugins.skills | false | VS Code 管理的 skills/规则发现与 UI 集成 |
| dsh.vscodeProfile.overrides | 空对象 | 只允许 schema 定义的模块配置；不接受任意 JS/YAML/执行路径；密钥使用 SecretStorage 引用 |

新增键统一以 dsh.vscodeProfile.plugins 对象呈现，但内部子键必须有具体 schema、默认值、依赖与描述；additionalProperties=false。设置名在 P0 冻结后进入 package.json 与中英文说明。所有 profile 选择按窗口生效；多根工作区不能出现每个文件夹各启动一个 child。需要多个隔离运行时的用户使用不同窗口。

拟定的 settings.json 用法示例（实现后才生效，本次不写入用户设置）：

~~~json
{
  "dsh.vscodeProfile.enabled": true,
  "dsh.vscodeProfile.plugins": {
    "ui": true,
    "tasks": true,
    "attachments": true,
    "edits": true,
    "context": true,
    "completion": false,
    "models": false,
    "mcp": false,
    "skills": false
  }
}
~~~

关闭 enabled 即停用整个专用启动；仅将 ui 设为 false 则使用原生 DSH 界面。插件的开关是能力提供者开关，不能只隐藏按钮而后台继续运行。

这里的 true 是请求提供能力；缺少公开映射、依赖、凭据或验收时应显示 unavailable/unverified，不因默认 true 就假装完成。权限敏感字段列 restricted，并遵守 Workspace Trust；普通外观设置不引入额外授权。

### 2.1 启动矩阵

| 总开关 | autoStart | 动作与结果 |
|---|---|---|
| true | true | 激活后按 recipe 解析并启动；所有自动触发共用一次 ensure |
| true | false | 保持停止；明确连接/启动动作才启动 |
| false | 任意 | 不启动专用 profile，不注入插件；保留设置/诊断和显式外部浏览入口 |

总开关 false 不是删除 profile、卸载插件、清空会话或自动切到 web profile。手动 DSH 和其他窗口实例不受影响。若用户主动打开外部 DSH，只提供该实例实际认证的能力；不把外部实例注册成自有，也不自动安装插件。

关闭时若 idle，停止当前窗口自有实例并释放连接；closePolicy=never 不阻止这次明确停用，它只约束自动退出策略。若存在活动任务/待应用事务，进入 draining：阻止新任务，保留查看/取消/收尾入口，当前任务完成后停用。提供明确“立即取消并停用”操作；没有该操作时不因切设置丢失正在运行的任务或草稿。进程已崩溃则不为排空而重新启动。

再次开启先解析当前设置，不强行恢复旧插件集。期望与实际状态分别可见：disabled / stopped / preparing / running / draining / switching / failed；错误时保留恢复入口。

### 2.2 总开关、插件开关和既有功能开关

三类作用不同，不建立双向循环写设置：

- enabled：是否启动专用部署。
- plugins：DSH 能力提供者是否装载/注册。
- features.*：相应 VS Code 入口是否启用，兼容旧键。

effective = profileEnabled AND providerEnabled AND dependenciesReady AND hostFeatureEnabled（没有对应 host 开关时按 true）AND existingPermissionSatisfied。不要把权限条件写进用户开关，也不要开一个功能就擅自打开终端/文件写入授权。

| 现有入口 | 依赖与保留语义 |
|---|---|
| clipboard/thread-attachment/editor-links/statusbar/theme-follow | 基础 integration；图片/非文本再依赖 attachments；状态栏即使停用也可解释状态 |
| changes-review | observed 路径保留；staged/checkpoint 额外依赖 edits |
| ctrl-k / ctrl-i | 新原地编辑需要 edits；未启用时明确不可用；不能静默退回草稿投递却称原地编辑成功 |
| tab-completion | completion + provider；默认仍关闭 |
| lm-route | models + 既有路由配置与同意；DSH 原生模型不受此开关代管 |
| mcp-consume | mcp + 既有 MCP 同意与配置 |
| chat-participant / exports / call-export | 对应既有 facade/bridge 与开关；新 IDE 方法按 capability 判断 |
| bridge.terminal / editorRead / ui | 保留既有授权，不由插件开关替代 |

迁移时，对明确设置过 lm-route/mcp-consume/tab-completion 的老用户，只在新子开关尚未被用户设置时继承意图；使用 configuration.inspect 区分默认值与显式值，不将有效默认值全部写回。新配置的显式 false 永远优先。显示“需要哪个提供者”，由用户在同一设置页启用，不在后台反复互改配置。

### 2.3 生效策略和防风暴

- registry 为每个字段声明 live-ui / live-service / restart-profile。live-service 只有在公开 API 支持幂等卸载、依赖清理且有测试时允许；否则按 restart-profile。
- 展示项直接更新插件拥有的组件状态，不替换整个 iframe；持久期望值纳入下一次解析。
- 插件图、加载参数、工具策略、runtime/home 变化产生新 generation，经 supervisor 切换，不原地改正在加载的文件。
- 250ms debounce；只保留最新一个待应用配置；running/switching 时最多一个后继。相同 effective digest 不重启，失败保持现有冷却，不因焦点/文件事件重试。
- drain 完成后应用**最新**配置；用户在排空中重新开启可以撤销停用。不同窗口不得被一个全局 active pointer 切换到对方配置。
- ui=false 时，已加载的原生 UI/基础桥可继续工作；依赖自有 UI 的功能应显示其替代入口或缺口，不把失效按钮留在页面上。

## 3. 插件化 UI 与 DSH 功能

### 3.1 界面边界

允许通过插件改变 DSH 布局、导航、会话列表、composer、上下文 chips、工具/任务卡片、修改审阅入口和状态展示。可挂载插件自己拥有的 vscode-workbench 页面，并以公开路由/组件注册入口选择它；关闭 ui 后恢复原生入口。无需将新增界面塞进原生 DOM。

P0 必须核实公开 UI 挂载、卸载、布局/组件覆盖和服务访问入口。原生 composer 无法公开准确定位时，优先使用插件自己拥有的 composer；每个 composer 向 session bridge 注册 surfaceId、composerId、sessionId、selectionGeneration。没有可靠目标就拒绝插入，不猜 DOM/fiber。

遵守现有目标版平铺 client.* 模块装载约束。UI 插件不实现第二份 Agent 状态源、不自建按秒轮询、不再次包裹整页链接、不替换每次输入的 React 节点。搜索、草稿、IME、焦点和 caret 在组件自身持有；变更 key 必须有明确身份原因。

可关闭/可卸载是接口要求：dispose 释放监听、timer、订阅和 retain。界面切换先保存版本化草稿，再确认目标；出现冲突保留两份可恢复草稿。敏感草稿存本地，不写日志或仓库。

### 3.2 服务模块

| 模块 | 自有能力 ID（拟定） | 必需的上游核实 |
|---|---|---|
| attachments | ide.attachments.v1 | 原生 file receipt 的生产者/存储/授权/过期；图片 mediaType/data；不能把 URI 当 receipt |
| tasks | ide.tasks.v1 | session prompt/follow/cancel 关联、工具事件、状态持久化；不另造 Agent loop |
| edits | ide.edits.v1、ide.checkpoints.v1 | 插件注册工具/策略入口、可限制的工具集合、公开 checkpoint 语义 |
| context | ide.context.v1 | 工作区授权、文件/符号来源、规则、可选检索服务；无公开服务可由自有插件实现查询 |
| completion | ide.completion.v1、ide.nextEdit.v1 | FIM provider 调用、结构化编辑输出、取消；不能与旧 FIM 路由重复注册 |
| policies | ide.policy.v1 | 公开工具权限/拦截协议；read-only/staged/direct 的真实执行边界 |
| models / mcp / skills | 各独立 ide.*.v1 | 各服务的公开类型、生命周期和权限；包名存在不是兼容性证据 |
| browser UI | ide.ui.v1 | 公开组件/路由/服务注册；关闭后原生 UI 恢复 |

插件共享认证传输和事件源。已有 integration 模块迁移时先定唯一提供者和切换顺序，不能新旧插件同时注册同名 HTTP 路由/工具、同一 follow 或两套变更通知。

## 4. Profile recipe、配置所有权与目录

仓库将提供 profiles/vscode/recipe.json 和对应 schema；本次先交付 [设计示例](planning/full-ide/vscode-profile.recipe.example.json)。该 JSON 是扩展自己的规划格式，**不能直接交给 DSH 启动**。ProfileCompiler 将其转换成目标版本支持的 package.json / dsh.profile.bundles / Cordis overlay / --patch 参数。

逻辑 ID 默认 vscode；dsh.profile 自定义值继续作为逻辑名。目标解析为 <logical>-dsh020rc1-g<digest>；遵守现有 1–64 字符限制，长名截断加 hash。digest 来自规范化后的运行时精确身份、受管包实际内容哈希、recipe、依赖锁和影响加载的配置；完整 SHA-256 存 lock，短名碰撞必须核对完整值，不能覆盖。

目录为设计落点，P0 需用真实 loader 验证相对路径和加载约束：

~~~text
<dshHome>/
  profiles/<physicalProfile>/
    package.json                  # 编译的 DSH profile，依赖与 bundle 锁定
    cordis.patch.yml              # 已编译的兼容 user layer，不接收随意覆盖
    node_modules/...              # 当前 generation 自己的插件解析目录
  .integrations/vscode-sidebar/profile-store/
    locks/<home+logical>.lock     # 跨进程 prepare/commit 锁
    generations/<fullDigest>/
      recipe.resolved.json       # 仅非敏感的实际配置
      profile.lock.json          # 精确包/文件 hash、版本、协议、依赖图
      managed.overlay.yml        # --patch 指向此不可变路径
      manifest.json              # 所有权、状态、完整性
    leases/<windowId>.json        # generation/PID/启动身份/心跳，不含 token
    journals/<operationId>.json   # prepare/activate/commit/rollback 记录
~~~

本地窗口 active/previous 指针保存在该窗口对应的扩展状态域并与 lease 对应；不能仅凭扩展共享 globalState 的一个 active 字段判断所有窗口。使用规范化 home + logical profile 标识配置族。

### 4.1 四层配置

1. base：官方精确运行时所需 bundles，映射来自固定版本证据。
2. managed：本扩展锁定的 integration + IDE 插件、禁用重复 UI/HMR 的兼容 overlay。
3. user：用户允许字段、显式第三方插件列表与配置；第三方插件未认证时展示实际状态，不自动升级。
4. runtime secrets：仅进程私有环境/SecretStorage 解析，不能进入 recipe/lock/overlay/诊断。

优先级为基础 < 受管默认 < 允许的用户覆盖；不可覆盖项包括认证、所有权、协议版本和受管包内容。冲突返回可解释差异，不静默改写用户值。静态配置与进程 token 分开，不能因每次 token 不同就创建新 generation。

新安装专用 recipe 不自动继承终端 web 的全部插件。对旧 scaffold 的 donor 继承，迁移时保存一份可追溯快照，识别已有插件/patch 并报告兼容性；之后不持续跟随 donor。复杂 !!js patch 不能用正则转换，无法安全编译时报告冲突并保留原配置。

### 4.2 home 与数据范围

profile 隔离插件和配置；home 决定会话/凭据等数据范围。保留现有 dsh.home.mode 行为，不能在 minor 升级中自动移动用户会话或将 shared 改成 isolated。新引导明确展示数据位置，用户可选独立 home。逻辑 profile、generation、VS Code 窗口、workspace、session 都是不同身份。

同 home 多进程是否允许并发写数据必须通过目标 DSH 真实探针验证；配置锁不解决数据层并发。如果不安全，检测到冲突就阻止第二个写入实例并说明可选独立 home，不能默默共享一个未证明安全的数据库。保持一个窗口最多一个 owned child，不因此新增全局 daemon。

## 5. ProfileManager 的事务与资源管理

状态机：unresolved → planned → preparing → prepared → activating → verified → committed；错误进入 failed，可回到 previous。存在运行任务时 activating 前进入 draining。下文方法是本项目内部 ports，使用现有 OperationContext/PortError，JSDoc 实现，不要求 TypeScript 迁移。

~~~ts
type GenerationId = string; // 完整 SHA-256
interface ProfileSelection {
  logicalId: string; home: string; runtimeVersion: string;
  effectiveSettings: Readonly<Record<string, unknown>>;
}
interface ProfilePlan {
  planId: string; expectedPrevious: GenerationId | null;
  generationId: GenerationId; physicalProfile: string;
  changes: readonly { path: string; reason: string; ownership: 'managed' | 'user' }[];
  activation: 'none' | 'live-ui' | 'live-service' | 'restart-profile';
  conflicts: readonly { field: string; reason: string }[];
}
interface PreparedProfile {
  generationId: GenerationId; physicalProfile: string;
  overlayPath: string; lockDigest: string;
}
interface ProfileManager {
  plan(selection: ProfileSelection, op: OperationContext): Promise<ProfilePlan>;
  prepare(planId: string, op: OperationContext): Promise<PreparedProfile>;
  commit(input: { generationId: GenerationId; expectedPrevious: GenerationId | null;
    lease: RuntimeLease; capabilityDigest: string }, op: OperationContext): Promise<void>;
  reconcile(op: OperationContext): Promise<ProfileStatus>;
  collectUnused(op: OperationContext): Promise<{ removed: GenerationId[]; retained: GenerationId[] }>;
}
interface ProfileStatus {
  desired: GenerationId | null; active: GenerationId | null;
  previous: GenerationId | null; state: string;
  drift: readonly { path: string; reason: string }[];
}
~~~

- plan 是只读；conflicts 非空不 prepare。plan 绑定设置摘要和 expectedPrevious，过期返回 CONFLICT。
- prepare：获取跨进程锁，在同一文件系统 staging 生成；校验完整依赖和 hashes 后发布不可变目录。每个 generation 从完整 allowlist 构建，不做旧目录增量混拷。
- prepare 锁有 owner identity、随机 nonce、heartbeat；默认等待上限 30 秒。过期不等于 owner 已死，必须结合进程启动身份防 PID 重用；不能验证时返回 BACKPRESSURE，不抢锁破坏活跃写入。
- supervisor 先排空/停止旧 child，再以 PreparedProfile 启动候选；允许准备时旧实例继续运行，不允许用第二个验证 child 绕过每窗口单实例约束。
- 只有认证握手、runtime/插件版本、generation 和 required capabilities 全匹配才能 commit。commit compare-and-swap expectedPrevious；记录运行实例与窗口指针，不更新全机 active。
- 启动失败：停止失败候选、恢复 previous 并最多尝试一次旧配置启动；两者均失败则保持 failed，由显式重试恢复，不形成回滚重启环。
- 网络响应超时不代表 commit/apply 没发生；reconcile 查询 journal、lease 和真实进程再决定，不能无条件再执行。
- 文件在 Windows 被占用时等待/退避有上限；发布新目录，不强行替换被读取的 DLL/JS/manifest。
- 默认保留 active、previous、全部存活 lease 和最近两代未使用配置；垃圾回收只操作所有权标记匹配的 generation。closePolicy=never 的 child 仍是存活 lease，不能因窗口退出立即回收。
- 回退插件 generation 不等于回退 home 数据格式。升级 DSH 若会迁移数据，要有独立数据备份/恢复方案；不能简单把旧 binary 指回新数据库。

## 6. 新增传输与 capability 契约

既有 /api/vscode/v1 不破坏。新 IDE API 拟使用 /api/vscode/ide/v1/capabilities、/rpc、/events；CH1 原有版本号不借用。exact route/schema 在 P0 固定。所有实现复用认证、deadline、大小限制、Origin 校验和脱敏错误，不增加匿名浏览器后门。

~~~ts
interface IdeCapability {
  availability: 'available' | 'disabled' | 'unavailable' | 'unverified';
  reason: string | null; providerId: string; providerVersion: string;
}
interface IdeCapabilityReport {
  protocolVersion: 1; runtimeInstanceId: string;
  generationId: string; effectiveConfigRevision: string;
  features: Readonly<Record<string, IdeCapability>>;
}
interface RequestEnvelope {
  protocolVersion: 1; requestId: string;
  runtimeInstanceId: string; generationId: string;
  method: string; payload: unknown;
}
~~~

runtime availability 与 release certification 分开：后者在发行物兼容性清单中记录 tested/untested、环境和证据；生产机器不能因没跑测试就把一个可调用 capability 硬报故障，发行说明也不能因 available 就说已认证。

扩展只与匹配 instance/generation 的响应和事件交互。沿用 PortError；修改请求超时为 OUTCOME_UNKNOWN/effect:unknown，用户取消等待不等于撤销操作。现有 prompt requestId 不被本计划升级成可靠幂等键。

新自有写操作使用持久 operationId + 状态查询。重试前查 journal：不存在且有可靠未执行证据才重新提交；running/unknown 不重复执行。保留期覆盖事务存续，不按短 HTTP timeout 删除幂等记录。跨进程并发 claim 使用经过验证的锁/原子持久机制，不能只用内存 Map。

新 IDE 事件统一 {instanceId,generationId,eventId,revision,kind,payload}；一个连接复用任务/事务/配置事件，不给每张卡片开 SSE。重连先快照再增量；可恢复 cursor 只有公开/自有 journal 已保证时才启用。输入验证和 replay/gap/duplicate fixtures 两端共享。

## 7. 核心领域 ports

下述接口为可实施的最小边界；opaque handle 不能由 URI/路径自行拼出。P0 冻结时补齐 JSON schema、字段大小、默认值和共享测试样本。

### 7.1 上下文与附件

~~~ts
interface ContextItem {
  id: string; kind: 'file' | 'selection' | 'diagnostic' | 'symbol' | 'rule';
  uri: string; documentVersion: number | null; contentHash: string;
  source: 'editor-buffer' | 'disk' | 'search' | 'user';
  text: string; truncated: boolean;
}
interface ContextSnapshot {
  id: string; workspaceId: string; items: readonly ContextItem[];
  totalBytes: number; excluded: readonly { id: string; reason: string }[];
}
interface ContextPort {
  capture(selection: unknown, op: OperationContext): Promise<ContextSnapshot>;
  query(input: { workspaceId: string; query: string; limit: number },
    op: OperationContext): Promise<readonly ContextItem[]>;
}
interface AttachmentReceipt {
  id: string; sessionId: string; contentHash: string;
  mediaType: string; byteLength: number; expiresAt: string;
}
interface AttachmentPort {
  upload(input: { sessionId: string; name: string; mediaType: string;
    byteLength: number; contentHash: string }, bytes: AsyncIterable<Uint8Array>,
    op: OperationContext): Promise<AttachmentReceipt>;
  release(id: string, op: OperationContext): Promise<void>;
}
~~~

ContextBroker 在 host 捕获未保存内容与版本；插件只能取请求明确授权的快照/路径。显式用户选择与检索自动采集分开记来源；应用忽略规则、敏感排除、每文件/总量预算，超额显式展示。检索不静默读取工作区外资源。

receipt 绑定会话/实例权限，不能跨会话窃用。初始上传上限建议每文件 20MiB、图片 10MiB、每请求 40MiB，最终取 provider 上限和本地预算较小值；暂存未提交收据 30 分钟过期，已入会话的引用按 DSH 持久规则管理。真实 MIME 与申报一致；取消清理未完成上传。不能把 base64/原始正文打进日志。

### 7.2 任务与命令

~~~ts
interface TaskSnapshot {
  taskId: string; sessionId: string; workspaceId: string; revision: number;
  state: 'queued' | 'running' | 'waiting-user' | 'completed' | 'failed'
    | 'cancelled' | 'interrupted' | 'unknown';
  operationId: string; changeSetIds: readonly string[];
}
interface TaskPort {
  submit(input: { sessionId: string; prompt: string; contextSnapshotId: string;
    receiptIds: readonly string[]; mode: 'observed' | 'staged'; operationId: string },
    op: OperationContext): Promise<TaskSnapshot>;
  get(taskId: string, op: OperationContext): Promise<TaskSnapshot>;
  cancel(taskId: string, op: OperationContext): Promise<TaskSnapshot>;
}
~~~

任务是对同一 DSH 会话工作的投影/日志，不创建另一套 Agent loop。task.cancel 在目标只有 session.cancel 时只能取消该任务独占的活动 session turn；不能冒称能精确取消混合队列中的一项，映射不足返回 CAPABILITY_UNAVAILABLE 并说明范围。提交、prompt admission、执行完成分别记录。

终端操作关联 taskId/callId、cwd、命令参数、退出码、取消状态与截断输出；GUI terminal 的关闭不自动证明子进程已结束。权限沿用单一 DSH/host 授权来源；不把每次工具调用都强制转换成二次确认。

### 7.3 编辑事务

~~~ts
interface FileRevision {
  uri: string; documentVersion: number | null; contentHash: string | null;
  exists: boolean; encoding: string; eol: 'lf' | 'crlf' | 'mixed';
}
interface ProposedFileChange {
  fileId: string; operation: 'create' | 'modify' | 'delete' | 'rename';
  before: FileRevision; destinationUri: string | null;
  afterText: string | null; hunks: readonly { id: string; patch: string }[];
}
interface ChangeSet {
  id: string; taskId: string; sessionId: string; revision: number;
  mode: 'observed' | 'staged'; changes: readonly ProposedFileChange[];
  state: 'proposed' | 'reviewing' | 'applying' | 'applied' | 'partially-applied'
    | 'rejected' | 'conflict' | 'reverting' | 'reverted' | 'unknown';
}
interface ApplyResult {
  operationId: string; changeSetId: string; state: ChangeSet['state'];
  files: readonly { fileId: string; state: 'applied' | 'skipped' | 'conflict' | 'failed';
    afterHash: string | null; reason: string | null }[];
}
interface EditPort {
  propose(input: { taskId: string; operationId: string;
    changes: readonly ProposedFileChange[] }, op: OperationContext): Promise<ChangeSet>;
  get(changeSetId: string, op: OperationContext): Promise<ChangeSet>;
  apply(input: { changeSetId: string; expectedRevision: number;
    decisions: readonly { fileId: string; accept: 'all' | 'hunks' | 'none';
      hunkIds: readonly string[] }[]; operationId: string },
    op: OperationContext): Promise<ApplyResult>;
  revert(input: { changeSetId: string; operationId: string },
    op: OperationContext): Promise<ApplyResult>;
  operation(operationId: string, op: OperationContext): Promise<ApplyResult | null>;
}
~~~

插件持有提案/任务来源，Host 唯一执行 WorkspaceEdit。apply 前重读所有目标的 buffer version/hash、磁盘状态、根路径和新文件存在性；逐块选择生成新的完整候选文件并校验，不靠按字符串猜位置。首版 staged 仅文本；二进制编辑明确不支持，不生成假 diff。

新建/删除/重命名首版只接受 all/none；modify 可选 hunks。hunk ID 作用域为 fileId + changeset revision；重复、未知 ID 和空的 hunks 决策返回 INVALID_ARGUMENT。未列出的文件不修改，所有决定都记录在 operation journal 中。

未保存文档写回编辑器 buffer，不能绕过 VS Code 直接写盘覆盖。已经保存的目标按 VS Code 编辑/保存策略处理，不擅自保存全部用户文件。VS Code 没有提供跨多文件、磁盘和持久 journal 的全局事务保证：先校验、记录意图，再应用并逐文件确认。部分成功进入 partially-applied；崩溃后用实际 before/after hashes 查询恢复。

revert 仅当当前内容仍匹配记录的 after，或可证明无冲突合并时执行；否则展示冲突，不以整文件快照覆盖用户新改动。任务级 checkpoint 只恢复该任务写集；现有原生 undo、Git 原有 dirty 状态和模型会话 checkpoint 不能混为同一概念。

### 7.4 补全与下一处编辑

补全输入至少包含 document URI/version、cursor、prefix/suffix、contextSnapshotId、request sequence。响应绑定同一 version/sequence；用户继续输入、切文档、关闭功能立即取消并拒绝迟到响应。服务调用复用一个提供者，缓存按内容和模型配置指纹隔离。

FIM 只返回当前位置候选文本。下一处编辑返回带 before revision 的结构化提案，用户显式接受后进入 EditPort；不能把补全结果直接写到其他文件。延迟、质量与预算见 G15。

## 8. 模块落点、迁移与改约

| 文件/目录（新路径为拟定） | 职责 |
|---|---|
| profiles/vscode/{recipe,schema}.json | 随发行物的无密钥配置模板 |
| src/profile/{manager,compiler,registry,lock,leases,migration}.js | profile 与设置生命周期 |
| src/runtime/supervisor.js | 复用并增加 prepared profile 与 drain/switch 接线 |
| src/protocol/ide.js | IDE schema/错误/版本边界 |
| src/context/broker.js | 编辑器快照与上下文预算 |
| src/tasks/store.js | host 任务投影与恢复，不执行 Agent |
| src/edits/{coordinator,journal,review}.js | 唯一写入端、状态查询与 UI |
| src/inlineEdit/controller.js、src/inlineCompletion.js | 编辑器入口与补全 |
| runtime-integration/dsh-vscode-ide/lib/ | 新 DSH 功能模块与 client.* UI |
| runtime-integration/dsh-vscode-ide/contracts/ | 新 ide-v1 schema 和共享 fixtures |
| 现有 dsh-vscode-integration/lib/ | 保持旧桥；接线按唯一所有权迁移 |

新包要进入 VSIX 文件清单、profile lock 和集成同步测试，不能仅放源码目录。保留现有配置/命令和 exports 的兼容包装；新增 public methods 做版本协商，旧调用方不需要知道新 profile 路径。

接口改动流程：记录原因 → 更新本文/ADR → schema/fixture → 两端实现 → 兼容测试 → 真实能力映射。新增 API 名称在契约冻结前不可在 README 中宣传已经可用。

## 9. 必须防止的退化

- 设置每变一次就复制插件/重启；窗口焦点变化触发 profile 修复；模块开关互相写设置形成环。
- 不同扩展版本共用同一插件可变目录，live HMR 中断工具。
- profile 开关关闭仍因 ensureConnected/命令 wrapper 自动重启。
- 自有 UI 和原生 UI 各订阅、各发送同一个 prompt；切界面丢草稿/焦点。
- 附件发送到最后活跃而非当前目标；缺可靠 composer 身份时硬插。
- staged 工具只换名称，实际继续调用原生写入工具；Apply/Undo 超时自动重放。
- 插件不可用却报告 available；功能被禁用就从总计划完成率中删除。
- 垃圾回收删除其他窗口/借用实例使用的 generation；仅检查 PID 不检查启动身份。

完成门槛为总计划 G01–G28。尤其 G02/G27/G28 必须证明：**设置确实决定专用 profile 与插件行为，改 UI 可恢复，新增 DSH 能力不需要维护官方源码 fork。**
