# Work、Knowledge、Protocol、Governance 边界与自然语言写回详细设计

> 状态：**已批准的详细设计；当前实现部分满足，物理拆分尚未执行**（2026-07-30）  
> 工作包：`W4-01`  
> 上位设计：[总体架构](./overall-architecture-proposal.md)、[Product Harness详细设计](./product-harness-detailed-design.md)、[Execution Governance详细设计](./execution-governance-detailed-design.md)  
> 当前事实：这些逻辑所有者仍部分共置在`backend/app/harness`、`backend/app/collaboration_*`与`backend/app/governance`；本文固定公开边界，不授权机械搬目录或重做已验证Schema。

## 1. 结论

Product Harness继续作为Agent和前端使用产品能力的**门面名称**，但不再被视为一个拥有全部事实的大领域模块。其内部稳定分为4个状态所有者：

1. **MOD-WORK**：Project、WorkItem、Plan/PlanNode、ActionItem、责任、状态与依赖。
2. **MOD-KNOWLEDGE**：Note/Revision、Knowledge Source、Rule Reference、Idea候选及其升级关系。
3. **MOD-PROTOCOL**：协作方法Definition/Revision、Binding、覆盖、停用与升级。
4. **MOD-GOVERNANCE**：Intent/Context/Plan/执行/模型/Tool/结果等Decision Subject、Policy、Request、Decision、Grant与Consumption。

自然语言永远先成为`ChangeProposal`或已有模块候选对象；只有用户决定、有效Grant或明确的低风险自动规则才能路由到所有者命令。APP-PROJECTION只生成Read Model和候选ChangeSet，不能直接写这4个所有者的表。

## 2. 为什么必须拆边界

同一句“把英语学习项目改成每天练习，并记住我不喜欢死记硬背”至少包含4种不同变化：

```text
Project/Work变化       -> MOD-WORK
学习笔记/经验候选       -> MOD-KNOWLEDGE / MOD-MEMORY
每日周期定义             -> MOD-SCHEDULE
是否允许这些变化生效     -> MOD-GOVERNANCE
```

如果一个Harness Service直接一次性修改所有表，会出现5个问题：事务所有权不清、候选冒充事实、失败半写、权限无法细分、Projection/Obsidian写回无法安全落地。

## 3. 四个所有者的责任

### 3.1 MOD-WORK

**用户价值**：用户无需回看聊天，也能知道目标、当前阶段、下一行动、谁负责、是否阻塞和完成依据。

**拥有**：

- Project、Project状态与当前里程碑引用；
- WorkItem、父子关系、优先级、状态；
- TaskPlan稳定身份、不可变PlanRevision、PlanNode与依赖；
- ActionItem、责任主体、due时间、状态、Evidence引用；
- Work关联、领域Trace和事务Outbox。

**不拥有**：Note正文、Protocol定义、Approval、Schedule规则、Artifact有效性、Product Run进度。

**公开Queries**：`list_projects`、`get_project`、`get_project_snapshot`、`list_work`、`get_work`、`get_current_plan`、`list_actions`、`list_responsibilities`。

**公开Commands**：`create/transition_project`、`create/transition/reparent_work`、`create/accept_plan_revision`、`create/transition_action`、`link_evidence_reference`。

### 3.2 MOD-KNOWLEDGE

**用户价值**：项目、学习和研究的内容、来源、修订与未决问题可以积累，而不被模型摘要覆盖。

**拥有**：

- Note稳定身份、不可变NoteRevision与状态；
- Note到Project/Work/Evidence/Message的显式Link；
- 外部/内部Knowledge Source Reference及其可用性；
- Rule Reference；
- Idea候选、接受/合并/升级/归档关系；
- 可重建搜索索引的Outbox状态。

**不拥有**：Accepted Memory、Context采用、Project生命周期、Protocol方法定义、Evidence有效性判断。

**公开Queries**：`get_note`、`search_notes`、`list_project_knowledge`、`get_source_status`、`list_ideas`。

**公开Commands**：`capture_note`、`create_note_revision`、`link/unlink_note`、`capture_idea`、`accept/merge/upgrade/archive_idea`、`mark_source_unavailable`。

### 3.3 MOD-PROTOCOL

**用户价值**：学习、研究、项目和内容交付可采用不同协作方法；用户能知道本轮为何采用某套步骤，方法升级不会静默改变在途工作。

**拥有**：

- Protocol Definition与不可变Revision；
- User/Project/Work/System Binding；
- 继承、禁用可选规则、覆盖与选择优先级；
- 激活、停用、兼容和升级状态；
- 对当前场景的有效协议解析结果与revision引用。

**不拥有**：真实PlanNode进度、Policy授权、Prompt正文、Workflow定义、Schedule。

**公开Queries**：`list_definitions`、`get_revision`、`resolve_effective_protocol`、`list_bindings`、`preview_upgrade`。

**公开Commands**：`publish_revision`、`activate/deactivate_definition`、`save/delete_binding`、`accept_upgrade`。

### 3.4 MOD-GOVERNANCE

**用户价值**：用户看见系统准备接受、执行或提交什么，并能批准、修改、拒绝；旧批准不能授权新内容。

**拥有**：

- Decision Point目录；
- Decision Subject及当前精确Hash；
- Policy Set/Revision、Evaluation与Snapshot；
- Human Decision Request、Decision Record；
- Authorization Grant、Consumption；
- Governance Outbox与Runtime Interrupt Link。

**不拥有**：被批准的Project/Work/Note事实、Runtime Checkpoint本体、Tool副作用结果、Evidence有效性。

**公开Queries**：`preview_policy`、`get_effective_policy`、`list_pending_requests`、`get_decision`、`verify_grant`。

**公开Commands**：`evaluate_subject`、`request_human_decision`、`record_decision`、`issue/consume/revoke_grant`、`activate_policy_revision`。

## 4. 对象归属表

| 对象 | 权威所有者 | 可派生视图 | 不能冒充它的对象 |
|---|---|---|---|
| Project/Work/Plan/Action | MOD-WORK | Board、Dossier、Responsibility Lane | Product Session、Prompt、Markdown任务 |
| Note/Revision/Idea | MOD-KNOWLEDGE | Knowledge Garden、Obsidian Note | Accepted Memory、聊天摘要 |
| Protocol Definition/Binding | MOD-PROTOCOL | Method Card、StepInput引用 | Workflow节点、System Prompt |
| Decision/Grant | MOD-GOVERNANCE | Approval Inbox、授权状态 | 模型说“用户同意了” |
| Accepted Memory | MOD-MEMORY | Memory视图 | Note、TurnDigest |
| ContextPackage | MOD-CONTEXT | Context Inspector | 完整历史或文件目录 |
| Schedule | MOD-SCHEDULE | Calendar、Review Queue | due_at、Worker定时器 |
| Evidence/Artifact | MOD-EVIDENCE | Gallery、Coverage | Work中的一段自由文本 |

## 5. 应用用例与事务所有权

### 5.1 单所有者命令

Router/Tool只做解析与认证，调用该所有者的Application Coordinator：

```text
HTTP/Agent Tool
 -> WorkApplication.create_work(command)
 -> 一次Work事务
 -> Work事实 + Trace + Outbox
 -> commit
```

Repository、规则函数、查询投影不得自行提交调用方事务。

### 5.2 跨所有者用例

跨模块不使用一个数据库事务偷偷改4个所有者。采用“来源事实先提交 + 幂等后续命令 + 可见协调状态”：

例：Idea升级为Project。

1. Knowledge记录`IdeaUpgradeRequested`及目标ChangeSet，保留原Idea。
2. Outbox调用Work `CreateProject(command_id=upgrade-id)`。
3. Work幂等创建Project并返回ID。
4. Knowledge记录`IdeaUpgraded(project_id)`。
5. 第2步失败时Idea仍在，状态`upgrade_failed/pending_retry`，不会丢失或冒充已升级。

只有当前物理共库且属于同一逻辑所有者的写可在一个事务内完成；跨所有者原子性必须由明确Saga/Outbox表达。

### 5.3 已批准跨模块提交

Decision先由Governance提交，再由Outbox调用真正所有者命令。所有者命令重新验证：

- Decision Subject类型与资源匹配；
- Grant绑定当前payload hash/revision；
- Principal、Scope、有效期与能力；
- Grant未被消费；
- 当前对象CAS仍成立。

只有在所有者事实成功提交的事务中消费一次性Grant；失败回滚不能消耗授权。

## 6. 自然语言写回协议

### 6.1 ChangeProposal

模型解析自然语言后输出候选，不直接调用写表：

```json
{
  "schema_version": "change-proposal.v1",
  "proposal_id": "...",
  "source": {
    "interaction_id": "...",
    "message_id": "...",
    "model_call_attempt_id": "..."
  },
  "targets": [
    {
      "owner": "MOD-WORK",
      "command_type": "create_project",
      "subject_ref": null,
      "expected_revision": null,
      "payload": {"kind": "learning", "title": "英语口语", "goal": "..."}
    }
  ],
  "assumptions": [],
  "unknowns": [],
  "confidence": "...",
  "proposal_hash": "..."
}
```

规则：

1. 每个target只属于一个Owner；跨模块自然语言拆成多个target。
2. 模型必须列出假设和未知项；无法确定Project归属时不能猜。
3. UI显示人类可读Diff和所有Owner影响；批准绑定完整`proposal_hash`。
4. 修改任一字段生成新revision/hash，旧Decision失效。
5. 低风险自动规则也要产生Decision Record，说明策略和来源。

### 6.2 ChangeSet与命令编译

批准后由应用层把Proposal编译为不可变`ChangeSet`：

- 固定target顺序、命令Schema、stable ID和expected revision；
- 记录Principal/Scope、Decision/Grant和Idempotency key；
- 为跨模块步骤建立依赖和补偿语义；
- 不把自然语言再次交给模型重新解释。

执行时只发送已批准的结构化payload。任何来源revision变化返回`STALE_SOURCE`并显示Diff，不自动套用。

### 6.3 Obsidian/第三方编辑

Adapter读取frontmatter中的`chat_id/source_revision/projection_revision`，计算受支持字段的Diff，生成同一`ChangeProposal`。未知文件、缺ID、路径猜测、二进制附件或不受支持字段都进入`unsupported/needs_review`，不得直接写Product Store。

## 7. 查询与Projection公开边界

APP-PROJECTION只能调用以下稳定Query Port：

```text
WorkProjectionQueries.project_snapshot(project_id, access_context)
KnowledgeProjectionQueries.project_knowledge(project_id, access_context)
ProtocolProjectionQueries.resolve_for_subject(subject_ref, access_context)
GovernanceProjectionQueries.permissions_and_pending(subject_ref, access_context)
```

当前`HarnessProjectionQueryService`是Work/Knowledge物理共置期的显式只读边界。它可以在同一数据库读事务提供owner-local snapshot，但Projection Envelope必须通过source revision vector诚实表达跨Owner非原子快照。

查询返回公开DTO，不返回ORM、Credential、完整Provider Payload、内部Policy条件秘密或隐藏推理。可选Owner失败时，Projection区块标`unknown/error`；整体仍可显示的部分不得被伪装为空。

## 8. 状态机与失败语义

### 8.1 不变量

1. 模型输出不是Work/Note/Memory/Decision事实。
2. Plan revision未接受不能产生正式责任步骤；Action与其来源PlanNode重复时只显示Action承诺。
3. Note修订不自动成为Accepted Memory；Idea不自动成为Project。
4. Protocol升级不改变已绑定RunSpec和历史StepInput。
5. Grant不能跨Subject、Scope、revision或能力复用。
6. Work完成需要Evidence或显式豁免，不因进度条100%自动完成Project。

### 8.2 失败

| 失败 | 结果 |
|---|---|
| Proposal解析失败 | 保留原Message，显示未形成候选 |
| 用户拒绝/修改 | 记录Decision；不写Owner事实或生成新Proposal |
| CAS冲突 | ChangeSet保持未应用，返回当前revision和Diff |
| 第N个跨Owner步骤失败 | 已提交事实不回滚伪造原子性；协调记录部分结果与可恢复下一步 |
| Outbox重复 | 目标Owner以command_id返回同一结果 |
| Projection查询失败 | `unknown/error`，不显示0或“没有” |
| 索引失败 | 权威事实保留，索引进入可重建pending |

## 9. 物理代码演进

目标代码方向：

```text
backend/app/
  modules/
    work/
    knowledge/
    protocol/
    governance/
  application/
    interaction/
    projection/
  interfaces/
    http/
    agui/
    agent_tools/
```

这不是立即搬目录命令。按以下顺序无行为演进：

1. 为当前模块固定公开Query/Command DTO、状态机和架构依赖测试。
2. 从大Service提取纯规则、查询、命令协调器；保持一个用例一个事务所有者。
3. 让Router、Workflow和Projection只引用公开Port。
4. 固定Schema、OpenAPI、Workflow节点、审批Hash和场景指纹。
5. 最后才移动物理包；提供兼容import的短期删除计划，不建立永久双入口。

已落地的`governance/`、`harness/`和`collaboration_*`可以继续物理共置，直到上述门满足。行数只触发审查，不能机械拆成Service-per-method或Repository-per-table。

## 10. 测试矩阵

| 边界 | 必测 |
|---|---|
| Work | 状态机、依赖环、责任、CAS、Evidence完成门、Scope |
| Knowledge | revision、来源撤销、Idea升级幂等、索引失败 |
| Protocol | Binding优先级、停用、升级、旧Run冻结、循环规则 |
| Governance | Hash失效、并发Decision、Grant一次消费、Outbox恢复 |
| 自然语言 | 多target拆分、未知项、用户修改、拒绝、旧revision冲突 |
| 跨Owner | 第一步/中间/最后失败、重复Outbox、恢复和部分结果展示 |
| Projection | 只走公开Query、空/未知/禁止/错误区分、source revisions |
| 重构 | 依赖图、Schema/OpenAPI/Workflow/Hash指纹、全场景回归 |

## 11. 场景穿透

### 11.1 “创建儿童AI学习项目”

1. Message先由Conversation接纳。
2. Intent形成`create_project`候选；必要时澄清目标与受众。
3. ChangeProposal包含Work Project、初始learning Work和可选Protocol Binding，分别归Owner。
4. 用户批准当前Hash。
5. Work创建Project/Work，Protocol创建Binding；任一步失败均有协调状态。
6. APP-PROJECTION读取同一Project ID/revision，Web显示Dossier，Obsidian生成稳定目录。

### 11.2 “记录今天的英语薄弱点，下周提醒复习”

1. Knowledge候选创建learning Note。
2. Schedule候选创建复习规则；Note不能用`due_at`冒充Schedule。
3. 用户可只批准Note、修改Schedule或全部拒绝。
4. Projection在Schedule未实现/失败时显示`unknown`，但Note仍可见。

### 11.3 “这个项目已经完成”

1. Work读取开放Work/Action和Evidence coverage。
2. Governance形成`work_state_commit`/`result_commit`决定Subject。
3. 缺Evidence时要求补证或显式豁免；模型陈述不是完成依据。
4. Work在Grant和CAS有效时提交状态，Evidence保存依据，Projection刷新revision。

## 12. 当前实现与后续缺口

### 12.1 已有证据

1. Project/Work/Plan/Action、Note/Memory候选、Protocol Binding和Governance D1-D7已有真实纵向实现。
2. 模型候选、HITL决定、CAS、Outbox、RunSpec和结果提交门已有大量合同测试。
3. 本轮新增`HarnessProjectionQueryService`，Projection不直接读取私有ORM。

### 12.2 尚未完成

1. 4个Owner的完整物理包与全部公开Port尚未拆完。
2. 通用`ChangeProposal/ChangeSet`及自然语言多Owner写回尚未实现。
3. Idea升级关系、完整Knowledge Source生命周期和Protocol升级服务仍有缺口。
4. MOD-SCHEDULE未实现；不得塞回Work或Protocol。

因此本文关闭D3/W4-01的**详细设计缺口**，工作包保持`in_progress`直到边界合同、自然语言写回与无行为物理演进完成。
