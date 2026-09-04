# Chat Workflow开发框架

## 1. 目的

这份文档是新增或修改Chat Workflow时的规范入口。它规定源码目录、配置文件、节点类型、Pi Agent装配、`.chat`运行期配置和前端发现协议。

Chat不实现第二套Agent Runtime。Workflow负责业务编排，Agent节点继续使用Pi `AgentSession`，Tool继续使用Pi `ToolDefinition`和Extension/SDK注册接口。

Project、分层配置、Session分区和资源Target的现状见[Chat Project架构设计](./chat-project-framework.md)与[Chat Context与Resource Target模型](./chat-context-resource-model.md)。Workflow、Agent、Node和Pi装配合同不因资源归属变化而改变。

## 2. 配置与运行事实源

```text
源码内Workflow与Agent配置
  workflow.json / agent.json / Prompt / Skill / Extension
        ↓ Chat统一解析和校验
~/.chat/config.json + <project-root>/.chat/config.json
  Personal默认与Project覆盖
        ↓
当前Session中该Workflow的最新配置 + 本轮明确调整
        ↓ 解析文件并固定Prompt资源revision
本轮全部Agent的冻结定义
        ↓
Pi ResourceLoader + AgentSession
  实际加载和启用的Tool、Skill、Extension、Prompt与模型
        ↓ 浏览器安全投影
前端展示和编辑
```

这些职责不能互换：

1. 源码配置描述Chat内置Workflow的结构和默认能力。
2. Personal与Project配置只保存默认值和声明式覆盖，不保存函数或复制内置定义。
3. Session按Workflow保存最新配置，并为每轮保存固定revision的配置快照；同名Agent不跨Workflow共享状态。
4. Pi `AgentSession`是本轮实际生效能力的最终事实源。

浏览器不直接读取服务端目录或自行解析配置文件。前端通过Chat API读取Backend配置和Session事实；`localStorage`只允许暂存尚未发送的编辑，并且不能覆盖Backend返回的已提交状态。

## 3. 统一目录

一个Workflow是一级开发和管理单元；一个Agent是Workflow内部的二级单元：

```text
src/workflows/<workflow-id>/
  ├── index.ts                 # 唯一代码注册入口
  ├── workflow.json            # 名称、说明、节点和Agent配置路径
  ├── workflow.ts              # Workflow编排函数
  ├── steps.ts                 # 普通节点与Agent节点的执行代码
  ├── agents/
  │   └── <agent-id>/
  │       ├── agent.json       # Agent默认声明
  │       ├── SYSTEM.md        # 可选：替换基础System Prompt
  │       ├── instructions/    # 可选：追加规则
  │       ├── skills/          # 可选：Agent私有Pi Skills
  │       │   └── <skill>/SKILL.md
  │       ├── extensions/      # 可选：Agent私有Pi Extensions
  │       │   └── <extension>/
  │       │       ├── index.ts # Pi Extension入口，调用registerTool()
  │       │       └── tools/   # Extension内部的Tool源码组织
  │       └── runtime.ts       # 可选：需要Chat依赖注入的运行时装配
  └── tests/
```

`tools/`可以用于清晰组织源码，但Pi按Extension加载可执行文件。Agent配置应把`extensions/<extension>`传给Pi的`additionalExtensionPaths`，而不是让Chat扫描并执行任意`tools/`目录。

Chat个人Pi资源继续使用Pi原生Agent目录语义，但根目录由Chat Home提供：

```text
~/.chat/agent/extensions/
~/.chat/agent/skills/
~/.chat/agent/prompts/
```

Workflow私有资源不能为了方便复制到全局目录；它们由所属Agent配置显式引用。

## 4. 两种节点

Workflow框架只定义两种节点：

```ts
type ChatWorkflowNodeDefinition =
  | {
      kind: "agent";
      id: string;
      name: string;
      description: string;
      agentId: string;
    }
  | {
      kind: "task";
      id: string;
      name: string;
      description: string;
    };
```

### 4.1 Agent节点

Agent节点必须引用同一Workflow已经声明的Agent ID。框架负责：

1. 读取和合并Agent默认配置、Personal/Project默认、Session最新配置与本轮调整。
2. 解析相对于`agent.json`的Prompt、Skill和Extension路径。
3. 创建Pi `ResourceLoader`和`AgentSession`。
4. 应用Workflow私有且由代码提供的Context Transform或运行时Tool。
5. 为执行和前端检查返回同一份解析结果。

### 4.2 普通节点

普通节点执行确定性的应用代码，例如转换输入、调用领域服务或组成阶段结果。它没有Agent ID，也不能隐式创建Pi AgentSession。需要模型能力时必须显式改为Agent节点。

人工审核属于普通节点。Manifest使用`planReview: true`声明该Workflow采用通用计划审核合同。`planning-execution`使用`plan(agent) → review(task) → execute(agent)`，`planner-orchestrator`使用`plan(agent) → review(task) → delegate(agent)`；两者都通过Workflow SDK的耐久Hook挂起同一个Run。Planner输出携带`needs_clarification | ready_for_review`就绪状态：前者只能补充信息并回到Planner，后者才允许批准进入下游Agent。用户补充信息或要求修改时，原始需求、上一版完整文档和用户原文进入同一Planner Agent的新一轮调用；按钮批准被规范化为原生User Message，最终计划和该审核消息进入版本化下游任务书。

计划和审核话语以Pi原生MessageEntry保存在同一Session中；`chat.workflow_stage`保存审核节点身份，审核请求、决定、版本绑定和消息引用以追加CustomEntry保存。每个决定必须引用它对应的原生消息。`chat.workflow_agent_input`只能保存`inputEntryIds`，不得复制`userPrompt`或上游输出正文。Run控制面只保存`runId`、Invocation、Session和当前阶段的窄绑定。浏览器刷新只能断开并重连事件流，不能隐式取消等待审核的Run；只有显式停止操作可以取消。每个决定必须绑定`reviewId + planRevision + planSha256`，旧版本、重复冲突和跨Run提交必须失败关闭。

所有Workflow还必须通过[Session消息检查清单](./chat-session-architecture.md#9-新workflow检查清单)。

节点定义是可展示元数据；节点执行函数仍属于`workflow.ts`或`steps.ts`，不序列化进JSON。

## 5. Workflow组合入口

所有内置Workflow通过`defineChatWorkflow()`创建。这个函数只做框架级校验和标准化，不执行Workflow：

1. 校验Workflow、Node和Agent ID唯一。
2. 校验Agent节点引用的Agent存在。
3. 拒绝未被任何节点引用的Agent，除非未来明确增加辅助Agent语义。
4. 保存唯一的运行函数和可选Agent Session装配函数。
5. 产生浏览器安全的结构投影。

示例：

```ts
export const memoryWorkflowDefinition = defineChatWorkflow({
  manifest,
  agents: [MEMORY_AGENT],
  run: memoryWorkflow,
  prepareAgentSession: prepareMemoryAgentSession,
});
```

新增内置Workflow需要在中央组合入口注册一次。前端、HTTP解析和Agent配置页面不得增加该Workflow的专用分支。若未来内置Workflow数量使手工注册成为维护问题，可在构建期生成Registry；不在服务启动时动态执行任意目录中的代码。

## 6. 源码配置契约

### 6.1 workflow.json

```json
{
  "schemaVersion": 1,
  "id": "memory",
  "name": "长期记忆",
  "description": "由Memory Agent管理长期记忆。",
  "agentCallable": false,
  "planReview": false,
  "nodes": [
    {
      "kind": "agent",
      "id": "manage",
      "name": "管理记忆",
      "description": "查询、添加、更新或删除个人长期记忆。",
      "agentId": "memory-agent"
    }
  ],
  "agents": [
    {
      "id": "memory-agent",
      "config": "./agents/memory-agent/agent.json"
    }
  ]
}
```

`workflow.json`不包含`run`、Tool `execute()`或Context Transform等函数。`agentCallable`和`planReview`缺省都为`false`：前者是Agent能否通过`workflow_call`启动该Workflow的唯一显式资格门禁，后者表示该Workflow是否使用通用计划审核控制面。两者正交；审核型Workflow只要显式开放，也可以作为子Workflow并在自己的Session等待用户。

### 6.2 agent.json

```json
{
  "schemaVersion": 1,
  "id": "memory-agent",
  "name": "Memory Agent",
  "description": "管理个人长期记忆。",
  "systemPrompt": {
    "mode": "replace",
    "file": "./SYSTEM.md"
  },
  "customInstructions": [],
  "tools": {
    "mode": "explicit",
    "names": ["memory_list"],
    "exclude": [],
    "addresses": ["system:tool/memory_search"]
  },
  "resources": {
    "mode": "explicit",
    "skillPaths": ["./skills/memory"],
    "extensionPaths": [],
    "pluginSources": []
  }
}
```

配置只表达可声明数据。Tool实现、Extension Factory、Context Transform和领域服务实例必须由代码提供；配置通过稳定名称或路径引用它们。

## 7. 配置与Prompt资源

Chat首次准备Chat Home时创建Personal根配置；Project可以在源码目录保存Project覆盖：

```json
{
  "schemaVersion": 1,
  "defaultWorkflowId": "minimal-pi-coding-agent",
  "workflows": {
    "memory": {
      "agents": {
        "memory-agent": {
          "append": [],
          "promptFiles": []
        }
      }
    }
  }
}
```

规则：

1. 未出现的Workflow或Agent继承源码默认配置。
2. 合并后的Personal/Project配置是Workflow初始默认，不直接替代Session状态。
3. 运行顺序是“Workflow默认 → 当前Session中该Workflow的最新配置 → 本轮调整 → 冻结全部Agent定义”。
4. 一次Run启动后，所有Stage复用同一份已解析定义；配置文件和Prompt资源更新从下一次Run开始生效。
5. 默认配置写入采用完整Schema校验和原子替换，不允许前端修改未知字段。
6. 空的本轮Agent调整表示把该Agent恢复到Workflow默认；不会清除同一Workflow其他Agent的配置。
7. 未发送编辑只能保存在按`projectId + sessionId`隔离的浏览器草稿中；运行完成时只清除该次实际提交且期间未再次变化的内容。

规则与经验属于Agent自定义Prompt资源，按Target存储：

```text
~/.chat/prompt-resources                         # Personal
~/.chat/projects/<projectId>/prompt-resources   # 一个Project一个库
```

Agent选择使用`Target + resourceId`寻址。本轮快照固定具体revision；Draft与已确认资源分离，修改和归档追加revision而不覆盖历史。项目源码中的`<project-root>/.chat/prompts`是可移植的Pi Prompt文件，不是这套带Session来源和Draft生命周期的管理库。

Chat可随产品交付内置Personal经验。内置经验第一次访问Prompt资源库时以稳定ID归档为普通`experience`资源；已有同ID资源及其用户版本不会被覆盖。前端继续通过统一资源接口自动发现，用户选择后按同一路径进入Agent自定义System Prompt区域，不增加内置案例专用配置分支。

## 8. Tool定义与加载

只有Pi `ToolDefinition`是可执行Tool定义。Chat不复制`name`、参数Schema或`execute()`形成第二套Tool类型。

Tool有两种合法来源：

1. **Extension Tool**：Agent配置声明`extensionPaths`，Pi加载Extension并通过`registerTool()`注册。适合能从Pi `ExtensionContext`获得全部依赖的Tool。
2. **SDK Custom Tool**：Workflow运行时使用Pi `customTools`注入。适合需要Chat领域服务、Workflow Invocation ID等宿主依赖的Tool。

Chat系统内置Tool是第二种来源的公共管理形式：实现与严格Manifest归档在`src/tools/builtins/<tool-id>`，`ToolCatalog`负责发现和限定地址，`ToolResolver`在AgentSession创建时绑定Project、Session、Workflow、Invocation、Stage和Agent上下文。Project Tool继续使用Pi Extension的`registerTool()`，不增加第二套可执行Tool格式。

两种来源最终都进入同一个Pi AgentSession Tool Registry。前端从`session.getAllTools()`读取名称、参数Schema和`sourceInfo`，并结合`getActiveToolNames()`展示“已发现/已启用”，不得根据目录名猜测Tool。

`memory_search`和`memory_record`由Chat系统Tool Registry提供，可被其他Agent显式配置；Memory list/get/update/delete与Rule Curator Tool仍是Workflow私有能力。执行与Resolve共用公共AgentSession装配和各Workflow必要的私有`prepareAgentSession`扩展。

### 8.1 Workflow调用能力

Workflow调用按“Skill定义方法、Tool提供动作”实现。`workflow-delegation`是Coordinator使用的Pi Skill，规定获批计划不可变、自包含任务书、依赖分批、独立任务同轮并行、失败保留和汇总证据；`workflow_call`是通过`system:tool/workflow_call`统一解析并按Agent配置装配的Chat系统Tool，使用`describe | start | wait | cancel`四个操作完成一次调用的全生命周期。`describe`返回目标每个Child Agent可选的Tool/Skill准确名称；`start`接收目标Workflow ID、父Agent编写的Prompt、每个Child Agent的明确能力选择和可选等待窗口；`wait/cancel`只接收当前父Session已有的`callId`。

Tool必须从中央Registry取得目标，并校验`agentCallable`、最大深度和每父Session最多8个活跃调用；能力名称必须通过目标Workflow实际检查结果解析，不能直接接受模型提供的路径或地址。随后为目标预留独立Subsession，通过Pi `parentSession`记录不复制上下文的原生谱系，再由`startChatWorkflow()`运行完整Workflow。父Tool参数与Child冻结配置分别保留调用前后事实。等待超时只返回可恢复的`running`句柄，不取消子Run；后续等待和主动取消都通过Workflow Runtime公共Run API完成，并用父Session中的调用关系校验所有权。审核型Child在自己的Session等待人，批准后同一个子Run继续；相同Workflow定义允许创建新的子Session与子Run。Backend中断后通过同一Chat Session的新回合恢复旧`callId`，不假设本地Runtime自动续跑被杀死的Step。不能直接调用目标Agent、复用父Session并发写入、让前端维护可调用白名单，或把Workflow调用实现成第二套Agent Runtime。完整合同见[Chat Workflow调用Workflow设计](./chat-subworkflow-design.md)。

## 9. 后端与前端接口

```text
GET  /api/chat-config
PUT  /api/chat-config
GET  /api/workflows
GET  /api/workflows/:workflowId/agents/:agentId/catalog
POST /api/workflows/:workflowId/agents/:agentId/resolve
GET  /api/tools
PUT  /api/workflows/:workflowId/agents/:agentId/tool-config
DELETE /api/workflows/:workflowId/agents/:agentId/tool-config
GET  /api/prompt-resources
GET  /api/prompt-resources/drafts
GET  /api/prompt-resources/:resourceId/history
GET  /api/sessions/:sessionId/workflow-calls
DELETE /api/sessions/:parentSessionId/workflow-calls/:callId
```

职责：

1. `chat-config`按`projectId`返回Personal与可信Project配置的Backend合并投影；写入明确指定作用域。
2. `workflows`返回Workflow、Node、Agent和源码配置来源的浏览器安全投影。
3. `catalog`返回当前可发现资源，不伪造一次Agent配置来获取目录。
4. `resolve`使用与执行完全相同的装配路径，返回最终Prompt、Tool、Skill、Extension、模型和诊断。
5. `tools`返回当前Project可见Tool及Workflow Agent反向使用关系；`tool-config`只修改当前Project的Agent持久Tool策略。
6. Prompt资源HTTP接口只负责列表、搜索、草稿查看和历史读取；创建、修改、归档、Draft提交、Proposal应用与拒绝由Rule Management Workflow持续对话完成，不能增加绕过对象ID确认的写接口。
7. `workflow-calls`从Pi Session里的调用关系生成轻量调用树和统计；取消接口复用`workflow_call`的Runtime取消实现并校验父Session归属，前端不能直接控制子`runId`。

前端使用通用Workflow/Agent页面渲染这些数据。新增同类型资源不修改前端；只有框架新增资源类型或交互语义时才修改前端合同。

## 10. 新增Workflow检查表

1. 在`src/workflows/<id>/`创建`workflow.json`和`index.ts`。
2. 只使用`agent`或`task`节点。
3. 为每个Agent创建独立目录和`agent.json`。
4. Tool遵守Pi `ToolDefinition`；Skill使用真实`SKILL.md`。
5. 所有相对路径相对于声明它们的配置文件。
6. 通过`defineChatWorkflow()`创建定义，并在Registry注册一次。
7. 为Manifest校验、Agent解析、节点引用和实际AgentSession能力增加测试。
8. 验证`GET /api/workflows`、Catalog和Resolve无需前端专用代码即可显示。
9. 检查Builder单层转换和`LocalBuilder(dev=true)`完整Step产物；开发产物必须由Node实际装载，不能残留无法直接运行的本地源码依赖。
10. 运行`pnpm test:dev`，通过Frontend的Run合同验证`Workflow → Agent节点 → Pi SDK → 本地假模型 → completed`，并使用隔离的Build Dir与Chat Home。
11. 运行后端测试、前端测试、类型检查、生产构建和Built Server真实Workflow Run测试。
12. 验证Session配置隔离、本轮冻结、解析失败不落盘，以及刷新不覆盖未发送编辑。
13. 若声明`agentCallable: true`，验证子调用使用独立Pi父子Session、不复制父上下文、父Agent明确选择每个Child Agent能力，以及深度与取消门禁；若调用其他Workflow，必须通过Pi Skill + Tool，不直接调用目标Agent或Workflow函数。
