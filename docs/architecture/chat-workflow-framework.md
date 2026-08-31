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

`workflow.json`不包含`run`、Tool `execute()`或Context Transform等函数。

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
    "names": ["memory_search", "memory_list"],
    "exclude": []
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

## 8. Tool定义与加载

只有Pi `ToolDefinition`是可执行Tool定义。Chat不复制`name`、参数Schema或`execute()`形成第二套Tool类型。

Tool有两种合法来源：

1. **Extension Tool**：Agent配置声明`extensionPaths`，Pi加载Extension并通过`registerTool()`注册。适合能从Pi `ExtensionContext`获得全部依赖的Tool。
2. **SDK Custom Tool**：Workflow运行时使用Pi `customTools`注入。适合需要Chat领域服务、Workflow Invocation ID等宿主依赖的Tool。

两种来源最终都进入同一个Pi AgentSession Tool Registry。前端从`session.getAllTools()`读取名称、参数Schema和`sourceInfo`，并结合`getActiveToolNames()`展示“已发现/已启用”，不得根据目录名猜测Tool。

Memory Tool需要`MemoryService`和Workflow调用上下文，因此继续使用Pi `customTools`是合法且更直接的依赖注入；Rule Curator Tool同样需要Prompt资源Store、当前Session和Invocation上下文。两者的源码归档在各自Agent目录，Skill使用真实`SKILL.md`文件，执行与Resolve共用相同的`prepareAgentSession`装配函数。

## 9. 后端与前端接口

```text
GET  /api/chat-config
PUT  /api/chat-config
GET  /api/workflows
GET  /api/workflows/:workflowId/agents/:agentId/catalog
POST /api/workflows/:workflowId/agents/:agentId/resolve
GET  /api/prompt-resources
GET  /api/prompt-resources/drafts
GET  /api/prompt-resources/:resourceId/history
```

职责：

1. `chat-config`按`projectId`返回Personal与可信Project配置的Backend合并投影；写入明确指定作用域。
2. `workflows`返回Workflow、Node、Agent和源码配置来源的浏览器安全投影。
3. `catalog`返回当前可发现资源，不伪造一次Agent配置来获取目录。
4. `resolve`使用与执行完全相同的装配路径，返回最终Prompt、Tool、Skill、Extension、模型和诊断。
5. Prompt资源HTTP接口只负责列表、搜索、草稿查看和历史读取；创建、修改、归档、Draft提交、Proposal应用与拒绝由Rule Management Workflow持续对话完成，不能增加绕过对象ID确认的写接口。

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
9. 运行后端测试、前端测试、类型检查、构建和Built Server测试。
10. 验证Session配置隔离、本轮冻结、解析失败不落盘，以及刷新不覆盖未发送编辑。
