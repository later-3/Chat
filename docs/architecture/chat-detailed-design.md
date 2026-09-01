# Chat Workflow详细设计

## 1. 设计结论

本文受[Chat Agent第一性原理与架构约束](./chat-agent-first-principles.md)约束。Chat以Workflow作为一级管理对象。一个Workflow下面归拢它的定义、Agent和相关代码；Session是独立的连续会话，不归属于某个Workflow，但保存每个Workflow在该Session中的最新配置和每次对话的配置快照。

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

## 2. 配置生命周期

每个Workflow为内部Agent提供初始默认配置。一次对话选择Workflow后，Chat从当前Session恢复该Workflow的最新配置；没有历史配置时才使用默认配置。本轮用户或管理Workflow做出的调整合并后冻结为本轮快照，执行完成后成为该Workflow在当前Session中的最新配置。

```text
Workflow默认配置
  ↓
Session中该Workflow的最新配置（如果存在）
  ↓
本轮调整
  ↓
不可变Turn配置快照
  ↓
Agent装配和Workflow执行
```

配置作用域固定为`Session → Workflow → Agent`。不同Workflow中的同名Agent不自动共享配置；手工调整和Agent辅助调整写入同一份Workflow配置。

## 3. 当前落地目录

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
  ├── planning-execution/
  │     ├── index.ts
  │     ├── workflow.ts
  │     ├── steps.ts
  │     ├── context.ts
  │     ├── workflow.json
  │     └── agents/
  │           ├── planner/
  │           │     └── agent.json
  │           └── pi-coding-agent/
  │                 └── agent.json
  ├── memory/
  │     ├── workflow.json
  │     └── agents/memory-agent/
  │           ├── agent.json
  │           ├── skills/memory/SKILL.md
  │           └── tools/
  └── rule-management/
        ├── workflow.json
        └── agents/rule-curator-agent/
              ├── agent.json
              ├── skills/rule-library/SKILL.md
              └── tools/
```

Workflow根目录的`index.ts`是代码注册入口；`workflow.json`保存名称、说明、Node和Agent配置路径。`workflow.ts`只包含Vercel Workflow编排；`step.ts`或`steps.ts`包含Node与Pi运行代码，避免把Pi SDK引入Workflow纯函数环境。每个Agent拥有独立目录和`agent.json`，Prompt、Skill、Extension与运行时代码归档在该Agent目录中。

完整规范和新增Workflow检查表见[Chat Workflow开发框架](./chat-workflow-framework.md)。

## 4. 注册和启动

`registry.ts`是后端Workflow事实源：

1. `POST /runs`使用它校验Workflow ID。
2. `startChatWorkflow()`使用它取得实际Workflow函数。
3. `GET /api/workflows`使用它向前端返回Workflow、Stage和Agent说明。

新增Workflow不再修改HTTP解析和启动条件分支，只增加对应目录、通过`defineChatWorkflow()`创建定义并在中央组合入口注册一次。运行函数不会进入HTTP响应。

Workflow内部统一使用两种Node：`agent`节点引用一个已声明Agent；`task`节点执行普通应用代码且没有Agent ID。框架校验Node ID、Agent ID和引用关系，但不取代Vercel Workflow执行引擎。

## 5. Agent装配边界

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

`createWorkflowAgentSession()`把上述声明转换为Pi的`SettingsManager`、`DefaultResourceLoader`和`createAgentSession()`参数。所有会说话的Workflow Agent都使用同一个持久Chat Session；Planner计划也作为原生Assistant消息保存。各Agent需要不同模型上下文时使用Stage级Context Transform，不复制或改写持久化话语角色。

`createWorkflowAgentSession()`是执行与检查共用的唯一Pi装配入口。`agent-inspection.ts`创建不发送Prompt的内存AgentSession，并从真实ResourceLoader和AgentSession返回最终Prompt、Model、Thinking、Tools、Skill内容、Extension能力、Plugin资源和诊断；浏览器不自行推导生效结果。

## 6. 四个Workflow

### 6.1 直接执行

这个Workflow拥有一个`pi-coding-agent`和一个`execute` Stage。Agent继续使用Pi默认System Prompt、工具和项目资源，Workflow包装不改变Session上下文、压缩或工具循环。

### 6.2 Planning Execution

这个Workflow拥有：

1. `planner`：替换基础System Prompt，默认只启用系统内置只读`memory_search`，在当前持久Chat Session中读取原生用户消息；先形成完整任务理解，再通过版本化输出契约声明`needs_clarification`或`ready_for_review`并写入原生Assistant消息。
2. `review`：普通Task Node，通过耐久Hook等待用户补充阻塞信息、要求修改或批准执行，不声明虚假的Agent ID；等待澄清时前后端都禁止批准。
3. `pi-coding-agent`：保留Pi默认基础Prompt，在Chat自定义指令区域加入本Workflow执行规则，并接收包含用户原话、批准版本、批准计划及执行契约的版本化任务书。

补充信息或拒绝后，同一Planner配置接收原始请求、上一版完整文档和原生用户消息，生成下一版并再次进入审核。Planner不得把开始执行前的需求澄清下放给Executor；能由工具调查的事实进入执行步骤，只有用户能决定的阻塞信息先在Review Task闭环。计划和审核话语使用Pi原生MessageEntry；按钮批准规范化为原生User Message。审核节点身份、就绪状态、阻塞问题、版本、摘要、决定和Agent输入来源使用CustomEntry，决定引用对应消息，输入来源只保存`inputEntryIds`。批准后Executor通过隐藏CustomMessage接收最终任务书，不重复写入原始用户请求，也不以隐藏交接取代审核消息。

### 6.3 Memory

Memory Workflow拥有一个`memory-agent`和一个Agent Node。`memory_search`与`memory_record`属于Chat系统内置Tool，可由任意Workflow Agent按限定地址加载；Memory Agent另外拥有list/get/update/delete四个管理Tool。所有Tool仍使用Pi `ToolDefinition`和`customTools`接口，`MemoryService`、Session、Workflow Invocation、Stage、Agent和Tool Call来源由Chat公共Tool Resolver注入。

Memory Skill以Agent目录中的真实`SKILL.md`作为源码事实源。开发运行时直接读取源码文件；生产构建把Markdown作为Nitro Server Asset打包，再物化到`~/.chat/runtime/skills/memory`供Pi按原生Skill路径读取。执行和检查共用同一装配函数。

### 6.4 Rule Management

Rule Management Workflow拥有一个`rule-curator-agent`和一个Agent Node。Agent通过统一`prepareAgentSession`装配自己的Skill和Prompt资源Custom Tools；Tool仍是Pi原生`ToolDefinition`，没有第二套Agent或Tool运行时。

规则只表达“什么场景下，目标Agent必须遵守什么”。`content`既可以直接保存完整约束，也可以要求目标Agent读取并遵守Project内一个稳定路径的设计或工程文档；后者不需要把长文档复制进规则库。设计文档由具备文件Tool的执行Agent维护，Rule Curator只负责将遵守要求保存为Prompt资源并应用到指定Workflow Agent。

资源创建、修改、归档、提交草稿、应用建议和拒绝建议均通过持续对话完成。所有确认短语绑定具体Draft或Proposal ID；浏览器读取资源、草稿、历史和Session中的待确认建议，但不直接执行变更。

## 7. 配置与资源存储

用户级默认配置保存在`~/.chat/config.json`，Project覆盖保存在`<project-root>/.chat/config.json`。后端严格解析并原子写入；前端通过带`projectId`的Chat API读取和修改合并投影，不直接访问文件系统。

一次运行的配置解析顺序是：

```text
Workflow源码内agent.json与默认选择
  ↓
当前Session中该Workflow的最新配置（如果存在）
  ↓
本轮实际调整
  ↓
解析并冻结所有Agent定义和Prompt资源revision
  ↓
写入本轮Session配置事实
```

请求只覆盖同名Agent，其余Agent沿用Session配置或Workflow默认。规则与经验按Target保存在Chat Home：个人资源位于`~/.chat/prompt-resources`，项目资源位于`~/.chat/projects/<projectId>/prompt-resources`。Project源码目录中的`.chat/prompts`继续表示可移植的Pi Prompt文件。

## 8. 公共基础设施边界

以下公共代码不复制进每个Workflow目录：

- Chat Session打开、路径校验和持久化。
- Workflow Run事件协议和Agent事件投影。
- HTTP认证、路由和前端静态文件服务。
- Pi Agent循环、ResourceLoader、工具、压缩和Session JSONL。

Workflow通过公共接口使用这些能力。只有某个Workflow特有的Stage输入、上下文转换、Prompt和适配代码放在它自己的目录中。

## 9. 已实现与下一批工作

已实现：

1. 按`Session → Workflow → Agent`持久化最新配置和本轮冻结快照。
2. 规则与经验Prompt资源目录、草稿、版本、来源、检索和归档。
3. Prompt资源进入Agent自定义System Prompt区域，并在Agent检查界面显示实际版本。
4. 规则管理Workflow、Rule Curator Agent、Workflow专用Skill和Chat Custom Tools。
5. Pi Web规则库、Agent规则选择、Agent建议来源和Session刷新恢复。
6. Chat Home、Project Manifest/Registry、ProjectContext和按Project分区的Session与Prompt资源。

下一批工作仍包括：在Pi Web中直接创建和编辑Agent配置文件、根据真实需求增加普通Task Node实例，以及补齐其他Pi Web迁移清单中的资源维护接口。
