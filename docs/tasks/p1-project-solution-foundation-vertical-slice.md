# P1 Project Solution 基础纵向任务书：对话建项、真实资源与项目账本

| 项目 | 内容 |
|---|---|
| 状态 | 目标重构草案，待用户审核；批准前不得实现 |
| 核心目标 | 帮助不会管理项目的用户，仅靠对话建立、理解、维护并逐步推进多个真实项目 |
| BMAD定位 | 项目方法输入之一；吸收阶段、Work、Artifact、质量门和Correct Course，不复制BMAD产品形态 |
| 本次用户结果 | 用户用一句话和真实工作区建立Project；Chat观察代码、文档与脚本，生成可修改候选；确认后形成可恢复的项目账本和管理页面 |
| 交付方式 | 1个完整纵向PR；内部检查点不能作为半成品交付 |
| 技术链 | 真实对话→qwen候选→只读Resource Adapter→用户确认→Product Store v4→Portfolio/Project UI→真实E2E |
| 下一任务 | Project Progress Workflow：组织项目上下文、规划下一Work、执行真实资源动作、验证并回写项目事实 |

## 1. 最终产品目标

Chat最终要提供一套完整的Project Solution，而不是一套项目表单。它必须在任何时刻基于证据回答：

1. 用户有哪些项目，各自在解决什么问题？
2. 每个项目包含哪些代码、文档、脚本、服务和外部资源？
3. 项目目前处于什么状态，健康度、重点、阻塞和风险是什么？
4. 现在谁在做什么，使用的是人、Agent还是自动化？
5. 谁改了什么，修改落在哪个资源版本、Commit、PR或产物上？
6. 做过哪些决定，为什么决定，谁确认，后来是否被替代？
7. 有哪些Work和具体待办，依赖、负责人、验收标准与下一步是什么？
8. 项目应该如何继续推进，完成后如何验证和维护一致性？

最终运行闭环是：

```text
用户只用自然语言表达意图
→ Chat定位或建立Project
→ Observe真实项目资源
→ 恢复项目账本与当前状态
→ 结合项目方法选择下一步
→ pi提出计划或项目变更候选
→ 用户修改/确认
→ Workflow执行真实动作
→ 验证代码、文档、脚本、测试或服务结果
→ Reconcile真实资源与项目事实
→ 记录参与者、贡献、决定、证据、待办和下一步
```

本任务只交付这个最终方案的第一个完整用户闭环：**对话建项、真实资源观察、项目账本和管理查询**。它不是全部Project Solution，但也不能只是Schema或CRUD。

## 2. Project的产品定义

Project定义为：

> 围绕一个长期目标，把真实资源、参与者、工作、决定、贡献、证据和推进方法组织在一起，并可跨会话持续观察、维护和推进的用户工作边界。

### 2.1 Project不等于什么

1. 不等于一个聊天Session；多个Session可以推进同一Project。
2. 不等于一个Git仓库；一个Project可以包含多个仓库、文档、脚本和服务，一个仓库也可能服务多个Project。
3. 不等于BMAD目录；文件位置不是权威状态机。
4. 不等于待办列表；Todo只是项目执行的一部分。
5. 不等于Agent Run；Agent只是在某个Work中贡献的参与者。
6. 不等于项目管理看板；UI只是Project事实的投影与控制面。

### 2.2 Project拥有的稳定事实

```text
Project
├─ Definition       目标、范围、成功标准、方法
├─ Resources        仓库、目录、文档、脚本、服务、外部系统
├─ Participants     用户、Agent、自动化及其项目角色
├─ Work             可交付工作、状态、依赖、验收标准
├─ Actions          当前具体待办、负责人、截止/阻塞
├─ Decisions        问题、选项、选择、理由、确认者、影响
├─ Contributions    谁在何时改了什么、关联Work与资源版本
├─ Evidence         Commit、PR、测试、Trace、Artifact、部署证据
└─ Observations     某一时刻真实资源的版本化观察结果
```

Project Query根据这些事实生成当前阶段、健康度、活动Work、阻塞和下一步投影；浏览器和模型都不能自己维护第二套状态。

## 3. 我们为什么参考BMAD

固定源码证据：

```text
/Users/xulater/Code/reference-agent-sources/BMAD-METHOD-v4.44.3
commit 4c4f6dc8534f95427e66e122ac5de47ac51b5f94
tag v4.44.3
```

BMAD为Chat提供经过真实项目使用验证的输入：

| 输入 | 源码证据 | Chat吸收 | Chat调整 |
|---|---|---|---|
| 绿地规划链 | `docs/user-guide.md`、greenfield workflows | Brief→需求→方案→实现→Review的阶段与Artifact关系 | 阶段不是所有项目唯一流程 |
| 棕地分流 | brownfield workflows、`working-in-the-brownfield.md` | quick/focused/major按影响范围选择负担 | 不把估时写成硬规则 |
| Story/Work | `story-tmpl.yaml`、`create-next-story.md` | 负责人、AC、任务、测试、前序经验、来源 | Work不局限软件Story |
| 就绪检查 | `validate-next-story.md` | 来源、依赖、结构、测试、安全与GO/NO-GO | LLM判断只形成候选，Domain提交事实 |
| 质量门 | `qa-gate.md`、DoD checklist | 可解释PASS/CONCERNS/FAIL、问题与证据 | Chat质量门绑定真实对象版本 |
| 方向纠偏 | `correct-course.md`、change checklist | 影响分析、具体修改、用户批准 | 转成版本绑定ProjectChangeProposal |
| 文档配置 | `core-config.yaml` | 按角色组织项目Artifact | 不固定目录，不复制整套文档正文 |

BMAD不负责Chat的资源Adapter、多人/Agent贡献账本、耐久Workflow、跨会话Memory、多项目组合和权限，这些由Chat自己的架构负责。

### 3.1 其他输入的责任

实施前每个模块必须写明证据来源，不能只写“参考优秀项目”：

1. Git/GitHub语义为资源版本、Commit、PR、作者和变更证据背书。
2. 当前Chat Product Store为权威事实、CAS、幂等和历史回放背书。
3. Vercel Workflow为耐久步骤、暂停、恢复和Checkpoint背书。
4. pi源码为Agent节点、Provider、模型事件和工具调用边界背书。
5. Memory项目只提供召回与长期知识，不拥有Project当前状态。
6. 仓库内Basecamp/Things Today研究只为项目组合与“当前需要处理什么”的交互提供输入，不替代Domain事实。

## 4. Project Solution的管理手段

### 4.1 建立：Intake

用户可以说：

> 把 `/Users/xulater/Code/Chat` 建成“Chat产品”项目，目标是做成长期运行的Agent产品。

Chat必须：

1. 解析目标和资源定位，生成`ProjectIntakeCandidate`，不直接创建Project。
2. 使用Resource Adapter只读观察真实工作区。
3. 识别Git状态、主要文档、可用脚本、测试与项目结构。
4. 根据证据建议项目类型、BMAD profile或轻量方法，并解释理由。
5. 生成初始范围、成功标准、参与者、Work和Action候选。
6. 在前端展示可修改候选。
7. 用户确认后，一次事务提交Project及全部初始事实。

### 4.2 管理：Portfolio与Project Ledger

用户可以问：

> 我有哪些项目？谁在做？还有哪些待办？

系统从Project事实生成：

- 项目目标、状态、最近活动和健康度。
- 当前负责人、Agent和自动化正在处理的Work/Action。
- 最近贡献、决定和真实资源变化。
- 阻塞、风险、等待用户确认的候选。
- 按依赖和项目方法计算的下一步，不让模型凭印象编造。

### 4.3 维护：Observe与Reconcile

维护不是改一个`status`。标准循环是：

```text
读取Resource
→ 保存不可变Observation
→ 与上次Observation和Project事实比较
→ 形成Drift/Maintenance Candidate
→ 用户确认
→ 更新Project事实或安排Resource Action
```

必须能表达：PR已合并但Work未完成、文档Hash变化、脚本消失、测试失败、仓库HEAD变化、新资源出现、项目记录引用旧版本等场景。

P1先实现真实Observe和人工触发刷新；自动定时维护、写资源和执行脚本属于后续任务。

### 4.4 推进：Plan、Execute、Verify、Commit

最终推进手段是：

1. 选择Project和当前Work。
2. Context Builder只选当前阶段真正相关的Resource、Decision、Memory和Rules。
3. pi规划下一步，用户修改/批准。
4. Workflow调用具备明确能力的Resource Adapter修改代码、文档或运行脚本。
5. 验证结果并生成Contribution、Evidence和项目更新候选。
6. 用户确认后更新Work/Action/Decision/Project状态。

这部分在下一纵向任务实现；P1必须先把对象、真实资源观察和用户入口设计成可直接承接它，而不能预埋空Workflow或假执行结果。

## 5. 参与者、贡献、决定和待办

### 5.1 `ProjectParticipant`

项目内的稳定参与身份，类型为：

- `human`：用户或协作者。
- `agent`：Codex、Kimi或其他Agent产品身份。
- `automation`：CI、定时任务、部署器。
- `external`：无法认证但需要记录的外部参与方。

保存项目角色、显示名、能力范围和有效状态。Agent参与记录可以保存安全的Agent/profile/model版本，但不得暴露pi Session ID、Workflow Run ID或密钥。

### 5.2 `ProjectWork`与`ProjectAction`

`ProjectWork`表示有明确交付结果的工作单元：目标、AC、依赖、风险、状态和当前负责人。

`ProjectAction`表示具体下一行动/待办：动作、关联Work、负责人、状态、阻塞、可选截止时间和完成证据。Action不能代替Work的交付语义，也不能只保存在聊天正文里。

软件Work默认吸收BMAD状态：`draft→approved→in_progress→review→done/cancelled`；轻量项目使用更短状态。Action使用`todo→doing→blocked→done/cancelled`。

### 5.3 `ProjectContribution`

不可变记录“谁实际做了什么”：

- participantId、projectId、workId/actionId。
- `kind: analysis | code | document | script | review | test | deployment | coordination`。
- 用户可读摘要。
- 受影响Resource的before/after revision、Hash或Git引用。
- 关联Product Run、Artifact、Commit、PR、Test或Trace证据引用。
- 时间与来源。

模型说“我改了”不是证据。能从Git、Workflow、测试或Artifact核验时必须核验；无法核验时标记`reported`而不是`verified`。

### 5.4 `ProjectDecision`

不可变记录：

- 决策问题和上下文。
- 考虑过的选项。
- 最终选择和理由。
- 决策者/批准者。
- 受影响Project/Work/Resource/Document。
- 绑定的revision与Hash。
- `active | superseded | revoked`及替代关系。

“不做前端”“由Kimi实现、Codex评审”“服务器不编译”等内容只有在用户确认并提交Decision后，才能成为项目权威事实。

### 5.5 `ProjectActivity`是读模型

项目时间线由Work/Action转换、Contribution、Decision、Observation和Workflow产品事件组装，不再持久化一份万能Activity正文。这样避免同一事实写两遍后漂移。

## 6. Product Store与Trace的分工

| 来源 | 保存内容 |
|---|---|
| Product Store | Project、Resource、Participant、Work、Action、Contribution、Decision、Observation及用户正文 |
| Git/外部系统 | 文件正文、Diff、Commit、PR、脚本结果、部署对象等真实资源事实 |
| Trace | 代码路径、状态转换、调用关系、对象引用、Hash、耗时、错误 |
| Workflow Store | 耐久步骤、Checkpoint、Hook等待/恢复 |
| Project Timeline Assembler | 按引用组装“谁在何时因为什么做了什么” |

Trace不能复制目标、决定理由、Contribution摘要、文档正文、Diff、URI或命令Body。项目审计正文属于Product Store，系统诊断属于Trace。

## 7. P1必须交付的完整用户闭环

### 7.1 本任务范围

1. Project、Resource、Participant、Work、Action、Contribution、Decision、Observation strict合同。
2. `ProjectResourcePort`及第一批真实只读Adapter：
   - `local-git-workspace.v1`：允许根目录内的Git HEAD、branch、status、tracked file manifest和recent commits。
   - `project-document-manifest.v1`：识别项目治理/产品/架构/任务文档的路径、revision evidence和Hash。
   - `package-script-catalog.v1`：从受支持manifest读取脚本名称和用途；P1禁止执行任意脚本。
3. 服务端Resource Registry、允许根目录和安全locator合同；浏览器不能提交任意绝对路径直接读取服务器。
4. 真实百炼`qwen3.7-plus`的Project Intake节点，输出严格`ProjectIntakeCandidate`。
5. 候选修改/确认：模型输出不能直接成为Project事实。
6. 确认后原子创建Project、初始Resources、用户Participant、初始Work/Action、建项Decision和首个Observation。
7. 对话式管理命令候选：新增/分派待办、记录决定、记录已发生贡献、刷新Observation。
8. 项目列表、详情、参与者、资源、Work/待办、决定、贡献和时间线的响应式UI。
9. Product Store v3→v4迁移、CAS、幂等、完整性与损坏失败关闭。
10. 真实API、真实Resource、真实模型和浏览器E2E。

### 7.2 明确不做

1. P1不写代码/文档、不运行项目脚本、不调用部署或Git push。
2. 不把服务器全部文件系统暴露给Chat；只允许配置的资源根和已确认Resource。
3. 不自动定时扫描；用户或后端管理动作显式触发Observe。
4. 不实现Project Context到现有PlanningExecutionWorkflow的完整注入。
5. 不实现真实Resource副作用、结果未知对账或自动提交PR。
6. 不实现Correct Course、完整质量门、Rules或主动提醒。
7. 不让用户为了使用基础能力必须理解BMAD术语。

## 8. 第一个纵向场景

```text
用户在真实Chat输入：
“把Chat仓库建成一个项目，目标是持续开发Chat产品，先告诉我目前谁在做什么、有哪些待办。”

→ Message Command创建Product Run
→ Project Intake节点调用真实qwen3.7-plus
→ 模型只生成Intake意图候选
→ local-git/document/script Adapter观察真实仓库
→ Application将模型候选与资源证据编译成ProjectIntakeCandidate
→ Workflow等待用户确认
→ 前端展示目标、范围、方法、资源、参与者、Work/Action和证据
→ 用户修改/确认
→ Product Store原子提交全部Project事实
→ 页面显示项目当前状态、参与者、最近变化、决定和待办
→ API重启/新Session后仍能恢复
```

随后用户说：

> 记录决定：BMAD只是参考，核心目标是帮助用户管理和推进多个真实项目。

系统生成绑定当前Project revision的Decision候选，用户确认后进入Decision Register和Timeline。

## 9. Resource Adapter边界

```ts
interface ProjectResourcePort {
  describe(): ProjectResourceCapabilities;
  observe(input: ObserveProjectResourceInput): Promise<ProjectResourceObservation>;
}
```

P1只冻结所有首批Adapter都真实支持的`observe`，不提前加入假的`write/execute`方法。未来副作用使用独立能力接口和Workflow节点。

安全要求：

1. 服务端配置允许资源根；locator规范化后必须仍位于允许根。
2. 拒绝`..`逃逸、符号链接逃逸、NUL、凭据化URL和未知scheme。
3. 默认忽略`.env`、密钥、凭据、依赖目录、构建产物和大文件。
4. Git命令参数使用固定argv，不经过shell字符串拼接。
5. Observation限制文件数量、字节预算、提交数量和耗时；超预算失败可解释。
6. 不读取未声明正文到Trace；进入模型的摘要必须有Manifest和预算。

## 10. 领域规则

1. 所有模型产物先是Candidate，未经确认不得创建/修改Project事实。
2. Project名称可重复，但projectId稳定；同一Resource可被多个Project引用但权限独立。
3. Work依赖禁止自依赖、循环和未声明跨Project依赖。
4. Action负责人必须是当前Project有效Participant。
5. Contribution必须有actor、时间、关联对象和证据状态；verified必须存在可校验证据。
6. Decision必须绑定Project revision；旧revision确认返回409并保留候选。
7. Observation不可变；同一资源新观察不能覆盖旧观察。
8. Project当前状态由已提交事实投影；模型摘要、浏览器缓存和Git分支名都不能直接改状态。
9. archived Project只允许查询和显式恢复，不允许普通写入。
10. commandId同请求重放返回原结果，不同Hash失败关闭。

## 11. JSON Product Store v4

新增集合：

```text
projects
projectResources
projectParticipants
projectWorks
projectActions
projectContributions
projectDecisions
projectObservations
projectCandidates
```

Project P1占用`chat-product-store.v4`；Rules基础顺延为v5。迁移必须显式`v1→v2→v3→v4`，旧Session/Run/Memory/Import/Receipt/Outbox逐对象等值，新集合为空。

Snapshot Integrity至少校验Map key/ID、owner、Resource locator与Adapter kind、Participant引用、Work依赖、Action负责人、Contribution证据、Decision revision、Observation链和Candidate生命周期。

## 12. Application、Workflow与API

### 12.1 Application用例

- Query：listProjects、getProjectWorkspace、getProjectTimeline、getProjectCandidate。
- Command：beginProjectIntake、confirm/revise/rejectProjectCandidate、create/assign/transitionAction、recordDecisionCandidate、recordContributionCandidate、observeProjectResource、archiveProject。

不建立万能ProjectService。Resource观察发生在事务外，Observation候选带输入资源revision/Hash；提交事务内重新校验Project CAS和资源身份。

### 12.2 Workflow

新增唯一`ProjectIntakeWorkflow`或在现有定义中增加明确Project Intake入口，最终实现前必须通过源码核验选择较小方案。耐久链必须包含：真实模型候选、真实Resource Observe、候选发布、Hook等待、确认后提交。浏览器不接触Workflow ID、Hook Token或pi Session ID。

### 12.3 公开API

至少提供：

```text
GET  /api/projects
GET  /api/projects/:projectId
GET  /api/projects/:projectId/timeline
GET  /api/project-candidates/:candidateId
POST /api/project-intakes
POST /api/project-candidates/:candidateId/decisions
POST /api/projects/:projectId/actions
POST /api/project-actions/:actionId/assignments
POST /api/projects/:projectId/observations
POST /api/projects/:projectId/decision-candidates
POST /api/projects/:projectId/contribution-candidates
```

具体路径在合同实现前冻结；所有Command使用现有Command Envelope、strict Zod、Problem Detail、commandId和expectedRevision。

## 13. 统一UI

1. Chat仍是主要输入；用户可以在消息中选择现有Project或发起建项。
2. 候选确认沿用计划审核的“可读、可修改、批准/拒绝”交互，不另外发明一套审批语言。
3. 增加Portfolio入口：项目、健康度、当前负责人、活动Work、待办、阻塞和最近更新。
4. Project Workspace包含概览、资源、参与者、Work/待办、决定、贡献、时间线。
5. Timeline明确区分“用户决定”“Agent贡献”“资源观察”“系统状态转换”。
6. 手机390×844可完成建项确认、查看谁在做、记录决定和管理待办，无横向溢出。
7. UI只提交动作和显示`allowedActions`，不拥有权威Project历史。

## 14. Trace与审计

新增事件仍使用事件级strict联合：

```text
project.intake.started/candidate_published/confirmed/rejected
project.resource.observe.started/completed/failed
project.action.created/assigned/transitioned
project.decision.candidate/committed/rejected
project.contribution.candidate/committed/rejected
```

Trace只记录对象ID、revision、Hash、adapter kind、actor产品ID、耗时、outcome和errorCode。不写目标、决定理由、Contribution摘要、文件路径、Diff、Commit message、命令Body或模型正文。

## 15. 严格测试与真实完成门

### 15.1 合同/领域/Store

1. 每种Project对象合法fixture和未知字段反例。
2. Participant/Assignment、Work/Action依赖、Contribution证据、Decision绑定、Observation不可变测试。
3. Candidate确认、修改、拒绝、旧revision、并发确认和commandId重放。
4. Resource locator逃逸、符号链接、秘密路径、超预算和Git异常。
5. v1→v2→v3→v4迁移；截断、未知Schema、悬空、Hash篡改和I/O故障保持原文件逐字节不变。

### 15.2 真实Resource集成

使用临时但真实的Git仓库：创建提交、分支、文档和package scripts，验证Adapter返回真实HEAD/status/manifest/hash；不得mock child process或直接构造Observation冒充。

### 15.3 真实模型与浏览器E2E

1. 真实qwen3.7-plus从自然语言生成严格Intake Candidate。
2. 浏览器从真实Chat发送建项消息，观察真实仓库，修改并确认候选。
3. 页面显示真实Project、Resources、Participants、Work/Actions、Decision和Observation。
4. 第二条对话记录“谁负责什么”和一条项目Decision，确认后Timeline正确。
5. 两页面并发确认只有一个成功，另一个409后刷新恢复。
6. API/Workflow重启后候选或已提交Project可恢复。
7. 390×844完成核心路径。
8. Trace扫描证明没有用户正文、资源路径、Diff、密钥或Provider Payload。

缺真实Key、网络或真实Resource证据时必须报告未完成，禁止用stub降级后宣称通过。

## 16. 模块设计与质量约束

```text
packages/contracts       Project事实、Candidate、API与Trace合同
packages/domain          Project不变量、状态机、投影与候选验证
packages/application     Intake/确认/管理/Observe用例与事务
packages/project-runtime Resource Port、Registry与只读Adapters
packages/product-store-json v3→v4与Integrity
packages/workflows       Project Intake耐久链
packages/pi-runtime      严格Project Candidate Adapter
apps/api                 REST与组合根
apps/web                 Portfolio、Project Workspace、候选审核
packages/testing         真实Git fixture与E2E工具
```

1. Domain不得依赖Git、Node fs、Hono、React、Workflow或pi。
2. Adapter依赖Application Port；Router、Workflow和React不直接写Store。
3. 不建立万能ProjectService、万能Resource接口或任意metadata口袋。
4. P1只有真实observe能力；不要提前设计空write/execute实现。
5. 核心边界、不变量、安全路径和Product Store/Trace分工使用精炼中文注释。
6. 注释解释为什么，不逐行翻译代码；超大文件和多责任组件必须拆分。
7. 不新增生产依赖，除非先证明用途、许可证、退出方式和现有能力不足。

## 17. 实施与Git规则

1. 本任务书批准并合入后，从最新origin/main创建全新实现worktree/分支。
2. 实现使用1个完整PR；内部可按Contracts→Resource→Store→Application/Workflow→UI→E2E提交，但不能在中途报告完成。
3. 沿用固定端口、安全preclean、VS Code Compound和服务器不编译规则。
4. 实现PR必须完成自审、修复、全质量门、真实模型和浏览器证据后再请求用户复审。
5. 合并后同步main并删除实现分支/worktree。

## 18. 用户审核点

请用户确认以下7项：

1. Project是否采用“目标+真实资源+参与者+工作+决定+贡献+证据”的定义。
2. Chat是否以对话为主要驱动，表单/UI作为观察与确认手段。
3. P1是否必须真实读取Git工作区、项目文档与脚本清单。
4. 是否接受模型只生成Candidate，用户确认后才写Project事实。
5. 是否接受Contribution区分reported与verified，不能把Agent自述当证据。
6. 是否接受P1先只读管理与维护，下一任务再开放代码/文档/脚本副作用执行。
7. 是否接受Project用Store v4、Rules后续使用v5。

未得到明确批准前，不开始产品实现。
