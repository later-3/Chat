# Chat Long Agent能力与NanoClaw Agent Group模型

## 1. 文档地位

本文定义Chat Long Agent的持续身份、Session生命周期、NanoClaw Agent Group、独立工作空间、Agent Memory、能力配置和运行边界。它补充[Chat Long Agent与多入口架构](./chat-long-agent-architecture.md)和[Chat、NanoClaw与Pi统一集成设计](./chat-nanoclaw-pi-integration.md)。

本文区分“目标架构”和“当前实现”。目标能力没有进入代码、测试和真实运行验收前，界面与文档不得把它展示为已可用。

## 2. 核心结论

1. Long Agent拥有一个跨轮次持续的Chat Session；用户每次发消息不会创建新的产品Session。
2. 每轮执行会临时创建一个Pi `AgentSession`对象，绑定并恢复同一个Chat `SessionManager`。Turn结束后释放执行对象，不会删除或替换Session历史。
3. NanoClaw不是单纯的IM转发器。Agent Group继续承载长期身份、独立工作空间、Markdown Agent Memory、Standing Instructions、Skills、任务、Destination和生态能力。
4. Chat Backend是唯一Agent Runtime，负责Pi Agent Loop、Model、Thinking、Project Context、Chat Tool和原生Chat Session写入；NanoClaw不再运行第二个Provider或Agent容器。
5. Chat Mem0与Agent Group Memory是不同作用域的能力：Mem0保存用户和Project共享事实；Agent Group Markdown Memory保存某个Long Agent自己的身份、经验、工作状态和待办。
6. NanoClaw能力应通过版本化Management、Trigger和Resource合同进入Chat，而不是由Chat直接读取NanoClaw数据库、挂载整个NanoClaw目录或复制一份失去来源的配置。

## 3. 五个必须区分的对象

| 对象 | 持续时间 | 事实所有者 | 职责 |
|---|---|---|---|
| `LongAgent` | 长期 | Chat与NanoClaw映射 | 用户看到的长期同事入口和运行策略 |
| NanoClaw `Agent Group` | 长期 | NanoClaw | 身份、工作空间、Agent Memory、技能、任务、Destination和权限 |
| `ProjectLongAgent` | Project生命周期 | Chat | Long Agent在一个Project中的状态和唯一专属主Session |
| Chat Session | 跨多轮持续 | Chat/Pi `SessionManager` | 用户、Assistant、Tool、Usage、Compaction和分支历史 |
| Pi `AgentSession` | 一次Turn或恢复过程 | Chat Pi Runtime | 运行Agent Loop；每轮可重新创建并恢复同一Chat Session |

NanoClaw Channel Session是第六个内部对象，只保存`Agent Group + Messaging Group + Thread + Mailbox`路由坐标。它可以跨多轮持续，但不是用户可见Chat Session，也不是Pi Agent执行对象。

```text
Long Agent
  ├── NanoClaw Agent Group（身份、Workspace、Agent Memory、生态能力）
  ├── ProjectLongAgent: daily（唯一Chat Session A）
  ├── ProjectLongAgent: chat（唯一Chat Session B）
  └── NanoClaw Channel Sessions（Telegram/Slack/Thread路由坐标）

每次消息
  → 恢复对应Chat Session
  → 装配一个Pi AgentSession
  → 执行并追加原生Session Entry
  → 释放Pi AgentSession执行对象
```

## 4. Agent Group与Chat运行策略的事实所有权

Agent Group与Chat LongAgent Definition不能各自保存一份完整且相互覆盖的Agent配置。目标事实所有权如下：

| 配置 | 事实所有者 | 说明 |
|---|---|---|
| 稳定Agent Group ID、运行身份名称、长期职责 | NanoClaw Agent Group | Chat保存稳定引用；`long-agents.json`的name/description只是UI别名和摘要 |
| Standing Instructions、Workspace、Markdown Agent Memory | NanoClaw Agent Group | 通过版本化Context Snapshot提供给Chat |
| Agent Skills、Template来源、自我扩展状态 | NanoClaw Agent Group | Chat只装配经过解析和授权的固定Revision |
| Model、Thinking Level、Pi Tool授权 | Chat | 因为执行发生在Chat Backend |
| Personal全局启停、默认Project | Chat LongAgent映射 | 属于Chat产品行为 |
| Project挂载、专属主Session、Project资源 | Chat | 受Project权限和隔离约束 |
| Channel、Messaging Group、Wiring、Destination | NanoClaw | 由Channel与权限模型管理 |
| Provider、容器镜像、容器重启 | NanoClaw独立运行模式 | `chat-pi`模式不产生这类运行事实 |

`chat-pi`模式中的NanoClaw `container_configs.provider`、容器Model和容器Restart不得作为当前Long Agent运行状态展示。若数据库为了独立模式兼容仍保留这些列，应明确返回`runtimeOwner=chat-pi`和`nativeRuntimeActive=false`，不能显示成“正在使用Codex”。

## 5. Context Snapshot与Workspace访问

Chat Backend不能直接读取NanoClaw中央数据库，也不能无边界挂载`groups/`目录。目标通过NanoClaw Management Adapter提供窄合同：

```text
AgentGroupContextSnapshot
  groupId
  revision
  identity
  standingInstructions
  memoryManifest
  skillManifest
  workspaceCapabilities
```

执行前的数据流：

```text
Chat解析LongAgent + ProjectLongAgent
  → 读取固定Revision的AgentGroupContextSnapshot
  → Chat校验Project、资源和Tool权限
  → 物化为本轮只读Resource Snapshot
  → createChatPiAgentSession()
  → Pi执行
```

Workspace不是把宿主目录直接交给Pi。读写必须通过Agent Group作用域的受控Tool或已授权Mount，并记录`longAgentId`、`agentGroupId`、`projectId`、`sessionId`和操作来源。跨Project或跨Agent Group访问需要显式授权。

## 6. Memory分层

### 6.1 Chat Shared Memory

Chat Mem0继续保存可被多个Agent使用的稳定事实：

- Personal：用户跨Project偏好和事实。
- Project：项目架构决定、约束、经验和目标。
- 通过Chat `memory_search`、`memory_record`和管理页维护。

### 6.2 Long Agent Memory

NanoClaw Agent Group Markdown Memory保存只属于一个Long Agent的持续状态：

- 自我定义、角色边界和工作方式。
- 与用户长期协作形成的Agent经验。
- 当前长期计划、开放事项和Scratchpad。
- Agent Group内部知识索引与可审阅Markdown文件。

目标事实源沿用NanoClaw的Open Knowledge Format Markdown目录。Chat不把它复制进Mem0，也不把Personal/Project事实自动写入Agent Memory。

### 6.3 Pi Extension选择

两个公开Pi Memory Extension只能作为能力参考或适配基础，不能未经作用域设计直接装入所有Long Agent：

| Extension | 机制 | 适合点 | 不直接采用的原因 |
|---|---|---|---|
| `pi-memory` | Markdown、Daily Log、Scratchpad、可选qmd搜索、Turn前注入 | 与可读写Markdown Agent Memory接近；MIT；不要求常驻Worker | 默认使用全局目录和自己的文件布局；需要改造成按Agent Group解析且兼容NanoClaw OKF |
| `pi-agent-memory` | claude-mem Worker、SQLite/FTS5/Chroma、自动观察Tool结果和Session总结 | 跨引擎观察和自动压缩能力强 | 引入独立Worker和第三套索引；Project作用域与Chat Target不一致；AGPL；与Mem0和Nano Agent Memory职责重叠 |

当前方案已经实现NanoClaw Agent Memory的基础Pi适配层：存储仍由NanoClaw Agent Group拥有，Chat在每轮装配Pi时加载带Revision与显式Prompt预算的Standing Instructions与核心OKF Memory，并提供Group作用域的`agent_memory_search/read/write` Tool。每个Turn Marker记录不可变`contextRevision`和Group/Core Revision；重试读取按内容寻址的历史Snapshot，因此并发的新Turn或设置读取不会覆盖失败Turn的上下文。Host根据Long Agent映射注入Group身份，不能让环境变量、全局目录或模型参数决定当前Agent，以免多个Long Agent并发串写。Daily Log、Scratchpad专用语义与qmd索引仍可在后续迭代扩展，但不改变NanoClaw Markdown事实源。

建议Tool命名与Chat共享Memory明确区分：

```text
memory_search / memory_record             → Chat Personal/Project Mem0
agent_memory_search / agent_memory_write  → 当前NanoClaw Agent Group Markdown Memory
agent_scratchpad                          → 当前Agent Group开放事项
```

## 7. NanoClaw能力接入矩阵

| NanoClaw能力 | `chat-pi`当前状态 | 目标接入方式 |
|---|---|---|
| 多Channel、多Bot、Wiring | 已接入Telegram文本路径 | 继续扩展Adapter，不改变Chat Session身份 |
| Agent Group身份 | 已通过静态Resource API进入Chat Web与每轮Pi Context | 继续接入Skills、任务与Destination |
| 独立Workspace | 未进入Pi主链 | 受控Workspace Tool与版本化资源快照 |
| Markdown Agent Memory | 已提供管理API、核心Context注入与`agent_memory_*` Tool | 增加Scratchpad/Daily Log语义与可重建索引 |
| Standing Instructions | 已通过Agent Group Context Snapshot进入Pi主链 | 每轮记录并冻结实际使用的Group/Core Memory Revision |
| Skills、Template | 未进入Pi主链 | 转换为Pi Resource Snapshot并冻结Revision |
| 定时任务、主动触发 | Nano保存任务；尚不能唤醒Chat Pi | 统一`TriggerEnvelope`，绑定Project、Session和Delivery |
| Agent-to-Agent | Chat Tool尚未接入 | Chat解析目标ProjectLongAgent并建立Child Turn |
| Destination、多端投递 | 文本原路回复已接入 | 增加显式Destination和Delivery Policy |
| 文件、卡片、编辑、Reaction | HTTP合同目前只有文本 | 版本化Message Content与Channel能力协商 |
| Self-mod Packages/MCP | 原生依赖容器Runner | 改为Agent Group变更提案、审批、资源Revision和Chat重新装配 |
| OneCLI Credential/Approval | `chat-pi`执行链未使用 | Chat Credential与Nano Channel Credential分别授权；复用审批语义 |
| Provider/Model、容器Runtime | 已被Chat Pi替代 | 不接入；不得展示旧Provider为运行事实 |
| Inbox/Outbox、重试、Ack | 已接入 | 保持NanoClaw所有权和幂等合同 |

## 8. Trigger统一

Channel消息、定时任务、Webhook、Agent-to-Agent和主动事件最终都要形成同一个执行合同：

```text
TriggerEnvelope
  triggerId
  triggerType: channel | schedule | webhook | agent | proactive
  agentGroupId
  projectBinding
  targetChatSessionId
  payload
  deliveryBinding
  createdAt
```

NanoClaw负责触发事实、权限、Mailbox和Delivery；Chat负责解析ProjectLongAgent、幂等执行Pi和提交Chat Session。定时任务不能直接唤醒已禁用的Nano容器Runtime，也不能在没有Project和目标Session时运行。

## 9. 配置生效与运维动作

必须把配置重载、会话操作和进程重启分开：

| 用户动作 | 正确语义 | 是否需要重启 |
|---|---|---|
| 修改Model、Thinking、Prompt、Tool授权 | 更新Chat运行策略，下一Turn装配 | 否 |
| 修改Agent Group身份、Memory、Skill | 生成新Agent Group Revision，下一Turn装配 | 否 |
| 清空或压缩上下文 | 对固定Chat Session执行分支/Compaction操作 | 否；不是“重启Agent” |
| 暂停Project Long Agent | 阻止当前Project的新Turn，保留历史 | 否 |
| 更换Bot Token或Channel进程配置 | 重连NanoClaw Channel Host | 需要重启或热重连Channel |
| 更新NanoClaw Host代码 | 重启NanoClaw Host | 是 |
| 更新Chat Backend代码或进程环境 | 重启Chat Backend | 是 |

Chat Web不应提供含义模糊的“重启Agent”。运维页面应分别提供“重新加载配置”“暂停当前Project”“重连Channel”“重启NanoClaw Host”和Session上下文操作，并显示影响范围。

## 10. 实施顺序

1. 清除`chat-pi`运行状态中的旧Provider/容器误导信息，补运行所有权字段和回归测试。
2. 建立只读Agent Group Profile与Context Snapshot合同，把身份和Standing Instructions接入Pi。
3. 接入NanoClaw Markdown Agent Memory，增加Group作用域Tool、固定Revision和并发隔离测试。
4. 将NanoClaw Skills与Template转成Chat可验证的Pi Resource Snapshot。
5. 建立统一Trigger Envelope，首先打通定时任务和主动消息。
6. 增加Agent-to-Agent、Destination和富消息合同。
7. 把NanoClaw Agent Group、Channel、Memory、任务和运行状态整合到Chat Long Agent管理页。

每一步都必须证明：一个Project Long Agent仍只有一个专属主Chat Session；同一外部Trigger重试不重复执行Pi；Agent Group和Project作用域不会串写；Chat或NanoClaw任一侧重启后可以从耐久事实恢复。
