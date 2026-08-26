# Chat 项目管理四场景纵向推演

> 本文是类别设计压力测试，不是已执行验证报告。当前真实来源与实现验证以
> [Chat 项目管理三真实项目验证](./project-management-three-real-project-validation.md)为准；学习和个人日报尚未获得真实项目证据。

> 文档类型：产品行为推演与首版验收样本
>
> 推演日期：2026-08-25
>
> 上位规范：[Chat 全项目生命周期管理蓝图](./project-management-system-blueprint.md)
>
> 目的：用 Chat、Content Lab、AI 学习和个人日报证明同一个项目管理内核可以覆盖不同对象、时间、资源、证据和用户视图，且不依赖某个固定前端

## 1. 推演方法

四个场景都必须走完同一条协作链，而不是只比较字段：

```text
用户输入
→ 识别 Project / Need / Authority
→ 形成可审核的 Requirement / Scope / Work / Plan
→ Agent 恢复 Project Opening 与 Work Execution Context
→ 读取受管 Resource，Claim 并执行
→ 记录 Activity、Artifact Revision、Event 与 Evidence
→ 用户通过合适的 View 观察、修订、审核或决定
→ 达到各自的 Acceptance / Outcome Gate
→ 形成 Case / Lesson / Practice Candidate
→ 在下一次工作或时间触发中继续维护
```

每个场景逐项验证：

1. **用户结果**：用户真正想得到什么，而不是想创建多少事项；
2. **对象拆解**：哪些是 Need、Work、Artifact、Evidence、Knowledge、Decision 和时间事实；
3. **事实所有权**：Chat、Git、文件、数据库和外部平台各自拥有什么；
4. **Agent 恢复**：旧 Session 消失后，从什么稳定入口恢复最小充分上下文；
5. **维护循环**：什么事件或时间触发观察、提醒、复盘和下一步；
6. **用户呈现**：用户需要看文字、图片、代码、时间线、关系或报表中的哪些信息；
7. **完成与学习**：什么证据可以推进状态，什么经验可以进入下一版方法。

推演中的 DSH、代码编辑器、文档查看器、媒体工具、事项工具和报表工具都只是某种能力的可能实现。若更换表面，以下对象、事件、Revision、Authority 和 Evidence 不应改变。

## 2. 场景一：Chat 软件开发与自举

### 2.1 用户输入

用户在 8 月 25 日对 Codex 说：

> 给 Chat 增加 Browser Provider。先基于真实上游能力做复用决策；用独立 worktree；不得让浏览器拥有产品事实；完成后我要看到代码、设计、测试、真实界面结果和后续风险。

这句话产生一个 `Need`，不是立即完成的 Work Item。理解阶段至少拆出：

| 对象 | 例子 |
|---|---|
| Need | 用户需要 Chat 具备受治理的浏览器能力 |
| Requirement | 能打开、读取和操作授权页面；凭据不进入模型或浏览器投影；失败可恢复 |
| Constraint | 先审计上游；不自研浏览器；独立 worktree；不得绕过 Application |
| Scope | 当前纵向包含 Provider Port、一个真实场景、DSH 入口和验证 |
| Non-goal | 不实现通用 RPA 平台，不复制浏览器 UI |
| Work | 上游决策、合同、Adapter、Application 用例、DSH 表面、E2E、文档 |
| Dependency | 上游证据与权限合同先于 Adapter；合同先于 UI |
| Acceptance | 真实页面纵向、权限/恢复测试和用户审核均通过 |

Agent 可以提出拆解 Candidate，但只有用户当前授权和有权 Decision 能形成 `Commitment`。

### 2.2 Agent 怎样恢复

Codex 新开 Session 后不靠上一次聊天摘要猜测。Resolver 用稳定 Binding 找到 Chat Project 和当前 Work，Application 编译：

```text
Project Opening Context
├── Chat Project ID、目标、生命周期与当前 Profile/Configuration Revision
├── 用户与 Codex Authority、当前承诺和 Workspace Attention
├── 当前 Work、依赖、风险、未决 Decision 与 Claim
├── Resource Map：Chat、Pi Fork、DSH Fork、治理文档、运行实例
└── Required Reads 路标

Work Execution Context
├── Browser Provider Requirement、Scope、Non-goal、Acceptance
├── 相关技术合同和上游研究证据
├── 当前 worktree/branch、基线 Commit 与 dirty 状态
├── 相关 Artifact Revision、已有测试和未决 Operation
└── 允许动作、需要用户决定的动作和 Evidence Gate
```

仓库内 `AGENTS.md`、项目状态、技术合同和任务相关 as-built 仍是 Resource 内容；Context 保存路标、Revision、Hash、适用原因和预算，而不是复制全文。

### 2.3 三天的推进与历史

| 时间 | Activity / Event | Artifact / Revision | 用户可见结果 |
|---|---|---|---|
| 8 月 25 日 | Codex Claim；审计两个候选 Provider；提交复用决策 | 研究记录 r1、Decision Candidate d1 | Project Home 显示“塑形中”；Decision View 可比较候选 |
| 8 月 26 日 | 用户采用窄 Adapter；Codex 建 worktree；实现合同与 Application | 合同 r1、代码 Commit c1、测试 Evidence e1 | Work Detail 显示范围、变更、测试和风险；Code View 可看 Diff |
| 8 月 27 日 | 真实 E2E 发现登录态恢复缺陷；Work 进入 Blocked；修复后复测 | 缺陷 Issue i1、代码 c2、E2E e2、Handoff h1 | Timeline 显示失败而非把 c1 当成功；Review View 展示 c1→c2 差异 |

同一个文件修改 4 次时，Git 拥有文件和 Commit 历史；Chat 保存相关 `ArtifactRef`、Work 关系、关键 Revision、验证结果和采用 Decision。用户能从 Work Detail 打开最终 Diff，也能沿 Timeline 看见为什么修改，而不要求 Product Store 保存完整代码。

### 2.4 完成、交接与知识演进

以下单独发生都不能完成 Work：

- 外部事项卡片被拖到 Done；
- Agent 说“完成了”；
- worktree 中有代码；
- 某次测试通过；
- 已生成 Commit。

Profile 的 Gate 要求：Requirement 逐项有 Evidence、根级质量门通过、真实浏览器场景通过、风险与迁移说明存在、具有 Authority 的用户或审核者确认 Acceptance。完成后：

1. Work 形成已验收 Outcome；
2. Commit、测试、E2E、Decision 成为可追溯 Evidence；
3. Handoff 说明未做事项、已知风险和下一次观察点；
4. “登录态恢复必须作为 Browser Provider 合同测试”成为 Lesson Candidate；
5. 用户采用后生成 Browser Provider Practice 新 Revision，后续 Work 的 Context 自动包含它。

### 2.5 用户需要的视图

| View | 用户要回答的问题 |
|---|---|
| Project Home | Chat 当前目标、版本、健康、承诺、待决定和最近变化是什么？ |
| Work Board/List | 哪些功能、缺陷、研究或审核正在做，谁在做，卡在哪里？ |
| Requirement / Decision | 为什么做、范围是什么、哪种方案被采用、还能否修订？ |
| Code View | 改了哪些仓库、文件和 Commit，Diff 是什么？ |
| Document View | 技术合同、研究、迁移和 as-built 写了什么？ |
| Test / Report | 哪些门通过，哪些未运行，趋势和失败原因是什么？ |
| Timeline | 计划、实际、失败、修复、审核和发布按时间怎样发生？ |

这些 View 可由 DSH、代码工作台或其他表面分别实现；核心只要求信息与动作合同。

## 3. 场景二：Content Lab 内容生产与方法演进

### 3.1 用户输入

用户在 8 月 25 日发送一个 YouTube URL：

> 把这个视频做成中文内容，面向刚开始使用 AI Agent 的人。先做小红书图文，我审核后再发布。上次文案太像摘要，这次需要有自己的结构和案例。

系统不把 URL 直接变成“待办完成度 0%”，而是区分：

| 对象 | 例子 |
|---|---|
| Source / Need | YouTube URL、目标读者、渠道意图、用户补充要求 |
| Content Work | 选题采用、转录、理解、结构、中文稿、图片、QC、审核、发布 |
| Artifact | 原字幕、整理稿、文案、图片、发布包；每种都有 Revision |
| Decision | 是否采用选题、选择哪个结构、是否发布 |
| Evidence | 来源快照、QC 结果、用户审核、发布平台回执、表现 Observation |
| Case | 该内容的策略、反馈、结果、适用条件和失败点 |
| Practice | “从摘要到原创结构”的内容工作法 Revision |

Source 的存在不等于已承诺生产；文案完成不等于已发布；发布回执不等于方法已经证明有效。

### 3.2 Agent 怎样恢复并执行

第一个 Agent 获得：目标受众、渠道要求、Source、当前内容 Work、用户反馈、采用中的 Practice Revision、可用媒体能力、Artifact 预算和发布 Authority。它读取源字幕和相关案例，而不是递归扫描整个媒体目录。

Agent A 生成转录和中文结构草稿后 Handoff。第二天 Agent B 接手时，Delta Context 包含：

- Source Revision 未变化；
- 结构稿从 r1 改为 r3，r2 因用户反馈“仍像摘要”被拒绝；
- 图片 1 已完成，图片 2 缺少事实依据；
- 发布仍需用户 Decision；
- 当前 Claim、剩余 Work、相关案例和 QC Gate。

Agent B 不需要读取 Agent A 的完整聊天，也不会把 r2 当当前稿。

### 3.3 从生产到发布的时间线

| 时间 | 事实 | 维护动作 |
|---|---|---|
| 8 月 25 日上午 | Source 被捕获，用户采用选题 | 建立 Content Work，关联目标读者和渠道 |
| 8 月 25 日下午 | 转录 r1、中文结构 r1、文案 r1 | 记录 Provenance：哪些 Activity 使用了哪个 Source/Practice |
| 8 月 25 日晚 | 用户拒绝文案 r1，说明“缺少自己的判断” | Review 绑定 r1；形成修改 Requirement，而非覆盖历史 |
| 8 月 26 日 | 文案 r2、6 张图 r1、QC 通过 | Review View 展示正文和图片；发布仍未授权 |
| 8 月 27 日 | 用户批准发布；平台返回稳定发布 ID | Publication 进入 Published，回执成为 Evidence |
| 9 月 3 日 | 定时观察互动表现；用户评价转化质量 | 更新 Metric Observation；触发 Case Review |
| 9 月 5 日 | 用户采用一条经验 | Practice 从 p3 升级到 p4，旧内容仍绑定 p3 |

### 3.4 资源和存储

| 内容 | 权威所有者 | Chat 保存 |
|---|---|---|
| 字幕、中文稿、发布文案 | Content Lab 文件或内容数据库 | ArtifactRef、Revision、Hash、类型、关系 |
| 图片与视频 | 媒体目录/对象存储 | URI、元数据、预览能力、来源与 Evidence |
| 平台发布对象和指标 | 小红书等发布平台 | 外部 ID、发布回执、有限 Snapshot、Observation 时间 |
| Work、Decision、Review、Practice 采用 | Chat Product Store | 完整版本化产品事实 |
| Work 看板投影 | Work Tracking Provider | Binding、Projection、同步健康和外部 Revision |

如果当前采用外部事项表面，用户可以在那里看生产和审核事项；如果以后 DSH 自己提供 Board，核心 Work 不迁移、不复制。文案与图片也不能因为 Work Tracker 不适合展示正文而被塞进事项描述。

### 3.5 用户需要的视图

- Project Home：本周内容目标、正在生产、待审核、已发布、风险和最近表现；
- Content Pipeline：每条内容从 Source、Draft、Review 到 Published 的状态和责任；
- Document View：当前中文稿、历史 Revision、逐条 Review 和来源；
- Media View：封面、图片序列、视频片段和发布预览；
- Publication Timeline：昨天、前天、上周发布了什么，哪个渠道、哪个版本；
- Case Library：成功/失败案例、策略、适用条件、反馈和关联 Practice；
- Report：发布量、返工、审核周期、表现趋势及数据窗口，不用数量冒充内容质量；
- Practice View：当前工作流、历史 Revision、为什么修改、哪些案例支持采用。

## 4. 场景三：四个月 AI 学习与转职目标

### 4.1 用户输入

用户在 8 月 25 日说：

> 四个月后我要转到更好的 AI 工程岗位，目标薪资上涨 50%。我能写普通后端，但数学、LLM 训练、Agent 工程和系统设计掌握不均。请和我一起制定计划，每周推进，并用真实练习验证，不要因为我读完课程就算掌握。

目标具有期限，但“工资上涨 50%”受市场和面试等外部因素影响。Project 需要分离：

- `Objective`：在目标日期前达到目标岗位可竞争状态；
- `Outcome Metric`：目标岗位面试表现、作品质量、邀约/Offer 与薪资结果；
- `Competency`：数学基础、模型原理、应用工程、Agent、系统设计、表达；
- `Gap Observation`：基线测评暴露的具体缺口及置信度；
- `Learning Work`：课程、阅读、练习、开源贡献、项目和模拟面试；
- `Knowledge Artifact`：笔记、解释、代码、错题、复习卡和作品；
- `Assessment Evidence`：闭卷回忆、独立实现、迁移应用、面试反馈；
- `Review Schedule`：间隔复习、每周承诺、月度目标检查。

### 4.2 第一周如何运行

| 日期 | 事件 | 结果 |
|---|---|---|
| 周一 | Agent 用职位样本和用户目标形成 Competency Map Candidate | 用户修订并采用 c1；不是自动真相 |
| 周二 | 完成基线题和一次系统设计讲解 | 产生 Assessment a1，确认 3 个 Gap |
| 周三 | Agent 提议 7 项学习任务 | 用户只承诺本周 3 项，其余仍是 Candidate |
| 周四 | 阅读 Attention is All You Need 并写笔记 | 只有 Knowledge Artifact；Competency 未自动 Mastered |
| 周五 | 不看笔记解释 attention 并修改一个小模型 | Evidence e1 暴露 mask 理解错误，状态进入 Revisit |
| 周日 | 周 Review 比较计划/实际、错误和精力 | 调整下周 Work；安排 3 天后复习；形成 Lesson Candidate |

Agent 在周五新开 Session 时读取当前目标期限、Competency Map Revision、最近 Assessment、错题、到期 Review、已承诺 Work 和 Evidence Gate；它不会只因为看到“课程已完成”就跳过验证。

### 4.3 掌握、遗忘和复习

`Mastered` 是有时效和层级的判断，不是永久布尔值。Profile 可以定义：

```text
unassessed → gap → planned → learning → practicing → validate
                                              ├── mastered
                                              └── revisit
```

每次 Mastered 记录：Competency Revision、验证方式、难度、Evidence、评估者、发生时间、下次 Review 时间和置信度。后续复习失败不会删除历史掌握，而是产生新 Assessment 和当前 `revisit` 状态。用户能看见“曾经会、何时开始遗忘、在哪类问题上失误”。

### 4.4 资源和用户视图

学习资料、课程页面、书、论文、笔记、练习仓库和模拟面试记录各自保存在合适资源中；Git 只管理代码和声明为版本化的文本，不强制管理所有视频或平台数据。Chat 保存关系、Revision、Evidence 和观察。

用户需要：

| View | 回答的问题 |
|---|---|
| Goal Roadmap | 距目标日期还有多久，各阶段目标和风险是什么？ |
| Competency Matrix | 哪些能力是 Gap、Practicing、Mastered 或 Revisit，证据是什么？ |
| Calendar/Timeline | 本周承诺、复习到期、测评和面试安排是什么？ |
| Knowledge View | 读了哪些书/课程/论文，笔记和代码在哪里，它们关联什么能力？ |
| Assessment Report | 分数、错误类型、迁移能力和模拟面试反馈怎样变化？ |
| Portfolio View | 哪些代码项目、文章和贡献可以证明能力？ |
| Weekly Review | 实际投入、掌握变化、遗漏、计划调整和用户决定是什么？ |

### 4.5 完成和方法学习

课程完成只完成一个 Learning Activity；独立实现和解释可以成为能力 Evidence；目标 Project 的最终结果还需要按用户采用的成功标准审核。Agent 可以出题、评价和提出 Mastered Candidate，但不能独立确认用户已掌握或薪资目标已达成。

若连续三周发现“先做项目再回补原理”比线性读课更有效，这是一条带适用条件和反例的 Learning Practice Candidate。用户采用后生成新 Profile/Configuration Revision，不倒改前两周历史。

## 5. 场景四：个人日报与跨项目复盘

### 5.1 用户输入和低摩擦捕获

用户一天中说：

1. “上午把 Content Lab 的那篇稿改完了，晚上还要看最终图片。”
2. “突然想到 Chat 可以给 Project Home 加一个 Attention 区，先记一下。”
3. “下午状态不好，只读了 20 页书。”
4. “明天 10 点提醒我复查发布数据。”

系统不能把 4 条消息都自动变成 Work。它们分别可能是：

| 输入 | 初始对象 | 后续政策 |
|---|---|---|
| 已完成修改 | Daily Event + Content Lab Work 引用 | 观察资源和 Work 状态，不能靠日记完成 Work |
| 新想法 | Capture / Need Candidate | 周 Review 时决定丢弃、孵化或关联到 Chat |
| 学习记录和感受 | Daily Entry + AI 学习 Activity 引用 | 记录实际时间与主观状态，不自动判定失败 |
| 明天复查 | Action Candidate + dueAt | 用户确认后成为承诺或提醒；需时区和触发政策 |

### 5.2 一天、七天和一个月

**每日收尾**编译当天 `occurredAt` 窗口内的 Event、用户原始记录、跨 Project 引用、未决 Candidate 和到期 Action。Agent 起草摘要，用户可以修订；摘要保存 Revision，原始记录保持来源和隐私级别。

**每周复盘**不拼接 7 篇日报，而是查询：

- 各 Project 本周 Outcome、Blocked、待审核和重要 Decision；
- 计划与实际时间差；
- 新增、采用、滚动和放弃的 Action；
- 用户标记的精力/情绪 Observation；
- 反复出现的摩擦、Idea 和可能的 Lesson。

**月度观察**可以展示趋势，但不得把“记录次数”“完成事项数”直接解释成生产力或成长。Metric 必须说明窗口、来源、缺失数据和解释边界。

### 5.3 跨日、滚动和历史

Action 未完成时不复制成第二条“明日事项”，而是保留稳定 ID，记录 `plannedEnd` 变化和 Roll-over Event。跨时区旅行时，Daily Window 使用 Project Configuration 的时区 Revision；时区变化本身是 Event，旧日报不重新切日。

Idea 被用户采用为 Chat 的 Need 时：

1. Daily Project 保留原 Capture 与发生时间；
2. Chat Project 创建稳定 Need，并用来源关系指向 Capture；
3. 两个 Project 不复制后续状态；
4. 日报只通过 Query 显示“已转入 Chat / 当前尚未承诺”。

### 5.4 隐私和 Authority

- 原始日记默认只对用户和明确授权的 Agent Context 可见；
- 跨项目摘要只能引用允许暴露的字段，不能复制私人正文；
- Agent 可分类、起草摘要、建议 Action 和提醒；
- Agent 不得擅自公开、删除、改变隐私或把全部想法转成任务；
- 分享版周报是新的 Artifact Revision，需要用户 Decision，不等于内部周报。

### 5.5 用户需要的视图

- Today：今日原始记录、事件、承诺、待确认 Candidate 和晚间收尾；
- Timeline/Calendar：过去发生了什么、未来有什么期限和复习；
- Document View：日报与周报正文、历史 Revision 和修订来源；
- Attention：跨 Project 的待决定、待审核、Blocked、过期与同步异常；
- Trend Report：时间、节奏、计划偏差和用户自定义观察；
- Relation View：一条记录怎样关联 Content Lab 发布、Chat Need 或学习 Activity；
- Privacy View：哪些内容对哪些 Participant/Context 可见。

## 6. 四场景共同内核与差异归属

| 维度 | Chat | Content Lab | AI 学习 | 个人日报 | 应放在哪里 |
|---|---|---|---|---|---|
| 核心结果 | 可验收软件 | 可发布内容与方法改进 | 可证明能力提升 | 可持续记录与复盘 | Profile |
| 主要 Artifact | 代码、合同、测试 | 文案、图片、发布包 | 笔记、练习、作品 | 原始记录、日报、周报 | Profile + Resource |
| 时间模型 | 开发周期、Release | 生产批次、发布、效果窗口 | 目标日期、周计划、间隔复习 | 每日、每周、月度 | Profile Time Policy |
| Agent 不可决定 | 高影响采用/发布/完成 | Published、Practice Adopted | Mastered、目标达成 | 公开、删除、全部转 Work | Authority + Gate |
| 完成 Evidence | Commit、测试、E2E、验收 | QC、审核、发布回执 | 测评、独立应用、反馈 | 来源、复盘决定、后续结果 | Profile Evidence Policy |
| 主要 View | Code、Work、Decision、Test | Document、Media、Pipeline、Report | Roadmap、Matrix、Calendar、Assessment | Today、Timeline、Report、Relation | View Requirement |
| 长期知识 | 架构、故障和工程 Practice | 案例与内容工作法 | 知识、错题和学习方法 | 个人模式与复盘 Lesson | Knowledge / Practice |

四者必须共享：稳定 Project/Object ID、Revision、Event、Participant/Authority、Need 与 Commitment 分离、Work 协调、Resource/Artifact 引用、Decision、Evidence、Provenance、Context、View Requirement、Maintenance Activity 和 Provider Operation。

## 7. 反例测试：出现以下情况说明设计仍然过窄

1. 文档只能通过 Obsidian 找到，而 DSH 或未来 Document View 无法消费同一 Artifact；
2. 没有外部事项工具就不能创建或推进 Work；
3. 所有项目都必须有 Git Commit 才能完成；
4. AI 学习必须伪装成 Feature/Bug，日报必须伪装成 Backlog；
5. Work Tracker 不支持媒体或关系图，系统就丢弃图片、来源和 Provenance；
6. 用户只能看到当前状态，看不到昨天、上周和历史 Revision；
7. 新 Agent 必须读取完整仓库、全部日记或旧 Session 才能开工；
8. Agent 产出文件后自动将项目标为完成；
9. Profile 变化直接重写旧历史；
10. 每个新项目类型都要修改核心 Router、Store 或新增一套控制面。

## 8. 首版可执行验收

首版不是同时做完所有理想界面，而是让四个场景各跑一条真实最小纵向：

1. **Chat**：一个真实开发 Work 从 Need、Claim、Git Artifact、测试、Review 到 Acceptance，并跨 Agent/Session 恢复；
2. **Content Lab**：一个真实 Source 从采用、生产、多 Revision 审核到发布回执，再形成 Case/Practice Candidate；
3. **AI 学习**：一个真实 Gap 从基线、练习、测评到 Mastered/Revisit，并生成下次 Review；
4. **个人日报**：连续 7 天捕获、每日收尾、跨项目引用、Action 滚动和周报修订；
5. 至少用两种不同 Presentation Capability 显示同一 Project，且更换一个表面不改变权威对象；
6. 至少移除或断开一个 Provider，证明 Project、Artifact 入口和历史仍能恢复；
7. 用一个不交付的第五 Profile Fixture 证明新增类型无需按名称修改通用 Router/Store；
8. 汇总四条纵向的摩擦，只把跨场景反复出现的问题升级为内核规则。

这些验收结果决定 v1 的 Profile、Configuration 和 View Requirement Revision。未通过项进入明确的 Issue/Block 或下一版候选，不能用“框架已经搭好”替代真实使用效果。
