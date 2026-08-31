# Pi Agent设计与源码分析

## 1. 目的与范围

本文先回答Pi自身是怎么设计的，再为后续Chat需求分析提供输入。这里不定义Chat的Agent配置Schema，也不把Chat当前实现误认为Pi原生设计。

分析基线：

```text
Chat/pi commit 1e44171651f99e3c9066f805529db58bf93a5136
Pi package version 0.84.2
```

Chat当前走的是成熟的`createAgentSession()`路径：

```text
@earendil-works/pi-ai
  → @earendil-works/pi-agent-core / Agent
    → @earendil-works/pi-coding-agent / AgentSession
      → Chat Workflow
```

Pi源码中还存在新的`AgentHarness`持久运行时设计，但它尚未成为Chat当前调用链，且主要执行方法仍返回`HarnessNotImplemented`。本文将两条路径分开描述。

## 2. Pi为什么这样分层

Pi把“调用模型”“运行Agent循环”“形成Coding Agent产品”分开，避免每个使用场景都复制同一套Provider、工具循环和Session逻辑。

| 层 | 核心包 | 负责 | 不负责 |
|---|---|---|---|
| 模型接入层 | `pi-ai` | Provider、Model、认证、统一流式消息和请求参数 | Agent循环、Session、Coding工具 |
| Agent循环层 | `pi-agent-core` | Agent状态、LLM与工具循环、事件、队列、上下文转换 | Skill/Extension发现、Coding Session文件、TUI |
| Coding Agent层 | `pi-coding-agent` | AgentSession、Coding工具、SessionManager、资源加载、Extension、压缩、重试、模型配置 | Chat Workflow和Web产品协议 |
| 交互适配层 | Coding Agent的TUI、print、JSON、RPC、SDK模式 | 把同一Coding Agent能力交给终端、进程或嵌入应用 | 具体业务Workflow |
| Chat业务层 | Chat | Workflow、多个Agent之间的输入关系、浏览器API和产品Session语义 | 重写Pi的模型或Agent循环 |

依赖方向是单向的：Coding Agent使用Agent Core，Agent Core使用Pi AI。低层不知道Skill目录、Plugin管理或Chat Workflow。

## 3. 当前生产路径的核心对象

### 3.1 Model与ModelRuntime

`Model`描述一个具体模型及其能力；`ModelRuntime`负责Provider注册、认证、模型解析和实际`streamSimple()`调用。

它解决的是“向哪个Provider的哪个模型发请求以及怎样认证”，不保存对话，也不决定Workflow。

### 3.2 Agent

`Agent`是进程内的有状态Agent循环。它持有：

```ts
interface AgentState {
  systemPrompt: string;
  model: Model;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool[];
  messages: AgentMessage[];
  isStreaming: boolean;
  streamingMessage?: AgentMessage;
  pendingToolCalls: ReadonlySet<string>;
  errorMessage?: string;
}
```

它的职责是：

1. 接收一个或多个`AgentMessage`。
2. 在调用Provider前执行`transformContext`和`convertToLlm`。
3. 流式调用模型。
4. 执行Assistant返回的Tool Call。
5. 把Tool Result加入上下文并继续下一轮模型调用。
6. 发出消息、Turn、工具和Agent生命周期事件。
7. 接收Steering和Follow-up队列。

它没有文件型Session管理。`messages`只是当前`Agent`对象的内存状态；持久化由更上层完成。

### 3.3 AgentMessage与Provider Message

Pi故意区分两种消息：

```text
AgentMessage[]
  → transformContext
  → convertToLlm
  → Provider支持的Message[]
  → LLM
```

`AgentMessage`可以包含应用自定义消息。Provider只理解`user`、`assistant`和`toolResult`等标准角色，因此`convertToLlm`负责过滤或转换应用消息。

这个设计允许UI信息、压缩摘要和应用上下文存在于Agent侧，而不要求所有Provider理解这些类型。

### 3.4 SessionManager

当前Coding Agent的`SessionManager`负责JSONL Session。Session头记录ID、时间和cwd；后续Entry通过`id`和`parentId`形成树。

主要Entry包括：

| Entry | 用途 | 是否进入模型上下文 |
|---|---|---|
| `message` | 用户、Assistant和Tool Result | 是 |
| `model_change` | 当前模型变化 | 不作为消息；用于恢复配置 |
| `thinking_level_change` | Thinking Level变化 | 不作为消息；用于恢复配置 |
| `compaction` | 压缩摘要 | 是，替代被压缩的旧上下文 |
| `branch_summary` | 分支导航摘要 | 是 |
| `custom_message` | Extension注入的自定义消息 | 是 |
| `custom` / `CustomEntry` | Extension或应用状态、展示元数据 | 否 |

`CustomEntry`的目的只是持久化扩展状态。`buildSessionContext()`通过Entry树和压缩信息生成下一次模型调用所需的消息；普通`custom`会被过滤。

因此：

```text
Agent配置 ≠ CustomEntry
Agent实际对话消息 ≠ CustomEntry
CustomEntry = 可持久化但不进入模型上下文的应用数据
```

Chat目前使用`CustomEntry`记录Workflow、Stage、Agent身份和内部阶段输出，是Chat的观察与展示逻辑，不是Agent能力配置机制。

### 3.5 SettingsManager

`SettingsManager`合并全局`agentDir/settings.json`和项目`.pi/settings.json`，向Coding Agent提供稳定设置。它包含两类配置：

1. Agent运行设置：默认模型、Thinking Level、工具、重试、压缩、队列、Transport、Thinking Budget、图片策略和网络超时。
2. Coding Agent产品设置：Theme、TUI、外部编辑器、Package资源、Skill命令等。

这两类不能在Chat的Agent需求分析中直接混为一个配置对象。Theme属于交互界面；重试和压缩会影响Agent执行。

### 3.6 ResourceLoader

`DefaultResourceLoader`负责发现和加载：

- Extensions
- Skills
- Prompt Templates
- Themes
- AGENTS.md等项目上下文
- SYSTEM.md与APPEND_SYSTEM.md

它同时提供两种控制方式：

1. 使用全局、项目、Package和Settings的默认发现。
2. 使用`noSkills`、`noExtensions`和`additional*Paths`等选项建立调用方指定的资源集合。

ResourceLoader是资源目录、配置文件与运行中AgentSession之间的边界。Skill和Extension不是`Agent`底层概念，而是Coding Agent通过ResourceLoader加到AgentSession上的能力。

### 3.7 ExtensionRunner

Extension模块由ResourceLoader加载，但运行时绑定到一个具体`AgentSession`。`AgentSession`为每个实例创建`ExtensionRunner`，并交给它当前的cwd、SessionManager和ModelRegistry。

Extension可以：

- 注册工具、命令、Provider和渲染器。
- 监听Agent、Turn、消息和工具事件。
- 在Provider请求前修改上下文、Headers或Payload。
- 在工具调用前阻止或修改执行。
- 写Session Entry和触发UI请求。

所以“全局Extension”有两个不同含义：

1. 安装或发现范围是全局，默认对所有项目可见。
2. 运行实例仍属于一个AgentSession，并不是整个Node进程只有一个ExtensionRunner。

### 3.8 AgentSession

`AgentSession`是当前Coding Agent最重要的组合对象。它连接：

```text
Agent
SessionManager
SettingsManager
ResourceLoader
ModelRuntime
ExtensionRunner
Coding Tools
Compaction / Retry
```

它承担的职责包括：

1. 根据当前工具、Skill、上下文文件和Prompt构造System Prompt。
2. 展开`/skill:name`和Prompt Template。
3. 让Extension处理输入和生命周期事件。
4. 调用底层`Agent.prompt()`。
5. 监听`message_end`并写入SessionManager。
6. 在错误后执行自动重试。
7. 在上下文临近上限或溢出时执行压缩。
8. 管理模型、Thinking Level、工具集合和队列。

`AgentSession`是一次运行中的对象；JSONL Session文件是持久历史。销毁AgentSession不会删除Session文件。

## 4. createAgentSession是组合入口

SDK的`createAgentSession(options)`不是另一个Agent实现，而是创建上述对象关系的组合入口。

它的主要流程是：

```text
1. 解析cwd和agentDir
2. 创建或接收ModelRuntime
3. 创建或接收SettingsManager
4. 创建或接收SessionManager
5. 创建或接收ResourceLoader，并执行reload
6. 从显式参数、已有Session或Settings解析Model和Thinking Level
7. 计算内置、Extension与Custom Tool的启用集合
8. 创建底层Agent并接入Provider、Extension和transformContext
9. 从SessionManager恢复消息
10. 创建AgentSession，构造ExtensionRunner、工具注册表和System Prompt
```

`CreateAgentSessionOptions`暴露的不是一个扁平产品配置，而是不同层的装配点：

| 选项组 | 代表的设计层 |
|---|---|
| `model`、`thinkingLevel`、`scopedModels` | Agent模型状态 |
| `tools`、`excludeTools`、`noTools`、`customTools` | Agent工具能力 |
| `resourceLoader` | Coding Agent资源能力 |
| `sessionManager` | 持久对话选择 |
| `settingsManager` | 运行策略与产品设置 |
| `modelRuntime` | Provider和认证运行时 |
| `transformContext` | 本次发送给模型前的上下文适配 |
| `providerRequestGate` | Provider请求前的强制安全边界 |
| `cwd`、`agentDir` | 资源和文件操作环境 |

后续Chat不能把这些字段机械复制成一个JSON Schema。必须先判断一个选项属于Agent稳定能力、Workflow本次输入、Chat平台运行时还是只能由代码提供的函数。

## 5. 一次Prompt的真实运行链

以`AgentSession.prompt(text)`为例：

```text
用户文本
  → Extension command检查
  → Extension input事件（可处理或转换）
  → Skill命令和Prompt Template展开
  → 模型与认证检查
  → 必要时预先压缩
  → 构造User AgentMessage
  → Extension before_agent_start（可注入消息或修改System Prompt）
  → Agent.prompt()
      → transformContext
      → convertToLlm
      → ModelRuntime.streamSimple()
      → Assistant流式事件
      → Tool Call执行
      → Tool Result
      → 必要时下一轮模型调用
  → AgentSession监听事件并持久化message_end
  → 自动重试或自动压缩
  → agent_settled
```

事件流不仅服务于UI，也驱动Session持久化和Extension。Chat把其中的Thinking、Text和Tool事件转成Workflow Run事件给浏览器，是对Pi事件的产品投影。

## 6. Skill、Extension和Package在Pi中的位置

### 6.1 Skill

Skill是模型可发现、按需读取的说明资源。Coding Agent启动时只把Skill的名称、描述和路径放入System Prompt；模型需要时使用`read`读取完整`SKILL.md`。显式`/skill:name`则由AgentSession直接展开完整内容。

因此Skill影响的是一个AgentSession的System Prompt和输入展开，不是整个Pi AI Provider层的全局对象。

### 6.2 Extension

Extension是可执行代码。它的文件或Package可以在全局或项目范围被发现，但ResourceLoader决定当前AgentSession实际加载哪些Extension，ExtensionRunner负责本次运行。

### 6.3 Pi Package

Pi Package是分发单位，可以同时包含Extension、Skill、Prompt和Theme。安装Package和某个AgentSession启用哪些资源是两件事：

```text
Package安装与版本管理
  → 解析资源清单
    → ResourceLoader选择本次AgentSession的资源
```

这一区分是后续Chat“插件管理”和“Agent能力设置”分层的上游依据。

## 7. 当前路径的持久性边界

当前`Agent`和`AgentSession`主要保证：

- 完整消息在`message_end`后进入JSONL。
- 模型、Thinking Level、压缩和分支数据可以恢复。
- 同一个Session文件可以由新的AgentSession继续。

它没有把一次尚未完成的Provider请求或Tool副作用完整保存成可跨进程恢复的操作状态。因此Chat当前使用Vercel Workflow负责Workflow级Step运行和状态；Pi JSONL负责对话历史。

这也是两个“Session”不能混淆的原因：

| 概念 | 负责 |
|---|---|
| Pi Coding Agent Session | 对话树、模型状态、Thinking Level、压缩和展示历史 |
| Vercel Workflow Run | Workflow及Step执行状态 |
| AgentSession对象 | 某次进程内Agent运行 |

## 8. AgentHarness：Pi正在形成的另一条设计路径

`pi-agent-core`现在还包含`AgentHarness`和新的Session/Storage设计。它的目标是把对话与操作状态持久化，支持：

- 不可变Entry树。
- 可变Register。
- Usage Ledger。
- 原子事务。
- Lane。
- Provider和Tool副作用前后的持久检查点。
- 中断后的恢复与副作用重放策略。

但在当前源码基线中：

- `AgentHarness.create()`遇到已有记录会返回`HarnessNotImplemented("create.restore")`。
- `prompt()`、`resume()`、`createLane()`、Hooks和Events等主要操作仍返回`HarnessNotImplemented`。
- Coding Agent的`createAgentSession()`仍然创建成熟的`Agent`、Coding Agent `SessionManager`和`AgentSession`，没有切换到`AgentHarness`。

因此AgentHarness是重要的上游演进方向和设计参考，但不能当作Chat已经获得的能力，也不能据此直接设计当前实现。

## 9. 对Chat需求分析的上游输入

到这里可以得出以下事实，但还不直接形成Chat Schema：

1. Workflow代码本来就可以为不同阶段创建不同的AgentSession，并传入不同的模型、工具、ResourceLoader和上下文转换。
2. Skill和Extension通过ResourceLoader进入AgentSession，Pi没有要求所有AgentSession共享相同资源集合。
3. SessionManager与ResourceLoader是两个独立装配点；多个Agent可以共享一份对话历史，但使用不同运行能力。
4. `transformContext`只改变当前Provider请求，不改变持久Session，适合Workflow阶段性交接。
5. System Prompt、Skill、Extension、Tool并不都处于同一层；后续配置设计必须保留这些边界。
6. Pi Package是安装与分发单位，不能直接等同于Agent能力配置。
7. CustomEntry属于Session持久化与观察，不属于Agent配置。
8. 当前成熟路径不能恢复未结算副作用；Chat必须继续明确Workflow Runtime和Pi Session的边界。

## 10. Pi当前能力的接口与数据结构索引

这一节只整理Pi已经存在的能力入口，不决定Chat如何配置。

### 10.1 四层公开入口

| 入口 | 主要类型 | 粒度 | 作用 |
|---|---|---|---|
| Agent Core构造 | `AgentOptions` | 一个进程内Agent | 模型、Prompt、工具、消息、上下文转换、队列和Provider钩子 |
| Coding Agent SDK构造 | `CreateAgentSessionOptions` | 一个AgentSession | 组合ModelRuntime、SessionManager、SettingsManager、ResourceLoader和Coding工具 |
| ResourceLoader构造 | `DefaultResourceLoaderOptions` | 一个资源加载器 | Skill、Extension、Prompt、Theme、Context File和System Prompt发现与覆盖 |
| 持久设置 | `Settings` | 全局或项目 | 默认模型、执行策略、资源来源、Session目录和交互设置 |

这四层有重叠，但含义不同。例如`thinkingLevel`可以由`createAgentSession()`显式传入，也可以来自Settings，还可以从已有Session恢复。显式参数、Session历史和Settings之间有明确的解析优先级。

### 10.2 能力矩阵

| 能力 | 核心对象和数据结构 | 创建或配置入口 | 运行时入口 | 当前持久化行为 |
|---|---|---|---|---|
| Provider与Model | `Model`、`ModelRuntime` | `modelRuntime`、`model`、Settings中的默认Provider/Model | `AgentSession.setModel()` | `model_change`记录当前选择；认证和模型目录不写Session |
| Thinking | `ThinkingLevel`、`ThinkingBudgets` | `thinkingLevel`、Settings中的默认等级与Budget | `AgentSession.setThinkingLevel()` | `thinking_level_change`记录等级；Budget不写Session |
| System Prompt | `buildSystemPrompt()`、ResourceLoader的System Prompt数据 | `systemPrompt`、`appendSystemPrompt`及Override | Extension的`before_agent_start`可按Turn修改 | 当前Session不保存完整基础System Prompt |
| 项目上下文 | ResourceLoader的`agentsFiles` | cwd、agentDir、`noContextFiles`、`agentsFilesOverride` | ResourceLoader reload | 文件内容进入System Prompt，但不作为Session Entry保存 |
| Built-in Tool | `AgentTool`、Coding Agent `ToolDefinition` | `tools`、`excludeTools`、`noTools`、Settings `defaultTools` | `setActiveToolsByName()` | Tool定义和启用集合不保存；Tool Call与Tool Result作为消息保存 |
| Custom Tool | `customTools`或Extension `registerTool()` | 代码传入或Extension加载 | Extension可刷新工具 | 与Built-in Tool相同，只保存调用结果 |
| Skill | Coding Agent `Skill` | ResourceLoader默认发现、`additionalSkillPaths`、`noSkills`、`skillsOverride` | 模型按描述调用`read`，或`/skill:name`显式展开 | 自动发现的Skill不保存；显式展开后的文本作为用户消息保存 |
| Extension | `Extension`、`ExtensionRunner`、`ExtensionAPI` | ResourceLoader默认发现、`additionalExtensionPaths`、`noExtensions`、`extensionsOverride`、`extensionFactories` | 事件、命令、工具、Provider和上下文钩子 | Extension代码与启用集合不保存；可自行写CustomEntry或CustomMessage |
| Pi Package | `PackageSource`、Package Manifest | Settings `packages`和PackageManager | ResourceLoader把Package解析成资源 | 安装状态在Settings和安装目录，不在Session |
| Prompt Template | `PromptTemplate` | ResourceLoader路径与Override | `AgentSession.prompt()`展开`/name` | 展开结果作为用户消息保存，模板定义不保存 |
| 对话消息 | `AgentMessage`、Provider `Message` | Agent初始State或Session恢复 | `prompt()`、`continue()`、`transformContext()`、`convertToLlm()` | 标准消息写`message` Entry |
| Session树 | `SessionManager`、`SessionEntry` | `sessionManager` | 分支、导航、压缩、命名和标签 | JSONL持久化，是当前Coding Agent历史事实源 |
| Steering与Follow-up | Agent内部消息队列、AgentSession展示队列 | Settings中的两种Queue Mode | `steer()`、`followUp()`、`clearQueue()` | 未投递队列只在内存；投递后才成为消息 |
| Compaction | `CompactionSettings`、`CompactionEntry` | Settings | 手动压缩和自动阈值/溢出压缩 | 摘要写`compaction` Entry，旧完整历史仍保留 |
| Retry | `RetrySettings`、Provider Retry设置 | Settings | AgentSession错误处理 | 当前重试计数在内存，不形成独立持久操作状态 |
| Provider请求边界 | `transformContext`、Extension context、`providerRequestGate`、Payload/Header钩子 | SDK代码与Extension | 每次Provider调用前执行 | 转换后的实际请求默认不写Session |
| 生命周期事件 | `AgentEvent`、`AgentSessionEvent`、Extension Events | `subscribe()`和Extension handler | 流式产生 | 事件本身不持久化；AgentSession选择其中的消息事件落盘 |
| UI能力 | Extension UI、TUI/RPC事件、Theme | 交互模式与Extension | TUI或RPC客户端 | 不属于Agent对话事实，除非应用主动保存 |

### 10.3 能力输入的优先级与生命周期

`createAgentSession()`创建模型状态时，大致按以下优先级解析：

```text
显式CreateAgentSessionOptions
  ↓（未提供）
已有Session保存的Model / Thinking Level
  ↓（无法恢复或新Session）
Settings默认值
  ↓
可用模型的回退选择
```

资源的流程不同：

```text
Settings与Package资源
+ 全局/项目自动发现
+ additional paths / inline factories
  ↓
ResourceLoader.reload()
  ↓
当前AgentSession的Skill、Extension、Prompt、Theme和Context集合
```

对话又是第三条链：

```text
SessionManager.buildSessionContext()
  ↓
Agent初始messages
  ↓
Extension context handlers
  ↓
Chat或SDK transformContext
  ↓
convertToLlm
  ↓
Provider Message[]
```

这三条链分别解决默认配置、能力装配和本次模型上下文，不能合并成一个没有层次的“Agent参数集合”。

### 10.4 可声明数据与代码能力

Pi接口中有些值天然是数据，有些值本质上是代码：

| 类型 | 例子 | Pi设计含义 |
|---|---|---|
| 可声明数据 | Model ID、Thinking Level、Tool名称、Skill路径、Extension来源、Retry和Compaction数值 | 可以来自JSON Settings或调用参数 |
| 运行时对象 | `SessionManager`、`ModelRuntime`、`ResourceLoader`、`SettingsManager` | 必须由宿主应用创建并管理生命周期 |
| 执行函数 | `transformContext`、`providerRequestGate`、Tool `execute`、Extension Factory和Override回调 | 只能由代码提供，配置最多引用其注册名称 |
| 本次输入 | cwd、用户Prompt、图片、Session选择、Workflow上游输出 | 由当前请求和Workflow决定，不是Agent固有定义 |

这只是Pi接口性质的分类。哪些字段最终进入Chat配置，必须等Pi Web和Chat场景分析后决定。

### 10.5 原生接口、字段和源码位置

| Pi层级 | 公开接口或数据结构 | 关键字段 | 源码位置 |
|---|---|---|---|
| Agent Core | `AgentOptions` | `initialState`、`convertToLlm`、`transformContext`、`streamFn`、Tool Call前后钩子、队列模式、Thinking Budget、Transport、Tool执行模式 | `pi/packages/agent/src/agent.ts` |
| Agent Core | `AgentState` | `systemPrompt`、`model`、`thinkingLevel`、`tools`、`messages`、Streaming和Pending Tool状态 | `pi/packages/agent/src/types.ts` |
| Coding Agent SDK | `CreateAgentSessionOptions` | cwd、agentDir、ModelRuntime、模型、Thinking、工具、ResourceLoader、SessionManager、SettingsManager、Provider Gate和Context Transform | `pi/packages/coding-agent/src/core/sdk.ts` |
| Coding Agent Services | `CreateAgentSessionServicesOptions`、`AgentSessionServices` | cwd绑定的ModelRuntime、SettingsManager、ResourceLoader及诊断 | `pi/packages/coding-agent/src/core/agent-session-services.ts` |
| 资源加载 | `ResourceLoader`、`DefaultResourceLoaderOptions` | Extension、Skill、Prompt、Theme、Context File、System Prompt的路径、禁用开关、Factory和Override | `pi/packages/coding-agent/src/core/resource-loader.ts` |
| 持久设置 | `Settings`、`PackageSource` | 模型默认值、工具默认值、队列、压缩、重试、资源路径、Package、Session目录、网络和界面设置 | `pi/packages/coding-agent/src/core/settings-manager.ts` |
| 对话持久化 | `SessionHeader`、`SessionEntry`、`SessionContext` | Session树、消息、模型、Thinking、压缩、分支摘要、CustomEntry和CustomMessage | `pi/packages/coding-agent/src/core/session-manager.ts` |
| Skill | `SkillFrontmatter`、`Skill` | 名称、描述、文件路径、来源、`disable-model-invocation` | `pi/packages/coding-agent/src/core/skills.ts` |
| Extension | `ExtensionAPI`、`ExtensionContext`、`ToolDefinition`、`ExtensionEvent` | 事件、工具、命令、消息、Session元数据、模型、Thinking、Provider和UI | `pi/packages/coding-agent/src/core/extensions/types.ts` |
| System Prompt | `BuildSystemPromptOptions` | 自定义Prompt、追加Prompt、已选工具、Tool提示、项目上下文和Skill | `pi/packages/coding-agent/src/core/system-prompt.ts` |

这里的“能力设置”不是指一个文件，而是四种不同接口：

```text
AgentOptions
  = Agent Core运行循环的构造参数

CreateAgentSessionOptions
  = Coding Agent一次AgentSession的装配参数

DefaultResourceLoaderOptions
  = 这个AgentSession能发现和加载哪些资源

Settings
  = 全局或项目持久默认值与运行策略
```

`createAgentSession()`的源码也验证了它们的组合顺序：先创建ModelRuntime、SettingsManager、SessionManager和ResourceLoader，再从显式参数、已有Session和Settings解析模型与Thinking，接着计算工具集合，最后创建`Agent`和`AgentSession`。

### 10.6 Extension能力不是普通配置字段

Pi的`ExtensionAPI`原生提供以下能力组：

1. 监听资源、Session、Provider、Agent、Turn、消息和工具生命周期事件。
2. 注册Tool、Command、Shortcut、CLI Flag、消息渲染器和Entry渲染器。
3. 发送Custom Message或User Message，并用CustomEntry持久化Extension状态。
4. 读取和修改Session名称、Entry Label、活动工具、模型和Thinking Level。
5. 注册或撤销Provider。
6. 通过`ExtensionContext`读取cwd、只读SessionManager、模型、上下文用量、System Prompt和取消信号。

这些能力说明Extension是运行代码，不是一个能完整序列化进JSON的配置对象。Chat后续最多配置“允许加载哪个已登记Extension及其声明式参数”；不能把Tool `execute()`、事件Handler或Provider实现本身放进Agent配置Schema。

### 10.7 Skill进入模型的准确路径

Skill的原生数据结构只有名称、描述、文件路径、来源和是否允许模型自动调用。ResourceLoader加载Skill后，`AgentSession._rebuildSystemPrompt()`把Skill交给`buildSystemPrompt()`；只有当前工具集合包含`read`时，Skill列表才进入System Prompt。模型需要使用Skill时，再读取对应`SKILL.md`。

显式`/skill:name`走另一条路径：`AgentSession`读取完整文件、去掉Frontmatter并展开成当前用户输入。两条路径都证明Skill是AgentSession资源，但自动发现是否有效还依赖该Agent是否有`read`工具。

### 10.8 Pi的提示词区域和拼装顺序

Pi中容易被统称为“Prompt”的内容实际有四种：

| 机制 | Pi入口 | 进入模型的位置 | 适用场景 |
|---|---|---|---|
| 基础System Prompt | 默认Coding Prompt、`SYSTEM.md`、`systemPromptOverride` | 替换整个基础System Prompt | 定义Agent身份和根本职责 |
| 追加System Prompt | `APPEND_SYSTEM.md`、`appendSystemPrompt`、`appendSystemPromptOverride` | System Prompt内部，紧接基础Prompt | 编码规范、输出规则、某个Agent长期规则和本轮附加规则 |
| 项目上下文 | `AGENTS.md`、`CLAUDE.md`、`agentsFilesOverride` | System Prompt的`project_context`区域 | Chat全局与当前Project根目录的规范和命令 |
| Prompt Template | `prompts/*.md`、`/name` | 展开为User Message | 用户输入模板，不是System Prompt规则 |

Skill是第五种资源：Skill名称和描述进入System Prompt，完整`SKILL.md`由模型按需读取。它不保证整份规则在每次调用中出现，因此不适合作为必须始终生效的编码规范。

`AgentSession._rebuildSystemPrompt()`从ResourceLoader取得这些数据，再交给`buildSystemPrompt()`。当前源码中的固定顺序是：

```text
Pi默认Coding Prompt或自定义基础System Prompt
  ↓
appendSystemPrompt中的多个片段（按数组顺序，以空行连接）
  ↓
AGENTS.md等项目上下文
  ↓
可用Skill描述（只有read工具启用时）
  ↓
Current working directory
```

Pi CLI默认从cwd一直向文件系统根目录发现Context文件。Chat不能把机器上偶然存在的父目录当成产品全局配置，因此在统一Agent装配层设置`noContextFiles: true`，再通过`agentsFilesOverride`显式提供`~/.chat/agent`与用户明确打开的Project根文件。这样保留Pi的`project_context`格式和AgentSession行为，同时落实Chat的Personal + Project作用域。

Pi默认只自动发现一个`SYSTEM.md`：受信项目的`.pi/SYSTEM.md`优先，否则使用`agentDir/SYSTEM.md`。`APPEND_SYSTEM.md`也是项目优先于全局。SDK可以通过`appendSystemPromptOverride(base)`保留Pi已发现的默认追加内容，再追加多个调用方提供的规则。

Extension的`before_agent_start`还可以按Turn替换最终System Prompt，但这是运行时代码钩子。Chat可以使用Pi原生追加System Prompt，在最终Prompt中建立一个由Chat管理的“Agent自定义提示词区域”，不需要为普通提示词规则创建Extension。

这个自定义区域与Session的`CustomEntry`只有设计思想相似，不能混用：

| 扩展点 | 所属对象 | 是否进入模型 | 生命周期 |
|---|---|---|---|
| Pi `CustomEntry` | Session | 否 | 随Session JSONL持久化 |
| Chat Agent自定义提示词区域 | Agent配置 | 是，属于System Prompt | 每次交互读取配置并重新组成 |

Pi没有名为“Chat自定义区域”的原生字段；它提供的是`appendSystemPrompt`扩展点。Chat负责给该区域定义来源、顺序、标记和前端展示，Pi负责把最终文本作为System Prompt发送给模型。

### 10.9 Pi原生资源元数据可以支持分组

Pi解析Skill、Extension、Prompt和Theme时，不只返回路径。`ResolvedResource`和`SourceInfo`还包含：

```text
path     实际资源路径
source   本地路径、Package来源或其他来源标识
scope    user / project / temporary
origin   package / top-level
baseDir  资源所属基础目录
```

因此Chat前端不需要根据路径字符串猜分组。后端可以先使用Pi解析资源，再按`scope`、`origin`、`source`和`baseDir`投影为“默认、全局、当前项目、Package、自定义目录”等界面分组。Agent配置仍应保存稳定的资源引用或来源，不保存前端临时生成的分组标题。

Pi本身已经支持多个Skill、Extension和Prompt Template文件或目录来源：Settings数组、Package资源和SDK的`additional*Paths`最终都会进入ResourceLoader。Chat要补的是资源维护、分组选择和每Agent过滤，不需要重写资源加载器。

## 11. 下一步分析任务

Pi接口和数据结构索引已经形成；[Pi Web架构与源码分析](./pi-web-design.md)也已说明浏览器、Next.js Route、Agent RPC、Session读取和资源管理如何使用这些能力。

下一步进入Chat当前架构和需求分析：先说明已经实现的事实、用户场景和缺口，再讨论哪些Pi能力需要成为Workflow中Agent可声明的配置。详细设计不能跳过这一层。
