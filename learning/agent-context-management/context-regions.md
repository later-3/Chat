# DSH、Pi、Hermes、Codex 上下文区域剖析

> 文档类型：Later 的个人学习资料，不是 Chat 产品合同。
>
> 范围：只讨论模型主请求的区域划分、来源和真实例子；不讨论压缩。
>
> 证据日期：2026-08-20。

## 1. 学习目标

理解四套 Agent 在真正调用模型前如何回答四个问题：

1. 宿主身份和高优先级规则放在哪里？
2. 项目规则、运行环境和 Skill 属于什么类别？
3. 当前用户输入、历史与 Tool Result 如何进入消息序列？
4. UI 如何区分“协议 Role”与“内容真实来源”？

## 2. 固定证据

| 系统 | 固定源码或运行证据 |
|---|---|
| Pi | Later 自有分支 `later-3/pi@1f2b9ff53c`，包版本 `0.84.2` |
| DSH | Later 窄派生 `2606877ed5`；Prompt 基底 `rc.6@15148dbd9a` |
| Hermes | 安装源码 `551e5af50dc6597069e57af047213f61e40246d6`，`v0.18.0` |
| Codex | 本机 Codex CLI `0.144.5` 的真实只读 Session；官方 `AGENTS.md` 发现规则在证据日期同步核对 |

前三套系统的完整原始实验过程见[真实上下文组装实验](./real-request-experiments.md)。Codex 样本由本机真实 `codex exec` 生成，只提取角色、字符长度、Tool Call和公开输出，不记录凭据或隐藏推理。

## 3. 两套分类必须同时存在

### 3.1 Provider物理区域

不同Provider命名略有差异，但一次模型请求通常可以归约为：

```text
Model Request
├── system / developer / instructions
├── messages[]
│   ├── user
│   ├── assistant
│   └── tool / toolResult
├── tools[]
└── request options
    └── provider / model / thinking / maxTokens / temperature ...
```

### 3.2 语义来源

同一物理Role不能证明内容是谁提供的。例如`user`可能表示：

```text
direct_user             用户亲自输入
workspace_instructions  AGENTS.md等项目规则
runtime_context         沙箱、权限、cwd、时间等运行快照
skill_catalog           宿主自动提供的Skill目录
plugin_context          插件生成的上下文
```

因此准确解释一段上下文至少需要：

```text
protocolRole + semanticSource + producer + sourceEvidence
```

## 4. 四套系统总表

| 语义区域 | Pi | DSH | Hermes | Codex |
|---|---|---|---|---|
| Agent身份 | System | System Section | System `stable` | Base Instructions |
| 宿主行为与安全规则 | System | System Section | System `stable` | Base/Developer |
| 项目规则文件 | System Context Files | User，`agent-instructions` | System `context` | User，`AGENTS.md instructions` |
| Runtime环境 | System中的cwd；其余由调用方扩展 | User Runtime Snapshot | System `stable/volatile` | Developer或User环境块，按宿主来源拆分 |
| Skill目录 | System | User Skill Catalog | System `stable` | Developer Skill Instructions |
| 当前用户输入 | User Message | User，`source.kind=user` | User Message | 独立User Message |
| Assistant/Tool历史 | `messages[]` | Session Surface派生 | Conversation History | Response Items |
| Tool Schema | 独立`tools[]` | 独立`tools[]` | 独立Tools | 独立Tools |
| 请求参数 | 独立Settings | GenerateOptions | API Client Options | Turn Context/Request Options |
| 来源透明度 | System拼接后较弱 | 最强，消息带`source` | 组装前分层、合并后较弱 | Role分层清楚，AGENTS有来源包装 |

## 5. Pi：System中心型

Pi低层上下文是：

```text
AgentContext
├── systemPrompt
├── messages[]
└── tools[]
```

`pi/packages/coding-agent/src/core/system-prompt.ts`的`buildSystemPrompt()`依次组装：

1. 默认Pi身份，或调用方提供的非空`customPrompt`；
2. 当前工具的摘要和使用准则；
3. `appendSystemPrompt`；
4. Resource Loader发现的多级Context Files；
5. Skill目录；
6. 当前工作目录。

其中`AGENTS.md`会被包装为：

```xml
<project_context>
  <project_instructions path=".../AGENTS.md">
    ...正文...
  </project_instructions>
</project_context>
```

它属于`systemPrompt`，不是User Message。当前用户输入、Assistant Tool Call与Tool Result则进入`messages[]`。

### 真实首轮

在Chat工作区输入`这是一个什么项目？`：

```text
system   14,268字符
user          9字符
tools         4个：read / bash / edit / write
```

System在第一次Provider请求前已经包含：

```text
~/.pi/agent/AGENTS.md
/Users/xulater/Code/AGENTS.md
Chat/AGENTS.md
```

随后模型才决定读取`PROJECT_STATE.md`并查看目录。宿主预装项目规则和模型后来调用`read`是两个不同阶段。

### 记忆方法

> Pi把身份、项目规则、Skill目录和cwd尽量放进System，把实际交互过程放进Messages。

## 6. DSH：命名注册表与来源型

DSH的`SystemPrompt`服务管理四类输入：

```text
PromptAssembly
├── sections[]   → 真正的System
├── contexts[]   → 动态User Context
├── tools[]      → Tool Schema
└── variables{}  → provider/model/cwd等插值
```

`PromptSection`按名称和顺序渲染为顶层`system`。`PromptContext`则被明确设计为“durable user-role snapshot”。此外，Workspace指令和Skill目录也由各自插件在`pre-step`阶段生成带来源的User Message。

```text
Messages
├── 用户真实输入
│   └── role=user, source.kind=user
├── Workspace指令
│   └── role=user, source.kind=agent-instructions
├── Runtime Context
│   └── role=user, source.plugin=@deepseek-ai/dsh-system-prompt
└── Skill Catalog
    └── role=user, source.kind=skill-catalog
```

### 真实首轮

同一句`这是一个什么项目？`：

| 顺序 | Role | 字符数 | 真实来源 |
|---:|---|---:|---|
| 1 | system | 6,049 | DSH命名System Sections |
| 2 | user | 9 | 用户手输 |
| 3 | user | 8,398 | `AGENTS.md`，`agent-instructions` |
| 4 | user | 490 | 沙箱/审批Runtime Snapshot |
| 5 | user | 895 | Skill Catalog |

Tools共25个。模型随后才读取`PROJECT_STATE.md`和`PROJECT_CONTEXT.md`。

`<system-reminder>`只是User正文里的包装标签，不会把该消息升级成System Role。

### 记忆方法

> DSH把稳定身份和工具规则放System，把会变化、需要来源和耐久回放的Context放进带来源User Message。

## 7. Hermes：三层System型

Hermes先在`agent/system_prompt.py`中建立三层：

```text
System
├── stable
│   ├── SOUL.md或默认身份
│   ├── Agent与Tool指导
│   ├── Skill Index
│   └── 环境、平台与模型规则
├── context
│   ├── 调用方system_message
│   └── 一个项目Context来源
└── volatile
    ├── Memory
    ├── USER.md
    ├── 外部Memory
    └── 日期、Session、Model、Provider
```

然后把三层连接成一个System字符串。项目Context按第一个命中来源选择：

```text
1. .hermes.md / HERMES.md
2. AGENTS.md
3. CLAUDE.md
4. .cursorrules / .cursor/rules/*.mdc
```

这不是Pi的“多级文件全部合并”；如果`.hermes.md`命中，后面的`AGENTS.md`不会再作为同级项目Context加入。

### 真实首轮

同一句`这是一个什么项目？`：

```text
system   30,633字符
user          9字符
tools        28个
```

System已经包含`# Project Context`与Chat的`AGENTS.md`。随后模型才执行`search_files`并读取`PROJECT_STATE.md`、`PROJECT_CONTEXT.md`和`README.md`。

### 记忆方法

> Hermes先按稳定、项目、动态三层管理内容，但Provider最终看到的是合并后的大型System。

## 8. Codex：Base/Developer与项目User Context分层

OpenAI官方文档说明Codex会在开始工作前建立`AGENTS.md`指令链：先读取Codex Home，再从项目根逐级走到当前目录，越接近当前目录的内容越靠后。官方文档没有承诺最终Provider请求中的具体Role，因此本节Role结论来自本机固定版本的真实Session。

### 真实首轮

```text
Codex CLI  0.144.5
Model      gpt-5.6-sol
Sandbox    read-only
CWD        Chat-prompt-management-design
User       这是一个什么项目？
```

本机Rollout记录：

```text
Base Instructions                 17,730字符
developer                         22,560字符
developer                          1,842字符
developer                            186字符
user [AGENTS.md instruction chain] 12,672字符
user [direct user]                     9字符
```

三个Developer块承载Skill、权限、Agent职责和当前协作约束；`AGENTS.md`指令链是一条独立User消息，真实用户输入又是下一条User消息。模型随后发起一次只读Shell Tool，读取项目要求的状态文档后给出回答。

这个样本再次证明：

```text
role=user, semanticSource=workspace_instructions
role=user, semanticSource=direct_user
```

是两类不同内容。

### 记忆方法

> Codex把宿主拥有的规则放Base/Developer，把仓库提供的AGENTS规则放User Context，把用户本轮输入放另一条User。

## 9. 同一问题的四种外形

```text
Pi
  SYSTEM = 身份 + Tool指导 + 多级AGENTS + Skills + cwd
  USER   = 当前输入

DSH
  SYSTEM = Harness身份 + Persona + Tool说明
  USER   = 当前输入
  USER   = AGENTS [agent-instructions]
  USER   = Runtime Context [plugin]
  USER   = Skill Catalog [skill-catalog]

Hermes
  SYSTEM = stable + context(项目规则) + volatile
  USER   = 当前输入

Codex
  BASE/DEVELOPER = 身份 + Skills + 权限 + 协作模式
  USER           = AGENTS instruction chain
  USER           = 当前输入
```

## 10. 需要真正掌握的结论

1. **Role不是来源。** `user`不等于“用户亲自输入”。
2. **项目规则没有统一物理位置。** Pi/Hermes放System，DSH/Codex放User Context。
3. **Tool Guidance与Tool Schema不同。** 前者通常位于System/Developer正文，后者位于独立`tools[]`。
4. **History是语义视图。** Provider物理上仍是User、Assistant、Tool消息序列，不存在统一的顶层`history`字段。
5. **宿主预装与模型读取是两个阶段。** `AGENTS.md`已经在首轮上下文中，不妨碍模型后来再次通过Tool读取文件。
6. **可读视图不能按Role猜来源。** 必须同时显示协议Role、语义类别、生产者、来源文件/版本和最终Payload位置。

可以用一句话记住四者：

```text
Pi      = System中心
DSH     = 来源注册表中心
Hermes  = 分层System中心
Codex   = Base/Developer与项目User分权
```
