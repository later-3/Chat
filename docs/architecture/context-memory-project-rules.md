# 长期上下文架构：Memory、Project 与用户规则

> 文档类型：分阶段架构。Memory M1～M3已经实现；Project与Rules章节仍是后续目标，不能当成已交付能力。当前Memory运行节点见[Workflow运行设计](./runtime-workflows.md)，当前能力与缺口见根目录[PROJECT_STATE.md](../../PROJECT_STATE.md)。

> 状态：Memory M1～M3与调试收口已经合入；Project与Rules尚未实现
>
> 适用基线：当前`main`；精确提交以`origin/main`为准
> 目标：在现有“对话 → 规划 → 人工确认 → 执行 → Product Commit”闭环上，增加可追溯、可选择、可回放的长期上下文能力。

## 1. 要解决的用户问题

用户在 Chat 中推进长期工作时，需要同时做到：

1. 按本轮需要，从一个或多个真实 Memory 服务查询历史信息，并知道用了哪个服务、哪些结果和哪个版本。
2. 把用户明确选择的内容导入指定 Memory 服务；网络失败时不产生“看起来成功”的重复记忆。
3. 恢复项目的目标、当前阶段、工作状态、决定、阻塞、文档与下一步，而不是重新阅读全部聊天。
4. 管理带标签和适用范围的个人规则；用户可主动选择，系统也能按场景合理选择，并能解释最终用了哪些规则。
5. 规划节点只收到本轮经过选择的上下文；刷新、重启和历史回放后仍能重建当时的真实输入。

## 2. 事实所有权

| 信息 | 权威所有者 | Chat 保存什么 | 不允许什么 |
|---|---|---|---|
| 会话、消息、运行、审批 | Chat Product Store | 完整产品事实 | 由 Memory 或 Workflow 替代 |
| 外部 Memory 记录与索引 | 对应 Memory 服务 | 后端选择、查询/导入意图、来源、结果快照、采用证据 | 把外部记录直接冒充 Chat 产品事实 |
| 项目状态与文档清单 | Chat Product Store | Project、阶段、Work、文档角色、版本、Hash、推进决定 | 让 BMAD 文件目录成为唯一状态源 |
| 用户规则 | Chat Product Store | Rule、Revision、Tag、Scope、生命周期、采用证据 | 只存在于 Prompt 或一份不可追溯偏好文本 |
| Workflow Checkpoint | Vercel Workflow Store | 当前运行所需的有界 Step 输入/输出、Checkpoint、后端私有映射和产品引用 | 暴露给浏览器、保存无限历史对象图或当成产品终态 |
| Trace | Trace Journal | 路径、对象引用、版本、Hash、数量、耗时、错误码 | 复制会话、Memory、文档、规则或 Provider 正文 |

## 3. 参考输入与版本证据

### 3.1 Memory 项目

| 项目 | 固定证据 | 直接采用 | 按 Chat 调整 | 明确拒绝 |
|---|---|---|---|---|
| memmy-agent | `211d521b310fc23c63dd3d9ca848941173981c5e`，1.0.4 | 本地 HTTP 服务；`memory/search`、`memory/add`；`adapterId + requestId + requestHash` 幂等；标签与分层检索 | 只通过后端 Adapter 调用；查询结果转成 Chat 快照；namespace 只由服务端映射，M1 本地验收使用物理隔离数据库 | 浏览器直连、自动导出全部对话、把 injectedContext 不经验证直接塞进 Prompt、把固定本地实现宣称为多租户隔离 |
| TencentDB Agent Memory / MemoryCore | `3a9748d3c61c2a2feb38237c9b28992250c1804e`，MemoryCore 2.0.0-beta.1 | v3 强隔离；L0 conversation 与 L1 atomic 查询；Bearer + serviceId；BM25 无 embedding 可工作 | 查询优先用 L1 `atomic/search`；导入用 L0 `conversation/add`，结果标为“已接收/异步物化”；Chat 自己提供幂等与对账 | 把 `atomic/update` 当新建接口；它要求记录已存在且每次调用无条件增版 |
| MemOS | `027dc8975836c066a7d1dd80c78c3da5c0fa084e`，2.0.27 | 分层记忆、add/search 和云/本地部署思想 | 只作为第三 Adapter 候选；必须先有可运行服务或有效云配置再进入实现任务 | 在没有 Neo4j/Qdrant 或云 Key 时宣称“已真实接入” |

`memmy-agent` 本地工作树当前有用户未提交改动。本设计与后续合同测试只认上述 Git 提交中的公开合同；不得读取临时改动来悄悄扩大接口。

固定提交还有 6 个必须由 Chat 边界补足的事实：

1. HTTP 接受 namespace，但本地 `MemoryService` 的 `assert*InScope` 在该提交中为空实现，检索候选也没有按 namespace 过滤；因此 namespace 不是 M1 的隔离证据，真实 E2E 每次重建独立 SQLite 文件。
2. `contextBudget` 会参与 injected sections 组装，但外部 `tokenEstimate` 仍不可直接信任；Adapter、Application 与 Store 使用同一保守算法再次校验。
3. verbose 查询没有稳定的外部对象 revision；Chat 保存 `externalObjectIds`、可用的 `sourceUpdatedAt`、不可变正文快照和自己的 revision/Hash，不虚构外部版本。
4. `hitCount` 按去重后的 `sourceMemoryIds` 计算；`adoptedCount` 按真正进入 ContextPackage 的规范化 section/Snapshot 计算，因为一个 section 可以合成多个外部来源。外部来源集合、实际 sections 和 Product Store 的 result-set Hash 必须能相互重建，UI 的“使用 N 条”明确指采用快照数。
5. `memory/add`的顶层`source`会覆盖namespace来源，原生`sessionId`要求Memmy先存在对应Session；Chat导入只发送服务端映射的namespace、稳定`turnId`和L2事实字段，不伪造外部Session。
6. L2 add返回成功不等于Chat已经证明可查询；M2按真实external ID执行strict GET，再用同一namespace/tag执行Search，二者一致才提交`materialized`。成功响应丢失时只用原operationId与相同正文做原生幂等对账。

### 3.2 BMAD

固定证据为 `BMAD-METHOD` v4.44.3，提交 `4c4f6dc8534f95427e66e122ac5de47ac51b5f94`。采用与调整如下：

1. 采用“先规划、再执行”、阶段门、Story 状态、可独立执行的工作项、文档分片、QA Gate 和 Correct Course。
2. 把 BMAD 的 `Draft → Approved → InProgress → Review → Done` 转成可配置模板中的默认 Work 状态，不写死为所有项目唯一流程。
3. 把 `core-config.yaml` 的文档路径思想转成 Project Document Manifest；Product Store 保存角色、状态、版本与 Hash，文件内容仍按需要读取。
4. 把 sharding 转成按角色和预算选择上下文，不默认复制、切碎或加载全部文档。
5. 把 Correct Course 转成版本绑定的 `ProjectChangeProposal`，用户确认后才修改阶段、范围或关键文档。
6. 不采用文件即状态、单体 technical-preferences 自动全量注入，以及“Agent 说完成就完成”的语义。

主要源码入口为 `docs/user-guide.md`、`docs/core-architecture.md`、`bmad-core/core-config.yaml`、greenfield/brownfield workflow、`story-tmpl.yaml`、`create-next-story.md`、`validate-next-story.md` 与 `correct-course.md`；结论绑定该版本，不宣称未来 BMAD 版本仍保持相同合同。

### 3.3 经验规则飞轮

参考 OPC 飞轮与 `规则目录-v1.json`：规则从真实案例产生，经历候选、试用、验证、生效、弱化/禁用；按责任主体、场景和阶段选择，而不是加载全部规则。Chat 额外增加版本、标签、用户显式选择、冲突说明与 Prompt 采用证据。

## 4. 核心产品对象

### 4.1 共享上下文对象

`ContextPackage` 是一次规划实际使用的不可变清单，不是万能服务：

```text
ContextPackage
├── contextPackageId / revision / sha256
├── purpose: planning | execution | project_review
├── productRunId
├── budget: 字符与条目上限
├── items[]
│   ├── kind: message | memory_snapshot | project_document | project_state | rule
│   ├── objectRef: id + revision + sha256
│   ├── source: Chat 或外部 backendId/externalObjectId
│   ├── selection: explicit | scoped | retrieved | required
│   └── reasonCode
└── excluded[]: objectRef + reasonCode
```

它只保存已经选中的版本引用和必要正文快照。`ContextPackage` 的 Hash 进入规划 Input Manifest；历史回放由 Product Store 正文加 Trace 路径共同组装。每个 Plan Revision 固定引用一个不可变 ContextPackage；用户要求修改 Plan 时默认复用该包，只有用户显式刷新上下文或引用被策略判定为失效时才生成新包，避免外部 Memory 在同一轮修订中悄悄漂移。

Workflow 为保证 Worker 重启后不重复付费调用或丢失外部查询结果，会耐久保存当前节点经过 Schema 校验且受预算限制的输入/输出；这份运行中 Checkpoint 不是第二份产品事实，也不参与历史正文回放。生产部署必须为 Workflow Store 配置访问控制、静态加密和运行保留期，不能把它当成无限期会话归档。

### 4.2 Memory 对象

1. `MemoryBackendProfile`：浏览器可见的安全元数据，只含 backendId、显示名、类型、能力和健康状态；endpoint、Token、serviceId、tenant 映射只在服务端配置。
2. `MemoryQuery`：本次查询、后端选择、过滤条件、预算和生命周期。
3. `MemoryResultSnapshot`：外部命中的规范化、不可变快照；保存一个或多个 externalObjectId、可用的源更新时间、正文、Hash、分数、标签、时间和 backendId；外部没有版本时不伪造。
4. `MemoryAdoption`：哪些快照真正进入哪个 ContextPackage，以及采用/排除原因。
5. `MemoryImportIntent`：用户明确选择的正文引用、目标后端、标签、稳定 operationId、请求 Hash 和状态。
6. `MemoryImportResult`：`queued | dispatching | accepted | materialized | failed | outcome_unknown`；记录派发/对账次数、外部ID/版本和验证结果；未知结果不能伪造外部ID或自动换身份重写。

查询快照只在结果被规划采用时保留正文；未采用结果只保留数量、状态和诊断证据，避免 Product Store 无限制膨胀。

### 4.3 Project 对象

1. `Project`：目标、项目类型、当前阶段、方法模板版本和生命周期。
2. `ProjectMethodTemplate`：阶段、允许转换、必需/可选文档角色、推进门；内置 `bmad-software.v1`，项目可裁剪并固定模板版本。
3. `Work`：可执行工作项，默认状态 `draft/approved/in_progress/review/done/cancelled`，携带验收条件、依赖和负责人。
4. `ProjectDocument`：文档角色、URI/存储引用、revision、sha256、状态；角色包括 brief、prd、ux、architecture、story、qa、change-proposal，也允许自定义角色。
5. `ProjectDecision`：阶段推进、范围变化、文档接受等用户决定。
6. `ProjectChangeProposal`：Correct Course 候选；在用户确认前不修改权威项目状态。

项目模板是约束检查器，不是脚手架监狱。非软件项目可以选择轻量模板，只保留目标、阶段、工作、文档和决定这五类稳定概念。

### 4.4 Rule 对象

1. `Rule`：稳定身份、所有者、标题和当前有效 revision。
2. `RuleRevision`：规则正文、理由、正例/反例、适用范围、显式冲突规则、风险与 Hash。
3. `RuleTag`：用户可管理的标签；标签只是分类，不承担生命周期或授权。
4. `RuleScope`：场景、项目类型、项目阶段、Workflow 节点和可选 Project ID。
5. `RuleLifecycle`：`candidate → trial → active → weakened/disabled/rejected`，每次转换有来源与决定。
6. `RuleSelection`：显式选择、标签筛选、自动选择、排除和冲突结果；最终写入 ContextPackage。

选择顺序固定为：禁用/显式排除 → 用户显式选择 → 系统必需安全规则 → 作用域匹配的 active 规则 → 预算裁剪。声明冲突的规则不能同时进入包：显式选择冲突直接要求用户处理，自动选择冲突按稳定优先级排除并展示原因，不由模型静默决定。

## 5. Port 与 Adapter

### 5.1 MemoryBackendPort

公共 Port 只表达两个真实后端已共同证明的语义：

```ts
interface MemoryBackendPort {
  describe(): MemoryBackendCapabilities;
  health(): Promise<MemoryBackendHealth>;
  query(input: MemoryQueryInput): Promise<MemoryQueryOutput>;
}
```

约束：

1. 输入输出均为 strict Schema；Adapter 负责验证外部响应并转换稳定错误码。
2. 不提供 `Record<string, unknown>` 元数据口袋；后端差异通过能力判别联合表达。
3. Query Port只冻结真实memmy查询证明的最小语义；M2把`import/reconcile`实现为独立`MemoryImportBackendPort`，不塞进查询接口。查询可有限重试；导入发送后失联必须进入`outcome_unknown`，只用同一身份对账。
4. Registry 在 API/Workflow 服务端组合根构建。浏览器提交 backendId，无法提交 endpoint、Token、模型或 tenant。

`@chat/memory-runtime` 是 Chat 自有的内部 Adapter 包，只依赖 Workspace Port、合同、Domain 和仓库已有的 Zod，没有引入 Memory SDK。真实验收启动固定提交的 memmy HTTP 服务；该参考项目为 MIT License。退出时删除 Registry 中的 memmy 注册和该 Adapter 即可，Product Store 中已经冻结的 backendId、快照、revision 与 Hash 仍可回放，不要求继续运行 memmy，也不污染 Domain。

```ts
interface MemoryImportBackendPort {
  describeImport(): MemoryImportCapabilities;
  import(input: MemoryImportInput): Promise<MemoryImportAccepted>;
  reconcile(input: MemoryImportReconcileInput): Promise<MemoryImportReconcileOutput>;
}
```

`import`一旦跨过fetch边界，断连、超时、5xx或非法成功响应都按`write_outcome_unknown`处理；`reconcile`不是普通重试。有external ID时执行GET+Search验证，没有ID时memmy只能用相同adapterId、requestId和相同规范化正文触发原生幂等对账。

固定 memmy 提交首次执行 `npm ci` 时，npm 审计报告 8 项已知问题（1 low、1 moderate、5 high、1 critical）。M1 不修改第三方固定提交来伪造“已修复”：它只允许在本地测试/调试中以 loopback、物理隔离 SQLite、最小子进程环境运行，不进入 Chat 生产依赖、不上传服务器、也不作为服务器部署产物。后续升级必须先固定新的 commit/tree，复跑合同、真实 HTTP、供应链审计与退出兼容门，再决定是否扩大使用范围。

### 5.2 后端差异

| 能力 | memmy | Tencent MemoryCore |
|---|---|---|
| 查询 | `POST /api/v1/memory/search`，verbose 获取来源 | `POST /v3/atomic/search`，必要时 L0 search |
| 导入 | `POST /api/v1/memory/add`，稳定 requestId 原生幂等 | `POST /v3/conversation/add`，L0 接收后异步抽取 L1 |
| 对账 | 按稳定请求重放或读取返回 memory ID | 以 Chat 稳定 session/operation 映射查询 L0；不得用 `atomic/update` 重放 |
| 隔离 | namespace/profile/project，由服务端映射 | team/agent/user/session + serviceId，由服务端映射 |
| 完成语义 | 返回 memory ID；可能仍有索引处理 | `accepted` 不等于 L1 已物化，UI 必须区分 |

## 6. Workflow 拓扑

### 6.1 规划链

```text
Message Command
  → 单一 PlanningExecutionWorkflow
  → beginPlanningContextStep（冻结查询意图）
  → queryMemoryContextStep（仅用户选择/策略要求时）
  → persistPlanningContextResultStep（原子提交Query终态与ContextPackage）
  → compilePlanningInputStep
  → pi.plan
  → 用户修订/批准
  → pi.execute
  → Product Commit
```

Memory 查询是现有 Workflow 的一个可选节点，不另起竞争的规划 Workflow。项目状态、文档和规则在 `assembleContextRequestStep` 选择；外部查询在专门 Step 执行；最终由 API Application 用例原子提交 ContextPackage。

### 6.2 导入链

```text
Memory Import Command
  → 原子提交 MemoryImportIntent + Outbox
  → MemoryImportWorkflow
  → loadImportIntentStep
  → callMemoryImportStep（maxRetries=0）
  → commitImportResultStep
  → outcome_unknown 时 reconcileMemoryImportStep / 人工处置
```

导入使用独立耐久 Workflow，因为它有自己的用户结果和外部副作用生命周期；它不改变 `PlanningExecutionWorkflow` 的唯一性。

### 6.3 Project 推进链

模型只能产生 `ProjectChangeCandidate`。阶段推进、Work 完成、关键文档接受和 Correct Course 必须经过 Application 不变量与用户决定，再成为 `ProjectDecision`。简单的标题、标签等低风险修改可直接使用普通 Command，但仍需 expectedRevision。

## 7. API 与最小统一 UI

### 7.1 对话工作区

发送区新增一个统一的“上下文”入口：

1. Memory：选择后端、可选标签/层、开关“本轮查询”。
2. Project：选择当前项目，展示阶段与活动 Work。
3. Rules：主动勾选规则或按标签筛选；自动选择结果在规划面板可见。
4. 发送后显示本轮 Context 摘要：来源数量、规则数量、项目版本与 Memory 后端；不把内部凭据或 Workflow ID 暴露给浏览器。

### 7.2 管理页

在现有响应式 PWA 内增加一致的侧栏/抽屉页面：

1. Memory 后端：只展示配置状态、能力和健康，不编辑密钥。
2. Projects：项目、阶段、Work、文档清单与变更候选。
3. Rules：规则 CRUD、标签、Scope、生命周期、筛选与启停。

桌面与手机使用同一组件和信息架构；手机不得新增横向溢出或遮挡输入区。

## 8. 存储与迁移

1. Product Store 每次增加新事实集合都升级显式 Schema 版本：M1 提供 v1 → v2，M2 提供 v2 → v3，R1 计划提供 v3 → v4；迁移必须确定性、可测试并有字节级失败保护，不让 Zod 默认值悄悄改写历史。
2. 新集合仍使用 ID → Entity 映射；跨对象引用、revision、Hash 和状态机在启动时完整校验。
3. Memory 服务数据库、Token、本地配置、Trace、E2E 数据和构建产物都在 `.gitignore` 范围内。
4. 当前仍是单 API 写者 JSON Store，不宣称多实例；外部 Memory 调用不得发生在 Product Store `transact` 内。

## 9. Trace 与回放

新增事件只允许严格、事件级 Schema，例如：

1. `context.assembly.started/completed/failed`
2. `memory.query.started/completed/failed`
3. `memory.import.started/accepted/materialized/outcome_unknown/failed`
4. `project.transition.candidate/committed/rejected`
5. `rule.selection.completed/failed`

字段只含 productRunId、operationId、backendId、对象引用、数量、Hash、durationMs、outcome 和稳定 errorCode。正文从 Product Store 的版本对象读取，Trace 不保存正文副本。

Trace 是不阻断产品事务的可观察证据：写入故障或进程在产品提交后的窄窗口崩溃时，Replay 必须明确报告事件缺口，不能补造“完整”时间线。正常完成门要求无缺口；若未来需要监管级原子审计，应另建类型化 Trace Outbox，而不是把任意日志塞进产品事务。

## 10. 配置与密钥

1. Memory 后端配置是服务端文件或环境变量；配置对象引用环境变量名，不把密钥值写入 JSON Product Store。
2. API 与 Workflow 分别装配 Registry，因此冻结的后端描述和配置指纹必须包含 `authMode + credentialRevision`。启用 Bearer 时必须显式提供同一个非秘密凭据版本/keyId；禁止把 Token 本身或 Token Hash 用作漂移证据。两进程描述不一致时在外部查询前失败关闭。
3. 百炼仍固定真实 `qwen3.7-plus`。本地测试优先复用 `/Users/xulater/.pi/agent/read-chat-provider-key.mjs` 从 pi 配置读取到子进程环境；不打印、不写入 Git，也不再次要求用户手工提供已存在的 Key。
4. Memory 服务固定到独立调试端口；启动前使用现有安全 preclean 机制，只清理自己登记且身份匹配的进程，未知占用只报告不杀。
5. 弱服务器只接收本地构建产物；本阶段不在服务器编译，也不自动部署。

## 11. 失败语义

| 场景 | 产品结果 |
|---|---|
| Memory 查询超时 | 若用户标记 required，则先持久化Query失败再让Run失败关闭；optional 则提交排除包后继续 |
| 外部响应合同损坏 | `memory.backend.contract_invalid`，不采用任何命中 |
| 导入发送前失败 | `failed`，允许用户重试同一 Intent |
| 导入发送后失联 | `outcome_unknown`，只对账，不自动重复写 |
| Project 版本冲突 | 409，保留候选，不覆盖新状态 |
| 规则被禁用但客户端仍选择 | 409/422，要求刷新，不静默使用旧 revision |
| Context 超预算 | 按固定优先级裁剪，并保存 excluded + reason；不让模型临时决定 |
| Provider 失败 | 沿用 B2 失败关闭；不能退回假模型或无上下文规划 |

## 12. 明确不做

1. 不同步全部对话到 Memory；不做后台无授权自动记忆。
2. 不把 MemOS、memmy 或 TencentDB 内部对象全部复制成 Chat Schema。
3. 不把所有 Project 强制成软件研发目录；不要求每个项目都有 PRD、UX 和 Architecture。
4. 不让规则自动变成 active；Chat 提议只产生 candidate。
5. 不在每次单元测试调用付费模型；真实 Provider 只在纵向里程碑与组合 E2E 运行。
6. 不顺带实现完整 SSE Cursor、多租户认证、服务器部署或第三方副作用工具。
