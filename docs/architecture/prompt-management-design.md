# Chat 提示词管理：上游事实与设计草案

> 状态：待产品审核的设计草案，不是已实现合同。
>
> 调研基线：Chat `main@f1315ef`；Pi `later-3/pi@1f2b9ff`（npm 基底 `0.84.2`）；DeepSeek Harness `0.1.0-rc.6@15148dbd9a`。DSH 后续窄派生提交只涉及 Trajectory，不改变本文引用的 Prompt 与 Session 机制。
>
> 本文只确定提示词的所有权、组成、来源、连续会话和预算方向。用户审核后再拆实现任务；本轮不修改 Planner、Executor、Direct Agent 或 DSH 的运行行为。
>
> 三个真实 Agent 的逐请求实验、宿主预注入与模型 Tool Call 的因果区分，以及真实压缩请求证据见[《Pi、DeepSeek Harness 与 Hermes 的真实上下文组装实验》](./prompt-context-real-experiment.md)。若本文的概括与实验报告冲突，以固定源码和实验报告中的真实请求为准。

## 1. 结论先行

Later 对现状的判断基本正确，但需要补一层边界：

1. Pi Coding Agent 已经有完整的单个 AgentSession 组装逻辑。它管理系统提示词、消息历史、工具定义、模型参数、Tool Loop 和会话内压缩。
2. DSH 也有完整逻辑，而且比 Pi 更强调插件化来源：系统提示词由带名称和顺序的 Section 组成，动态 Context 作为带来源的耐久 User Message 进入 Session，工具 Schema 独立组装，模型可见内容必须能从 Session Log 重建。
3. Chat 不是完全没有提示词逻辑。Planner、Executor、Direct Agent、Memory/Rule/Workspace Context 和 Prompt Review 已各自实现了一部分；问题是它们散落在不同 TypeScript 文件和上游默认行为里，没有统一的区域、来源、优先级、预算、跨 Run 历史和压缩合同。
4. Chat 不应复制 Pi Agent Loop，也不应让 DSH Session 成为 Chat Prompt 的权威来源。推荐保留 Pi 负责一次 Agent 运行内部的循环和 Provider 适配，让 Chat 新增一个产品级 `Prompt Profile + Prompt Compiler + Assembly Manifest`，管理“这一节点为什么把哪些事实交给模型”。
5. 同一个 Product Session 可以逐条消息选择不同 Workflow。连续会话上下文必须从 Chat Product Store 的正式 Message/Context 事实编译，而不是复用 DSH 隐藏上下文或默认继承某个 Pi Session。

## 2. 术语

本文把几个容易混用的词拆开：

- **原始 Provider 请求**：Provider Adapter 已序列化、Credential/Header 注入前，真正将要发送的 JSON 请求正文。现有 Prompt Review 审核的就是它。
- **Prompt Fragment**：Chat 管理的一小段有来源内容，例如 Direct 节点规则、当前用户输入、一条 Workspace 指令或一份会话摘要。
- **Prompt Region**：给人管理和分配预算的稳定区域，例如系统指令、当前输入、会话上下文、参考上下文、工具和请求参数。
- **Prompt Assembly**：某次模型请求所采用的 Fragment 清单及其顺序、排除原因、预算和 Hash。
- **模型可见上下文**：本次请求实际传入模型的 System、Messages、Tools 和参数。它不等于完整产品会话历史。
- **完整会话历史**：Product Store 中的正式 Message、Run、Decision 和 Evidence。它不会因为压缩而删除。

## 3. Pi Coding Agent 的真实设计

### 3.1 最终请求不是四个完全独立的文本框

Later 提到的“系统提示词、用户输入、工具、历史”是正确的理解入口。按 Pi 的实际类型，Provider 前的稳定结构是：

```text
Context
├── systemPrompt
├── messages[]
│   ├── user              ← 当前用户输入也是这里的最后一条或几条
│   ├── assistant         ← 历史模型回复，含 Tool Call
│   └── toolResult        ← 工具执行结果
└── tools[]               ← 名称、描述、参数 Schema

Request options
├── model / provider
├── thinking / maxTokens / temperature 等
└── stream / provider compatibility fields
```

所以“用户输入”在 Provider 合同中通常不是独立顶层字段，而是 `messages` 中本轮新增的 User Message。模型参数则是第五类不可忽略的信息。

源码入口：

- `pi/packages/agent/src/types.ts`：`AgentContext` 与 `AgentState`。
- `pi/packages/agent/src/agent-loop.ts`：每次请求前依次运行 `transformContext(messages)`、`convertToLlm(messages)`，再调用 `streamFunction(model, context, settings)`。
- `pi/packages/ai/src/api/openai-completions.ts`：把 Context 和请求选项序列化为最终 Provider Payload。

### 3.2 System Prompt 如何组成

`pi/packages/coding-agent/src/core/system-prompt.ts` 的 `buildSystemPrompt()` 负责组装：

1. Pi 默认身份和工作方式，或者调用方传入的非空完整 `customPrompt`；后者会替换默认正文。
2. 当前启用工具的一行摘要与工具使用准则。
3. 调用方的 `appendSystemPrompt`。
4. 从 Workspace 发现的 Context Files，例如 `AGENTS.md`。
5. 可用 Skills 的目录提示。
6. 当前工作目录。

`pi/packages/coding-agent/src/core/agent-session.ts` 的 `_rebuildSystemPrompt()` 会在资源或工具变化后重建这份文本；`_installAgentNextTurnRefresh()` 又会在下一轮开始前刷新 System、Tools、Model 和 Thinking。因此它不是只在 Session 创建时固定一次。

需要特别注意：非空 `customPrompt` 是替换默认基础正文，不是普通追加；但是 append、Context Files、Skills 和 cwd 仍按配置继续参与。当前实现使用 `if (customPrompt)` 判断，所以空字符串不会创建“空的完整 System”，而是回退到 Pi 默认正文；这与类型注释容易产生不同理解。

### 3.3 User、History 和 Tool Loop

`AgentSession.prompt()` 会先处理 Extension Input、Skill 命令和 Prompt Template，再创建 User Message。随后 `Agent` 把它追加到已有 `state.messages`。

一次用户输入可能产生多次 Provider 请求：

```text
User Message
→ Provider Request 1
→ Assistant Tool Call
→ Tool Result
→ Provider Request 2（带上前面的 Tool Call 与 Tool Result）
→ …
→ 最终 Assistant Message
```

`pi/packages/agent/src/agent-loop.ts` 明确把 Assistant Message 和 Tool Result 依次追加到同一上下文。Steering、Follow-up 和 Extension 注入也能成为下一次请求的一部分。

因此“每次发送给大模型都审核”必须拦截每一次 Provider Request，而不是只审核首次 User Prompt。现有 Chat Direct Agent 的 `providerRequestGate` 正是放在这个边界。

### 3.4 Pi 的完整历史与模型可见历史不是一回事

`pi/packages/coding-agent/src/core/session-manager.ts` 保存追加式 Session Entry，并根据当前 Branch 构建 `buildSessionContext()`。正常情况下，User、Assistant、Tool Result 和 Custom Message 都会进入模型可见历史。

发生 Compaction 后：

- 原始 Entry 仍保留在 Session 文件中；
- 模型可见 Context 改为一条 `compactionSummary` 加保留的近期消息；
- `pi/packages/coding-agent/src/core/messages.ts` 把 Summary 转成 User Message，使用明确的 `<summary>` 包装。

这是一种“保留证据，替换活跃上下文”的设计，而不是删除历史。

### 3.5 Pi 的压缩政策

`pi/packages/coding-agent/src/core/compaction/compaction.ts` 的默认值是：

- `reserveTokens = 16,384`
- `keepRecentTokens = 20,000`
- 当 `contextTokens > contextWindow - reserveTokens` 时自动压缩

它从最近消息向前累计，尽量保留 `keepRecentTokens`，不在 Tool Call 与 Tool Result 之间切断；较早部分交给模型生成结构化摘要。若切点落在一个超长 Turn 中间，还会额外生成 Turn Prefix Summary。

这套默认值适合 Pi CLI 的通用 Coding Session，但不能自动成为 Chat 的产品政策：

1. 摘要本身是另一次模型请求；启用 Prompt Review 时也必须进入审核。
2. 摘要是模型输出候选，不能无版本、无来源范围地成为 Chat 长期事实。
3. Pi 的 Context Window 只看一个 Pi Session；Chat 还要处理跨 Product Run、跨 Workflow 的连续会话。

## 4. DSH 的真实设计

### 4.1 DSH 把 Prompt 组装成插件注册表

`packages/core/system-prompt/src/index.ts` 的 `SystemPrompt` 服务维护四类注册：

1. `PromptSection`：有唯一名称和 `order` 的 System Prompt 片段；同名 Scoped Section 可覆盖 Global Section。
2. `PromptContext`：有唯一名称和顺序的动态运行时上下文。
3. Tool Provider：贡献本轮可见 Tool Schema，并按稳定顺序输出。
4. Prompt Variable：例如 `provider`、`model`、`cwd`，在渲染时严格插值。

每个 Model Step 前，`ReactLoopAgent.preStep()` 都调用 `systemPrompt.assemble()`。`renderPrompt()` 把 Section 按顺序连接成 System；Context 则不是拼进 System，而是投影成 User Message。

这比 Pi 的数组参数多了两项重要能力：**贡献者身份**和**稳定覆盖/排序语义**。

### 4.2 DSH 的模型可见区域

DSH 最终的 `GenerateOptions` 定义在 `packages/llm/llm/src/types.ts`：

```text
GenerateOptions
├── system
├── messages[]
├── tools[]
├── provider / model
├── reasoningEffort / temperature / maxTokens / stop
├── sessionId
└── purpose: conversation | compaction | session-title
```

`packages/core/agent-loop/src/agent.ts` 在每个 Step 中：

1. 组装 System、Runtime Context 和 Tools；
2. 让 `agent/pre-step` 插件修改即将进入的 User Messages；
3. 把这些消息写入 Session Log；
4. 用 `session.deriveMessages()` 取得当前完整模型 Surface；
5. 构造并冻结请求，然后交给具体 LLM Adapter。

OpenAI 风格 Adapter 最终把 `system` 作为第一条 System Message，把历史 Messages、Tools 和参数序列化进 HTTP Body。若使用 `dsh-llm-pi-ai`，它会把同一结构转换成 Pi AI 的 `Context`；Prompt 管理权仍属于 DSH，而不是 Pi Coding AgentSession。

### 4.3 DSH 的 Context 不只有 Workspace 指令

固定 Base/Code Preset 中，常见的模型可见来源包括：

- Persona：例如“你是由某模型驱动的 Coding Agent”，属于 System Section。
- 每个 Tool Plugin 的使用说明，属于 System Section；Tool Schema 仍单独位于 `tools[]`。
- Workspace 指令：`dsh-agent-instructions` 发现用户全局与项目目录中的 `AGENTS.md`、`CLAUDE.md` 及 Local Overlay，按根目录到 cwd 的层级组装。Base 配置单批最多 `65,536` UTF-8 Bytes。
- Runtime Context：沙箱、审批等插件贡献命名 Context；`RuntimeContextProjection` 仅在快照变化时追加一条来源为 `@deepseek-ai/dsh-system-prompt` 的 User Message，并声明新快照替代旧快照。
- Skill Catalog 和显式 Skill 内容：`dsh-tool-skill` 在 `pre-step` 注入带来源的 User Message。
- 真正的 User Message、Assistant Message、Tool Call/Result。

所以 DSH 的 System 不是所有“系统性信息”的唯一容器；一部分动态说明故意以有来源的 User Message 进入 Session，便于耐久回放和变更替换。

### 4.4 DSH Session 是事件事实，Messages 是派生 Surface

`packages/core/session/src/index.ts` 的 `Session.deriveMessages()` 不直接维护一份可变聊天数组，而是从追加式事件日志和当前 Surface 派生 Messages。`request/header` 另外保存本轮 System、Tools 和模型配置快照。

DSH 的冻结规则是“Model-visible ⟺ Logged”：只要内容进入模型请求，就必须可以从 Session Log 重建。这使 UI、恢复和压缩都不需要猜当时的 Prompt。

### 4.5 DSH 的压缩政策

`dsh-compaction-basic` 的默认政策是：

- 模型上下文达到 `80%` 时触发压力压缩；
- 默认保留最近 `16%` 的 Context Window；
- 摘要最多 `8,192` Tokens；
- 默认允许 1 次压缩后复测；
- Provider 报 Context Overflow 时可以强制做一次有界恢复。

它先用 `dsh-compaction-tool-result-pruner` 做无模型裁剪。Base 配置对超过 `8,192` 字符的 Tool Result 保留头 `4,096` 和尾 `1,024` 字符，再决定是否需要模型摘要。

模型摘要请求会复用原请求的 System、Tools 和被压缩消息前缀，把压缩指令作为最后一条 User Message，以利用 Provider Prefix Cache。成功后，它把选中的 Surface 区域替换为一条带来源、带 `<compacted-summary>` 的 User Message；原始事件和 Summary 调用证据仍留在完整日志中。

与 Pi 相比，DSH 的优势不是“摘要写得更好”，而是压缩范围、替换关系、来源事件、模型调用和当前 Surface 都有耐久证据。

## 5. 两套上游与当前 Chat 的对照

| 方面 | Pi Coding Agent | DSH rc.6 | 当前 Chat |
|---|---|---|---|
| System | 一个 Builder，支持 default/custom/append/context/skills/cwd | 命名、排序、Scoped Override 的 Section Registry | Planner/Executor/Direct 各自硬编码 TS 常量 |
| 当前用户输入 | 本轮 User Message | `pre-step` claim 的 User Message | Bridge 只提交最新真实 User Message |
| 历史 | Pi Session Branch 的 Messages | Session Event Surface 的派生 Messages | Product Store 有完整 Message，但当前模型输入没有统一选择器 |
| 动态上下文 | Context Files、Skills、Extension | Workspace、Runtime Context、Skill 等带来源 User Message | Workspace/Memory/Project/Rule 已有冻结事实，但只在部分 Workflow 使用 |
| Tools | System 中有摘要，同时另传 Schema | System 中可有使用说明，同时另传 Schema | Planner/Executor/Direct 各自选 Tool，没有统一 Prompt Profile |
| 来源 | 主要靠 Loader 配置和文件位置解释 | 注册名、Scope、Message Source、Event Seq | Prompt Review 事后按字段猜来源，缺少生成时 Manifest |
| 压缩 | Session Summary + recent tail | Event Surface Replacement + durable provenance | Direct V1 关闭；跨 Product Run 尚无统一策略 |
| 最终原始请求 | Provider Adapter 生成 | LLM Adapter 生成 | Direct Prompt Review 已能在发送前冻结并审核 |

当前 Chat 最重要的事实缺口不是“没有 Prompt 字符串”，而是缺少一个统一回答以下问题的地方：

1. 这段内容属于哪个区域？
2. 谁创作、谁选择、谁组装、谁序列化？
3. 它绑定哪个 Product Fact、版本和 Hash？
4. 为什么本轮采用或排除？
5. 占了多少预算，超限时谁先退出？
6. 历史经过何种摘要或替换？
7. 最终 Provider Payload 中对应哪个 JSON Pointer？

### 5.1 当前 Direct Agent 的准确现状

`packages/pi-runtime/src/direct-agent-executor.ts` 每个 Product Run 创建一个新的 Pi Session，只把当前 `sourceMessage` 交给 `session.prompt()`，因此它目前具备同一 Run 内 Tool Loop 连续性，不具备同一 Product Session 跨多条用户消息的模型上下文连续性。

它还明确配置：

- `systemPrompt: ""`：配置值为空；Pi 的 truthy 判断会回退到默认基础 System，并不是关闭默认 System；
- `appendSystemPrompt: DIRECT_AGENT_APPEND_SYSTEM_PROMPT`；
- 禁用 Context Files、Skills、Prompt Templates、外部 Extensions、Compaction 和 Retry；
- 只启用 `read/grep/find/ls`；
- 关闭 Thinking；
- 每次 Provider Request 进入 Prompt Review Gate。

因此当前审核页把 Direct System 来源解释为“Pi 基础系统指令、工具摘要、准则和文档路径”在高层上是符合代码事实的；真正的问题是它把整条 System Message 统一关联到几份文件，没有记录默认正文、Chat Append 和 cwd 各自的片段边界、版本与实际 JSON Pointer。真正可见的内容仍以原始 Payload 为准，来源说明则应在组装时由 Manifest 记录，不能只由 UI 根据 Role 和文件名推测。

### 5.2 当前一次 DSH 交互实际有两次组装

使用 LifeOS Provider 时，DSH 和 Chat/Pi 并不是共同维护一份 Prompt：

```text
DSH User Input
→ DSH pre-step 组装 DSH System / History / Context / Tools
→ LifeOS Adapter 收到 DSH GenerateOptions
→ Adapter只提取最新真实User Message，以及当前Surface中的Workspace指令
→ Chat提交Product Message并启动所选Workflow
→ Chat节点重新组装自己的Pi请求
→ Provider Review / Provider
→ Chat正式Assistant Message回投DSH
```

`packages/dsh-lifeos-bridge/src/adapter.ts` 的 `lastUserPrompt()` 只认 `source.kind === "user"` 的最后一条真实 User Message；`workspaceInstructionsOf()` 只提取 `source.kind === "agent-instructions"`。DSH 自己的 Persona、完整 History、Runtime Context、Skill Catalog 和 Tool Schema 都不会被透传到 Chat 模型请求。

这个隔离本身是正确的：它阻止 DSH 宿主能力偷偷变成 Chat 权限。但它也说明连续会话不能依赖“DSH 已经组装过历史”，Chat 必须从自己的 Product Store 明确选择。

同一 Adapter 还把 DSH 的 `purpose=session-title|compaction` 视为宿主辅助工作：标题直接取可见用户文本，Compaction 只对最近 12 条可见消息生成有界本地摘要，不访问 Chat、不创建 Product Message/Run。于是当前部署同时存在“DSH Surface 的宿主压缩”和“Chat 模型上下文管理”两件事；前者不能替代后者，也不能修改 Chat 的完整历史。

### 5.3 当前散落的 Chat Prompt 入口

| 场景 | System/规则 | User/上下文组装 | 当前历史来源 |
|---|---|---|---|
| Planner | `packages/pi-runtime/src/planner.ts#PLANNER_SYSTEM_PROMPT` | `buildPlannerUserPrompt()` 拼接 Workspace、当前需求、Memory、Project、Rule、Prior Plan | 只有显式 Prior Plan，不是普通会话历史 |
| 结构化 Executor | `packages/pi-runtime/src/executor.ts#EXECUTOR_SYSTEM_PROMPT` | `buildExecutorUserPrompt()` 拼接 Execution Contract、当前 Step、冻结 Context 和依赖结果 | 只读当前 Execution Contract |
| 完整 Coding Executor | Pi 默认 System + `packages/pi-runtime/src/coding-agent-executor.ts` 的 Chat Append | `buildExecutorUserPrompt()` 作为 Pi User Prompt | 单个执行 Operation 的 Pi Session |
| Direct Agent | Pi 默认 System + `DIRECT_AGENT_APPEND_SYSTEM_PROMPT` | 当前 Product Run 的 `sourceMessage` | 单个 Direct Run 的 Pi Session |
| 审核可读版 | 不参与请求 | `packages/application/src/prompt-review-readable.ts` 事后拆 Raw Payload | 按 Role 推测来源 |

Application 已经能冻结 Workspace、Memory、Project 和 Rule 等产品事实，但不存在一个统一 Compiler 决定这些事实如何进入不同 Agent。Direct Run 虽然也会创建通用 `ContextRequest`，当前 `authorizeDirectAgentOperation()` 只把 `sourceMessage`、只读能力和预算交给执行器；因此 Direct Prompt 不会自动继承 Planning 已支持的那些 Context。

## 6. Chat 的推荐设计

### 6.1 不新增第二套 Agent Loop

复用决策如下：

- **直接使用 Pi**：AgentSession、Tool Loop、Provider Adapter、同一 Run 内消息推进。
- **借鉴 DSH，不直接复用为权威**：命名 Region、来源链、稳定排序、模型可见内容可重建、压缩替换不删除证据。
- **Chat 自研**：Product Fact 选择、跨 Run 会话上下文、节点 Prompt Profile、预算、压缩决定、来源 Manifest 和 Prompt Review 投影。
- **明确拒绝**：从 DSH Transcript DOM 或 Pi Session 文件反推 Chat 的长期上下文；让 Workflow Checkpoint、DSH Session 或 Pi Session 成为第二套 Product Store。

### 6.2 六个顶层区域

第一版只定义 6 个用户可理解的 Region，避免一开始制造过多概念：

| Region | 内容 | 典型子来源 |
|---|---|---|
| `system` | 不能被普通上下文覆盖的节点身份、边界和行为规则 | Chat 产品规则、Agent 类型、Workflow/Node 指令 |
| `current_input` | 本轮明确要处理的输入 | 当前 Product User Message、前序节点输出 |
| `conversation` | 为理解连续对话选入的已提交历史 | Conversation Summary、近期 User/Assistant 成功对 |
| `reference_context` | 可采用但不自动授权的背景材料 | Workspace、Memory、Project、Rule、文件片段 |
| `tools` | 可调用能力及模型可见 Schema/说明 | Capability Profile、Tool Schema、调用约束 |
| `request_options` | 非自然语言请求控制 | Provider、Model、Thinking、Token、Temperature、Stop |

Tool Result 和 Assistant Tool Call 属于 `conversation` 的运行中消息；工具定义属于 `tools`。这样既符合 Provider 结构，也不会把“工具是什么”和“工具刚刚返回了什么”混在一起。

### 6.3 Prompt Fragment

每个进入编译器的片段至少记录：

```ts
interface PromptFragment {
  fragmentId: string;
  region: PromptRegion;
  content: PromptContent;
  order: number;
  required: boolean;
  priority: number;
  source: {
    owner: "chat" | "user" | "dsh" | "pi" | "provider";
    productRef?: { objectId: string; revision: number; sha256: string };
    codeRef?: { package: string; exportName: string; templateVersion: string };
  };
  selection: "required" | "explicit" | "recent" | "retrieved" | "runtime";
  sha256: string;
}
```

`codeRef` 是模板来源，不把本机绝对路径写进产品事实；前端可通过版本对应的 Source Catalog 显示仓库相对路径。`productRef` 绑定真实用户资料或 Message。正文、引用、模板版本和最终编译结果分别 Hash，避免“来源没变但内容已漂移”。

来源需要表达一条链，而不是只显示“来自某文件”：

```text
作者/事实所有者 → 选择者 → 组装器 → Provider 序列化器 → Payload JSON Pointer
```

例如当前 Direct 节点 System 应显示：

```text
Chat Direct Profile
  authored at packages/pi-runtime/src/direct-agent-executor.ts#DIRECT_AGENT_APPEND_SYSTEM_PROMPT
  selected by direct Prompt Profile revision N
  assembled by Pi buildSystemPrompt(default + append=[...] + cwd)
  serialized by Pi OpenAI-compatible adapter
  located at /messages/0/content in this reviewed payload
```

其中只有最后一行依 Provider 格式变化；前面的来源不会由 UI 猜测。

### 6.4 Prompt Profile

每个可调用模型的 Workflow Node 绑定一个版本化 `PromptProfile`，而不是直接绑定一大段字符串：

```text
PromptProfile
├── agentType: planner | executor | direct
├── template refs and versions
├── allowed regions and source kinds
├── history policy
├── context selection policy
├── capability/tool profile
├── review mode: manual | off
├── compaction policy
└── budget policy
```

用户以后在前端配置节点时，编辑的是这些允许公开的字段；安全边界、Product Commit 规则和 Credential 处理不是可关闭的普通 Prompt 文本。

同一个执行类 Pi Agent 可以因此服务多个 Workflow：普通 Direct 节点把 `reviewMode=off`，审核工作流把它设为 `manual`；两者使用同一个 Agent 类型和 Prompt Compiler，不复制一套 Executor。

### 6.5 Prompt Assembly Manifest

每次真正 Provider 请求前，Chat 都应生成或补全一份 Manifest：

- Profile ID/revision/hash；
- 采用的 Fragment ID、版本、Hash、顺序与 Token/Byte 估算；
- 排除的 Fragment 及稳定 Reason Code；
- Conversation Summary 与原始 Message 范围；
- Tool Profile；
- 最终 `system/messages/tools/options` 各字段 Hash；
- Provider Adapter 产生最终 Payload 后的 JSON Pointer 映射；
- 最终 Payload Hash 和 Prompt Review Request ID（若开启审核）。

Manifest 是来源和选择证据，不重复保存完整 Provider Payload。完整待发正文继续只在 Prompt Review Request 保存一次；Workflow、Trace 和 Pi Journal 只保存 Ref/Hash。

### 6.6 各层职责

```text
DSH
  提供 UI、当前真实用户输入、用户显式选择的宿主 Context
        ↓
Chat Application / Prompt Compiler
  读取 Product Store 事实 + 当前 Node Prompt Profile
  选择 Fragment、分配预算、冻结 Assembly Manifest
        ↓
Workflow Node
  只传 Run/Node/Manifest 引用，负责耐久推进
        ↓
Pi AgentSession
  接受已编译的 System / initial Messages / Tools
  负责同一 Run 内 Tool Loop
        ↓
Provider Adapter + Review Gate
  生成最终原始 Payload，绑定 Manifest Pointer，按开关暂停审核
```

DSH 原生 Workspace Context 可以作为一个来源 Provider，但只有 Chat 明确选择并冻结的内容才进入 Chat Prompt。DSH 的 Skill Catalog、沙箱快照或其他 Context 不会因为它们出现在 DSH Session 中就自动进入 Chat。

## 7. 连续 Product Session 如何迭代

### 7.1 两种连续性必须分开

1. **同一个 Product Run 内**：Pi AgentSession 负责多轮 Tool Loop；每次 Provider Request 使用新增 Assistant/Tool Result 更新上下文。
2. **同一个 Product Session 的不同消息/Run 之间**：Chat Prompt Compiler 从 Product Store 的正式历史重新选择；不能默认沿用上一个 Pi Runtime Session。

这使用户在同一会话内切换 Planning、Direct 或未来其他 Workflow 时，历史仍是一份 Chat 产品事实，而每个节点按自己的 Profile 决定读取多少、以何种形式读取。

### 7.2 第一版历史选择建议

V1 建议采用保守规则：

1. 当前 User Message 永远必选。
2. 最近成功 Product Commit 的 `User → Assistant` 对按时间倒序选入。
3. 失败、取消或 `outcome_unknown` Run 的候选输出不进入默认模型上下文；它们仍保留为证据。
4. 未形成正式 Assistant Message 的历史 User Message也不默认作为待办重放，避免新 Workflow 误把旧失败请求当成本轮指令；用户若继续该目标，应在当前输入中明确引用。
5. Workspace、Memory、Project 和 Rule 不混入 Conversation History，走各自的 `reference_context` 选择和版本冻结。
6. 切换 Workflow 不复制历史，只换当前 Node 的 Prompt Profile。

这是一个需要 Later 审核的产品选择。另一种方案是保留所有正式 User Message，即使上一 Run 失败；它更“像聊天”，但也更容易把未完成旧请求重新激活。

### 7.3 跨 Run 压缩

Chat 不应直接采用 Pi 自动 Compaction 作为跨 Run 事实。推荐新增一类版本化 `ConversationSummary`：

```text
ConversationSummary
├── Product Session ID
├── source message range + every message hash
├── summary body + revision + hash
├── summarizer profile/model/request evidence
├── status: candidate | committed | superseded | rejected
└── retained recent boundary
```

生成摘要是辅助模型调用，也遵守当前节点的 Review Policy；摘要先是 Candidate，校验和提交后才能替代较早 Message 进入模型上下文。原始 Message 永不删除，Summary 只改变本次 Assembly 的活跃视图。

Direct V1 现在关闭 Pi Compaction 是正确的安全默认。Chat 跨 Run Summary 打通后，再决定是否启用 Pi 的 Run 内 Compaction；若启用，它的每次 Summary 请求也必须经过相同 Provider Gate，并把压缩范围证据投影回 Chat。

## 8. Token、字符与字节预算

不建议给六个 Region 先写死一组百分比。不同模型、工具数量和任务类型差异太大。第一版使用“硬边界 + 优先级分配”：

1. 从模型元数据取得 Context Window `C`。
2. 冻结输出预留 `O`，再保留 Provider 安全余量 `M`。
3. 模型输入硬上限为 `min(C - O, floor(0.8 × C)) - M`。`80%` 是可配置初始值，来自 DSH 的成熟默认，不是永久产品常量。
4. 先放不可裁剪的必需 Fragment：安全 System、当前输入、最小 Tool Schema。
5. 再按 Profile 的 Priority 放 Conversation、Reference Context 和扩展 Tool 说明。
6. 超预算时只按稳定规则排除可选 Fragment，并在 Manifest 记录原因；必需 Fragment 本身超限则在 Provider 前失败，不做静默截断。
7. 文本预算以 Provider 对应 Tokenizer 为优先；没有稳定 Tokenizer 时用保守估算并加入 Margin。不能信任外部 Memory 自报的 Token 数。
8. 字符/UTF-8 Byte 上限用于文件读取、Product DTO 和 HTTP 传输安全，不代替模型 Token 预算。
9. Tool Result 先做确定性裁剪或 Artifact 引用，再触发模型摘要；参考 DSH 的“先无模型 Prune、再 Summary”，但裁剪值由 Chat Profile 配置。
10. Prompt Review 的 Raw 继续完整展示。任何上游预算裁剪必须在 Assembly 阶段已经发生，并在可读视图标出排除项；审核页绝不把被截断展示冒充完整请求。

首个实现不必一次做精确 Tokenizer。可以先把同一保守估算器用于 Application、Store Integrity 和 UI，等真实 Provider Usage 数据稳定后再替换 Provider-aware Meter。

## 9. Prompt Review 如何与新管理模型结合

Raw 页不变：只展示真正待发的 Canonical Provider Payload。

Readable 页以后不再按 `message.role` 静态猜来源，而是读取 Assembly Manifest，按 6 个 Region 展示：

```text
系统指令
  Fragment、正文、作者、模板版本、选择者、组装器、Payload位置

当前输入
  Product Message ID/revision/hash、正文、Payload位置

会话上下文
  Summary或正式Message范围、采用/排除原因、Token

参考上下文
  Workspace/Memory/Project/Rule来源与版本

工具
  Capability Profile、Tool Schema来源、是否可调用

请求参数
  Provider/Model/Thinking/Token来源与实际值
```

所有标题、解释、来源标签都明确标记为 UI Metadata，不进入模型请求；区域正文必须能通过 JSON Pointer 回到 Raw 的真实字段。若某个 Raw 字段无法映射，Readable 页新增“未归类原始字段”，不能丢失或自作解释。

## 10. 建议实施顺序

在本设计审核通过后，建议按 3 个小纵向推进：

1. **来源先行**：定义 Prompt Region、Fragment、Profile 和 Assembly Manifest；先接 Direct Agent。Raw 不变，Readable 改为消费真实 Manifest，修正当前错误来源说明。
2. **连续会话**：Direct Agent 在每个新 Product Run 中从正式 Product Message 选择近期成功对；前端展示采用/排除历史。暂不启用模型摘要。
3. **压缩与统一**：增加 Conversation Summary Candidate 和预算策略，再把 Planner、Execution Agent 迁移到同一 Compiler。

每一步都能独立在 DSH 前端体验，不要求先完成一个巨大的 Prompt 平台。

## 11. 需要 Later 审核的 4 个产品选择

1. 历史默认是否只纳入成功提交的 `User → Assistant` 对；本文建议“是”。
2. Prompt Profile 的用户配置第一版是否只开放 `reviewMode`、历史深度、Context 开关和预算，而不开放安全 System 正文；本文建议“是”。
3. 跨 Run 压缩摘要是否必须先成为可追溯 Candidate 再提交；本文建议“是”。
4. 首个实现是否只改 Direct Agent，体验稳定后再迁移 Planner/Executor；本文建议“是”。
