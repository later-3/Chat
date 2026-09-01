# Chat当前架构与源码分析

## 1. 目的和源码规模

本文描述当前开发分支已经由自动测试覆盖的实现事实，不把后续设想写成现状。目标架构和新增需求必须遵守[Chat Agent第一性原理与架构约束](./chat-agent-first-principles.md)。

当前Chat后端和Workflow位于`src/`：

| 类型 | 数量 | 说明 |
|---|---:|---|
| Chat后端开发代码（`src/`，不含测试） | 持续变化 | 以当前分支源码为准 |
| Chat后端与脚本测试 | 持续变化 | `*.test.mjs`与`scripts/`中的构建测试 |
| Pi Web派生前端开发代码 | 持续变化 | 纯浏览器前端 |
| Workflow框架支持的Node类型 | 2 | Agent Node、Task Node |

不包含两个子模块、构建产物和依赖。前端和Pi分别由`frontend/`与`pi/`子模块固定提交。

## 2. 当前组件边界

```text
frontend/：Pi Web派生的纯浏览器前端
  │
  │ HTTP
  ▼
Chat Nitro进程
  ├── 认证与前端静态文件
  ├── /runs：Workflow控制与事件读取
  ├── /api/sessions：Pi Session读取投影
  ├── /api/projects：Project Registry发现与切换
  ├── /api/files：受限文件读取
  ├── /api/workflows/.../agents/.../resolve：Agent实际装配结果
  ├── /api/workflows/.../agents/.../catalog：Agent可选择资源目录
  ├── /api/chat-config：.chat根配置读写
  ├── /api/memories：长期记忆管理
  ├── /api/prompt-resources：规则与经验Prompt资源、草稿和版本读取
  └── /api/skills、/api/extensions、/api/plugins：Pi资源管理
          │
          ▼
Vercel Workflow Runtime
  ├── minimal-pi-coding-agent
  ├── planning-execution
  ├── memory
  └── rule-management
          │
          ▼
Chat Workflow Step
  ├── 打开Chat Session
  ├── 创建本Stage的Pi AgentSession
  ├── 订阅Pi事件并发布Run事件
  ├── 执行Prompt
  └── 销毁进程内AgentSession
          │
          ▼
pi/：Pi Coding Agent
  ├── ~/.chat/agent：模型、认证、Settings和个人资源
  ├── <project>/.chat：Project配置和资源声明
  ├── ~/.chat/prompt-resources：个人规则与经验
  └── ~/.chat/projects/<projectId>/
        ├── sessions：Chat对话Session
        └── prompt-resources：项目规则与经验
```

生产部署只运行一个Chat进程。`frontend/dist`由Nitro提供，不再启动Pi Web Next.js服务。开发环境额外运行Vite，只提供页面热更新和到Chat的代理。

## 3. 浏览器到Workflow的调用链

当前浏览器发送一条普通文本消息时：

```text
useAgentSession.handleSend()
  ↓
GET /api/chat-config
  → 默认Workflow和Agent选择
  ↓
POST /runs { projectId, cwd, prompt, sessionId?, workflow, agentConfigs? }
  ↓
首轮调用reserveChatSession()创建并flush Pi Session
  ↓
startChatWorkflow()
  ↓
start(minimalPiCodingAgentWorkflow | planningExecutionWorkflow | memoryWorkflow)
  ↓
立即返回runId、workflowInvocationId、sessionId、isNewSession
```

浏览器随后并行执行：

```text
GET /runs/:runId/events
  → NDJSON：stage_start + Pi AgentSession事件投影

GET /runs/:runId
  → 轮询running / completed / failed / cancelled，并在waiting_review阶段返回当前计划

POST /runs/:runId/review
  → approve，或request_revision + 用户审核原文
```

Run被接受后，浏览器立即使用返回的Session ID更新地址栏、当前Session和侧栏；这一步不等待Workflow完成或人工审核结束。完成后，浏览器再请求`GET /api/sessions/:id`，以Pi Session持久数据校正页面历史。

与原Pi Web相比，Chat没有长期驻留的`AgentSessionWrapper` Registry，也没有`/api/agent/:id`命令总线。每条用户消息启动一次Workflow Run；每个Agent Stage在自己的Step中创建和销毁AgentSession。

## 4. Workflow目录与选择机制

当前后端注册4个Workflow：

```text
minimal-pi-coding-agent
planning-execution
memory
rule-management
```

每个Workflow目录拥有`workflow.json`、`index.ts`注册入口、`workflow.ts`编排定义、`step.ts`或`steps.ts`运行实现、独立Agent目录和专用上下文代码。`defineChatWorkflow()`校验两种声明式Node、Agent配置路径和引用关系。编排文件不导入Node或Pi运行代码；Step才打开文件、Session和Pi SDK。

`registry.ts`是后端唯一注册事实源：HTTP请求用它校验Workflow ID，`startChatWorkflow()`用它取得运行函数，`GET /api/workflows`用它返回Workflow、Node和Agent定义。静态配置使用“Node”；运行期事件和Session观察记录继续使用“Stage”，Stage ID对应执行中的Node ID。

Pi Web前端从`GET /api/workflows`读取选择项，不再维护支持的Workflow白名单。前端提交时只校验Workflow ID是非空字符串，后端注册表执行最终校验。

## 5. Chat Session

### 5.1 事实源

Chat只使用Project Registry解析出的目录：

```text
~/.chat/projects/<projectId>/sessions
```

`openChatSession()`负责：

1. 用`projectId`从Registry解析cwd、agentDir和sessionDir，并校验可选cwd一致。
2. 没有Session ID时，用`SessionManager.create()`创建新Session；`POST /runs`的首轮接受边界通过`reserveChatSession()`立即`flush()`，保证响应中的ID已经可查询。
3. 有Session ID时，只在Chat Session目录中查找，并校验Session的cwd与请求cwd一致。
4. 配置Chat的Context Entry Filter，避免旧版本规划交接消息继续进入模型上下文。

浏览器不能提供Session文件路径。Session ID是网络边界上的唯一会话标识。

### 5.2 一次对话与一次AgentSession不是同一个生命周期

当前一个Chat Session可以连续经历多次Workflow Run和多个AgentSession：

```text
同一Chat Session JSONL
  ├── 第1轮：Direct Workflow / Pi Coding AgentSession
  ├── 第2轮：Planning Workflow / Planner AgentSession + Executor AgentSession
  └── 第3轮：再次Direct / 新建Pi Coding AgentSession并恢复同一JSONL
```

模型历史、Thinking变更、压缩和分支仍由Pi SessionManager恢复。Workflow切换不会自动创建新对话。

Session还通过Pi CustomEntry保存两类Chat事实：每个Workflow的最新Agent配置，以及每轮执行真正使用的冻结配置。配置作用域是`Session → Workflow → Agent`；同名Agent出现在不同Workflow中不会共享配置。Pi Web刷新Session后从Backend恢复这些配置。

Chat关闭Pi从cwd无限向父目录发现`AGENTS.md`或`CLAUDE.md`的默认行为。统一Agent装配层只显式提供两类Context文件：`~/.chat/agent`中的用户级文件，以及用户当前明确打开的Project根目录中的文件。父目录和子目录Context都不自动读取。文件仍由Pi放入标准`project_context`区域，执行和Agent检查页面使用同一结果。

## 5.3 Prompt资源

规则与经验按Target保存在Chat Home运行数据中：个人资源位于`~/.chat/prompt-resources`，项目资源位于`~/.chat/projects/<projectId>/prompt-resources`。每个已确认资源使用追加版本链，草稿与已确认资源分目录保存。资源包含目的、Prompt内容、标签、状态和Session来源；归档产生新版本，不删除历史。Rule Curator通过只读Pi Tool读取当前Session活动分支，自行选择相关Pi Entry ID并保存上下文快照，用户不需要接触内部ID；创建工具再次校验这些Entry属于当前活动分支的可引用范围。项目源码目录中的`.chat/prompts`仍是可随仓库移动的Pi Prompt文件，两者不混用。

产品自带的开发经验案例保存在源码常量和`docs/development-experiences/`中，首次访问时以稳定ID归档到Personal经验库；初始化只补充缺失资源，不覆盖用户已经修改或归档的同ID版本。它们与对话产生的经验使用相同API、前端勾选、Session配置和System Prompt装配链路。

规则内容描述适用场景和必须遵守的要求，可以直接包含要求，也可以引用Project内稳定路径的设计或工程文档。Prompt资源实体与版本历史保存在上述Chat Home目录；`<project-root>/.chat/config.json`和Session配置只保存Workflow Agent对资源Target、ID及revision的选择关系，不复制资源实体。

Agent配置通过资源ID选择Prompt资源。本轮开始时Chat把资源解析到具体版本并写入Turn配置快照，随后把该版本内容放入Chat自定义System Prompt区域。规则管理Workflow使用普通Pi AgentSession、一个Workflow专用Skill和Chat Custom Tools完成检索、草稿、确认提交与Agent规则建议；用户通过后续对话确认应用或拒绝建议，拒绝不会修改目标Agent配置。

## 6. 直接执行Workflow

`minimalPiCodingAgentWorkflow()`只有一个Step：

```text
openChatSession()
  ↓
appendChatWorkflowStage(execute, pi-coding-agent)
  ↓
createAgentSession({
  cwd,
  agentDir,
  sessionManager,
  transformContext: stripLegacyPlanningHandoffs
})
  ↓
session.prompt(userPrompt)
  ↓
Pi把User / Assistant / Tool Result写入同一Session
```

除Chat指定的路径、SessionManager和旧数据过滤外，这个AgentSession按本轮解析出的Agent配置运行。没有外部选择时使用Pi默认资源、模型、Thinking和工具；选择配置后可显式指定Model、Thinking、Prompt、Tools和资源。它的Agent身份本质上是Pi Coding Agent，不是Chat自定义的“Direct Agent”。

## 7. 规划执行Workflow

### 7.1 Planner Stage

Planner先打开同一个Chat Session，然后：

1. 写入`workflow=planning-execution / stage=plan / agent=planner`元数据。
2. 把原始用户请求作为Pi原生`message.role=user`写入一次。
3. 写入只包含`inputEntryIds`的Agent输入引用。
4. 在同一个持久SessionManager上创建Planner AgentSession；Planner使用替换System Prompt和无工具策略。
5. 从最后一条原生Assistant消息解析`chat-planner-output`契约。Planner必须先覆盖背景、目标、交付物、范围、约束、授权边界和验收标准，并明确区分可由Executor调查的事实与只能由用户决定的阻塞信息。
6. `needs_clarification`只生成任务澄清文档和阻塞问题；`ready_for_review`才生成可批准的执行计划。原生Assistant消息保留完整输出，审核正文不显示机器元数据。

修订时审核原文已经是最新的原生User消息。Planner使用Context Transform在模型调用中补充“修订完整计划”的控制说明和上一版计划，不改变或复制持久化话语角色。

当前Planner仍会创建默认ResourceLoader并加载Extension；`noTools: "all"`只关闭工具，不等于`noExtensions: true`。因为没有`read`工具，已发现Skill不会进入Planner System Prompt，但Extension代码仍可能参与生命周期。这只是当前Planner的具体配置，不代表Chat存在“受限Agent”类型，也不构成后续默认禁止Extension的理由。

### 7.2 Review Task与修订循环

Planner每次输出任务澄清或完整计划后，Workflow创建与`workflowInvocationId + planRevision`绑定的耐久Hook，并把审核正文、就绪状态、阻塞问题、版本、SHA-256和Session ID同时写入主Session与Project运行状态。Workflow Run保持`running / waiting_review`，不创建新Session，也不把审核Task伪装成Agent。

- 等待澄清：前端列出阻塞问题，只允许用户补充信息并继续规划；Backend拒绝对`needs_clarification`提交批准决定。
- 批准：只有`ready_for_review`可以在审核接口校验Run、Project、版本和计划摘要后恢复Hook。按钮动作规范化为一条可见的原生User MessageEntry（例如“已通过执行计划 v2，开始执行。”），决定CustomEntry通过`messageEntryId`引用它，再进入Executor。
- 补充信息或要求修改：用户原文写入原生User MessageEntry；决定CustomEntry通过`messageEntryId`和兼容字段`feedbackEntryId`引用同一条消息。原始请求、上一版文档和用户消息进入同一个Planner配置继续修订。
- 审核事实分三层：`chat.workflow_stage(review, nodeKind=human)`说明谁在处理；原生User MessageEntry保存人的实际表达；`chat.plan_review_decision`保存`reviewId + revision + sha + decision + messageEntryId`的机器绑定。节点身份、会话话语和控制决定不能互相替代。
- 刷新或断线：前端从Session和运行状态恢复同一Run；断开页面连接不会隐式取消，只有停止按钮调用`DELETE /runs/:runId`。
- 并发：同一Session存在非终态规划Run时拒绝开启新回合；`completed / failed / cancelled`是单向终态，迟到Step不能重新发布审核。

### 7.3 Executor Stage

Executor重新按Session ID打开主Session，然后：

1. 写入`stage=execute / agent=pi-coding-agent`标记。
2. 写入只含原始请求、审核消息和最终计划MessageEntry ID的输入引用。
3. 创建ResourceLoader，在Pi默认System Prompt后追加执行规则。
4. 审核按钮产生的规范化User Message已经作为真实会话话语持久化；Workflow再通过`sendCustomMessage(..., { triggerTurn: true })`写入隐藏的结构化内部交接并触发执行：

```text
workflow_execution_task_brief
  ├── task.userRequest：用户原话
  ├── task.approvedPlanRevision：批准版本
  ├── task.approvedPlan：最终批准的执行计划
  └── executionContract：启动、调查、授权边界和完成报告要求
```

5. Pi正常持久化Tool Result和Executor Assistant消息；不会第二次写入原始User消息。

这个`custom_message`会进入模型上下文，前端不把它渲染成用户话语，也不取代审核User Message。持久Session完整保留Planner计划、审核决定、结构化绑定以及Executor输出；不同Agent的模型视图由Stage装配规则决定。

### 7.4 为什么Planner必须保存为Assistant

Planner确实是本轮说话的Agent，所以它的计划就是原生Assistant消息。多个Agent身份不通过篡改角色表达，而通过`chat.workflow_stage`与相邻原生消息关联。

当前实现分开三层：

- 持久化事实：原生User、Assistant和Tool Result。
- 模型上下文：每个Agent按Stage规则选择和转换同一线性历史。
- 前端投影：把Stage元数据和相邻原生消息折叠成一个Workflow视觉块。

完整规范和反例见[Chat Session架构](./chat-session-architecture.md)。

## 8. Memory Workflow

Memory Workflow使用一个`memory-agent`：

1. Agent JSON只启用6个`memory_*` Tool。
2. Tool用Pi `defineTool()`定义，并通过Pi `customTools`注入当前`MemoryService`、cwd、Session ID和Workflow Invocation ID。
3. Memory Skill源码位于Agent目录的`skills/memory/SKILL.md`；生产构建通过Nitro Server Asset物化到`~/.chat/runtime/skills/memory`。
4. `resolve`和执行共用同一装配函数；检查模式使用不可执行占位服务，不创建Memory数据库或索引。

Memory管理HTTP API和Memory Agent Tool都调用同一个`MemoryService`，前端管理页不绕过Chat目录数据库直接操作Mem0。

## 9. Workflow事件与完整历史

### 8.1 实时事件

`subscribeAgentSessionLog()`订阅每个AgentSession，`createChatRunEventPublisher()`把事件写入Workflow Run的NDJSON流。事件外层增加：

```text
workflowId + stageId + agentId
```

浏览器因此可以区分Planner与Pi Coding Agent，同时复用Pi Web原来的消息、Thinking和Tool渲染器。

实时流只投影浏览器需要的字段，不是永久历史。

### 8.2 Session观察数据

Chat使用Pi原生`CustomEntry`保存不进入模型上下文的编排数据：

| customType | 内容 | 用途 |
|---|---|---|
| `chat.workflow_stage` | Workflow、Stage、Node Kind和Agent身份 | 划分执行阶段 |
| `chat.workflow_agent_input` v2 | 原生消息`inputEntryIds` | 说明每个Agent使用哪些会话事实 |
| `chat.plan_review*` | 审核版本、决定、摘要和消息引用 | 恢复人工审核状态 |
| `chat.session_migration` | 迁移ID、备份、源哈希和变更ID | 历史数据幂等迁移 |

`chat.workflow_message`和包含`userPrompt/upstream.output`的Agent Input只为旧Session迁移期读取，新代码不再写入。`session-read-model.ts`把Pi原生消息和Stage元数据投影成前端历史；`session-export.ts`生成按Workflow、Stage和Agent整理的完整历史。

## 10. 当前能力配置在哪里

当前每个Workflow已经拥有自己的Agent JSON配置，并通过公共解析和装配代码转换为Pi运行对象：

| Agent Stage | 当前能力来源 |
|---|---|
| Direct的Pi Coding Agent | Workflow目录内`agents/pi-coding-agent/agent.json` + `~/.chat/agent` Settings/模型/资源 + 当前可信Project资源 |
| Planner | Workflow目录内`agents/planner/agent.json`定义替换System Prompt，并默认选择`system:tool/memory_search` |
| Planning Executor | Workflow目录内`agents/pi-coding-agent/agent.json`定义Chat自定义指令；`context.ts`实现不可序列化的Context Transform |
| Memory Agent | `agents/memory-agent/agent.json` + 私有Skill/管理Tool + 公共`memory_search`/`memory_record`系统Tool |
| Rule Curator Agent | `agents/rule-curator-agent/agent.json` + 私有Skill + Pi Custom Tool运行时装配 |

`agent-config.ts`和`agent-config-loader.ts`严格解析并有序合并Workflow默认配置、Project持久配置、Session配置、本轮调整、主配置、追加配置、Prompt文件与已固定版本的Prompt资源。`agent-definition.ts`实现身份、基础System Prompt、Chat自定义指令区域、模型、Thinking、工具和资源策略；它通过公共Tool Resolver把限定地址转换为Pi `ToolDefinition`，再集中创建SettingsManager、ResourceLoader和AgentSession。`GET /api/tools`查询Project可见Tool与反向使用关系，`catalog`查询Agent可选择资源，`resolve`查询本轮实际装配结果。

`~/.chat/config.json`保存个人默认，`<project-root>/.chat/config.json`保存Project覆盖。Session使用Pi CustomEntry保存每个Workflow的最新配置和每轮冻结快照。本轮请求只提交实际调整；后端按`Workflow默认 → Session最新 → 本轮调整`解析，先把所有Agent和Prompt资源冻结为可执行定义，再追加Session配置事实。同一Workflow的所有Stage复用该冻结结果。

`GET /api/workflows`可以查询Workflow、Stage和Agent定义；可执行的`run`和`prepareAgentSession`不会投影给浏览器。Agent执行和检查都先从Registry取得Workflow定义，再调用同一个`prepareAgentSession`装配Workflow私有Tool、Skill和Context Transform，随后进入公共`createWorkflowAgentSession`。因此前端无需了解某个Workflow的Tool实现，也能通过通用检查接口看到最终Prompt、Model、Thinking、Tools和资源诊断。

## 11. 当前边界问题

这部分只指出源码事实，不在这里直接给最终重构方案。

1. Agent配置文件内容尚不能在前端创建和编辑。
2. 普通Task Node已有Schema和框架校验，但4个现有Workflow都只有Agent Node；等真实需求出现后再增加实例。
3. Context Transform和宿主依赖Tool仍由Workflow代码注册；配置只能引用稳定名称，不能序列化函数。
4. Catalog表示已安装/可选择资源，Resolve表示当前Agent实际生效能力；前端仍可进一步强化这两个状态的视觉区分。
5. 运行中Steering、Follow-up、Extension交互式UI和Session Fork依赖持续运行控制面，当前一次一Run的接口尚未支持。
6. cwd-only Session和Resource入口仅保留给旧数据迁移与现有测试；浏览器正常路径已经提交稳定`projectId`。
7. Skill、Extension和Plugin已有基础管理API和每Agent选择，更新检查及部分原Pi Web操作仍待迁移。

## 12. 源码证据索引

| 结论 | 源码 |
|---|---|
| 浏览器Workflow调用 | `frontend/lib/chat-workflow-browser.ts`、`frontend/hooks/useAgentSession.ts` |
| HTTP输入和Workflow选择 | `src/run-request.ts`、`src/routes/runs.post.ts`、`src/workflows/registry.ts`、`start-chat-workflow.ts` |
| Chat Session所有权 | `src/chat-session.ts` |
| 直接执行 | `src/workflows/minimal-pi-coding-agent/` |
| Planner与Executor | `src/workflows/planning-execution/` |
| Workflow框架与Manifest | `src/workflows/framework.ts`、各Workflow的`workflow.json` |
| Agent配置与装配 | `src/workflows/agent-definition.ts`、各Workflow的`agents/<id>/agent.json` |
| 分层配置 | `src/chat-config.ts`、`src/routes/api/chat-config.*.ts` |
| Memory | `src/memory/`、`src/workflows/memory/`、`src/routes/api/memories/` |
| 规则与经验 | `src/prompt-resources/`、`src/workflows/rule-management/`、`src/routes/api/prompt-resources*` |
| Session Workflow配置 | `src/workflows/workflow-configuration.ts`、`src/session-read-model.ts` |
| Workflow观察数据 | `src/workflows/workflow-stage.ts` |
| 实时事件 | `src/workflows/agent-session-log.ts`、`chat-run-events.ts` |
| Session前端投影 | `src/session-read-model.ts` |
| 完整历史 | `src/session-export.ts` |

新增Workflow时以[Chat Workflow开发框架](./chat-workflow-framework.md)为规范入口，并用本文核对当前实现事实。
