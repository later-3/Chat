# Chat 全项目生命周期管理蓝图

> 文档类型：项目管理模块上位产品与架构规范
>
> 决策日期：2026-08-25
>
> 当前状态：用户纠正后的采用方向；作为后续对象、呈现、Context、Provider和维护运行时设计的上位约束
>
> 实现事实仍以`PROJECT_STATE.md`、K0基线、源码与as-built为准

## 1. 目标

Chat需要拥有的不是某个外部工具Adapter，也不是一套Markdown任务模板，而是：

> 一套能够拆解、定义、呈现、维护和持续演进不同类型Project的管理方案与技术设施；Chat使用它管理自己，也使用它帮助用户管理其他Project。

这套系统必须回答四类问题：

1. **管理什么**：Project包含哪些对象、关系、时间、历史和完成事实；
2. **怎样维护**：用户与Agent如何提出、采用、推进、验证、复盘和演进；
3. **怎样看见**：用户需要哪些视图，Agent需要哪些可恢复上下文；
4. **放在哪里**：哪些事实由Chat拥有，哪些内容由Git、文件、数据库或外部平台拥有，怎样引用和对账。

DSH、代码编辑器、Markdown查看器、媒体播放器、数据库和报表工具都是实现某些能力的表面或Provider，不能出现在
核心Project语义中。Git在包含代码或版本化文件的项目里是明确采用的版本控制基础设施，但它也不拥有Project目标、决定或完成事实。

## 2. 方法证据与采用结论

本蓝图不照搬单一方法论，采用以下公开方法中被多个场景共同证明的部分：

| 来源 | 采用事实 | Chat采用方式 |
|---|---|---|
| [PM² Project Management](https://pm2.europa.eu/pm2-methodologies/pm2-project-management_en) | 治理、生命周期、活动和Artefact四个支柱；项目需要按上下文裁剪 | Authority、Lifecycle、Maintenance Activity、Artifact/View分层 |
| [PMI Process Groups](https://www.pmi.org/standards/process-groups) | 启动、规划、执行、监控控制、收尾形成管理循环 | Project生命周期的通用检查点，不强制每个Profile使用同一阶段名 |
| [Shape Up](https://basecamp.com/shapeup) | 先塑形、设投入边界、区分候选与承诺、用Scope和未知性观察进展 | Need→Shape→Commit分离；Profile可定义Appetite和Discovery Progress |
| [W3C PROV](https://www.w3.org/TR/prov-overview/) | Entity、Activity、Agent及其来源关系用于判断可靠性 | Artifact、Activity、Participant、Evidence和Provenance关系 |
| [Git版本控制](https://git-scm.com/book/en/v2/Getting-Started-About-Version-Control.html) | 文件随时间的版本、比较、归因和恢复 | 软件代码和受管文本的权威版本历史 |
| [OpenProject Work Packages](https://www.openproject.org/docs/user-guide/work-packages/) | 稳定事项ID、类型、状态、负责人、优先级、日期、关系和活动 | Work Tracking能力只是Project对象体系的一部分 |

采用结论：

- Project管理必须包含治理、生命周期、工作、资源/产物、决定、证据、知识和时间历史；
- 不同Project只共享内核不变量，不共享固定对象集合、状态机和视图；
- 事项系统负责跟踪Work，不负责替代完整资产、文档、代码和知识系统；
- 用户需要可观察的历史变化，不能只看到当前状态；
- Agent需要来源明确、按当前Work裁剪的上下文，不能依赖旧Session或全量文件扫描；
- 方法必须可版本化和迭代，不能一次设计后永久锁死。

## 3. 三层模型

### 3.1 通用Project内核

所有Project都必须能够表达：

```text
Project Identity
Objective / Outcome
Participant / Authority
Need / Requirement
Work / Action / Dependency
Schedule / Cadence / Milestone
Resource / Artifact
Decision / Change
Evidence / Review / Acceptance
Risk / Issue / Block
Knowledge / Case / Practice
Event / Revision / Provenance
View Requirement / Context Map
```

并非每个概念都必须成为一张独立Store表。K1需要以不变量、查询和生命周期判断哪些是稳定聚合、哪些是Profile扩展或读模型；
不得因为表格方便而制造Repository-per-object，也不得把全部概念塞进万能JSON对象。

### 3.2 Project Profile Revision

Profile定义“一类Project怎样被管理”，至少包含：

| 区域 | 内容 |
|---|---|
| Object Catalog | 本Profile使用哪些对象类型和关系 |
| Lifecycle | Project、Work、Artifact或知识对象的状态机和Gate |
| Time Policy | 期限、Cycle、Cadence、Recurrence、回顾窗口和时区 |
| Authority | 用户、Agent、自动化和外部参与者的读、写、决定和确认权限 |
| Evidence | 什么能证明进展、验收、发布、掌握或采用 |
| Resource Policy | 权威资源类型、观察预算、版本和来源规则 |
| Context Policy | Agent开工、执行、审核和Handoff分别读取什么 |
| View Requirements | 用户必须能看见哪些列表、时间线、文档、代码、媒体、报表或关系图 |
| Maintenance Policy | 哪些事件/时间触发观察、同步、提醒、报告和复盘 |
| Metrics | 哪些指标有意义，怎样避免用数量制造假进度 |

Profile是内置、版本化、可测试的规则，不是任意执行DSL。Profile更新产生新Revision和采用Decision，不能静默重解释旧历史。

### 3.3 Project Configuration Revision

Configuration定义“这个真实Project怎样采用Profile”：

- 名称、目标、范围、成功标准和明确不做；
- 当前生命周期、期限、节奏和时区；
- 参与者、角色、Authority覆盖；
- 资源、目录、仓库、数据库和外部平台Binding；
- 术语、分类、渠道、能力域或产品模块；
- 必读治理、历史视角和默认View；
- Provider Capability选择和Mapping；
- 当前Profile Revision与采用Decision。

同类型Project可以采用不同Configuration；同一Project也可以通过Decision升级Configuration而不改变稳定Project ID。

## 4. 管理对象

### 4.1 身份与治理

| 对象 | 责任 | 用户关心 | Agent关心 |
|---|---|---|---|
| Project | 内聚事情的稳定身份、目标、范围和生命周期 | 为什么做、成功是什么、现在在哪 | 当前Project ID、Revision、目标和禁止事项 |
| Objective/Outcome | 可观察的目标或阶段结果 | 得到什么、有无达成 | 验收条件和Evidence政策 |
| Participant | 人、Agent、自动化、外部组织 | 谁参与、谁负责 | 自己的稳定Participant身份 |
| Authority | 能读、写、建议、决定、确认或执行什么 | 哪些必须由我决定 | Allowed/Denied Actions和高影响Gate |
| Profile/Configuration | 当前采用的管理方法与项目配置 | 为什么这样管理、何时修改过 | 精确Revision、Hash和编译政策 |

### 4.2 需求、范围与承诺

| 对象 | 责任 | 关键边界 |
|---|---|---|
| Need | 用户问题、机会、想法、输入或Gap | 被记录不等于被承诺 |
| Requirement | 对结果、行为、质量或约束的明确要求 | 必须可追溯到Need、Decision和验收 |
| Scope | 一个阶段或承诺包含与不包含什么 | 可变，但变化必须有来源和影响 |
| Work | 可独立验收的用户结果 | 不等于Action、Session、Commit或单文件修改 |
| Action | 当前可以执行的下一步 | 完成Action不自动完成Work |
| Dependency | Work/Artifact/Decision之间的先后或阻塞关系 | 不能只在文字说明里隐含 |
| Commitment | 用户或有权角色选定的当前投入 | Backlog/Idea不自动进入承诺 |

### 4.3 执行、质量与变化

| 对象 | 责任 | 关键边界 |
|---|---|---|
| Activity | 人、Agent或系统在一段时间内做了什么 | 过程不是完成事实 |
| Claim | 某Participant临时承担某Work | 有lease、释放、过期和Handoff |
| Risk | 尚未发生但可能影响目标的风险 | 与已经发生的Issue/Block分离 |
| Issue/Block | 已发生的问题或停止条件 | 必须有恢复条件和责任人 |
| Review | 对Work、Artifact、Decision或Evidence的审核 | 审核意见有Revision和对象绑定 |
| Acceptance | 有Authority的验收结果 | Agent不能用自报替代 |
| Change | 对范围、要求、Profile、Configuration或计划的修改 | 记录原因、影响和采用Decision |

### 4.4 资源、产物、证据与知识

| 对象 | 责任 | 所有权 |
|---|---|---|
| ResourceRef | 指向仓库、目录、文档、数据库、平台或外部对象 | Chat保存受管引用和能力，不复制内容 |
| ArtifactRef | 指向被生产或修改的具体产物及Revision | 真实Store拥有正文/二进制 |
| Evidence | 证明观察、进展、验收或终态的不可混淆引用 | Chat保存Hash、来源、时间、验证级别 |
| KnowledgeRef | 说明、研究、笔记和概念知识的入口 | 可由任意Document Provider呈现 |
| Case/Lesson | 从一个结果中提取的经验、适用条件和反例 | 候选经采用后成为长期知识 |
| Practice Revision | 可复用工作方法、检查表或流程版本 | 与Workflow Runtime Definition分离 |
| Metric/Observation | 对项目或结果的测量 | Observation不是Decision或成功结论 |

### 4.5 时间与历史

Project不能只保存“当前状态”，必须区分：

- `occurredAt`：事情实际发生时间；
- `observedAt`：Chat或Agent看到它的时间；
- `recordedAt`：写入产品事实时间；
- `validFrom/validTo`：规则、配置或关系的有效区间；
- `plannedStart/plannedEnd`：计划时间；
- `actualStart/actualEnd`：实际时间；
- `dueAt`：期限；
- `reviewAt`：检查点；
- `cadence/recurrence/timezone`：重复维护节奏。

历史由三类事实共同组成：

1. `ProjectEvent`：发生了什么、由谁、影响哪个对象；
2. `Object Revision`：对象在某一Revision是什么；
3. `Provenance`：Artifact/Evidence由哪些Activity、Participant和Resource产生。

当前看板、日报、周报、趋势和时间线都应从这些事实派生，不能各自手工维护状态副本。

## 5. 生命周期与持续维护循环

通用循环不是固定的瀑布阶段，而是一组所有Profile必须解释的管理活动：

```text
Capture Need
→ Understand / Shape
→ Decide / Commit
→ Plan
→ Execute
→ Observe / Monitor
→ Review / Accept
→ Deliver Outcome
→ Learn / Evolve
→ Continue / Pause / Close
```

Monitor、Control、Knowledge和Maintenance贯穿所有阶段。不同Profile可以：

- 省略不需要的显式阶段；
- 使用期限、Cycle、Review Trigger或持续流；
- 把探索和执行分开，显示未知性而不是伪造百分比；
- 同时维护交付流和方法改进流；
- 对外发布、掌握、采用和关闭使用不同Evidence/Gate。

### 5.1 Maintenance Runtime

项目不能只在用户显式要求同步时维护。Chat需要一个耐久Maintenance Runtime，响应：

- Agent开始、恢复、Handoff和结束；
- Product Command和Decision；
- Resource Observer检测到变化；
- Provider webhook、poll或reconcile结果；
- 期限、每日/每周/月度Cadence；
- Claim过期、Block超时、Review等待和Context陈旧。

Maintenance Activity可以观察、编译读模型、生成Attention和Candidate，但不能越权创建承诺、确认终态、采用方法或执行高影响外部动作。

## 6. 用户呈现合同

核心定义用户需要看见的信息，不规定由哪个工具呈现。

| View Capability | 必须回答 | 可能的实现表面 |
|---|---|---|
| Project Home | 目标、阶段、健康、当前承诺、风险、待决定、最近变化、下一步 | DSH、Web、项目管理前端 |
| Work Board/List | Work、状态、责任、优先级、期限、依赖、阻塞 | DSH或其他Work Tracker |
| Timeline/Calendar | 计划与实际、事件、发布、学习、回顾和期限 | DSH、日历、报表前端 |
| Object Detail | 一个对象的要求、关系、历史、Evidence和讨论 | 任意支持结构化Detail的表面 |
| Document View | 需求、方案、笔记、说明、案例和报告正文 | DSH、Markdown查看器、编辑器、知识工具 |
| Code View | 仓库、文件、Diff、Commit、测试和代码导航 | code-server、VS Code或未来代码前端 |
| Media View | 图片、音频、视频和发布预览 | DSH、浏览器、媒体工具 |
| Review/Decision | 候选、变化、对比、理由、Evidence和确认动作 | DSH或有治理能力的前端 |
| Report/Chart | 进展、流量、趋势、质量、学习掌握和发布表现 | DSH、报表/BI表面 |
| Relation/Graph | Objective、Need、Work、Artifact、Evidence和Knowledge关系 | DSH、图谱或文档工具 |
| Attention | 跨Project的Blocked、Needs Review、待决定、过期和同步异常 | DSH首页、通知或未来Workspace前端 |

同一个Provider可以实现多个Capability；一个Capability也可以由多个Provider实现。某个文档工具不是核心依赖，DSH完全可以实现
Document View；Work Tracker也不是Project本体，只是Work View的一种实现。

### 6.1 View Requirement

Profile声明用户必须具备哪些View Capability以及最低字段；Project Configuration选择当前实现。缺少必需View时必须显示
`unavailable/unsupported`及替代入口，不能因为某个Provider没有表格、图表或媒体能力就丢弃对象。

## 7. Agent上下文合同

Agent不消费“某个工具页面”，而消费Chat Application按目的编译的Context：

| Context | 用途 | 最小内容 |
|---|---|---|
| Project Opening | 进入Project | 身份、目标、Profile/Configuration、Authority、当前阶段、Attention、Resource路标 |
| Work Execution | Claim和执行 | Work要求、Scope、依赖、相关Artifact/Knowledge、Decision、Evidence门、允许动作 |
| Delta | 恢复或长任务续跑 | 自上次Anchor后的Event、Revision、Provider/Resource变化和未决Operation |
| Review | 人或Agent审核 | 候选/旧Revision对比、要求、Evidence、风险、决策权限 |
| Handoff | 跨Agent接手 | 已完成、剩余、风险、下一步、必读资源、Evidence和Claim状态 |
| Maintenance | 定时/事件维护 | 到期对象、陈旧Context、同步健康、Blocked/Review等待和报告窗口 |

每个Context都必须：

- 带Project/Work/Profile/Configuration Revision与SourceRef；
- 按Authority过滤；
- 有字符、对象数量和Artifact预算；
- 区分实时Snapshot、历史事实和Agent候选；
- 不包含完整隐藏推理、Token、未授权绝对路径或全部项目历史；
- 在来源失败时显示陈旧/不可用，不能静默使用旧事实。

## 8. 存储与技术设施

### 8.1 Chat Product Store

拥有：稳定身份、关系、政策采用、Authority、Decision、Work协调、Evidence引用、Context Map、View Requirement、
Provider Binding/Projection、Operation、Event和Revision。

不拥有：完整代码仓库、文档正文、媒体二进制、外部平台事实本体、Agent隐藏推理。

### 8.2 Git

对软件代码和声明为`versioned_file`的资源，Git是固定版本历史基础设施。Chat引用Repository、Branch/Worktree、Commit、Path和Diff，
但Commit只是Artifact/Evidence，不自动完成Work。非软件项目不为了统一而强制把全部媒体或数据库放进Git。

### 8.3 Resource Provider

Resource Provider声明能力，而不是行业名称：

```text
discover / read / write / version / diff / search / watch / render / export
```

每个Provider必须说明Scope、Credential、Authority、生命周期、幂等、结果未知、冲突、审计、退出路径和内容所有权。

### 8.4 Presentation Provider

Presentation Provider消费稳定Query/View Model，提供Document、Code、Media、Timeline、Board、Report或Graph等能力。它不直接写
Product Store；用户动作通过Chat Command提交，或被外部Provider修改后作为Inbound Change对账。

## 9. Project Profile第一组

| Profile | 核心对象与差异 | 关键完成事实 |
|---|---|---|
| `software-delivery.v1` | Requirement、Feature/Bug/Risk Work、Git Artifact、测试、Release | 可验证软件结果、质量门和用户验收 |
| `content-production.v1` | Source、Content Work、媒体Artifact、Publication、Case、Practice | 发布回执、用户审核、方法采用 |
| `learning.v1` | Competency、Gap、Learning Activity、Exercise、Assessment、Knowledge | 回忆、应用或测评证明掌握/需复习 |
| `personal-journal.v1` | Capture、Entry、Action Candidate、Event、Review、Report | 来源可追溯的记录、复盘与后续决定 |

四个Profile用于验证内核边界，不构成未来类型上限。新增Profile必须证明差异位于Profile/Configuration/Resource/View，而不是复制
Project控制面。

Profile是可复用的管理类别，不是实际Project模板实例。`AI学习`、`四个月后跳槽`、`个人日报`等名称与目标，目标日期以及每日/每周
Cadence都只能进入具体Project Configuration；同一个`learning`既能管理有期限的职业学习，也能管理无期限的长期阅读。

## 10. Chat模块责任

| 模块 | 新增或收敛责任 |
|---|---|
| `packages/contracts` | Project对象、时间、Event、View、Context、Profile/Configuration网络合同 |
| `packages/domain` | 状态机、时间不变量、Authority、Evidence/Gate和Profile编译 |
| `packages/application` | Adoption、Query、Context Compiler、Coordination、Maintenance、Projection和对账 |
| `packages/product-store-json` | 双谱系迁移、完整性、Event/Revision和单事务事实 |
| `packages/project-runtime` | Git、文件、内容、学习/日报等Resource Adapter，不拥有产品终态 |
| `packages/workflows` | 耐久Maintenance、定时Review、Observer和Provider对账步骤 |
| `packages/dsh-lifeos-bridge` | Project Home、Attention、Review和View/Resource跳转的窄表面 |
| `packages/pi-runtime` | Agent项目Context与受治理命令工具，不拥有Project事实 |
| 外部Provider | Work tracking、document/code/media/report呈现或资源能力 |

## 11. 完成定义

系统只有在以下结果同时成立时才算完成首版：

1. 四个Profile端到端推演和真实纵向通过；
2. 用户能从Project Home进入所需Work、Document、Code、Media、Timeline和Report能力，具体工具可替换；
3. Agent跨Session、跨Runtime和跨角色恢复相同Project/Work与来源；
4. 当前状态、历史Revision、时间线和Provenance可查询；
5. Maintenance Runtime无需用户提醒即可产生受治理Attention、同步和报告；
6. Chat自身完成一次由稳定旧版本管理新版本的真实开发闭环；
7. Provider移除或不可用时，核心Project与真实资源不丢失；
8. 新合成Profile不修改核心Router/Store分支即可编译并通过合同测试；
9. 用户通过真实使用确认方案可用，后续摩擦进入Profile/Configuration演进。

## 12. 非目标

- 不把所有项目对象正文复制到Chat；
- 不把所有Provider能力压成最低公分母；
- 不预先实现所有行业Profile、报表和集成；
- 不让某个Viewer、事项系统或Agent Session成为Project事实；
- 不用任务数量、文件数量、模型自报或单一百分比冒充真实进展；
- 不一次冻结永不变化的方法，首版必须保留Revision、迁移和反馈闭环。
