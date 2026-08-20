# Pi、DeepSeek Harness 与 Hermes 的真实上下文组装实验

> 文档类型：Later 的 AI Agent 学习与实验资料。本文不属于 Chat 产品合同、架构规范或实现授权。
>
> 四套系统只讨论区域划分的学习导读见[《DSH、Pi、Hermes、Codex 上下文区域剖析》](./context-regions.md)。
>
> 实验日期：2026-08-19。
>
> 共同工作目录：Chat 的独立研究 Worktree `codex/prompt-management-design`。
>
> 共同三轮输入：
>
> 1. `这是一个什么项目？`
> 2. `它现在处于什么阶段？`
> 3. `如果我要继续开发，最应该先做什么？`

## 1. 最重要的结论

这次实验纠正了一个关键因果错误：**项目文件出现在模型上下文中，不等于模型先调用了读取工具。**

一次真实 Agent Turn 必须拆成下面的顺序观察：

```text
用户提交输入
→ Agent 宿主自动发现、读取和组装上下文
→ 第一次真实 Provider 请求
→ 模型返回 Assistant Message / Tool Call
→ 宿主执行 Tool
→ Tool Result 进入历史
→ 下一次真实 Provider 请求
→ ……
→ 模型返回不含 Tool Call 的最终 Assistant Message
```

本次三个系统的第一轮事实分别是：

1. **Pi** 在第一次 Provider 请求前，已经把 3 级 `AGENTS.md` 自动放进 System Prompt；之后模型才决定读取 `PROJECT_STATE.md`。
2. **DeepSeek Harness（DSH）** 在第一次主 Provider 请求前，已经把项目 `AGENTS.md`、Runtime Context、Skill Catalog 作为 3 条有来源的 User Message 自动注入；之后模型才决定读取 `PROJECT_STATE.md` 和 `PROJECT_CONTEXT.md`。
3. **Hermes** 在第一次 Provider 请求前，已经把项目 `AGENTS.md` 放进它构建的 System Prompt；之后模型才决定搜索和读取项目文件。

这三者都不是“用户消息直接原样发给模型”。真正的共同外形都是：

```text
System + Messages + Tools + Request Options
```

差异主要在于：谁在 Provider 前注入什么、注入到 System 还是 Messages、如何记录来源、历史如何持久化，以及上下文压力出现时如何压缩。

## 2. 实验边界与可信度

### 2.1 固定源码

| 系统 | 实际源码/运行工件 | 固定版本 |
|---|---|---|
| Pi | Later 自有分支 `/Users/xulater/Code/opc-os/pi` | `later-3/pi@1f2b9ff53c`，包版本 `0.84.2` |
| DSH | Later 公开窄派生 `/Users/xulater/Code/deepseek-harness-chat-trajectory` | `2606877ed5`；Prompt 基底 `rc.6@15148dbd9a` |
| Hermes | 实际安装目录 `/Users/xulater/.hermes/hermes-agent` | `551e5af50d`，`v0.18.0` |

不是用 README 或模型记忆推断行为；每个结论同时核对了固定源码和真实运行。

### 2.2 真实 Provider

| 系统 | 本次真实模型 | 真实 Provider |
|---|---|---|
| Pi | `kimi-code/k3` | Pi 当前真实 Kimi Code 配置 |
| DSH | `qwen3.7-plus` | `dashscope-coding` |
| Hermes | `glm-5-2-260617` | Hermes 当前 `custom` 火山方舟 Coding 端点 |

本次没有使用 Fake Model、Fake Stream 或模拟 Tool Loop。实验 Trace 不记录 Credential/Header，原始 Trace 只保存在被 Git 忽略的本地 `.artifacts/`，没有提交真实历史正文或隐藏推理。

### 2.3 统一观测合同

每一次模型访问都记录或核对以下信息：

- request kind：主对话、标题、压缩；
- Provider、Model、API mode；
- System 长度；
- Message 数量、Role 顺序、每条内容长度；
- Tool Schema 数量；
- 模型返回的 Tool Call；
- Tool 执行结果进入下一请求的位置；
- 同一 Session 后续用户消息如何继承历史；
- 压缩调用的输入、输出和持久化结果。

字符长度只用于确认请求结构是否稳定，不等于 Token 数。

## 3. Pi：宿主先装载 Context Files，模型再决定读其他文件

### 3.1 第一次请求前 Pi 自动做了什么

Pi 的 `buildSystemPrompt()` 位于 `packages/coding-agent/src/core/system-prompt.ts:28`。真实运行中，第一次 Provider 请求的 System 已经包含：

1. Pi 默认 Coding Agent 身份与工作规则；
2. 当前启用工具的摘要和工具使用规则；
3. 调用方追加的 System 内容；
4. Resource Loader 自动发现的 Context Files；
5. Skill Catalog 元数据；
6. 当前工作目录。

本次自动发现了 3 个 Context File：

| 顺序 | 来源 | 字符数 |
|---|---|---:|
| 1 | 用户级 `~/.pi/agent/AGENTS.md` | 412 |
| 2 | `/Users/xulater/Code/AGENTS.md` | 2,068 |
| 3 | Chat 项目 `AGENTS.md` | 8,094 |

还自动放入 1 个 `mac-travel-mode` Skill 的目录元数据。这里没有 Tool Call；这些文件是 Pi 宿主在首次请求前读取和组装的。

Pi 的 System Builder 对 `customPrompt` 使用 truthy 判断（`system-prompt.ts:46`）：非空值替换默认基础正文，空字符串则回退到默认正文；随后 Context Files、Skills 和 cwd 仍按配置参与组装。

### 3.2 第一轮真实因果链

第一次主请求：

| 字段 | 实际值 |
|---|---|
| Messages | `[system, user]` |
| 内容字符数 | `[14,268, 9]` |
| Tools | `read, bash, edit, write`，共 4 个 |
| User | `这是一个什么项目？` |

这时项目 `AGENTS.md` 已在 System 中，但 `PROJECT_STATE.md` 不在。真实模型随后返回了两个 Tool Call：

1. `read PROJECT_STATE.md`
2. `bash` 查看项目目录、`apps` 和 `packages`

工具执行后，第二次主请求变为：

```text
[system, user, assistant(tool calls), tool, tool]
字符数：[14268, 9, 4, 4733, 787]
```

所以准确描述是：

```text
Pi 自动注入 AGENTS.md
→ 第一次模型请求
→ 模型决定读取 PROJECT_STATE.md 和目录
→ 工具执行
→ 第二次模型请求带回 Tool Result
→ 最终回答
```

不是“模型先读取 AGENTS.md，再知道项目是什么”。

### 3.3 同一 Pi Session 的三轮增长

Pi 的主循环在 `packages/agent/src/agent-loop.ts:290-308` 先运行 `transformContext()`、`convertToLlm()`，再调用 Provider。Assistant Tool Call 和 Tool Result 会追加到同一个消息分支。

本次同一个 Pi Session 的请求增长如下：

| 用户轮次 | Provider 请求 | Message 数 | 新动作 |
|---|---:|---:|---|
| U1 | 1 | 2 | System + 当前 User |
| U1 | 2 | 5 | 带回 1 个 Assistant Tool-Call Message 和 2 个 Tool Result |
| U2 | 1 | 7 | 在 U1 完整历史后追加 U2 |
| U2 | 2 | 9 | 模型读取 `PROJECT_PLAN.md` 后追加 Tool Result |
| U3 | 1 | 11 | 在前两轮完整历史后追加 U3；本轮无需工具 |

U3 第一次请求的 Role 顺序为：

```text
system,
user, assistant, tool, tool, assistant,
user, assistant, tool, assistant,
user
```

System 每次仍是 14,268 字符；变化的是 Messages 历史。

### 3.4 Pi 的真实压缩实验

三轮短会话执行 `/compact` 时，Pi 明确返回 `Nothing to compact`。即使添加真实项目文档，若没有满足“近期尾部 + 安全切点”的可压缩区域，Pi 仍不会为了形式而摘要。

为了观察真实压缩请求，实验只按大小和元数据选择了一个已有长 Pi Session，并复制到实验目录后 Fork；没有修改原 Session。该 Fork 压缩前最近一次 Usage 为 361,021 prompt tokens。

真实压缩访问了模型 2 次：

| 请求 | System | User 内容 | Tools |
|---|---:|---:|---:|
| 历史摘要 | 310 字符 | 849,485 字符 | 0 |
| 超长 Turn Prefix 摘要 | 310 字符 | 34,433 字符 | 0 |

压缩结果：

- `tokensBefore = 361,021`
- Summary 15,377 字符
- `retainedTailCount = 0`
- 原始 Session Entry 未删除；Fork 新增 1 条 Compaction Entry

默认值来自 `packages/coding-agent/src/core/compaction/compaction.ts:128-135`：

- `reserveTokens = 16,384`
- `keepRecentTokens = 20,000`
- 触发条件位于同文件 `:237`：`contextTokens > contextWindow - reserveTokens`

重要接缝事实：Pi 的普通 `before_provider_request` Extension 能看到主 Agent Turn，但这两次 Compaction Summarizer 调用走独立 Stream Function，没有经过该普通 Hook。本次必须在更低层的真实 Fetch 边界才能观测。这也是 Chat 若承诺“每一次模型请求都审核”时必须补统一底层 Hook 的直接证据；Later 自有 Pi 分支允许我们把这个接缝做成上游通用能力。

## 4. DSH：自动上下文是有来源的耐久 User Message

### 4.1 第一次请求前 DSH 自动做了什么

DSH 的 `SystemPrompt` 服务位于 `packages/core/system-prompt/src/index.ts:338`，每个 Agent Step 在 `packages/core/agent-loop/src/agent.ts:225-230` 调用 `assemble()`。

真实 DSH Web 第一次主模型请求不是 `[system, user]`，而是：

| 位置 | Role | 字符数 | 来源 | 是否用户手输 |
|---:|---|---:|---|---|
| 1 | system | 6,049 | 多个命名 System Section | 否 |
| 2 | user | 9 | `source.kind=user` | 是 |
| 3 | user | 8,398 | `source.kind=agent-instructions`，项目 `AGENTS.md` | 否 |
| 4 | user | 490 | `@deepseek-ai/dsh-system-prompt` Runtime Context | 否 |
| 5 | user | 895 | `source.kind=skill-catalog` | 否 |

Tools 共 25 个。

Runtime Context 的真实内容描述了本轮沙箱 `workspace-write` 和审批策略 `ask`。它不是 `GenerateOptions` 的一个顶层 `runtimeContext` 字段，而是先由命名 Context Provider 生成，再由 `RuntimeContextProjection`（`packages/core/agent-loop/src/runtime-context.ts:25`）投影为一条模型可见、可持久回放的 User Message。

Skill Catalog 也是 `pre-step` 自动注入的 User Message，不是模型先调用 `skill` 工具才取得。

### 4.2 第一轮真实因果链

DSH 第一轮准确顺序是：

```text
用户提交“这是一个什么项目？”
→ DSH SystemPrompt.assemble()
→ agent-instructions 自动发现并注入项目 AGENTS.md
→ RuntimeContextProjection 注入沙箱/审批快照
→ tool-skill 注入 Skill Catalog
→ 第一次主模型请求（5 条 Message，25 个 Tool）
→ 模型返回 Tool Call：读取 PROJECT_STATE.md、PROJECT_CONTEXT.md
→ DSH 执行两个 read 工具
→ 第二次主模型请求带回两个 Tool Result
→ 最终回答
```

第二次主请求新增的 3 条内容长度为：

```text
assistant(tool calls) = 4
tool(PROJECT_STATE.md) = 5,106
tool(PROJECT_CONTEXT.md) = 3,109
```

模型读取项目状态文件是第一次请求之后的模型决定，不能与前面三条宿主注入混为一谈。

### 4.3 DSH 还有独立的标题请求

第一次用户消息还触发了独立的真实 `purpose=session-title` 请求：

```text
system = 363 字符
user = 97 字符
tools = 0
```

它不属于主 Agent Tool Loop。若 Chat 的审核政策叫“每次发给大模型都停”，产品上必须明确主对话、标题、压缩是否使用同一审核政策，而不能只在 UI 上笼统写“模型请求”。

### 4.4 同一 DSH Session 的三轮增长

| 用户轮次 | 主请求 Message 数 | 新动作 |
|---|---:|---|
| U1 首次 | 5 | 当前 User + 3 条宿主自动 Context |
| U1 工具后 | 8 | Assistant Tool Call + 2 个 Tool Result |
| U2 | 10 | U1 最终 Assistant + U2；未重复注入相同 Context |
| U3 首次 | 12 | U2 最终 Assistant + U3 |
| U3 工具后 | 15 | 读取 `PROJECT_PLAN.md`、Glob `flywheel` 后带回结果 |

DSH 没有在每轮重复复制相同的 `AGENTS.md`、Runtime Context 和 Skill Catalog；它们已经是 Session Surface 里靠前的耐久消息。只有快照变化或原 Surface 被替换时才会产生新的 Context Message。

### 4.5 DSH 的真实手动压缩

通过真实 DSH Web 输入 `/compact`，UI 返回：

```text
Compacted 14 history items (~5908 tokens).
```

真实压缩模型请求包含 16 条 Message 和原来的 25 个 Tool：

```text
roles:
[system,user,user,user,user,assistant,tool,tool,assistant,user,
 assistant,user,assistant,tool,tool,user]

chars:
[6049,9,8398,490,895,4,5106,3109,1086,10,
 1217,17,4,1811,24,1802]
```

最后一条 User Message 是 Compaction 指令。也就是说，DSH 的 Basic Compaction 真实复用了主请求的 System、Tools 和待压缩消息前缀，不是另建一份只有“请总结”的小 Prompt。

真实 Usage：

- input tokens：17,681
- output tokens：1,454
- max tokens：8,192

持久事件链为：

```text
command/run
→ compaction/start
→ compaction/summary
→ compaction/end
→ command/done
```

`compaction/summary` 保存：

- 被替换的 Event Seq 范围；
- 14 个 `shadowedSeqs`；
- `shadowedTokenCount = 5,908`；
- Provider/Model/Usage；
- Summary 输出和当前 Surface Replacement 证据。

原始事件没有删除，只是从当前 `Session.deriveMessages()` Surface 中被 Summary 替换。默认政策位于 `packages/compaction/compaction-basic/src/config.ts:20-23,91-92`：压力阈值 80%、近期保留 16%、Summary 最大 8,192 Tokens、重试 1 次。

## 5. Hermes：System 分成三层，项目上下文只选一个优先来源

### 5.1 第一次请求前 Hermes 自动做了什么

Hermes 的 `build_system_prompt_parts()` 位于 `agent/system_prompt.py:113-466`，返回 3 层：

| 层 | 真实职责 |
|---|---|
| `stable` | 身份、通用 Agent/Tool 指导、Memory/Session/Skill 使用说明、Skill Index、Coding/环境/Profile 提示 |
| `context` | 调用方 `system_message` 与一个项目 Context |
| `volatile` | Memory、`USER.md`、外部 Memory、时间、Session/Model/Provider 等动态信息 |

项目 Context 的选择位于 `agent/prompt_builder.py:1931-1958`，按“第一个命中即停止”选择：

1. `.hermes.md` / `HERMES.md`，向上走到 Git Root；
2. 当前目录 `AGENTS.md`；
3. 当前目录 `CLAUDE.md`；
4. 当前目录 `.cursorrules` / `.cursor/rules/*.mdc`。

本次 Chat 工作目录没有更高优先级的 Hermes 文件，因此项目 `AGENTS.md` 在第一次请求前已经被放入 `# Project Context` System 区域。

### 5.2 第一轮真实因果链

权威的连续 CLI Session 第一次请求为：

| 字段 | 实际值 |
|---|---|
| Messages | `[system, user]` |
| 内容字符数 | `[30,633, 9]` |
| Tools | 28 个 |
| User | `这是一个什么项目？` |

真实模型随后调用：

1. `search_files` 查找 README；
2. `read_file PROJECT_STATE.md`；
3. `read_file PROJECT_CONTEXT.md`；
4. 下一请求又读取 `README.md`。

所以这里也同样是“宿主先注入 `AGENTS.md`，模型再决定读状态文件”，不是模型先读项目规则。

### 5.3 同一 Hermes Session 的三轮增长

Hermes System 在普通请求中一直保持 30,633 字符，并按 Session 缓存。三轮真实请求：

| 用户轮次 | 请求 Message 数 | 说明 |
|---|---:|---|
| U1 | 2 → 6 → 8 | 搜索文件并读取 3 个文件 |
| U2 | 10 → 13 → 16 | 继承 U1 全历史，再执行 2 个 read 和 2 个 terminal |
| U3 | 18 | 继承前两轮历史；直接回答，没有工具 |

U2 第一次请求的 Role 顺序为：

```text
system,user,assistant,tool,tool,tool,assistant,tool,assistant,user
```

U3 第一次请求是在前 16 条历史后追加 U2 最终 Assistant 和 U3 User。

### 5.4 Hermes 的真实压缩请求

Hermes 默认配置位于 `hermes_cli/config.py:1339-1343`：

- `threshold = 0.50`
- `target_ratio = 0.20`
- `protect_last_n = 20`
- `protect_first_n = 3`

压缩成功后，Hermes 会让 System Prompt Cache 失效并重建，相关代码位于 `agent/conversation_compression.py:651-653`。这与普通轮次一直复用 Session 内缓存不同。

普通 Agent Middleware 看不到独立的 Compression Auxiliary Call，因此实验在 `agent.context_compressor.call_llm` 的真实边界增加了临时只读观测。一次真实压缩调用的实际参数为：

| 字段 | 实际值 |
|---|---|
| task | `compression` |
| Messages | 1 条 `user` |
| User Prompt | 17,055 字符 |
| Tools | 0 |
| max tokens | 2,600 |
| 模型 | 没有单独 override，回退真实主模型 `glm-5-2-260617` |
| Provider | 当前真实 `custom` Provider |

真实返回 Usage：

- prompt tokens：5,850
- completion tokens：3,006
- total tokens：8,856

这与源码 `agent/context_compressor.py:1651-1817` 一致：Hermes 先把被压缩 Turn 序列化进一个结构化 Summary Prompt，再单独调用 `call_llm(messages=[{ role: "user", content: prompt }])`，不带 Agent Tools。

这个观测样本在三轮主实验后增加了 CLI 路由验证和两条控制消息，不作为“三轮历史形状”样本，只用于证明真实 Auxiliary Compression 请求边界。实际压缩把 18 条消息变为 14 条，估算模型请求从约 35,186 降到约 28,316 tokens。

## 6. 三者并排比较

| 方面 | Pi | DSH | Hermes |
|---|---|---|---|
| 项目规则预注入 | 多级 Context Files 进入 System | `agent-instructions` 进入有来源 User Message | 只选一个最高优先项目 Context 进入 System |
| Runtime Context | Extension/调用方自行注入 | 命名 Context → 耐久 User Message | System `volatile/context` 片段 |
| Skill | System 中的 Skill 目录提示 | 有来源的 Skill Catalog User Message | System 中的 Skills Index |
| 历史 | 当前 Session Branch Messages | Session Event Surface 派生 Messages | Session DB Conversation History |
| Tool 定义 | 独立 `tools[]`，System 还有工具指导 | 独立 `tools[]`，System Section 可有工具说明 | 独立 Tools，System 有通用 Tool 指导 |
| 每个 Tool Loop 请求 | 追加 Assistant Tool Call + Tool Result | 追加事件并从 Surface 派生 | 追加到 Conversation History |
| 辅助模型请求 | Compaction 走独立 Stream Function | `purpose=session-title|compaction` 明确区分 | `task=compression` 走独立 Auxiliary Client |
| 压缩后原历史 | Session Entry 保留，活跃 Branch 用 Summary | Event Log 保留，Surface Replacement | DB 保留/归档取决于 in-place 设置，活跃 Messages 用 Summary |
| 普通主请求 Hook 能否覆盖压缩 | 不能 | `llm/stream` 可按 purpose 观察 | 普通 Agent Middleware 不能 |

### 6.1 “Session 历史能否一比一还原最终请求？”

答案不是统一的“能”。必须区分 Messages、模型可见请求和最终 HTTP Body：

1. **Pi Session 文件**能重建当前 Branch 的 User/Assistant/Tool/Compaction 历史，但最终 System 还依赖 Resource Loader、调用方配置、Tools、Model 和 Provider Adapter。只拿 Session JSONL 不能一比一还原最终 HTTP Body。
2. **DSH Session Log**最接近可重放：模型可见 Message 必须进入 Log，`request/header` 还记录 System、Tools 和 Model Config 快照。它能重建当时的模型 Surface；最终认证 Header 和 Adapter 序列化字节仍不属于 Session。
3. **Hermes Session DB**保存 Conversation History，但 System 来自配置、项目文件、Memory、Skills 和运行时信息，且普通 Session 记录没有 DSH 那种完整 Request Header Snapshot。只拿历史消息不能一比一还原最终请求。

因此 Chat 需要的不是再存一份聊天数组，而是：

```text
正式 Product Facts
+ 本轮 Prompt Assembly Manifest
+ Provider Adapter 产生的最终待发 Raw Payload
```

Manifest 解释来源和选择；Raw Payload 证明最终真正发送什么。二者职责不能互相替代。

## 7. 对 Chat 提示词管理的直接启示

### 7.1 Readable 不能靠 Role 猜来源

同样一条 `user` Role：

- 可能是人真正输入的当前请求；
- 可能是 DSH 自动注入的项目 `AGENTS.md`；
- 可能是 Runtime Context；
- 可能是 Skill Catalog；
- 可能是压缩指令或压缩 Summary。

因此 Readable 审核页必须消费组装时记录的来源，而不是看到 `role=user` 就标成“用户提示词”。

### 7.2 必须分别标记宿主注入与模型 Tool Result

推荐在 Chat Manifest 中至少记录：

```text
host_preload      宿主在第一次模型请求前自动注入
user_input        当前用户明确输入
conversation      已提交历史
model_tool_call   模型返回的工具调用
tool_result       工具执行后反馈给模型的结果
auxiliary_prompt  标题、摘要等辅助模型请求
```

这能避免再次把“DSH 预先读取 AGENTS.md”和“模型调用 read_file”说成一件事。

### 7.3 Provider Hook 必须覆盖所有请求种类

真实实验已经证明至少有 3 类请求可能绕开普通主 Agent Hook：

1. Pi Compaction Summarizer；
2. DSH Session Title；
3. Hermes Compression Auxiliary Client。

Chat 自有 Pi 分支应把统一的 Provider-Before-Send Hook 放在所有 Pi 模型调用共同经过的底层边界，并给请求标记：

```text
agent_turn | compaction | title | retry | other_auxiliary
```

审核 Workflow 可以决定哪些 kind 必须暂停，但不能因为某次调用不在主 Agent Loop 就看不见它。

### 7.4 Chat 可借鉴的上游设计

- 向 Pi 学：同一个 Agent Run 内，Assistant Tool Call 和 Tool Result 如何稳定追加并推进循环。
- 向 DSH 学：贡献者身份、命名 Context、稳定排序、Request Header Snapshot、Surface Replacement 和来源事件。
- 向 Hermes 学：System 的 stable/context/volatile 分层，以及对最前、最近历史的保护策略。
- Chat 自己负责：Product Fact 选择、Workflow Node Profile、跨 Run History、预算、来源 Manifest、Decision 与 Product Commit。

## 8. 被排除的错误样本与观测影响

为了不把实验错误包装成产品事实，以下样本没有进入核心结论：

1. DSH 第一次启动未加载真实 Credential，Provider 调用数为 0；排除。
2. 尝试用普通 HTTP POST 调 DSH `/compact` 得到 404；真实 Slash Command 属于 Web Client Connection Plane，后来改用真实 DSH Web UI；404 样本排除。
3. Hermes `--oneshot --resume` 实际不会恢复历史，因为 CLI 在 Resume 分支前进入 Oneshot；真实 Trace 也只有 `[system,user]`。三轮实验改用正常 `hermes chat --resume`；Oneshot 样本排除。
4. Hermes 把 `--query /compact` 当普通 User Message 发给了模型，而不是执行 Slash Command；该请求不属于真实压缩，排除。随后在真实交互 CLI 中执行 `/compact`。
5. Hermes 的临时项目 Trace Plugin 目录会被模型的文件搜索看到，这是观测者效应；实验结束后已经删除，报告不把它视为项目源码。
6. Pi 三轮短会话不满足压缩切点；压缩结论来自只读复制后的历史 Session Fork，并与三轮主会话分开标记。

## 9. 可复现实验入口

本地未提交 Trace 位于独立 Worktree 的：

```text
.artifacts/prompt-context-research/
├── pi-native-20260819/
├── dsh-real-20260819/
└── hermes-real-20260819/
```

它们被 Git 忽略，仅用于本次复核。正式产品不能依赖这些实验 Trace；后续实现应把同等来源信息做成稳定的 Prompt Assembly Manifest 和版本化合同测试。
