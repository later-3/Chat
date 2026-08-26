# Chat 项目管理内核 K0 收敛基线

> 文档类型：K0只读源码、Git与运行实例审计事实
>
> 审计日期：2026-08-25
>
> 审计分支：`codex/project-management-kernel-k0-baseline`
>
> 上位计划：[Chat项目管理内核收敛实施计划](../product/project-management-kernel-convergence-plan.md)
>
> 当前状态：K0只读审计已关闭；用户已批准继续目标驱动的本地设计、代码实现和验证。正式Store迁移、外部Provider写入、部署、push和PR仍按具体影响范围授权

## 1. K0结论

当前Chat不是“没有项目管理代码”，而是存在三套不同代际、不同成熟度且尚未汇合的能力：

1. 当前`main`拥有通用Project账本、Plane+Git Bootstrap和新的Capability Governance；
2. `codex/content-lab-plane-p8`拥有Content Production、日常Plane协调、资源上下文、跨Agent开工包和真实Plane落地；
3. 当前常驻43111实例运行`main`源码表面，只具备Bootstrap和通用Project API，不具备P8协调路由。

K0发现一个必须在任何合并或迁移前解决的关键冲突：

> `main`和P8使用了相同或相邻的Product Store版本名称，但分别保存Capability Governance和Project
> Coordination两套互不包含的实体。P8的`v21`不是当前`main v20`的简单超集，不能按版本数字直接覆盖或串行迁移。

因此P8不能fast-forward到当前`main`，也不能把P8的`migrate-v20-to-v21`直接用于正式Store。下一实现阶段必须先建立
双谱系读取和唯一后继Schema，再汇合Application与DSH表面。

K0已完成版本矩阵、对象/API/UI清单、术语建议、重复对象责任和集成策略。第9节决定已经被后续
[全项目生命周期管理蓝图](../product/project-management-system-blueprint.md)吸收；K1不再等待逐项用户审核。

## 2. 精确版本矩阵

### 2.1 Git谱系

| 基线 | Commit | 相对共同基线 | 事实 |
|---|---|---|---|
| 共同祖先 | `8b28e68bf020ca817ca2ae8048cda511a7f9a0a3` | 0 | `main`和P8在此后分叉 |
| 当前`main` | `f831182c6515995670571a0bca76214dc0fe1152` | 1个独有Commit | `feat: establish capability governance v1` |
| Content Lab P8 | `7ddcf10150379684d62ffc114d3a7a77677dc97c` | 13个独有Commit | P0-P8项目管理纵向与真实Plane落地 |
| 收敛计划 | `dc8c35e7f12720203855d632ee6703beed728469` | P8之上2个文档Commit | 最终目标、K0-K5与四项目验证计划 |
| 本K0分支基线 | `dc8c35e7f12720203855d632ee6703beed728469` | 计划之上 | 本文提交前无代码变化 |

`git rev-list --left-right --count main...codex/content-lab-plane-p8`返回`1 13`。两条分支都修改了37个相同文件；
经典`git merge-tree`确认23个文件会产生文本冲突。P8相对共同基线修改146个文件，增加27,173行、删除233行；
`main`唯一Capability Governance提交修改162个文件，增加11,568行、删除1,013行。

### 2.2 真实文本冲突文件

| 类别 | 文件 |
|---|---|
| 当前事实 | `PROJECT_STATE.md` |
| Store合同 | `packages/contracts/src/product-store.ts` |
| DSH表面 | `packages/dsh-lifeos-bridge/src/client/LifeosDock.tsx` |
| Store入口与实现 | `packages/product-store-json/src/index.ts`、`json-product-store.ts`、`snapshot-integrity.ts` |
| 旧版本与迁移 | `legacy-v16.ts`至`legacy-v19.ts`、`migrate-v16-to-v17.test.ts`、`migrate-v17-to-v18.test.ts`、`migrate-v18-to-v19.test.ts`、`migrate-v19-to-v20.ts` |
| Store测试 | `configurable-workflow-store-quality-gate.test.ts`、`json-product-store.test.ts`、`prompt-review-store.test.ts`、`rules-v9-migration.test.ts`、`snapshot-integrity/execution.ts` |
| Replay/Fixture | `packages/realtime/src/replay.test.ts`、`packages/testing/src/application-use-cases.test.ts`、`fixtures/s7-versioned-fixtures.ts`、`s7-compatibility-auditor.test.ts` |

另有14个双方都修改但文本可自动合并的文件，包括Application `deps/index`、Contracts `ids/index/public`、Bridge
`service/client/contracts`及若干Store测试。自动文本合并不等于语义兼容，集成时仍须逐项复核。

### 2.3 Store谱系

| 谱系 | 当前Schema | 独有事实 | 明确缺少 |
|---|---|---|---|
| 当前`main` | `chat-product-store.v20` | `toolExecutionIntents`、`toolExecutionDecisions`、`toolExecutionResults`及Capability Governance | P8 Claim、Handoff、Context、Provider Projection/Operation |
| P8 P4 | 也使用`chat-product-store.v20`历史形态 | Content Work、Claim/Practice/Context、Provider Binding v1 | 当前`main`的Tool Execution事实 |
| P8 P5-P8 | `chat-product-store.v21` | Provider Binding/Projection v2、Coordination Operation、Inbound Change | 当前`main`的Tool Execution事实 |

这是一个真实的版本号碰撞：两种`v20`严格Schema并不相同。仓库历史已经用`legacy-v16.ts`处理过类似双分支Schema，
后续可以复用“同版本多形态、按严格字段识别、迁入唯一后继”的机制，但不能复用旧数据假设。

K1/K2的后继Store建议使用下一个未占用版本，并显式接受：

1. 当前`main v20 capability`；
2. P8 `v20 content`；
3. P8 `v21 coordination`；
4. 既有更老版本通过各自已验证链先进入对应分支形态。

后继Schema必须同时包含Capability和Project事实，迁移只读旧快照并写新本地快照，不访问Plane、Git或其他Provider。

### 2.4 常驻43111实例

2026-08-25只读取证据：

- PID `18659`监听`127.0.0.1:43111`；
- 进程启动时间为2026-08-24 18:22:53；
- 命令和`cwd`都来自`<CHAT_REPOSITORY>/apps/api`；
- `GET /api/healthz`返回`{"status":"ok","service":"chat-api"}`；
- `GET /api/project-agent/opening-packet`返回404；
- `GET /api/plane-projects/bindings`返回404；
- 项目协调Skill能把Git common dir解析为Chat Project和`codex/`可写分支，但`status`因上述路由缺失返回404并失败关闭。

API没有公开Build SHA，因此不能把进程`cwd`等同于密码学确认的加载Commit；但进程路径、启动时间和两条P8路由404共同证明
它没有运行P8日常协调表面。本文只登记该能力边界，不读取或修改正式`.data`。

## 3. 当前对象清单

### 3.1 通用Project账本：保留为内核

| 对象 | 当前责任 | K1/K2目标 |
|---|---|---|
| `Project` | 长期目标、范围、成功标准、生命周期、当前Stage/Method | 保留稳定ID和主聚合责任 |
| `ProjectMethodSnapshot` | 编译后的不可变方法政策 | 保留；由新Profile Revision与Configuration Adoption编译 |
| `ProjectStage` | 当前阶段目标和完成门 | 保留 |
| `ProjectMilestone` | 可验收阶段结果 | 保留 |
| `ProjectWork` | 可验收用户结果 | 保留；统一generic/content及后续Profile扩展边界 |
| `ProjectAction` | Work下的执行下一步 | 保留；不能与Work合并 |
| `ProjectParticipant` | human/agent/automation/external参与者 | 保留并与Principal/Agent Runtime身份分离 |
| `ProjectResource` | 外部权威资源的受管Descriptor | 保留；Adapter结果按Profile扩展 |
| `ProjectDecision` | 版本绑定的用户或授权决定 | 保留 |
| `ProjectEvidence` | 完成、审核和恢复证据引用 | 保留；不复制真实资产 |
| `ProjectContribution` | 参与者贡献与Evidence状态 | 保留 |
| `ProjectUpdate` | 已确认健康、变化、阻塞和下一步摘要 | 保留 |
| `ProjectStateTransition` | Project/Stage/Milestone/Work严格转换历史 | 保留 |
| `ProjectObservation` | 对Git、文档、脚本或Profile Resource的只读观察 | 保留 |
| `ProjectCandidate` | Intake、Advancement、Management候选 | 保留Candidate/Decision模式，收敛入口 |

### 3.2 P8协调对象：通用化后保留

| 对象 | P8当前限制 | K1/K2目标 |
|---|---|---|
| `ProjectWorkBlock` | Content recoverable states | 通用Block事实，恢复状态由Profile政策校验 |
| `ProjectWorkClaim` | Content Agent必须Claim | 通用租约；Profile决定disabled/optional/required |
| `ProjectWorkHandoff` | 已能跨Participant恢复 | 直接保留，Context Compiler引用 |
| `ProjectPracticeRevision` | Content workflow方法 | 保留为Profile可选能力，不强制所有项目存在 |
| `ProjectWorkOutcome` | Publication等内容结果 | 演进为Profile定义的Outcome扩展，不替代Evidence |
| `ProjectContextMap` | Authority/Evidence literal固定为Content Production | 改为通用版本化Context Map，政策来自采用的Profile/Configuration |
| `ProjectProviderBinding` | `plane_ce`和`content-lab-plane-mapping.v1`硬编码 | 保留稳定Binding；Capability和Mapping Revision外置 |
| `ProjectProviderProjection` | 只覆盖work/practice/page | 保留；对象类型按Provider Mapping版本扩展 |
| `PlaneProjectOperation` | 日常Plane Work Item/Comment写入 | 保留为Provider Operation实现；Application命令仍是Provider无关语义 |
| `ProjectInboundChange` | Plane人工变化分类 | 保留受治理入站Candidate/冲突责任 |

### 3.3 Bootstrap对象：保留外部准备历史，不再承担Project采用

| 对象 | 当前责任 | 收敛决定候选 |
|---|---|---|
| `ProjectBootstrapCandidate` | Plane+Git初始化候选 | 保留历史；未来由Project Adoption协调调用外部准备 |
| `ProjectBootstrapDecision` | 用户确认初始化副作用 | 保留独立高影响Decision |
| `ProjectBootstrapOperation` | workspace/plane/binding三步外部操作 | 保留Operation身份和对账，不合并到日常Plane Operation |
| `ProjectWorkspaceBinding` | Session↔Plane Project↔Workspace Root | 降级为Bootstrap Receipt/legacy Binding，迁入稳定Project Resource/Provider Binding |
| `initializerProfile` | `blank/ai_learning`目录模板 | 重命名概念为Resource Template，不能冒充Project Profile |

### 3.4 运行时投影：不进入Product Store第二套事实

| 投影 | 当前责任 | 收敛目标 |
|---|---|---|
| `PlanningProjectContext` | Planner冻结的项目上下文 | 与统一Context Compiler共享SourceRef，仍是Run输入快照 |
| `ProjectAgentOpeningPacket` | Resolver编译Project/Profile/Work/Permission/Plane/Resource摘要 | 保留网络DTO，不变成持久聚合 |
| DSH `projectCoordination`卡片 | 显示项目、当前Work、未决Operation/Inbound和打开Plane | 保留窄表面，不复制完整看板 |
| Skill本地reference cache | Git路径解析和稳定project key缓存 | 仅导航/恢复，不能成为Product事实 |

## 4. API与命令清单

### 4.1 当前`main`

`main`公开21条Project路由和8条Bootstrap路由：

- Project Intake/Management/Advancement Candidate及Decision；
- Project list/detail/timeline；
- Action create/transition/assignment；
- Project/Stage/Milestone transition；
- Archive、Observation、Decision Candidate、Contribution Candidate；
- Bootstrap message、configuration、candidate decision、operation retry/query和Session current。

这些路由已经能维护通用账本和建外部容器，但DSH当前只呈现Bootstrap审核、进入Workspace和打开Plane，没有完整Project日常
管理入口。

### 4.2 P8新增

P8将Project路由扩展到35条，保留8条Bootstrap路由，另增加13条受专用Plane客户端凭据保护的协调路由。

新增Project/Application命令：

- `createContentProductionProject`、`registerProjectAgent`、`createProjectWork`；
- `recordProjectEvidence`、`claimProjectWork`、`blockProjectWork`、`resumeProjectWork`；
- `requestProjectWorkReview`、`handoffProjectWork`、`decideProjectWorkTransition`；
- `recordContentPublication`、`adoptProjectPractice`；
- `compileContentLabProjectContext`和`getProjectAgentOpeningPacket`。

Plane协调路由族：

- Binding list/get、Opening Packet、Snapshot、Work Item Comments；
- Sync、Inbound Change list/resolve；
- Operation prepare/list/get/execute/reconcile。

内部Application还提供`adoptExistingPlaneProject`和人工处置未知Operation，但没有开放任意Plane endpoint/body。

### 4.3 UI与Agent入口

| 表面 | `main` | P8 |
|---|---|---|
| DSH Bootstrap卡 | 有 | 保留 |
| 打开Git Workspace/Plane | 有 | 保留 |
| Project Opening Packet摘要 | 无 | 有，只读窄卡片 |
| Claim/Progress/Block/Review/Handoff | 无DSH直接控件 | 通过Chat Application与Skill/Agent客户端，DSH只显示摘要 |
| 完整Plane看板/Page/Analytics | 跳转Plane | 仍跳转Plane，不复制UI |
| 当前常驻43111 | Bootstrap/通用Project可达 | P8路由404 |

## 5. 术语冻结建议

以下术语在K1前作为唯一推荐含义；它们是用户待审核的K0决定候选，不修改当前Schema：

| 术语 | 唯一含义 | 不等于 |
|---|---|---|
| Chat Project | 用户长期推进的一件内聚事情及稳定产品身份 | 仓库、Plane Project、目录、Session |
| Project Profile Revision | 一类项目的版本化Work、状态、权限、Evidence、Context和Mapping政策 | 目录模板、Plane模板、任意DSL |
| Project Configuration Revision | 一个真实Project采用的目标、术语、参与者、资源、节奏和Provider配置 | Profile复制品 |
| Method Snapshot | 某次采用后由Profile+Configuration编译的不可变执行政策 | 可编辑Profile |
| Project Adoption | 用户通过Decision采用Profile/Configuration并建立完整Project事实 | Bootstrap ready |
| Resource Template | 初始化目录或文件的模板，例如现有`ai_learning` | Project Profile |
| Project Resource | 外部权威资产的受管Descriptor和观察入口 | 资产正文或二进制副本 |
| Context Map | Agent按Profile查找治理、工作、资源、历史和Provider事实的版本化路标 | 全量模型上下文 |
| Work | 可验收的用户结果 | Action、Session、Commit、单文件修改 |
| Action | Work中的具体下一步 | 独立Project结果 |
| Participant | Project中的人、Agent、自动化或外部参与身份 | Runtime Session |
| Provider Binding | Chat Project与一个外部Provider项目表面的稳定关联 | Provider凭据 |
| Provider Projection | 精确Chat对象revision与外部对象/指纹的同步关系 | 第二份Chat事实 |
| Bootstrap Operation | 创建外部容器和初始Binding的高影响操作 | 日常Work推进 |
| Coordination Operation | 投影一次已授权Project命令的Provider副作用 | Application业务命令 |
| Outbox | 已提交产品意图的耐久分发队列 | 外部操作结果或项目历史 |

## 6. 重复对象与迁移责任

| 当前分裂 | 目标责任 | 迁移责任 | 旧对象删除条件 |
|---|---|---|---|
| Project Intake vs Bootstrap Candidate | Adoption协调内部Project与可选外部准备；两类Decision保留 | Application + Store迁移 | 所有Bootstrap历史可通过新Project/Receipt查询后才停止旧写 |
| Method Snapshot vs缺失的Profile Revision | Profile/Configuration是可采用源；Snapshot是编译结果 | Contracts/Domain/Application | 不删除Snapshot，永久解释旧Work |
| Workspace Binding vs Provider Binding | Resource/Provider Binding绑定稳定Project；Workspace Binding是旧Bootstrap Receipt | Store迁移 + Application Resolver | 旧Session/Operation均可追溯后归档，不物理删除 |
| Planning Context vs Context Map vs Opening Packet | 一个Context Compiler；分别输出Run快照、持久路标和网络DTO | Application | 无竞争持久事实后停止旧编译路径 |
| Generic Work/Action vs Content Work/Claim | Work/Action共享内核；状态、Claim政策和Outcome由Profile编译 | Domain/Application | 兼容旧Work版本，不批量倒改历史 |
| Bootstrap Operation vs Plane Operation vs Outbox | 两种Operation分别拥有初始化和日常外部结果；Outbox只分发 | Application/Store | 不合并身份，不删除已执行记录 |
| `main v20` vs P8 `v20/v21` | 唯一后继Store同时保存Capability与Project事实 | Contracts + product-store-json | 所有旧形态均有非空迁移和回滚门后停止旧写 |
| DSH Bootstrap卡 vs Coordination卡 | 同一Project生命周期下的两个窄阶段表面 | Bridge | Adoption纵向稳定后再决定是否合并布局 |

## 7. P8集成策略

### 7.1 明确拒绝

- 不fast-forward：当前`main`不是P8祖先；
- 不把P8 rebase到`main`后重写13个已审核P0-P8 Commit；
- 不直接merge K0分支到`main`，因为它包含未汇合的P8代码和两个计划Commit；
- 不先选择P8 `v21`覆盖正式Store；
- 不为让Git自动合并而删除Capability Governance或项目协调任一纵向；
- 不在合并过程中调用Plane、迁移正式`.data`或启动部署。

### 7.2 推荐集成步骤

后续单独授权时：

1. 从届时最新`main`建立`codex/project-management-kernel-integration`；
2. 记录新的merge-base、main独有提交和P8独有提交，漂移则回到K0复核；
3. 用普通非squash merge引入`codex/content-lab-plane-p8`，保留P0-P8证据历史；
4. 先不提交冲突结果，按以下顺序做语义汇合：
   - Contracts IDs/exports和唯一后继Store Schema；
   - 双谱系legacy reader、迁移和完整性检查；
   - Application deps/composition、Outbox和Provider Ports；
   - DSH Bridge/Client/LifeosDock；
   - Replay、Fixture、测试和`PROJECT_STATE.md`；
5. cherry-pick收敛计划Commit `0889dc82`、`dc8c35e7`及本K0文档Commit；
6. 运行Store空/非空双谱系迁移门、Capability全门、Project全门和根级质量门；
7. 用户审核集成分支后再分别决定合入`main`、正式Store迁移、部署和真实Plane协调启用。

### 7.3 冲突解决的不变量

1. 后继Store必须是两条谱系的严格超集，不能以一个功能替换另一个；
2. Capability授权、Tool Decision和Execution Evidence语义保持当前`main`事实；
3. Content Work、Claim/Handoff、Context、Provider Operation语义保持P8已验证事实；
4. Bootstrap的Candidate/Decision/Operation/Outbox历史不得重写；
5. DSH同时保留Tool Review、Bootstrap和Project Coordination窄表面；
6. `PROJECT_STATE.md`必须描述汇合后的单一事实，不能手工选择一侧整段；
7. 任何自动合并文件都要运行针对两条纵向的测试，不能只以无冲突为通过。

## 8. K0覆盖清单

| K0要求 | 状态 | 证据 |
|---|---|---|
| `main`、P8、Store和运行实例版本矩阵 | 已完成 | 第2节 |
| 实体、命令、路由和UI入口唯一清单 | 已完成 | 第3、4节 |
| 术语候选 | 已完成 | 第5节 |
| 重复对象保留/迁移/兼容/删除条件 | 已完成 | 第6节 |
| P8合并策略 | 已完成 | 第7节 |
| Provider写入和正式Store读取/迁移 | 未执行，符合K0边界 | 仅GET health/route状态；未读取`.data` |
| 用户确认最小原语和集成决定 | 已由后续蓝图与目标驱动实施授权取代 | 第9节及上位蓝图 |

## 9. 已采用的K1边界

1. 接受第5节术语，尤其区分Profile Revision、Configuration、Method Snapshot和Resource Template；
2. 接受Chat拥有跨Provider治理事实、Plane只拥有其外部对象，不再使用“Plane拥有全部项目事实”的旧表述；
3. 接受后继Store必须同时迁移`main v20 capability`与P8 `v20/v21 project`双谱系；
4. 接受从最新`main`建立集成分支、non-squash merge P8、手工语义汇合，不rebase或覆盖任一纵向；
5. 接受Bootstrap Operation与日常Coordination Operation保持不同身份，只由Project Adoption协调；
6. 接受P8 Context Map、Provider Binding和Work状态先通用化再增加AI学习/个人日报，不把Content字段直接推广；
7. 接受Chat自举通过前`PROJECT_STATE.md`继续按现合同维护，之后再设计受控状态摘要；
8. K1先实现通用合同、确定性测试和迁移设计；执行Agent在内部完成门通过后继续本地实现，不再逐层请求用户批准；正式Store迁移、外部Provider写入、部署、push或PR仍单独授权。

本文只证明K0事实；后续对象、时间、View、Context和Maintenance语义以蓝图和四场景推演为准。
