# Chat当前架构与源码分析

## 1. 目的和源码规模

本文只描述Chat当前已经实现的事实，不把目标方案写成现状。

当前Chat后端和Workflow位于`src/`：

| 类型 | 文件数 | 代码行 |
|---|---:|---:|
| Chat后端开发代码（`src/`，不含测试） | 70 | 4,854 |
| Chat后端与脚本测试 | 21 | 2,217 |
| Pi Web派生前端开发代码 | 106 | 35,307 |
| 前端合同与PWA测试 | 10 | 480 |

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
  ├── /api/files：受限文件读取
  ├── /api/workflows/.../agents/.../resolve：Agent实际装配结果
  └── /api/skills、/api/extensions、/api/plugins：Pi资源管理
          │
          ▼
Vercel Workflow Runtime
  ├── minimal-pi-coding-agent
  └── planning-execution
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
  ├── .chat/agent：模型、认证、Settings和全局资源
  └── .chat/sessions：Chat对话Session
```

生产部署只运行一个Chat进程。`frontend/dist`由Nitro提供，不再启动Pi Web Next.js服务。开发环境额外运行Vite，只提供页面热更新和到Chat的代理。

## 3. 浏览器到Workflow的调用链

当前浏览器发送一条普通文本消息时：

```text
useAgentSession.handleSend()
  ↓
POST /runs { cwd, prompt, sessionId?, workflow, agentConfigs? }
  ↓
startChatWorkflow()
  ↓
start(minimalPiCodingAgentWorkflow | planningExecutionWorkflow)
  ↓
立即返回runId
```

浏览器随后并行执行：

```text
GET /runs/:runId/events
  → NDJSON：stage_start + Pi AgentSession事件投影

GET /runs/:runId
  → 轮询running / completed / failed / cancelled
```

完成后，浏览器用返回的Session ID重新请求`GET /api/sessions/:id`，以Pi Session持久数据校正页面历史。

与原Pi Web相比，Chat没有长期驻留的`AgentSessionWrapper` Registry，也没有`/api/agent/:id`命令总线。每条用户消息启动一次Workflow Run；每个Agent Stage在自己的Step中创建和销毁AgentSession。

## 4. Workflow目录与选择机制

当前后端注册两个Workflow：

```text
minimal-pi-coding-agent
planning-execution
```

每个Workflow目录拥有自己的`index.ts`注册入口、`workflow.ts`编排定义、`step.ts`或`steps.ts`运行实现、`agents/`配置和专用上下文代码。编排文件不导入Node或Pi运行代码；Step才打开文件、Session和Pi SDK。`registry.ts`是后端唯一注册事实源：HTTP请求用它校验Workflow ID，`startChatWorkflow()`用它取得运行函数，`GET /api/workflows`用它返回Workflow、Stage和Agent定义。

Pi Web前端从`GET /api/workflows`读取选择项，不再维护支持的Workflow白名单。前端提交时只校验Workflow ID是非空字符串，后端注册表执行最终校验。

## 5. Chat Session

### 5.1 事实源

Chat只使用：

```text
Chat/.chat/sessions
```

`openChatSession()`负责：

1. 把cwd、agentDir和sessionDir解析为Chat目录下的绝对路径。
2. 没有Session ID时，用`SessionManager.create()`创建新Session。
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

1. 写入`workflow=planning-execution / stage=plan / agent=planner`标记和真实输入记录。
2. 使用`SessionManager.forkInMemory()`复制当前有效历史。这个副本不持久化，向它追加内容不会修改主Session。
3. 创建自己的SettingsManager和ResourceLoader，用`PLANNING_SYSTEM_PROMPT`替换默认System Prompt。
4. 用`noTools: "all"`创建AgentSession。
5. 调用`session.prompt(buildPlanningPrompt(userPrompt))`。
6. 从Planner最后一条Assistant消息提取计划。
7. 把完整Planner Assistant消息作为Chat CustomEntry写回主Session，用于完整历史展示，但不进入Pi模型上下文。

Planner能看到创建副本时主Session已有的有效历史。它本轮包装后的规划Prompt和Planner回复只存在于内存副本；主Session保存的是Chat自己的输入证据和Planner消息副本。

当前Planner仍会创建默认ResourceLoader并加载Extension；`noTools: "all"`只关闭工具，不等于`noExtensions: true`。因为没有`read`工具，已发现Skill不会进入Planner System Prompt，但Extension代码仍可能参与生命周期。这只是当前Planner的具体配置，不代表Chat存在“受限Agent”类型，也不构成后续默认禁止Extension的理由。

### 7.2 Executor Stage

Executor重新按Session ID打开主Session，然后：

1. 写入`stage=execute / agent=pi-coding-agent`标记。
2. 写入本Stage的用户原话以及Planner输出来源记录。
3. 创建ResourceLoader，在Pi默认System Prompt后追加执行规则。
4. 通过`transformContext`在本次Provider请求中插入隐藏Custom Message：

```text
workflow_execution_input
  ├── userRequest：用户原话
  └── plannerOutput：Planner输出
```

5. 调用`session.prompt(userPrompt)`，让Pi正常持久化用户消息、Assistant消息和工具结果。

Pi的`convertToLlm()`会把这个`role: "custom"`的本次输入转换为Provider可理解的User Message。因为它来自`transformContext`，不会写入标准Session消息；Chat另外用CustomEntry保存真实输入链供完整历史检查。

### 7.3 为什么主Session里不直接保存Planner为Assistant

Pi当前Provider上下文使用`user / assistant / toolResult`角色，没有多个Assistant身份协议。若把Planner的Assistant消息直接插进主对话，下一轮Pi Coding Agent会把它当成自己的历史回复。

当前实现因此分开两件事：

- 模型上下文：Executor只在本次调用中收到结构化Planner输入。
- 过程观察：主Session的CustomEntry保存Workflow、Stage、Agent、输入和Planner完整消息。

这是Chat业务语义，建立在Pi原生CustomEntry和Context Transform扩展点上，没有修改Pi标准Session消息Schema。

## 8. Workflow事件与完整历史

### 8.1 实时事件

`subscribeAgentSessionLog()`订阅每个AgentSession，`createChatRunEventPublisher()`把事件写入Workflow Run的NDJSON流。事件外层增加：

```text
workflowId + stageId + agentId
```

浏览器因此可以区分Planner与Pi Coding Agent，同时复用Pi Web原来的消息、Thinking和Tool渲染器。

实时流只投影浏览器需要的字段，不是永久历史。

### 8.2 Session观察数据

Chat使用Pi原生`CustomEntry`保存三类不进入模型上下文的数据：

| customType | 内容 | 用途 |
|---|---|---|
| `chat.workflow_stage` | Workflow、Stage和Agent身份 | 划分执行阶段 |
| `chat.workflow_agent_input` | 用户原话和上游Stage输出 | 说明每个Agent实际收到什么 |
| `chat.workflow_message` | Planner完整Assistant消息 | 展示内部Agent的Thinking和输出 |

`session-read-model.ts`负责把Pi标准消息和Chat观察数据投影成前端历史；`session-export.ts`生成按Workflow、Stage和Agent整理的完整历史。

## 9. 当前能力配置在哪里

当前每个Workflow已经拥有自己的Agent JSON配置，并通过公共解析和装配代码转换为Pi运行对象：

| Agent Stage | 当前能力来源 |
|---|---|
| Direct的Pi Coding Agent | Workflow目录内`agents/pi-coding-agent.json` + Chat `.chat/agent` Settings/模型/资源 |
| Planner | Workflow目录内`agents/planner.json`定义替换System Prompt和无工具策略 |
| Planning Executor | Workflow目录内`agents/pi-coding-agent.json`定义Chat自定义指令；`context.ts`实现不可序列化的Context Transform |

`agent-definition.ts`当前只实现身份、基础System Prompt、Chat自定义指令区域和工具策略；它严格解析JSON，并集中创建SettingsManager、ResourceLoader和AgentSession。`GET /api/workflows`已经可以查询当前Workflow、Stage和Agent定义。

模型、Thinking、Skill、Extension和提示词文件选择尚未进入配置解析与运行路径；当前JSON是随Workflow代码构建的默认配置，还没有运行时修改和写回接口。

## 10. 当前边界问题

这部分只指出源码事实，不在这里直接给最终重构方案。

1. Agent默认配置已有严格解析，但还没有运行时配置存储、更新API和生效快照。
2. 模型、Thinking和具体工具选择尚未接入Workflow Agent配置。
3. Skill、Extension和Package页面仍在前端，但Chat缺少对应完整API和每Agent选择语义。
4. 当前不同Agent仍继承Pi默认资源发现，Planner也会加载Extension代码；这不是限制策略，只是选择功能尚未实现。
5. Context Transform仍由Workflow代码注册；后续配置只能引用稳定实现ID，不能序列化函数。
6. 运行中Steering、Follow-up、Extension交互式UI和Session Fork依赖持续运行控制面，当前一次一Run的接口尚未支持。

## 11. 源码证据索引

| 结论 | 源码 |
|---|---|
| 浏览器Workflow调用 | `frontend/lib/chat-workflow-browser.ts`、`frontend/hooks/useAgentSession.ts` |
| HTTP输入和Workflow选择 | `src/run-request.ts`、`src/routes/runs.post.ts`、`src/workflows/registry.ts`、`start-chat-workflow.ts` |
| Chat Session所有权 | `src/chat-session.ts` |
| 直接执行 | `src/workflows/minimal-pi-coding-agent/` |
| Planner与Executor | `src/workflows/planning-execution/` |
| Agent配置与装配 | `src/workflows/agent-definition.ts`、各Workflow目录的`agents/*.json` |
| Workflow观察数据 | `src/workflows/workflow-stage.ts` |
| 实时事件 | `src/workflows/agent-session-log.ts`、`chat-run-events.ts` |
| Session前端投影 | `src/session-read-model.ts` |
| 完整历史 | `src/session-export.ts` |

下一步用本文现状与两份上游分析形成Chat需求，不从当前代码形状直接推出目标Schema。
