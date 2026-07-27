# 类 LifeOS 产品方法与 Chat Harness 启发研究

> 状态：**产品方法候选研究，已归档，未形成新增架构或 Schema 授权**
>
> 更新时间：2026-07-27
>
> 研究对象：Obsidian LifeOS 生态、Notion Life OS 模板体系，以及 Tana、Capacities、NotePlan、
> Amplenote、Sunsama、Amazing Marvin、Lunatask、Routine、RemNote、Readwise、Anytype、Logseq、
> Daniel Miessler LifeOS 等相邻产品或项目。
>
> 项目关系：本文补充[Chat持续协作系统研究](./chat-collaboration-system-research.md)中的产品方法景观；
> Chat 当前已经批准的协议、Context 和步骤输入合同仍由
> [Harness协议详细设计](./chat-harness-protocol-context-detailed-design.md)拥有。

## 1. 执行摘要

本研究把“类 LifeOS”定义为：**把人的学习、工作、生活和娱乐持续转成可捕获、可组织、可推进、
可回顾、可恢复的一套个人运行方法，并通过文档、数据库、日历、任务、查询或 Agent 呈现和执行的系统**。
它不是某一个品牌，也不等于“做一个人生仪表盘”。

得到 10 个核心结论：

1. 成熟 LifeOS 的本体不是页面，而是`捕获 → 澄清/归类 → 关联 → 推进 → 验证/反思 → 回写 → 复盘/归档`
   的生命周期协议。
2. 它们普遍把**低摩擦捕获**放在第一位：Daily Note、Journal、Inbox 或 Quick Capture 允许用户先记，
   再由人或系统延迟归类。
3. 它们普遍依赖**一份事实、多种投影**：同一条任务、笔记或对象可以出现在日历、项目页、今日页、
   查询表和回顾页，而不是复制多份。
4. 它们常同时提供两条导航轴：时间轴回答“现在和什么时候”，主题轴回答“关于什么、为什么”。
5. 它们真正的维护成本不在初次搭建，而在归类、关系修复、陈旧任务处置、周期回顾、模板升级和迁移。
6. 大多数现有系统仍然由**人充当运行时**：人记住规则、选择标签、推进状态、回顾、归档；软件主要负责
   查询、聚合和显示。
7. LifeOS Skill、Aino 和 Daniel Miessler LifeOS 代表的新变化，是把方法写成 Agent 能读、能执行、
   能迁移的配置、Skill 或 Harness；但它们仍未完整覆盖 Chat 所需的批准、并发、Evidence、失败恢复和Trace。
8. 对 Chat 最有价值的不是复刻某个 Dashboard，而是把这些人工方法吸收为**可版本化、可解释、可跳过、
   可迁移、可评测的协作协议**，再由 Chat 帮用户持续维护。
9. 学习、工作、生活、娱乐不应拆成 4 套事实库；更合理的是共享 Project、Work、Plan、Action、Note、
   Memory、Evidence 等核心对象，再绑定不同领域协议和视图。
10. Markdown、目录和文档非常适合成为可读、可导出、可编辑的投影；在 Chat 的多会话、并发和自动执行环境中，
    它们不能取代 Product Store 对版本、授权、状态、Evidence 和 Trace 的权威性。

一句话概括：**传统 LifeOS 把协议交给人记忆、把状态交给文件或数据库、把呈现交给查询；Chat 可以保留
这套优秀方法，但让系统承担协议执行、上下文召回、陈旧状态发现、迁移和证据维护，让人保留目标、主观选择
与高影响授权。**

## 2. 研究边界与证据等级

### 2.1 本文要回答的问题

1. 各产品用哪些核心对象承载学习、工作、生活和娱乐？
2. 用户每天、每周、每个项目具体怎样使用它，而不是只看功能列表？
3. 为什么采用 Daily Note、数据库、对象类型、标签、日历或漏斗等设计？
4. 状态如何维护，模板或方法升级后怎样迁移，哪里容易腐化？
5. 用户看到的是聊天、页面、表格、看板、日历、时间线、回顾向导还是游戏化数值？
6. 哪些原则可以直接采用，哪些要按 Chat 的权威状态、治理和运行边界改造，哪些不应采用？

### 2.2 证据等级

| 等级 | 含义 | 本文用法 |
|---|---|---|
| 官方事实 | 官方文档、产品帮助中心、作者官网或官方仓库明确说明 | 描述对象、工作流、呈现和公开维护机制 |
| 产品推断 | 由多个官方事实组合出的设计原因或代价 | 明确标为“推断”或“启发” |
| Chat项目事实 | 当前仓库已经批准或实现的合同 | 用于判断能否直接接合 |
| 候选设计 | 由研究推导、尚未获得用户审核的新增能力 | 明确标为“候选”，不得据此创建Schema或代码 |

本文没有把论坛单条抱怨或营销页面口号当普遍用户事实，也没有进行这些项目的源码级审计。除当前治理规则
已经固定的 LibreChat 外，本文项目**不进入 Chat 的正式外部架构参考集**；它们只是本次经用户授权形成的
产品方法景观。若未来要把某个项目提升为源码级正式参考，仍需单独限定问题、版本和研究成本并由用户审核。

## 3. “类 LifeOS”到底是什么

名称相同并不代表同一种系统：

1. **Obsidian LifeOS**：围绕 Markdown Vault、Periodic Notes、Theme Notes、PARA/IPO/GTD/OPC 等方法构建
   的插件与模板生态，是本次用户所指对象的最高概率匹配。
2. **Notion Life OS**：通常不是一个官方插件，而是由关联数据库、视图、模板、公式和教程组成的模板产品，
   代表 Ultimate Brain、Pillars-Pipelines-Vaults 等体系。
3. **Life OS Assistant**：一个较新的 Obsidian 社区插件，加入任务、项目卡、记忆确认和 AI 选择上下文；
   当前更适合作为观察项，不能与成熟 LifeOS 生态混同。
4. **Daniel Miessler LifeOS**：面向 AI 的个人 Harness 项目，重点是 Context、Skill、Memory、路由和自我改进，
   不是 Obsidian 个人知识管理插件。
5. **本文简称 LifeOS**：泛指具有“个人运行协议 + 可持续事实 + 多视图 + 复盘维护”的产品方法，不绑定品牌。

因此，判断一个系统是否值得参考，不看它是否叫 LifeOS，而看它是否真正回答 5 个问题：

- 新信息进入哪里？
- 它如何获得类型、归属和下一行动？
- 用户如何知道今天该做什么？
- 做过以后如何形成结果、记忆或下一轮安排？
- 系统怎样发现并修复陈旧、冲突和失效状态？

## 4. 跨产品的共同运行模型

### 4.1 六层结构

成熟系统通常可以拆成 6 层：

| 层 | 负责的问题 | 常见实现 |
|---|---|---|
| 1. 方法与生命周期 | 一件事从进入到结束要经历什么 | PARA、GTD、IPO、漏斗、日/周计划、间隔复习 |
| 2. 核心对象与身份 | 哪些东西是同一个事实 | Project、Task、Note、Goal、Person、Book、Highlight、Habit |
| 3. 捕获与分流 | 用户怎样不费力地先把东西留下 | Daily Note、Journal、Inbox、Quick Capture、Jot |
| 4. 关系与投影 | 同一事实如何从不同角度被看到 | 链接、Relation、Rollup、Query、Calendar、Kanban、Dashboard |
| 5. 复盘与维护 | 怎样处理陈旧、遗漏、迁移和完成 | Daily shutdown、Weekly review、Archive、Reschedule、Template migration |
| 6. 自动化与Agent | 哪些动作由系统代替人做 | 查询、聚合、周期生成、AI归类、Agent操作、迁移检查 |

只有页面而没有第 1、5 层，通常会退化为“模板博物馆”；只有自动化而没有第 2、5 层，会积累无法解释的
状态；只有知识图谱而没有推进协议，则更像资料库而不是 LifeOS。

### 4.2 共同闭环

```text
随手输入
  → 澄清：这是什么，是否值得保留
  → 类型化：任务、笔记、项目、目标、人物、资料或体验
  → 关联：属于哪个主题、项目、时间和来源
  → 推进：下一行动、排期、练习、执行或等待
  → 验证/反思：完成了吗，证据是什么，学到了什么
  → 回写：更新状态、结果、记忆、偏好和后续安排
  → 复盘/归档：清理陈旧项，调整方法，形成下一周期
```

LifeOS 产品之间最大的差别，不是有没有任务或笔记，而是把这条闭环的哪个步骤做成了产品主界面、哪个步骤
留给用户记忆、哪个步骤交给自动化。

## 5. 产品景观总览

| 家族/产品 | 主要入口 | 核心组织机制 | 关键推进机制 | 主要呈现 | 主要维护负担 | 对Chat的独特价值 |
|---|---|---|---|---|---|---|
| Obsidian LifeOS | Daily/Periodic Note | 时间轴 + Theme/Project + PARA等 | 标签、任务、项目生命周期、周期回顾 | Markdown、项目索引、查询、看板、日历 | 标签纪律、回顾、归档、插件/模板迁移 | “一次写入、多轴召回”与方法可配置 |
| LifeOS Skill | Agent命令 | 读取真实Vault配置与模板 | 捕获、查询、项目创建、复盘、迁移预览 | 对话 + 文件变更 | 人确认价值判断和迁移 | 最接近“协议由Chat执行”的现实样本 |
| Aino LifeOS | Vault + AI聊天 | Periodic/Theme Note、Markdown | Agent、任务、日历、MCP | 左侧Vault、中间文档、右侧AI | 本地文件和Agent能力治理 | 本地可读资产与AI工作台结合 |
| Notion Ultimate Brain/PPV | Home/Quick Capture | 关联数据库、Relation/Rollup、模板 | My Day/Week、项目/目标视图 | 页面、表、Board、Calendar、Gallery | Relation、状态、模板升级和实例迁移 | 稳定对象 + 多投影的强样本 |
| Tana | Daily Page | Supertag、Field、Live Search | 随处捕获后类型化 | Outline、Table、Dashboard | 模板变更不自动追溯既有实例 | 对象类型和活查询，但暴露版本迁移难题 |
| Capacities | Daily Note | Typed Object、Property、Query、Collection | 捕获后转对象 | Daily Note、对象页、查询面板 | 类型/属性演进、人工精选 | “先捕获、后结构化”设计 |
| NotePlan | Calendar Note | 日/周/月/季/年 + Project Note | 手动完成、取消、重排；周回顾 | Calendar、Note、Backlink | 不允许无意识滚动，必须处置 | 维护触发器比自动搬运更重要 |
| Amplenote | Jot | Jot→Note→Task→Calendar | Idea Execution Funnel | 四个模式 | 阶段转换和任务排期 | 把Idea、知识、行动、时间明确分开 |
| Sunsama | Daily planning向导 | 当日任务 + Calendar | 昨日回顾、工作量预测、Shutdown、Weekly Review | 引导式流程、日历 | 每日/每周仪式 | 方法应在正确时机引导，而不只藏在Dashboard |
| Amazing Marvin | Day View | Task/Project/Category + Strategies | 可组合工作策略 | Day View、Master List、自定义策略 | 配置选择过载 | 协议可模块化，但组合必须受约束 |
| Lunatask | Task/Journal | Tasks、Habits、Journal、Mood、Relationships | 多种优先级/WIP方法 | 任务中心、日历、习惯、日记、关系 | 多领域一致性 | 证明整合生活领域有价值，也暴露多孤岛风险 |
| Routine | Journal/Agenda | Entry、Task、Event同一时间面 | 日程中捕获并转行动 | Agenda、Calendar、Journal | 轻量日常整理 | 对话/日记和行动不必成为两个系统 |
| RemNote | Note/Queue | Note与Flashcard同源 | Active Recall、Spaced Repetition、用户评分 | 笔记、卡片、到期队列 | 内容质量、评分、队列处置 | 学习必须有练习证据和调度 |
| Readwise | Highlight Review | Highlight、Source、Annotation | Daily Review、Resurface | 阅读库、每日回顾 | 来源同步、标注整理 | 让知识重新出现，而不是只收藏 |
| Anytype/Logseq | Object/Journal | 本地对象图或Block/Property/Query | 查询、任务、模板、Flashcard | Journal、Graph、Query、对象页 | 类型/属性/查询治理 | 本地优先、可读资产与查询投影 |
| Daniel LifeOS | AI入口 | Context、Memory、Skill、Routing、USER覆盖 | Current→Ideal Algorithm、自我改进 | 对话、配置、Git变更 | 系统升级与用户定制合并 | Harness打包、升级、回滚和个性化边界 |

## 6. 深入解析：它们如何具体落地

### 6.1 Obsidian LifeOS：时间轴和主题轴交叉

#### 官方事实

[LifeOS核心概念](https://lifeos.md/guide/beginner-guide/core-concept)和
[使用总览](https://lifeos.md/guide/overview/usage)把 Periodic Notes 作为时间轴，把 Theme Notes、Project 或
PARA 分类作为主题轴。短任务和零散想法可以先进入每日笔记，通过标签或主题标记被聚合；中长内容再形成独立文件。
项目具备预期结果和期限，相关每日记录可被项目索引查询，项目完成后进入归档。官方现在还提供从 Memos、IPO、
GTD、PARA 到 OPC 的不同工作流，并在[自定义工作流](https://lifeos.md/guide/best-practice/custom-workflow)中强调
按瓶颈选择方法，而不是选择功能最多的方法。

#### 为什么这样设计——产品推断

1. Daily Note 把“我应该放在哪个文件夹”的决策推迟，降低输入成本。
2. 时间轴天然适合回答“昨天发生了什么、这周要做什么”，主题轴适合回答“这个项目目前怎样”。
3. 标签适合短暂引用，文件适合需要持续演进的内容，减少所有信息都被迫升级为重文档。
4. 项目索引通过查询聚合分散记录，让用户不必在每日记录和项目文档之间重复复制。

#### 呈现方式

- 每日、每周、每月、季度、年度笔记形成时间导航。
- Theme/Project README 或索引页形成主题导航。
- Dataview、任务查询、Calendar、Kanban 或 Timeline 把同一 Markdown 事实投影成不同视图。
- 积分、等级、图表等游戏化呈现可以叠加，但它们是结果投影，不是 LifeOS 协议本身。

#### 维护与真实成本

[更新日志](https://lifeos.md/news/lifeos-pro-changelog)反映了模板演进中的真实问题：任务状态可能陈旧，
周期任务可能重复，Calendar同步可能产生冲突，周编号和本地化可能不一致，大型Vault需要索引和启动优化，
旧模板与新模板之间需要迁移。这说明“文件可读”不等于“系统免维护”。

#### 对Chat的启发

- **采用**：低摩擦连续输入、时间/主题双轴、单一事实多视图、按用户瓶颈选择协议。
- **改造**：标签和查询不能承担版本、审批、权限、Evidence或并发；Chat需要稳定ID、类型关系、revision和CAS。
- **不采用**：要求每个用户先理解并长期记住整套目录、标签和插件规则。

### 6.2 LifeOS Skill：从“人记协议”到“Agent执行协议”

#### 官方事实

[LifeOS Skill](https://lifeos.md/guide/ai-integration/lifeos-skill)会先读取实际插件配置，包括文件夹、Daily Note
路径、模板和标题段落，再执行捕获、任务查询/完成、按模板创建项目、全文检索和周/月回顾。迁移工作流时，它会先
盘点现有结构、让用户选择方法、预览目标结构和分类结果，再在确认后写入；迁移批次包含目标位置、原因和置信度，
并检查链接、路径和冲突。

#### 为什么重要

这是对用户原始判断最直接的验证：传统 LifeOS 的“协议”原本存在作者教程和用户记忆里；Skill把一部分协议
转成了 Agent 可读的配置和操作。它同时保留一个关键边界：Agent执行机械操作，用户决定价值、语气、分类和迁移。

#### 对Chat的启发

Chat 不应只让模型“看见一堆文件”，而应有一份明确的可执行合同：

1. 当前用户使用哪个方法与精确revision。
2. 捕获内容如何转成候选对象。
3. 哪些动作可以自动做，哪些需要确认。
4. 写入前要检查哪些版本、来源、权限和冲突。
5. 升级方法时怎样预览、分批迁移、验证和回滚。

### 6.3 Aino LifeOS：AI原生桌面工作台

[Aino介绍](https://aino.md/guide/intro/what-is-aino)把 Periodic Notes、Theme Notes、本地 Markdown、AI Chat、
Agent、MCP、任务、Calendar 和浏览能力组合成桌面产品，并保持与 Obsidian Vault 兼容。其典型呈现是左侧资料库、
中间文档、右侧AI对话/工作台。

它证明了“可读文件资产 + 对话式执行 + 结构化视图”可以共存。但对Chat而言，兼容文件只是产品价值的一部分；
如果Agent会产生副作用，就仍需独立的授权、Evidence、失败语义和恢复机制，不能只依赖Vault是否写成功。

### 6.4 Notion Life OS：关系数据库和多视图

#### 官方事实

[Notion数据库模板](https://www.notion.com/help/database-templates)支持为数据库创建模板及日/周/月/年重复实例；
[Relation与Rollup](https://www.notion.com/help/relations-and-rollups)让 Tasks、Projects、Goals、Notes、Areas 等
数据库建立关系并聚合状态。[Ultimate Brain](https://thomasjfrank.com/brain/)把这些对象投影为 Home、Quick Capture、
My Day、My Week、My Year、GTD、Archive，以及 People、Books、Recipes 等领域页面。
[August Bradley PPV](https://www.notionlifedesign.com/)则以 Pillars、Pipelines、Vaults 区分稳定责任、推进流程和知识资产。

#### 为什么这样设计——产品推断

Notion路线的核心不是文件夹，而是先建立少量“规范化对象”，再为同一数据库创建多种筛选视图。这样项目页、
今日页和目标页看到的是同一条Task，不必复制状态。Pillars/Pipelines/Vaults进一步解决了“长期责任、当前推进、
参考知识不应混在一起”的问题。

#### 呈现方式

- Home/Command Center 作为导航和当前焦点页。
- Table、Board、Calendar、Timeline、Gallery 作为同一数据库的不同投影。
- My Day/Week/Year 让时间尺度逐层展开。
- 领域库如 Books/Recipes 负责生活与娱乐，但往往偏收藏和追踪，推进协议较弱。

#### 维护与真实成本

模板可以生成新实例，但已经生成的页面和大量关联数据不会自然获得一套完整、可审计的协议迁移。用户仍要维护
Inbox、Relation、Status、过期任务和视图过滤条件。模板作者最清楚体系，普通用户容易“会用页面，不理解协议”。

#### 对Chat的启发

- **采用**：稳定核心对象、一份事实多投影、关系与汇总。
- **改造**：把教程、视图名和公式里的隐式规则升级成显式、可版本化协议。
- **不采用**：为每个生活领域复制数据库，或把一个巨型Dashboard当作系统完成标准。

### 6.5 Tana、Capacities、Anytype与Logseq：捕获后类型化

#### Tana

[Tana Supertag](https://outliner.tana.inc/learn/features/supertags)把任意节点升级为带字段和模板的类型化对象，
Live Search 可以从各处召回同一对象。Daily Page 因此既是随手输入区，也能逐步生成项目、任务、人物或资料。
但[Tana故障排查](https://outliner.tana.inc/help/troubleshooting)也说明：已生成或编辑过的模板节点可能与模板脱离，
后续模板变更不会自动传播，新增字段也不一定追溯既有实例。

#### Capacities

[Capacities Daily Notes](https://docs.capacities.io/reference/use-cases/daily-notes)明确允许用户先写，再把其中内容
转换为 Person、Task、Project、Tag 或长笔记；[Content Types](https://docs.capacities.io/reference/content-types)
提供类型和属性，[Queries](https://docs.capacities.io/reference/queries)负责动态过滤，Collection负责人工精选。

#### Anytype与Logseq

[Anytype文档](https://doc.anytype.io/anytype-docs)展示了本地优先的 Object、Type、Template、Query、Collection；
[Logseq文档](https://docs.logseq.com/)展示 Journal、Block、Property、Query、Task 和 Flashcard 的组合。二者共同说明，
本地资产和结构化查询并不冲突。

#### 对Chat的启发

1. 用户输入时不应被迫先选择完美目录或类型；Chat可以先生成有来源的候选，再在需要时确认。
2. 动态Query适合做投影，人工Collection适合表达主观精选，两者不能混为一类关系。
3. 模板变更不自动传播说明协议必须拥有revision、兼容规则、迁移计划和历史绑定。
4. “模型认为它是项目”仍只是候选，不能因为打了类型就自动成为Product事实。

### 6.6 NotePlan、Amplenote、Sunsama、Amazing Marvin与Routine：推进和复盘

#### NotePlan

[NotePlan Daily Notes](https://help.noteplan.co/article/43-part-1-daily-notes)和
[Weekly Planning](https://help.noteplan.co/article/160-weekly-planning)以日/周/月/季/年Calendar Note连接Project Note。
它刻意不让未完成任务无声自动滚动：用户需要完成、取消、重排或明确留下。周笔记像一个维护“绊线”，迫使用户
重新看见陈旧承诺。

#### Amplenote

[Idea Execution Funnel](https://www.amplenote.com/help/idea_execution_funnel_explained)把 Jots、Notes、Tasks、
Calendar 设计成从想法到执行的四阶段漏斗。它避免把“我想到过”“我已经理解”“我准备行动”“我安排了时间”
错误地当成同一个状态。

#### Sunsama

[Daily Planning](https://help.sunsama.com/docs/usage-guides/daily-planning/)通过向导让用户回顾昨天、挑选今天任务、
查看预估负荷并确认计划；Shutdown与Weekly Review把复盘放到正确时机。方法不是一份要背诵的说明，而是系统
在关键节点发起的短交互。

#### Amazing Marvin

[Strategies](https://help.amazingmarvin.com/en/collections/1139197-strategies)允许用户给Day View组合不同执行方法，
例如[1-3-5策略](https://help.amazingmarvin.com/en/articles/4561574-1-3-5)。它最接近“可组合协议模块”，同时也说明
策略数量越多，选择、冲突和配置负担越高。

#### Routine

[Routine Journal](https://help.routine.co/en/articles/2612820/journal)把Journal Entry、Task和Event放在同一Agenda/Calendar
时间面中，用户可从记录直接形成行动，不必维护分离的日记系统和任务系统。

#### 对Chat的启发

- 不要默默把所有未完成Action搬到明天；要提示用户完成、取消、重排、等待或重新定义。
- Idea、Note、Work、Action、Schedule和Evidence必须有清晰边界。
- 协议应在捕获、计划、完成、复盘等关键时机提供短引导，而不是要求用户每天主动打开复杂Dashboard。
- 可组合协议需要冲突解析、优先级和数量上限，不能让用户安装无限策略后交给模型临场猜。

### 6.7 Lunatask：跨生活领域的一体化

[Lunatask](https://lunatask.app/)把任务、习惯、日记、情绪、关系、笔记和日历放在同一个本地加密产品中，
并允许 Must/Should/Want、Eisenhower、WIP 等不同任务方法。它说明用户确实希望在一个入口里同时处理工作、
生活和自我状态。

但它也暴露一个风险：如果每个领域各自拥有互不相通的状态、统计和维护规则，“一体化”只是把多个小应用放在
一个Shell里。Chat更适合共享Principal、时间、Project/Work、Note、Evidence和Context，再针对习惯、关系、学习、
娱乐提供协议和视图扩展。

### 6.8 RemNote与Readwise：学习不是“读完”

[RemNote间隔重复](https://help.remnote.com/en/articles/6022755-getting-started-with-spaced-repetition)把笔记和Flashcard
保持同源，用户通过主动回忆并给出难度反馈，调度器决定下次出现时间。
[Readwise](https://docs.readwise.io/readwise)把阅读高亮、来源和Annotation汇集到Daily Review中，让旧知识按节奏重新出现。

这两个产品共同说明：学习闭环至少需要目标/诊断、材料、练习、用户作答、评分或Evidence、下一次Schedule和复盘。
“模型总结了一遍”或“用户打开过资料”不能成为学会的证据。

Chat 当前已批准的 learning-loop 协议和 Evidence 边界与此一致；候选增强不是另建Learning数据库，而是增加
到期复习视图、练习结果投影和基于Evidence的难度/节奏建议。

### 6.9 娱乐：从收藏清单变成体验协议

Notion模板、Tana、Capacities等系统常提供 Book、Movie、Trip、Recipe 等类型，但多数停留在收藏、评分和Gallery。
如果Chat只是增加电影/游戏/书单数据库，并不能证明“娱乐管理”已经落地。

更有意义的候选闭环是：

```text
捕获兴趣
  → 判断当下想获得什么体验
  → 选择并安排
  → 实际体验
  → 简短反思或与人分享
  → 形成可修正的偏好/推荐候选
  → 归档或延伸为新的学习、创作、社交行动
```

这里的主观感受和偏好必须由用户拥有；Chat可以帮助召回上下文、避免重复选择、安排时间和形成候选总结，
但不能把观看时长、评分或模型推断自动升级为长期Memory。

### 6.10 Daniel Miessler LifeOS：AI Harness与升级边界

[Daniel Miessler LifeOS官方仓库](https://github.com/danielmiessler/LifeOS)把系统描述为从Current State走向Ideal State
的Algorithm，并组合Context、Persistent Memory、Skills、Routing和Self-improvement。它还把用户定制与系统本体
分离，使用Git支持升级合并和回滚。

这与Obsidian LifeOS不同，却更接近Chat希望达到的“协议由系统维护”：

- 系统层拥有可升级方法和能力。
- 用户层拥有偏好、目标和覆盖项。
- Agent根据Context和Skill执行。
- Git或版本历史提供变更追踪和回退。

它对Chat最强的启发是**协议打包与升级模型**，而不是复制其对象或运行架构。Chat仍必须保留自己的Product Store、
MAF/AG-UI运行边界、HITL、Evidence、Trace、并发和恢复合同。

## 7. 为什么这些设计反复出现

| 设计 | 解决的用户问题 | 代价或失效方式 | Chat应怎样处理 |
|---|---|---|---|
| Daily Note/Journal/Inbox | 输入时不想先设计分类 | Inbox长期不清理 | 允许无结构输入；由协议触发候选归类和定期清理 |
| 时间轴 | 人按“今天/本周/上次”回忆 | 主题信息散落 | 与Project/Topic轴并存，不以日期替代归属 |
| 主题/对象轴 | 聚合一个项目或主题的长期材料 | 标签歧义、关系断裂 | 使用稳定ID和类型关系，标签只作辅助投影 |
| 一份事实多视图 | 避免状态复制 | 复杂过滤器让规则隐形 | Product Store一份权威事实，视图公开来源与筛选逻辑 |
| 模板 | 降低重复搭建成本 | 已生成实例难升级 | 模板/协议不可变revision + 迁移预览 |
| 周期回顾 | 修复陈旧状态和错误承诺 | 仪式过重会被放弃 | 按风险和积压触发短回顾，允许跳过但保留安全下限 |
| 自动聚合 | 减少手工复制 | 查询错误会制造假全局视图 | 显示数据新鲜度、来源、未知和失败 |
| AI归类/摘要 | 降低维护成本 | 把推断冒充事实 | 一律作为有来源候选，按策略或HITL提交 |
| 本地可读文件 | 信任、可迁移、可编辑 | 并发、权限、Schema和原子性弱 | 作为投影/导出/编辑入口，权威提交仍走产品事务 |
| 游戏化/统计 | 提升反馈和可见进展 | 数字替代真实价值 | 只用可解释指标，不把积分当完成或学习Evidence |

## 8. 维护机制：决定系统能否长期存活

### 8.1 传统产品把哪些工作留给用户

1. 清空Inbox或Daily Note中的未归类项。
2. 选择项目、主题、Area、Goal或Supertag。
3. 处置过期、阻塞或长期未动的任务。
4. 维护Relation、Rollup、Query、Template和目录路径。
5. 决定何时完成、取消、归档或重新定义项目。
6. 把经验转成可复用笔记、Memory、Flashcard或下次计划。
7. 在模板升级时迁移已有实例并修复链接。

这就是“人作为运行时”的具体含义：作者把协议设计好了，但每个用户仍需记得何时做这些动作。

### 8.2 Chat可以接管的维护工作

在不替用户做主观决定的前提下，Chat可以：

1. 从对话、文件、日历或Tool结果中生成带来源的分类/关联候选。
2. 识别无下一行动、长期未更新、等待超时、Evidence缺失和来源失效的Work。
3. 在适当时机启动短Review，而不是等待用户记得打开模板。
4. 根据绑定的精确协议revision生成StepInput、提醒和视图。
5. 预览协议升级影响，分批迁移并对冲突、低置信度项请求HITL。
6. 验证文件投影、链接、对象revision和Product Store是否一致。
7. 记录用户纠正、跳过、失败和完成证据，用于评估协议是否真的降低维护成本。

### 8.3 必须继续由用户拥有的判断

1. 目标是否值得追求。
2. 哪种生活/学习/娱乐体验更符合当下价值。
3. 含糊输入的最终归属。
4. 主观评价、偏好、语气和长期Memory是否接受。
5. 高影响动作、公开发布、外部消息、花费和不可逆变更。
6. 当协议与现实冲突时，是跳过一次、调整绑定还是升级方法。

## 9. 呈现方式：协议本体与界面投影必须分开

现有产品常用 8 类呈现：

| 呈现 | 最适合回答 | 典型产品 | Chat中的候选位置 |
|---|---|---|---|
| 连续流/日记 | 我刚想到什么、今天发生了什么 | Obsidian、Routine、Capacities | Chat对话流/每日连续记录 |
| 今日页 | 今天真正要继续什么 | Notion、Marvin、Sunsama | Personal Home“继续今天” |
| Calendar/时间线 | 什么时候发生、负荷是否冲突 | NotePlan、Sunsama、Routine | Conversation Day/Calendar |
| Project/Topic档案 | 这件事为何存在、现在怎样 | Obsidian、Notion | Project/Area/Topic Dossier |
| Board/Action Queue | 下一步、阻塞和责任 | Notion、Marvin | Work Board/Action Queue |
| 学习复习队列 | 现在应练什么、证据怎样 | RemNote、Readwise | Learning Review Queue |
| Library/Gallery | 有哪些书、电影、体验候选 | Notion、Tana、Capacities | Experience/Library Queue |
| Review向导/健康提示 | 哪些状态需要修复 | Sunsama、NotePlan | Protocol Review/Health |

对Chat最重要的约束是：这些界面都必须从同一权威事实投影。即使以后用积分、等级、进度环、RPG式角色面板、
表格、看板或文件树呈现，也不能让显示方式反向拥有Work状态、Memory、Approval或Evidence。

一个事实可以在多个地方被看见，例如同一Action同时出现在：

- 对话中的“下一步”；
- 今日页；
- Project档案；
- Calendar；
- Weekly Review。

这些是 5 个引用和投影，不是 5 条独立任务。

## 10. 与Chat现有基线的映射

### 10.1 已经批准或实现的基础

以下不是本研究新增的想法，而是Chat当前已有基线：

| LifeOS需要 | Chat当前基础 | 当前意义 |
|---|---|---|
| 稳定对象 | Project、Work、Plan/Action、Note、Memory、Evidence | 不为每种方法复制事实模型 |
| 方法版本 | CollaborationProtocolDefinition不可变revision | 一个方法可演进，历史仍可解释 |
| 方法选择 | Work→Project→User→System的ProtocolBinding优先级 | 不要求所有用户使用同一体系 |
| 上下文采用 | ContextPackage adoption/exclusion/lock/revision/CAS | 用户能看见和纠正采用内容 |
| 最小步骤输入 | StepInputProjection | Agent不必读取整个Vault或全部历史 |
| 人工判断 | HITL与绑定revision的Approval | 高影响或主观决策不自动提交 |
| 结果可信度 | Validation、Evidence、Result Commit | “模型说完成”不等于完成 |
| 可恢复性 | Product事实、Runtime状态、Checkpoint/Outbox分离 | 不靠当前页面或单段Prompt维持系统 |
| 多种工作方法 | 7套内置协作协议 | 简单问答、软件、项目、任务、学习、研究、周期简报可区分 |

因此，本研究并没有推翻现有方向，反而验证了“稳定核心对象 + 可版本化协作协议 + 多投影”的选择。

### 10.2 研究暴露的候选缺口

以下仍是**候选**，不是批准项：

1. **协议安装包**：把definition、binding默认值、视图、触发器、迁移和测试作为一个可管理单元。
2. **Review Cadence/Trigger**：不只定义阶段，还定义日/周/到期/积压/来源失效时怎样启动维护。
3. **未归类Inbox**：允许先捕获，并把分类候选、置信度和长期未处理项显式呈现。
4. **陈旧状态绊线**：对无下一行动、长期等待、Evidence缺失和静默滚动提供处置交互。
5. **协议升级与迁移**：预览影响、精确revision绑定、批次迁移、冲突HITL、验证和回滚。
6. **人类可读投影**：Daily Note、Project README、Review和协议说明文档可以导出/同步，但不是第二事实源。
7. **协议效果评测**：纠正率、跳过率、陈旧率、完成Evidence、维护耗时和用户主观负担，而不是只统计Token或打开次数。

## 11. 候选：Protocol Pack（协议包）

> 候选概念，待用户审核。它不是当前已冻结领域对象，也不等于MAF Workflow Definition。

一个可体验、可安装、可升级的 LifeOS 方法，不应只是一段Prompt或一组页面。候选`Protocol Pack`至少包含：

| 组成 | 内容 |
|---|---|
| Identity | 稳定key、名称、版本、作者、兼容范围、来源 |
| Definition | 阶段、进入/退出条件、可跳过项、停止条件 |
| Object Mapping | Project/Work/Plan/Action/Note/Memory/Evidence如何使用 |
| Capture/Triage | 默认捕获入口、候选类型、延迟归类规则 |
| Context Policy | 各阶段需要、排除、锁定和预算的Context |
| Automation Policy | 确定性Executor、Agent、Tool各自能做什么 |
| HITL Policy | 哪些判断必须由用户确认，批准绑定什么revision |
| Validation/Writeback | 完成证据、结果提交、Memory候选和失效传播 |
| Cadence/Trigger | 每日、每周、到期、积压、失败或来源失效触发器 |
| Projections | 对话卡片、今日页、Project页、Calendar、文件导出 |
| Lifecycle | 安装、启用、暂停、升级、迁移、回滚、卸载 |
| Verification | Schema兼容、迁移Dry Run、样例场景、健康检查和效果指标 |

### 11.1 Protocol与Workflow不能混同

- **协作协议**：描述一类工作长期怎样被理解、推进、复盘和维护，例如学习循环或周期简报。
- **MAF Workflow**：一次运行中实际执行的节点图、状态和Checkpoint。
- **Protocol Pack**：候选分发/安装单元，包含协议及其投影、触发、迁移和验证材料。

一个协议可以在不同运行中编译成不同步骤；一次Workflow运行也可以引用协议的精确revision。不能把“装了一个模板”
理解为“启动了一个永远运行的Workflow”。

### 11.2 升级原则

1. 旧Run、Approval和历史结果继续绑定旧revision，不被后台静默改写。
2. 新revision默认只影响新绑定或用户明确选择的未来Work。
3. 现有对象需要迁移时先产生影响报告和Dry Run。
4. 低风险确定性转换可分批执行；歧义、冲突或主观分类进入HITL。
5. 每批迁移保存来源revision、目标revision、对象集合、结果、Evidence和回滚信息。
6. 升级失败不能留下“模板已更新、事实迁了一半、界面看似成功”的状态。

## 12. 学习、工作、生活、娱乐怎样共用一套Harness

| 领域 | 共享核心对象 | 领域协议重点 | 主要Evidence | 主要投影 |
|---|---|---|---|---|
| 工作/项目 | Project、Work、Plan、Action、Note、Evidence | 目标、里程碑、下一行动、阻塞、交付、复盘 | Artifact、测试、交付回执、用户接受 | Project、Board、Calendar、Review |
| 学习 | Project/Goal、Work、Note、Action、Evidence、Schedule | 诊断、练习、主动回忆、反馈、间隔复习 | 作答、练习结果、解释、作品 | Learning Queue、主题笔记、进度复盘 |
| 生活 | Project/Area、Work、Action、Note、Memory、Schedule | 责任维护、习惯/事件、决策、关系与周期回顾 | 日历事件、完成记录、用户确认 | Today、Calendar、Area档案 |
| 娱乐/体验 | Work/Interest候选、Note、Action、Memory候选、Schedule | 捕获、选择、体验、反思、推荐/偏好候选 | 用户评价、记录、分享或作品 | Library、Queue、Calendar、体验日志 |

这些领域的差异主要在协议、Context、Evidence和View，不在于是否各自建立一套完全不同的数据库。确有独特对象时，
也应先证明它无法由现有核心对象与类型化扩展表达，再进入概念审核。

## 13. 文件、目录与Product Store的边界

Obsidian证明Markdown/目录非常适合让人理解和控制系统；Chat也可以把它们作为重要承载形式，但目标拓扑应是：

```text
Product Store权威事实
  → Daily Note / Project README / Review / Protocol文档等人类可读投影
  → 用户或Agent编辑
  → 形成候选变更与差异
  → CAS / HITL / Validation / Evidence
  → Product事务提交
  → 重新生成或确认投影
```

原因不是“数据库一定比文件高级”，而是Chat需要处理传统单用户Vault通常不负责的事情：

1. 多Product Session并发读取和修改同一Harness。
2. Approval必须绑定当前内容和revision。
3. Agent或Tool副作用需要权限、幂等和恢复语义。
4. Evidence、Provenance、Trace和失效传播不能由文件名猜测。
5. 前端、Telegram、文件和未来外部集成必须共享一个权威事实源。

文件投影仍应尽量可读、稳定、可导出，并公开它对应的对象ID、revision和生成时间；这能保留LifeOS的可迁移与信任优势，
同时避免双重事实源。

## 14. 不应复制的失败模式

1. **模板动物园**：几十个页面、数据库和按钮，却没有统一对象身份和运行闭环。
2. **Dashboard博物馆**：看起来信息丰富，但用户不知道下一步，系统也不维护陈旧状态。
3. **输入即强制归类**：用户必须先选Area、Project、Tag、状态，导致捕获成本过高。
4. **无声任务滚动**：所有未完成项每天自动搬运，最终积累成不可信的愿望清单。
5. **标签万能化**：同一个Tag同时表示主题、状态、权限、Context和路由，无法稳定查询和迁移。
6. **模板更新无版本**：作者更新方法，既有实例和用户覆盖项失去兼容关系。
7. **AI自动写长期事实**：摘要、偏好或“完成”未经用户/证据门就进入Memory和Work状态。
8. **文件冒充并发事务**：多Agent或多入口通过改Markdown互相覆盖，却没有CAS、幂等、HITL和对账。
9. **每个领域一套产品**：学习、生活、工作、娱乐各有独立Inbox、项目、标签和统计，用户重复维护。
10. **最大方法强加给所有人**：把作者的完整体系当默认正确答案，而不是从用户当前瓶颈逐步增加结构。

## 15. 体验与验证优先级

### 15.1 第一梯队：建议亲自体验

| 对象 | 体验目的 | 最小体验任务 | 预计成本 |
|---|---|---|---|
| Obsidian LifeOS示例Vault | 理解时间/主题双轴和项目索引 | 连续记录3天，创建1个项目，完成1次周回顾并归档 | 2-3小时 + 3天自然使用 |
| LifeOS Skill | 验证Agent能否读取协议并安全维护Vault | 捕获、查询、建项目、预览一次工作流迁移 | 1-2小时 |
| Notion Ultimate Brain或同类副本 | 理解规范对象与多视图 | 录入同一任务并从Today、Project、Goal三个视图观察 | 1-2小时 |
| Tana | 理解随处捕获→Supertag→Live Search | 从Daily Page把5条输入转成3类对象并修改模板 | 1-2小时 |
| NotePlan | 理解时间绊线与任务处置 | 保留一个未完成任务跨日，比较重排与不自动滚动 | 30-60分钟 + 2天 |
| RemNote | 理解学习Evidence与调度 | 创建10张同源卡片，完成2轮评分与到期复习 | 1小时 + 3天 |

### 15.2 第二梯队：针对单一机制体验

- Amplenote：验证Idea Execution Funnel是否比对象状态列表更容易理解。
- Sunsama：验证Daily Planning/Shutdown这种“在时机中教方法”的体验。
- Amazing Marvin：验证策略模块化的收益与配置过载阈值。
- Capacities：验证先捕获后类型化、Query与人工Collection的差别。
- Lunatask：验证工作、生活、习惯、情绪和关系放在一个Shell时是否仍保持一致心智模型。
- Daniel LifeOS：验证系统层与用户定制层分离、升级和回滚的产品表达。

### 15.3 体验记录模板

每次体验不要只记录“功能好不好用”，而记录：

1. 初始输入用了几步，是否必须先分类。
2. 同一事实出现在哪些视图，是否有复制。
3. 下一行动怎样产生，谁负责维护。
4. 陈旧、失败、过期和冲突怎样被发现。
5. 模板/方法更新后，既有数据怎样处理。
6. 哪些规则必须靠用户记忆。
7. 哪些主观判断被软件过度自动化。
8. 如果交给Chat执行，需要哪些权限、HITL、Evidence和恢复合同。

## 16. 候选产品判断，尚待审核

| 编号 | 候选判断 | 为什么提出 | 参考是否真正涉及 | 当前建议 | 信心与未验证项 |
|---|---|---|---|---|---|
| L1 | 建立可安装、可升级的Protocol Pack | 现有方法的真正复用单位超过单个协议Definition | LifeOS Skill、Daniel LifeOS涉及；MAF不负责产品协议分发 | 建议进入后续详细设计审核 | 中高；尚未定义与现有Catalog的最小边界 |
| L2 | 为协议增加Review Trigger/Cadence | 维护失败比初次搭建更常决定系统寿命 | NotePlan、Sunsama、RemNote强涉及 | 建议优先做场景验证 | 高；需核对现有Schedule设计是否已足够 |
| L3 | 增加未归类Inbox和陈旧状态绊线 | 保持低摩擦捕获，同时防止长期腐化 | Obsidian、Capacities、NotePlan涉及 | 建议复用现有Note/Work候选，不先建新库 | 高；需验证UI信息负担 |
| L4 | 提供文件/目录人类可读投影 | 保留Obsidian式可读、可迁移和可编辑优势 | Obsidian/Aino/Anytype涉及；并发治理未涉及 | 建议只作投影和受治理编辑入口 | 高；双向同步合同仍未设计 |
| L5 | 学习/生活/娱乐使用领域协议而非独立数据库 | 避免4套Harness和重复维护 | 多产品仅证明领域需求，未证明Chat对象足够 | 建议先用长场景验证 | 中高；习惯、人物关系等是否需独特对象尚未验证 |
| L6 | 评测协议维护成本与纠正率 | 防止只看Dashboard、Token和完成数量 | 正式参考基本未涉及完整指标 | 建议先定义最小事件和人工评测 | 中；指标可能反向驱动错误行为 |

这些判断不是批量开发授权。正式进入实现前，每项仍需结合当前代码、对象所有权、完整用户场景、全部可行选择、
迁移和验收门单独审核。

## 17. 来源地图

访问日期均为2026-07-27。优先使用官方文档、作者站点和官方仓库；营销页面只用于确认公开定位，不能单独证明
可靠性、用户满意度或完整实现。

### 17.1 Obsidian LifeOS生态

- [LifeOS官网](https://lifeos.md/)
- [核心概念](https://lifeos.md/guide/beginner-guide/core-concept)
- [使用总览](https://lifeos.md/guide/overview/usage)
- [自定义工作流](https://lifeos.md/guide/best-practice/custom-workflow)
- [项目生命周期](https://lifecontext.vip/guide/best-practice/project-life-cycle)
- [Daily Workflow案例](https://www.lifeos.md/case/daily-workflow)
- [开源基础版说明](https://obsidian-life-os.pages.dev/guide/readme/free)
- [主系统说明](https://obsidian-life-os.pages.dev/guide/core/main-system)
- [LifeOS更新日志](https://lifeos.md/news/lifeos-pro-changelog)
- [LifeOS Skill](https://lifeos.md/guide/ai-integration/lifeos-skill)
- [Aino是什么](https://aino.md/guide/intro/what-is-aino)
- [Aino下载](https://aino.md/download/)
- [Life OS Assistant社区页](https://community.obsidian.md/plugins/personal-life-system)

### 17.2 Notion方法体系

- [Notion Database Templates](https://www.notion.com/help/database-templates)
- [Notion Relations and Rollups](https://www.notion.com/help/relations-and-rollups)
- [Notion Database多视图说明](https://www.notion.com/help/guides/databases-reimagined-whats-changed)
- [Ultimate Brain](https://thomasjfrank.com/brain/)
- [Ultimate Brain Pages](https://thomasjfrank.com/docs/ultimate-brain/pages/)
- [Ultimate Brain Simple Way](https://thomasjfrank.com/docs/ultimate-brain/start-using-ultimate-brain-the-simple-way/)
- [August Bradley PPV](https://www.notionlifedesign.com/)

### 17.3 类型化对象与本地知识系统

- [Tana Getting Started](https://outliner.tana.inc/help/getting-started)
- [Tana Supertags](https://outliner.tana.inc/learn/features/supertags)
- [Tana Fields](https://outliner.tana.inc/learn/features/fields)
- [Tana Troubleshooting](https://outliner.tana.inc/help/troubleshooting)
- [Capacities Daily Notes](https://docs.capacities.io/reference/use-cases/daily-notes)
- [Capacities Content Types](https://docs.capacities.io/reference/content-types)
- [Capacities Queries](https://docs.capacities.io/reference/queries)
- [Capacities Collections](https://docs.capacities.io/reference/collections)
- [Anytype Documentation](https://doc.anytype.io/anytype-docs)
- [Anytype Queries and Collections](https://doc.anytype.io/anytype-docs/getting-started/sets/collections)
- [Logseq Documentation](https://docs.logseq.com/)

### 17.4 时间、行动与复盘

- [NotePlan Daily Notes](https://help.noteplan.co/article/43-part-1-daily-notes)
- [NotePlan Tasks](https://help.noteplan.co/article/52-part-2-tasks-events-and-reminders)
- [NotePlan Weekly Planning](https://help.noteplan.co/article/160-weekly-planning)
- [Amplenote Idea Execution Funnel](https://www.amplenote.com/help/idea_execution_funnel_explained)
- [Sunsama Daily Planning](https://help.sunsama.com/docs/usage-guides/daily-planning/)
- [Sunsama Weekly Review](https://roadmap.sunsama.com/changelog/weekly-review-20)
- [Amazing Marvin Basics](https://help.amazingmarvin.com/en/articles/2549907-the-basics-how-to-guide)
- [Amazing Marvin Strategies](https://help.amazingmarvin.com/en/collections/1139197-strategies)
- [Routine Journal](https://help.routine.co/en/articles/2612820/journal)
- [Routine Planner](https://www.routine.co/features/planner)

### 17.5 全生活与学习

- [Lunatask](https://lunatask.app/)
- [Lunatask Privacy](https://lunatask.app/docs/getting-started/privacy)
- [RemNote Spaced Repetition](https://help.remnote.com/en/articles/6022755-getting-started-with-spaced-repetition)
- [RemNote Flashcard Basics](https://help.remnote.com/en/articles/8663109-flashcard-basics)
- [RemNote Notes and Flashcards](https://www.remnote.com/feature/flashcards-in-your-notes)
- [Readwise Documentation](https://docs.readwise.io/readwise)
- [Readwise Reviewing Highlights](https://docs.readwise.io/readwise/docs/faqs/reviewing-highlights)

### 17.6 AI Harness

- [Daniel Miessler LifeOS官方仓库](https://github.com/danielmiessler/LifeOS)

## 18. 最终推导

类 LifeOS 已经证明 3 件事：

1. 用户确实需要一个跨学习、工作、生活和娱乐的连续运行系统，而不是互不相连的聊天和工具。
2. 最可持续的底座是稳定对象、低摩擦捕获、时间/主题双轴、多投影和周期维护，而不是某个固定UI。
3. 现有方案最大空缺是“谁替用户持续执行和维护协议，并在自动化时保持事实、授权、证据和恢复可信”。

Chat的机会正位于第3点：保留这些产品已经验证的人类方法，把原来靠作者教程和用户记忆运行的规则，转成Chat可
解释、可执行、可版本化、可迁移和可评测的协作协议。对话是入口，Harness是持续事实，Workflow是一次运行，
Agent/Tool是受治理执行者，Evidence/Trace证明结果，文档、目录、日历、看板和游戏化面板只是面向不同任务的投影。
