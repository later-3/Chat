# Chat Workflow 运行设计：当前实现

> 文档类型：当前实现（as-built）
>
> 当前Workflow Definition：`planning-execution-workflow.v2`、`memory-import-workflow.v1`、`project-intake-workflow.v1`、`project-advancement-workflow.v1`
>
> 产品事实源：Product Store；Workflow返回值和Runtime状态不是产品终态。

## 1. 为什么有四套Workflow

当前有四个独立的用户结果，因此有四套耐久生命周期：

1. `PlanningExecutionWorkflow`：一条消息的Memory召回、规划、人工修订/批准、执行、验证和正式提交。
2. `MemoryImportWorkflow`：一次显式Memory外部写入或一次只读对账。
3. `ProjectIntakeWorkflow`：一次真实资源建项理解、候选审核和确认。
4. `ProjectAdvancementWorkflow`：现有Project的一次Stage/Milestone/负责人Update理解、候选修订和确认。

“规划必须在同一个Workflow中完成”指的是规划、修订循环和执行不能拆成多个竞争的规划Run；它不要求把所有独立业务塞进这一条Workflow。Memory导入拥有外部写入/对账生命周期；Project Intake与Advancement都以Project Candidate而不是Plan Approval为暂停对象，但分别承担“创建Project”和“推进既有Project”两个独立用户结果，因此各自拥有Definition与恢复生命周期。

## 2. 运行时组件

```text
API Product Command
→ Product事务（事实 + Receipt + Outbox）
→ API Outbox Dispatcher
→ Workflow Runtime私有HTTP
→ Vercel Workflow Local World / Checkpoint
→ Workflow Step
→ API私有Application Command / pi / Memory Adapter
→ Product Commit
```

| 组件 | 当前责任 |
|---|---|
| API进程 | 唯一Product Store Owner、公开Command/Query、Outbox Dispatcher |
| Workflow Runtime进程 | Local World、bundle、Hook、Runtime Binding、四套Workflow启动/恢复 |
| Runtime Binding Store | 私下关联Product Run/Outbox/Approval与Workflow Run/Hook Token |
| Workflow Store | Step结果、Hook等待、Checkpoint和重放 |
| pi Runtime | 真实百炼Planner/Executor调用及结构化候选 |
| Memory Registry | 根据服务端配置提供memmy/MemoryCore窄Adapter |
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
           → completeRunAttemptStep
        → persistExecutionCandidateStep
        → validateExecutionStep
        → commitExecutionResultStep
        → product_committed
```

### 4.2 Memory上下文

Memory节点位于Plan修订循环之前。同一Product Run最多准备一次不可变ContextPackage；Plan v2～v5复用同一版本和Hash，不重复查询外部Memory，也不让后续外部变化静默污染审核内容。

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

pi Executor完成只产生候选。Workflow必须：

1. 持久化完整Execution Candidate引用。
2. 运行确定性Validation。
3. Validation通过后调用Application Product Commit。
4. Product Store原子提交正式Assistant Message和Run终态。

候选已经生成但Product Commit失败时，只重试幂等提交，不重新调用付费Executor。

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
| Planner/Executor付费模型调用 | `maxRetries=0`；失败形成稳定错误，不自动再次扣费 |
| Project Understanding付费模型调用 | `FatalError`终止Step；Candidate记录failed，不自动再次扣费 |
| Memory外部写入 | `maxRetries=0`；发出后失联进入`outcome_unknown` |
| Product Commit | 使用稳定Command ID幂等重试，不重新生成候选 |
| Workflow Start/Resume | 先记录Binding意图，失联后对账，不盲目重复 |
| Hook等待 | 同一Workflow、同一Approval绑定；页面断开不取消等待 |
| Approval过期 | Application确认状态后收敛；已决定但未恢复时继续等同一Hook |

## 9. Trace与回放

Trace记录：命令入口、事务、Outbox、Workflow Start/Resume、Step、Provider/Memory Attempt、状态转换、耗时、错误和产品对象引用。

Trace不保存：用户消息、Plan正文、Decision正文、Prompt、Provider完整Payload、Memory正文、密钥和隐藏推理。

Replay Assembler按产品对象ID、revision和SHA-256组合：

1. Product Store正文与产品事实。
2. Trace系统时间线。
3. Workflow/Prompt/模型配置版本证据。
4. Runtime Binding的安全存在性证据。

缺少revision或Hash不一致必须显式报告，不能生成“看起来完整”的假回放。

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
| pi Planner/Executor | `packages/pi-runtime/src/planner.ts`、`executor.ts` |
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
