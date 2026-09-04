# Chat Workflow 调用 Workflow 设计

## 1. 目标场景

新增一种与 `planning-execution` 不同的协作方式：

```text
用户
  → planner-orchestrator / Planner：形成可审核计划
  → 人工审核：澄清、修订或批准固定 revision
  → planner-orchestrator / Coordinator：按需要分派、看护与汇总
      ├── workflow_call → Execution Workflow / Subsession 1
      ├── workflow_call → Execution Workflow / Subsession 2
      ├── workflow_call → Execution Workflow / Subsession 3
      ├── workflow_call → Execution Workflow / Subsession 4
      └── workflow_call → Execution Workflow / Subsession 5
  → Coordinator 汇总 5 个 Tool Result
```

`planning-execution` 在批准后仍由同一个 Executor Stage完成计划；
`planner-orchestrator` 则把批准计划中的工作包动态交给多个完整 Workflow Run。
工作包没有依赖时可以并行，有依赖时由 Coordinator 分批调用。

## 2. 架构边界

主执行链保持不变：

```text
Frontend → Backend → Workflow → Agent装配 → Pi AgentSession
```

- Workflow 调用是 Chat 的编排事实，不成为第二套 Agent Runtime。
- Coordinator 仍是普通 Pi AgentSession。它通过 Pi Skill理解调用规则，通过 Pi `ToolDefinition`执行调用；任何装配该Tool的Agent也可在完成自己工作的同时按需委托。
- 子任务仍从中央 Workflow Registry取得定义，经过 `startChatWorkflow()`进入 Vercel Workflow Runtime。
- 子 Workflow 内的 Agent仍统一通过 `createWorkflowAgentSession()`装配。
- 不修改 Pi SessionManager、ResourceLoader、AgentSession或 Tool Call消息格式；复用Pi公开的`newSession({ parentSession })`表达父子谱系。

## 3. 为什么调用能力是 Skill + Tool

Skill定义模型必须怎样拆分、何时并行、怎样写自包含任务书、怎样处理失败和汇总；
Tool只提供窄的可执行动作：查询目标能力、启动一个允许被Agent调用的Workflow、等待或终止它。

```text
workflow-delegation Skill
  └── workflow_call Tool
      ├── describe target Child Agents / Tools / Skills
      ├── reserve child Chat Session
      ├── start target Chat Workflow
      ├── await Workflow Run result
      └── return child IDs + result text
```

`workflow_call`通过Chat系统Tool Registry统一注册，只有Agent配置选择`system:tool/workflow_call`时才装配；`planner-orchestrator/coordinator`另外使用私有Skill约束其委托策略。
目标 Workflow必须在 Manifest中显式声明 `agentCallable: true`。`planReview`不是调用禁区：审核型子Workflow在自己的Child Session中挂起并等待用户，父Tool像等待其他长任务一样继续等待或取得可恢复句柄。
父Agent必须先用`describe`取得目标Workflow每个Child Agent实际可选的Tool/Skill准确名称，再用`start`为每个Child Agent明确选择；空数组表示明确不给予该类能力。Backend只接受名称，通过现有检查和装配入口解析Tool地址、Skill/Extension路径并冻结本轮`agentConfigs`。目标Workflow的Node、Agent身份、Prompt和Stage结构仍由Workflow定义提供，但目标Project里保存的Agent默认选择不能成为子调用的隐式授权。

Workflow声明目录是调用发现与执行Registry共同的元数据事实源。系统Tool在装配时只过滤未声明`agentCallable`的Workflow，并把可调用目标的`id`、名称、描述和Agent ID写入模型可见的Tool描述、Prompt Snippet和`workflowId`参数Schema。`describe`再通过目标的真实Agent检查入口返回本次Project中可选择的能力。当前Workflow自身只要声明了`agentCallable`也会保留：调用相同定义会创建新的子Session和子Run，不会复用父运行实例。不另建`workflow_list` Tool，也不依赖Agent读取源码猜测ID。执行时仍由中央Workflow Registry重复校验，模型可见Schema不是授权边界。

## 4. Session 与调用关系

### 4.1 不并发写父 Session

5 个子 Workflow不能共享父 Chat Session。多个 SessionManager并发追加同一条 Pi JSONL会破坏线性会话、分支叶节点和 flush顺序。

每个 `workflow_call` 必须预留一个独立 Subsession：

```text
Parent Chat Session
  ├── Planner原生 Assistant计划
  ├── 人工审核原生 User消息
  ├── Coordinator原生 Assistant Tool Call × 5
  ├── Tool Result × 5
  └── Coordinator原生 Assistant汇总

Child Chat Session × 5
  ├── Pi header.parentSession（原生谱系，不复制父历史）
  ├── chat.session_relation（CustomEntry，不进模型）
  ├── chat.workflow_delegation_origin（CustomEntry，不进模型）
  ├── 目标 Workflow的冻结配置与 Stage
  ├── 原生 User任务书
  ├── Tool Result
  └── 原生 Assistant结果
```

### 4.2 原生谱系与调用语义分开

Pi与Chat分别保留自己负责的事实：

| 事实 | 标识 | 说明 |
|---|---|---|
| Pi Session lineage | `parentSession`文件路径 | Pi原生父子谱系；使用`newSession`，不复制父Entries |
| Workflow Call | `callId` | 一次Tool调用及其父/子Run、状态和Tool Call绑定 |
| Chat Subsession | `childSessionId` | 稳定Project Session ID、调用层级及`callId`关联 |

父 Session追加 `chat.workflow_call` CustomEntry；子 Session追加
`chat.session_relation`和`chat.workflow_delegation_origin` CustomEntry。前者保存父子Session关系，后者保存发起任务的父Workflow、Stage和Agent身份；它们都不复制任务正文或结果正文：

```ts
interface ChatWorkflowCall {
  callId: string;
  toolCallId: string;
  parent: { sessionId: string; workflowId: string; workflowInvocationId: string; stageId: string; agentId: string };
  child: { sessionId: string; workflowId: string; workflowInvocationId: string; runId?: string };
  status: "starting" | "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  updatedAt: string;
}
```

同一个 `workflow_call` Tool提供四种模型可见操作，不增加旁路控制Tool：

- `describe(workflowId)`：返回目标每个Child Agent可选的Tool/Skill名称；
- `start(workflowId, prompt, agents, waitTimeoutMs?)`：父Agent提供任务上下文与每个Child Agent的明确能力选择，只创建一次子Session与Run；
- `wait(callId, waitTimeoutMs?)`：继续等待当前父Session拥有的已有调用；
- `cancel(callId)`：主动取消当前父Session拥有的非终态子Run。

默认等待窗口为30秒，单次最大5分钟，`0`表示启动后立即返回控制权。等待窗口到期返回
`status=running + callId + runId + sessionId + elapsedMs`，不会取消子Run；父Agent可以使用同一个
`callId`反复等待。这个超时是Tool调用的等待边界，不是Workflow执行时限。

每个 `projectId + parentSessionId` 最多同时拥有8个 `starting/running`子调用。容量检查在第一次
异步启动边界之前同步预留，因此同一Assistant消息中的第9个并行Tool Call也不能穿透。调用进入
`completed/failed/cancelled`后释放容量；限制只约束活跃数，不限制同一Session累计调用次数。

任务正文已经存在于父Agent的原生Tool Call参数和子Session的原生User消息；父Agent请求的能力名称同样保存在Tool Call参数，Backend解析出的准确配置保存在子Session的`chat.workflow_turn_configuration`；结果正文存在于子Session的原生Assistant消息和父Session的原生Tool Result。

委派任务在子Agent的Pi协议中仍是`role=user`：这里的role表示“当前Agent收到的输入”，不表示现实作者一定是人。`chat.workflow_delegation_origin`只引用`callId`、目标Invocation和父Workflow Agent身份；Session读模型据此给第一条原生User任务投影来源标签，页面显示“委派任务 · 来自 Workflow · Agent”。原始Pi MessageEntry、模型上下文和Prompt正文均不修改。完整历史使用同一CustomEntry生成相同来源标签，所以独立打开Child Session时仍能还原任务由谁发起。

Session列表从 `chat.session_relation` 投影 `parentSessionId`。移除父或子 Session均不隐式级联；
关系指向已移除或已永久删除Session时保留最小ID证据。

## 5. 生命周期与失败语义

一次调用按以下顺序推进：

1. `describe`校验目标并从真实Agent检查结果返回可选能力；父Agent形成任务书和每个Child Agent的明确选择。
2. `start`再次校验目标、调用深度和容量，把能力名称解析为现有Agent配置；无效选择在创建Child Session前失败。
3. 预留子Session，用Pi `parentSession`写入不复制历史的原生谱系，再写`chat.session_relation`和不含任务正文的`chat.workflow_delegation_origin`。
4. 在父Session写入`chat.workflow_call(status=starting)`。
5. 使用预先生成的子`workflowInvocationId`和冻结`agentConfigs`启动目标Workflow并绑定Run。
6. 在父Session追加`running`状态，在本次等待窗口内等待`run.returnValue`。
7. 等待窗口到期时返回可恢复的`running`句柄，子Run继续执行；后续`wait`不创建新Session或Run。
8. 成功时追加`completed`并返回结构化Tool Result；失败或取消时追加对应终态。

父 Agent或父 Run取消时，Tool的 `AbortSignal`取消仍在运行的子 Run。已完成的子 Run不回滚。
父Agent也可以在取得 `callId`后显式执行 `cancel`；控制入口先从当前父Session的
`chat.workflow_call`查找归属，因此不能等待或取消其他Session发起的调用。
并行调用独立收敛；一个子调用失败不能抹去其他子调用的成功证据。

Backend进程中断后的恢复以Chat Session为边界，而不是假设本地Workflow Runtime能原地复活
被终止的JavaScript Step：先停止或对账旧父Run，再在同一父Session发起继续回合。新Agent从
原生Tool Result取得旧 `callId`，`wait/cancel`从父Session关系和Workflow Runtime重新取得
子 `runId`与终态，不依赖原进程中的Run对象，也不创建第二个子Session。若中断发生在本地Runtime
尚未持久化子Step结果之前，旧子Run可能只能取消或重试；不能把这种情况报告为已经自动恢复执行。

Session详情同时返回只读 `workflowCallStatistics`：`direct`统计当前父Session的调用，`tree`
沿子Session边递归聚合状态数量、累计终态耗时、Subsession数量与最大深度；`capacity`暴露当前
父Session活跃数和上限。统计只读取 `chat.workflow_call`，不成为新的状态源。

第七步在同一个读模型上增加 `workflowCallTree`，每个节点只包含调用事实、深度和可选的
`parentCallId`。`GET /api/sessions/:sessionId/workflow-calls`保留为轻量诊断与控制投影，Session详情和轻量接口必须返回相同事实。父会话正文只使用Pi原生Tool Call/Result展示调用，不在输入框附近增加常驻或悬浮看护面板。

第八步以现有Session侧栏作为子Workflow入口。Session列表从`parentSessionId`递归生成树；审核型子Workflow进入`waiting_review`时，Backend从耐久审核记录投影`attention=review|clarification`。对应子Session使用轻量警示色和Pi working同类旋转动效，折叠祖先显示嵌套待处理数量。页面可见时自适应刷新列表，刷新或Backend重启后仍可重建；用户点击Child Session后进入普通会话页面，在其原有审核卡片中确认。第一版不在父会话内嵌Child Session正文。

控制调用时，客户端或后续界面提交节点的`parent.sessionId + callId`到
`DELETE /api/sessions/:parentSessionId/workflow-calls/:callId`。Backend仍调用与Pi Tool相同的
`cancelActiveChatWorkflowCall()`，先按父Session校验归属，再通过Workflow Runtime取消子Run并追加
`cancelled`终态；浏览器不能直接根据`runId`绕过归属检查。树中更深层的Agent也可以成为父调用者，
因此每个节点使用自己的父Session，而不是一律使用根Session。

父Session的完整历史把`workflow_call`显示成Child Workflow调用关系，并明确目标Workflow、Child Session、
子Run、Invocation与`callId`；原生Tool Call参数保留父Agent实际提交的任务书和能力名称。子Workflow自己的User、Agent、Tool消息和解析后的冻结配置只存在对应Child Session的完整历史。
这两份视图通过Pi `parentSession`、`callId`与`childSessionId`关联即可完整还原，但不能把子会话正文复制回父Session。

为避免递归失控，第一版同时使用三道门禁：

- Workflow Manifest显式可调用；
- 每次调用都创建独立子Session与子Run，即使父子使用同一个Workflow定义；
- `chat.session_relation.depth` 有固定上限；
- 每个父Session最多8个活跃子调用。

## 6. 人工审核

现有计划审核不是 `planning-execution` 私有UI语义。它泛化为“需要计划审核的Workflow”能力，既可用于根Workflow，也可用于Child Workflow，但保持原有合同：

- Planner输出 `needs_clarification | ready_for_review`；
- 每个 revision绑定 `reviewId + planRevision + planSha256`；
- 只有 `ready_for_review`可以批准；
- 人工原话或按钮批准写入原生 User Message；
- Hook支持刷新、重连和恢复；
- 非终态审核Run继续阻止同一父 Session开启重叠回合。

Child Workflow等待审核时，父`workflow_call`仍是`running`而不是新增终态；用户进入Child Session提交决定后，同一个子Run继续推进，父Tool最终取得同一个调用的结果。无需把审核决定转发成父会话消息，也不复制Child历史。

`planner-orchestrator` 的批准只授权 Coordinator按获批工作包调用目标 Workflow；
不自动扩大购买、发布、付款、删除等外部或不可逆动作的授权。

## 7. 验证场景

自动化场景必须实际覆盖：

1. Planner输出包含5个独立工作包的 `ready_for_review`计划。
2. 未批准前没有子 Workflow和子 Session。
3. 用户批准固定 revision后，Coordinator一次产生5个 `workflow_call`。
4. 5个目标 Workflow分别进入自己的 Subsession并完成。
5. 父 Session得到5个 Tool Result和最终汇总；Session列表把5个子Session关联到同一父Session。
6. 每个子 Workflow拥有独立 `runId`、`workflowInvocationId`、Session冻结配置和原生消息。
7. 非 `agentCallable`和深度超限必须拒绝；子失败和父取消均失败关闭并保留关系记录；相同Workflow定义、审核型Workflow的父子调用必须成功。
8. 真实Runtime覆盖 `start → running → wait → completed`和 `start → running → cancel → cancelled`，并证明父Workflow取消一个子调用后仍可继续完成汇总。
9. 在子结果已持久化、父进程消费前崩溃的场景中，同一父Session的新回合使用原`callId`恢复结果，且不创建第二个子Session。
10. 第9个同父Session活跃调用失败关闭；终态调用不占容量，Project间的预留状态隔离。
11. Session详情的direct/tree统计与真实5路并行调用一致，损坏的循环关系不会导致无限遍历。
12. 轻量控制接口在子调用运行中返回调用树；错误父Session不能取消，正确归属可以终止并持久化终态。
13. 审核型Child Workflow在Session树中出现待确认提示；从Child Session批准后，父Tool完成，提示消失，Child完整历史包含任务书、计划、审核话语、执行任务书和结果。
14. Builder单层转换、Nitro开发Step bundle、生产构建、Built Server和 `pnpm test:dev`真实Runtime全部通过。
