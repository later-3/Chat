# Chat需求分析

## 1. 输入与范围

本文受[Chat Agent第一性原理与架构约束](./chat-agent-first-principles.md)约束，并以三份源码事实为输入：

1. [Pi Agent设计与源码分析](./pi-agent-design.md)：Pi原生能力、接口和持久化边界。
2. [Pi Web架构与源码分析](./pi-web-design.md)：原网页产品如何消费Pi能力。
3. [Chat当前架构与源码分析](./chat-current-architecture.md)：当前Workflow、Session和浏览器调用链。

Project目标结构另见[Chat Project架构设计](./chat-project-framework.md)。该设计直接参考Pi的用户级/项目级配置、资源、Session分区和Project Trust，再加入Chat的稳定Project身份、Workflow和Memory场景。

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
15. 在执行功能维度，Chat以Workflow作为一级管理对象。一个Workflow下面包含工作流定义、参与执行的Agent，以及该Workflow运行所需的配置、提示词、资源声明和适配代码；Agent是其中的实际执行单元和能力承载者。
16. Session独立于Workflow管理：同一个Session中可以逐轮切换Workflow，Workflow只决定本轮由哪些Agent以什么顺序处理消息。
17. Chat在Workflow内的Agent System Prompt中定义自己的自定义提示词区域；编码规范只是可加入该区域的一类提示词资源。
18. Chat需要正式管理Project。Project表示用户长期使用Chat维护的外部项目，源码保持原位，不复制到Chat仓库。
19. Chat默认使用`~/.chat`保存用户级配置、Credential、Memory、Project Registry和按Project分区的Session；每个Project使用自己的`.chat`目录保存Project Manifest、配置和项目资源。
20. Project使用稳定`projectId`，绝对路径只属于本机Registry；项目移动不能改变Session和Memory归属。
21. Project和Workflow是正交管理入口：Project决定工作目录、项目配置和资源作用域，Workflow决定本轮执行结构。
22. 打开Project不等于信任Project。项目级配置、Skill和Extension必须遵守参考Pi Project Trust定义的显式信任边界。
23. 每个Workflow拥有自己的Agent默认配置；Session按Workflow保存最新配置。一次对话没有调整时沿用该Workflow的上次配置，有调整时冻结本轮快照并把结果保存为该Workflow的新配置。
24. 同名或同实现的Agent出现在不同Workflow中时不自动共享配置；需要复用的是公共实现和Agent装配机制，不是隐含运行状态。

## 3. 运行逻辑

底层循环可以保持简单：

```text
用户发送一条消息
  ↓
Chat确定本轮Workflow
  ↓
读取当前Session中该Workflow的最新配置；不存在时读取Workflow默认配置
  ↓
应用本轮调整并冻结配置快照
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

因此“可配置”不要求热修改一个正在运行的Agent对象。每个Workflow中的Agent都有初始默认配置；Session保存该Workflow最近一次对话使用的配置。用户在某次对话中选择另一份配置文件或调整资源后，本轮使用冻结结果，完成后它成为该Workflow在当前Session中的最新配置；下一次没有调整就继续沿用。一个已经启动的Workflow始终使用启动时冻结的配置快照，避免Planner执行完后修改配置导致Executor突然使用另一套能力。

Chat需要维护以下五类明确对象。Project是工作空间入口，Workflow是本轮执行入口，两者不存在包含关系：

1. Project：拥有稳定身份、本机路径、Project配置、Project资源、Session集合和Project Memory命名空间。
2. Workflow：拥有工作流描述、Stage顺序、Stage输入输出关系、Agent、配置、提示词、资源声明以及该Workflow使用的适配代码和测试。
3. Workflow Agent：作为具体执行单元，承载身份、基础Prompt、自定义提示词区域、模型、Thinking和所选资源。
4. Agent资源：Pi能够发现和加载的Model、Tool、Skill、Extension、Package和提示词文件；资源可以来自用户级、Project级或Workflow私有来源，但是否启用由Workflow内的Agent配置声明。
5. Session：属于一个Project，独立保存连续对话上下文，并记录每轮实际选择的Workflow及其Agent执行过程。

Project是用户切换工作对象的入口；Workflow是用户和开发者管理执行功能的入口；Agent是Workflow内部能力和配置的承载者。一个Workflow归拢完成该流程所需的业务内容，但不复制Chat平台和Pi已经提供的公共代码。

```text
Project（工作空间入口）
  ├── Project Manifest与本机路径登记
  ├── Project配置和资源
  ├── Project Session集合
  └── Project Memory命名空间

Workflow（一级执行管理对象）
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
  ├── 属于一个Project
  ├── 每轮可选择不同Workflow执行
  ├── 保存每个Workflow的最新配置
  └── 保存每次对话的配置和执行快照
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

### 4.6 打开和切换Project

用户在Pi Web中选择`ziji-content-lab`目录后，Chat需要：

1. 用户明确选择的目录就是Project根；只读取或创建该目录的`.chat/project.json`，不向父目录或子目录发现Project。
2. 把规范化绝对路径登记到Project Registry，而不是把路径本身当作Project ID。
3. 即使Project还没有Session，也能在重启后的项目切换器中显示。
4. 切换Project时同时切换cwd、Session列表、Project配置、项目资源、文件访问和Project Memory范围。
5. 保持项目源码位于原目录；Chat只管理配置、索引和运行数据。
6. `A`和`A/B/C`可以分别是独立Project；目录嵌套、Git根目录和父目录Manifest都不改变用户本次选择的Project根。

## 5. Chat全局、Project配置和Pi资源是什么关系

### 5.1 Pi提供的原生分层

当Chat调用`SettingsManager.create(cwd, agentDir)`和`DefaultResourceLoader`时，Pi会同时看到：

```text
Pi用户级agentDir
  ├── models.json / auth.json / settings.json
  ├── 全局Skill与Extension
  └── 全局Package

Pi本轮目标cwd
  ├── .pi/settings.json
  ├── .pi/skills、.pi/extensions等项目资源
  ├── .agents/skills
  └── AGENTS.md等项目上下文
```

Pi以cwd作为项目资源和Session分区依据。Chat保留这套资源与执行语义，但浏览器长期项目管理还需要稳定Project ID、项目简介、路径迁移和Memory命名空间，因此Chat必须增加Project业务对象，不能继续让cwd同时承担路径与长期身份。

### 5.2 Chat采用的对应分层

Chat直接参考Pi的形状：

```text
~/.chat/agent
  ├── Credential、Model和用户级Settings
  └── 用户级Skill、Extension和Prompt

<project-root>/.chat
  ├── project.json与Project配置
  └── Project级Skill、Extension、Prompt和Instructions

~/.chat/projects/<projectId>/sessions
  └── Pi Session JSONL
```

Chat需要控制：

1. 模型与认证由`~/.chat/agent`管理，不再依赖Chat源码仓库的工作目录。
2. Workflow拥有默认Agent定义；用户可以为其中单个Agent选择外部主配置、追加配置和Prompt文件。
3. 资源列表、安装状态和解析结果通过Pi的ResourceLoader、SettingsManager和PackageManager获取，不复制一套资源扫描器。
4. 每次交互读取Agent配置，并用Pi公开接口创建本轮ResourceLoader和AgentSession。
5. Project`.chat`资源经过路径校验和Project Trust后交给Pi公开加载接口；Tool最终仍由Pi Extension或SDK注册。
6. cwd中的Pi原生`.pi`和`.agents/skills`资源可以继续由Pi发现，Chat前端必须展示真实来源，不将其伪装成Chat Project资源。
7. Agent配置以`inherit`或`explicit`决定本轮继承全部可信资源，还是只使用选中的Skill、Extension和Plugin。

因此Chat做的是“Project管理 + Workflow管理 + Workflow内Agent配置 + 资源维护 + Session上下文”。Project不取代Workflow，Workflow也不负责发现或持久化Project。

这里的基础设施分为三层：

| 层级 | 内容 | 归属 |
|---|---|---|
| Project公共基础设施 | Project Manifest、Registry、ProjectContext、Session分区和信任 | Chat平台 |
| Workflow相关代码 | Stage输入输出结构、配置解析、Prompt与资源声明、Agent装配、阶段适配和Workflow测试 | 对应Workflow目录 |
| 平台公共基础设施 | HTTP服务、认证、Session持久化、Workflow Runtime接入、事件协议、Pi运行时和公共资源发现 | Chat/Pi平台 |

每个Workflow只放自己的定义、Agent和相关代码，通过稳定接口使用公共基础设施，不重复实现HTTP、Session或Pi Runtime。

## 6. 功能边界

### 6.1 Chat应该拥有

- Project Manifest、Project Registry和统一`ChatProjectContext`。
- 用户级`~/.chat`与Project本地`.chat`配置的读取、合并、校验和安全投影。
- Project切换、Project Trust和按Project划分的Session目录。
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

- Project发现、打开、不可用状态和切换交互。
- Workflow和Agent能力的浏览器交互。
- 消息、Thinking、Tool、Session和文件的展示。
- 网络合同校验和用户可理解的失败反馈。
- PWA和移动端体验。

浏览器页面不拥有服务端事实，也不直接推导Pi资源目录。浏览器对`~/.chat/config.json`和Project`.chat/config.json`的读取与修改必须经过Chat API；前后端使用同一配置事实源，但只有后端实现文件解析、信任判断和路径授权。

## 7. 配置能力必须满足的语义

### 7.1 不把不同生命周期混成一张表

目标设计必须区分：

```text
平台级资源与安全策略
  ≠ Project身份与本机路径
  ≠ Project配置和资源
  ≠ Workflow定义
  ≠ Agent能力定义
  ≠ Workflow本次输入
  ≠ Pi Session中恢复的状态
  ≠ 前端显示偏好
```

例如Package安装属于平台资源；某Agent启用哪些Skill属于Agent能力；用户Prompt和上游Stage输出属于本次Workflow输入；模型切换是否写进Session属于对话状态。

Chat本轮冻结的Workflow Agent配置是运行事实源。配置按`Workflow默认配置 → Session中该Workflow最新配置 → 本轮调整`解析；选择另一份配置文件时，本轮直接使用新文件中的模型、Thinking和资源设置，并在完成后成为该Workflow的新Session配置。Pi Session中的模型记录不再与Agent配置竞争产品优先级，它只保留Pi原生Session兼容信息和历史证据。

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

1. Session必须属于一个稳定Project；Session目录不能由浏览器路径直接决定。
2. Workflow切换不得隐式更换Chat Session。
3. 标准用户、Assistant和Tool Result继续由Pi原生SessionManager保存。
4. Workflow观察数据使用Pi允许的扩展Entry，并保持不进入模型上下文。
5. Workflow上游输入是否进入后续模型必须由Stage输入规则明确决定。
6. 每个Stage重新创建AgentSession时，必须明确哪些状态从Pi Session恢复、哪些由Agent能力定义覆盖。
7. 自动重试不得重复已经产生文件修改或Session追加的Workflow Step；当前Agent Step保持`maxRetries = 0`，除非未来提供可证明安全的幂等机制。
8. 实时事件丢失后，前端必须能用Session持久历史和Run状态收敛。
9. 一次Workflow Run启动后固定使用本轮解析出的全局配置、Project配置和请求覆盖；文件更新从下一条用户消息开始生效。
10. Project路径迁移只更新Registry路径，不能改变Session与Memory归属。

## 9. 安全和部署要求

1. Extension是可执行代码，Chat通过Pi原生加载机制使用它，不额外定义“受限Agent”或默认禁用规则。
2. Project出现于Registry不代表受信任；参考Pi Project Trust，在信任前不得应用项目能力配置或执行Project Extension。
3. Credential只保存在Chat后端受控的`~/.chat/agent`中，不出现在配置响应、日志或Session观察数据。
4. Session ID只能解析到对应Project的Chat Session目录；cwd必须与Registry登记和Session头匹配。
5. Package安装、更新和删除属于资源维护；某个Agent是否使用其中资源属于Agent配置，两者不能混成一个开关。
6. 生产仍保持一个Chat服务；Pi和前端子模块由父仓库gitlink固定版本。
7. VS Code能从Chat入口调试Workflow，并通过Source Map进入Chat使用的Pi源码。

## 10. 当前缺口与已完成能力

| 优先级 | 缺口 | 原因 |
|---:|---|---|
| 已完成 | Backend持久化Session Workflow最新配置和本轮快照 | 刷新、手工选择和Agent辅助调整使用同一事实源 |
| 已完成 | Chat Home、Project Manifest/Registry和ProjectContext | Project路径、配置、Session、Memory和Prompt资源由稳定`projectId`解析 |
| 已完成 | 个人与项目Prompt资源及规则管理Workflow | 已覆盖Target、来源、标签、草稿、绑定确认、版本、归档、检索和Agent选择 |
| 1 | Agent配置文件只能选择，尚不能在前端创建和编辑 | 当前默认选择已持久化，但文件内容编辑仍需外部工具 |
| 2 | 普通Node已有Schema和校验，但尚无内置Workflow实例 | 需要在真实需求出现时验证展示和观察数据，不为示例增加空业务 |
| 3 | 资源管理接口尚未全部迁移 | Skill更新检查及部分原Pi Web操作仍待接入 |
| 4 | 运行中交互和Session分支未迁移 | 需要先决定持续运行控制面，不应塞进一次Run返回值 |

## 11. 已确认的配置场景

### 11.1 默认配置与本轮选择

每个Workflow Agent有一份初始默认配置。第一次使用该Workflow时从默认配置开始；之后优先读取当前Session中该Workflow的最新配置。本轮在Pi Web中选择另一份配置文件时，不修改Workflow默认文件，但会形成新的本轮快照，并在完成后成为该Workflow在当前Session中的最新选择，直到用户再次调整。

Session继续提供上下文；模型、Thinking、System Prompt和资源集合由本轮选中的Agent配置决定。不存在Agent配置与Session模型状态之间的产品级优先级竞争。

### 11.2 Skill与Extension的来源和分组

Skill和Extension都允许配置多个文件或目录。Chat先通过Pi解析所有可用资源，再按来源提供分组：

1. Pi与Chat默认资源。
2. `~/.chat/agent`中的用户级资源。
3. 当前Project`.chat`中的Chat Project资源。
4. 当前cwd中的Pi原生`.pi`与`.agents/skills`资源。
5. Workflow Agent私有资源。
6. Package提供的资源，按Package来源分组。
7. 用户新增的文件或目录，按配置来源或目录分组。

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

目录、两种Node、`workflow.json`、`agent.json`、`.chat/config.json`和前后端接口的规范定义见[Chat Workflow开发框架](./chat-workflow-framework.md)。该文档是后续Agent新增Workflow时的直接开发入口。

### 11.4 Agent自定义提示词区域

需要明确区分：

| Chat配置项 | Pi机制 | 行为 |
|---|---|---|
| Agent基础提示词 | `SYSTEM.md`或`systemPromptOverride` | 替换Pi默认Coding Agent提示词；Planner等不同身份适用 |
| Agent自定义提示词区域 | Chat基于`appendSystemPromptOverride`组成 | 每次使用该Agent时进入System Prompt |
| 当前Session配置和本轮勾选的提示词规则 | 加入本轮Agent自定义区域 | 进入本轮快照；后续没有调整时继续沿用 |
| 项目规范 | `AGENTS.md` | Chat显式提供用户级文件和当前Project根目录文件，父目录和子目录都不自动继承 |
| Pi Prompt Template | `/name`展开 | 形成User Message，不用于编码规范System Prompt |

Chat把Agent自定义提示词区域作为“Workflow内Agent配置”的一部分。该区域可以由多个文件组成，例如：

```text
Agent长期规则
+ Workflow内这个Agent需要的规则
+ 当前Session沿用或用户本轮调整的编码规范
+ 后续其他自定义提示词资源
```

“编码规范”只是其中一类。Pi Web按组和文件展示可选提示词；Chat把当前Session沿用的选择和用户本轮调整合并后，读取对应文件并加入这个Agent的本轮有效配置。

按Pi当前源码，最终顺序是：

```text
Pi默认或Agent基础System Prompt
  ↓
Chat管理的Agent自定义提示词区域
  ├── Agent默认规则
  ├── Workflow中该Agent的规则
  └── Session最新选择与本轮调整后的规则
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
