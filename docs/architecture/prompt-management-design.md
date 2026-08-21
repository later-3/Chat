# Chat 提示词管理：上游事实与设计草案

> 状态：Prompt管理三模块架构已获产品确认；Prompt Studio、Agent默认—Workflow节点实例—Session/Run临时覆盖三层配置、会话上下文选择、语义预览、Workflow Prompt Assembly v3、Direct Prompt Assembly v2、近期正式跨Run历史和Direct Review来源投影已实现。Runtime Review编辑、摘要/压缩以及非Direct节点的Provider Review仍按本文后续阶段推进。
>
> 调研基线：Chat `main@f1315ef`；Pi `later-3/pi@1f2b9ff`（npm 基底 `0.84.2`）；DeepSeek Harness `0.1.0-rc.6@15148dbd9a`。DSH 后续窄派生提交只涉及 Trajectory，不改变本文引用的 Prompt 与 Session 机制。
>
> 本文确定提示词的所有权、组成、来源、连续会话和预算方向，并记录已交付的管理、Direct四通道Chat输入组装与最终Payload Review，以及Planner、Coding Executor、Note Extractor的节点Prompt纵向。
>
> 三个真实 Agent 的逐请求实验、宿主预注入与模型 Tool Call 的因果区分，以及真实压缩请求证据已迁入个人学习资料[《Pi、DeepSeek Harness 与 Hermes 的真实上下文组装实验》](../../learning/agent-context-management/real-request-experiments.md)。该资料不是Chat合同；若本文的上游事实概括与固定源码、实验记录冲突，以固定源码和实验记录为准。

## 1. 结论先行

Later 对现状的判断基本正确，但需要补一层边界：

1. Pi Coding Agent 已经有完整的单个 AgentSession 组装逻辑。它管理系统提示词、消息历史、工具定义、模型参数、Tool Loop 和会话内压缩。
2. DSH 也有完整逻辑，而且比 Pi 更强调插件化来源：系统提示词由带名称和顺序的 Section 组成，动态 Context 作为带来源的耐久 User Message 进入 Session，工具 Schema 独立组装，模型可见内容必须能从 Session Log 重建。
3. Chat 不是完全没有提示词逻辑。Planner、Executor、Direct Agent、Memory/Rule/Workspace Context 和 Prompt Review 已各自实现了一部分；问题是它们散落在不同 TypeScript 文件和上游默认行为里，没有统一的区域、来源、优先级、预算、跨 Run 历史和压缩合同。
4. Chat 不应复制 Pi Agent Loop，也不应让 DSH Session 成为 Chat Prompt 的权威来源。推荐保留 Pi 负责一次 Agent 运行内部的循环和 Provider 适配，让 Chat 新增一个产品级 `Prompt Profile + Prompt Compiler + Assembly Manifest`，管理“这一节点为什么把哪些事实交给模型”。
5. 同一个 Product Session 可以逐条消息选择不同 Workflow。连续会话上下文必须从 Chat Product Store 的正式 Message/Context 事实编译，而不是复用 DSH 隐藏上下文或默认继承某个 Pi Session。

### 1.1 三个相互独立、按顺序交付的模块

Chat 的 Prompt 能力固定拆成 3 个模块，不能再把“保存一段文字”“组装 Provider 请求”和“发送前人工审核”混成一个对象：

1. **Prompt 模型与组装基础**：定义 Region、版本化 Fragment、Profile、Compiler 和 Assembly Manifest。Git 拥有内置 Markdown；用户正文位于Chat全局或目标Workspace的可见Markdown文件；Product Store拥有身份、权限、版本链、Hash、文件引用和每次Run的冻结Assembly。
2. **Prompt 管理工作台**：DSH「设置 → 提示词」只管理区域、组件和版本。内置组件只读，修改必须创建用户副本；用户组件通过 CAS 追加不可变 Revision。本模块不调用模型、不启动 Workflow。
3. **Workflow Runtime 控制**：每个 Pi Agent 节点可配置 `reviewMode=off|manual`。`manual` 在真实 Provider 请求边界暂停，显示 Raw 与基于 Assembly Manifest 的可读来源，并允许批准、拒绝；以后若允许编辑，编辑结果必须成为新的待审 Revision/Hash。

这三个模块的依赖方向是：管理事实 → 组装选择 → Runtime 冻结/审核。Prompt Studio 不是 Workflow 节点；Prompt Review 是 Agent 节点内部能力，也不需要额外画成人工节点。

### 1.2 Agent配置只用三层，不建立通用继承系统

1. `Agent Profile`是Chat全局模板。Chat自研Agent的默认System Prompt来自Git Catalog；Pi-backed Agent的默认值直接继承Pi运行时，自定义正文则完整替换Pi基础System。它不能复制或冒充上游Agent的默认Prompt与Tool实现。
2. `Workflow Node Binding`是工作流里的Agent实例。它引用一个支持该节点类型的Agent，并只保存相对默认值的Prompt差异；系统Workflow不能原地修改，保存时派生个人已发布版本。
3. `WorkflowRunConfiguration`是当前Session发送草稿。它可临时覆盖同一节点的Agent引用或Prompt；创建Run时Application校验、规范化并冻结进RunSpec和Prompt Assembly，之后不再读取浏览器草稿。

优先级固定为`Run临时差异 > Workflow节点差异 > Agent默认`。正文仍是普通Markdown；Workflow差异直接进入不可变Definition JSON，不新增表、规则语言、Mixin或多重继承。Tool授权不参与这条覆盖链。

Pi-backed Agent另有一层不可写的运行时基线，但它不属于上述配置继承链。独立Pi Executor通过真实`pi-coding-agent AgentSession`生成基线，并经带Runtime Key的私有只读接口实现Application的`AgentRuntimeProfileReaderPort`；API进程不会加载完整Pi Coding Agent。基础System在`Pi默认动态System`与`Chat用户完整覆盖`之间二选一，之后始终追加`Chat固定运行约束`与本轮上下文；前端按同样顺序展示，并按Execution Capability切换实际Tool Schema。Chat不复制Pi的默认Prompt或Tool Schema；每个Run中受Workspace路径、工具回合和Provider适配影响的最终逐字节正文，仍只以Provider前Prompt Review为准。

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
| System | 一个 Builder，支持 default/custom/append/context/skills/cwd | 命名、排序、Scoped Override 的 Section Registry | 所有Prompt-bearing节点采用锁定节点Contract + 冻结有效Agent/会话用户层；Direct另有四通道v2与最终Payload Review |
| 当前用户输入 | 本轮 User Message | `pre-step` claim 的 User Message | Bridge 只提交最新真实 User Message |
| 历史 | Pi Session Branch 的 Messages | Session Event Surface 的派生 Messages | Direct v2从Product Store选择近期成功User/Assistant对；其他节点尚未迁移 |
| 动态上下文 | Context Files、Skills、Extension | Workspace、Runtime Context、Skill 等带来源 User Message | Chat节点只接受显式Prompt选择；Direct/Coding Executor自动Context/Skill/Template发现关闭 |
| Tools | System 中有摘要，同时另传 Schema | System 中可有使用说明，同时另传 Schema | 工具由节点Runtime Contract决定，用户Prompt层不能增权；Direct v2另冻结Tool Profile |
| 来源 | 主要靠 Loader 配置和文件位置解释 | 注册名、Scope、Message Source、Event Seq | v3绑定共享/节点Revision、MD路径、Scope与Hash；Direct Review另绑定Payload Pointer |
| 压缩 | Session Summary + recent tail | Event Surface Replacement + durable provenance | Direct v2关闭；跨 Product Run Summary尚未实现 |
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

`packages/pi-runtime/src/direct-agent-executor.ts` 每个Product Run创建一个新的Pi Session。Application先冻结`direct-agent-prompt-compiler.v2` Assembly，Executor再把其中的正式历史Messages写入同一Session，最后以当前Product Message调用`session.prompt()`。因此它同时具有：

- 同一Run内由Pi负责的Tool Loop连续性；
- 同一Product Session跨Run、由Chat Product Store重新选择的近期成功`User → Assistant`历史；
- 当前输入仍是最后一条原始`role:user`消息，而不是拼接后的伪历史文本。

它明确配置：

- 不传空字符串覆盖Pi System，稳定使用固定Pi默认基础System；
- `appendSystemPrompt = Chat Direct运行约束 + Assembly命名System Region`；
- `noContextFiles/noSkills/noPromptTemplates/noExtensions=true`，Pi不能自行装载`AGENTS.md`或其他宿主上下文；
- 禁用Compaction和Retry，Thinking固定为off；
- 只启用冻结的`read/grep/find/ls`只读能力；
- 每次Provider Request都进入Prompt Review Gate。

当前审核页的Raw始终以真实Payload为准。易读页读取同一Run的Assembly，把System组件、正式历史、当前User、Runtime Tool消息、Tools与Request Options映射到精确JSON Pointer；来源说明不进入模型请求。DSH→Bridge、Bridge→Chat和Provider三类Prompt审核共用右侧全高审查面板，顶部状态和底部决定固定，中间只有一个纵向滚动容器；正文`pre`只保留必要的横向滚动，不再与页面形成嵌套纵向滚动。

### 5.2 当前一次 DSH 交互实际有两次组装和三道可选审核

使用 LifeOS Provider 时，DSH 和 Chat/Pi 并不是共同维护一份 Prompt：

```text
DSH User Input
→ DSH pre-step 组装 DSH System / History / Context / Tools
→ 可选DSH→Bridge审核完整GenerateOptions
→ LifeOS Adapter 收到 DSH GenerateOptions
→ Adapter提取最新真实User Message，并携带会话共享层与当前Workflow节点Prompt选择
→ 可选Bridge→Chat审核实际将交给fetch的Command Plan/bodyJson
→ Chat原子提交Product Message、Prompt Assembly并启动所选Workflow
→ 每个Prompt-bearing节点只从冻结Assembly读取自己的用户层
→ 可选Provider Review审核Credential注入前最终Payload / Provider
→ Chat正式Assistant Message回投DSH
```

`packages/dsh-lifeos-bridge/src/adapter.ts` 的 `lastUserPrompt()` 只认 `source.kind === "user"` 的最后一条真实User Message。DSH自己的Persona、完整History、`agent-instructions`、Runtime Context、Skill Catalog和Tool Schema都不会被透传到Chat模型请求；`agent-instructions`只保留为DSH Session证据与只读上下文面板。Bridge第二道审核展示的`bodyJson`与实际HTTP请求体来自同一冻结Builder，审核决定绑定Plan Hash；它不是从Friendly视图反向重建Raw。

这个隔离本身是正确的：它阻止 DSH 宿主能力偷偷变成 Chat 权限。但它也说明连续会话不能依赖“DSH 已经组装过历史”，Chat 必须从自己的 Product Store 明确选择。

同一 Adapter 还把 DSH 的 `purpose=session-title|compaction` 视为宿主辅助工作：标题直接取可见用户文本，Compaction 只对最近 12 条可见消息生成有界本地摘要，不访问 Chat、不创建 Product Message/Run。于是当前部署同时存在“DSH Surface 的宿主压缩”和“Chat 模型上下文管理”两件事；前者不能替代后者，也不能修改 Chat 的完整历史。

### 5.3 当前散落的 Chat Prompt 入口

| 场景 | System/规则 | User/上下文组装 | 当前历史来源 |
|---|---|---|---|
| Planner | 独立Planner Agent Profile + v3会话上下文 | `buildPlannerUserPrompt()` 拼接Workspace、当前需求、Memory、Project、Rule、Prior Plan | 只有显式Prior Plan，不是普通会话历史 |
| 结构化 Executor | `packages/pi-runtime/src/executor.ts#EXECUTOR_SYSTEM_PROMPT` | `buildExecutorUserPrompt()` 拼接 Execution Contract、当前 Step、冻结 Context 和依赖结果 | 只读当前 Execution Contract |
| 完整 Coding Executor | 独立Coding Executor Agent Profile + v3会话上下文 | `buildExecutorUserPrompt()`作为Pi User Prompt | 单个执行Operation的Pi Session |
| Direct Agent | 独立Direct Agent Profile + Assembly会话上下文 | Assembly Messages Regions + 当前Product Message | 单个Direct Run的Pi Session |
| Note Extractor | 独立Note Extractor Agent Profile + v3会话上下文 | 正式Session Message候选 | 当前Note运行输入 |
| 审核可读版 | 不参与请求 | 拆Raw Payload并关联同Run Assembly来源 | Assembly精确来源；其他字段仍按Runtime/Adapter定位 |

Application为Direct冻结Provider-ready v2 Assembly；对多节点Workflow冻结v3 Assembly。每个模型节点的Assembly由“按三层优先级解析出的有效Agent Prompt + 同一份会话上下文”组成。`生成计划`、`执行计划`只是节点显示名，不是Agent类别；页面显示的是该节点引用哪个Agent、是否继承默认以及是否存在Workflow/Run差异。Planning/Execution Input Manifest继续独立冻结Workspace、Memory、Project、Rule等产品事实，并额外绑定对应节点Assembly Hash；Prompt文字不会暗中扩大节点能力。

## 6. Chat 的推荐设计

### 6.1 不新增第二套 Agent Loop

复用决策如下：

- **直接使用 Pi**：AgentSession、Tool Loop、Provider Adapter、同一 Run 内消息推进。
- **借鉴 DSH，不直接复用为权威**：命名 Region、来源链、稳定排序、模型可见内容可重建、压缩替换不删除证据。
- **Chat 自研**：Product Fact 选择、跨 Run 会话上下文、节点 Prompt Profile、预算、压缩决定、来源 Manifest 和 Prompt Review 投影。
- **明确拒绝**：从 DSH Transcript DOM 或 Pi Session 文件反推 Chat 的长期上下文；让 Workflow Checkpoint、DSH Session 或 Pi Session 成为第二套 Product Store。

### 6.2 语义区与 Provider 物理区分开

Provider最终物理结构固定为`system + messages[] + tools[] + request options`，另有一个模型不可见的Assembly Manifest。Prompt Studio管理的是更细的**语义区**；Region不是Provider新字段。增加语义Region只需发布Catalog版本，不改变四个物理通道；只有未来新增新的物理通道时，才需要升级Compiler与Assembly schema。

当前目录共20个区域。Direct v2先把所有用户可管理内容作为带稳定标题的System段落；历史与当前输入继续保持正式Message角色，Tools和Request Options独立传输：

| Region | 用户可编辑 | 计划位置 | 含义 |
|---|---:|---|---|
| `agent_identity` | Agent默认、Workflow节点或Run临时差异 | system | Agent身份、职责与工作方式；不属于会话上下文Prompt |
| `workspace_instructions` | 是 | system | 用户显式选择的平台或目标Workspace指令，如根`AGENTS.md` |
| `user_context` | 是 | system | 完成任务确实需要知道的用户资料和偏好 |
| `background` | 是 | system | 背景、现状和边界 |
| `objective` | 是 | system | 本次运行希望达成的结果 |
| `requirements` | 是 | system | 必须满足的交付要求 |
| `rules` | 是 | system | 本次运行必须遵守的规则和规范 |
| `experience` | 是 | system | 可复用的方法、经验和注意事项 |
| `examples` | 是 | system | 希望模型参考的正向案例 |
| `counterexamples` | 是 | system | 需要避免的错误做法和反例 |
| `output_contract` | 是 | system | 输出格式、结构和验收约定 |
| `custom_context` | 是 | system | 用户扩展的命名Key/Value上下文 |
| `runtime_contract` | 否 | system | Chat、Workflow 和 Agent Runtime 强制执行的节点边界 |
| `current_input` | 否 | messages | 当前 Product Message 或前序节点输入 |
| `conversation` | 否 | messages | 明确选入的正式历史与同 Run Tool Loop 消息 |
| `platform_workspace` | 否 | messages | 预留的平台Workspace运行引用；当前不自动注入文件正文 |
| `target_workspace` | 否 | messages | 用户在DSH选择的工作对象Workspace身份；当前同时决定Direct只读Tool Root |
| `memory` | 否 | messages | 未来由 Memory Provider 选择并冻结的事实 |
| `tools` | 否 | tools | Tool Schema、说明和能力边界 |
| `request_options` | 否 | request_options | Provider、Model、Thinking、Token 等参数 |

这些Region是面向用户的管理分类；System是首个Direct Profile选择的模型物理位置，不意味着这些概念永远被架构写死在System。未来Profile可为特定Region发布新的映射版本，但同一个Assembly必须记录当时实际位置。Tool Result和Assistant Tool Call属于`conversation`运行消息；工具定义属于`tools`。

Region key 是受限稳定字符串，不是封闭 enum。增加新区域只需发布 Catalog 新版本；已有 Prompt Revision 无需 Store schema 迁移。

### 6.2.1 Workspace选择合同

Workspace同时承担两件不同的事，不能混为一谈：

1. **Prompt Scope**：平台Chat根和目标Workspace根都可以拥有自己的Prompt Markdown。用户在Composer中显式选择某个Revision后，Chat读取正文并把它冻结进Assembly；例如根`AGENTS.md`被投影为`workspace_instructions`组件。
2. **Agent Tool Root**：DSH当前打开目录经Bridge映射成已登记`rootId`，Direct以该目标根作为只读cwd。它决定Tool可以访问哪里，但不会自动把文件内容加入Prompt。

Direct v2明确关闭Pi的Context Files、Skills、Prompt Templates与Extension发现。因此“模型自己递归读取AGENTS”不是Chat机制。平台Chat根的`AGENTS.md`只作为全局可选组件，目标根的`AGENTS.md`只作为该Workspace可选组件；两者都必须由用户选择，正文才进入System。

安全边界：

- DSH Workspace身份不是文件权限；Bridge必须映射为服务端登记的Chat `rootId`；
- Catalog只发现登记根的精确`AGENTS.md`，不递归父级或子目录；
- 浏览器不能提交绝对路径、正文Hash或owner；Application按Revision ID/Hash重新读取；
- 文件Adapter拒绝symlink逃逸，并分别限制在Git Catalog、Chat全局Prompt目录与目标Workspace `.chat/prompts`；
- 当前Agent只有单一目标Tool Root且固定只读；未来双Root或写能力需要独立Capability合同，不能由Prompt选择暗中授予。

### 6.3 Prompt Fragment

每个进入编译器的片段至少记录来源、内容证据和选择证据。用户版本的长期正文位于可见Markdown，Product Revision保存引用：

```ts
interface PromptFragment {
  fragmentId: string;
  region: PromptRegion;
  contentRef: {
    kind: "markdown" | "key_value";
    contentSha256: string;
    sourceRelativePath: string;
    sourceFileSha256: string;
  };
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

Git内置正文由Catalog路径拥有；全局用户正文位于Chat`.data/prompts/global`，Workspace正文位于该根`.chat/prompts`。产品事实不保存本机绝对路径。Application读取文件后同时校验内容Hash和文件Hash，再把本轮实际正文冻结进Prompt Assembly；这避免长期库正文与运行证据互相漂移。

来源需要表达一条链，而不是只显示“来自某文件”：

```text
作者/事实所有者 → 选择者 → 组装器 → Provider 序列化器 → Payload JSON Pointer
```

例如当前 Direct 节点 System 应显示：

```text
Chat Direct Profile
  authored at packages/pi-runtime/src/direct-agent-executor.ts#DIRECT_AGENT_APPEND_SYSTEM_PROMPT
  selected by direct Prompt Profile v2
  assembled by Chat Prompt Compiler into appendSystemPrompt
  combined with Pi fixed default System by AgentSession
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

当前组装把“可管理内容”和“不可覆盖运行契约”明确分层：

```text
锁定Runtime Contract
→ Pi基础Agent/Harness Contract
→ Agent默认或当前Definition Node差异
→ 当前Run临时差异
→ 会话共享Prompt选择
→ 当前输入/正式历史/节点上下文/Tools/Request Options
```

会话上下文Region继续使用`default / replace / append`；Agent身份不复用这套多值Region组合，而只按`Run > Workflow Node > Agent Default`选出一个有效System Prompt。任何`replace`都不能删除或重写工具白名单、结构化输出、审批、预算、安全和Product Commit规则。共享默认Revision清单属于Git Catalog并进入Catalog Hash，不属于Bridge代码常量。

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
  提供 UI、当前真实用户输入、会话共享与Workflow节点Prompt选择
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

DSH与Bridge两道调试审核属于边界观察/放行能力，不拥有Prompt事实，也不进入Workflow图；Provider Review属于Agent节点内部的真实模型发送闸门。三个开关彼此独立，关闭时自动放行，开启时按数据流顺序等待。

DSH原生Workspace Context保留在DSH Session及只读面板中，不是Chat Prompt旁路。平台或目标Workspace内容若要进入Chat，必须先由Chat Catalog投影为有Revision/Hash的组件，再由用户显式选择并冻结。DSH的Skill Catalog、沙箱快照或其他Context不会因为它们出现在DSH Session中就自动进入Chat。

## 7. 连续 Product Session 如何迭代

### 7.1 两种连续性必须分开

1. **同一个 Product Run 内**：Pi AgentSession 负责多轮 Tool Loop；每次 Provider Request 使用新增 Assistant/Tool Result 更新上下文。
2. **同一个 Product Session 的不同消息/Run 之间**：Chat Prompt Compiler 从 Product Store 的正式历史重新选择；不能默认沿用上一个 Pi Runtime Session。

这使用户在同一会话内切换 Planning、Direct 或未来其他 Workflow 时，历史仍是一份 Chat 产品事实，而每个节点按自己的 Profile 决定读取多少、以何种形式读取。

### 7.2 Direct v2历史选择合同

Direct审核工作流已经采用以下保守规则：

1. 当前 User Message 永远必选。
2. 最近成功 Product Commit 的 `User → Assistant` 对按时间倒序选入。
3. 失败、取消或 `outcome_unknown` Run 的候选输出不进入默认模型上下文；它们仍保留为证据。
4. 未形成正式 Assistant Message 的历史 User Message也不默认作为待办重放，避免新 Workflow 误把旧失败请求当成本轮指令；用户若继续该目标，应在当前输入中明确引用。
5. Prompt Region、Workspace、Memory、Project和Rule不混入Conversation History，走各自来源和版本冻结。
6. 切换 Workflow 不复制历史，只换当前 Node 的 Prompt Profile。

选择器按最近优先、完整成对地采用历史；预算不足时从最旧的一对开始排除。Assembly保存每条采用Message的ID、sequence、sha256和来源Run，Store Integrity重新计算同一结果。Planning/Executor尚未采用本合同。

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

Direct v2现在关闭Pi Compaction。Chat跨Run Summary打通后，再决定是否启用Pi的Run内Compaction；若启用，它的每次Summary请求也必须经过相同Provider Gate，并把压缩范围证据投影回Chat。

## 8. Token、字符与字节预算

Direct v2没有假装已经获得精确Provider Tokenizer，而是冻结一套可重算的首版预算：

1. 总输入上限`64,000`估算Token；
2. Tool Schema固定预留`8,000`；
3. 文本估算器为`ceil(UTF-8 bytes / 3)`，版本`utf8-bytes-div-3.v1`；
4. 必需System与当前User优先，二者超限时在Provider前失败，不静默裁剪；
5. 历史以完整`User → Assistant`对为单位从最近向前选择，超预算时稳定排除更早历史；
6. Assembly记录每项估算、总计、采用/排除和Reason Code，Product Store使用同一个Domain合同复算；
7. Prompt Review Raw继续完整展示已经完成预算选择后的实际请求，不能把截断UI冒充完整请求。

这不是所有模型永久通用的数值。未来换成Provider-aware Tokenizer或模型Context Window时，必须发布新的Meter/Profile版本，不能让同一版本的Assembly计算结果漂移。

## 9. Prompt Review 如何与新管理模型结合

Raw 页不变：只展示真正待发的 Canonical Provider Payload。

Readable页已经优先读取Assembly Manifest，并按四个物理通道与语义来源展示：

```text
系统指令
  Fragment、正文、作者、模板版本、选择者、组装器、Payload位置

当前输入
  Product Message ID/revision/hash、正文、Payload位置

会话上下文
  正式Message/成功Run、采用/排除原因、估算Token

System语义区
  Git/全局/Workspace Markdown路径、Revision、Scope与Hash

工具
  Capability Profile、Tool Schema来源、是否可调用

请求参数
  Provider/Model/Thinking/Token来源与实际值
```

所有标题、解释、来源标签都明确标记为 UI Metadata，不进入模型请求；区域正文必须能通过 JSON Pointer 回到 Raw 的真实字段。若某个 Raw 字段无法映射，Readable 页新增“未归类原始字段”，不能丢失或自作解释。

## 10. 实施顺序

按产品确认后的顺序推进：

1. **Prompt Studio 管理纵向（已实现）**：Git Region/Builtin Catalog、全局/Workspace用户 PromptFragment Revision、公开 Query/Command、DSH 设置页。
2. **系统级Prompt Assembly纵向（已实现）**：每次发送前只配置会话上下文；Agent System Prompt在独立Agent目录中版本化。Application按Workflow节点的Agent引用为多节点Run冻结v3，并让Planner、Coding Executor、Note Extractor按Manifest绑定的节点Hash取值。Direct另冻结Provider-ready v2，把Agent System、会话上下文、正式历史Messages、当前User、Tools和Options写入Assembly，Prompt Review关联真实Region与Message来源。
3. **后续纵向**：Provider审核页编辑后重新冻结；Conversation Summary Candidate与压缩；按独立授权为非Direct节点增加逐请求Provider Review与Payload来源映射。

每一步都是用户可独立验证的小纵向，不为了未来阶段提前建立第二套控制面。

## 11. 已冻结的产品选择

1. Prompt Studio 先管理、后组装；第一纵向不进入 Workflow。
2. 内置Markdown由Git Catalog唯一拥有；用户修改通过“创建副本”进入全局或Workspace Markdown库，Product Store保存版本/权限/Hash/文件引用。
3. 用户管理的会话语义Region编译为带稳定标题的System段；多节点v3保存独立Agent Profile与共享会话上下文，Direct v2另外让当前输入和正式历史保持原生Message角色，并让Tools与Request Options保持独立物理通道。
4. Prompt Review 是 Pi Agent 节点内部开关，不再为它制造第二个图节点。
5. 历史默认只纳入成功提交的 `User → Assistant` 对；失败证据保留但不自动激活。
6. 跨 Run 压缩摘要必须先成为可追溯 Candidate 再提交。
7. DSH当前目录只负责选择目标Workspace身份与Tool Root；Pi自动上下文发现关闭。平台/目标根`AGENTS.md`由Chat Catalog投影为不同Scope的可选组件，只有用户显式选择后才读取并冻结进System。
8. 统一Compiler已接`agent.plan`、`agent.direct`、`execute.plan`与`note.extract`。每个模型节点只读取自己绑定的Agent Profile和同一份会话上下文，不存在可串读的节点Overlay；非模型节点不接收用户Prompt。Provider逐请求人工审核仍只属于配置为`manual`的Direct节点。
