# Chat Session架构

本文是Chat Session语义、Workflow持久化和历史投影的约束性规范。Pi `SessionManager`是会话事实源；Workflow只能增加编排信息，不能发明第二套消息格式。

## 1. 对象边界

| 对象 | 含义 | 生命周期 |
|---|---|---|
| Chat Session | 用户看到的一条连续会话 | 跨多轮、跨Workflow持久化 |
| Turn | 一次线性交互单元，可由人或Agent先说话 | 通常对应一次Workflow Run |
| Workflow Run | 一次编排执行，包含Stage和审核等待 | 开始到完成、失败或取消 |
| Workflow Call | 父Agent的一次Pi Tool Call与一个子Workflow Run的稳定绑定 | starting到completed、failed或cancelled |
| Subsession | 为子Workflow隔离创建的Chat Session | 独立持久化，不随父Session级联移除 |
| Stage | 当前由哪个人、Agent、Task或Tool处理 | Workflow Run的一部分 |
| AgentSession | 某个Agent本次运行的Pi对象 | Agent Stage执行期间 |

在一条对话中切换Workflow、Stage或Agent不会创建新的Chat Session。例外是Agent通过`workflow_call`显式委托完整子Workflow：每个并行子调用创建独立Subsession，父Session继续保持线性Pi消息链。Pi `parentSession`表达原生谱系，Chat CustomEntry补充稳定调用ID、运行状态和层级；两者都不复制父对话，也不把并行结果塞进不透明CustomEntry冒充对话。

## 2. 三层必须分开

```text
持久化事实层：Pi SessionEntry树
  ↓
Agent上下文层：按当前Agent规则选择、转换模型可见消息
  ↓
前端投影层：把原生消息与相邻Workflow元数据折叠展示
```

持久化角色描述“事实上的说话者”，不能为了适配某个下游Agent而修改。不同Agent需要不同模型上下文时，由Agent装配时的Context Transform处理；前端需要显示Agent名称时，由Stage元数据与原生消息关联处理。

## 3. 消息硬约束

1. 人说的话必须保存为Pi原生`message.role=user`。
2. Agent说的话必须保存为Pi原生`message.role=assistant`。
3. Tool结果必须保存为Pi原生`message.role=toolResult`。
4. 一句话只能有一份会话事实。CustomEntry不能成为用户原话或Agent回复的唯一副本。
5. `custom_message`会进入模型上下文，可用于隐藏的Agent间交接或无新用户话语时的内部触发；它不能冒充用户或Agent的真实话语。
6. `CustomEntry`不进入模型上下文，只保存Workflow、Stage、Agent、配置快照、审核控制状态和原生消息引用。

Workflow/Agent身份与消息角色正交：同样是`assistant`，可以由Planner或Executor产生；同样是`user`，可以是人类原始请求、审核修改意见，或父Workflow Agent交给子Agent的任务输入。`chat.workflow_stage`负责说明相邻消息属于哪个执行阶段；`chat.workflow_delegation_origin`负责说明子Session首条任务输入由哪个父Workflow Agent发起，但不改变其Pi `role=user`语义。

## 4. 标准CustomEntry

| customType | 内容 | 禁止内容 |
|---|---|---|
| `chat.workflow_turn_configuration` | Workflow ID和本轮冻结的Agent配置 | 用户或Agent话语正文 |
| `chat.workflow_stage` | Invocation、Workflow、Stage、Node Kind、Agent ID | Agent回复正文 |
| `chat.workflow_agent_input` v2 | `inputEntryIds`，引用原生会话消息 | `userPrompt`、上游输出正文 |
| `chat.plan_review` | 审核ID、版本、摘要、`planEntryId`和控制状态 | 作为计划文本的唯一副本 |
| `chat.plan_review_decision` v3 | 决定、版本绑定、`messageEntryId`；修订决定兼容保留`feedbackEntryId` | 作为审核原话的唯一副本 |
| `chat.workflow_call` | `callId/toolCallId`、父/子Workflow与Session ID、Run ID、状态和时间 | 任务正文、结果正文 |
| `chat.session_relation` | `callId`、父/子Session ID、调用深度和创建时间 | 任务正文、结果正文或Pi `parentSession`文件路径的重复副本 |
| `chat.workflow_delegation_origin` | `callId`、目标Invocation、父Workflow/Stage/Agent身份 | 任务正文，或改写原生User Message的role/content |

人工审核是`nodeKind=human`，没有虚假的Agent ID。没有人也没有Agent的确定性节点可使用`task`或`tool`元数据；只有它真的产生话语时，才追加对应的原生消息。

## 5. Planning Execution正例

下面是一条Session中的线性时间线；缩进不表示另建子会话：

```text
custom          workflow_turn_configuration(planning-execution)
custom          workflow_stage(plan, agent=planner)
message/user    原始需求                              id=u1
custom          workflow_agent_input([u1])
message/assistant 第一版计划                          id=p1

custom          workflow_stage(review, nodeKind=human)
custom          plan_review(planEntryId=p1)
message/user    审核修改意见                          id=f1
custom          plan_review_decision(messageEntryId=f1, feedbackEntryId=f1)

custom          workflow_stage(plan, agent=planner)
custom          workflow_agent_input([u1, p1, f1])
message/assistant 第二版完整计划                       id=p2
custom          plan_review(planEntryId=p2)
message/user    已通过执行计划 v2，开始执行。          id=a1
custom          plan_review_decision(approve, messageEntryId=a1)

custom          workflow_stage(execute, agent=pi-coding-agent)
custom          workflow_agent_input([u1, f1, p2, a1])
custom_message  隐藏的内部执行交接
message/toolResult ...
message/assistant 最终回复
```

按钮不是自然语言输入框，但点击仍然是用户在会话中的真实表达。Backend必须把它规范化为准确、可见、可审计的原生User Message，而不是只留下不可见控制事实。`chat.workflow_stage`先说明审核节点，`chat.plan_review_decision`再把这条话语绑定到具体审核版本；Executor使用隐藏`custom_message`接收完整任务书并触发一轮Agent执行，但它不取代审核消息。

历史Session若只有审核Decision CustomEntry而没有原生消息，读取时可以生成兼容事件，但主会话必须使用专用“人工审核”样式，不能向用户暴露`chat.plan_review_decision`等内部类型名；完整历史必须在Review Stage中同时展示可读审核话语和结构化决定，并在左侧导航中按`user: <审核话语>`投影，保证Default、User和搜索视图与主会话一致。该投影只存在于导出读模型，不得反写源Session。

如果将来审核者是Agent，三层模型保持不变：Stage记录具体Agent身份，Agent话语使用原生Assistant Message，结构化Decision继续引用该消息；不能一律伪装成User角色。

## 6. Agent先发起

Agent可以先说话。正确顺序可以是：

```text
custom            workflow_stage(announce, agent=announcer)
message/assistant Agent的第一句话
message/user      人的回应
```

Session列表的“第一句话”取第一条原生`user`或`assistant`文本，不等同于标题。显式Session名称优先；Pi列表中的`(no messages)`只是内部哨兵，不能作为前端标题展示。

## 7. 反例

以下实现全部禁止：

```text
custom chat.workflow_agent_input { userPrompt: "用户原话" }
# 没有对应的原生user消息
```

```text
custom chat.workflow_output { message: <Planner AssistantMessage> }
# 没有对应的原生assistant消息
```

其他反例：

1. 等到Executor开始时才第一次写入原始用户请求，或再次写入同一请求。
2. 把审核原文只存在`plan_review_decision.feedback`中，或按钮批准只写CustomEntry而没有原生MessageEntry。
3. 为适配Agent B而把Agent A的持久化`assistant`改成`user`。
4. 前端长期从CustomEntry伪造user/assistant；这只允许作为未迁移活动Session的兼容路径。
5. 每个Agent、Stage或Workflow创建自己的Chat Session。
6. 把人工审核伪装成`agentId=human`。

## 8. Session文件与生命周期

Pi `SessionManager`继续拥有Session JSONL格式、创建、打开、列表和上下文构建。Chat只增加Project作用域和产品生命周期：

```text
~/.chat/projects/<projectId>/sessions/
├── <active-session>.jsonl
└── removed/
    ├── index.json
    └── <removed-session>.jsonl
```

Pi只枚举`sessions/`第一层的`.jsonl`，不会递归进入`removed/`。因此移除动作移动原始JSONL，不向Session内部追加状态，也不改变Pi默认加载流程。

源码职责保持窄而明确：

1. `session-files.ts`只提供active目录、removed目录和`sessionId → SessionInfo`文件事实，实际枚举仍调用Pi。
2. `chat-session.ts`负责Workflow执行时创建或打开Agent使用的SessionManager，并安装Chat上下文过滤器。
3. `session-read-model.ts`负责把Pi Session和Workflow观察元数据投影成浏览器合同。
4. `removed-session-index.ts`只负责移除区索引的校验、原子写入和中断恢复；`session-removal.ts`只负责移除、恢复、永久删除和保留期，不解析或重写JSONL内容。

执行入口和读取入口不能合并；它们只共享底层文件查找。Workflow启动与生命周期修改使用同一个Project Session操作锁，避免启动和移动并发发生。每次Workflow Run额外保存`runId + workflowInvocationId + projectId + sessionId`绑定，状态仍从Workflow Runtime读取，不建立第二套运行时。

`removed/index.json`保存移除时间、`purgeAt`、列表快照、最小永久删除标记和一条未完成操作。索引通过临时文件加`rename`原子替换；JSONL移动前先持久化未完成操作，进程重启或下次读取时按源文件和目标文件的实际存在状态继续完成。保留天数使用现有个人配置与Project覆盖机制，移除时固定成该Session的`purgeAt`。

Planning Run、Workflow Run、Memory、Prompt Resource和审计事实只保留Session引用，不随Session移动或永久删除。只有需要读取Session内容的调用才检查生命周期；非终态Workflow会阻止移除。永久删除只删除移除区JSONL，并保留不含会话内容的最小tombstone，从而区分“已永久删除”和“从未存在”。

Subworkflow是Workflow调用，不是Session本身。创建Child Session时复用Pi Coding Agent的`parentSession`头建立原生结构关系，但使用的是不复制历史的`newSession({ parentSession })`，不是`forkFrom()`或`createBranchedSession()`；所以Child模型只接收父Agent通过Tool参数给出的任务上下文。Chat保留三类互补领域事实：父Session的`chat.workflow_call`记录一次Tool调用及其子Run，子Session的`chat.session_relation`记录稳定`sessionId/callId/depth`，`chat.workflow_delegation_origin`记录任务发起者。Pi文件路径负责原生谱系，CustomEntry负责Workflow语义、运行ID与可观测状态，不能相互替代。Session列表优先从显式关系投影`parentSessionId`，并可从Pi路径关系兼容读取；移除功能不自动级联移动其他Session。

Session详情的`workflowCallStatistics`是上述关系的只读聚合：`direct`只计当前Session发起的调用，`tree`沿独立Subsession递归，`capacity`只反映当前父Session的活跃调用。`workflowCallTree`同时投影每条边的深度、父调用ID和调用状态，供诊断与控制接口复用；聚合使用已访问Session集合防御损坏循环，不把统计结果或调用树写回Session，也不替代Workflow Runtime状态。用户导航仍复用现有Session侧栏的`parentSessionId`树，不另建看护树。

完整历史中，父Session必须保留原生`workflow_call` Tool Call/Result，并把同一`toolCallId`的最新调用状态合并展示，至少给出目标Workflow、Child Session、子Run和调用ID；Tool Call参数是父Agent提供的任务书与Child Agent能力选择的原始事实。Child Session的完整历史独立展示原生User、Agent和Tool消息，`chat.workflow_turn_configuration`记录Backend解析后的本轮Tool/Skill配置，`chat.workflow_delegation_origin`把首条User任务标记为来自具体父Workflow Agent。两边通过Pi `parentSession`、`callId`和`childSessionId`关联即可完整还原，但父历史不内联复制子Session对话。

并行子Workflow禁止共享父SessionManager写同一JSONL。任务正文保存在父原生Tool Call参数和子原生User消息中；结果正文保存在子原生Assistant消息和父原生Tool Result中。关系CustomEntry只保存ID和状态。父Run取消时仍在执行的子Run收到取消；已经完成的子Run和关系证据不回滚。

## 9. 新Workflow检查清单

新增或修改Workflow时必须逐项确认：

1. 所有人和Agent的话语都能在原生MessageEntry中找到。
2. CustomEntry只含编排状态或MessageEntry引用，没有话语正文的唯一副本。
3. 同一UI输入不会因多个Agent消费而重复写成多条user消息。
4. Agent间交接由Context Transform或隐藏CustomMessage完成，并保留原始持久化角色。
5. Stage正确声明`agent / human / task / tool`；只有Agent节点需要`agentId`。
6. 普通Workflow切换继续使用同一个SessionManager和Session ID；并行子Workflow必须各自使用独立Subsession，并显式关联父Session。
7. 等待、恢复、重试、审核驳回和批准路径都有真实Session用例。
8. 前端刷新后从Backend和Pi Session恢复，不依赖React内存重建事实。
9. Workflow Call与Subsession关系不复制任务或结果正文，且失败、取消和部分成功都保留可恢复终态。
10. 前端Session树从读模型恢复父子关系和耐久待确认提示；取消控制必须提交实际父Session和`callId`，并复用Tool调用相同的归属与Runtime取消逻辑。
