# Chat Agent第一性原理与架构约束

## 1. 文档地位

本文是Chat架构设计和需求评审的约束性基准，回答三个问题：

1. Chat作为Agent产品，本质上管理什么。
2. Frontend、Backend、Workflow、Agent、Pi和Session分别负责什么。
3. 新需求应当落入哪个已有边界，什么情况才构成需要单独评审的架构变化。

本文描述的是必须长期保持的设计原则，不等同于“当前代码已经全部实现”。
当前实现事实由[Chat当前架构与源码分析](./chat-current-architecture.md)说明；
具体需求和落地方式分别由[Chat需求分析](./chat-requirements.md)和
[Chat Workflow详细设计](./chat-detailed-design.md)说明。

如果具体设计与本文冲突，不能通过增加条件分支绕过去。必须先说明冲突、影响和替代方案，经过架构评审后再修改本文或具体设计。

## 2. 第一性原理：Agent到底是什么

从一次模型调用看，Agent由以下事实组成：

```text
Agent
  = Model与Thinking
  + System Prompt
  + 当前模型上下文
  + 可用Tools
  + Skills、Extensions和其他资源
  + Agent循环及运行策略
```

Pi Agent Core拥有模型消息、工具调用和Agent循环。Pi Coding Agent在它之上组合Coding场景需要的Prompt、文件工具、Session、资源加载、压缩和重试。Chat不复制这些能力；Chat通过Pi公开接口配置和运行Agent。

对Chat而言，一个Agent需要管理的内容可以归为三类：

| 类别 | 内容 | 典型Pi入口 |
|---|---|---|
| 行为与上下文 | 基础Prompt、自定义Prompt资源、项目上下文、历史消息 | System Prompt、ResourceLoader、SessionManager、Context Transform |
| 可调用能力 | Built-in Tool、Custom Tool、Extension Tool | `tools`、`customTools`、Extension |
| 运行配置 | Model、Thinking、资源选择、重试和压缩相关设置 | `createAgentSession()`、SettingsManager |

产品层可以统一管理和展示这些Agent能力；运行层必须保留它们在Pi中的真实差异。例如规则文本进入System Prompt，Skill通常按需读取，Tool还绑定参数Schema和可执行函数。统一管理不等于把不同能力伪装成同一种运行对象。

## 3. Chat只增加Workflow协作层

Chat增加Workflow，是因为一次用户对话可能需要一个或多个Agent或非Agent节点协作。Workflow负责：

- 本次对话执行哪些Stage。
- Stage的先后或依赖关系。
- 每个Stage引用哪个Agent定义或普通节点实现。
- 上游输出怎样成为下游输入。

Workflow不负责：

- 重写Agent循环。
- 重写Pi Session格式。
- 复制Skill、Tool和Extension加载机制。
- 在编排文件中直接实现HTTP、文件存储或Provider调用。

一次对话的核心关系是：

```text
用户发送一条消息
  ↓
选择一个Workflow
  ↓
Workflow取得本轮配置快照
  ↓
按定义执行Stage
  ├── Agent Stage → 通过统一装配边界创建Pi AgentSession
  └── 普通Stage → 执行该节点的确定性逻辑
  ↓
结果和执行事实追加进同一个Chat Session
```

Workflow是一级管理和代码组织边界。Agent属于某个Workflow的定义；两个Workflow中名称或实现相同的Agent，不因此共享运行时配置。需要复用实现时复用定义或公共装配代码，不通过建立隐含的跨Workflow Agent身份实现共享。

## 4. 稳定架构与职责

```text
Frontend
  │  Project、用户意图、选择和展示
  ▼
Backend
  │  Project解析、事实、校验、持久化、安全和运行入口
  ▼
Workflow
  │  一次对话的Stage关系、输入输出和Agent引用
  ▼
Agent Assembly
  │  把Workflow Agent配置解析为Pi真实运行对象
  ▼
Pi Agent
     Model、Prompt、Context、Tools、Agent Loop和Session算法
```

### 4.1 Frontend

Frontend负责：

- 选择Session和Workflow。
- 查看Workflow、Stage、Agent和能力资源。
- 调整本轮配置。
- 展示Backend返回的解析结果、运行事件和历史。

Frontend不拥有服务端事实，不直接读文件，不导入Pi SDK，不自行推断某个配置最终是否生效。

### 4.2 Backend

Backend负责：

- HTTP认证和输入边界。
- Workflow、Agent和资源事实的API投影。
- Session与运行配置持久化。
- 资源的读取、校验、检索和变更。
- 启动Workflow并转发运行事件。

Backend中的资源模块可以管理Rule、Skill或Plugin等对象，但这些是已有Agent能力体系的实现模块，不自动成为新的顶层架构层。

### 4.3 Workflow

Workflow负责一次对话的业务流程。每个Workflow归拢：

- Workflow和Stage定义。
- 自己的Agent默认定义。
- Stage输入输出转换。
- Workflow专用Prompt、Skill、Tool或其他资源。
- Workflow专用测试。

Workflow编排文件只表达关系；Node、Pi和文件操作放进Step或公共运行模块。

### 4.4 Agent Assembly

所有Workflow中的Agent都通过统一装配边界创建Pi AgentSession。它负责：

- 合并Workflow默认Agent配置、Session中该Workflow的最新配置和本轮调整。
- 解析Prompt资源、Skills、Tools、Extensions和Plugins。
- 选择Model与Thinking。
- 构建ResourceLoader、SettingsManager和AgentSession。
- 返回用于前端检查的真实最终结果。

不能为Planner、规则Agent、Memory Agent或其他新Agent复制一套AgentSession创建逻辑。它们的差异应由配置、资源和Workflow输入表达。

### 4.5 Pi

Pi继续拥有Agent Loop、Provider消息转换、Tool执行、ResourceLoader、压缩、重试和Session算法。只有Pi公开扩展点无法满足通用Agent需求时，才讨论修改Later维护的Pi分支。

### 4.6 Project、Context与Resource Target

Project与Workflow正交：Project确定本轮工作目录、Session归属、Project配置和资源范围；Workflow确定一次对话的Stage关系和Agent装配。每个Session只属于一个稳定`projectId`，项目绝对路径由Backend Registry解析，不能由浏览器或`cwd`兼任长期身份。

资源操作必须区分两个概念：

- Context：操作从哪个Project和Session发起，用于权限、来源和审计。
- Target：资源最终归属于个人库或哪个Project库。

Context不隐含Target。当前Project中的Agent可以按用户明确意图读写个人资源或另一个已登记Project的资源，但Backend必须解析Target、保留原始Context和来源，并按每个Target独立执行权限与路径校验。发现资源不等于启用资源；只有具体资源被写入本轮Agent配置并完成解析后才生效。

## 5. Session、对话和运行对象

术语必须明确：

| 术语 | 含义 | 生命周期 |
|---|---|---|
| Chat Session（会话） | 用户看到的完整连续会话，包含多次对话 | 跨多次Workflow Run持久化 |
| Turn（一次交互） | 一次线性交互单元，可由用户或Agent先发起，并包含其Workflow执行和回复 | 通常对应一次Workflow Run |
| Workflow Run | 本次对话的执行实例 | 本轮开始到完成、失败或取消 |
| AgentSession | 某个Agent Stage本轮使用的Pi运行对象 | Stage执行期间 |

Session是连续状态，不是新的业务中心。它至少保存：

- 持续累加的对话历史。
- 每个Workflow在该Session中的最新配置。
- 每次对话实际使用的不可变配置快照和执行证据。

AgentSession不是Chat Session。每次对话可以重新创建AgentSession，同时恢复同一个Chat Session的有效历史。

Session持久化必须遵循[Chat Session架构](./chat-session-architecture.md)：用户、Assistant和Tool Result都是Pi原生MessageEntry；Workflow、Stage、Agent和审核控制状态只能作为正交元数据存在。CustomEntry不能替代真实话语。

## 6. Workflow配置生命周期

每个Workflow为自己的Agent提供初始默认配置。当前Session中的每次对话可以调整配置；用户没有调整时沿用该Workflow在当前Session中的上次配置。

```text
Workflow默认配置
  ↓  仅在该Workflow尚无Session配置时使用
Session中该Workflow的最新配置
  ↓
应用本轮用户或管理Workflow做出的调整
  ↓
冻结本轮配置快照
  ↓
执行Workflow
  ↓
保存为该Workflow在当前Session中的最新配置
```

可以写成：

```text
TurnConfig
  = SessionWorkflowConfig ?? WorkflowDefaultConfig
  + TurnOverrides
```

约束如下：

1. 配置作用域是`Session → Workflow → Agent`，不是跨Workflow的全局Agent身份。
2. 同名Agent出现在不同Workflow中时，默认配置和Session配置互相独立。
3. Workflow Run开始后使用冻结快照，执行中发生的配置变更从后续对话生效。
4. 手工调整和Agent辅助调整必须写入同一份配置状态，不能维护两套选择。
5. 历史消息持续累加；本轮System Prompt和能力集合按本轮配置重新组成。
6. 冻结不是只保存资源ID；必须先解析具体Prompt revision、配置文件内容和最终Agent定义，再写入Session本轮事实。
7. 任一Agent解析失败时，不得把半成品最新配置或Turn快照写进Session。

## 7. Agent能力的统一管理模型

Agent能力配置统一包含：

```text
Agent Configuration
  ├── Identity与基础System Prompt
  ├── 自定义Prompt资源
  │     ├── 规则与经验
  │     ├── 编码规范
  │     ├── 输出格式
  │     └── 后续其他Prompt区域
  ├── Skills
  ├── Tools
  ├── Extensions
  ├── Plugins
  ├── Model
  └── Thinking
```

所有能力类型共享管理语义：

- 稳定ID和类型。
- 名称、说明、来源和内容或能力定义。
- 标签、分类和检索。
- 默认选择、Session最新选择和本轮调整。
- 用户手工选择或Agent辅助选择的来源。
- 解析诊断和最终生效状态。
- 本轮实际使用快照。

资源地址至少包含类型、稳定ID和Target。个人资源与项目资源可以同名同ID；选择、去重、检索和版本解析必须使用`Target + ID`，不能依赖进程`cwd`或把所有项目放进一个隐式数据库。

各类型通过自己的适配器接入Pi：

| 能力类型 | 运行适配 |
|---|---|
| Prompt资源 | 按顺序进入基础Prompt之后的Chat自定义区域 |
| Skill | 交给Pi ResourceLoader发现并按Pi规则进入模型 |
| Tool | Built-in、Custom Tool或Extension Tool注册 |
| Extension | 交给ResourceLoader和ExtensionRunner加载 |
| Plugin | 由PackageManager提供其中的资源 |
| Model与Thinking | 转换为AgentSession创建参数和Session兼容记录 |

增加能力类型时应实现一个类型适配，而不是修改每个Workflow的执行代码。

## 8. 两个稳定扩展方向

### 8.1 增加Workflow

当需求改变一次对话的执行步骤或协作关系时，增加Workflow或Stage。正常改动范围是：

- 新增Workflow目录和注册。
- 定义Stage和Agent。
- 实现输入输出转换。
- 增加Workflow测试和前端元数据展示。

不应改动Agent Loop、Session Schema或为该Workflow复制公共资源管理。

### 8.2 增加Agent能力类型或资源

当需求改变Agent能看到、遵守或调用的内容时，增加能力资源或适配。正常改动范围是：

- 定义资源数据和来源。
- 提供校验、检索和管理接口。
- 接入统一Agent配置和装配边界。
- 在统一能力界面展示与选择。
- 记录本轮实际使用快照。

多数新需求应落在这两个方向之一，或者是它们与Frontend/Backend职责的组合。

## 9. 新需求归类方法

收到新需求时按以下顺序判断：

1. 它改变用户如何选择、配置或观察吗？属于Frontend投影与交互。
2. 它需要保存、检索、校验或安全控制吗？属于Backend事实和资源管理。
3. 它改变一次对话的Stage顺序或输入输出吗？属于Workflow。
4. 它改变Agent能看到或必须遵守的内容吗？属于Prompt或上下文资源。
5. 它改变Agent能调用的能力吗？属于Tool、Skill或Extension配置。
6. 它改变跨对话连续性或审计吗？属于Session配置、消息或观察快照。

一个产品名词可以同时落入多个既有职责，但不因此成为新的架构层。例如“规则库”包含Backend资源目录、Frontend能力面板、Prompt资源适配和规则管理Workflow；它仍然没有超出Frontend、Backend、Workflow和Agent能力体系。

## 10. 需要单独讨论的架构冲击

出现以下任一情况时，必须在实现前单独评审：

1. 改变`Session → 多次Turn`的连续性语义。
2. 改变`Session → Workflow → Agent`的配置作用域和继承规则。
3. 引入跨Workflow隐式共享状态或全局Agent身份。
4. 绕过统一Agent装配边界直接创建Pi AgentSession。
5. 绕过Pi原生Tool、Skill、Extension或Session机制重写平行实现。
6. 让Frontend持有或推断服务端事实。
7. 让Workflow编排层承担资源存储、HTTP或Provider实现。
8. 引入新的执行引擎、持久化系统或信任边界。
9. 需要修改Pi标准消息或Session Schema。
10. 一个局部需求导致多个既有Workflow重复修改同类代码。

“出现了新对象名称”不是架构冲击；“现有对象关系、状态所有权或生命周期必须改变”才是。

## 11. 模块和接口设计约束

### 11.1 单一事实源

- Workflow注册表是Workflow事实源。
- Workflow目录中的Agent默认定义是默认配置事实源。
- Backend持久化的Session Workflow配置是运行时最新配置事实源。
- Pi AgentSession和ResourceLoader解析结果是最终生效事实源。
- Frontend只消费以上投影。

### 11.2 稳定接口

公共接口应围绕事实命名：

- `list/resolve Workflow`。
- `resolve Agent configuration`。
- `list/search/update Agent resource`。
- `create AgentSession from resolved configuration`。
- `append/read Turn configuration snapshot`。

避免用含义不明确的总称隐藏多个职责，也避免为了一个具体Workflow把接口命名成产品场景。

### 11.3 依赖方向

```text
Frontend → Backend API
Workflow → 公共Session、配置和Agent装配接口
Agent装配 → Pi公开接口
资源管理 → 文件或外部资源 + Pi资源解析接口
```

反向依赖需要评审。例如公共Agent装配模块不能导入某个具体Workflow，Pi子模块不能依赖Chat业务对象。

### 11.4 代码规模信号

新增一个普通Workflow、Prompt资源类型或能力面板时，如果需要大量重复代码，应先检查：

- 是否复制了Pi已有能力。
- 是否绕过了公共Agent装配和资源接口。
- 是否把多个职责放进同一模块。
- 是否缺少类型适配或Backend投影。

代码量不是唯一标准，但局部需求导致跨层大面积修改通常说明边界不稳定。

## 12. 测试和观察约束

架构扩展至少验证：

1. Workflow默认配置能够解析。
2. Session最新配置和本轮调整按规定合并。
3. 本轮执行使用冻结快照，不受执行中修改影响。
4. Agent检查接口和实际执行共用同一装配路径。
5. Prompt、Skill、Tool等能力按各自Pi机制真实生效。
6. 切换Workflow不破坏Session历史，也不错误共享配置。
7. 完整历史能说明本轮Workflow、Stage、Agent、输入和能力快照。
8. Frontend刷新后从Backend恢复事实，不依赖旧React内存。
9. 个人与项目资源互相隔离，跨Project读写只有显式Target才能发生。
10. Draft和Proposal确认绑定具体ID，确认A不能提交或应用B。
11. Prompt资源解析失败时，Session最新配置和Turn快照都不发生变化。

## 13. 规则与经验：架构范例

规则或经验首先被归类为自定义Prompt资源，而不是新的核心系统：

```text
规则内容、元数据和Personal/Project Target
  → Backend Prompt资源管理

规则列表、标签、来源和选择
  → Frontend统一Agent能力界面

规则如何进入模型
  → Agent Prompt资源适配

从Session沉淀、检索和建议规则
  → 规则管理Workflow + 普通规则Agent

规则Agent的工作方法
  → Workflow专用Skill

查询、保存、选择和归档
  → Agent Custom Tools调用Backend资源接口

某次对话实际使用哪些规则
  → Session中的Workflow配置和Turn快照
```

规则Agent和其他Agent使用同一配置、资源和AgentSession装配机制。它可以拥有自己的Prompt资源、Skills和Tools，也可以通过持续对话调整本Workflow或其他指定Workflow的后续配置。不同Workflow中的同名Agent不会因此共享配置。资源创建、修改、归档、Draft提交、Proposal应用和拒绝由持续对话完成；变更Tool必须校验与具体对象ID绑定的确认短语，读取HTTP接口不能成为绕过确认的第二条写入通道。

这个范例以后同样适用于其他需求：先识别它是Workflow变化、Agent能力资源、Frontend/Backend职责还是Session连续性，再决定模块，而不是从产品名词直接推导新架构。

## 14. 架构评审清单

任何新增需求进入详细设计前必须能够回答：

1. 用户场景发生在哪一次对话中？
2. 由哪个Workflow负责，是否真的需要新Workflow？
3. 涉及哪些Agent或普通Stage？
4. 新内容属于哪类Agent能力？
5. 默认配置、Session最新配置和本轮调整分别是什么？
6. 通过Pi哪个公开扩展点生效？
7. Backend保存什么事实，Frontend展示什么投影？
8. 本轮配置和执行证据怎样进入完整历史？
9. 是否复用了统一Agent装配和资源管理接口？
10. 是否改变现有状态所有权、生命周期或信任边界？

前九项无法清楚回答时，不开始编码。第十项答案为“是”时，先完成架构评审。
