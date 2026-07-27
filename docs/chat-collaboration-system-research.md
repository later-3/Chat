# Chat持续协作系统研究与落地推导

> 状态：已批准。2026-07-24用户批准按本文方向实现Chat Harness与完整Chat系统。
>
> 更新日期：2026-07-23。
>
> 目的：回答Chat怎样把项目、任务、学习、研究、笔记、规则、上下文、Agent执行和长期恢复组合成一套可落地系统。本文拥有研究证据和方案推导；稳定产品愿景由[`PROJECT_CONTEXT.md`](../PROJECT_CONTEXT.md)拥有，完整场景由[`chat-vision-scenario-validation.md`](./chat-vision-scenario-validation.md)拥有。Obsidian、Notion及跨平台类LifeOS产品怎样运行、呈现和维护的补充景观，见[类LifeOS产品方法与Chat Harness启发研究](./lifeos-product-method-research.md)。
>
> 边界：本文没有批准新Schema、迁移、Workflow节点或前端页面。候选字段与算法只有在用户审核后才能进入模块详细设计。

## 1. 研究结论

Chat不需要发明一套包办人生的复杂管理学，也不能把全部责任交给大模型。可行的落地方式是：

1. 用少量稳定对象保存用户已经接受的事实：Project、Work、Plan、Action、Note、Memory、Artifact、Evidence及其关系。
2. 用可版本化的协作协议描述“这类事项通常怎样推进”，但协议只提供可解释默认路径，不强迫所有用户走同一瀑布流程。
3. 用Product Harness保存、查询和维护这些事实；用Context Compiler渐进召回，并让用户通过友好界面采用、排除或锁定。
4. 用一个持续协作根Workflow按意图选择协议和分支；确定性Executor负责查询、状态、权限和事务，Agent只处理语义判断与生成。
5. 用ExecutionDraft把整轮工作讲清楚，用步骤级输入把最小充分工作包交给pi或其他执行层。
6. 用验证、Evidence和提交门控制长期回写；模型输出、摘要和索引都只是候选或派生物。
7. 用SQLite关系数据承载权威事实和事务，JSON承载版本化扩展，FTS5承载可重建全文索引；未来只有在真实召回评测证明必要时才增加向量索引。

这套方案的第一性原理不是“保存更多上下文”，而是：

> 先知道用户正在推进什么，再按当前步骤选择最小充分事实，并把目标、背景、约束、资源、能力、验证和停止条件交给执行层。

## 2. 证据边界和固定版本

### 2.1 证据等级

| 等级 | 内容 | 可以为哪些结论背书 |
|---|---|---|
| A | 当前安装版源码、实际测试和项目运行 | 本项目现在真正能调用的MAF、SQLite和现有代码行为 |
| B | 固定提交的本地参考源码及其测试 | 参考项目在该提交怎样组织会话、上下文、事件和执行 |
| C | 官方标准、官方指南和同行评审论文 | 成熟方法、算法性质和已知限制 |
| D | 本项目推导 | 为Chat组合出的产品对象、协议、Workflow和交互；必须待用户审核 |

任何D级结论都不能借MAF、Scrum、Kanban或某个开源项目的名字冒充框架原生能力。

### 2.2 固定版本

| 来源 | 固定版本或提交 |
|---|---|
| Chat安装版 | `agent-framework-core 1.11.0`、`agent-framework-openai 1.10.1`、`agent-framework-ag-ui 1.0.0rc8` |
| MAF参考源码 | `9c4cd07899502157284b64a73f9a0adfb4594d96` |
| pi | `2b00dade7cec918aefb025c8b7a4fa304a30acdd` |
| nanobot | `2c789767280482f38667044f8a3be5102c71dd26` |
| QwenPaw | `2134427584c2657bb717bb083a120f2de011d047` |
| LibreChat | `8e5ef1fb31e9d63b735c089b21cbc82c50acce46` |
| Codex CLI | `0.144.5`，官方Tag `rust-v0.144.5`，对应提交`87db9bc18ba5bc82c1cb4e4381b44f693ee35623` |

安装版与参考源码不同时，以安装版实测为本项目行为依据。

## 3. 历史经验能提供什么

### 3.1 项目管理：目标、工作源、检查和适应

[Scrum Guide 2020](https://scrumguides.org/docs/scrumguide/v2020/2020-Scrum-Guide-US.pdf)提供了4个适合Chat吸收的原则：

1. Product Goal提供长期焦点。
2. Product Backlog是一个持续涌现、有序的工作来源。
3. Refinement负责把工作进一步拆分并澄清。
4. Definition of Done使“完成”具有透明且可检查的共同标准。

[PMI当前PMBOK页面](https://www.pmi.org/fr-fr/standards/pmbok)强调价值交付、适应性、责任和非规定性，说明项目管理不应被实现成一条所有人都必须遵守的固定瀑布。

对Chat的采用：

- Project保存目标、范围、状态和当前焦点。
- WorkItem保存需要推进的工作，不在Message里猜进度。
- Plan/Milestone负责可调整的分解。
- Validation Contract和Evidence共同表达完成标准。

不采用：

- 不复制Scrum角色、会议和全部Artifact。
- 不要求个人项目必须有Sprint。
- 不把“阶段”再做成一套与Project/Work竞争的状态机。

### 3.2 任务与流动：显式工作流、在制限制和等待时间

[The Kanban Guide](https://kanbanguides.org/the-kanban-guide/)要求显式定义工作项、开始/完成点、状态流和WIP控制，并把WIP、吞吐、工作项年龄、周期时间作为最低流动指标。

对Chat的采用：

1. WorkItem必须有明确状态和责任人。
2. ActionItem表达下一个可执行动作；等待用户的步骤不能伪装成Agent正在执行。
3. 可以为用户展示“进行中太多”“阻塞多久”“下一项是什么”，而不是无限创建新任务。
4. Workflow状态和Work状态必须分开：一次Run结束不代表Work完成。

首版不需要完整看板平台；只需稳定状态、依赖、下一行动、阻塞原因和少量可解释指标。

### 3.3 学习：提取练习、间隔和掌握证据

[Roediger与Karpicke的测试效应研究](https://pubmed.ncbi.nlm.nih.gov/16507066/)表明，主动提取比反复阅读更有利于延迟保持；[Cepeda等人的间隔效应综述](https://pubmed.ncbi.nlm.nih.gov/16719566/)说明分散学习相对集中学习具有稳定优势。

因此学习不应只有“读完了”：

```text
目标
-> 基线诊断
-> 学习材料
-> 主动练习
-> 评估证据
-> 薄弱点
-> 下一次复习
```

对Chat的采用：

- 学习仍复用`Project(kind=learning)`、Work、Plan、Note和Evidence。
- 练习结果、测验、作品或可解释回答才是掌握Evidence候选。
- 复习日期是Action/Schedule，不靠Agent长期驻留“记住”。
- 用户可以跳过诊断或改变路径，系统记录依据和风险，不强制课程化。

### 3.4 笔记和经验：内容、版本、来源与关系

[W3C PROV-O](https://www.w3.org/TR/prov-o/)以Entity、Activity和Agent表达“什么由什么活动、主体和来源产生”，其核心可以渐进使用。

对Chat的采用：

1. Note保存用户可读内容和revision。
2. Memory保存经过接受、可跨场景复用的稳定信息。
3. Artifact保存执行产生的文件、代码、报告或其他产物引用。
4. Evidence证明结果或状态；Provenance连接来源、活动、执行者和派生物。
5. 来源删除、权限撤销或内容变更时，派生Memory/Evidence必须降级、复核或失效。

不采用一开始就实现完整通用知识图谱；首版只建立产品确实需要的有类型关系和来源血缘。

### 3.5 软件项目：Git管理代码，Chat管理协作语义

[Git用户手册](https://git-scm.com/docs/user-manual)中的commit、branch和tag已经承担代码快照与历史引用。Chat不应复制一个代码版本系统。

对Chat的采用：

- Project保存repository、worktree、branch、commit、文件或测试入口的引用和Hash。
- Artifact/Evidence引用Git对象、Diff和测试结果。
- Context按需加载文件，不把整个仓库长期复制进数据库或Prompt。

## 4. MAF源码事实及其边界

### 4.1 AgentSession与Context Provider

安装版：

- `.venv/lib/python3.12/site-packages/agent_framework/_sessions.py:364`：`ContextProvider.before_run`可以增加messages、instructions、tools和middleware，`after_run`可以处理/保存响应。
- `.venv/lib/python3.12/site-packages/agent_framework/_sessions.py:913`：`AgentSession`是运行时状态容器，包含session/service标识和状态。

结论：

- MAF提供运行前后装配上下文的原生扩展点。
- Chat可以把已编译的步骤输入通过Context Provider交给Agent。
- `AgentSession`不能代替Product Session、Project、Work、权限或长期事实数据库。

### 4.2 Middleware与逐次治理

安装版`_middleware.py`区分：

1. AgentMiddleware：拦截Agent调用。
2. FunctionMiddleware：拦截Tool调用。
3. ChatMiddleware：拦截模型调用。

结论：

- 逐次模型请求可见性适合落在Chat Middleware/自定义受治理Executor边界。
- Tool副作用治理必须在Function/Tool Gateway边界单独完成，不能因为模型请求已批准就自动授权工具。
- Middleware是运行拦截机制，不拥有产品Approval、Policy revision或审计事实。

### 4.3 Workflow、Executor和HITL

安装版与本地测试：

- `_workflows/_executor.py:31`：Executor是Workflow基本构件，不要求它是Agent。
- `_workflows/_workflow_context.py:403`：`request_info`可以向外请求信息，并要求响应处理器。
- `_workflows/_checkpoint.py:31`：Checkpoint包含消息、已提交状态、待处理请求、迭代和图Hash。
- `tests/workflow/test_functional_workflow.py:543-560`：HITL暂停、Checkpoint和带响应恢复。
- 同文件`592`以后：故障恢复可以重放缓存步骤结果。
- `tests/workflow/test_sub_workflow.py:176-245`：`WorkflowExecutor`可以嵌套子Workflow，外部请求可以向父级或外部浮出。

结论：

1. 一个根Workflow可以组合确定性Executor、Agent Executor、Tool和子Workflow。
2. “项目查询”可以是0次模型调用的确定性节点。
3. 人工确认可以在多个决策点出现，并从Checkpoint恢复。
4. Chat仍需把MAF请求与Product Run、Approval、Attempt和用户身份显式映射。
5. MAF Checkpoint证明运行可恢复，不证明外部Tool副作用可以安全重做。

## 5. 参考项目事实：采用、改造和拒绝

### 5.1 pi

固定提交中的事实：

- `packages/coding-agent/src/core/system-prompt.ts`按Tool、指南、Context文件、Skill、日期和工作目录组装系统Prompt。
- `resource-loader.ts:67-123`加载全局及祖先目录中的`AGENTS.md`/`CLAUDE.md`。
- `extensions/runner.ts:959-990`的`before_provider_request`可以查看并替换最终Provider Payload。
- `session-manager.ts:406-465`只选择当前会话树路径、最近压缩摘要和保留条目。
- `compaction/compaction.ts:460-530`使用Goal、Constraints、Progress、Decisions、Next Steps和Critical Context结构化压缩。

采用：

- 规则文件渐进加载。
- 当前分支和压缩点之后的上下文选择。
- 执行层工作包应包含Goal、Constraints、Progress、Decisions、Next Steps、Critical Context。

改造：

- pi摘要只作为执行会话派生信息；Chat Product事实仍从数据库和用户决定获取。
- pi只拿当前步骤允许的文件、Tool和预算，不读取整个Product Store。

拒绝：

- 不把pi会话树当Product Session或Project。
- 不让pi直接提交Work、Memory或用户规则。

### 5.2 nanobot

固定提交中的事实：

- `agent/loop.py`显式经历RESTORE、COMPACT、COMMAND、BUILD、RUN、SAVE、RESPOND和DONE。
- `agent/memory.py`使用Memory文件、JSONL历史、Git Store和Cursor。
- `session/manager.py`按Token尾部选择上下文，并保护Tool Call边界。

采用：

- 显式阶段和失败边界。
- 追加事件、Cursor和可恢复Runner思路。
- 上下文压缩不破坏Tool调用结构。

拒绝：

- Markdown/JSONL记忆不能替代Chat的权威Project/Work/Note/Memory状态。
- 简单尾部截取不足以完成跨项目消歧和来源权限控制。

### 5.3 QwenPaw

固定提交中的事实：

- `runtime/prompt_manager.py`通过有优先级的PromptContributor逐请求构建Prompt，单个Contributor失败可被记录和隔离。
- `runtime/prompt_contributors.py`分别贡献身份、Workspace规则、多模态、编码模式、历史摘要、Driver策略和环境。
- `app/channels/console/channel.py`以SSE投影Session、Token和Context使用。

采用：

- Context/Prompt装配按贡献者职责拆分。
- 每一贡献项有来源、优先级和失败隔离。
- 前端只投影运行事件，不拥有权威事实。

拒绝：

- Contributor优先级不能覆盖权限、用户锁定和系统安全下限。
- Prompt拼装本身不能替代ContextPackage revision、Adoption和Hash。

### 5.4 LibreChat

固定提交中的事实：

- `packages/api/src/types/stream.ts`区分Generation Job的running、complete、error、aborted和requires_action。
- `stream/GenerationJobManager.ts`把可序列化Job/Event状态与单进程Runtime状态分开。
- `stream/interfaces/IJobStore.ts`保存Conversation/Response/Agent ID、Pending Action、Replay Event、Context/Token用量和Steering队列。
- `agents/checkpointer.ts`对Checkpoint大小设置硬限制。

采用：

- 活动Job、可重放事件和Pending Action分别持久化。
- HITL是非终态；刷新后仍能恢复。
- Checkpoint必须有容量和兼容性边界。

拒绝：

- 不复制Node/Mongo/Redis和其私有流协议。
- LibreChat没有提供Chat所需的Project/Work/Memory权威协议。

### 5.5 Codex

官方Codex指南把有效请求拆为Goal、Context、Constraints和Done when，并把`AGENTS.md`作为有作用域的持久仓库指导；Plan用于复杂工作，测试和Review必须显式要求：

- [Codex prompting](https://learn.chatgpt.com/docs/prompting.md)
- [Codex best practices](https://learn.chatgpt.com/guides/best-practices.md)
- [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)

固定源码还显示Provider请求由输入、Tool、基础Instructions和输出Schema组合，Compaction后会重新注入初始上下文。

采用：

- 给执行层的最小工作包明确Goal、Context、Constraints、Done when。
- 稳定仓库规则按作用域加载，当前步骤资源按需引用。
- 复杂工作先Plan，执行后测试与Review。

不能宣称：

- 没有证据表明Codex总会把用户原话自动改写成一份最优Prompt。
- Codex Memory/Compaction不能为Chat产品长期事实背书。

## 6. 摘要、检索、存储和恢复

### 6.1 为什么不无脑叠加历史

[Lost in the Middle](https://arxiv.org/abs/2307.03172)显示长上下文中信息位置会显著影响模型利用效果；上下文变长不等于相关事实一定被正确使用。

因此Chat保留完整历史作为证据，却只将当前目标需要的内容放入ContextPackage。

### 6.2 三种不同的信息产物

| 产物 | 内容 | 权威性 | 失败后怎么办 |
|---|---|---|---|
| Raw Message | 用户和Assistant原文 | 原始交互证据 | 不依赖摘要恢复 |
| TurnDigest | 主题、目标、决定、状态变化、开放问题、下一焦点、来源Message ID | 可重建派生物 | 重试或从原文重建 |
| Product Fact | 已接受Project/Work/Plan/Note/Memory等revision | 权威产品事实 | 只能通过命令、CAS和提交门修改 |

TurnDigest建议至少包含：

```text
topics
user_goals
accepted_decisions
committed_changes
open_questions
next_focus
discarded_noise
source_message_ids
confidence
generator_version
```

规则：

1. 摘要模型不能直接更新Project/Work/Memory。
2. `committed_changes`从提交结果投影，不由模型猜。
3. 每项重点必须能回到Message、Run、Note或Evidence。
4. 增量摘要达到阈值或发生冲突时，从权威事实和原始窗口重建，避免误差层层累积。
5. 摘要与权威事实冲突时，权威事实胜出，摘要标记stale。

### 6.3 渐进检索管线

```text
当前User Message + 开放问题 + 最近焦点
-> 精确命令/ID/名称识别
-> Principal与权限Scope过滤
-> Project/Work轻量目录召回
-> FTS/BM25检索Note、Digest和标题
-> 显式关系扩展
-> 候选排序和去重
-> 歧义/HITL
-> 加载已绑定目标的详细事实
-> ContextPackage采用、排除和Token预算
-> StepInputProjection
```

排序先确定性后语义：

1. 精确ID和用户显式选择最高。
2. 当前Project/Work和显式关系优先。
3. 状态、权限、来源有效性是硬过滤，不参与模型投票。
4. 名称、全文相关度、当前焦点和时间只产生候选分数。
5. 同名、跨Scope或低置信候选必须让用户选。
6. 模型重排只能改变候选顺序，不能越过权限或把候选提交成事实。

首版不用向量数据库。SQLite [FTS5](https://sqlite.org/fts5.html)已经提供`MATCH`、BM25、snippet和rank，可先覆盖标题、正文、摘要和关键词；以后用真实召回集比较精确率、召回率和用户纠正率，再决定是否增加Embedding。

### 6.4 SQLite存储候选

SQLite官方事实：

- [事务](https://sqlite.org/lang_transaction.html)提供读写事务、提交/回滚和快照语义；同一时刻只有一个Writer。
- [WAL](https://sqlite.org/wal.html)允许同机读写并发，但需要Checkpoint治理，不适用于网络文件系统。
- [Atomic Commit](https://www.sqlite.org/atomiccommit.html)说明其在前提满足时提供全有或全无提交。
- [JSON1](https://sqlite.org/json1.html)提供JSON函数，但SQLite没有独立JSON类型，JSON仍以普通值保存。

建议：

1. 关系列保存ID、scope、kind、status、revision、owner、parent、时间、Hash和关键查询字段。
2. 有类型Link表保存Project-Work、Note-Source、Memory-Source、Artifact-Evidence等关系。
3. JSON只保存协议特有扩展、快照和可演进配置；不用EAV，也不把完整聚合塞进一个大JSON。
4. FTS索引是可重建投影，不成为事实源。
5. 产品状态变化、Trace和Outbox在一个短事务提交。
6. 每个命令带幂等键和expected revision；并发冲突返回当前revision，让用户或Workflow重规划。
7. 大Artifact正文放文件系统或对象存储，数据库保存URI、Hash、大小、MIME、来源和访问策略。

### 6.5 RAG和反思方法的适用边界

[RAG](https://arxiv.org/abs/2005.11401)说明外部可检索记忆能够补充模型参数知识；[Generative Agents](https://arxiv.org/abs/2304.03442)展示原始经历、反思和动态召回的组合。

Chat只借鉴“外部检索、分层信息和按需召回”，不采用“反思自动成为人格或长期事实”。所有长期Memory仍要经过来源、作用域、冲突和接受门。

## 7. 候选落地模型

### 7.1 稳定事实与可演进方法分开

稳定关系对象：

- Project、WorkItem、TaskPlan、PlanNode、ActionItem。
- Note、Memory、Artifact、Evidence。
- Message、Interaction、ContextPackage、Run、Trace。

候选可演进对象：

- `CollaborationProtocolDefinition`：某类工作怎样推进。
- `ProtocolBinding`：某用户、Project、Work或场景采用哪个revision。
- `TurnDigest`：一轮交互的重点派生。
- `StepInputProjection`：某执行步骤的最小工作包。
- `Schedule`：周期触发、漏跑与下一次运行。

协议扩展核心对象，不复制核心对象。比如学习阶段通过PlanNode/Milestone表示，完成Evidence通过统一Evidence表示，而不是再造LearningTask、LearningRun和LearningEvidence。

### 7.2 协作协议的最小结构

```text
identity + revision
applies_when
recommended_lifecycle
required_context
interaction_and_hilt_rules
planning_pattern
agent_runtime_roles
skill_tool_requirements
validation_and_evidence
commit_and_summary_rules
allowed_overrides
```

协议是默认和约束的组合：

- 默认可以由用户跳过或覆盖。
- 系统安全、权限、来源有效性和高风险动作下限不能被放宽。
- 修改协议或Binding只影响新Run；历史Run保留原revision。

### 7.3 Context信息面板

面板不是新的数据库，而是一次Context编译的用户界面：

| 分组 | 示例 | 默认动作 |
|---|---|---|
| 用户明确选择 | `贪吃蛇`Project、某条Note、指定文件 | 锁定采用，除非权限/来源失效 |
| 系统必需 | 当前User Message、开放澄清、有效RunSpec约束 | 采用并解释原因 |
| 系统推荐 | 当前Work、最近决定、相关经验 | 可取消 |
| 按需资源 | 仓库、长文档、历史Evidence | 只给入口，执行步骤需要时加载 |
| 排除项 | 其他Project、旧闲聊、失效来源 | 显示排除原因 |

用户可以在发出输入前主动勾选，也可以在系统召回后修正；两者都生成新的ContextPackage revision和Adoption记录。

### 7.4 给执行层的工作包

每个pi步骤只接收：

```text
Goal
Current state and accepted decisions
Scope and non-goals
Relevant resources and how to read them
Ordered step and dependencies
Available tools and permissions
Validation / Done when
Expected output and Evidence
Budget and stop conditions
Correlation IDs
```

不接收：

- 其他Project全部资料。
- 完整Product Session历史。
- Product DB写权限。
- 未接受候选或隐藏密钥。
- 超出本步骤的Tool能力。

### 7.5 三方责任和四类权威性

| 参与者 | 必须负责 | 不能负责 |
|---|---|---|
| 用户 | 最终目标、主观偏好、歧义选择、高影响授权、结果接受 | 理解内部状态机和框架ID |
| Chat | 保存事实、召回Context、解释路由、拆解、治理、验证、提交和恢复 | 替用户猜主观选择，伪造Provider/Tool成功 |
| 执行层 | 在RunSpec和步骤权限内完成任务并返回Artifact/Evidence | 直接写长期Product事实，自行扩目标/预算/权限 |

| 信息类 | 例子 | 生效规则 |
|---|---|---|
| 权威事实 | Project状态、接受的Plan revision | 只能通过产品命令和事务改变 |
| 用户决定 | Context锁定、Approval、拒绝Memory | 绑定主体、作用域、revision和后果 |
| 模型候选 | Intent、Plan、摘要、Memory Candidate | 结构校验后仍需策略/用户接受 |
| 外部证据 | 文件Hash、测试、来源页面、Tool回执 | 校验来源、时间、权限和有效性 |

## 8. 方案取舍

| 问题 | 采用 | 暂不采用 | 原因 |
|---|---|---|---|
| 项目方法 | 目标、Backlog/Work、里程碑、完成标准、复盘 | 完整Scrum组织 | 个人协作需要结构，不需要仪式 |
| 任务流 | 状态、责任、下一行动、阻塞、少量流动指标 | 全功能项目管理平台 | 当前目标是持续推进和上下文 |
| 学习 | 诊断、练习、Evidence、间隔复习 | 独立学习数据库 | 复用核心对象，减少双重事实 |
| 笔记 | revision、来源、有类型关系、失效传播 | 通用知识图谱 | 先满足真实查询和治理 |
| 检索 | 硬过滤+精确匹配+FTS5+关系扩展+HITL | 先上向量数据库 | 项目名、状态、ID和权限更适合确定性查询 |
| 摘要 | 结构化TurnDigest+来源+可重建 | 摘要覆盖原始历史 | 防止漂移和假事实 |
| Workflow | 一个持续协作根Workflow+按协议分支/子计划 | 多个互相叠加的根Workflow | 隔离分支，统一治理和恢复 |
| Agent | Intent/Planner/Reviewer按需；pi负责执行 | 每个节点都创建Agent | 确定性工作不应花Token或引入不确定性 |
| 存储 | 关系核心+JSON扩展+FTS投影 | EAV或巨大JSON聚合 | 可查询、可迁移、可约束 |

## 9. 仍然困难且必须显式处理的场景

1. 用户自己也不知道目标：系统只能渐进澄清，不能保证一次识别正确。
2. 同名Project、隐喻或“昨天那个”：必须保留候选和HITL，不能追求100%自动路由。
3. 用户要求相互冲突：需要作用域、revision和优先级，而不是让模型临场选。
4. 摘要长期漂移：必须保存来源、检测冲突并周期重建。
5. 外部Tool结果未知：没有通用Exactly-once，只能按Tool做幂等、查询、补偿或人工对账。
6. 来源被删除或权限撤销：派生结果要降级，不能因为旧摘要仍存在就继续使用。
7. 多Intent共享资源：要允许独立Context/Run和部分成功，同时避免重复执行。
8. 用户在执行中改目标：必须从安全点生成Amendment或新Draft，使受影响授权失效。
9. SQLite多实例和容量：当前适合本地单机起点；网络文件系统、持续多Writer和大规模事件量需要压测或替换适配器。
10. “好的项目管理方法”不是唯一答案：协议必须可版本化、可覆盖、可跳过，并用用户纠正率和实际完成效果迭代。

## 10. 已批准的实现方向

1. 采用“稳定核心对象 + 可版本化协作协议”，不为每种场景新建领域模型。
2. Context信息面板只是Harness资产的采用界面，不建第二事实源。
3. 检索从确定性过滤、FTS5、关系扩展和HITL开始，向量检索以评测结果为启用条件。
4. TurnDigest是有来源、可重建派生物，永远不能直接提交Product事实。
5. 关系字段保存稳定查询项，JSON只保存协议扩展和快照。
6. 一个持续协作根Workflow按协议选择分支，不叠加多个默认根Workflow。
7. Agent按语义需要启用；查询、状态、事务、权限和校验使用确定性Executor。
8. 执行层只收步骤级最小工作包，不能直接写Product事实。
9. 学习复用Project/Work/Plan/Note/Evidence，并以Schedule表达复习。
10. 用户可以跳过方法默认，但不能放宽安全、权限、来源和高影响动作下限。

后续分别完成协议Schema、Context检索评测、TurnDigest合同、Evidence/Provenance和前端信息选择器
的详细设计与实现；本文不替代各模块的迁移、回滚和验证门。
