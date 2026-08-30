# Chat Workflow开发框架

## 1. 目的

这份文档是新增或修改Chat Workflow时的规范入口。它规定源码目录、配置文件、节点类型、Pi Agent装配、`.chat`运行期配置和前端发现协议。

Chat不实现第二套Agent Runtime。Workflow负责业务编排，Agent节点继续使用Pi `AgentSession`，Tool继续使用Pi `ToolDefinition`和Extension/SDK注册接口。

## 2. 三层事实源

```text
源码内Workflow与Agent配置
  workflow.json / agent.json / Prompt / Skill / Extension
        ↓ Chat统一解析和校验
.chat/config.json
  用户选择的默认Workflow和每个Agent的配置覆盖
        ↓ 合并为本轮声明
Pi ResourceLoader + AgentSession
  实际加载和启用的Tool、Skill、Extension、Prompt与模型
        ↓ 浏览器安全投影
前端展示和编辑
```

三层职责不能互换：

1. 源码配置描述Chat内置Workflow的结构和默认能力。
2. `.chat/config.json`只保存运行期默认值和用户覆盖，不保存函数或复制内置定义。
3. Pi `AgentSession`是本轮实际生效能力的最终事实源。

浏览器不直接读取服务端目录或自行解析配置文件。前端和后端“使用同一份配置”是指前端通过Chat API读取、修改后端管理的同一份`.chat/config.json`，而不是维护一份前端副本或实现第二个解析器。

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

Chat全局Pi资源继续使用Pi原生目录：

```text
.chat/agent/extensions/
.chat/agent/skills/
.chat/agent/prompts/
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

1. 读取和合并Agent默认配置、`.chat`默认覆盖与本次请求覆盖。
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

## 7. `.chat/config.json`

Chat首次准备数据目录时创建根配置：

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
2. `.chat`中的选择是后续运行默认值；本次HTTP请求可以提供临时覆盖。
3. 合并顺序是“源码默认 → `.chat`默认覆盖 → 本次请求覆盖”。
4. 一次Run启动后冻结合并结果；文件更新从下一次Run开始生效。
5. 写入采用完整Schema校验和原子替换，不允许前端修改未知字段。
6. 删除一个覆盖项等于恢复源码默认，不删除源码配置。

## 8. Tool定义与加载

只有Pi `ToolDefinition`是可执行Tool定义。Chat不复制`name`、参数Schema或`execute()`形成第二套Tool类型。

Tool有两种合法来源：

1. **Extension Tool**：Agent配置声明`extensionPaths`，Pi加载Extension并通过`registerTool()`注册。适合能从Pi `ExtensionContext`获得全部依赖的Tool。
2. **SDK Custom Tool**：Workflow运行时使用Pi `customTools`注入。适合需要Chat领域服务、Workflow Invocation ID等宿主依赖的Tool。

两种来源最终都进入同一个Pi AgentSession Tool Registry。前端从`session.getAllTools()`读取名称、参数Schema和`sourceInfo`，并结合`getActiveToolNames()`展示“已发现/已启用”，不得根据目录名猜测Tool。

Memory Tool需要`MemoryService`和Workflow调用上下文，因此继续使用Pi `customTools`是合法且更直接的依赖注入；它的源码仍归档到Memory Agent目录，Skill则使用真实`SKILL.md`文件。

## 9. 后端与前端接口

```text
GET  /api/chat-config
PUT  /api/chat-config
GET  /api/workflows
GET  /api/workflows/:workflowId/agents/:agentId/catalog
POST /api/workflows/:workflowId/agents/:agentId/resolve
```

职责：

1. `chat-config`读取或更新同一份`.chat/config.json`。
2. `workflows`返回Workflow、Node、Agent和源码配置来源的浏览器安全投影。
3. `catalog`返回当前可发现资源，不伪造一次Agent配置来获取目录。
4. `resolve`使用与执行完全相同的装配路径，返回最终Prompt、Tool、Skill、Extension、模型和诊断。

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
