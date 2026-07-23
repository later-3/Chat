# Product Harness、Work 与 Memory 详细设计

> 状态：已批准。2026-07-23用户批准D1-D8；本文固定正式Schema方向、状态机、Agent工具合同、HITL写入门和长期场景，并作为实现与验收基线。
>
> 证据版本：MAF安装版`1.11.0`；MAF源码`9c4cd07899502157284b64a73f9a0adfb4594d96`；pi`2b00dade7cec918aefb025c8b7a4fa304a30acdd`；nanobot`2c789767280482f38667044f8a3be5102c71dd26`；QwenPaw`2134427584c2657bb717bb083a120f2de011d047`；LibreChat`8e5ef1fb31e9d63b735c089b21cbc82c50acce46`。

## 1. 要解决的问题

Chat不能只保存对话，然后让模型从摘要猜“用户有哪些项目、做到哪一步、最近在学什么”。系统需要一套产品级承载面：

```text
用户输入 / Agent候选
  -> Product Harness命令或查询
  -> Project / Work / Plan / Note / Memory权威事实
  -> Context Resolver按当前意图选择最小充分工作集
  -> ExecutionDraft / RunSpec
  -> Agent执行
  -> Evidence、结果和候选状态变更
  -> HITL/策略提交
```

这里的`Product Harness`不是新的Agent，也不是MAF HarnessAgent。它是Chat应用层向Agent和前端暴露产品资源的受治理合同集合。

## 2. 证据与取舍

### 2.1 MAF事实

1. MAF负责Agent、Workflow、Session、Tool、Checkpoint和`request_info`恢复。
2. MAF Harness提供Todo、Mode、文件记忆等Agent便利能力，但不拥有本产品的Project、Work、Note和Accepted Memory事实。
3. 采用：MAF Tool类型合同、Workflow节点、HITL和Checkpoint。
4. 不采用：把Harness Todo或AgentSession直接当Product Work Store。

### 2.2 pi事实

1. `session-manager.ts`用追加条目、parentId、compaction和custom entry保留完整历史与派生上下文。
2. `compaction.ts`把摘要、保留边界和文件操作细节分开，原始记录不因压缩消失。
3. 采用：追加事实、派生摘要、上下文投影分离；资源按需加载。
4. 不采用：用单个编码Session文件承载多项目的权威工作管理。

### 2.3 nanobot事实

1. MemoryStore区分原始history、长期`MEMORY.md`、用户与身份文件；ContextBuilder有明确Token上限。
2. 采用：长期记忆与最近历史分离、预算上限、派生失败不破坏原始历史。
3. 不采用：可被Agent直接覆盖的Markdown作为本产品唯一长期事实源。

### 2.4 QwenPaw事实

1. Workspace组合Session、Memory、Driver、Cron和TaskTracker；Memory工具通过Manager注入。
2. MemorySpace把持久历史只读挂载给模型，写入只发生在隔离scratch区域。
3. TaskTracker支持运行中事件缓冲和重连，但本身是进程内状态。
4. 采用：Workspace式能力装配、Agent只读召回与受控写面分开。
5. 不采用：进程内TaskTracker作为持久Work生命周期；允许模型直接写权威历史。

### 2.5 LibreChat事实

LibreChat覆盖Web资源、Conversation、Message、Run和持久恢复，但没有为本项目完整Project/Work/Learning/Memory治理背书。采用其服务端权威资源和CAS原则；其未涉及的领域由本项目需求推导。

## 3. 正式对象

### 3.1 Project

长期目标容器，允许跨Session、跨Work和跨时间推进。

| 字段 | 约束 |
|---|---|
| `id` | UUID，不复用标题 |
| `scope_id` | 权限与租户边界 |
| `kind` | `delivery`、`learning`、`research`、`personal` |
| `title`、`goal` | 用户可见目标；标题不能替代目标 |
| `status` | 状态机值 |
| `current_milestone_id` | 可空，不把里程碑文本塞入Project |
| `row_version` | CAS |
| `created_by`、`created_at`、`updated_at` | 来源与时间 |

### 3.2 WorkItem

跨回合推进的工作单元。Task、Issue、学习练习和研究问题都使用一个生命周期，通过`kind`区分，不再建立互不兼容的Task表。

| 字段 | 约束 |
|---|---|
| `project_id` | 可空；简单独立事项允许无Project |
| `kind` | `task`、`milestone`、`learning_unit`、`research_question` |
| `title`、`objective` | 当前目标 |
| `status` | 状态机值 |
| `priority` | 有限枚举，不让模型自由造等级 |
| `parent_work_item_id` | 可空；形成树但禁止环 |
| `current_plan_revision_id` | 可空；只指向已接受Plan revision |
| `completion_evidence_set_id` | 完成时必须存在或明确豁免 |
| `row_version` | CAS |

### 3.3 TaskPlan与PlanNode

`TaskPlan`拥有不可变revision；`PlanNode`表示步骤、依赖、责任主体、验证和停止条件。Plan不是Workflow Definition：Plan描述要做什么，Workflow描述系统怎样编排。

### 3.4 ActionItem

用户或Agent下一步承诺。它可以来自PlanNode，也可以独立存在；拥有`assignee_kind=user|agent|external`、截止时间、状态和完成Evidence。

### 3.5 Note与NoteRevision

笔记是可编辑知识资产，不是Memory。

| kind | 用途 |
|---|---|
| `learning_note` | 技能概念、练习、误区和复习线索 |
| `project_note` | 项目背景、方案、会议和过程记录 |
| `research_note` | 来源、摘录、分析和未决问题 |
| `idea` | 尚未承诺为Work的想法 |

每次修改生成`NoteRevision`；Note只保存current pointer、状态和索引元数据。内容包含来源引用，但不把外部网页全文无界复制。

### 3.6 MemoryCandidate、AcceptedMemory与MemoryRevision

1. `MemoryCandidate`是一次提议，来源可以是Message、TurnSummary、Note、Project或用户直接输入。
2. `AcceptedMemory`是稳定身份和作用域；`MemoryRevision`是不可变内容版本。
3. `scope_kind`至少支持`user`、`project`、`work_item`、`learning_track`。
4. Memory必须声明`memory_kind`：偏好、稳定事实、决定、经验规则、术语或关系。
5. 接受、拒绝、替代、撤销和失效都保留记录；删除原始Message不能静默改写Memory来源状态。

### 3.7 LearningTrack不是独立存储孤岛

学习使用`Project(kind=learning)`承载长期目标，`WorkItem(kind=learning_unit)`承载模块与练习，`Note(kind=learning_note)`承载笔记，PlanNode承载学习路径，Evidence承载测验或作品。API可提供`LearningTrackView`，但不建立第二套Project/Task生命周期。

### 3.8 关联对象

采用显式关联表：

1. `resource_session_links`：资源与Product Session，含关联原因和来源。
2. `resource_message_links`：事实或候选到原始Message。
3. `project_work_links`：跨Project依赖，不用逗号分隔ID。
4. `note_resource_links`：Note到Project/Work/Evidence/来源。
5. `memory_source_links`：Memory revision到证据来源。
6. `context_adoption_records`：本轮实际采用/排除哪些资源及原因。

## 4. 状态机

### 4.1 Project

```text
proposed -> active -> paused -> active
    |          |         |
    +------> cancelled    +--> completed -> archived
active ---------------------------------> archived
```

`completed`要求里程碑和开放Work检查；`archived`只隐藏，不表示完成。

### 4.2 WorkItem

```text
draft -> planned -> ready -> in_progress -> completed -> archived
                    |           |  ^
                    |           v  |
                    +--------> blocked
draft/planned/ready/in_progress/blocked -> cancelled
completed -> in_progress 仅允许带理由的reopen命令
```

禁止：模型输出一句“完成了”就直接`completed`；必须通过`work_state_commit`并绑定Evidence或豁免原因。

### 4.3 PlanNode与ActionItem

`pending -> ready -> in_progress -> completed`；任意未终态可进入`blocked|skipped|cancelled`。依赖未完成时不能进入ready，除非用户显式override并留Decision Record。

### 4.4 Note

`draft -> active -> superseded -> archived`。修改产生revision，不把Note变成Memory；Note内容可以提出MemoryCandidate。

### 4.5 Memory

```text
candidate -> pending_review -> accepted -> superseded
     |              |            |
     +-> rejected   +-> rejected +-> revoked / invalid
candidate -> session_only（只进入当前Session派生上下文，不是长期Memory）
```

## 5. 命令、查询和事务

### 5.1 查询

1. `list_projects(status, kind, cursor)`。
2. `search_resources(query, kinds, project_id, limit)`。
3. `get_project_context(project_id, include)`。
4. `list_work(project_id, status, parent_id)`。
5. `get_work_item(id)`、`get_plan(id, revision)`。
6. `search_notes(query, project_id, work_item_id)`。
7. `search_memory(query, scope, as_of)`。

查询只返回调用Principal可见的Product事实；模型不通过Prompt猜目录。

### 5.2 命令

1. `propose_project`、`activate_project`、`transition_project`。
2. `propose_work_item`、`transition_work_item`、`reparent_work_item`。
3. `create_plan_revision`、`accept_plan_revision`。
4. `capture_note`、`create_note_revision`、`link_note`。
5. `propose_memory`、`accept_memory_revision`、`reject_memory_candidate`、`revoke_memory`。

每个命令包含`command_id`、Principal、预期row_version、原因、来源引用和可选Decision/Grant；命令结果原子写领域事实、Trace和Outbox。

### 5.3 失败语义

1. CAS冲突：不覆盖，返回当前版本和Diff入口。
2. Agent/模型失败：候选可失败，不能产生正式状态。
3. 索引失败：领域事实已提交则进入`index_pending`，可重建。
4. 外部同步失败：Outbox重试，不回滚本地已接受事实。
5. Evidence未知：Work保持`in_progress|blocked`，不能假完成。

## 6. Agent Harness工具合同

### 6.1 工具集合

```text
harness.list_projects
harness.search_resources
harness.get_project_context
harness.list_work
harness.get_work_item
harness.search_notes
harness.search_memory
harness.propose_project
harness.propose_work_change
harness.capture_note
harness.propose_memory
```

Agent看到的是稳定Schema与精简结果，不直接获得数据库或任意SQL。只读工具不签发写Grant；写工具默认只生成candidate/command preview，真正提交走Decision Point。

### 6.2 Prompt中的Harness说明

Agent Instructions只说明：

1. 何时先查目录，何时加载详情。
2. 资源ID和revision必须原样引用。
3. 查询为空就诚实回答为空。
4. 不能把摘要候选表述为正式Project/Work/Memory。
5. 任何长期写入先调用propose工具，不能在自然语言中宣称已提交。

不把所有Project、Task和Note正文复制到System Prompt。

## 7. 两阶段上下文

### 阶段A：意图与候选目标

输入：当前User Message、最近回合重点、开放澄清、Project/Work轻量目录、少量检索命中。

输出：IntentCandidate、候选Project/Work、置信度、是否需要HITL。

### 阶段B：目标绑定后的ContextPackage

只加载已选目标的：背景、目标、当前状态、已接受决定、开放Work、当前Plan、必要Note片段、Accepted Memory、Evidence引用、文件入口和验证标准。

每一项带`source_kind/source_id/revision/adoption_reason/token_estimate`；Context Adoption记录采用与排除。大文件交给Tool按需读取。

## 8. HITL矩阵

| 动作 | 默认 | 可跳过条件 | 不可普通跳过 |
|---|---|---|---|
| 查看Project/Work目录 | auto | 始终只读且同Scope | 跨权限Scope |
| 采用Project上下文 | conditional | 唯一高置信匹配且不跨项目 | 多匹配、跨敏感项目 |
| 创建Project/Work候选 | auto candidate | 只生成候选 | 正式激活 |
| 正式创建/改目标 | require human | 精确低风险策略可配置 | 删除、合并、跨Scope |
| Work普通进度更新 | conditional | 有Evidence且未声称完成 | completed/cancelled/reopen |
| 保存Note revision | conditional | 用户明确要求记录且同Scope | 覆盖冲突、外部发布 |
| 接受长期Memory | require human | 精确Project规则可配置 | 敏感事实、跨Scope、身份权限 |
| 撤销/失效Memory | require human | 无 | 不能由模型静默完成 |

优先级沿用：系统下限 > Run > Project/场景 > Workflow > 用户默认。

## 9. 前端工作区

统一配置中心继续负责策略和工具配置；主工作区增加4种平行视图：

1. `Project Explorer`：Project目录、状态、目标、里程碑和关联Session。
2. `Work Board`：树/列表、Plan revision、ActionItem、阻塞和Evidence。
3. `Knowledge`：Note、来源、关联、revision和Memory候选。
4. `Context Inspector`：本轮候选、采用/排除、预算和来源。

聊天中的HITL卡只显示本次决定；“查看完整内容”打开右侧工作区，不把17部分或长期资源压进小弹窗。

## 10. 长跨度验收场景

### 10.1 三周开发项目

1. 第1天“做贪吃蛇”：只生成Project/Work/Plan候选；确认后激活。
2. 第3天“继续昨天碰撞检测”：阶段A命中唯一Project和开放Work，阶段B只加载相关Plan、Note和文件引用。
3. 第5天Agent声称完成但测试失败：Evidence失败，Work保持in_progress并记录阻塞。
4. 第8天用户改方案：新Plan revision，旧Plan可追溯；ExecutionDraft使用新版。
5. 第14天跨Session问“做到哪了”：直接查询Project/Work，不依赖原Session长度。
6. 第21天完成：所有开放Work和Evidence通过后提交completed，随后可archived。

### 10.2 四周学习技能

1. 创建`Project(kind=learning)`和多个`learning_unit`。
2. 每轮保存原始会话；重点进入TurnSummary；概念解释可形成learning_note revision。
3. “我哪里薄弱”查询练习Evidence和开放Work，不让模型从聊天语气猜。
4. 稳定学习偏好提出MemoryCandidate，用户接受后成为Project或User scope Memory。
5. 两周后复习只装配当前单元、错题Note和相关Memory，不加载四周全部聊天。

### 10.3 纯问答

“Python的GIL是什么”保存原始Interaction和回合重点，但不创建Project/Work；除非用户明确要求记笔记，否则不生成正式Note；确有稳定偏好才提出MemoryCandidate。

### 10.4 可执行长场景测试合同

长测试不能用真实等待几周，也不能只验证最终一行文本。测试Runner注入可控时钟，以`day/turn/session/channel/process`作为步骤属性；每一步都检查领域表、Context Adoption、Decision、Outbox、Trace和用户可见投影。

`E2E-LONG-DEV-21D`至少包含32轮：

1. Day 1创建贪吃蛇候选，用户修改目标后接受；断言1个Project、3个初始WorkItem和Plan revision 2，旧revision保留。
2. Day 2在新Session询问无关Python问题；断言保存Interaction/TurnSummary，但不关联Project、不改Work、不产生Accepted Memory。
3. Day 3说“继续碰撞检测”；唯一目录命中后只装配该Project、当前Work、接受的Plan、必要Note和文件入口；断言没有复制Day 2问答和全部历史。
4. Day 5 Agent声称碰撞检测完成，但测试Evidence失败；断言Work仍为`in_progress`或`blocked`，不存在完成Decision和假Assistant完成事实。
5. Day 8修改技术方案；制造CAS竞争和API进程退出；断言新Plan revision获批、旧ExecutionDraft授权失效、Outbox由新Worker恢复一次。
6. Day 12跨Session、跨入口重复提交同一`command_id`；断言Project/Work/Note各只有一个有效提交，重复输入仍有Trace但无重复副作用。
7. Day 14查询“做到哪了”；断言答案来自Project/Work/Evidence查询，不依赖原始Session是否仍打开。
8. Day 18撤销一个来源Note；断言相关Context/Memory候选降级或失效，未关联资源不受影响。
9. Day 21所有开放Work有通过Evidence后请求完成；断言完成HITL、Project状态、最后里程碑、Run和用户可见摘要一致。

`E2E-LONG-LEARN-28D`至少包含40轮：

1. 创建`Project(kind=learning)`、4个`learning_unit`和首个Plan revision。
2. 在4周中穿插练习、错题、概念笔记、无关闲聊和两个不同Session；原始Message全部保留，Context每轮只装配当前单元和相关来源。
3. 同一概念被纠正3次；断言Note有3个revision，Accepted Memory只指向用户接受的当前版本，旧版本可追溯但不再采用。
4. “我哪里薄弱”必须查询失败Evidence和开放Work；模型不得从聊天语气猜测。
5. 用户说“我喜欢先看例子”先产生MemoryCandidate；拒绝后不得进入下轮Context，再次明确接受后才成为User-scope Memory。
6. Day 28复习时断言Prompt不包含28天完整历史，Token预算在上限内，并能定位每个采用块的source/revision/reason。

执行层分3组：

1. 领域长测使用脚本化Agent输出和虚拟时钟，保证几十轮可重复且覆盖全部负向断言。
2. 故障长测在每个提交门后注入API/Worker退出、重复Outbox、Lease过期、索引失败和CAS竞争；每个安全点至少一次。
3. 真实模型长测抽取Day 1、3、8、14、21及学习Day 1、7、14、28共9个关键回合，使用现有Provider配置并逐次审批；比较结构合同和产品事实，不以模型措辞逐字相等为断言。

这些测试随正式Schema进入`backend/tests/e2e/`；不建立另一套临时内存Harness。

## 11. 已批准决定

1. `D1`：采用统一WorkItem + kind，而不是Task/LearningTask/ResearchTask三套表。
2. `D2`：学习使用Project/Work/Note组合，仅提供LearningTrack投影视图。
3. `D3`：Note与Memory严格分开，Note可产生MemoryCandidate。
4. `D4`：所有领域写命令CAS + 事实/Trace/Outbox同事务。
5. `D5`：Agent写工具只产生候选或受治理命令，不直接改数据库。
6. `D6`：两阶段上下文固定为产品合同；目录召回和详情装配分别留Trace。
7. `D7`：Project/Work/Note/Memory分别拥有状态机，不用一个万能status。
8. `D8`：前端使用Project Explorer、Work Board、Knowledge、Context Inspector四个工作区投影。

实施状态：核心Schema与状态机、Query Harness、写候选/HITL提交、两阶段Context、前端4工作区和可重复的多周长测均已完成；真实模型已完成简单问答纵向回合，关键项目/学习回合的9点真实模型抽样仍作为后续持续回归矩阵执行。
