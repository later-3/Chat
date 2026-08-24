# Chat Workflow 运行设计：当前实现

> 文档类型：当前实现（as-built）
>
> 当前公开系统Definition包括“规划执行工作流”“Memory 增强规划与执行”“执行 Agent（逐次提示词审核）”“Memory 增强执行 Agent”“Memory Agent 增强执行”“只查询 Memory 后回答”与“只整理为 Memory 候选”。后三者分别冻结为`direct@3/4/5`并复用`memory-agent-direct.v1`的完整、只读和只整理路径，不替换`direct@1`或`direct@2`。旧“默认规划工作流”和“默认笔记工作流”不再进入产品选择器；对应Runner与稳定证据为历史恢复及兼容调用保留。其他内部耐久流程包括`memory-write-workflow.v1`、历史兼容`memory-import-workflow.v1`、`project-intake-workflow.v1`、`project-advancement-workflow.v1`。
>
> 产品事实源：Product Store；Workflow返回值和Runtime状态不是产品终态。
>
> 当前默认产品Profile选择独立的“规划执行工作流”，其Definition只含“规划—审核—执行—验证—提交”，不包含Memory节点。另有用户显式选择的“Memory 增强规划与执行”、单节点Direct Agent、三节点Memory Direct、完整/只读/只整理三种Memory Agent组合和历史完整上下文Planning；各自身份、RunSpec和轨迹完全隔离。普通`pnpm dev`的Provider运行基础默认`off`：不准备工件、不检查端口、不启动Sidecar，API/Workflow Registry为空；只有显式`memorycore / memmy / compare`才启动固定Sidecar并在API/Workflow装配相同Registry。DSH Memory管理页和同源窄代理不改变该开关，也不会在`off`模式启动或绕过Provider；运行模式不会把Memory节点隐式塞进其他Definition。

## 1. 为什么有多套Workflow

当前有多个独立用户结果和互不包裹的Definition，因此分别冻结耐久生命周期与Runner：

1. 默认“规划执行工作流”：一条消息的规划、人工修订/批准、执行、验证和正式提交；冻结Definition不含Memory。
2. “Memory 增强规划与执行”：用户显式选择后，在同一个父Workflow中执行`memory.query → memory.write →`完整Planning链。
3. 历史完整上下文Planning：已从公开目录移除；底层仅保留兼容和既有冻结RunSpec恢复能力。
4. “执行 Agent（逐次提示词审核）”：`direct@1 / direct-agent.v1`，只有一个`agent.direct`业务节点。
5. “Memory 增强执行 Agent”：`direct@2 / memory-direct.v1`，固定执行`memory.query → agent.direct → memory.write`，不修改或包裹第4项。
6. “Memory Agent 增强执行”：`direct@3 / memory-agent-direct.v1`，固定执行`agent.memory_retrieve → agent.direct → agent.memory_write`。检索Agent只从Provider原始结果中选择引用；写入Agent只产出待用户审核的候选，绝不直接外写。
7. “只查询 Memory 后回答”：`direct@4 / memory-agent-direct.v1`，固定执行`agent.memory_retrieve → agent.direct`；没有写入节点，不产生Memory写入候选。
8. “只整理为 Memory 候选”：`direct@5 / memory-agent-direct.v1`，固定执行`agent.direct → agent.memory_write`；没有检索节点，只有用户批准候选后才外写。
9. `MemoryWriteWorkflow`：直接Memory Write Command或已批准Memory Agent候选产生的一次外部写入或一次只读对账；Memory Planning、Memory Direct和Memory Agent Direct只复用其Application状态机，不启动竞争的Workflow。
10. 历史`MemoryImportWorkflow`：只保留旧事实兼容。
11. `ProjectIntakeWorkflow`：一次真实资源建项理解、候选审核和确认。
12. `ProjectAdvancementWorkflow`：现有Project的一次Stage/Milestone/负责人Update理解、候选修订和确认。

旧`NoteCaptureWorkflow`不再由产品选择器提供；实现与绑定解析暂留，避免已有等待审核、兼容调用或恢复中的Run失去证据链。

“规划必须在同一个Workflow中完成”指的是选择Memory流程后，查询、写入、规划、修订循环和执行都由同一个父Workflow顺序驱动，不能拆成多个竞争的规划Run。Memory Write仍拥有独立的产品意图、结果未知与对账状态机；只有直接Write Command才通过Outbox启动独立`MemoryWriteWorkflow`。

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
| Workflow Runtime进程 | Local World、bundle、Hook、Runtime Binding、各固定Workflow启动/恢复 |
| Runtime Binding Store | 私下关联Product Run/Outbox/Approval与Workflow Run/Hook Token |
| Workflow Store | Step结果、Hook等待、Checkpoint和重放 |
| pi Runtime | Planner与Pi Adapter；Executor通过私有Client访问独立AgentSession服务 |
| Pi Executor Service | Operation幂等、AgentSession、Workspace工具、Session与安全Journal |
| Workflow Memory Registry | 由唯一`CHAT_MEMORY_MODE`冻结：`off`为空；`memorycore / memmy / compare`分别装配同一Query/Write/Reconcile Port下的Tencent、memmy或两者；API与Workflow描述Hash必须一致 |
| Trace/Replay | 记录系统路径并组合Product事实、版本证据进行回放 |

Workflow进程不得打开Product JSON文件；所有产品读写都通过API私有Application Command完成。

## 3. Outbox分发边界

Memory纵向新增两种Outbox事件：

| kind | 产生位置 | 分发结果 |
|---|---|---|
| `workflow_start` | Message Command事务 | 启动唯一Planning Workflow |
| `workflow_resume` | Decision Command事务 | 恢复对应Approval的Hook |
| `memory_import_start` | Memory Import Command事务 | 启动一次外部导入Workflow |
| `memory_import_reconcile` | Reconcile Command事务 | 启动一次只读对账Workflow |
| `memory_write_start` | Memory Write Command、Session Import或批准Memory Agent Candidate的同一事务 | 每个新Write Intent启动一次新方案外部写入Workflow |
| `memory_write_reconcile` | Memory Write Reconcile事务 | 启动一次只读Provider对账Workflow |
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
[仅Memory Planning]
for each memory.query（当前内置1个，自建Definition最多8个）:
  beginWorkflowMemoryQueryStep
  → queryWorkflowMemoryProviderStep
  → persistWorkflowMemoryQueryResultStep
→ freezeWorkflowMemoryContextStep
→ beginWorkflowMemoryWriteNodeStep
  → 提交Intent/Result（不创建start Outbox）
  → 当前父Workflow唯一执行write与只读reconcile

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

在Planning链中，`memory.query@1`和`memory.write@1`只存在于显式选择的Memory Planning Definition，并位于Plan修订循环之前；Memory Direct的独立顺序见第5节，并使用`memory.write@2`表达写回失败是否阻断Product Commit。`memory.write@1`保持历史规范化与Definition Hash不变，不能回填`required`字段。Query以RunSpec节点身份、executionPath和attemptNumber派生稳定`wmq_*`；Query、Snapshots与Node终态在同一Product Store事务提交。所有Query终态随后聚合成唯一`WorkflowMemoryContext`，Plan v2～v5复用同一版本和Hash。Write以稳定`mwi_*`冻结来源Message和Provider描述；外部结果通过Node终态投影，正文不进入Trace。

- `required`查询失败：先保存失败结果，再让Run失败关闭。
- `optional`查询失败：保存排除原因，规划可继续。
- 默认Simple Planning没有Query/Write节点：不调用外部服务、不制造空Context，也不产生Memory轨迹。
- Provider内部L0/L1只在Tencent Adapter内映射；Planner只看通用category、正文与三元引用。

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

## 5. MemoryDirectAgentWorkflow

```text
loadMemoryDirectRunSpecStep
→ executeWorkflowMemoryQuery
→ freezeWorkflowMemoryContextStep
→ runDirectAgentWorkflowCore
   └─ 只产生已持久化Direct Candidate，不提交正式Message
→ executeWorkflowMemoryWrite
→ commitDirectAgentCandidate
```

Memory Direct使用独立Workflow ID、Runner family和bundle；Runtime按冻结dispatch静态选择，普通Direct不会进入该函数。Query、Context和Write继续复用同一Application Port及产品事实，不在Direct Runner里复制Memory引擎或Provider协议。

Context ID/Revision/Hash进入Direct Attempt Input Manifest。Application授权Pi Operation时逐项重载Snapshots、校验Hash和Prompt组合Token预算；Pi只把规范化`<chat_memory_context>`作为当前请求前的不可信历史消息，并追加“不是系统指令”的系统约束。Context正文不进入Workflow Checkpoint、Operation Journal、Trace或日志，但会成为真实Provider Payload的一部分；`promptReviewMode=manual`时由现有Prompt Review展示并审核，`off`时仍保留Provider派发与结果未知栅栏。

Direct Agent完成时只先返回`candidate_ready`。随后执行Write：`required=true`的`failed/outcome_unknown`阻止正式Message提交，`required=false`保留Write终态后允许提交候选；任何情况下都不二次写入。最后只有`commitDirectAgentCandidate`能把候选采用为正式Assistant Message。既有`directAgentWorkflow`仍调用同一Core后立即Commit，外部行为不变。

### 5.1 MemoryAgentDirectWorkflow（`direct@3/4/5 / memory-agent-direct.v1`）

```text
loadMemoryAgentDirectRunSpecStep
→ begin/persist Workflow Memory Query
→ begin MemoryAgentOperation(retrieval)
→ Retrieval Agent 调用只读Memory工具并仅选择结果下标
→ complete / failed / outcome_unknown MemoryAgentOperation
→ freezeWorkflowMemoryContextStep
→ runDirectAgentWorkflowCore
→ begin MemoryAgentOperation(write)
→ Write Agent 从有界证据提出候选
→ persist MemoryAgentWriteCandidate（或 nothing_useful）
→ commitDirectAgentCandidate

用户稍后批准 Candidate（revision + sha256）
→ 原子创建 MemoryAgentWriteDecision + 每项 MemoryWriteIntent/Result + memory_write_start Outbox
→ 既有 MemoryWriteWorkflow 唯一执行外部写入/只读对账
```

同一Runner family只解释3种已冻结、不可混用的节点序列：

```text
direct@3 完整：agent.memory_retrieve → agent.direct → agent.memory_write
direct@4 只读：agent.memory_retrieve → agent.direct
direct@5 只整理：agent.direct → agent.memory_write
```

`direct@4`成功后直接提交Direct Candidate，没有写入Operation、Candidate或外部Write；`direct@5`不创建Workflow Memory Query/Context，Direct提示词中没有`<chat_memory_context>`，只在回答完成后生成待审核候选。3种序列各自拥有固定系统Definition/Revision/View，RunSpec加载、Direct授权和Store完整性校验都会拒绝节点缺失、额外节点或版本串用。

`agent.memory_retrieve`和`agent.memory_write`是独立的受限节点，而不是把Provider返回正文交给模型后让模型自由改写事实：检索Agent只能选择本次Provider原始结果的下标，Application据此冻结Snapshot/Context；写入Agent的每个Proposal都必须绑定可见Message或Direct Candidate证据，随后才可持久化为`MemoryAgentWriteCandidate`。模型输出从不直接成为长期Memory，也不能伪造Provider对象、外部写入身份或候选证据。

每次Retrieval/Write Agent在跨模型或Provider边界前，Application先以输入Hash、来源Hash、RunSpec和节点身份提交`MemoryAgentOperation`。模型/Provider只被允许在该栅栏后执行一次；成功、确定性失败和发出请求后失联分别收敛为`succeeded`、`failed`和`outcome_unknown`。恢复只读取同一Operation终态，绝不因Workflow重放猜测性重新查询或重新调用Agent。Operation正文、Provider Payload与Memory正文不进入Checkpoint、Trace或浏览器持久化。

写入Agent节点的`reviewMode`当前固定`manual`。Candidate批准命令复核Principal、所属Run、Candidate revision/hash及全部Item证据后，才在同一Product事务中创建统一Write Intent；拒绝只提交Decision，不产生外部写。`required=true`的写入Agent无法安全生成候选时阻断本轮Product Commit；`required=false`则以可观察节点终态继续。这里的`required`只约束“候选能否生成”，不把用户审核绕成自动外写。

## 6. MemoryWriteWorkflow

### 6.1 普通写入

```text
loadMemoryWriteStep
→ markMemoryWriteDispatchingStep
→ callMemoryWriteProviderStep（唯一外部写入，maxRetries=0）
   ├─ failed → commitFailed
   ├─ outcome_unknown → commitUnknown → 只读reconcile
   └─ accepted → commitAccepted → 只读reconcile
→ materialized / accepted / failed / outcome_unknown
```

`dispatching`是外部写入前的耐久栅栏。跨过fetch边界后的断连、超时、5xx或非法成功响应都可能意味着外部已经写入，因此不能回到写入Step盲目重试。

### 6.2 只读对账

`mode=reconcile`只允许从`dispatching/accepted/outcome_unknown`进入，只调用Adapter的读取/搜索能力，不再次执行外部写入。

- memmy：Chat固定写入L2，Provider同步落盘且文字召回不依赖embedding；已知对象只用`GET detail`严格验证。写响应丢失时先以稳定`mwi_*`在只读Panel索引中定位候选，再逐个读取详情并核对正文、标题、Tag与来源Message；不会重发`memory.add`。固定版本没有可信的库内多Principal过滤，因此当前Adapter只允许绑定的单Principal和Chat专属物理数据库。
- Tencent MemoryCore：固定本地无模型Profile声明`write.materialization=accepted_only`；用稳定映射读取L0并检查L1，L0存在收敛为`accepted`，只有Provider数据面已经真实存在同一写入session的L1才是`materialized`。本地查询门可用独立L1 fixture验证Query Port，但该fixture不能作为Write会自动物化的证据。

`accepted`是合法非失败终态。Dispatcher监督器和页面都不得把它自动降级成未知结果、显示成“物化中”，也不得为了追求`materialized`重复写入。

旧`MemoryImportWorkflow`、`MemoryImportIntent/Result`和对应API只为历史兼容保留；新功能不得继续向旧对象写入。

### 6.3 Chat/Codex Session增量导入

Session导入不是第二套Workflow。公开Query先列出Chat Product Session或本机Codex Session并生成零写入Preview；用户确认来源快照Hash与Preview Hash后，Application在一个事务中提交`MemorySessionImport`批次、尚未存在的`memory-write-intent.v2 + Result`及对应`memory_write_start` Outbox。每个Outbox继续启动本节同一个`MemoryWriteWorkflow`，因此幂等、`outcome_unknown`和只读对账政策没有分叉。

转换器固定为`conversation-turns.v1`：只采用user/assistant可见正文，按用户轮次组合并在Provider字符上限内确定性分块。条目语义身份绑定Principal、Provider、来源种类、来源Session、条目键和条目Hash；相同快照再次导入零新增，追加或修改的轮次只创建新条目。Codex Adapter只接受服务端配置的`CODEX_HOME`，按需读取`sessions`、`archived_sessions`和`session_index.jsonl`中的普通文件；符号链接、超限文件、未知顶层合同与非法JSONL失败关闭。Codex Session ID只作为外部来源身份，不成为Product Session或授权身份。

## 7. ProjectIntakeWorkflow

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

### 7.1 ProjectAdvancementWorkflow

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

## 8. Runtime Binding与版本证据

Runtime Binding保存以下私有关系：

- Product Run/Start Outbox → Workflow Run。
- Approval Request → Hook Token和Resume状态。
- Memory Import Outbox → Memory Import Workflow Run。
- Memory Write Outbox → Memory Write Workflow Run。
- Project Candidate/Outbox → Project Intake或Advancement Workflow Run和Hook恢复状态。

约束：

1. Runtime数据存在但Binding文件缺失时拒绝创建空映射。
2. Binding存在但对应Workflow Run不存在时启动失败关闭。
3. 活动Planning Run恢复前核对Workflow Definition、bundle和版本证据。
4. 活动Memory Import/Write Run分别核对各自独立Definition Version。
5. 活动Memory Agent Direct Run核对`memory-agent-direct.v1` Runner/Bundle、RunSpec、Retrieval/Write Operation与Candidate引用；恢复不会用当前默认Definition替换冻结证据。
6. 活动Project Intake/Advancement Run核对各自Definition Version、Candidate身份和Start/Resume状态。
7. Runtime ID只用于后端诊断，不进入浏览器、公开API和Product Store身份模型。

本地开发每次重建Bundle后会在服务启动前检查活动Planning Run。证据完全一致时继续恢复；若代码版本已经变化且旧Bundle不再可执行，则保留全部历史证据，通过Application把Product Run、Attempt和Workflow Outbox收敛为`workflow.version_incompatible`，并用Workflow SDK取消旧Runtime Run。该路径不删除Store或Runtime文件，也不重启同一产品工作；生产环境应保留旧部署完成原版本恢复。

## 9. 重试与结果未知

| 边界 | 当前策略 |
|---|---|
| 纯确定性Step | 可由Workflow按耐久语义重放 |
| Planner/Executor付费模型调用 | `maxRetries=0`；Executor通过同一Operation查询，不猜测性重启AgentSession |
| Project Understanding付费模型调用 | `FatalError`终止Step；Candidate记录failed，不自动再次扣费 |
| 普通Memory只读查询 | Provider标记retryable时最多重试2次；最终失败先提交Query/Node证据再决定是否终止父Workflow |
| Memory Retrieval/Write Agent模型或Provider边界 | `maxRetries=0`；每次调用先有`MemoryAgentOperation`栅栏，发出请求后失联收敛为`outcome_unknown`，恢复不重新调用 |
| Memory外部写入 | `maxRetries=0`；发出后失联进入`outcome_unknown` |
| Product Commit | 使用稳定Command ID幂等重试，不重新生成候选 |
| Workflow Start/Resume | 先记录Binding意图，失联后对账，不盲目重复 |
| Hook等待 | 同一Workflow、同一Approval绑定；页面断开不取消等待 |
| Approval过期 | Application确认状态后收敛；已决定但未恢复时继续等同一Hook |

## 10. Trace与回放

Trace记录：命令入口、事务、Outbox、Workflow Start/Resume、Step、Pi Operation/Session/Turn/Message Hash/Tool/Compaction、Provider/Memory Attempt、状态转换、耗时、错误和产品对象引用。

Trace不保存：用户消息、Plan正文、Decision正文、Prompt、Provider完整Payload、Memory正文、密钥和隐藏推理。Pi Executor例外保存已经脱敏且有长度上限的Assistant可见文本、Tool输入/结果，用于复核实际命令、模型可见路径和执行输出；它们不是产品事实。

Replay Assembler按产品对象ID、revision和SHA-256组合：

1. Product Store正文与产品事实。
2. Trace系统时间线。
3. Workflow/Prompt/模型配置版本证据。
4. Runtime Binding的安全存在性证据。

缺少revision或Hash不一致必须显式报告，不能生成“看起来完整”的假回放。

### 10.1 DSH执行轨迹投影

`GET /api/runs/:productRunId/workflow-execution-trace`是DSH完整Workflow树使用的公开只读投影；
`GET /api/runs/:productRunId/execution-trace`继续提供实时Pi工具cursor页。Application在Principal校验后组合：

1. Product Store中的实际`WorkflowNodeRun`及其Manifest已引用的现有输入/输出事实；`skipped`节点和静态
   Definition节点不进入执行轨迹。Application按引用解析真实User Message、Plan/Approval/Decision、
   Execution Contract/Candidate、Validation与正式Message，未知引用只显示不可变引用，不猜测正文。
2. Vercel Workflow World的Run/Step/Hook/Sleep事件；Runtime私有路由先把Workflow Run ID、
   correlation ID、Hook Token、原始I/O和错误正文删除。
3. 独立Run Activity Journal中的Pi Agent、模型调用、Token Usage与工具生命周期；Debug Trace不参与。

动态Execution Step由既有Execution Contract、Execution Attempt和Execution Candidate组合；Pi Attempt用
已有Attempt ID显式绑定所属Workflow NodeRun与Step。Activity是可重建读模型，不拥有产品终态；详情中的Planner
输入证据会明确标注“不是Provider原始Payload”。完整边界见[Session与轨迹架构](./session-architecture.md)。

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

### 10.2 DSH Memory 管理页与同源代理

DSH公开`settings.section`的全局「Memory」页不属于某一会话Dock：它按需读取待审核`MemoryAgentWriteCandidate`、Provider描述、Session来源/Preview/Import批次，并提供双Provider比较。候选详情显示候选正文、标签与证据引用；批准/拒绝提交观察到的Candidate revision/hash，浏览器响应丢失时只允许以同一`commandId`和逐字相同body重放。Session导入先得到零写入Preview，再以其`sourceSnapshotSha256 + previewSha256`创建批次；比较Preview本身不写Product Store或Memory，Provider score只在自身Provider内展示。

浏览器只调用枚举的`/lifeos/memory/*`同源路由；Bridge Host分别校验候选ID、query、Command Envelope和Preview payload，再逐一调用Chat公开`/api/memory/*`。它不是通用反向代理，不向浏览器暴露Sidecar endpoint、Provider凭据、配置、外部对象ID或Workflow/Pi私有身份，也不缓存产品事实。`CHAT_MEMORY_MODE=off`时此表面可以随DSH启动，但Provider列表/来源以服务端空Registry为准，绝不准备或启动Sidecar。
浏览器本地“时间”偏好通过公开Session
utility Slot控制；开启时只重投影同一Trace的本地时间范围，不写Session事件或产品事实。
Plan/HITL Composer Dock只承载当前可操作审核或结果未知重试，决定确认后退出，历史由Human Review
NodeRun继续留在Trajectory。浏览器缓存和Bridge绑定都可由Chat Query恢复，不拥有任何运行终态。

## 11. 关键源码地图

| 关注点 | 文件 |
|---|---|
| Planning主编排 | `packages/workflows/src/planning-execution-workflow.ts` |
| Memory Direct主编排 | `packages/workflows/src/memory-direct-agent-workflow.ts`、`direct-agent-workflow.ts` |
| Workflow Memory Query Step | `workflow-memory-steps.ts`、`configurable-planning-resource-executors.ts` |
| Hook与Decision Step | `workflow-decision-steps.ts` |
| 执行Step | `workflow-execution-steps.ts` |
| 验证和Product Commit Step | `workflow-result-steps.ts` |
| Memory Import主编排 | `memory-import-workflow.ts` |
| Memory Import Step | `memory-import-workflow-steps.ts` |
| Memory Write主编排/Step | `memory-write-workflow.ts`、`memory-write-workflow-steps.ts` |
| Project Intake主编排/Step | `project-intake-workflow.ts`、`project-intake-workflow-steps.ts` |
| Project Advancement主编排/Step | `project-advancement-workflow.ts`、`project-advancement-workflow-steps.ts` |
| Runtime HTTP与Local World | `runtime-server.ts`、`workflow-world.ts` |
| Runtime Binding | `runtime-bindings.ts` |
| Workflow→API私有客户端 | `packages/contracts/src/internal-runtime-client.ts`（稳定运行合同，Workflow Runtime与Pi Executor共用） |
| API私有Application Router | `apps/api/src/internal-runtime-router.ts` |
| Outbox分发与监督 | `apps/api/src/outbox-dispatcher.ts` |
| pi Planner / Executor Client | `packages/pi-runtime/src/planner.ts`、`executor-service-client.ts` |
| Pi AgentSession与Operation Journal | `coding-agent-executor.ts`、`executor-operation-store.ts`、`executor-service.ts` |
| Pi Executor进程入口 | `apps/pi-executor/src/index.ts` |
| Project Understanding/Model Profile | `packages/pi-runtime/src/project-intake-understanding.ts`、`project-advancement-understanding.ts`、`project-model-profile.ts` |
| Memory Adapter | `packages/memory-runtime/src/*-adapter.ts` |
| Project Resource Adapter | `packages/project-runtime/src/registry.ts` |

## 12. 当前边界与后续演进

已经实现：

1. 同一Planning Workflow内的规划、反复修订、批准/拒绝、执行与正式提交。
2. Provider中立、可重复的`memory.query`节点和唯一`WorkflowMemoryContext`；memmy与Tencent MemoryCore均实现相同Workflow Query/Write/Reconcile Port，运行时按显式mode选择。
3. `memory.write`节点与独立Memory Write/对账Workflow及结果未知语义；旧Import链只做历史兼容。
4. 固定Memory Sidecar的显式准备/启动、双Provider真实HTTP健康与Query/Write/Reconcile基础门；memmy与MemoryCore真实HTTP门均已通过。真实memmy断响应门进一步验证Write在响应丢失后收敛`outcome_unknown`、以同一身份只读对账并最终只产生1个外部对象；Sidecar wrapper `SIGKILL`孤儿恢复门验证子进程组终止且端口释放。
5. 独立Memory Direct三节点Workflow、Memory-aware Direct Input Manifest、Provider前不可信Context注入、组合Token预算门和候选后Write政策；当前确定性纵向已完成。
6. Chat/Codex Session零写入Preview、双Hash确认、确定性转换、条目级去重和增量导入；新批次复用统一Memory Write状态机。真实Codex Session门已验证50个来源、抽样8条消息转换为4个条目。
7. 双Provider只读比较Preview：同一来源namespace、查询和预算并行调用，返回可复核正文/标签差异且禁止跨Provider比较score；不创建第二套Workflow或产品采用事实。
8. `direct@3/4/5 / memory-agent-direct.v1`：完整、只查询和只整理三种固定组合；Retrieval/Write Agent的耐久Operation栅栏、只读结果选择、证据绑定Candidate、人工Decision与批准后复用统一Memory Write状态机。百炼`qwen3.7-plus`真实Memory Agent门3/3通过（Retrieval选择Provider原始index 1，Write生成1个候选）。
9. DSH全局Memory管理页和严格`/lifeos/memory/*`同源代理；确定性Controller/Host合同测试覆盖候选决定的CAS/原样重试、Session Preview/Import冻结Hash及逐条路由校验。默认-off真实Chromium门2/2通过；显式memmy与真实百炼模型的串行Chromium纵向也已通过，浏览器依次选择`direct@4`只查询、`direct@5`只整理和`direct@3`完整组合，验证Provider提示词上下文有无、候选审核、外部物化与刷新恢复。
10. 固定端口F5调试、严格Trace和多源Replay。
11. 独立Project Intake耐久链、真实Git/文档/脚本观察、候选确认与Project账本。
12. 独立Project Advancement耐久链、Stage/Milestone/负责人Update审核、State Transition与Timeline。

尚未实现：

1. Chat公开SSE Cursor Runtime Journal。
2. Project Context进入Planning Workflow的节点；PS1已实现Project、初始Stage、Work/Action和资源观察，但尚未注入任务规划。
3. 用户规则选择与规划注入节点。
4. 生产多实例Store、正式身份、Worker生产接管和后端部署拓扑。
5. 外部副作用Tool与通用Workflow编辑器。

未来新增节点前，应先确认它属于现有Workflow的一个步骤，还是拥有独立用户结果和独立恢复生命周期；不能为了“统一”把所有业务塞进一个永久Workflow。

## 13. 验证入口

```bash
pnpm test
pnpm --filter @chat/workflows test
pnpm --filter @chat/testing test
pnpm test:provider:bailian
pnpm test:e2e:planning-execution:real
CHAT_FIXED_SOURCE_CACHE_ROOT=/path/to/shared/cache pnpm test:memory:memorycore-real-http
env CHAT_REPO_ROOT=/absolute/path/to/Chat pnpm test:e2e:dsh-memory-vertical-real:paid
pnpm test:e2e:project-intake:real
```

普通质量门与真实付费/外部服务门必须分开运行；没有真实凭据时不得用fixture冒充真实完成证据。
