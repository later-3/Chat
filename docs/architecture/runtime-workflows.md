# Chat Workflow 运行设计：当前实现

> 文档类型：当前实现（as-built）
>
> 当前Workflow Definition：`planning-execution-workflow.v3`、`memory-import-workflow.v1`、`project-intake-workflow.v1`、`project-advancement-workflow.v1`
>
> 产品事实源：Product Store；Workflow返回值和Runtime状态不是产品终态。
>
> 当前默认产品Profile选择独立的“规划执行工作流”，其Definition只含“规划—审核—执行—验证—提交”，
> 不包含Memory节点。带Memory/Project/Rules的完整上下文Planning Workflow、Memory代码、合同和历史Workflow继续保留；统一启动器不启动Memory服务，API/Workflow组合根也不装配Memory Adapter。

## 1. 为什么有多套Workflow

当前有多个独立用户结果和两种Planning配置，因此分别冻结耐久生命周期与Definition：

1. 默认“规划执行工作流”：一条消息的规划、人工修订/批准、执行、验证和正式提交；冻结Definition不含Memory。
2. 完整上下文Planning Workflow：显式选择时可编排Memory、Project、Rules等可选上下文节点；当前默认Profile不选择它。
3. `MemoryImportWorkflow`：一次显式Memory外部写入或一次只读对账。
4. `ProjectIntakeWorkflow`：一次真实资源建项理解、候选审核和确认。
5. `ProjectAdvancementWorkflow`：现有Project的一次Stage/Milestone/负责人Update理解、候选修订和确认。

“规划必须在同一个Workflow中完成”指的是规划、修订循环和执行不能拆成多个竞争的规划Run；它不要求把所有独立业务塞进这一条Workflow。Memory导入拥有外部写入/对账生命周期；Project Intake与Advancement都以Project Candidate而不是Plan Approval为暂停对象，但分别承担“创建Project”和“推进既有Project”两个独立用户结果，因此各自拥有Definition与恢复生命周期。

## 2. 运行时组件

```text
API Product Command
→ Product事务（事实 + Receipt + Outbox）
→ API Outbox Dispatcher
→ Workflow Runtime私有HTTP
→ Vercel Workflow Local World / Checkpoint
→ Workflow Step
→ API私有Application Command / Pi Executor Service / Memory Adapter
→ Product Commit
```

| 组件 | 当前责任 |
|---|---|
| API进程 | 唯一Product Store Owner、公开Command/Query、Outbox Dispatcher |
| Workflow Runtime进程 | Local World、bundle、Hook、Runtime Binding、四套Workflow启动/恢复 |
| Runtime Binding Store | 私下关联Product Run/Outbox/Approval与Workflow Run/Hook Token |
| Workflow Store | Step结果、Hook等待、Checkpoint和重放 |
| pi Runtime | Planner与Pi Adapter；Executor通过私有Client访问独立AgentSession服务 |
| Pi Executor Service | Operation幂等、AgentSession、Workspace工具、Session与安全Journal |
| Memory Registry | 当前固定为空且不实例化Adapter；恢复memmy/MemoryCore必须重新修改组合根并经过评审 |
| Trace/Replay | 记录系统路径并组合Product事实、版本证据进行回放 |

Workflow进程不得打开Product JSON文件；所有产品读写都通过API私有Application Command完成。

## 3. Outbox分发边界

当前Outbox有八种事件：

| kind | 产生位置 | 分发结果 |
|---|---|---|
| `workflow_start` | Message Command事务 | 启动唯一Planning Workflow |
| `workflow_resume` | Decision Command事务 | 恢复对应Approval的Hook |
| `memory_import_start` | Memory Import Command事务 | 启动一次外部导入Workflow |
| `memory_import_reconcile` | Reconcile Command事务 | 启动一次只读对账Workflow |
| `project_intake_start` | Project Intake Command事务 | 启动一次建项Workflow |
| `project_intake_resume` | Candidate Decision事务 | 恢复对应Project Candidate Hook |
| `project_advancement_start` | Project Advancement Command事务 | 启动一次现有Project推进Workflow |
| `project_advancement_resume` | Advancement Decision事务 | 恢复对应推进Candidate Hook |

分发流程遵守“先写意图栅栏，再跨Runtime边界”：

1. Product事务先提交Outbox。
2. Dispatcher把条目CAS为分发中。
3. Runtime先在Binding Store声明稳定意图，再调用Workflow SDK。
4. 只有可验证响应才标记已确认。
5. 请求发出后失联进入`outcome_unknown`并查询Binding/Run对账，不能重新猜测性启动。

## 4. PlanningExecutionWorkflow

### 4.1 总体节点

```text
beginPlanningContextStep
├─ no_query / already_prepared ───────────────────┐
└─ dispatch_required                              │
   → queryMemoryContextStep                       │
   → persistPlanningContextResultStep             │
                                                  ↓
for planRevision 1..5:
  compilePlanningInputStep
  → runPiPlannerStep
  → publishPlanReviewStep
  → claimDecisionHookStep
  → wait Hook or Approval expiry
  → loadCommittedDecisionStep
     ├─ request_revision → 下一轮规划
     ├─ reject → commitRejectedRunStep → cancelled
     └─ approve
        → compileExecutionContractStep
        → 对每个Plan Step：
           beginExecutionAttemptStep
           → runPiExecutorStep
              → start/reconcile Pi Operation
              → AgentSession多轮Provider/Tool loop
           → completeRunAttemptStep
        → persistExecutionCandidateStep
        → validateExecutionStep
        → commitExecutionResultStep
        → product_committed
```

### 4.2 Memory上下文

以下是完整上下文Planning Workflow的保留能力边界，不是当前默认产品路径。当前默认“规划执行工作流”的Definition没有Memory节点；因此不会产生Memory NodeRun、Vercel Step或前端轨迹。完整上下文Workflow只有被显式选择时才会解释其Memory节点，而当前Profile仍没有Memory Registry或服务。
若未来重新启用，必须重新经过产品授权并修改组合根、Profile、合同与真实验证。

保留实现中，Memory节点位于Plan修订循环之前。同一Product Run最多准备一次不可变ContextPackage；Plan v2～v5复用同一版本和Hash，不重复查询外部Memory，也不让后续外部变化静默污染审核内容。

- `required`查询失败：先保存失败结果，再让Run失败关闭。
- `optional`查询失败：保存排除原因，规划可继续。
- 没有选择Memory：不调用外部服务，仍形成可解释的上下文结果。

### 4.3 规划和修订

每一轮先由Application编译输入Manifest，再调用真实pi Planner。模型输出只有通过Schema和领域校验并由Application提交后，才成为可Query的Plan Revision与Approval。

最多5个Plan Revision；到达上限后不再发生第6次付费模型调用，Run进入明确失败。

### 4.4 Hook与人工决定

```text
Workflow先耐久注册Hook
→ Runtime保存Approval到Hook Token的私有Binding
→ 用户提交Decision Command
→ Application校验并提交Decision + Resume Outbox
→ Dispatcher调用Runtime resume
→ Runtime按Approval定位Hook并恢复
→ Workflow再次读取已经提交的Decision
```

Hook Payload只携带产品Decision引用；Workflow不能信任浏览器原始决定。过期时先由Application判断Approval是否真的过期；若Decision已经提交但Resume仍在路上，Workflow继续等待同一个Hook。

### 4.5 执行与Product Commit

批准后编译不可变Execution Contract。执行按Plan依赖顺序逐步进行，每步有独立Attempt、输入Manifest Hash、依赖结果引用和候选Hash。

Pi Coding Executor完成只产生候选。Approved Step的Capability决定可见工具；非文本能力绑定唯一活动Project Workspace。Workflow必须：

1. 持久化完整Execution Candidate引用。
2. 运行确定性Validation。
3. Validation通过后调用Application Product Commit。
4. Product Store原子提交正式Assistant Message和Run终态。

候选已经生成但Product Commit失败时，只重试幂等提交，不重新调用付费Executor。

Executor Operation使用稳定`pio_*`身份和请求Hash。Workflow断线后按事件cursor与终态Snapshot查询同一Operation，不重新创建AgentSession。Tool调用前已耐久保存意图；进程重启发现未闭合Tool时收敛为`outcome_unknown`。完整事件与正文隔离规则见[Pi Coding Executor Service As-built](./pi-coding-executor-service.md)。

Operation Start在进入Journal前还有独立授权门：Executor用`executionAttemptId + Contract ID/Hash + Step + Manifest`向Application回查Product Store，只使用API返回的权威Contract、Context和依赖引用。Runtime Key只是进程身份，不能单独授予文件或Shell能力。

## 5. MemoryImportWorkflow

### 5.1 普通导入

```text
loadMemoryImportStep
→ markMemoryImportDispatchingStep
→ callMemoryImportStep（唯一外部写入，maxRetries=0）
   ├─ failed → commitFailed
   ├─ outcome_unknown → commitUnknown → 只读reconcile
   └─ accepted → commitAccepted → 只读reconcile
→ materialized / accepted / failed / outcome_unknown
```

`dispatching`是外部写入前的耐久栅栏。跨过fetch边界后的断连、超时、5xx或非法成功响应都可能意味着外部已经写入，因此不能回到`callMemoryImportStep`盲目重试。

### 5.2 只读对账

`mode=reconcile`只允许从`dispatching/accepted/outcome_unknown`进入，只调用Adapter的读取/搜索能力，不再次执行外部写入。

- memmy：按已知external ID读取并搜索，或使用完全相同operationId/request Hash验证原生幂等结果。
- Tencent MemoryCore：用稳定映射读取L0并检查L1；L0存在可以收敛为`accepted`，L1可查后才是`materialized`。

`accepted`是合法非失败终态。Dispatcher监督器和页面都不得把它自动降级成未知结果，也不得为了追求`materialized`重复写入。

## 6. ProjectIntakeWorkflow

```text
Project Intake Command
→ Product事务提交Message + queued Candidate + Start Outbox
→ prepareProjectCandidateStep
   → API私有Command调用模型无关ProjectIntakeUnderstandingPort
   → 允许根内并行观察Git、治理文档与脚本清单
   → Application编译并提交under_review Candidate
→ 建立Candidate Hook并等待
→ 用户通过公开Command修订、确认或拒绝
→ Product事务先提交Project事实/拒绝事实 + Resume Outbox
→ Runtime恢复同一Hook
→ Workflow返回product_decided
```

Project Understanding当前由pi Adapter执行，部署时使用服务端Model Profile选择Provider、模型、endpoint和凭据环境变量；这些配置不进入Domain、公开API或浏览器。真实验收Profile为百炼`qwen3.7-plus`，替换模型不改变Candidate合同。

模型调用和真实Resource Observe位于产品事务外；任一边界失败都会把Candidate提交为`failed`。Workflow Step使用`FatalError`禁止默认重试，避免一次建项故障触发多次付费调用。用户修复配置后显式发起新的建项意图。

待办、决定和贡献的“管理项目”消息不会启动新Workflow：用户已经显式选择命令类型，Application可确定性编译一个绑定Project revision/Hash的可编辑Candidate，不需要用模型重述正文。刷新Observation只提交客观只读观察，也不制造无价值审批层。

### 6.1 ProjectAdvancementWorkflow

```text
Project Advancement Command
→ Product事务提交Message + 版本绑定queued Candidate + Start Outbox
→ prepareProjectAdvancementCandidateStep
   → API私有Command读取当前Project/Stage/Method最小清单
   → pi Adapter调用当前服务端Model Profile
   → Application编译并提交under_review Candidate
→ 建立Candidate Hook并等待
→ 用户直接修改Candidate，或确认/拒绝
→ Product事务先提交Decision与Stage/Milestone/Update事实 + Resume Outbox
→ Runtime恢复同一Hook
→ Workflow返回product_decided
```

Workflow不拥有Stage状态机。Application/Domain校验Principal、Candidate CAS/Hash、Project/Stage/Method绑定和Update作者；确认分支在同一JSON Store事务中写入所有产品事实。模型调用位于事务外，`FatalError`禁止同一Candidate revision自动再次付费；免费恢复测试真实重启API与Workflow后证明调用计数仍为1。

## 7. Runtime Binding与版本证据

Runtime Binding保存以下私有关系：

- Product Run/Start Outbox → Workflow Run。
- Approval Request → Hook Token和Resume状态。
- Memory Import Outbox → Memory Import Workflow Run。
- Project Candidate/Outbox → Project Intake或Advancement Workflow Run和Hook恢复状态。

约束：

1. Runtime数据存在但Binding文件缺失时拒绝创建空映射。
2. Binding存在但对应Workflow Run不存在时启动失败关闭。
3. 活动Planning Run恢复前核对Workflow Definition、bundle和版本证据。
4. 活动Memory Import Run核对其独立Definition Version。
5. 活动Project Intake/Advancement Run核对各自Definition Version、Candidate身份和Start/Resume状态。
6. Runtime ID只用于后端诊断，不进入浏览器、公开API和Product Store身份模型。

本地开发每次重建Bundle后会在服务启动前检查活动Planning Run。证据完全一致时继续恢复；若代码版本已经变化且旧Bundle不再可执行，则保留全部历史证据，通过Application把Product Run、Attempt和Workflow Outbox收敛为`workflow.version_incompatible`，并用Workflow SDK取消旧Runtime Run。该路径不删除Store或Runtime文件，也不重启同一产品工作；生产环境应保留旧部署完成原版本恢复。

## 8. 重试与结果未知

| 边界 | 当前策略 |
|---|---|
| 纯确定性Step | 可由Workflow按耐久语义重放 |
| Planner/Executor付费模型调用 | `maxRetries=0`；Executor通过同一Operation查询，不猜测性重启AgentSession |
| Project Understanding付费模型调用 | `FatalError`终止Step；Candidate记录failed，不自动再次扣费 |
| Memory外部写入 | `maxRetries=0`；发出后失联进入`outcome_unknown` |
| Product Commit | 使用稳定Command ID幂等重试，不重新生成候选 |
| Workflow Start/Resume | 先记录Binding意图，失联后对账，不盲目重复 |
| Hook等待 | 同一Workflow、同一Approval绑定；页面断开不取消等待 |
| Approval过期 | Application确认状态后收敛；已决定但未恢复时继续等同一Hook |

## 9. Trace与回放

Trace记录：命令入口、事务、Outbox、Workflow Start/Resume、Step、Pi Operation/Session/Turn/Message Hash/Tool/Compaction、Provider/Memory Attempt、状态转换、耗时、错误和产品对象引用。

Trace不保存：用户消息、Plan正文、Decision正文、Prompt、Provider完整Payload、Memory正文、密钥和隐藏推理。Pi Executor例外保存已经脱敏且有长度上限的Assistant可见文本、Tool输入/结果，用于复核实际命令、模型可见路径和执行输出；它们不是产品事实。

Replay Assembler按产品对象ID、revision和SHA-256组合：

1. Product Store正文与产品事实。
2. Trace系统时间线。
3. Workflow/Prompt/模型配置版本证据。
4. Runtime Binding的安全存在性证据。

缺少revision或Hash不一致必须显式报告，不能生成“看起来完整”的假回放。

### 9.1 DSH执行轨迹投影

`GET /api/runs/:productRunId/workflow-execution-trace`是DSH完整Workflow树使用的公开只读投影；
`GET /api/runs/:productRunId/execution-trace`继续提供实时Pi工具cursor页。Application在Principal校验后组合：

1. Product Store中的实际`WorkflowNodeRun`及其Manifest已引用的现有输入/输出事实；`skipped`节点和静态
   Definition节点不进入执行轨迹。Application按引用解析真实User Message、Plan/Approval/Decision、
   Execution Contract/Candidate、Validation与正式Message，未知引用只显示不可变引用，不猜测正文。
2. Vercel Workflow World的Run/Step/Hook/Sleep事件；Runtime私有路由先把Workflow Run ID、
   correlation ID、Hook Token、原始I/O和错误正文删除。
3. 严格JSONL Trace中的Pi Agent、模型调用、Token Usage与工具生命周期。

动态Execution Step由既有Execution Contract、Execution Attempt和Execution Candidate组合；Pi Attempt用
已有Attempt ID显式绑定所属Workflow NodeRun与Step。该投影没有增加Product Store字段、Provider Prompt快照或
新的执行日志，因此只能展示当前已经保存的事实；详情中的Planner输入证据会明确标注“不是Provider原始Payload”。

Bridge把真实触发消息的`DSH user/message ID → Product Run`绑定保存在私有原子状态中；Client通过
同源Query恢复各Run的公开轨迹。State-only Definition在原生`user/message`处保存绑定，可见Definition
在其后的`request/header`处严格向前读取绑定，并使用该事件已解析的Step Location投影到
`trajectory` target。Bridge不向DSH Session追加自定义事件，也不伪装成原生工具或Assistant事件。
最终形成`Workflow → Workflow NodeRun → Pi Agent → 模型/工具`
这一条实际执行主线。Vercel Runtime投影继续作为后端脱敏运行时证据保留，但不在DSH Trajectory
中与Workflow节点混排；后续证据或诊断表面可以独立消费。Planner/Executor的终态行摘要包含模型/工具次数、模型
Token Usage与耗时；每一层的安全详情包含开始/完成时间，Human Review包含已提交决定。
固定DSH rc.6的窄派生扩展保留独立Tool contribution的Conversation Location，因此终态树不会再回到
Turn序言；可选`callLabels`把标签显示为`WORKFLOW/NODE/STEP/AGENT/MODEL/TOOL`，可选`callPreviews`
让列表只显示稳定摘要，同时保留原始调用参数和完整结果供原生检查器查看；底层仍保持原生Tool/Subtool行为。
Bridge同时在自己的Tool名称中投影Unicode树线以保留可见父子深度，不查询或改写DOM。
浏览器本地“时间”偏好通过公开Session
utility Slot控制；开启时只重投影同一Trace的本地时间范围，不写Session事件或产品事实。
Plan/HITL Composer Dock只承载当前可操作审核或结果未知重试，决定确认后退出，历史由Human Review
NodeRun继续留在Trajectory。浏览器缓存和Bridge绑定都可由Chat Query恢复，不拥有任何运行终态。

## 10. 关键源码地图

| 关注点 | 文件 |
|---|---|
| Planning主编排 | `packages/workflows/src/planning-execution-workflow.ts` |
| Planning/Memory Step | `workflow-planning-steps.ts` |
| Hook与Decision Step | `workflow-decision-steps.ts` |
| 执行Step | `workflow-execution-steps.ts` |
| 验证和Product Commit Step | `workflow-result-steps.ts` |
| Memory Import主编排 | `memory-import-workflow.ts` |
| Memory Import Step | `memory-import-workflow-steps.ts` |
| Project Intake主编排/Step | `project-intake-workflow.ts`、`project-intake-workflow-steps.ts` |
| Project Advancement主编排/Step | `project-advancement-workflow.ts`、`project-advancement-workflow-steps.ts` |
| Runtime HTTP与Local World | `runtime-server.ts`、`workflow-world.ts` |
| Runtime Binding | `runtime-bindings.ts` |
| Workflow→API私有客户端 | `api-client.ts` |
| API私有Application Router | `apps/api/src/internal-runtime-router.ts` |
| Outbox分发与监督 | `apps/api/src/outbox-dispatcher.ts` |
| pi Planner / Executor Client | `packages/pi-runtime/src/planner.ts`、`executor-service-client.ts` |
| Pi AgentSession与Operation Journal | `coding-agent-executor.ts`、`executor-operation-store.ts`、`executor-service.ts` |
| Pi Executor进程入口 | `apps/pi-executor/src/index.ts` |
| Project Understanding/Model Profile | `packages/pi-runtime/src/project-intake-understanding.ts`、`project-advancement-understanding.ts`、`project-model-profile.ts` |
| Memory Adapter | `packages/memory-runtime/src/*-adapter.ts` |
| Project Resource Adapter | `packages/project-runtime/src/registry.ts` |

## 11. 当前边界与后续演进

已经实现：

1. 同一Planning Workflow内的规划、反复修订、批准/拒绝、执行与正式提交。
2. memmy和Tencent MemoryCore可选规划召回。
3. 独立Memory导入/对账Workflow及结果未知语义。
4. 真实百炼`qwen3.7-plus`、真实Memory服务和真实浏览器E2E。
5. 固定端口F5调试、严格Trace和多源Replay。
6. 独立Project Intake耐久链、真实Git/文档/脚本观察、候选确认与Project账本。
7. 独立Project Advancement耐久链、Stage/Milestone/负责人Update审核、State Transition与Timeline。

尚未实现：

1. Chat公开SSE Cursor Runtime Journal。
2. Project Context进入Planning Workflow的节点；PS1已实现Project、初始Stage、Work/Action和资源观察，但尚未注入任务规划。
3. 用户规则选择与规划注入节点。
4. 生产多实例Store、正式身份、Worker生产接管和后端部署拓扑。
5. 外部副作用Tool与通用Workflow编辑器。

未来新增节点前，应先确认它属于现有Workflow的一个步骤，还是拥有独立用户结果和独立恢复生命周期；不能为了“统一”把所有业务塞进一个永久Workflow。

## 12. 验证入口

```bash
pnpm test
pnpm --filter @chat/workflows test
pnpm --filter @chat/testing test
pnpm test:provider:bailian
pnpm test:e2e:planning-execution:real
pnpm test:memory:memmy-response-drop
pnpm test:e2e:memory-import:real
pnpm test:e2e:memorycore:real
pnpm test:e2e:project-intake:real
```

普通质量门与真实付费/外部服务门必须分开运行；没有真实凭据时不得用fixture冒充真实完成证据。
