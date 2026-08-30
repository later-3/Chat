# Chat Workflow详细设计

## 1. 设计结论

Chat以Workflow作为一级管理对象。一个Workflow下面归拢它的定义、Agent和相关代码；Session是独立的连续对话，不归属于某个Workflow。

```text
Chat Session
  └── 每轮选择一个Workflow
        ├── Workflow定义和Stage关系
        ├── Agent定义与能力配置
        ├── Prompt和上下文适配
        └── Workflow专用测试
              ↓
            Chat/Pi公共运行能力
```

## 2. 统一落地目录

```text
src/workflows/
  ├── registry.ts
  ├── agent-config.ts
  ├── agent-config-loader.ts
  ├── agent-definition.ts
  ├── agent-inspection.ts
  ├── start-chat-workflow.ts
  ├── types.ts
  ├── minimal-pi-coding-agent/
  │     ├── index.ts
  │     ├── workflow.ts
  │     ├── step.ts
  │     ├── workflow.json
  │     └── agents/
  │           └── pi-coding-agent/
  │                 └── agent.json
  └── planning-execution/
        ├── index.ts
        ├── workflow.ts
        ├── steps.ts
        ├── context.ts
        ├── workflow.json
        └── agents/
              ├── planner/
              │     └── agent.json
              └── pi-coding-agent/
                    └── agent.json
```

Workflow根目录的`index.ts`是代码注册入口；`workflow.json`保存名称、说明、Node和Agent配置路径。`workflow.ts`只包含Vercel Workflow编排；`step.ts`或`steps.ts`包含Node与Pi运行代码，避免把Pi SDK引入Workflow纯函数环境。每个Agent拥有独立目录和`agent.json`，Prompt、Skill、Extension与运行时代码归档在该Agent目录中。

完整规范和新增Workflow检查表见[Chat Workflow开发框架](./chat-workflow-framework.md)。

## 3. 注册和启动

`registry.ts`是后端Workflow事实源：

1. `POST /runs`使用它校验Workflow ID。
2. `startChatWorkflow()`使用它取得实际Workflow函数。
3. `GET /api/workflows`使用它向前端返回Workflow、Stage和Agent说明。

新增Workflow不再修改HTTP解析和启动条件分支，只增加对应目录、通过`defineChatWorkflow()`创建定义并在中央组合入口注册一次。运行函数不会进入HTTP响应。

Workflow内部统一使用两种Node：`agent`节点引用一个已声明Agent；`task`节点执行普通应用代码且没有Agent ID。框架校验Node ID、Agent ID和引用关系，但不取代Vercel Workflow执行引擎。

## 4. Agent装配边界

Agent配置被分成两个明确模块：

- `agent-config.ts`：数据结构和严格Schema校验，不读取文件。
- `agent-config-loader.ts`：按顺序读取主配置、追加配置和Prompt文件，解析相对路径并合并。

当前已经实现并验证的能力：

| 能力 | 当前声明 |
|---|---|
| 身份 | ID、名称、说明 |
| 基础System Prompt | 使用Pi默认Prompt或完整替换 |
| Chat自定义指令 | 多段文本统一放入`chat_agent_custom_instructions`区域 |
| Model与Thinking | 继承Pi/Session结果，或由Agent配置显式指定 |
| 工具策略 | 使用Pi默认工具、不启用工具或按名称选择/排除 |
| 资源策略 | `inherit`继承Pi默认发现；`explicit`只加载选中的Skill、Extension和Plugin |

`createWorkflowAgentSession()`把上述声明转换为Pi的`SettingsManager`、`DefaultResourceLoader`和`createAgentSession()`参数。SessionManager仍由Workflow Stage显式传入，因此Planner可以使用内存副本，Executor和直接执行Agent可以使用持久Chat Session。

`createWorkflowAgentSession()`是执行与检查共用的唯一Pi装配入口。`agent-inspection.ts`创建不发送Prompt的内存AgentSession，并从真实ResourceLoader和AgentSession返回最终Prompt、Model、Thinking、Tools、Skill内容、Extension能力、Plugin资源和诊断；浏览器不自行推导生效结果。

## 5. 三个Workflow

### 5.1 直接执行

这个Workflow拥有一个`pi-coding-agent`和一个`execute` Stage。Agent继续使用Pi默认System Prompt、工具和项目资源，Workflow包装不改变Session上下文、压缩或工具循环。

### 5.2 Planning Execution

这个Workflow拥有：

1. `planner`：替换基础System Prompt，不启用工具，使用当前Chat Session的内存副本。
2. `pi-coding-agent`：保留Pi默认基础Prompt，在Chat自定义指令区域加入本Workflow执行规则。

`context.ts`负责把用户原话和Planner输出只注入Executor本次模型请求；过程证据继续使用Pi CustomEntry写入同一Chat Session。

### 5.3 Memory

Memory Workflow拥有一个`memory-agent`和一个Agent Node。Agent默认只启用6个Chat Memory Tool；Tool继续使用Pi `ToolDefinition`和`customTools`接口，`MemoryService`、Session ID和Workflow Invocation ID由该Agent的运行时装配函数注入。

Memory Skill以Agent目录中的真实`SKILL.md`作为源码事实源。开发运行时直接读取源码文件；生产构建把Markdown作为Nitro Server Asset打包，再物化到`.chat/memory/runtime/skills`供Pi按原生Skill路径读取。执行和检查共用同一装配函数。

## 6. `.chat`根配置

`.chat/config.json`保存默认Workflow和每个Workflow Agent的默认选择覆盖。后端严格解析并原子写入；前端通过`GET/PUT /api/chat-config`读取和修改同一文件，不直接访问文件系统。

一次运行的配置合并顺序是：

```text
源码内agent.json
  ↓
.chat/config.json默认选择
  ↓
本次HTTP请求选择
```

请求只覆盖同名Agent，其余Agent继续使用`.chat`默认选择。

## 7. 公共基础设施边界

以下公共代码不复制进每个Workflow目录：

- Chat Session打开、路径校验和持久化。
- Workflow Run事件协议和Agent事件投影。
- HTTP认证、路由和前端静态文件服务。
- Pi Agent循环、ResourceLoader、工具、压缩和Session JSONL。

Workflow通过公共接口使用这些能力。只有某个Workflow特有的Stage输入、上下文转换、Prompt和适配代码放在它自己的目录中。

## 8. 下一批实现

1. 在Pi Web中创建和编辑Agent配置文件；当前可以选择文件并把选择持久化到`.chat/config.json`。
2. 根据真实需求增加新的Workflow，并用普通Node验证非Agent阶段的前端展示和运行证据。
3. 补齐Skill更新检查、Skill更新和其他Pi Web迁移清单中的接口。
