# Chat 可配置工作流 As-built

> 日期：2026-08-10
> 状态：后端产品事实、运行内核与公开API已落地；旧Web展示层已删除，DSH已接入Planning与Note人工审核表面
> 范围：运行投影、受限定义内核、Planning、Note、Rules、Definition、迁移与验收

## 1. 用户结果

本次实现把“工作流只能写死在代码里”改成两层边界：

1. **节点能力仍由代码和策略注册。** 浏览器不能上传代码、表达式、HTTP节点或任意Executor。
2. **已有节点怎样组合、默认启停、选择哪些资源、使用哪个已发布版本，可以在运行前配置。** 发送消息时服务端把选择编译为不可变RunSpec；本次Run随后只读这个版本。

后端当前已经支持：

- 查询真实Run、节点Input/Output/Timeline/Evidence和受控Trace摘要；
- 为Run选择已发布Planning或Note流程以及Memory、Project、Rules和审核策略；
- 通过严格Command复制、编辑、校验、发布、归档或恢复受限Definition；
- 在Planning审核中要求修订、批准或拒绝；在Note审核中确认、编辑后确认、要求修订或拒绝；
- 刷新、进程重启或重复提交后继续同一产品Run，不重复消费已经提交的决定或副作用；
- 查询正式Note、历史Revision和来源，维护带Revision/Tag/Scope的规则并把精确Rule Revision注入规划。

DSH桥接面已经交付原生对话、Planning HITL与Note Candidate审核。Note审核读取安全DTO并支持确认、要求修订和拒绝；Candidate正文、标签、类型和来源数量在手机/桌面同一卡片中可见。Note列表/历史编辑、Run Viewer、Rules和Definition编辑仍是已存在的Chat API能力，但在对应DSH Client插件完成前不能写成当前用户界面已经可操作。

与原始目标对照，本次真正交付的是受限Kernel、运行观察、Memory/Project/Rules配置化Planning、人工审核循环、执行/验证/提交、Note、Rules和Designer。正式Research产品事实与正式Skill集合/授权/冻结/消费链尚未交付；它们保留为原始目标中的明确延期项，不用兼容节点、空资源目录或`optional_unavailable`冒充完成。

## 2. 实际架构

```mermaid
flowchart LR
  UI["DeepSeek Harness Web\nLifeOS Client插件"] -->|"Bridge Host / REST Query / Command"| API["Hono\n认证、strict校验、ETag"]
  API --> APP["Application\n事务、CAS、权限、投影"]
  APP --> STORE["Product Store v10\n权威产品事实"]
  STORE --> OUTBOX["Outbox\nstart / resume"]
  OUTBOX --> RUNTIME["Vercel Workflow Runtime\n固定Runner解释RunSpec"]
  RUNTIME -->|"私有strict命令"| APP
  RUNTIME --> PI["pi-agent-core\n静态Planner / Note / Executor"]
  STORE --> VIEW["View + NodeRun\nTransition + Manifest"]
  VIEW --> UI
```

责任没有合并：

- Product Store拥有Definition、Revision、RunSpec、Run、Decision、Note、Rule和节点产品证据；
- Workflow Store只拥有耐久步骤、Hook和Checkpoint；
- pi只产生候选，不拥有审批、正式Note或Run成功事实；
- DSH与浏览器只保存会话轨迹、未发送草稿和查询缓存，不拥有产品历史与终态；
- Trace只记录路径、版本、耗时、错误与对象引用，不保存隐藏推理或产品正文。

Note Application按变化原因拆分：公开Query/DTO投影、普通Note维护、冻结Candidate/Policy纯规则和Node/Manifest投影分别在独立模块；`publishNoteCandidate`、`submitNoteDecision`与`commitConfirmedNote`仍各自保留完整Product Store事务，避免为了压缩函数行数把一个原子提交拆成多个Service调用。

## 3. 定义、运行与观察模型

| 对象 | 作用 | 不变量 |
| --- | --- | --- |
| `WorkflowDefinition` | 可变聚合身份 | 只指向current draft/published revision |
| `WorkflowDefinitionRevision` | 一版语义结构 | draft/published/superseded内容与Hash不可原地改写 |
| `WorkflowRunConfiguration` | 本次发送前的有限覆盖 | strict联合；无任意metadata或JSON口袋 |
| `WorkflowRunSpec` | 本次Run的实际执行输入 | 服务端重新编译；绑定Definition、Runner、资源三元组、策略和Hash |
| `WorkflowViewDefinition` | 本次Run的稳定图快照 | 历史Run不读取latest Definition重新画图 |
| `WorkflowNodeRun` | 一个节点、路径、轮次与attempt | 状态机、executionPath和父子关系受Domain约束 |
| `NodeRunTransition` | 节点状态历史 | 序号连续；reason、时间和产品引用与状态匹配 |
| `NodeValueManifest` | 节点输入/输出版本证据 | 只存ref/revision/hash；生成后不可原地改写；queued节点不提前伪造消费事实 |

受限IR只包含Task、Sequence、Choice、BoundedLoop和Composite。结构操作是strict命令：插入、移动、删除可选Task，设置默认activation/config，包装/展开Choice或BoundedLoop以及移动到固定分支。不存在自由edge、任意回边、表达式、代码节点或浏览器指定Executor。

## 4. 可配置字段的真实语义

只有运行链实际消费的字段才公开：

| 节点 | 字段 | 权威执行位置 |
| --- | --- | --- |
| `context.memory` | `required`、`maxItems`、选择的`mrs_*` | Compiler + `PlanningMemorySelection`原子事实；Planning/Execution按Selection精确重读 |
| `context.project` | `required`、Project选择 | `PlanningProjectContext`与Node终态/Manifest同事务 |
| `policy.rules` | `required`、Rule选择 | `RuleSelection`与Node终态/Manifest同事务；正文只经私有Runtime边界 |
| `agent.plan` | `maxSteps` | Application发布Plan前再次校验 |
| `execute.plan` | `maxActions` | Application编译Execution Contract前再次校验，任何Provider调用之前失败 |
| `result.validate` | `strictEvidence` | Application确定性Validation消费并进入产品事实 |
| `note.extract` | `maxCharacters`、默认kind、建议tags | Definition默认值与本次输入按字段合并后进入RunSpec |
| `note.classify` | `allowCustomTags` | Workflow早失败 + Application发布Candidate权威复核 |
| `human.note_review` | manual / policy允许时自动继续 | 低风险固定策略产生`WorkflowPolicyResolution`；超界回到真实人工审核 |

Planning包含执行和产品提交，因此`human.plan_review`始终是manual；公开Catalog、Blueprint和Composer不再展示不可达的自动继续。`always_auto`仅保留为历史合同可识别值，Compiler明确拒绝。

`agent.research`只为旧Definition兼容：新系统Planning已移除，配置为空，运行时固定`skipped/no_evidence`，不会把“没调研”投影成成功。`capability.skills`在没有正式Skill产品集合时只能安全形成`optional_unavailable`，不会伪造Skill已加载。这两项是未交付边界，不计入P6原始G3完成度。

## 5. Planning与Note运行链

### 5.1 Planning

新系统Planning顺序为：

```text
Memory -> Project -> Rules -> Skills（当前仅合同槽位，无正式Skill资源）
       -> bounded_loop(Plan -> Human Review)
       -> Execute -> Validate -> Product Commit
```

Memory、Project、Rules先各自形成不可变选择/上下文事实；这些事实与对应Node终态和Manifest同一Product Store事务提交。Plan修订必须复用上一版全部冻结上下文；批准后Execution只解析Approved Step明确引用的三元组。

Plan、Review、Execute、Validate和Commit由各自业务Application用例拥有running/terminal投影；Runner不再用通用命令二次补写不同摘要或outcome。外部执行结果未知进入`outcome_unknown`，不降级成普通失败或自动重试。

### 5.2 Note

Note流程为`bounded_loop(Extract -> Classify -> Review) -> Commit`。模型只产生Candidate；编辑确认和要求修订创建successor，不覆盖旧Candidate。Decision绑定精确Candidate revision/hash；正式Note Revision、Assistant Message、Run成功和commit Node同事务提交。

低风险自动继续只适用于Note，且Policy Resolution绑定RunSpec、Definition Node、Candidate和固定策略版本/Hash。策略不允许时仍创建可审计Resolution，并进入真实`waiting_human`。

## 6. 前后端合同

公开面提供：

- Workflow Catalog、Blueprint、Published Definition和安全Resource目录；
- Definition detail/validate/copy/save/publish/archive/restore；
- Run View、Node Detail、Run Configuration Summary；
- Note列表、详情、历史、修订、归档/恢复、Candidate审核；
- Rule/Revision/Tag/Scope/lifecycle与安全Selection摘要。

Query使用ETag/`If-None-Match`/304；Bridge Host在切换Run或取消请求时丢弃过期结果。公开DTO不包含Workflow Run ID、Hook Token、pi Session、Provider配置、完整Trace Payload或未授权正文。

写命令使用Command Envelope、CAS revision和稳定commandId。Bridge在网络结果未知时保存pending command；Note修订、归档、恢复和Decision重试复用同一commandId与原payload，不能通过再次点击创建第二个业务事实。

## 7. Checkpoint、恢复与安全

- Planning生成/发布、Note生成/发布、Execution执行/持久化分别合并在单个耐久Step内；Workflow作用域只保留产品ref、outcome和身份，不跨Step携带Message、Memory、Plan输出或Note正文。
- Hook先由产品Decision提交，再由Outbox恢复；edited Note同时区分被claim的旧Candidate和Decision绑定的successor。
- Runtime Binding保存runner family/bundle版本；恢复按当次Run证据分派，不按当前全局默认猜测。
- Runtime私有命令校验RunSpec、节点类型、合法executionPath、activation、状态、终态和产品引用；持有Runtime Key也不能伪造另一路径或在Run终态后创建节点。
- 百炼Host采用精确域名/Workspace正则；当前允许用户已配置并授权且真实验收通过的`coding.dashscope.aliyuncs.com`，Token Plan与同形恶意域名仍在启动或付费调用前失败关闭。Project模型Profile在provider为`bailian`时使用同一安全合同。

## 8. Store与迁移

Product Store当前为`chat-product-store.v10`：

- v6：Workflow View/Node/Transition/Manifest；
- v7：Definition/Revision/RunSpec；
- v8：Note；
- v9：Rules与Planning Project Context；
- v10：Planning Memory Selection与Workflow Policy Resolution。

迁移按版本串行、可重复打开，并对非空历史Fixture执行Zod、生产完整性、只读Auditor和故障注入。v5→v6使用迁移专用冻结投影，不调用会继续演进的当前Application projector。

JSON Store仍是当前单实例Adapter，不宣称多实例数据库、备份或生产容量。未来替换Store不改变上述产品合同。

## 9. 表面退出方式

Workflow Definition/View、Note和Rules均不依赖具体前端渲染库。旧Web使用过的React Flow与Markdown渲染器已经随旧前端删除；DSH接入必须通过公开Slot/Surface消费现有DTO，不把DSH类型写回产品合同。

## 10. 验证与剩余边界

自动门覆盖Contracts、Domain、Application、Store、Workflow、Runtime、API、迁移、并发、权限、IDOR、容量和Checkpoint正文扫描。旧Web浏览器证据只存在于Git历史；当前用户界面必须重新通过DSH真实浏览器纵向，不能沿用旧UI结论。Note Bridge的确定性纵向覆盖Candidate投影、版本/Hash绑定决定、断网原样重试和正式Assistant Message收敛；部署前仍须补真实手机浏览器证据。

既有Planner、Executor与Note Capture真实Provider门已通过并保存脱敏证据。DSH切换后的浏览器门以当前根脚本为准；已删除的旧Web Playwright命令不再是当前完成门。

```text
pnpm test:provider:bailian
pnpm test:provider:bailian:note
pnpm test:e2e:dsh-real
```

Research与Skill仍是产品范围延期，不是Provider问题。Note列表/历史编辑、Definition和Run View的DSH表面尚待单独纵向接入。
