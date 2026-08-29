# Chat需求分析

## 1. 输入与范围

本文以三份事实为输入：

1. [Pi Agent设计与源码分析](./pi-agent-design.md)：Pi原生能力、接口和持久化边界。
2. [Pi Web架构与源码分析](./pi-web-design.md)：原网页产品如何消费Pi能力。
3. [Chat当前架构与源码分析](./chat-current-architecture.md)：当前Workflow、Session和浏览器调用链。

本文定义Chat需要解决什么，不提前规定最终配置文件字段。

## 2. 已确认的产品方向

1. Pi Web只作为Chat浏览器前端；Chat后端拥有Session、文件、认证、Workflow和Pi运行时。
2. Chat的核心是“同一会话中，用户每一轮可以选择一个Workflow执行”，不是选择Workflow就创建新Session。
3. Direct Workflow必须保持Pi Coding Agent原有会话语义：历史恢复、工具循环、压缩和持续交互不能退化成一次性问答。
4. Workflow可以包含多个Agent Stage；Stage之间的输入关系由Workflow定义。
5. 用户需要在实时界面和完整历史中看到`Workflow → Stage · Agent → 消息/Thinking/工具`，但观察数据不能破坏Pi Session上下文。
6. 不同Workflow中的Agent可能需要不同System Prompt、模型、Thinking、工具、Skill和Extension能力。
7. 常用Agent能力应先能由配置文件声明；当前前端负责选择配置文件和资源并检查解析结果，创建和编辑配置文件属于后续功能。
8. Pi Web现有页面能力后续仍要逐项接入，不能因为当前功能暂未使用就从界面或目标范围中永久删除。
9. Agent不是长期驻留对象。每次用户消息是一轮独立交互：Chat读取当前配置、恢复Pi Session上下文、创建本轮需要的AgentSession、完成执行并销毁运行对象。
10. 不定义“受限Agent”类型，也不默认禁止Extension。Planner、Pi Coding Agent或后续Agent都使用同一套能力配置机制；具体能力由配置值决定。
11. 当前系统没有管理员与普通用户角色，资源管理接口不基于不存在的角色模型设计。
12. Agent配置文件可以放在用户选择的任意授权路径，不要求进入Git仓库，也不由Chat复制到临时目录。前端提交文件路径和本轮资源选择，后端统一读取、合并和校验。
13. 每个Workflow先使用独立目录，集中放置该Workflow的代码、默认Agent配置和提示词资源，在物理结构上隔离。后续确有复用需要时再提取共享内容。
14. Agent的基础System Prompt和追加Prompt规则必须文件化，并能在Pi Web中查看、选择和预览。
15. Chat以Workflow作为一级管理对象。一个Workflow下面包含工作流定义、参与执行的Agent，以及该Workflow运行所需的配置、提示词、资源声明和适配代码；Agent是其中的实际执行单元和能力承载者。
16. Session独立于Workflow管理：同一个Session中可以逐轮切换Workflow，Workflow只决定本轮由哪些Agent以什么顺序处理消息。
17. Chat在Workflow内的Agent System Prompt中定义自己的自定义提示词区域；编码规范只是可加入该区域的一类提示词资源。

## 3. 运行逻辑

底层循环可以保持简单：

```text
用户发送一条消息
  ↓
Chat确定本轮Workflow
  ↓
读取本轮使用的Agent配置
  ↓
打开或创建同一个Chat Session
  ↓
按Workflow顺序为每个Stage创建AgentSession
  ├── 恢复Session上下文
  ├── 装配模型、Thinking、工具和资源
  ├── 执行这一Stage
  └── 销毁进程内AgentSession
  ↓
Pi Session保存需要延续到下一轮的对话事实
  ↓
下一条用户消息重新读取最新配置并重复以上过程
```

因此“可配置”不要求热修改一个正在运行的Agent对象。每个Workflow中的Agent都有一个持久默认配置；修改默认配置后，后续交互持续使用新值。用户也可以在某次交互中选择另一份配置文件，这一整轮Workflow使用被选择的配置。一个已经启动的Workflow应使用启动时读取到的同一份配置结果，避免Planner执行完后修改配置导致Executor突然使用另一套能力。

Chat需要维护的不是一个笼统“项目管理模块”，而是以下四类明确对象。其中Workflow是一级管理对象：

1. Workflow：拥有工作流描述、Stage顺序、Stage输入输出关系、Agent、配置、提示词、资源声明以及该Workflow使用的适配代码和测试。
2. Workflow Agent：作为具体执行单元，承载身份、基础Prompt、自定义提示词区域、模型、Thinking和所选资源。
3. Agent资源：Pi能够发现和加载的Model、Tool、Skill、Extension、Package和提示词文件；资源可以来自公共来源，但是否启用由Workflow内的Agent配置声明。
4. Session：独立保存连续对话上下文，并记录每轮实际选择的Workflow及其Agent执行过程。

Workflow是用户和开发者管理功能的入口；Agent是Workflow内部能力和配置的承载者。一个Workflow归拢完成该流程所需的业务内容，但不复制Chat平台和Pi已经提供的公共代码。

```text
Workflow（一级管理对象）
  ├── Workflow定义
  │     ├── Stage顺序
  │     └── Stage输入输出关系
  ├── Agent定义与配置
  │     ├── Prompt与自定义指令
  │     └── 选择公共或Workflow私有资源
  ├── Workflow专用基础设施
  │     ├── 配置解析与校验
  │     ├── Stage适配代码
  │     └── 测试
  └── 调用Chat和Pi公共运行能力

Chat Session（独立连续上下文）
  └── 每轮可选择不同Workflow执行
```

## 4. 核心用户场景

### 4.1 连续使用Pi Coding Agent

用户在一个Chat Session中连续选择直接执行Workflow。每一轮都应恢复同一Pi Session，并表现得像持续使用Pi Coding Agent：

- 能看到之前的用户、Assistant和Tool消息。
- Session保存的模型、Thinking和压缩状态能够正确恢复。
- Context Window接近限制时沿用Pi压缩机制。
- Workflow包装不改变模型实际收到的历史语义。

### 4.2 在同一Session切换Workflow

用户先直接执行，下一轮选择规划执行，再切回直接执行。Workflow变化只决定“下一轮如何处理”，不改变Chat Session身份。

完整历史要能说明每轮由哪个Workflow和Agent处理；后续模型上下文仍遵守Pi Session规则和Chat明确的Stage交接规则。

### 4.3 多Agent串行执行

规划执行包含Planner和Executor：

- Planner看到需要的历史与用户原话。
- Executor明确收到用户原话和Planner输出。
- 两个Agent可以使用不同能力。
- 内部Agent过程可观察、可审计。
- Planner身份不伪造成Provider原生的新消息Role。

### 4.4 定义一个Workflow中的Agent能力

Workflow开发者应能复用Pi原生装配点定义一个Agent Stage需要的能力，而不是每个Workflow手写一套ResourceLoader和AgentSession创建过程。

需要覆盖的能力类别至少包括：

| 能力类别 | 上游依据 | 需求问题 |
|---|---|---|
| Agent身份与说明 | Chat Workflow业务 | 前端和历史如何稳定显示 |
| Model策略 | Pi ModelRuntime与Session恢复 | 固定模型、继承Session或使用默认值如何选择 |
| Thinking策略 | Pi Thinking Level与Session Entry | 显式值和Session恢复怎样避免互相覆盖 |
| System Prompt | ResourceLoader与BuildSystemPrompt | 替换、追加和继承项目上下文的语义 |
| Tool集合 | `tools`、`excludeTools`、`noTools` | 内置、Custom和Extension Tool怎样组合 |
| Skill集合 | ResourceLoader | 继承、允许、排除与`read`依赖 |
| Extension集合 | ResourceLoader与ExtensionRunner | 资源来源、Agent启用范围和Extension参数 |
| Package来源 | Settings与PackageManager | 安装管理与Agent能力选择必须分开 |
| Compaction与Retry | SettingsManager、AgentSession | 哪些跟随Chat平台，哪些允许Agent覆盖 |
| Context Transform | Coding Agent SDK代码接口 | 只能引用后端注册逻辑，不能序列化函数 |

这张表是需求范围，不是`AgentConfig` Schema。

### 4.5 从前端查看和修改

前端最终需要：

1. 查询可用Workflow和每个Stage引用的Agent说明。
2. 查询Pi当前可用模型、工具、Skill、Extension和Package状态。
3. 为Workflow内的单个Agent选择主配置、追加配置、Prompt文件和Pi资源。
4. 得到后端校验错误、资源诊断和生效范围。
5. 明确区分“资源已安装”“当前Agent已启用”“当前Session正在使用”。
6. 查看Agent的基础System Prompt、默认追加规则和本轮临时选择的追加规则。
7. 按Plugin组或逐项选择Skill与Extension，并允许增加配置文件、Prompt文件或资源路径。

前端不接收或提交Tool函数、Credential或Session文件路径。配置文件和资源路径必须通过Chat已授权工作目录边界，并由后端再次校验和解析。

## 5. Chat控制的配置和Pi项目资源是什么关系

### 5.1 Pi原生的两层资源来源

当Chat调用`SettingsManager.create(cwd, agentDir)`和`DefaultResourceLoader`时，Pi会同时看到：

```text
Chat控制的agentDir
  ├── models.json / auth.json / settings.json
  ├── 全局Skill与Extension
  └── 全局Package

本轮目标cwd
  ├── .pi/settings.json
  ├── .pi/skills、.pi/extensions等项目资源
  ├── .agents/skills
  └── AGENTS.md等项目上下文
```

这里的“项目”只是Agent本轮工作的cwd和Pi项目级资源作用域，不需要创建新的Project业务对象或Project Store。

### 5.2 Chat需要控制什么

Chat已经控制了Session目录和Pi agentDir，下一步继续沿用这个逻辑：

1. 模型与认证继续由Chat指定的`.chat/agent`管理。
2. Workflow拥有默认Agent定义；用户可以为其中单个Agent选择外部主配置、追加配置和Prompt文件。
3. 资源列表、安装状态和解析结果通过Pi的ResourceLoader、SettingsManager和PackageManager获取，不复制一套资源扫描器。
4. 每次交互读取Agent配置，并用Pi公开接口创建本轮ResourceLoader和AgentSession。
5. cwd中的项目资源仍由Pi按原规则发现；Agent配置以`inherit`或`explicit`决定本轮继承全部资源，还是只使用选中的Skill、Extension和Plugin。

因此Chat做的是“Workflow管理 + Workflow内Agent配置 + 资源维护 + Session上下文”，不是整体项目管理。管理入口和目录边界是Workflow，实际运行由其中的Agent完成。

这里的基础设施分为两层：

| 层级 | 内容 | 归属 |
|---|---|---|
| Workflow相关代码 | Stage输入输出结构、配置解析、Prompt与资源声明、Agent装配、阶段适配和Workflow测试 | 对应Workflow目录 |
| 平台公共基础设施 | HTTP服务、认证、Session持久化、Workflow Runtime接入、事件协议、Pi运行时和公共资源发现 | Chat/Pi平台 |

每个Workflow只放自己的定义、Agent和相关代码，通过稳定接口使用公共基础设施，不重复实现HTTP、Session或Pi Runtime。

## 6. 功能边界

### 6.1 Chat应该拥有

- Workflow注册、描述、Stage顺序和Stage输入关系。
- Workflow内的Agent定义和Stage引用。
- Workflow内Agent的自定义提示词区域、能力声明、解析、校验和Pi对象装配。
- Chat Session选择和安全边界。
- Workflow/Stage/Agent观察数据与浏览器API。
- 前端修改配置时的输入校验、生效边界和错误处理。

### 6.2 Pi应该继续拥有

- Provider、Model和认证运行时。
- Agent循环和Tool执行。
- Coding Agent标准工具、压缩、重试和队列。
- Session JSONL结构、恢复和分支算法。
- ResourceLoader、Skill、Extension和Package原生机制。

### 6.3 Pi Web派生前端应该拥有

- Workflow和Agent能力的浏览器交互。
- 消息、Thinking、Tool、Session和文件的展示。
- 网络合同校验和用户可理解的失败反馈。
- PWA和移动端体验。

浏览器页面不拥有服务端事实，也不直接推导Pi资源目录。

## 7. 配置能力必须满足的语义

### 7.1 不把不同生命周期混成一张表

目标设计必须区分：

```text
平台级资源与安全策略
  ≠ Workflow定义
  ≠ Agent能力定义
  ≠ Workflow本次输入
  ≠ Pi Session中恢复的状态
  ≠ 前端显示偏好
```

例如Package安装属于平台资源；某Agent启用哪些Skill属于Agent能力；用户Prompt和上游Stage输出属于本次Workflow输入；模型切换是否写进Session属于对话状态。

Chat中的Agent配置是本轮运行事实源。默认配置可以引用Chat管理的默认模型；选择另一份配置文件时，本轮直接使用新文件中的模型、Thinking和资源设置。Pi Session中的模型记录不再与Agent配置竞争优先级，它只保留Pi原生Session兼容信息和历史证据。

### 7.2 配置只能表达可声明数据

配置文件可以表达模型标识、Thinking Level、工具名称、资源选择和数值策略。以下能力必须由后端代码注册，配置只能引用稳定ID：

- Context Transform。
- Tool `execute()`。
- Extension Factory和事件Handler。
- Provider Request Gate。
- Workflow Stage执行函数。

### 7.3 解析结果必须可检查

后端在创建AgentSession前应能给出解析结果或诊断，至少包括：

- 最终模型策略和Thinking策略。
- 活动工具与不存在的工具。
- 已发现、启用、禁用或冲突的Skill和Extension。
- System Prompt来源和项目上下文是否继承。
- 使用了哪些Settings默认值。

这样前端展示的是后端真实解析结果，而不是自己猜测配置会如何生效。

## 8. Session和运行要求

1. Workflow切换不得隐式更换Chat Session。
2. 标准用户、Assistant和Tool Result继续由Pi原生SessionManager保存。
3. Workflow观察数据使用Pi允许的扩展Entry，并保持不进入模型上下文。
4. Workflow上游输入是否进入后续模型必须由Stage输入规则明确决定。
5. 每个Stage重新创建AgentSession时，必须明确哪些状态从Pi Session恢复、哪些由Agent能力定义覆盖。
6. 自动重试不得重复已经产生文件修改或Session追加的Workflow Step；当前Agent Step保持`maxRetries = 0`，除非未来提供可证明安全的幂等机制。
7. 实时事件丢失后，前端必须能用Session持久历史和Run状态收敛。
8. 一次Workflow Run启动后固定使用本轮解析出的Agent配置；配置文件更新从下一条用户消息开始生效。

## 9. 安全和部署要求

1. Extension是可执行代码，Chat通过Pi原生加载机制使用它，不额外定义“受限Agent”或默认禁用规则。
2. Credential只保存在Chat后端受控的Pi agentDir中，不出现在配置响应、日志或Session观察数据。
3. Session ID只能解析到Chat自己的Session目录；cwd必须与Session头匹配。
4. Package安装、更新和删除属于资源维护；某个Agent是否使用其中资源属于Agent配置，两者不能混成一个开关。
5. 生产仍保持一个Chat服务；Pi和前端子模块由父仓库gitlink固定版本。
6. VS Code能从Chat入口调试Workflow，并通过Source Map进入Chat使用的Pi源码。

## 10. 当前缺口与优先顺序

| 优先级 | 缺口 | 原因 |
|---:|---|---|
| 1 | 没有后端Agent能力解析与装配边界 | 所有配置和前端能力都依赖它，当前逻辑散落在Workflow代码 |
| 2 | 没有Workflow描述/Stage/Agent查询事实源 | 前端只能硬编码两个Workflow名称 |
| 3 | 没有每Agent Skill和Extension选择语义 | 当前不同Stage只能使用代码里隐含的默认资源发现 |
| 4 | 模型、Thinking和工具选择未接Workflow路径 | 原Pi Web界面被禁用，不能表达用户或Agent策略 |
| 5 | Skills、Plugins、Extensions后端API未迁移 | 页面存在但Chat没有完整实现 |
| 6 | 运行中交互和Session分支未迁移 | 需要先决定持续运行控制面，不应塞进一次Run返回值 |

## 11. 已确认的配置场景

### 11.1 默认配置与本轮选择

每个Workflow Agent有一份默认配置。修改默认配置后，后续交互一直使用新配置。本轮在Pi Web中选择另一份配置文件时，只改变这次交互选择的配置来源，不修改默认配置。

Session继续提供上下文；模型、Thinking、System Prompt和资源集合由本轮选中的Agent配置决定。不存在Agent配置与Session模型状态之间的产品级优先级竞争。

### 11.2 Skill与Extension的来源和分组

Skill和Extension都允许配置多个文件或目录。Chat先通过Pi解析所有可用资源，再按来源提供分组：

1. Pi与Chat默认资源。
2. Chat agentDir中的全局资源。
3. 当前cwd中的项目资源。
4. Package提供的资源，按Package来源分组。
5. 用户新增的文件或目录，按配置来源或目录分组。

Pi Web既可以勾选整个分组，也可以勾选单个资源。默认组只是一个可见分组，组内资源仍然可以单独开关。目录是否进一步展开成子分组由实际资源数量决定，不改变后端配置语义。

Skill和Extension共用选择交互，但保持不同类型；Extension不会被隐式当作Skill，也不会因为某个Agent名称而默认禁止。

### 11.3 Workflow目录

第一版先按Workflow建立独立目录：

```text
workflows/<workflow-id>/
  ├── workflow定义与Stage代码
  ├── agents/
  │     └── 每个Agent的默认配置
  ├── prompts/
  │     └── 该Workflow使用的提示词文件
  ├── resources/
  │     └── Workflow私有资源声明或文件
  ├── infrastructure/
  │     └── 该Workflow专用的解析、装配和适配代码
  └── tests/
        └── Workflow、Stage和Agent装配测试
```

即使两个Workflow都使用Pi Coding Agent，也先各自在自己的目录中拥有明确配置。允许使用Chat/Pi公共基础设施和公共资源，但不为了复用提前打散Workflow目录，也不在Workflow内复制Session、HTTP服务或Pi Runtime。

### 11.4 Agent自定义提示词区域

需要明确区分：

| Chat配置项 | Pi机制 | 行为 |
|---|---|---|
| Agent基础提示词 | `SYSTEM.md`或`systemPromptOverride` | 替换Pi默认Coding Agent提示词；Planner等不同身份适用 |
| Agent自定义提示词区域 | Chat基于`appendSystemPromptOverride`组成 | 每次使用该Agent时进入System Prompt |
| 本轮勾选的提示词规则 | 加入本轮Agent自定义区域 | 只在当前用户交互中生效 |
| 项目规范 | `AGENTS.md` | 由当前cwd自动提供 |
| Pi Prompt Template | `/name`展开 | 形成User Message，不用于编码规范System Prompt |

Chat把Agent自定义提示词区域作为“Workflow内Agent配置”的一部分。该区域可以由多个文件组成，例如：

```text
Agent长期规则
+ Workflow内这个Agent需要的规则
+ 用户本轮选择的编码规范
+ 后续其他自定义提示词资源
```

“编码规范”只是其中一类。Pi Web按组和文件展示可选提示词；用户为本轮Pi Coding Agent勾选规则后，Chat读取对应文件并加入这个Agent的本轮有效配置。

按Pi当前源码，最终顺序是：

```text
Pi默认或Agent基础System Prompt
  ↓
Chat管理的Agent自定义提示词区域
  ├── Agent默认规则
  ├── Workflow中该Agent的规则
  └── 用户本轮勾选的规则
  ↓
AGENTS.md项目上下文
  ↓
Skill描述
  ↓
当前cwd
```

Chat给自定义区域加明确的结构标记，并把其中的多个规则按确定顺序组成，再交给Pi的`appendSystemPromptOverride`。例如最终文本可以包含：

```text
<chat_agent_custom_instructions>
...多个已选择提示词文件的内容...
</chat_agent_custom_instructions>
```

这是Chat的Agent配置扩展区，不修改Pi原生数据结构，同时保留Pi默认Prompt、项目上下文和Skill机制。
