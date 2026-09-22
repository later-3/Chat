# Chat Session架构

本文是Chat Session语义、Workflow持久化和历史投影的约束性规范。Pi `SessionManager`是会话事实源；Workflow只能增加编排信息，不能发明第二套消息格式。

2026-09-07 Long Agent 目标扩展了会话选择与跨日生命周期，见本文第10节及[Long Agent架构](../long-agents/chat-long-agent-architecture.md)。下文的Workflow消息、谱系和持久化合同继续有效；多Agent与用户共同会话的参与者协议尚未定案。

## 1. 对象边界

| 对象 | 含义 | 生命周期 |
|---|---|---|
| Project | 所有交互的数据、上下文与权限边界；Daily是默认Project | 长期存在 |
| Chat Session | 用户看到的一条连续会话 | 跨多轮、跨Workflow持久化 |
| Turn | 一次线性交互单元，可由人或Agent先说话 | 通常对应一次Workflow Run |
| Workflow Run | 一次编排执行，包含Stage和审核等待 | 开始到完成、失败或取消 |
| Workflow Call | 父Agent的一次Pi Tool Call与一个子Workflow Run的稳定绑定 | starting到completed、failed或cancelled |
| Subsession | 为子Workflow隔离创建的Chat Session | 独立持久化，不随父Session级联移除 |
| Stage | 当前由哪个人、Agent、Task或Tool处理 | Workflow Run的一部分 |
| AgentSession | 某个Agent本次运行的Pi对象 | Agent Stage执行期间 |

在一条对话中切换Workflow、Stage或Agent不会创建新的Chat Session。例外是Agent通过`workflow_call`显式委托完整子Workflow：每个并行子调用创建独立Subsession，父Session继续保持线性Pi消息链。Pi `parentSession`表达原生谱系，Chat CustomEntry补充稳定调用ID、运行状态和层级；两者都不复制父对话，也不把并行结果塞进不透明CustomEntry冒充对话。

每条Chat Session创建前必须先解析有效Project，并在整个生命周期内保持同一个`projectId`。Daily Project中的Session与其他Project使用完全相同的Pi JSONL和Chat元数据合同；Daily只是默认Project，不是无Project Session类型。Chat Web、IM和CLI可以成为同一Session的交互入口，入口变化不改变Session身份和Project归属。

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
5. 仅因一个线性Workflow切换Agent或Stage就隐式创建新Session；显式子调用、Daily按日轮换或新的独立工作使用各自已声明的会话创建合同。
6. 把人工审核伪装成`agentId=human`。
7. 创建`projectId`为空的普通聊天Session，或由Frontend用“Daily模式”掩盖无Project数据。
8. 切换Project时原地修改Session归属，或因目标Project不可用而把原Session放进Daily继续。
9. 同一外部会话从IM切到Chat Web时，仅因入口变化就复制一个新的Chat Session。

## 8. Session文件与生命周期

普通 Workflow 支持显式 Fork：选择用户 Entry，在该输入之前通过 Pi `createBranchedSession()`（空历史使用 `newSession`）创建同 Project 的新会话，保留 `parentSession`，源会话不变。`chat.session_fork` 标记之前复制的审核、子调用和 Subsession 关联只属于历史，不成为子会话的活跃控制状态。幂等发布、Web/TUI 接续和完整历史投影见 [Workflow TUI 合同](../tui/chat-workflow-tui.md)。

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
11. 新建、恢复、主动发言、Channel接入和定时触发都先解析Project；缺少具体归属的新交互进入Daily Project。
12. Session固有Project与请求、Channel Binding或父任务Project不一致时明确失败，不自动迁移或回退。

## 10. Friend 每日 Session 与本轮项目（P1，待实施）

实施状态：P2 已完成本轮装配元数据与历史项目标记；P3 已完成每日唯一性、耐久接受序号、总结与恢复；P5 迁移与恢复合同见[升级手册](../../operations/friend-migration.md)。标题保留以兼容既有锚点。

最新合同取代旧的“进入业务项目另建 Friend Session”。每个 Friend 每日一条直接交流 Session，原生 ID、存储根、header cwd 不因工作目标变化。普通项目 Session 和显式 Workflow 子会话保持原合同；跨日、时区和总结由[Long Agent 架构 §4–6](../long-agents/chat-long-agent-architecture.md#4-project-first-与会话选择)规定。

### 10.1 原生记录与模型输入

- 版本化 `chat.long_agent_turn` 扩展 SessionRef、协作目标、装配 snapshot revision、可信来源、接受序号和回复关联；旧 schema 继续可读，不猜失踪的目标字段。未知新版本停止执行并提示升级，不能默认成 Home。
- 用户/助手/工具仍各存原生消息。CustomEntry 只保存关联和证据，不能认为模型自动看到它。
- 在首轮及协作项目变更时，追加一条原生隐藏 custom_message，说明“以下轮次属于项目 A/无项目”的历史事实；包含稳定项目 ID、名称和关联 turnId，不复制 AGENTS.md 正文，不伪装成用户原话。同一 turnId 幂等；中断恢复检查标记，不能重复追加。
- 当前有效规则仅在本轮系统装配区域替换；历史项目标记只解释过去。它进入 Pi 原生 compaction 输入，压缩要求保留项目归属和未完成事项。CustomEntry 仍保存可核对的范围，模型摘要不能取代事实。
- transformContext 可作只读上下文投影，不能改持久角色，也不能独自承担 compaction 的项目归属；原生压缩读取 Session 分支，不保证使用普通 prompt 的 transformContext。
- 每日交接按 revision 每轮装配恢复，不只在首次创建时添加一条可能丢失的系统提示。日内压缩与跨日交接分开，不能删除原 Entry 来模拟压缩。

### 10.2 迁移、兼容与日历唯一性

旧 Agent 项目绑定、旧按日索引和旧 Channel 映射先扫描并报告。每 Friend 每日期建立唯一新索引；若同日已有多个旧 Session，以已有 Home 当日主 Session 为优先，无法唯一确定时停止该 Agent 迁移并报告冲突，不合并正文。其他旧 Session 保留为历史。迁移和维护时没有当日主 Session 就保持空；首次实际交流再创建。旧业务历史提供有来源入口，不伪装成当日既有对话。

迁移在停止新接受并排空在途工作后进行；保存受管备份、版本标记和原映射。阶段写入原子化，重跑从标记恢复；失败前不发布新映射。回退仅允许新格式尚无新增工作时恢复原映射；已有新消息后必须导出兼容数据或向前修复，不把旧版本直接指向未知格式。旧链接读取保持，继续发送由后端明确定位今天，不静默写旧日。

Project 参与者不因能读项目而自动获得 Friend 混合多个项目的整日 Session。按项目活动投影只返回授权轮次引用/摘要；整个 Friend 日常历史继续属于其私有受众。

原生接缝门禁：`test/agents/pi-assembly-seams.test.mjs`。它已证明同一 ID/文件重装配、CustomEntry/transformContext 区别及 compaction 重开恢复；P2 公共工厂及 Long Agent 消息/检查 API 已增加实现测试；P3 生产入口回归见 `test/long-agents/daily-lifecycle.test.mjs`，包括真实压缩后恢复工具操作；P5 无损迁移演练结果见[阶段验收](../../history/reviews/2026-09-20-agent-unification-p5.md)。

### 10.3 P2 已实现的原生扩展

`chat.agent-assembly.v1` 保存 Friend 本轮定义、存储身份、协作目标、根规则正文和 SHA-256；`chat.agent-assembly-resources.v1` 保存选中资源内容/版本；`chat.agent-assembly-tools.v1` 保存实际启用工具选择、Schema 和资源版本，恢复不允许设置变化暗中增加能力；`chat.workflow-context-files.v1` 保存普通 Workflow invocation/stage/agent 的规则快照。均使用 Pi CustomEntry，未知版本或校验错误中止恢复，不向模型重复注入元数据。

`chat.collaboration-context.v1` 为原生隐藏 CustomMessage，在首轮或目标变更时幂等记录 turnId、项目 ID/名称及历史解释，不复制规则、不增加 user 消息。Pi 原生压缩能够读到它；P3 已通过真实 Pi 压缩输入、原生记录重开、项目 B 工具写入及旧日总结的产品回归。

Workflow Call 的 parent/child 端点增加可选 `projectId`。旧记录省略时沿用原同项目关系；跨项目子会话创建先验证 parentProjectId 与真实父 Session 归属，保持 Pi 原生 parentSession。树读模型和前端解析保留两端 Project，统计按已记录目标加载子 Session，不从父 cwd 猜测。Memory 写入来源仍为父存储 Session，默认写入目标取协作 Project。

P5 归属查询同时读取当前主会话、全部 dailySessions 和经过校验的历史迁移记录。旧 Friend 历史返回原 owner 与 `readOnly: true`，不能变成普通 Workflow 会话；普通 Workflow 启动入口再次校验归属。旧链接携带的 projectId 由 Backend 按精确 Session 映射解析，未知项目或 Session 不回退。新迁移不移动或复制 JSONL；只为已执行 v1 迁移的历史保留当前位置别名。

## 11. LA0：独立工作与群聊的原生 Session 合同

2026-09-20 目标合同；LA0 证明原生接缝，生产接入分别属于 LA1/LA5。每日唯一性只约束默认直接交流，不限制任务/群参与上下文。对象与生命周期以[Long Agent 机制 §9](../long-agents/chat-long-agent-mechanism-contract.md#9-la0交互任务与调度的实施合同)为准。

### 11.1 存储与模型输入

```text
Friend A（一个身份）
  ├─ 直接交流：Home / 今日 Session
  ├─ 后台任务：Task 归属 Project / 独立 Session
  ├─ 群 X：X 归属 Project / A 的参与 Session
  └─ 群 Y：Y 归属 Project / A 的参与 Session

群 X 公共 Session（不运行共享的 Agent Loop）
  ├─ 人类原生 user 消息 + 可信作者关联
  ├─ A 的 publication → A 参与 Session 的原生 assistant Entry
  └─ B 的 publication → B 参与 Session 的原生 assistant Entry
```

公共根负责排序和已发布消息引用；每位 Friend 在自己的参与 Session 中保留输入、原生 assistant/toolCall/toolResult、压缩及重试。公共根不是另一份文本日志，也不是把多名 Agent 当同一个 assistant 轮流驱动。前端通过 Backend 受权投影渲染原生消息引用，不能自行读参与者完整 Session 或凭姓名推断作者。

元数据只保留 conversation/participant/turn/run、source Session/Entry、replyTo、配置/授权 revision、输入截止点与状态。群外消息进入参与 Session 时采用有来源的原生 custom_message，保留原作者和公共 Entry 引用；Pi 映射成模型支持的角色，但 Chat 的真实发送者不丢失、不冒充真人。派生输入不是第二份群消息事实，必须能追溯公开原件和输入 revision。

`CustomEntry` 本身不会进入模型上下文。公共根引用需要显式受权投影才能展示/喂给参与者，不能期望 Pi 自动解析跨文件引用。普通/Friend 的共用历史/流式读取层增加该解析能力，各入口只增加可信来源及工作关联；不另写群聊渲染器来掩盖消息合同差异。

### 11.2 发布与恢复

发布按执行者原生输出定位，只选择明确公开的文本块，默认不公开 thinking、工具参数/结果或私有草稿。一次 publication 固定 source Entry 与内容摘要/所选块，发布后修订产生新版本，不跟随参与 Session 当前 leaf 漂移。摘要用于校验，不保存正文副本。

两条 Session 文件不能假装一次事务：先保证子原生 Entry 落盘，再在公共根已有锁内重开、按稳定 publicationId 幂等追加引用，最后更新可重建的消费/投递索引。子落盘但根未提交可重试；根已提交但回执丢失不得重复发布。未提交的流式草稿以 runId 区分，终态前不算公共历史或其他 Agent 的输入。

读取验证成员/受众 revision、源 Session 绑定、Entry 类型及摘要。无授权不返回正文；源被删除、损坏或校验失败显示不可用引用，禁止回退为读取整个私有 Session。原始消息只能由所属生命周期管理，引用中不公开磁盘路径。永久删除前必须处理公开引用的保留/墓碑策略。

原生 compaction 不删除 Entry；公开引用按 Entry ID 解析，因此不依赖当前模型上下文是否保留原文。参与者压缩保留公开消息截止点和来源，不能重新消费全部群历史。Fork 的历史引用仅为历史，不得重发、重算预算或复活旧任务；新分支执行另有工作标识。既有每日 Session 不因新增这些类型而被改写、拼接或改属。

### 11.3 独立任务返回

子工作使用 Pi 原生谱系和 Chat 稳定 origin 关联；来源会话与执行归属可跨 Project，两个端点分别授权。等待返回期间不保留父写入器。完成事件先耐久保存，再按目的 Session 锁重开最新 leaf、验证版本、去重写入最小结果引用；模型消费通过明确的后续轮次，不能伪造已经结束的 Tool Result。

锁内重开只是单 Backend 的写入保障，不是跨文件事务或任务恢复服务。LA1 已用等待窗口写入器替换 `workflow-call.ts` 的异步 settle 路径，后台返回重新获取 Session 锁并重开；具体合同见 [Workflow 返回](../workflows/chat-subworkflow-design.md#la1-实际返回路径)。LA0 的测试原型不作为生产辅助函数复用。

接缝门禁：`test/long-agents/la0-session-seams.test.mjs`。它通过公共工厂、真实 Pi 工具、压缩、文件重开验证独立执行与引用可行，复现旧 manager 分支风险，并验证锁内重开及持久去重。它不证明成员 ACL、群输入裁剪、生产公共投影或后台调度已经实现。

### LA1 已实现的后台 Session

明确后台工作绑定纳入 Session owner 与可写投影，存储于 Friend Home；普通 Workflow 启动接口不得接管它。日常列表只含每日主聊，独立工作从 Friend 工作列表进入。复用现有详情、Pi 历史、压缩及 turns/events 实时合同，不添加第二套 transcript。工作句柄与结果引用、v5 迁移、跨日/取消/恢复边界以 [Long Agent 实现合同](../long-agents/chat-long-agent-architecture.md#la1独立后台工作实现合同)为准，群公共 Session 尚待 LA5。
