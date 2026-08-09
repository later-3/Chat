# P1 BMAD Project 基础纵向任务书：阶段、Work 与文档清单

| 项目 | 内容 |
|---|---|
| 状态 | 待用户审核；未批准前不得开始实现 |
| 用户目标 | 在 Chat 中建立并持续推进一个 Project，能够看到并维护阶段、Work、文档清单和推进决定 |
| 交付方式 | 1 个完整纵向 PR；允许内部按依赖顺序提交，但不得把中间提交当成完成品或停在“下一个 M” |
| 实现范围 | Contracts → Domain → JSON Store v3→v4 → Application → REST API → 最小响应式 Project UI → 浏览器 E2E |
| 参考基线 | BMAD-METHOD v4.44.3，提交 `4c4f6dc8534f95427e66e122ac5de47ac51b5f94` |
| 当前基线 | `main` 的 `chat-product-store.v3`、单调试用户、真实 API/PWA、规划—确认—执行与 Memory M1～M3 |
| 下一阶段 | P2 才把 Project Context Builder、Project Workflow 节点、模型候选和 Correct Course 接入规划闭环 |

## 1. 结论：本任务完成后用户能做什么

本任务不是复制 BMAD，也不是只增加几张表。完成后，用户必须能从真实 Chat 页面完成以下闭环：

```text
进入“项目”
→ 新建绿地软件项目 / 棕地小改动项目 / 轻量非软件项目
→ Chat 按所选方法生成可解释、已冻结版本的阶段与文档要求
→ 用户建立 Work、填写验收标准和依赖
→ 用户登记外部项目文档及其版本、Hash、角色和状态
→ 用户尝试推进阶段
→ Application 计算推进门并明确显示“通过”或“缺少什么”
→ 通过时原子提交 Project 状态与 ProjectDecision
→ 刷新页面或重启 API 后，阶段、Work、文档、决定和历史版本仍可恢复
```

必须交付一个可实际使用的小版本，而不是只有 Schema、只有 API、只有静态 UI 或只有 happy path。

## 2. 用户真实意图与设计原则

1. **项目上下文是 Chat 的产品事实**：BMAD 文件、Agent 输出或浏览器状态都不能成为权威项目状态。
2. **方法是模板，不是枷锁**：软件项目可以采用 BMAD 启发的结构；小改动和非软件项目不能被强迫先写完整 PRD 与 Architecture。
3. **阶段推进有理由**：界面不仅显示“不能推进”，还要显示缺少的文档、未完成 Work、未通过的质量门或陈旧 revision。
4. **文档只登记一次正文位置**：Product Store 保存角色、URI、revision、Hash、状态和引用；不复制外部文档正文，不把目录路径当状态机。
5. **历史是证据**：文档新版本不能覆盖旧版本；阶段推进、Work 关键转换和文档接受必须产生可追溯决定。
6. **先建立确定性基础，再接模型**：P1 先证明 Project 事实与门禁正确；P2 才允许模型基于这些事实产生推进候选。

## 3. BMAD 源码证据与 Chat 的取舍

本任务的结论绑定本地只读参考源码：

```text
/Users/xulater/Code/reference-agent-sources/BMAD-METHOD-v4.44.3
commit 4c4f6dc8534f95427e66e122ac5de47ac51b5f94
tag v4.44.3
```

`/Users/xulater/Code/opc-os/agent_knowledge/project-studies/bmad-method` 只有研究基线和待批准的研究合同，没有完成架构结论，因此不能用它代替源码证据。

| BMAD 源码证据 | 真实行为 | Chat 采用 | Chat 调整/拒绝 |
|---|---|---|---|
| `docs/user-guide.md` | 规划产物对齐后进入 Story 开发循环；Story 需用户批准，完成前有验证/QA | 采用 plan→execute、人工门、完成证据 | 不复制 Agent 角色编排；Chat 用产品对象和 Workflow 节点表达 |
| `bmad-core/templates/story-tmpl.yaml` | Story 状态为 Draft、Approved、InProgress、Review、Done；包含 AC、任务、测试与开发记录 | 作为软件模板的默认 Work 状态和字段灵感 | 不把这组状态写死给所有项目；轻量模板可使用更短状态集 |
| `bmad-core/tasks/create-next-story.md` | 读取前一 Story、相关架构片段，要求来源引用并阻止无依据发明 | 采用依赖、验收标准、相关文档角色和“只选需要的上下文” | P1 不生成 Story 正文；P2 Context Builder 才选择内容 |
| `bmad-core/tasks/validate-next-story.md` | 对模板、路径、AC、测试、安全、任务顺序和来源做 GO/NO-GO | 采用确定性的 Work 就绪门和可读缺口 | 不让 LLM 自报 GO 就改变权威状态 |
| `bmad-core/core-config.yaml` | 用配置声明 PRD、Architecture、Story、QA 等文件位置及常驻文件 | 采用 Project Document Manifest 与角色 | 拒绝固定目录；使用 URI/产品引用、revision、Hash |
| `bmad-core/workflows/*greenfield*` | Brief→PRD→UX（可选）→Architecture→PO 校验→Story→Dev→QA | 形成 `bmad-software.v1` 绿地 profile | 阶段名与门禁压缩为 Chat 可维护的产品结构，不复制整套文档模板 |
| `bmad-core/workflows/*brownfield*`、`docs/working-in-the-brownfield.md` | 单 Story、小 Epic、重大改造分流；现有模式与回归风险优先 | 提供棕地 quick/focused/major profile | 不把 `<4h` 等脆弱估时写成领域规则；由用户按影响范围选择 |
| `bmad-core/tasks/qa-gate.md` | 独立 PASS/CONCERNS/FAIL/WAIVED Gate，Waiver 需原因和批准者 | 接受文档/Work 与推进决定保留质量证据 | P1 不实现完整 Test Architect；只实现可配置 required/review 门 |
| `bmad-core/tasks/correct-course.md`、`change-checklist.md` | 先分析影响并形成 Sprint Change Proposal，用户明确批准后修改产物 | P2 实现版本绑定 `ProjectChangeProposal` | P1 不允许模型或候选直接改阶段、范围、方法配置 |

### 3.1 不能照搬 BMAD 的部分

1. BMAD 的文件路径是运行配置，不是数据库关系，不能把 `docs/prd.md` 是否存在当成 Project 当前状态。
2. BMAD 的 Story 状态适合软件交付，不适合健身计划、内容运营或个人研究等非软件项目。
3. BMAD 的 QA Gate 是建议性文件；Chat 的阶段推进属于产品命令，必须在服务端用 CAS 与领域规则确定性校验。
4. BMAD 倾向把上下文写进自包含 Story；Chat 的完整历史不能每轮全部注入，P2 必须按角色、阶段和预算选择。
5. BMAD Agent 说“Done”不能成为 Chat 的 `done`；必须由用户命令和可验证门禁提交产品事实。

## 4. 范围与非范围

### 4.1 本任务必须完成

1. `Project`、`ProjectMethodConfiguration`、`ProjectWork`、`ProjectDocumentRevision`、`ProjectDecision` 的 strict 合同。
2. 内置 `bmad-software.v1` 与 `lightweight.v1`，包括绿地、棕地 quick/focused/major 和非软件轻量 profile。
3. Project、Work、Document 和阶段推进的领域状态机、不变量、CAS 与幂等。
4. Product Store 从 v3 串行迁移到 v4，并对新对象做跨对象完整性校验。
5. Project Query/Command 用例和公开 REST API。
6. 真实页面的 Project 列表、创建、详情、阶段、Work、文档清单和推进门结果；桌面与手机可用。
7. Trace 记录命令、状态转换、门禁结果、对象引用、版本和耗时，不记录目标/AC/文档正文。
8. 合同、领域、Store、Application、API、Web 单测和真实浏览器 E2E。
9. 使用迁移后的 v4 Store 跑一次现有百炼 `qwen3.7-plus` 真实闭环回归，证明 Project 扩展没有破坏原链。
10. 更新架构、仓库地图、前后端交互、PROJECT_STATE/PLAN 和关键中文注释。

### 4.2 本任务明确不做

1. 不修改 `PlanningExecutionWorkflow` 的业务步骤，不把 Project 内容注入 pi Prompt。
2. 不实现 `ProjectContextBuilder`、Project Workflow 节点、自动选择文档片段或 Token 预算。
3. 不实现模型生成 Project/Work/Stage 修改候选。
4. 不实现 `ProjectChangeProposal`、Correct Course 审批链或方法模板在线编辑器。
5. 不实现 Rules、规则标签、规则选择或规则注入。
6. 不复制 BMAD 的 PRD、Story、Architecture 或 QA 文档模板正文。
7. 不在 Product Store 中读取、上传或复制用户外部文档正文；P1 只维护清单与证据引用。
8. 不引入数据库、搜索引擎、对象存储或新的状态管理框架。
9. 不宣称多用户认证已完成；仍沿用当前明确标注的单调试 Principal。

P2 才能声称“规划模型真实使用了 Project 上下文”。P1 的真实模型回归只是既有链的迁移防回归证据，不能冒充 Project AI 能力。

## 5. 用户场景与验收结果

### 场景 A：绿地软件项目

用户创建 `bmad-software.v1 / greenfield_full` 项目，填写名称与目标。页面显示 Brief、Planning、Solutioning、Implementation、Review 五个阶段，以及当前阶段的文档与 Work 要求。缺少必需 Brief 时推进失败；登记并接受对应文档后可以推进，决定记录可见。

### 场景 B：棕地小改动

用户选择 `brownfield_quick`。系统不能强制完整 PRD、UX、Architecture；只要求意图/影响说明、验收标准、回归证据和 review。用户能在少量步骤内进入 implementation，同时仍保留依赖与风险门。

### 场景 C：棕地重点功能与重大改造

`brownfield_focused` 要求聚焦需求与集成/回归说明；`brownfield_major` 才要求 PRD、Architecture 和更完整的阶段门。用户能在创建前看见三种 profile 的差异，避免错误选择后才发现负担。

### 场景 D：轻量非软件项目

用户创建 `lightweight.v1`，阶段为 Intent→Active→Review→Done，Work 使用 Draft→Active→Review→Done/Cancelled；不出现 PRD、Architecture、代码或 QA 专属强制字段。用户仍需为 Work 提供可观察完成标准。

### 场景 E：Work 与依赖

用户建立两个 Work，B 依赖 A。B 不能在 A 未完成时进入 Done；循环依赖、自依赖、跨 Project 依赖、旧 revision 更新全部失败关闭。软件 Work 的 Draft→Approved→InProgress→Review→Done 与轻量 Work 状态分别由方法配置决定。

### 场景 F：文档版本与接受

用户登记一个 PRD URI、内容 SHA-256 与 revision 1；更新时创建 revision 2，revision 1 永久保留并标记 superseded。阶段门只承认当前、角色匹配、Hash 合法且已接受的版本，不能用旧版本或只改前端状态绕过。

### 场景 G：并发、重放与恢复

同一 `commandId` 同请求重放返回相同结果，不产生重复决定；同 ID 不同请求 Hash 返回 `COMMAND_ID_REUSED`。两个基于同一 revision 的推进命令只能一个成功。刷新页面、重启 API、从 v3 文件启动后，结果一致。

### 场景 H：手机使用

在 390×844 视口可以创建项目、查看阶段、打开 Work/文档清单、看到阻塞原因并提交允许的动作；无横向页面溢出，交互目标、焦点、标签和错误提示可访问。

## 6. 产品对象与持久化合同

所有实体使用 `.strict()`；浏览器不得指定权威 ID、owner、模板版本 Hash、Decision、状态终值或时间戳。

### 6.1 `Project`

至少包含：

- `projectId`、`ownerPrincipalId`、`title`、`objective`。
- `projectType: software | non_software`。
- `projectProfile: greenfield_full | brownfield_quick | brownfield_focused | brownfield_major | lightweight`。
- `lifecycle: active | completed | archived`。
- `currentStageKey`。
- `methodConfiguration`：完整冻结配置、`templateId`、`templateVersion`、`configurationSha256`。
- `revision`、`createdAt`、`updatedAt`。

方法配置必须随 Project 持久化完整快照，不能只保存一个指向当前代码常量的 ID。否则未来模板升级后无法解释旧项目为何能或不能推进。P1 创建后不在线修改方法配置；需要改阶段图或必需角色时进入 P2 Correct Course。

### 6.2 `ProjectMethodConfiguration`

它是 Project 内的不可变值对象，不单独建立万能模板仓库。至少包含：

- 有序 `stages`：稳定 key、显示名、是否终态、required/optional document roles。
- `transitions`：允许的 from/to。
- `workStatuses` 与允许转换。
- 每个阶段的 gate：必须接受的文档角色、阻塞状态、是否要求无未完成 Work、是否必须显式用户决定。
- profile 选择和创建时裁剪项，例如 `uxRequired`、`qualityGateRequired`。

内置模板由 Domain 中的纯函数按 `(templateId, templateVersion, profile, tailoring)` 确定性生成，并用 canonical JSON 计算 SHA-256。

### 6.3 `ProjectWork`

至少包含：

- `projectWorkId`、`projectId`、`stageKey`。
- `title`、`objective`、1～20 条 `acceptanceCriteria`。
- `dependsOnProjectWorkIds`。
- `status`、`risk: low | medium | high`。
- `revision` 与时间字段。

不把任务勾选数组、模型日志、Git 分支或 PR 状态直接塞入 Work。后续可以通过文档或外部集成引用它们。

### 6.4 `ProjectDocumentRevision`

每个内容版本是独立、不可变内容证据；更新创建新实体，不覆盖旧实体。至少包含：

- `projectDocumentRevisionId`、`projectId`、稳定 `documentKey`、`documentRevision`。
- `role`：`brief | prd | ux | architecture | work_spec | qa | change_proposal | custom`。
- custom role 时必填 `customRoleKey` 与显示名；标准 role 禁止携带 custom 字段。
- `title`、`locator`、`sha256`。
- `status: draft | ready | accepted | superseded`。
- `supersedesProjectDocumentRevisionId`（revision > 1 时必填）。
- 对象级 `revision` 与时间字段。

`locator` 第一版只支持严格联合：

1. `external_uri`：只允许 `https:` 或明确的仓库相对路径；禁止 `file:`、凭据化 URL、Query/Fragment 中的秘密。
2. `product_artifact`：引用现有 `artifactId + revision + sha256`。

URI 是定位信息，不是认证信息。API DTO 只回传安全 locator；Trace 只写对象 ID/revision/hash，不写 URI。

### 6.5 `ProjectDecision`

所有高影响转换由命令原子生成不可变 Decision：

- `advance_stage`：绑定 project revision、from/to、method configuration hash、gate evaluation hash。
- `complete_project` / `archive_project`：绑定当前 stage 与 revision。
- `transition_work`：绑定 Work before/after status 与 Work revision。
- `accept_document`：绑定 document revision 与 sha256。

每个 Decision 必须包含 `principalId`、`commandId`、`reason`（waiver 或非正常路径必填）与创建时间。P1 不提供一般性 waiver；不得通过写一个 Decision 绕开硬门。

## 7. 方法模板 v1

### 7.1 `bmad-software.v1`

共同阶段：`brief → planning → solutioning → implementation → review`。`review` 门通过后 Project lifecycle 进入 `completed`，不再伪造一个无业务含义的额外阶段。

| Profile | 目的 | 默认必需证据 |
|---|---|---|
| `greenfield_full` | 新产品/新系统 | Brief；PRD；按选择启用 UX；Architecture；实现 Work；Review/QA 证据 |
| `brownfield_quick` | 边界清楚、影响局部的单 Work | 意图/影响文档；AC；回归证据；Review，不强制 PRD/Architecture |
| `brownfield_focused` | 约 1～3 个相关 Work 的聚焦增强 | 聚焦需求；集成影响；相关架构/约束；回归证据 |
| `brownfield_major` | 跨模块、迁移或重大改造 | Brownfield PRD；Architecture；兼容/迁移；风险与 QA 门 |

“约 1～3 个”仅用于 UI 解释，不是服务端数量硬规则。选择权属于用户；系统显示代价和门禁差异。

软件 Work 默认状态：

```text
draft → approved → in_progress → review → done
          ↘ cancelled      ↘ in_progress
draft → cancelled
```

`review → in_progress` 用于修复，不得跳过审批直接 `draft → done`。

### 7.2 `lightweight.v1`

阶段：`intent → active → review → done`。默认只要求目标/成功标准、活动 Work 和最终复核；不出现软件专属文档要求。

Work 状态：

```text
draft → active → review → done
  ↘ cancelled      ↘ active
```

### 7.3 推进门计算

Domain 暴露一个纯函数 `evaluateProjectGate(snapshot, project, targetStage)`，返回严格结构：

- `outcome: pass | blocked`。
- `gateEvaluationSha256`。
- 稳定 `blockers[]`，每项含 `code` 与产品对象引用，不含拼接正文。
- `satisfiedEvidenceRefs[]`。

Command 必须在同一事务内重新计算门，不信任浏览器上一次 Query 的结果。Query 和 Command 复用同一 Domain 函数，避免“页面说能推进、服务端却使用另一套规则”。

## 8. 领域不变量与错误族

### 8.1 必须失败关闭的不变量

1. owner 不匹配。
2. `expectedRevision` 陈旧。
3. 项目已 archived 后任何业务修改。
4. 非模板允许的阶段或 Work 转换。
5. 未满足 gate 推进或完成。
6. 依赖未完成、循环、自依赖、跨 Project 引用。
7. 文档 role 与当前方法要求不匹配，或 custom role 字段组合非法。
8. 文档 revision 不连续、supersedes 指向错误、Hash/引用不一致。
9. 旧文档版本被接受为当前版本，或已 superseded 版本再次修改。
10. 同一 Project/documentKey/revision 重复。
11. 方法配置 Hash 与内容不一致，或引用未知模板版本。
12. 同一高影响命令并发时产生两个成功 Decision。

### 8.2 稳定错误代码

至少冻结：

```text
project.not_found
project.forbidden
project.revision_conflict
project.lifecycle_closed
project.profile_invalid
project.method_configuration_invalid
project.transition_invalid
project.gate_blocked
project.work_dependency_invalid
project.work_transition_invalid
project.document_revision_conflict
project.document_locator_invalid
project.document_not_current
project.document_hash_mismatch
project.command_reused
```

HTTP 映射遵循现有 Problem Detail：校验 400、权限 403、不存在 404、CAS/幂等冲突 409、领域门禁 422、内部损坏 500 且失败关闭。响应提供稳定 `recoveryAction`，不泄漏磁盘路径、完整 URI 或正文。

## 9. Product Store v3→v4

### 9.1 Schema 升级

P1 占用下一个版本：`chat-product-store.v4`。新增集合：

```text
projects
projectWorks
projectDocumentRevisions
projectDecisions
```

`ProjectMethodConfiguration` 嵌入 Project，不新增可变模板集合。

现有架构文档曾写“R1 计划 v3→v4”，这是排期冲突。以本任务为准：

```text
v1 → v2 Memory 查询
v2 → v3 Memory 导入
v3 → v4 Project 基础（本任务）
v4 → v5 Rules 基础（后续 R1）
```

实现合入时必须同步修改相关架构和路线图，避免两个功能声称拥有同一迁移版本。

### 9.2 迁移与完整性要求

1. `JsonProductStore.open()` 只允许显式串行 `v1→v2→v3→v4`，不跨版本猜测。
2. v3 非空的所有 Session、Run、Memory、Import、Receipt 与 Outbox 逐对象保持等值；新集合初始化为空。
3. 迁移写入继续复用 0600 临时文件、文件 fsync、原子 rename 和目录 fsync。
4. 截断 JSON、未知版本、未知字段、悬空引用、Hash 篡改、非法状态或迁移 I/O 故障都不得改写原文件。
5. Snapshot Integrity 校验所有 Map key 与对象 ID 一致、所有外键存在、同 Principal 所有权一致、方法 Hash 可重算、文档链连续无分叉、Decision 绑定有效。
6. 新 Store 上完成的 Project 写入不能破坏现有规划、Memory 与 Outbox 事务语义。

## 10. Application 用例与事务边界

不建立 `ProjectService` 万能类。按真实事务意图组织小型用例：

### Query

1. `listProjectMethodProfiles`：返回内置 profile 的用户可读差异与版本。
2. `listProjects`：当前 Principal 的摘要列表。
3. `getProjectWorkspace`：Project、当前 gate、Work、当前文档清单及近期 Decision 的一次一致快照。

### Command

1. `createProject`。
2. `updateProjectMetadata`（只允许 title/objective，CAS）。
3. `createProjectWork`、`updateProjectWork`、`transitionProjectWork`。
4. `registerProjectDocument`、`createProjectDocumentRevision`、`acceptProjectDocument`。
5. `advanceProjectStage`、`completeProject`、`archiveProject`。

每个 Command：

```text
校验公开 DTO
→ 计算 request canonical hash
→ ProductStore.transact(commandId)
→ 在 draft 上校验 Principal/CAS/状态机/引用
→ 创建或修改产品事实
→ 高影响动作同时创建 ProjectDecision
→ 一次原子提交 Receipt
```

本任务没有新的异步外部副作用，因此不新增 Project Outbox kind。不要为了“以后可能有 Workflow”提前派发空消息。

## 11. REST API 合同

保持当前 `/api`、strict Zod、Command Envelope、Problem Detail 和调试 Principal 方式：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/project-method-profiles` | 查看模板/profile 及门禁摘要 |
| GET | `/api/projects` | 项目列表 |
| POST | `/api/projects` | 新建 Project |
| GET | `/api/projects/:projectId` | 一次读取 Project Workspace |
| POST | `/api/projects/:projectId/metadata` | 修改 title/objective |
| POST | `/api/projects/:projectId/works` | 新建 Work |
| POST | `/api/project-works/:projectWorkId` | 修改 Work 内容 |
| POST | `/api/project-works/:projectWorkId/transitions` | Work 状态转换 |
| POST | `/api/projects/:projectId/documents` | 登记文档 revision 1 |
| POST | `/api/project-documents/:documentKey/revisions` | 新建后续文档版本 |
| POST | `/api/project-document-revisions/:id/acceptance` | 接受当前文档版本 |
| POST | `/api/projects/:projectId/stage-decisions` | 推进阶段或完成项目 |
| POST | `/api/projects/:projectId/archive` | 归档项目 |

如实现中发现 `documentKey` 放在路径会引入不安全或编码歧义，可以改为基于服务端 ID 的路径，但必须在实现前更新任务书/合同测试，不能路由和文档各写一套。

所有 Command Body 都是：

```json
{
  "commandId": "cmd_...",
  "payload": {
    "expectedRevision": 1
  }
}
```

创建命令没有 `expectedRevision`；子资源创建必须带 `expectedProjectRevision`，防止在陈旧阶段下写入 Work/文档。

公开 DTO 必须提供 `allowedActions` 与稳定 blocker code；浏览器不得自行推导领域权限。

## 12. 最小响应式 UI

### 12.1 入口与布局

1. 在真实产品入口增加“会话 / 项目”一级切换，沿用现有 token、按钮、卡片、状态色与错误模式。
2. Project 列表包含新建入口、模板/profile 说明、当前阶段、阻塞数量和最近更新时间。
3. Project Workspace 使用同一页内的阶段条、Work 列表、文档清单、推进区域；不做拖拽看板和图编辑器。
4. 桌面可以双栏；手机使用单列和分区切换，不能把桌面表格硬压缩到 390px。

### 12.2 必须可操作

1. 创建项目并预览所选 profile 的阶段/强制文档。
2. 创建/编辑 Work、提交合法状态转换、查看依赖阻塞。
3. 登记文档、更新版本、接受当前版本、查看旧版本但不能误操作。
4. 查看推进门，点击推进；409/422 后自动重新 Query 并保留用户未提交表单。
5. 刷新后通过服务端恢复，不使用 LocalStorage 冒充 Project Store；LocalStorage 只允许保存未提交草稿和最后打开的 projectId。

### 12.3 可访问与错误体验

1. 所有表单有 label；阶段与状态不只靠颜色；异步结果使用 `aria-live`。
2. Modal/Drawer 有焦点进入、Escape、焦点返回；能用键盘完成核心流程。
3. blocker 显示用户语言并保留稳定 code 供诊断。
4. 触控目标、输入字号和横向溢出满足现有 PWA 移动规范。

## 13. Trace、回放与安全

新增 Trace 事件采用事件级 strict 联合，不增加任意 `attributes`：

```text
project.command.received/completed/rejected
project.created
project.work.transitioned
project.document.registered/revised/accepted
project.gate.evaluated
project.stage.transitioned
project.lifecycle.changed
product_store.migration.completed/failed（如现有合同允许则扩展）
```

事件字段只允许：requestId、commandId、projectId、相关对象 ID、before/after 状态、revision、configuration/document/gate Hash、duration、outcome、errorCode。禁止写 title、objective、AC、reason 正文、URI、用户文档内容、请求 Body、Provider Payload、密钥或隐藏推理。

完整回放由 Product Store 的 Project/Work/Document/Decision 正文和 Trace 时间线组合，不在 Trace 重复正文。

## 14. 模块设计与代码质量

```text
packages/contracts
  project.ts / project-api.ts / IDs / snapshot v4

packages/domain
  project-method.ts      内置模板纯函数与Hash
  project-gate.ts        推进门纯函数
  project-state.ts       Project/Work/Document状态机与不变量

packages/application
  project-query-use-cases.ts
  project-command-use-cases.ts
  复用ProductStorePort、IdFactory、Error映射

packages/product-store-json
  migrate-v3-to-v4.ts
  snapshot-integrity.ts扩展

apps/api
  project-routes.ts      仅协议入口
  composition.ts         新ID工厂，不新增Store Owner

apps/web
  projects/              Project页面、hooks、表单与投影组件
  api/client.ts          strict响应解析
```

约束：

1. Domain 不依赖 Hono、React、JSON Adapter、BMAD 文件或 pi。
2. Router/React 不直接打开快照或复写状态机。
3. 不建立万能 `ProjectService`、Repository-per-entity、无替换价值 Port 或巨型 React 组件。
4. 模板与 gate 使用小型纯函数和判别联合；不为 2 个内置模板引入通用 DSL 解释器。
5. 核心不变量、为何保存配置快照、为何文档版本不可覆盖、为何命令内重算 gate 必须有精炼中文注释。
6. 注释解释“为什么”和边界，不逐行翻译代码。
7. 单文件超过约 400 行或同时承担合同/状态机/IO/UI 多种责任时必须拆分；不能用大量薄包装函数伪装拆分。
8. 不新增生产依赖；如确实需要，先在 PR 描述说明用途、许可证、退出方式和不可用现有依赖的原因。

## 15. 测试计划

### 15.1 Contracts

1. 所有合法 Project/Profile/Work/Document/Decision fixture。
2. 每个 strict 对象拒绝未知字段。
3. 浏览器指定 owner、ID、状态、Hash、模板版本、Decision 或内部字段时 400。
4. document locator 判别联合、custom role 联合和 command payload 交叉约束反例。

### 15.2 Domain

1. 5 个 profile 的确定性配置与固定 Hash fixture。
2. 阶段和 Work 状态机全部合法边、非法跳转、终态修改。
3. gate 的 required/optional 文档、accepted 当前版本、未完成 Work、依赖、完成门。
4. Work 自依赖、循环、跨 Project、陈旧 stage。
5. 文档连续版本、分叉、旧版接受、Hash/role/profile 不匹配。
6. 同样输入总得到相同 blocker 顺序与 gate Hash。

### 15.3 JSON Store 与迁移

1. 空/非空 v3→v4，旧事实逐对象等值，新集合为空。
2. v1→v2→v3→v4 串行迁移回归。
3. Project 完整性：Map key、外键、owner、stage、method Hash、Work dependency、document chain、Decision 绑定。
4. 截断、未知 Schema、未知字段、悬空、篡改、非法状态启动失败关闭且原文件逐字节不变。
5. temp write/fsync/rename/directory fsync 故障注入保留旧快照。
6. commandId 重放、重用冲突和两个并发 CAS 只有一个成功。

### 15.4 Application 与 API

1. 每个 Query 只返回当前 Principal 的对象和 allowedActions。
2. 每个 Command 的 happy path、权限、404、409、422、幂等重放。
3. 高影响转换在一个事务中同时提交 Decision；故障时两者都不提交。
4. Query gate 与 Command 内重算一致；陈旧 UI 不能绕过。
5. Problem Detail 不包含磁盘路径、URI、正文或内部堆栈。
6. API 重启后项目 workspace 等值恢复。

### 15.5 Web 单元/集成

1. profile 选择与要求预览。
2. 项目列表/详情 loading、empty、error、retry。
3. Work 与 Document 表单校验、草稿保留、409/422 恢复。
4. `allowedActions` 驱动按钮，不由组件私自猜状态。
5. 390px/桌面布局、键盘、焦点和 aria 状态。

### 15.6 真实浏览器 E2E 完成门

禁止 route mock、内存假 Store、fixture 页面或直接改 JSON。使用真实 Vite、Hono 和临时 JSON v4 Store：

1. **绿地门禁**：创建→推进被 Brief blocker 拒绝→登记并接受文档→推进成功→刷新恢复。
2. **棕地 quick**：创建后确认不要求完整 PRD/Architecture→Work 流转→回归证据→完成 review。
3. **轻量非软件**：创建→Intent/Active/Review/Done，全程没有软件专属强制项。
4. **依赖与 CAS**：依赖阻止完成；两个页面用同 revision 操作，一个 409，刷新后状态正确。
5. **文档历史**：revision 1→2，旧版可查看但不能接受/推进；v2 当前证据生效。
6. **重启恢复**：停止并重启 API，Project Workspace、Decision 和历史版本一致。
7. **手机**：390×844 完成创建、查看 blocker、登记文档和推进，无横向溢出。

### 15.7 真实模型回归

使用现有百炼配置和真实 `qwen3.7-plus` 跑一次 `planning-execution-real` 浏览器场景，Store 使用 v4：

1. 真实消息→规划→用户批准→执行→正式 Assistant Message。
2. 证据记录 Provider/模型、productRunId、最终状态和必要 Hash，不保存正文或凭据。
3. 不在 P1 断言模型读取 Project；该断言属于 P2。
4. 缺凭据、网络失败或 Provider 返回非法合同必须失败关闭，不能用 stub 替代后声称完成。

## 16. 实施顺序（同一 PR，不是分阶段交付）

1. 冻结 Task Book、对象合同、profile fixture、错误族和 E2E 场景。
2. Contracts + Domain，先让模板/状态机/gate 测试通过。
3. Store v4 + v3→v4 迁移 + Integrity。
4. Application Query/Command + API。
5. Project UI + API client。
6. 完整 browser E2E、真实 qwen 回归、调试与文档收口。
7. 自审、修复、Draft PR 证据齐全后请求用户复审。

这些只是一个 PR 内的依赖检查点。不得在第 2、3 或 4 步结束时报告“P1 已完成，下一步做 P2”。

## 17. Git、调试与交付规则

1. 用户批准任务书后，从最新 `origin/main` 创建新的实现 worktree 与 `codex/` 分支；任务书 worktree 不直接承担实现，避免审核中规格与代码混杂。
2. 一个完整实现 PR；除非出现用户未批准的重大范围变化，不再拆成多个等待合并的小 PR。
3. 沿用固定调试端口和安全 preclean；启动前只杀登记且身份复核通过的旧进程，未知占用只报告不杀。
4. Project API 不需要新端口或新进程，应加入现有 API/Web Compound 的同一等待链。
5. 服务器不编译；本地/CI 构建通过后才部署产物。
6. PR 合并后按用户现有治理规则同步 main，并删除该实现分支与 worktree。

## 18. 完成门

只有以下全部成立才可以报告完成：

1. 8 个用户场景均有自动化或明确人工证据。
2. `build / lint / format:check / typecheck / test` 全绿。
3. Store v1→v2→v3→v4、损坏失败关闭和字节级保护通过。
4. 真实浏览器 Project E2E 全绿，覆盖绿地、棕地 quick、轻量、CAS、版本历史、重启和手机。
5. 真实百炼 `qwen3.7-plus` 旧闭环在 v4 Store 上回归通过。
6. Trace 没有正文、URI、密钥、Provider Payload 或任意 attributes。
7. 页面没有 fixture 冒充、没有 LocalStorage 冒充权威状态、没有浏览器推导领域权限。
8. 关键中文注释、目录/架构/API/工作流边界文档与 PROJECT_STATE/PLAN 同步。
9. 自审确认没有万能 Service、重复状态机、跨层直写、过度抽象和超大组件。
10. Draft PR 中列出命令、测试数量、E2E 场景、真实 Provider 证据和已知非范围。

## 19. 审核点

用户审核本任务书时只需重点确认 6 个决定：

1. P1 是否按 1 个完整纵向 PR 交付。
2. `bmad-software.v1` 的 4 个 profile 与 `lightweight.v1` 是否符合项目分流预期。
3. 方法配置是否应在创建时冻结，P1 不允许在线改阶段图。
4. 文档是否只保存 Manifest/版本/Hash，不复制正文。
5. P1 是否只做确定性 Project 基础，P2 再做 Project Context + 模型候选 + Correct Course。
6. Product Store 版本是否按 Project=v4、Rules=v5 调整。

未得到用户明确“批准”前，不得建立实现分支或修改产品代码。
