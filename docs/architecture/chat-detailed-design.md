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

## 2. 当前落地目录

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
  │     └── agents/
  │           ├── pi-coding-agent.json
  │           └── pi-coding-agent.ts
  └── planning-execution/
        ├── index.ts
        ├── workflow.ts
        ├── steps.ts
        ├── context.ts
        └── agents/
              ├── planner.json
              ├── planner.ts
              ├── pi-coding-agent.json
              └── pi-coding-agent.ts
```

Workflow根目录的`index.ts`是注册入口，集中提供Workflow名称、说明、Stage、Agent和运行函数。`workflow.ts`只包含Vercel Workflow编排；`step.ts`或`steps.ts`包含Node与Pi运行代码，避免把Pi SDK引入Workflow纯函数环境。`agents/*.json`保存默认Agent定义；`context.ts`等文件是该Workflow使用的代码。

## 3. 注册和启动

`registry.ts`是后端Workflow事实源：

1. `POST /runs`使用它校验Workflow ID。
2. `startChatWorkflow()`使用它取得实际Workflow函数。
3. `GET /api/workflows`使用它向前端返回Workflow、Stage和Agent说明。

新增Workflow不再修改HTTP解析和启动条件分支，只增加对应目录并注册一次。运行函数不会进入HTTP响应。

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

## 5. 两个Workflow

### 5.1 直接执行

这个Workflow拥有一个`pi-coding-agent`和一个`execute` Stage。Agent继续使用Pi默认System Prompt、工具和项目资源，Workflow包装不改变Session上下文、压缩或工具循环。

### 5.2 Planning Execution

这个Workflow拥有：

1. `planner`：替换基础System Prompt，不启用工具，使用当前Chat Session的内存副本。
2. `pi-coding-agent`：保留Pi默认基础Prompt，在Chat自定义指令区域加入本Workflow执行规则。

`context.ts`负责把用户原话和Planner输出只注入Executor本次模型请求；过程证据继续使用Pi CustomEntry写入同一Chat Session。

## 6. 公共基础设施边界

以下公共代码不复制进每个Workflow目录：

- Chat Session打开、路径校验和持久化。
- Workflow Run事件协议和Agent事件投影。
- HTTP认证、路由和前端静态文件服务。
- Pi Agent循环、ResourceLoader、工具、压缩和Session JSONL。

Workflow通过公共接口使用这些能力。只有某个Workflow特有的Stage输入、上下文转换、Prompt和适配代码放在它自己的目录中。

## 7. 下一批实现

1. 在Pi Web中创建和编辑Agent配置文件；当前只选择用户已有文件。
2. 根据实际使用决定Agent配置选择是否需要跨浏览器刷新持久化。
3. 补齐Skill更新检查、Skill更新和其他Pi Web迁移清单中的接口。
