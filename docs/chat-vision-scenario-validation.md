# Chat愿景方案与完整场景模拟验证

> 状态：方案已批准、实现持续进行。本文是愿景级设计验证；未在PROJECT_STATE与测试中确认的对象、Schema、Workflow节点或前端功能仍不得写成已实现。
>
> 日期：2026-07-23。
>
> 当前实现基线：Product Harness D1-D8、ExecutionDraft/RunSpec、HITL策略、两阶段Context、25节点持续协作主Workflow、逐次ModelCallDraft审批、通用Execution Worker纵向切片和pi Tool纵向切片。
>
> 证据边界：MAF安装版`1.11.0`；MAF参考源码`9c4cd07899502157284b64a73f9a0adfb4594d96`；pi`2b00dade7cec918aefb025c8b7a4fa304a30acdd`；nanobot`2c789767280482f38667044f8a3be5102c71dd26`；QwenPaw`2134427584c2657bb717bb083a120f2de011d047`；LibreChat`8e5ef1fb31e9d63b735c089b21cbc82c50acce46`；本机Codex CLI `0.144.5`及官方Tag `rust-v0.144.5`；Claude Code只采用2026-07-23可访问的官方文档行为，不把它冒充开源实现。
>
> 研究依据：项目/任务/学习/笔记方法、MAF源码边界、参考项目取舍、摘要/检索/SQLite候选方案见[Chat持续协作系统研究与落地推导](./chat-collaboration-system-research.md)。

## 1. 验证结论

用户提出的愿景可以由当前总体架构承载，但不能只增加几段Prompt或几个Agent。完整方案必须同时具备7种能力：

1. 用Product Harness维护Project、Work、Plan、Note、Memory等权威事实。
2. 用版本化协作协议表达项目、任务、学习、研究、周期工作和用户质量标准怎样推进。
3. 用Context Compiler从原始历史和权威事实中选择最小充分上下文，而不是堆叠Session History。
4. 用ExecutionDraft让用户查看和修正系统准备怎样完成工作，再编译不可变RunSpec。
5. 用步骤级执行投影给Intent Agent、Planner、pi和Reviewer不同的最小输入与权限。
6. 用HITL、运行视图和干预命令让用户在执行前、执行中和提交前控制系统。
7. 用Validation、Evidence、Artifact、TurnSummary和产品提交门完成验证与长期状态回写。

场景推演发现当前方案需要补充6项候选设计：

| 候选优化 | 为什么现有对象不够 | 最小方案 |
|---|---|---|
| `CollaborationProtocolDefinition` / 协作协议定义 | Project和Work记录“是什么、做到哪”，不能单独表达“这类工作按什么方法推进” | 版本化声明适用条件、生命周期、上下文要求、HITL点、Skill/Tool、执行模板、验证与回写规则 |
| `ProtocolBinding` / 协议绑定 | 同一软件项目、学习项目或用户可能采用不同严格度和方法 | 把Principal、Project、Work或场景绑定到协议revision和受控覆盖项 |
| 可执行协作规则 | “用户喜欢简洁”可以是Memory；“所有文档必须有metadata”是必须执行和验证的规则，不能只做记忆 | 协议内定义可测试规则；自然语言偏好先成为候选，用户接受后绑定到明确作用域 |
| `StepInputProjection` / 步骤输入投影 | RunSpec包含整轮合同；把整份RunSpec交给每个Agent会越权并污染上下文 | 从RunSpec按节点职责编译最小输入、能力、预算、输出和停止条件 |
| 周期触发语义 | WorkItem能表达“每天推送AI资讯”的目标，但不能表达何时触发、漏跑和送达 | 增加Schedule/Recurrence合同；每次触发创建独立Run/Attempt/Delivery血缘 |
| 验证—修复循环 | Validation Contract说明怎样验收，但还需要控制修复次数、范围扩大和最终人工处置 | 确定性校验优先，语义Reviewer按需；失败在预算内形成修复步骤，越界重新HITL |

这些是场景推导出的候选，不应在用户审核前进入正式Schema。

## 2. 第一性原理

### 2.1 用户原话为什么不等于执行输入

用户自然语言通常缺少至少一种信息：

1. **指代**：说“这个项目”“继续昨天的”但没有稳定ID。
2. **背景**：没有重述项目方案、学习进度或历史决定。
3. **目标**：只表达动作，没有说明期望结果。
4. **范围**：没有说明哪些可以改、哪些不能改。
5. **方法**：用户不知道怎样拆任务或验证。
6. **能力**：没有说明执行层可用哪些Tool、文件、网络或权限。
7. **完成标准**：没有说明什么证据才算完成。
8. **风险偏好**：没有说明哪些动作必须停下来问。

因此：

```text
User Message ≠ Prompt ≠ ExecutionDraft ≠ RunSpec ≠ ModelCallDraft
```

- User Message保存用户原始表达。
- ExecutionDraft是Chat准备怎样完成工作的可编辑方案。
- RunSpec是被授权的不可变整轮合同。
- StepInputProjection是某个Agent或Runtime当前步骤的最小工作包。
- ModelCallDraft是一次即将发送给Provider的最终协议请求。

### 2.2 上下文里最重要的是什么

优先级不是“越多越完整”，而是：

1. 当前目标和期望结果。
2. 已接受决定与不能违反的约束。
3. 当前权威状态、开放问题和阻塞。
4. 本轮范围、非目标和可用能力。
5. 当前步骤需要的事实、资源和上游结果。
6. 完成标准、Evidence要求和停止条件。
7. 与上述内容直接相关的历史摘要或原始证据。

完整历史、整个仓库、所有Project、全部Note和所有协议都不应默认进入执行上下文。

### 2.3 三方共同遵守一套协议是什么意思

三方共享同一语义合同，但使用不同投影：

| 参与者 | 需要看到 | 不应拥有 |
|---|---|---|
| 用户 | 系统理解、采用Context、协议、计划、权限、当前步骤、验证和状态变更候选 | 内部密钥、隐藏推理、数据库实现 |
| Chat | 权威事实、协议revision、策略、Context、RunSpec、Trace、Evidence和提交门 | 替用户决定主观目标；替Provider伪造结果 |
| pi/执行层 | 当前任务、必要背景、资源、能力、步骤、验证和输出合同 | 全部Product数据库、无关项目、长期状态直接写权、超出RunSpec的权限 |

“同一协议”不是把同一份大Markdown复制给三方，而是同一版本和语义经过角色化投影后仍能相互核对。

## 3. 优化后的目标方案

### 3.1 候选协作协议族

候选`CollaborationProtocolDefinition`至少包含：

| 部分 | 含义 |
|---|---|
| Identity | 协议ID、revision、状态、作者、来源和兼容范围 |
| Applies When | 适用意图、Project kind、Work kind和前置条件 |
| Domain Model | 使用哪些既有产品对象；不允许协议自行创建第二套Project/Task |
| Lifecycle Guidance | 推荐阶段、允许跳过条件、进入和退出判断 |
| Required Context | 每一阶段必须或可选读取的Context类别 |
| Interaction Rules | 什么必须澄清、什么可以默认、用户怎样纠正 |
| Planning Pattern | 是否需要计划、怎样拆分、何时重规划 |
| Agent/Runtime Roles | 哪些语义角色需要模型、pi或确定性Executor |
| Skill/Tool Requirements | 可用Skill、真实Tool和最小能力 |
| HITL Points | 决策点、建议策略和不可放宽下限 |
| Validation | 完成标准、检查器、Reviewer触发条件和Evidence |
| Commit Rules | 可以提出哪些Project/Work/Note/Memory/Artifact Patch |
| Summary Rules | 本轮必须提取什么重点，什么不能自动长期化 |

首批协议候选：

1. `simple-answer`：简单问答，不创建长期Work。
2. `software-delivery`：软件项目开发、调试、重构、文档和交付。
3. `general-project`：非软件项目，支持目标、里程碑、Work与Evidence。
4. `standalone-task`：无Project的一次或短期任务。
5. `learning`：学习目标、路径、练习、笔记、掌握证据和复习。
6. `research`：问题、来源、摘录、判断、冲突和结论证据。
7. `recurring-brief`：周期触发、资料获取、筛选、去重、Delivery和补偿。

协议是持续协作主Workflow使用的数据和规则，不是7个互相叠加的根Workflow。根Workflow根据本轮意图和已绑定对象选择一个主协议，并在多Intent场景中创建多个受控子计划。

协议阶段也不能复制Project或Work状态机。推荐做法是把方法阶段投影为Milestone/Plan Node，并由协议声明进入条件、建议Artifact和退出证据：

| 协议 | 推荐阶段 | 典型产物和完成证据 |
|---|---|---|
| software-delivery | 目标澄清→现状/约束→方案决定→计划→实现→验证→交付/运营 | Brief、Decision、Plan、代码/文档Artifact、测试与交付Evidence |
| general-project | 立项目标→范围/参与者→里程碑→推进→验收→复盘/归档 | Project Goal、Milestone、Action、成果、验收和复盘Note |
| standalone-task | 捕获→澄清→就绪→执行→验证→完成/取消 | WorkItem、Action、结果与必要Evidence |
| learning | 目标→基线诊断→学习路径→学习/练习→评估→复习→阶段完成 | Learning Note、练习Artifact、测验Evidence、薄弱点和复习Action |
| research | 问题→来源策略→采集→证据评价→综合→结论→复核 | 来源、Research Note、冲突矩阵、结论与证据有效性 |
| recurring-brief | 定义→首次确认→周期触发→执行→验证→交付→周期复审 | Schedule、每次Artifact/Evidence/Delivery、漏跑与复审记录 |

这些阶段是可解释的推荐路径，不是不可跳过的瀑布。用户可以在ExecutionDraft或Project视图中跳过、合并或返回阶段；系统记录原因和受影响的验证，而不是强迫所有Project生成同一套文档。

### 3.2 Context Compiler

Context装配保留现有两阶段检索，再增加步骤级物化：

#### 阶段A：召回和消歧

输入：

- 当前User Message原文。
- 未解决Clarification。
- 最近TurnSummary中的当前焦点和开放问题。
- Project/Work/学习目录的轻量索引。
- 候选协议的名称与适用条件。

输出：

- 一个或多个Intent Candidate。
- 候选Project/Work。
- 主协议候选。
- 置信度和公开依据。
- 是否需要用户回答或确认。

阶段A不能读取所有项目详情，也不能直接决定长期状态。

#### 阶段B：目标绑定后的ContextPackage

只装配已确认或高置信唯一目标的：

- 背景、目标和当前状态。
- 当前里程碑、开放Work、Plan与Action。
- 已接受决定。
- 相关Note片段和Accepted Memory。
- Artifact、Evidence和文件入口。
- 用户/Project绑定的协议规则。
- 相关历史摘要和必要原始Message引用。

每项记录来源、revision、采用/排除原因、有效性和Token估算。

#### 阶段C：步骤级物化

从RunSpec和ContextPackage为每个步骤生成`StepInputProjection`：

```text
Intent Agent       -> 原始输入 + 轻量目录 + 开放问题 + 协议适用条件
Planner Agent      -> 已确认目标 + 当前状态 + 约束 + 可用能力摘要 + 验证目标
pi Executor        -> 当前可执行步骤 + 资源入口 + Tool权限 + 测试/Evidence + 停止条件
Reviewer Agent     -> 结果/Artifact + 验收规则 + Evidence；默认不给写权限
Summary Agent      -> 原始User/Assistant公开结果 + 已提交状态变化 + 未解决问题
```

这不是第三次无边界检索，而是从已授权RunSpec中按职责裁剪。

### 3.3 发给执行层的工作包

pi收到的不是“用户原话+聊天历史”，而是：

| 顺序 | 内容 | 为什么需要 |
|---:|---|---|
| 1 | 产品和执行角色指令 | 知道自己是执行者，不拥有产品事实和最终批准 |
| 2 | 当前任务 | 避免把整个Project当作本次任务 |
| 3 | 背景和当前状态 | 理解为什么现在做、已有结果是什么 |
| 4 | 目标和期望结果 | 对齐交付结果 |
| 5 | 已接受决定 | 不重开用户已经决定的问题 |
| 6 | 范围、非目标和禁止事项 | 防止范围蔓延 |
| 7 | 当前步骤和依赖 | 支持拆任务与按步骤推进 |
| 8 | 资源清单和读取顺序 | 先读入口文件，不把全部内容内联 |
| 9 | 能力Allowlist和环境 | 限制Tool、路径、网络和副作用 |
| 10 | 验证与Evidence | 让“完成”可被证明 |
| 11 | 输出和产品Patch合同 | 区分Artifact、回复和状态变更候选 |
| 12 | 停止、澄清和扩权条件 | 不让执行层猜测或私自扩大范围 |
| 13 | Correlation和预算 | 支持Trace、幂等、Token/时间/调用次数控制 |

组合优先级：

```text
System Safety Floor
> Principal/Scope/Capability约束
> 当前已接受ExecutionDraft与用户本轮显式决定
> Project/Work已接受决定和绑定协议
> 用户长期偏好与默认协议
> 当前步骤指令
> 召回的背景材料
```

低优先级内容与高优先级冲突时不能静默合并；要排除、降级为参考或重新HITL。

### 3.4 用户参与、观察和看护

用户参与分4个时间点：

1. **理解阶段**：查看Intent、关联目标、协议和Context；回答澄清或修正。
2. **准备阶段**：编辑Plan、ExecutionDraft、能力、预算、验证和输出。
3. **执行阶段**：在Workflow Run View查看当前节点、步骤输入输出、Tool、文件变化、预算和验证；可以Pause、Cancel、Steer或拒绝扩权。
4. **提交阶段**：查看Artifact、Evidence、验证结果和Project/Work/Memory Patch；接受、部分接受、要求修复或拒绝长期写入。

运行视图不展示隐藏推理，但必须展示公开决定依据、候选边实际值、采用Context、Model/Tool Attempt、Artifact Diff、验证命令和结果。

### 3.5 验证—修复—提交

```text
执行结果
-> 确定性检查（Schema、文件、测试、Hash、状态、静态规则）
-> 必要时Reviewer语义检查
-> 通过
   -> 形成Evidence和产品Patch候选
   -> HITL/策略提交
-> 未通过且仍在原RunSpec范围和修复预算内
   -> 生成结构化缺陷
   -> 回到pi修复步骤
-> 未通过且需要扩范围/权限/预算，或超过修复次数
   -> 暂停并请求用户决定
```

Reviewer不能用一句“看起来不错”替代确定性Evidence。pi也不能因为测试失败仍把Work标记为completed。

### 3.6 回合沉淀

每次Interaction终态后分别处理：

1. 原始Message：始终保留。
2. TurnSummary：提取主题、目标、决定、状态变化、开放问题、下一焦点和噪声排除。
3. Project/Work Patch：只有通过提交门才成为权威状态。
4. Note：用户要求记录或协议规则允许时形成revision。
5. Memory Candidate：只保存可能跨会话复用的稳定内容，不能自动接受。
6. Context Index：异步更新，可重建；失败不删除原始事实。

## 4. 基础Workflow的逻辑结构

以下是目标逻辑，不表示必须把每一行做成新的MAF节点：

```text
接纳User Message并建立Interaction
-> 读取开放问题与最近TurnSummary
-> 阶段A轻量召回
-> 确定性命令护栏 / Intent识别
-> 选择主协议候选
-> 目标消歧与HITL
-> 阶段B ContextPackage
-> Context审核策略
-> 判断是否需要Plan
-> Plan生成、拆分和审核
-> ExecutionDraft生成与编辑
-> 执行授权并编译RunSpec
-> 对每个步骤生成StepInputProjection
-> Agent / pi / Tool执行
-> 验证—修复循环
-> Result与产品Patch审核
-> 原子提交Product事实与Outbox
-> TurnSummary / 索引派生
-> Assistant Message与Delivery
```

确定性节点负责查询、路由、版本、策略、事务和校验；Agent节点只放在需要语义判断或生成的位置。简单确定性查询可以在0次模型调用下完成。

## 5. 场景一：现有软件项目增加功能

### 5.1 前置状态

- 正式Project：`贪吃蛇`，kind=`delivery`，status=`active`。
- 当前里程碑：可玩版本。
- 开放Work：碰撞检测已完成；暂停功能未创建。
- 当前Plan revision：3。
- 项目协议：`software-delivery@2`。
- 用户规则：代码变更必须运行单元测试；用户可见文档必须有metadata。
- 仓库入口：README、AGENTS、项目状态文件和测试命令引用。

### 5.2 用户输入

> 给贪吃蛇加一个暂停功能。

### 5.3 详细运行

| 步骤 | Chat动作与输入 | 输出/权威状态 | 用户可见与HITL |
|---:|---|---|---|
| 1 | 接纳原始Message，生成Interaction | User Message已提交；Run尚未创建 | 聊天气泡出现，显示正在理解 |
| 2 | 阶段A读取输入、最近焦点、Project轻量目录 | 唯一候选`贪吃蛇`，意图=`continue_project_feature` | 显示“关联贪吃蛇，置信度0.97” |
| 3 | 选择`software-delivery@2` | ProtocolBinding候选 | 唯一高置信且未跨项目，可按策略自动关联；仍显示依据 |
| 4 | 阶段B读取目标、开放Work、Plan、决定、规则和资源引用 | ContextPackage revision/hash | Context Inspector显示采用和排除；旧闲聊和英语学习被排除 |
| 5 | 判断任务复杂度 | 需要3步短Plan：交互定义、实现、验证 | 用户策略若“简单功能自动计划”则自动；否则可编辑 |
| 6 | 形成新Work候选和Plan revision候选 | 仍不是正式Work | Work Board显示将创建“暂停功能” |
| 7 | 生成ExecutionDraft | 包含范围、资源、pi能力、测试、metadata检查和停止条件 | 用户可直接改目标、步骤、文件范围或验收标准 |
| 8 | 用户接受Draft | Decision、Grant和不可变RunSpec | 旧revision失效；RunSpec绑定Project/Plan/协议/Context |
| 9 | pi步骤1读取指定入口文件 | 公开文件摘要和实现定位 | Workflow图显示正在读取；文件内容按需读取，不内联整个仓库 |
| 10 | pi需要修改文件 | Tool Draft和参数 | 写操作按有效Tool策略暂停或自动；用户可查看路径和Diff意图 |
| 11 | pi实现后运行测试 | Tool结果与测试Evidence候选 | 实时显示命令、耗时、退出码；不展示隐藏推理 |
| 12 | 确定性验证metadata、测试和文件范围 | Validation结果 | 任一失败进入修复循环 |
| 13 | Reviewer仅在“交互是否符合暂停语义”需要判断时运行 | 语义审查候选 | Reviewer无写权限，只返回结构化问题 |
| 14 | 形成Artifact/Evidence/Work Patch | Work仍未completed | 用户查看Diff、测试和建议状态 |
| 15 | 用户或策略接受产品Patch | Work进入completed或ready_for_review；Trace/Outbox同事务 | 最终回复说明改了什么、证据、剩余事项 |
| 16 | 生成TurnSummary | 摘要和索引派生 | 下一轮“暂停还有个问题”可召回该Work |

### 5.4 发给pi的实际语义块

应包含：

- 任务：在贪吃蛇项目增加暂停/恢复。
- 背景：当前可玩版本、碰撞检测完成、当前Plan revision 3。
- 目标：用户可以暂停并恢复，暂停期间游戏状态不推进。
- 已接受决定：沿用当前输入方式和项目架构。
- 范围：只修改游戏状态和必要测试；不重构渲染层。
- 步骤：读入口与规则、定位状态循环、实现、测试、回报。
- 资源：AGENTS、README、状态循环文件入口、现有测试目录。
- 能力：项目根内read/edit/test；无外部网络和删除权限。
- 验证：既有测试+暂停状态新增测试+metadata规则。
- 输出：文件Diff、测试证据、未解决问题、Work Patch候选。
- 停止：架构与记录不一致、需要新增依赖、需要改范围、测试环境不可用。

不应包含：

- 英语学习Project。
- 所有旧聊天原文。
- 其他仓库文件全文。
- 未接受的“顺便重写游戏引擎”建议。
- 密钥和其他Project的Note。

### 5.5 异常分支

1. 测试失败：Work保持`in_progress`，结构化失败回到pi；不得向用户说完成。
2. pi发现需要引入新依赖：超出原Capability/Scope，暂停请求用户决定。
3. 用户执行中说“不要快捷键，点按钮”：Steer到安全点，新Draft/Amendment，受影响步骤和审批失效。
4. 浏览器断线：Worker继续；重连按Cursor恢复同一Run，不创建第二次Provider/Tool Attempt。
5. Worker在写文件后崩溃：Tool结果进入`result_unknown`时不能自动重写，先检查文件Hash或人工对账。

### 5.6 通过标准

- 唯一Project正确关联，且用户知道为什么。
- 发给pi的内容不含无关历史。
- 每个写操作和范围扩大符合HITL策略。
- 测试失败不产生完成状态。
- 最终Artifact、Evidence、Work和TurnSummary职责分开。

## 6. 场景二：用户只有模糊想法，需要建立新项目

### 6.1 用户输入

> 我想做个能帮小孩背单词的东西。

### 6.2 第一性问题

系统不知道这是：

- 只想讨论创意。
- 想建立正式Project。
- 想马上写代码。
- 想做Web、CLI还是学习方案。

不能直接创建Project并启动pi，也不能一次问十几个表单问题。

### 6.3 运行

1. 接纳Message并产生`idea_exploration` Intent Candidate。
2. 阶段A没有匹配正式Project，`general-project`和`software-delivery`均为候选。
3. 系统先回复自己的最小理解，并提出一个真正可回答的问题：

   > 你现在更想先把目标和使用场景想清楚，还是已经确定要做一个软件原型？

4. 当前Interaction以Clarification Assistant Message结束；不显示“接受并继续”审批按钮。
5. 用户回答“先做个最小网页原型，小孩每天练10个词”。
6. 新User Message与未解决问题关联，重新识别为`create_software_project`。
7. Chat形成Project候选：

   - 目标：每天10词的儿童背词网页原型。
   - 非目标：账号、云同步、商业化。
   - 初始里程碑：可完成一轮10词练习。
   - 风险/未知：年龄、词库来源、反馈方式。

8. 用户审核Project、初始Work和Plan候选；可以改名或只保留想法Note。
9. 用户接受后，Project/Work/Plan在一个产品事务中激活，Outbox更新索引。
10. 只有用户选择“继续实现”时才生成ExecutionDraft和RunSpec；建立Project不等于授权pi写代码。

### 6.4 异常与优化验证

- 用户说“我只是随便想想”：保存原始会话，可按用户要求形成`Note(kind=idea)`；不创建Project。
- 用户不回答澄清：开放问题进入TurnSummary，下一次可以继续；不反复自动提醒。
- 用户一次给足技术和目标：可以跳过澄清，但仍展示Project候选和创建后果。
- Project创建成功但索引失败：Project仍是权威事实，标记索引待重建。

### 6.5 通过标准

- 澄清和审批是两种不同交互。
- 用户可以停留在Idea，不被迫进入Project。
- Project创建和项目执行是两次不同授权。
- 初始协议提供结构，不强迫用户走固定瀑布阶段。

## 7. 场景三：同名项目、跨项目上下文和误关联

### 7.1 前置状态

- `贪吃蛇-Web`：active，最近处理暂停功能。
- `贪吃蛇-教学版`：paused，最近处理课程讲义。

### 7.2 用户输入

> 继续贪吃蛇，把昨天说的问题修掉。

### 7.3 运行

1. 阶段A召回两个Project，分数接近。
2. “昨天说的问题”分别命中：

   - Web：暂停后计时器仍前进。
   - 教学版：讲义缺少碰撞检测图。

3. 系统不能选择最近Project后静默执行。
4. 创建Project Association Human Decision Request，提供两个可读选项、最近焦点和短ID，也允许文字回答。
5. 用户选`贪吃蛇-Web`。
6. 选择记录绑定当前Interaction；阶段B只加载Web项目。
7. 教学版内容进入ContextPackage排除列表，原因=`not_selected_project`。
8. 后续ExecutionDraft明确“修复暂停计时器”，避免只把“昨天的问题”传给pi。

### 7.4 安全分支

- 两个Project属于不同Scope：阶段A只显示用户可见候选；不可见项目不泄漏标题。
- 用户回答“都不是”：清除候选关联，要求用户补充或作为新事项。
- 用户选错后在ExecutionDraft纠正：生成新ContextPackage和Draft revision，旧Approval失效。
- 两个Project都需要做：产生两个Intent/Work分支和两个RunSpec，不把两个仓库混进同一个pi工作目录。

### 7.5 通过标准

- 多候选时不静默关联。
- 未选Project不进入执行上下文。
- 修改关联会使所有下游版本与授权失效。
- 用户能通过标题、焦点和可见短ID做决定。

## 8. 场景四：独立任务、任务拆分和用户行动

### 8.1 用户输入

> 帮我整理一份明天会议要讲的AI Agent现状，晚上提醒我确认。

### 8.2 意图拆分

这不是一个单一动作，至少包含：

1. 研究和整理内容。
2. 生成会议材料Artifact。
3. 晚上提醒用户确认。

用户没有要求建立长期Project，可以创建无Project的WorkItem及3个Plan Node：

```text
N1 AI研究与来源收集（Agent）
-> N2 生成会议材料（Agent/pi）
-> N3 晚上提醒确认（系统Schedule/Delivery）
-> N4 用户确认（User Action）
```

### 8.3 运行

1. Intent Agent输出多动作结构和时间约束。
2. Chat显示计划及责任方，不用“我们会完成”掩盖用户行动。
3. 用户确认研究范围、材料格式和提醒时间。
4. N1只获得研究Tool和来源标准，不获得文件写权限。
5. N2获得N1公开结果、文档模板和Artifact写权限，不自动获得网络。
6. N3由Scheduler在指定时间触发Delivery，不由模型“记住晚上提醒”。
7. N4是用户ActionItem；提醒送达不等于用户已确认。
8. 用户确认后，ActionItem completed；会议材料才可标记accepted。

### 8.4 异常

- 晚上设备离线：Delivery Attempt失败，按策略重试；不把研究Run标为失败。
- 用户提前确认：取消尚未触发的提醒，但保留取消Trace。
- 研究来源不足：N1停止并让用户决定扩大来源或接受不完整结果。
- 用户把提醒改到明早：只修改Schedule revision，不重跑研究。

### 8.5 通过标准

- 无Project任务仍有Work/Plan/责任和恢复。
- Agent行动、系统触发和用户行动明确分开。
- Run成功、Artifact完成、Delivery送达和用户确认是4个状态。

## 9. 场景五：跨天学习、练习和回到旧焦点

### 9.1 第一天

用户：

> 我要系统学习FastAPI，先看看我现在会多少。

运行：

1. 识别`learning`协议。
2. 没有对应Project，形成`Project(kind=learning)`候选。
3. 先做诊断而不是直接生成长期课程。
4. 用户同意后，建立学习Project、诊断Work和初始Plan。
5. Agent提出问题；用户答案是Evidence来源，不直接把“掌握”写成事实。
6. 根据诊断形成学习单元、薄弱点候选和复习计划。
7. 用户接受后更新Work和Plan；稳定学习偏好可以提出MemoryCandidate。

### 9.2 第二天

用户新建Product Session：

> 继续昨天的依赖注入。

运行：

1. 阶段A读取最近TurnSummary和学习Project目录。
2. 唯一命中FastAPI学习Project及开放`dependency-injection` Work。
3. 阶段B加载学习目标、上一轮错误、相关Note、练习Evidence和下一步。
4. 不加载昨天全部问答，更不加载其他Project。
5. 本轮先复习薄弱点，再给新练习；Plan按学习协议推进。

### 9.3 第三天切换项目

用户：

> 先不学了，帮我给书签API加导出功能。

1. 识别切换到软件Project。
2. FastAPI学习Project保持active或按用户决定paused；不会因焦点切换自动completed。
3. 当前Session焦点切换，ContextPackage排除学习内容。
4. 执行书签API任务。

### 9.4 第四天回到学习

用户：

> 回到FastAPI，我上次哪里没掌握？

1. 确定性查询学习Work、练习Evidence和Note。
2. 模型可以解释薄弱点，但不能从聊天语气猜测掌握程度。
3. 给出来源和最近验证日期；过期能力标记需要重新诊断。

### 9.5 异常

- 用户纠正Note：“我已经会Depends了，是测试覆盖差”：生成Note revision和学习Plan候选，不覆写旧Evidence。
- 学习摘要模型失败：原始Message和已提交Work仍在；摘要进入可重试派生任务。
- 用户拒绝长期Memory：偏好只在当前Session使用，不影响学习Project事实。
- 同一天学习英语和FastAPI：形成两个Project焦点，不把两套Note合并。

### 9.6 通过标准

- 跨Session、跨天、切换Project后仍能恢复学习焦点。
- 学习进度由练习Evidence和明确提交维护。
- Note、Memory、Work和TurnSummary不混用。
- 学习协议提供诊断—学习—练习—验证—复习闭环。

## 10. 场景六：周期AI资讯

### 10.1 用户输入

> 每天早上八点给我一份AI Agent资讯，只要真正重要的，别重复。

### 10.2 需要建立的事实

- WorkItem：持续AI Agent资讯。
- Schedule revision：每天08:00、时区Asia/Shanghai。
- Research/Brief协议：来源、时间窗口、重要性、去重、引用和字数。
- Delivery目标：Chat Web，未来可扩展Channel Binding。
- 去重状态：已交付主题/来源指纹。
- HITL策略：首次模板确认、正常每日自动、来源异常或成本越界暂停。

### 10.3 详细运行

1. 系统先澄清“每天”时区和节假日策略；已有用户时区可以显示后采用。
2. 生成可读订阅草稿，不立即创建无限期后台任务。
3. 用户审核来源范围、重要性定义、字数、时间、Delivery和暂停方式。
4. 接受后提交Work+Schedule+协议绑定+Outbox。
5. Scheduler每次到点创建独立触发记录和Product Run，不复用昨天Run。
6. Research步骤只获取时间窗口内的来源。
7. 确定性去重按URL、内容hash和主题指纹；模型只负责重要性和摘要候选。
8. Validator检查引用、发布日期、重复、字数和敏感内容。
9. Artifact形成当日简报；Delivery Worker发送并记录Receipt。
10. TurnSummary记录本次运行结果，但不把每篇新闻写成长Memory。

### 10.4 异常

- 没有重要新闻：发送“今日无达到阈值的更新”或按用户规则静默，不编造内容。
- 来源API失败：标明覆盖不完整；达到最低来源数前不冒充完整简报。
- 08:00 Worker宕机：恢复后依据misfire策略补跑一次或跳过，绝不能补跑多次。
- Delivery失败：Artifact仍成功；Delivery重试，不重做研究。
- 用户说“这周暂停”：Schedule进入paused，Work不删除。
- 用户把范围改成“大模型产品更新”：新协议/Schedule revision，旧规则可追溯。
- 某来源后来删除：相关Evidence失效，历史Artifact保留但显示来源不可用。

### 10.5 通过标准

- 周期性由Schedule和Worker保证，不由Agent记忆保证。
- 每次发生独立Run/Attempt/Delivery，可追踪漏跑和重复。
- 去重、来源和验证是明确合同。
- 失败不会产生重复推送或假完整。

## 11. 场景七：研究、笔记与来源失效

### 11.1 用户输入

> 调研Codex和Claude Code怎样管理上下文，整理成笔记，以后设计Agent时能复用。

### 11.2 运行

1. 识别`research`协议，创建或关联Research Project。
2. Plan拆分：研究问题、来源约束、分别核对、比较、结论、笔记、Memory候选。
3. Context明确：

   - Codex可使用官方开源源码和官方文档。
   - Claude Code核心未开源，只能使用官方行为文档。
   - 第三方博客默认排除。

4. Research Agent获得网络/本地源码只读能力；没有写Note权限。
5. 每条结论绑定来源、版本/日期和证据片段。
6. Note Writer根据已验证研究结果生成`research_note` revision。
7. Validator检查metadata、来源、事实/推断分层和链接。
8. 用户接受Note；可复用规则再成为MemoryCandidate或协议改进候选。

### 11.3 来源失效

如果Claude官方页面删除：

1. Evidence状态变为`source_unavailable`。
2. Note仍存在，但相关结论显示证据降级。
3. 由该结论产生的Memory或协议规则进入复核候选。
4. 不删除历史Note，也不静默继续当作最新事实。

### 11.4 通过标准

- 事实、参考经验、本项目推断和待审核决定分开。
- Note是知识资产，Memory只保存获准复用的内容。
- 来源失效可传播，不改写历史。

## 12. 场景八：用户自定义文档规范和自动修复

### 12.1 用户规则

> 这个项目里以后所有设计文档都必须有metadata，写完要自检，目标、状态、日期和来源一个都不能少。

### 12.2 规则落点

不能只保存为“用户偏好”Memory。系统应提出一个项目级可执行协作规则候选：

- scope：当前Project。
- applies_to：设计文档Artifact。
- required_fields：goal/status/date/sources。
- validator：确定性frontmatter/metadata检查器。
- failure_action：回到原执行步骤修复。
- max_repairs：2。
- final_action：仍失败则要求用户决定。

用户接受后，该规则绑定到Project协议revision。

### 12.3 后续写文档

1. Context Compiler采用该规则，记录来源和revision。
2. ExecutionDraft的Validation Contract自动包含metadata检查。
3. pi得到字段要求和检查命令，不需要读取整个用户偏好历史。
4. pi写完后，确定性Validator先检查。
5. 缺`sources`时，返回结构化缺陷，不调用Reviewer浪费Token。
6. pi在原范围内修复。
7. 第二次通过，生成文件hash和验证Evidence。
8. Work状态Patch等待提交门。

### 12.4 异常

- 用户本轮明确说“这个临时草稿不用metadata”：当前Run override可请求例外；例外有作用域和理由，不修改长期规则。
- 项目规则和用户全局规则冲突：更具体规则可覆盖用户偏好，但不能突破系统安全下限；冲突必须在Draft显示。
- Validator版本升级：新Run绑定新版本；旧Artifact不被追溯标成当时失败，除非用户发起重新审计。
- pi两次都失败：暂停，显示缺陷和已尝试修复，不无限自循环。

### 12.5 通过标准

- 可执行规则和描述性Memory分开。
- 规则能进入ExecutionDraft、pi输入和Validation。
- 修复有次数、范围和成本边界。
- 例外可追踪，不静默破坏长期规则。

## 13. 场景九：明确产品查询与简单问答

### 13.1 “我有哪些项目？”

1. 确定性命令护栏识别Project Catalog Query。
2. 直接查询Product Harness；模型调用数为0。
3. 返回正式Project目录、状态和可见短ID。
4. Conversation保存Message和结果；TurnSummary可记为“查询项目目录”。
5. 不创建Work、Project或Memory。

如果目录为空，返回“当前没有正式Project”；摘要中的候选项目只能另列为候选。

### 13.2 “什么是依赖注入？”

1. 识别简单知识问答。
2. 如果当前焦点是FastAPI学习，系统显示“可采用FastAPI学习上下文”；用户或策略决定是否关联。
3. 未关联时按通用问答回答，不创建Work。
4. 关联时可生成learning_note候选，但不能因为回答一次就把学习单元标为掌握。
5. 原始会话和TurnSummary保留；长期Memory默认不更新。

### 13.3 通过标准

- 权威查询不用模型猜。
- 简单问答仍留下原始会话和摘要，但不误建任务。
- 是否关联学习/项目对用户可见。

## 14. 场景十：一句话包含多个意图

### 14.1 用户输入

> 先总结一下昨天FastAPI学到哪了，再帮书签API加导出；如果时间不够就只给计划。

### 14.2 解析

至少两个Intent：

1. 查询学习状态，确定性读FastAPI Project。
2. 推进书签API软件Project，可能执行。

还有一个控制条件：时间不足时降级为Plan-only。

### 14.3 运行

1. Intent Agent输出两个Intent及顺序。
2. Chat显示两个目标和两个Project，不把Context混成一个包。
3. 查询分支先完成，产生用户可见学习摘要。
4. 软件分支读取书签API Context，并估算预算。
5. 若预算不足，ExecutionDraft明确只生成Plan，不给pi写权限。
6. 若预算足够，用户可选择只执行第一个可交付步骤。
7. 两个分支分别形成ContextPackage、结果和状态提交；Interaction聚合两个结果。

### 14.4 异常

- 一个分支失败：另一个已完成结果保留；Interaction显示部分完成，不冒充全部成功。
- 用户中途取消软件分支：学习查询不回滚。
- 两个分支都要调用不同Project的Tool：分别授权，不共享工作目录和能力。

### 14.5 通过标准

- 多Intent有独立目标、Context、Plan、Run和结果。
- 用户能部分执行、部分取消。
- 一个分支失败不污染另一个Project状态。

## 15. 场景十一：执行中用户看护与改变方向

### 15.1 用户开始运行

ExecutionDraft包含4步：

1. 读取项目。
2. 修改后端。
3. 修改前端。
4. 运行测试并提交结果。

### 15.2 用户运行中看到

Workflow Run View应显示：

- 当前真实MAF节点和代码阶段。
- 当前StepInputProjection的可公开摘要。
- 已读/拟改文件。
- Tool调用、参数、状态和耗时。
- Model调用次数、Token/费用预算。
- 测试和Validator状态。
- 尚未执行的步骤。
- 为什么走当前分支以及未走分支原因。

### 15.3 用户干预

用户说：

> 前端先别改，只做后端接口。

处理：

1. 这是Steer，不是普通聊天附加历史。
2. Chat在安全点暂停当前Run。
3. 影响Scope、Plan和Validation，旧RunSpec不能原地修改。
4. 形成Amendment候选或新ExecutionDraft revision。
5. 显示将取消前端步骤、修改完成标准和剩余预算。
6. 用户确认后继续；旧Tool授权中与前端路径相关的部分失效。

### 15.4 其他干预

- Pause：只暂停调度，不假设正在外发的Tool可立即停止。
- Cancel：按精确runId取消；发送后结果可能未知。
- “以后这类只读操作别问”：选择作用域，生成HITL Policy revision。
- 扩大权限：必须重新评估Capability和HITL，不能靠聊天一句话直接授权Shell。

### 15.5 通过标准

- 用户看得到真实步骤和公开内容，而不是动画。
- Steer会改变合同并使旧授权失效。
- Pause、Cancel、Steer、Retry、Restart、Resume语义不混用。

## 16. 场景十二：失败、结果未知、并发和恢复

### 16.1 Provider审批前失败

- ModelCallDraft构建失败：没有Provider Attempt。
- 用户可修改Draft或降级模型。
- Product Run保持等待/失败，不产生Assistant假结果。

### 16.2 Provider发送后断线

- Attempt进入`outcome_unknown`或由后台Transport继续获得确定结果。
- 浏览器重连只恢复事件，不重复发送。
- Provider支持查询时先按request ID对账；不支持时要求人工决定。

### 16.3 Tool写入后Worker崩溃

- Tool Ledger记录已外发边界和幂等键。
- 可查询文件系统时读取目标hash对账。
- 外部邮件等不可查询时进入人工处置，不自动重发。

### 16.4 两个Session同时修改同一Plan

- 两边读取revision 4。
- A提交revision 5成功。
- B提交CAS冲突，看到当前revision和Diff入口。
- B的ExecutionDraft和Approval失效，不能覆盖A。

### 16.5 Checkpoint恢复

- HITL等待时API/Worker重启。
- Product Decision先落库，Outbox发`resume_checkpoint`命令。
- 新Worker核对Workflow definition/version、图签名、Run/Attempt和Pending Request。
- 从已验证安全点恢复；前置节点不重跑。
- 该保证不能外推到尚未接合的子Workflow或Tool副作用阶段。

### 16.6 来源撤销

- 已批准Draft等待执行时，其Context Source权限被撤销。
- `context_hash`失效，RunSpec不可启动。
- 系统重新装配Context并解释被移除内容；不能继续使用缓存正文。

### 16.7 预算耗尽

- 达到模型调用或修复次数上限。
- Runtime停止，返回已完成步骤、未完成项和Evidence。
- 用户可以追加预算形成新授权；Worker不能自行增加。

### 16.8 通过标准

- 任何失败都能区分未发送、已发送、已解码、已提交和已交付。
- 不盲目重试未知副作用。
- 并发靠revision/CAS收敛。
- 恢复只从已证明的安全点发生。

## 17. 其他合理场景与异常矩阵

| ID | 场景 | 正确动作 | 禁止动作 |
|---|---|---|---|
| E01 | 用户说“第一个”回答上一轮澄清 | 带回未解决问题和选项版本，形成新User输入 | 脱离问题重新猜Intent |
| E02 | 用户删除提供上下文的Message | 保留删除Trace，相关Context/Memory/Evidence失效或复核 | 静默保留副本继续采用 |
| E03 | Project已归档但用户说继续 | 展示归档状态，请求恢复或只读查看 | 自动激活并执行 |
| E04 | Work被另一个Run完成 | 当前Run在提交门检测revision变化，停止或重规划 | 再次提交完成 |
| E05 | 用户要求删除文件 | 系统安全和Tool策略强制人工，展示精确目标和恢复性 | 用普通自动通过放行 |
| E06 | 用户要求读取另一个Project的敏感Note | Scope Policy拒绝或要求明确授权 | 因语义相关就自动采用 |
| E07 | Model生成不存在的Tool名 | Schema/Catalog拒绝，记录invalid output | 临时创建`new_tool`执行 |
| E08 | Planner建议扩大目标 | 作为Plan候选展示，不进入RunSpec | 让pi自行扩范围 |
| E09 | Reviewer与测试冲突 | 确定性失败优先，结果不通过 | Reviewer一句“没问题”覆盖测试 |
| E10 | 测试命令本身过期 | 标记Validation不可执行，请用户或协议维护者修正规则 | 把“无法测试”当通过 |
| E11 | Memory Candidate与现有Memory冲突 | 显示来源和Diff，接受新revision或保留旧版 | 最新模型输出自动覆盖 |
| E12 | 用户说“永远不要问我” | 只在允许作用域创建偏好；安全下限仍生效 | 创建无限边界永久授权 |
| E13 | 费用突然超过预算 | 暂停并解释已消费/预计剩余 | Worker自动换更贵模型 |
| E14 | Agent结构化输出解析失败 | 保存Attempt和Disposition，有限修复或人工 | 把原始文本直接写产品事实 |
| E15 | Summary与已提交Work矛盾 | Work事实优先，Summary标记重建 | 用Summary覆盖Work |
| E16 | 同一外部消息重复送达 | Ingress幂等返回原Interaction | 创建两个Run |
| E17 | 用户从另一设备接管 | 验证Principal/Scope，从Event Cursor续接 | 仅凭Product Session ID授权 |
| E18 | Artifact生成成功但Delivery失败 | Artifact/Run保持成功，Delivery独立重试 | 把Artifact删掉或重做Run |
| E19 | 用户只接受Artifact，不接受Memory | 分别提交；Memory保持候选/拒绝 | 用结果接受连带接受Memory |
| E20 | 用户拒绝最终结果但保留代码改动 | 明确区分Artifact存在、结果未接受和Work状态 | 自动回滚或自动completed |
| E21 | 外部资料内容恶意要求越权 | 作为不可信Context，不能覆盖System/RunSpec | 将资料中的指令当系统指令 |
| E22 | 旧协议revision有安全缺陷 | 阻止新Run使用，历史Run保留原绑定；提供迁移审计 | 静默改写历史Run协议 |
| E23 | 计划中存在用户登录步骤 | ActionItem交给用户，执行层等待可验证回执 | Agent索取或记录用户密码 |
| E24 | 模型不可用但任务可确定性完成 | 走查询/规则/Tool确定性分支 | 为保持“Agent感”强制调用模型 |

## 18. 用户拒绝和修改的完整语义

| 位置 | 用户动作 | 系统后果 | 能否继续 |
|---|---|---|---|
| Intent | 修正 | 新Intent revision，重新召回Context | 可以，从意图节点继续 |
| Project关联 | 选择其他/无 | 新ContextPackage；旧下游失效 | 可以 |
| Context | 删除/增加/锁定 | 新context_hash；重新生成Draft | 可以 |
| Plan | 改步骤/责任 | 新Plan revision和Draft | 可以 |
| ExecutionDraft | 修改 | 新draft_hash，重新授权 | 可以 |
| ModelCallDraft | 修改 | 新model_call_hash，再次审批 | 可以 |
| ModelCallDraft | 放弃 | 零发送；本轮可结束并把原输入返回编辑框 | 新Run可重新发送 |
| Tool | 修改参数 | 新Tool Draft；重算权限/风险 | 可以 |
| Tool | 拒绝 | 当前步骤blocked/skipped；按Plan决定替代路径 | 可能 |
| Result | 要求修复 | 在原范围/预算内进入修复步骤，否则新Draft | 可以 |
| Work Patch | 部分接受 | 只提交被接受的状态；其余保留候选 | 可以 |
| Memory | 拒绝 | 不影响原始会话、Artifact或Work | 可以 |
| outcome_unknown | 人工判定 | 记录对账依据，继续、补偿或终止 | 视证据 |

任何拒绝都不能被解释成同意另一件事；任何修改都要明确从哪个安全点重算。

## 19. 方案覆盖检查

| 愿景要求 | 方案位置 | 主要场景 |
|---|---|---|
| 用户表达不清时帮助澄清 | Clarification与Intent | 2、3、E01 |
| 自动补足未说出的上下文 | 两阶段Context+采用理由 | 1、3、5 |
| 持续维护项目 | Harness+软件协议 | 1、2、3 |
| 持续维护任务和责任 | Work/Plan/Action | 4、10 |
| 持续维护学习 | Learning Project/Work/Note/Evidence | 5 |
| 周期资讯和日常工作 | Schedule+Recurring协议+Delivery | 6 |
| Chat、用户、pi共享规范 | 协议多投影+RunSpec | 1、8 |
| 不堆叠全部历史 | Context Compiler | 1、5、9 |
| 每轮提取核心内容 | TurnSummary与派生索引 | 全部 |
| 用户习惯和文档标准 | 协议规则而非仅Memory | 8 |
| 拆任务交给pi | Plan+StepInputProjection | 1、4、10 |
| 执行后自动自检修复 | Validation—Repair | 1、8 |
| 用户观察和看护执行 | Workflow Run View+Steer | 11 |
| 多Agent合理分工 | 角色化步骤投影 | 1、7、10 |
| 失败可恢复且不假成功 | Attempt/Ledger/Checkpoint | 12、E16-E18 |

## 20. 从场景反推的模块责任

| 模块 | 必须新增或保持的责任 | 明确不负责 |
|---|---|---|
| Conversation | 原始Message、Interaction、开放澄清和TurnSummary血缘 | Project/Work权威状态 |
| Collaboration | Intent、协议选择、Plan、ExecutionDraft和产品Patch协调 | 直接执行Provider/Tool |
| Context | 召回、Adoption、预算、失效和StepInputProjection | 接受Memory或提交Work |
| Harness/Work | Project、Work、Plan、Action、Note权威状态 | MAF Checkpoint |
| Protocol Catalog（候选） | 协议revision、规则、Binding和兼容性 | 运行进度、用户身份 |
| Governance | HITL策略、Decision、Approval、RunSpec和请求级授权 | 替代Capability实际限制 |
| Run管理 | Product Run/Attempt/Job、控制、恢复血缘 | Tool外部副作用事实 |
| MAF适配 | Workflow、Agent、Context Provider、Middleware、Checkpoint | Product Session和产品终态 |
| Tool执行 | Catalog、请求、Ledger、幂等、对账和补偿 | 把模型建议当授权 |
| Evidence/Artifact | 产物、证明、Provenance、验证和失效 | Delivery回执 |
| Delivery | 交付Attempt、Receipt、重试和死信 | 重新执行生成任务 |

`Protocol Catalog`是场景推导出的候选模块边界；用户未审核前不创建正式目录或Schema。若审核认为独立模块过重，也可以先作为Collaboration模块内部有明确接口的组件实现，但状态所有权和版本合同不能消失。

## 21. 设计级验收结果

### 21.1 通过

1. 现有Project/Work/Plan/Note/Memory对象足以承载项目、任务和学习主状态，不需要为学习复制第二套生命周期。
2. 现有ExecutionDraft 17部分和RunSpec足以表达整轮执行合同。
3. 现有12类HITL决策点覆盖理解、准备、执行、结果和状态提交。
4. MAF Workflow可组织确定性Executor、Agent、pi Tool和子Workflow，产品状态仍能留在MAF外。
5. 两阶段Context方向正确，能避免把完整History无界交给模型。

### 21.2 必须优化后才通过

1. 需要版本化协作协议及绑定，否则“项目怎样管理、学习怎样推进”仍会散落在Prompt和代码分支。
2. 需要步骤级输入投影，否则多Agent和pi会收到过多Context/权限。
3. 需要可执行用户标准，否则Memory无法保证“必须自检”。
4. 需要Schedule/Recurrence，否则日常周期工作只能靠Agent记忆。
5. 需要Validation—Repair控制合同，否则自动审查可能无限循环或擅自扩范围。
6. 需要多Intent独立Context/Run聚合，否则一句话涉及学习和项目时会交叉污染。

### 21.3 当前无法宣称

1. 通用Tool副作用结果未知对账尚未完成。
2. 独立Evidence/Artifact/Provenance生命周期尚未完成。
3. Delivery和周期Scheduler完整产品能力尚未完成。
4. 任意嵌套Workflow和pi跨进程Checkpoint恢复尚未完成。
5. 多设备、完整容量、保留和生产SLO尚未完成。

## 22. 审核后的测试方案

以下是审核后才进入实施的最小测试资产，不是当前已通过数量。

### 22.1 自动测试

| 测试层 | 最少场景数 | 重点 |
|---|---:|---|
| 协议/规则单元测试 | 12 | 适用条件、revision、绑定、覆盖、冲突和失效 |
| Context Compiler | 12 | 两阶段召回、采用/排除、预算、敏感Scope、步骤投影 |
| 状态机与合同 | 14 | Project/Work/Plan/Schedule/Artifact/Evidence/Delivery候选状态 |
| HITL与授权 | 12 | 作用域、修改失效、部分接受、Steer、扩权、结果未知 |
| Workflow合同 | 10 | 确定性分支、单/多Intent、子步骤、修复循环和节点公开内容 |
| 并发与恢复 | 12 | CAS、重复入站、Lease、Checkpoint、Cursor、Outbox、死信 |
| 前端逻辑与可访问性 | 10 | 协议/Context/Draft/运行/结果视图、键盘、窄屏和可读性 |
| 浏览器E2E | 12 | 本文12个完整场景的用户主路径 |

建议最低自动资产为94个有明确场景ID的新增/扩展测试；不以数字替代风险覆盖。

### 22.2 长跨度测试

1. 30天软件项目：需求变化、两次Steer、一次测试失败、一次Worker重启、最终交付。
2. 35天学习：诊断、学习、练习、遗忘、复习、切换项目、重新评估。
3. 21天周期资讯：正常、无新闻、来源失败、漏跑、暂停、改时间、Delivery失败。
4. 14天研究：多来源冲突、Note revision、Memory拒绝、来源删除和证据降级。
5. 7天多事项：同一用户在3个Product Session间切换2个Project、1个学习目标和1个独立任务。

长测必须断言Context不会随历史线性增长，权威对象revision持续正确，并能说明每轮采用了什么。

### 22.3 真实模型与真实执行层

至少抽样：

1. 意图明确、模糊、多Intent各2轮。
2. Project唯一匹配和双候选消歧各1轮。
3. Planner拆分含用户Action的任务1轮。
4. pi执行、测试失败后修复、用户Steer各1轮。
5. Reviewer语义检查1轮。
6. TurnSummary与MemoryCandidate分离1轮。
7. 逐次ModelCallDraft修改、放弃、重新发送1轮。

真实模型测试断言结构、来源、分支、授权和产品状态，不把自然语言逐字一致当成功标准。

### 22.4 故障实验

必须在以下边界逐项注入：

- Provider发送前、发送后、首字节后、解码后、产品提交前。
- Tool执行前、外发后、部分成功、回调重复、对账失败。
- Worker领取前、续租中、Checkpoint前后、写终态前。
- Outbox写入、领取、重试、死信和重复投递。
- Context来源在Draft前、批准后、执行中失效。
- 两个Session并发修改Plan、协议绑定、Schedule和Memory。

## 23. 已批准的9项愿景决定

1. 采用“协作协议定义+协议绑定”，不只用Prompt、Skill和代码条件表达方法。
2. 首批协议族覆盖简单问答、软件交付、通用项目、独立任务、学习、研究和周期简报；名称和版本可演进。
3. 描述性偏好进入Memory，可执行标准进入协议规则。
4. 在两阶段Context之后增加步骤级`StepInputProjection`。
5. 学习复用`Project(kind=learning)+Work+Note+Evidence`，不建第二套学习数据库。
6. 周期工作使用`Work+Schedule+Run+Delivery`，不让Agent长期驻留记忆。
7. 确定性校验优先、Reviewer按需、有限修复次数、越界重新HITL。
8. 多Intent可在一次Interaction下形成多个独立Context/Run并允许部分成功。
9. 用户可查看公开输入输出、Tool、Artifact、预算和验证并可Pause/Cancel/Steer，但不展示隐藏推理。

这些方向已获准进入实现；字段Schema、迁移、正式Workflow调整和前端开发仍须逐模块满足设计、
回滚、异常和验证门。

## 24. 可复核的逐状态桌面推演

本节不是用自然语言说“应该可以”，而是把候选系统当成状态机逐步执行。每一步都固定：

```text
前置权威状态
-> 本步读取
-> 决策或模型输入
-> 本步提交
-> 用户可见结果
-> 必须成立的不变量
```

其中“候选对象”仍表示待审核设计；“当前实现证据”只引用已经存在的代码和测试，不能互相冒充。

### 24.1 推演A：用户问“我有哪些项目？”

#### 初始状态

```yaml
principal: local-user
product_sessions:
  - PS-A: current
projects:
  - P-SNAKE: {name: 贪吃蛇, kind: software, status: active}
  - P-FASTAPI: {name: FastAPI学习, kind: learning, status: active}
  - P-OLD: {name: 旧博客, kind: software, status: archived}
open_clarification: null
```

#### 逐步执行

| 步骤 | 读取与判断 | 模型/Tool | 提交的状态差异 | 用户可见 | 断言 |
|---:|---|---|---|---|---|
| A1 | Ingress验证Principal和幂等键 | 无 | 新Interaction和原始User Message | “我有哪些项目？”气泡 | 输入先持久化 |
| A2 | 确定性Command Guard匹配“列出我的项目” | 0次模型 | Trace=`project_catalog_query` | Workflow图显示命中目录查询 | 明确查询不能被Intent模型改成新建任务 |
| A3 | Product Query按Principal和status读取目录 | DB只读 | 无写入 | 活动2项、归档1项可分组 | Product事实来自Project表，不从摘要猜 |
| A4 | Presenter生成结构化列表 | 无 | Assistant Message | 展示名称、类型、状态、定位入口 | 空目录时只说没有正式Project |
| A5 | TurnDigest记录主题=`project_catalog` | 摘要可确定性生成 | 新Digest；无Project/Work/Memory变更 | 无额外审批 | 查询仍留下原始会话和重点，但不创建长期事项 |

为什么这条链可行：

1. 当前主Workflow已经有明确Project目录查询的0模型护栏和Product Harness阶段A目录。
2. Product Store已经拥有Project权威状态。
3. 候选协议系统不需要参与这条查询；否则会增加错误分支。

故障注入：

- Project Query失败：Assistant返回可重试错误，Interaction失败有Trace；不能回退到模型编造列表。
- 数据库为空但TurnDigest提到“贪吃蛇”：正式列表仍为空，可以另列“对话中出现但尚未创建的候选”。
- 用户无P-OLD权限：硬过滤后不返回；模型不得通过语义相关性找回。

### 24.2 推演B：四天内学习、切项目、回到学习并新建项目

#### 第一天开始前

```yaml
projects: []
work_items: []
turn_digests: []
```

#### 第一天上午：“我要学习FastAPI，先搞懂依赖注入”

| 步骤 | 本步处理 | 状态差异 | 为什么可以 |
|---:|---|---|---|
| B1 | Intent识别`start_learning`，目标FastAPI/依赖注入，置信度0.94 | 只保存Intent Candidate | 模型可以提出语义候选，但还没有创建Project |
| B2 | 目录查询确认不存在匹配学习Project | 无写入 | 避免同名重复创建 |
| B3 | 选择`learning`协议；提出基线诊断、学习、练习、评估、复习路径 | ExecutionDraft候选 | 学习研究支持主动提取和间隔；路径可跳过 |
| B4 | 用户确认目标并选择“先小测，再解释” | Decision绑定Draft revision | 主观学习方式由用户决定 |
| B5 | 同一事务创建P-FASTAPI、W-DI、Plan和首个Action | Project/Work/Plan正式生效；Trace/Outbox同事务 | Product事实不会来自摘要 |
| B6 | Agent进行小测和解释；用户作答 | 原始Messages和Run Evidence候选 | 学习活动与Product状态分开 |
| B7 | 评估识别“生命周期概念薄弱” | Note Candidate、复习Action Candidate | 评估不能直接宣布掌握 |
| B8 | 用户接受本轮重点与明日复习 | Note revision、Action due=Day2；Digest含开放问题 | 第二天可由结构化Action继续，不靠Agent记忆 |

#### 第一天下午：“切到书签API，把鉴权接口做完”

| 步骤 | 本步处理 | 读取和排除 | 状态差异 |
|---:|---|---|---|
| B9 | 阶段A匹配P-BOOKMARK；若不存在先请求新建确认 | 只读轻量Project目录 | P-BOOKMARK候选或正式创建 |
| B10 | ContextPackage采用书签API目标、当前Work、仓库规则 | 明确排除FastAPI学习Note和复习Action | 新Context revision |
| B11 | 软件协议生成“读取现状→实现→测试→验收”的计划 | 不加载学习材料 | Work/Plan候选 |
| B12 | 用户批准后交给pi步骤执行 | pi仅拿仓库入口、当前Work、范围、测试和停止条件 | Run/Artifact/Evidence；不改P-FASTAPI |

这里验证了同一Chat并不等于一个无限上下文；Project切换由ContextPackage边界完成。

#### 第二天：“继续学习”

初始事实：

```yaml
current_session_focus: P-BOOKMARK
active_learning_projects: [P-FASTAPI]
due_actions: [复习依赖注入生命周期]
last_learning_digest: 生命周期概念薄弱，待主动回忆
```

| 步骤 | 本步处理 | 状态差异 | 用户可见 |
|---:|---|---|---|
| B13 | Intent=`continue_learning`；查询得到唯一活动学习Project和到期Action | 无写入 | 显示“准备继续FastAPI学习：复习生命周期” |
| B14 | Context采用学习目标、薄弱点、上次Evidence、到期Action | 新ContextPackage | 用户可取消上次薄弱点或改学其他内容 |
| B15 | 按learning协议先提取练习，再给新材料 | 新Run和练习Evidence候选 | 不重复塞入第一天全部对话 |
| B16 | 评估通过后建议下一复习时间 | Evidence与Schedule/Action候选 | 用户接受后才提交 |

如果同时存在两个活动学习Project，“继续学习”不能自动绑定；必须显示选择器和自由输入。

#### 第三天：“我还想做一个背单词CLI”

| 步骤 | 本步处理 | 状态差异 | 不变量 |
|---:|---|---|---|
| B17 | 识别新软件Project，不把“背单词”误关联到FastAPI学习 | Project Candidate | 名称相似或主题相关不等于同一目标 |
| B18 | 用户确认最小目标和仓库位置 | P-VOCAB创建；W-MVP与Plan创建 | 新Project创建是显式产品命令 |
| B19 | pi执行首个MVP步骤 | Artifact/Evidence | P-FASTAPI的Action仍保留，不被覆盖 |

#### 第四天：“回到FastAPI，先复习我们上次没掌握的”

| 步骤 | 本步处理 | 读取 | 结果 |
|---:|---|---|---|
| B20 | 精确名称匹配P-FASTAPI | Project目录 | 无需模型猜Project |
| B21 | 查询未掌握Evidence、开放Work、到期Action和最近Digest | 不读取P-BOOKMARK/P-VOCAB详情 | Context显示“生命周期”薄弱点及来源 |
| B22 | 用户确认后开始提取练习 | 步骤级工作包 | 学习在跨Project、跨Session后继续 |
| B23 | 本轮终态更新Evidence/Action/Digest | 原子Product提交+派生摘要 | 项目、学习和任务持续一致 |

完整不变量：

1. 每个Project拥有自己的Work/Plan/Note关系。
2. Product Session切换不改变Project归属。
3. 每轮原始Message都保留，但模型上下文不会随天数线性增长。
4. Digest失败不影响已提交Project/Work；次日仍能从权威对象恢复。
5. 学习掌握、软件完成和用户接受是不同事实。

当前实现证据：

- 已有3天、7轮、5个Product Session的混合焦点长场景，验证3个Project工作集隔离和14条原始Message不被无脑拼接。
- 上述协议选择、学习Schedule和步骤级投影仍是候选增强，不能因当前长测通过就宣称已经实现。

### 24.3 推演C：同名项目、用户主动选Context和可回答HITL

#### 初始状态

```yaml
projects:
  - P-SNAKE-WEB: {name: 贪吃蛇, repository: web-snake, status: active}
  - P-SNAKE-PY: {name: 贪吃蛇, repository: python-snake, status: active}
message: "继续贪吃蛇，加暂停"
```

| 步骤 | 本步处理 | 用户交互 | 状态 |
|---:|---|---|---|
| C1 | 阶段A返回两个同名候选，置信差不足 | 工作台显示两张可选卡：Web版、Python版；同时保留自由输入 | Clarification Request持久化 |
| C2 | 用户选择Web版，并主动勾选“暂停交互设计”Note，排除旧Python实现Note | 选择器允许搜索、预览、锁定和排除 | Context Adoption Candidate |
| C3 | Chat重新编译ContextPackage | 展示采用5项、排除3项和每项理由 | 新context_hash；旧下游Draft失效 |
| C4 | 软件协议生成短Plan和ExecutionDraft | 用户可直接改“只加按钮，不加键盘快捷键” | Draft revision 2 |
| C5 | 用户接受 | 显示影响范围、Tool、验证和停止条件 | RunSpec绑定P-SNAKE-WEB和Context revision |

不变量：

1. 澄清问题必须能通过普通输入、选项或Context面板回答，不能只给“接受/拒绝”。
2. 用户明确选择高于模型相关度排序，但不能越过权限和来源有效性。
3. 修改Context会生成新revision和Hash，旧Approval不能继续使用。
4. Python版资料保持排除，即使文本相关度更高也不能偷偷进入执行步骤。

### 24.4 推演D：pi执行、用户看护、测试失败与进程恢复

#### 已接受RunSpec

```yaml
goal: 为Web贪吃蛇增加暂停按钮
scope: [game-state, controls, tests]
non_goals: [render-engine-refactor, new-dependencies]
capabilities: [read-project, edit-scoped-files, run-approved-tests]
done_when:
  - 暂停期间状态不推进
  - 恢复后继续
  - 既有和新增测试通过
stop_when:
  - 需要新依赖
  - 修改范围外文件
  - Tool结果未知
```

#### 正常与修复路径

| 步骤 | 执行与公开内容 | 持久状态 | 用户能做什么 |
|---:|---|---|---|
| D1 | Worker领取Attempt，恢复MAF Checkpoint | Job lease/epoch | 查看Worker、Attempt和Cursor |
| D2 | Planner步骤投影读取RunSpec，不读取其他Project | StepInput hash | 查看本步Goal/Scope/Done when |
| D3 | pi读取AGENTS、入口和测试文件 | Tool read Attempts | 查看文件路径、耗时和输出摘要 |
| D4 | pi提出修改3个文件 | Tool Draft | 批准、改参数、拒绝或收紧范围 |
| D5 | Edit Tool执行并返回文件Hash/Diff | Tool Execution、Artifact Candidate | 查看Diff；尚不显示Work完成 |
| D6 | 测试退出码1，暂停功能恢复后速度异常 | Validation Evidence=`failed` | 查看命令、退出码和失败摘要 |
| D7 | 确定性路由进入修复预算1/2 | 新StepInput只含失败、相关Diff和原约束 | 用户可Steer“不要改计时器API” |
| D8 | pi修复并重跑，测试通过 | Evidence Candidate=`passed` | 查看两次Attempt和变化 |
| D9 | Reviewer只检查交互语义，不覆盖测试 | Review Candidate | 查看公开问题，无隐藏推理 |
| D10 | 形成Artifact/Evidence/Work Patch | 仍是候选 | 接受、部分接受、要求修复 |
| D11 | 用户接受 | Work revision提交、Trace/Outbox同事务 | 最终回复链接Artifact和证据 |

#### 故障注入1：写Tool之前Worker退出

1. Attempt Lease过期。
2. Reconciler检查本步骤尚无外发Attempt。
3. 新Worker以新epoch接管，从Checkpoint恢复。
4. 旧Worker即使恢复也因epoch fence不能写事件或终态。
5. Tool只实际执行一次。

该路径可由当前Runtime Job/Lease/Checkpoint纵向能力承载。

#### 故障注入2：文件已写入，但回执前Worker退出

1. Tool Ledger记录`sent`，没有可信result。
2. Run进入`outcome_unknown`或等待对账，不能自动再次edit。
3. 对账器读取目标文件Hash并与请求前Hash、计划Patch比较。
4. 能证明写入完成时，人工或工具专属规则确认结果；无法证明时请求用户决定恢复、补偿或重新执行。
5. Work保持未完成。

该路径必须等待通用Tool Operation Ledger和副作用对账完成；当前Checkpoint不能为它背书。

#### 故障注入3：用户在D5后说“再加快捷键”

1. Steer作为新的User Interaction保存。
2. 判断该变化超出已接受scope。
3. 当前Run安全暂停，不让pi自行扩大范围。
4. 生成ExecutionDraft Amendment，重新计算Context、Plan、Capability和Hash。
5. 用户接受后创建新的授权和后续步骤；旧Artifact保留血缘。

### 24.5 推演E：多Intent、来源失效和并发提交

用户输入：

> 总结我上周FastAPI学到的重点；另外给书签API加导出功能。

#### 分支建立

| 步骤 | 学习查询分支 | 软件执行分支 | 聚合规则 |
|---:|---|---|---|
| E1 | Intent L=`summarize_learning` | Intent S=`continue_project_feature` | 同一Interaction下两个Intent ID |
| E2 | Context L只读P-FASTAPI、Note、Evidence | Context S只读P-BOOKMARK、仓库和Work | 两个context_hash，不共享正文 |
| E3 | 确定性汇总+必要语义摘要 | Plan/Draft/HITL/pi执行 | 查询分支可以先交付 |
| E4 | Assistant结果L | Artifact/Evidence/Work Patch S | 聚合器支持partial success |

异常1：FastAPI一条关键Note的来源文件已删除。

1. Context Compiler检测Source invalid。
2. 该Note仍可作为“历史记录”显示，但不能以“当前有效事实”参与结论。
3. 学习摘要标注缺失来源和置信下降。
4. 由该Note派生的Memory进入复核候选。
5. 软件分支不受影响。

异常2：另一个Session同时把书签API Plan revision 5更新为6。

1. 当前软件分支提交时携带`expected_revision=5`。
2. Product Store拒绝CAS，不覆盖revision 6。
3. Artifact和Evidence保留，不自动丢弃。
4. Workflow读取revision 6，对比目标、步骤和冲突。
5. 无冲突时提出rebase后的Patch；有冲突时请求用户选择。
6. 学习查询分支的成功结果保持已交付。

不变量：

1. 多Intent允许部分成功，不用一个失败回滚所有已交付查询结果。
2. Product事实提交按各聚合和revision进行，不做跨Project巨型事务。
3. 来源失效沿Provenance传播，不删除原始历史。
4. 并发冲突保留执行产物，但不把旧Plan状态强行写回。

## 25. 桌面推演后的方案修正

逐状态推演使原方案增加5个明确约束：

1. Context面板必须同时支持用户预先选择和系统召回后修正，两者都写Adoption和revision。
2. TurnDigest中的状态变化必须从已提交Product命令投影，不能让摘要模型猜“项目已完成”。
3. 查询类Intent优先走确定性Product Query；协议选择和Agent只在确实需要时介入。
4. 多Intent必须拥有独立Context和提交结果，聚合层只处理呈现、依赖和部分成功。
5. 学习复习和周期工作必须落到Schedule/Action；不能把“以后提醒我”留在摘要或Agent Session。

因此，前面9项待审核决定仍成立，但实现顺序应调整为：

```text
协议与Binding合同
-> TurnDigest权威边界
-> Context召回/Adoption/FTS评测
-> StepInputProjection
-> 多Intent聚合
-> Schedule
-> Validation/Repair
-> 前端Context与运行看护
```

该顺序先固定事实、来源和选择权，再扩大自动执行。
