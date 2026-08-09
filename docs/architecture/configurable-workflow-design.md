# Chat 可配置工作流详细架构与方案设计

> 状态：已获用户批准；S1～S7核心实现已落地，但原始目标中的正式Research与Skill资源纵向尚未交付，不能按完整目标宣称完成；实际边界以As-built为准
> 日期：2026-08-09  
> 上位目标：[阶段总纲与验证闭包](../tasks/configurable-workflow-stage-program.md)  
> 研究依据：[参考项目与技术研究](./configurable-workflow-research.md)  
> 文档性质：目标设计，不描述当前已经存在的能力

## 0. 原始目标锚点

本设计始终回到用户最初要求的六个结果：

1. 工作流由Chat预先支持的节点组成，但用户可以在运行前组合、启停和配置。
2. 用户能选择Memory、Project、规则、Skill和审核方式后再发起一次会话工作。
3. 项目规划流程能调研、整理上下文、生成任务书、反复审核、执行、验证和提交。
4. 简单查询、笔记沉淀等不同场景可以使用不同Definition，而不是复制一套硬编码流程。
5. 运行后从左到右显示真实节点；点击节点能查看输入、输出、状态、证据和日志时间线。
6. 架构、代码风格和测试必须可长期演进，不能为了做拖拽界面重造一个低质量n8n。

任何设计如果不能直接服务以上结果，或者削弱Chat既有事实所有权、HITL、耐久恢复和真实E2E，都不进入实现。

### 0.1 原始目标的实际处置

| 原始能力 | 本次已经交付 | 明确延期，不计入完成 |
| --- | --- | --- |
| Planning上下文与任务推进 | Memory Snapshot、Project Context、Rule Revision、Plan/Review循环、Execute、Validate、Commit | 独立Research产品事实、来源证据与受治理调用边界；当前新Planning不执行`agent.research` |
| Skill选择与消费 | `capability.skills`节点合同、资源类型和失败关闭语义 | 正式Skill产品集合、授权查询、冻结Revision/Hash及Runner消费；当前没有真实Skill可选 |

Research和Skill不是从原始目标中删除，而是因缺少对应产品事实与授权边界明确延期。最终发布说明必须把P6核心交付与这两项延期分别列出；除非用户接受范围调整或后续纵向真实完成，不能把G3或全部原始目标标记为“完整”。

## 1. 参考项目如何转化为Chat设计

| 来源 | 采用 | 按Chat调整 | 明确拒绝 |
| --- | --- | --- | --- |
| Activepieces | typed action、DRAFT/LOCKED启发、运行节点Input/Output/Timeline、循环执行路径、结构化横向布局 | 节点配置改为Chat有限联合；运行正文改用产品引用 | 任意Piece市场、通用Code节点、通用disabled透传 |
| Dify | Workflow Run快照、Node Execution、Human Input动作与超时、LLM运行查看体验 | 画布与可执行IR分离；人工动作先成为Chat Decision | 整张React Flow图直接作为执行事实、可变graph对象复用 |
| Windmill OpenFlow | sequence、choice、loop、suspend的显式结构语义 | 分支只匹配枚举outcome，循环必须有上限 | 任意脚本、任意表达式、公开resume URL |
| n8n | 节点目录和执行查看器作为产品参照 | 只用来识别复杂度边界 | 多输入Join、partial execution、pin data、任意回边和通用图执行栈 |
| React Flow | 画布渲染、节点选择、缩放和平移 | 只在Web消费Chat DTO；节点不可自由连边 | 保存坐标/edges为权威Definition，首期引入ELK |
| Vercel Workflow | Step、Hook、Checkpoint、代码转换和恢复 | 固定Runner解释运行前编译的RunSpec | 每个用户Definition生成代码；浏览器持有Runtime ID |
| Memos | Markdown快速捕获、标签检索、简洁时间线 | 标签由用户或模型Candidate确认，不从正文自动变正式事实 | 自动抽取井号标签即成为权威标签、社交与分享范围 |
| Joplin | Note、Revision、Tag作为独立可查询资源 | 采用最小Note聚合和修订历史 | Notebook树、同步协议、附件生态进入本阶段 |

该表只证明设计有真实参照。Chat的Product Run、Decision、Note、Definition和Node Run仍由Chat产品语义决定。

## 2. 总体架构

~~~mermaid
flowchart LR
    subgraph Web["apps/web"]
        Composer["发送前Workflow配置"]
        RunView["左到右Run Viewer"]
        Inspector["Node Inspector"]
        Designer["受约束Definition Designer"]
    end

    subgraph API["apps/api"]
        Public["Hono公开Query/Command"]
        Private["Workflow私有Command"]
        Dispatcher["Outbox Dispatcher"]
    end

    subgraph Application["packages/application"]
        Catalog["Node Catalog / Blueprint"]
        Compiler["Definition Validator / RunSpec Compiler"]
        UseCases["Run / Node Run / Decision / Note用例"]
        Queries["Workflow View / Node Detail Query"]
    end

    subgraph Product["Domain + Product Store"]
        Definitions["Definition / Revision"]
        Specs["RunSpec / View Snapshot"]
        Runs["Product Run / Node Run / Transition"]
        Business["Plan / Approval / Note / Evidence"]
    end

    subgraph Runtime["packages/workflows"]
        Runner["Structured Workflow Runner"]
        Executors["Static Node Executor Registry"]
        Hooks["Typed Human Review Hooks"]
    end

    Web --> Public
    Public --> Application
    Application --> Product
    UseCases --> Dispatcher
    Dispatcher --> Runner
    Runner --> Executors
    Runner --> Hooks
    Executors --> Private
    Private --> UseCases
    Queries --> RunView
    Queries --> Inspector
~~~

### 2.1 不新增万能平台包

首期沿用现有Workspace责任，不创建workflow-engine、workflow-platform或万能plugin package：

- 网络与持久化Schema：packages/contracts。
- 纯结构、状态机和不变量：packages/domain。
- Catalog、Compiler协调、Command和Query：packages/application。
- JSON迁移与完整性：packages/product-store-json。
- Hono和组合根：apps/api。
- Vercel Runner、Hook和静态Executor：packages/workflows。
- 画布、Composer、Inspector、Designer：apps/web。
- 纵向与架构验证：packages/testing及真实E2E脚本。

如果后续两个以上运行适配器真实要求复用同一内核，再评估独立package；本阶段不为假想替换提前抽包。

## 3. 核心产品对象

### 3.1 Workflow View Definition Snapshot

作用：保证当前和历史Run都能显示当时的用户可见图，而不依赖当前代码或最新Definition。

建议字段：

- workflowViewDefinitionId，产品身份前缀wvd。
- schemaVersion。
- sourceKind：legacy_code、published_definition。
- definitionId/revision/hash，可选；旧固定Run使用legacy source。
- title、blueprintKey、blueprintVersion。
- nodes：仅用户可见节点的稳定ID、类型、标题、层级和可展开信息。
- edges：control、outcome、loop_back等有限语义边。
- sha256、createdAt。

约束：

1. 不保存React Flow position。
2. 不保存Executor key、Hook Token或内部Step。
3. 新Run在发起事务中固定snapshot引用。
4. 历史固定Run通过Store迁移生成legacy snapshot；不能查询时用当前代码临时猜。

### 3.2 Workflow Node Run

作用：表达一个Definition节点的一次真实执行实例。

建议字段：

- workflowNodeRunId，前缀wnr。
- productRunId、workflowViewDefinitionId、runSpecId可选。
- definitionNodeId、nodeType、nodeSchemaVersion。
- executionPath：有序的loop node ID与iteration对。
- attemptNumber。
- parentNodeRunId，可选；用于Composite动态子运行。
- status：queued、running、waiting_human、succeeded、failed、skipped、cancelled、outcome_unknown。
- outcomeCode，可选；只能是节点描述允许的枚举。
- inputManifestId/outputManifestId或对应小型内嵌引用。
- publicSummary、error、startedAt、finishedAt、durationMs。
- revision、createdAt、updatedAt。

唯一约束：

~~~text
productRunId
+ definitionNodeId
+ canonical executionPath
+ attemptNumber
~~~

相同组合重放必须返回同一个Node Run；Retry创建新的attemptNumber，不重新打开终态对象。

### 3.3 Node Run Transition

作用：保存用户可见的稳定运行历史，不把原始Trace冒充产品时间线。

建议字段：

- nodeRunTransitionId，前缀wnt。
- workflowNodeRunId、nodeSequence。
- fromStatus、toStatus。
- reasonKind：started、waiting_human、resumed、completed、skipped、failed、cancelled、unknown。
- relatedProductRef，可选。
- occurredAt。

约束：

1. nodeSequence在单个Node Run内递增。
2. Transition与Node Run当前状态在同一产品事务提交。
3. 不保存用户正文、Prompt、Provider Payload或Stack。
4. 未来Runtime Journal可以投影这些事实或发失效提示，但不反向拥有它们。

### 3.4 Node Value Manifest

节点输入输出不使用任意JSON袋子。Manifest由命名slot和有限Product Ref联合组成：

- message。
- context_package。
- project_context。
- rule_selection。
- plan_revision。
- approval_request。
- decision。
- execution_contract。
- execution_candidate。
- validation_result。
- artifact。
- note_candidate。
- note_revision。

每个Ref至少包含产品ID、revision、sha256和安全label。小型控制结果使用Node Run outcomeCode，不创建无价值Artifact。

完整正文仍只存在于相应产品对象；公开Node Detail按权限读取安全预览。

### 3.5 Workflow Definition与Revision

Workflow Definition是用户保存的聚合身份：

- workflowDefinitionId，沿用wfd。
- ownerPrincipalId或system owner。
- blueprintKey、blueprintVersion。
- displayName、description。
- origin：system、user_copy。
- currentDraftRevisionId，可选。
- publishedRevisionId，可选。
- status：active、archived。
- revision、createdAt、updatedAt。

Workflow Definition Revision是不可变语义版本：

- workflowDefinitionRevisionId，前缀wfr。
- workflowDefinitionId。
- definitionRevision，单调递增。
- state：draft、published、superseded。
- semanticRoot。
- workflowViewDefinitionId。
- sha256、createdByPrincipalId、createdAt。

规则：

1. 每次保存产生新draft revision；旧draft变superseded。
2. 发布只接受当前draft及其expected revision/hash。
3. 发布后旧published变superseded，但历史Run引用不变。
4. Run只能使用published revision；首期不引入特殊draft test runtime。
5. system Definition也使用同一模型，S4先放入Planning，S5再放入Note。

### 3.6 Run Configuration与RunSpec

Run Configuration是浏览器提交的有限覆盖，不保存任意config对象。首期覆盖联合：

- node_enabled。
- memory_selection。
- project_selection。
- rule_selection。
- skill_selection。
- review_mode。

每个覆盖必须带definitionNodeId并由Blueprint声明可覆盖。

Definition中的optional Task可以保存defaultActivation：enabled或skipped；只有Blueprint允许optional且Node skipPolicy可安全给出默认outcome时才允许skipped。它不是传给Executor的通用disabled字段。每次Run仍在RunSpec中保留该节点及明确skip resolution，历史Viewer能显示skipped而不是让节点消失。

RunSpec是Application编译后、本次运行唯一使用的事实：

- workflowRunSpecId，前缀wrs。
- productRunId。
- definition revision/ref/hash。
- runnerFamily与runnerBundleVersion。
- normalized semanticRoot。
- resolved node configs。
- Memory、Project、Rule、Skill等精确revision/hash引用。
- review policy resolution。
- limits。
- executor schema manifest。
- sha256、createdAt。

RunSpec不保存密钥、endpoint或Provider凭据。正文过大时保存产品引用，不复制进Outbox。

### 3.7 Product Run演进

Product Run增加runKind与工作流引用：

- runKind：planning、note_capture。
- workflowViewDefinitionId。
- workflowRunSpecId，新动态Run必有，legacy Run可无。
- currentNodeRunId，可选。

现有planning phase暂时保留在planning分支，避免S1行为重写；Note使用自己的受限phase联合。S2以后主要依赖Workflow View，不再从phase猜图。

这应使用严格判别联合，而不是不断给Product Run添加互相无关的optional字段。

## 4. Node Catalog与Blueprint

### 4.1 Catalog Descriptor

每种Node Type的服务端描述包含：

- nodeType与schemaVersion。
- displayName、description、category。
- configSchema：真实Zod或等价运行时解析器，只存在服务端。
- publicConfigFields：有限表单字段联合。
- inputSlots、outputSlots与outcome enum。
- skipPolicy。
- riskPolicy。
- executorKind：step、human_review、container、composite。
- supportedBlueprints。

Public Config Field首期只允许：

- boolean。
- enum_select。
- bounded_integer。
- short_text。
- resource_selector。
- rule_selector。
- skill_selector。
- review_mode。

不直接把Zod、任意JSON Schema、JavaScript表达式或secret field发给浏览器。Catalog conformance测试确保公开字段名、默认值与真实config parser一致。

### 4.2 Blueprint

Blueprint规定某类工作流允许如何变化：

- blueprintKey/version。
- runnerFamily。
- allowedNodeTypes。
- requiredNodeIds或required roles。
- allowedSequenceSlots。
- allowedBranches与outcome。
- allowedLoops、最大嵌套与最大迭代策略。
- perRunOverridable fields。
- immutable risk rules。
- required terminal product commit role。

Planning Blueprint：

~~~text
message
→ context.memory?
→ context.project?
→ policy.rules?
→ capability.skills?
→ agent.research?
→ bounded review loop(agent.plan + human.plan_review)
→ execute.plan
→ result.validate
→ product.commit
~~~

Note Blueprint：

~~~text
message/selection
→ note.extract
→ note.classify
→ human.note_review?
→ note.commit
~~~

## 5. 结构化语义IR

### 5.1 元素联合

语义Root是Sequence。递归元素仅有：

1. Task：执行一个已注册Node Type。
2. Choice：读取前序Node的枚举outcome，进入一个分支。
3. BoundedLoop：执行body，按声明outcome继续或退出。
4. Composite：把运行时产生的有界子任务展开为子Node Run。

Human Review是特殊Task类别，Runner负责Hook，业务Decision仍由Application拥有。

### 5.2 受限条件

Choice条件只能是：

~~~text
from definitionNodeId
select outcomeCode
match Catalog声明的枚举值
~~~

不支持字符串表达式、变量脚本、隐式truthy或跨节点任意JSONPath。

BoundedLoop必须声明：

- maxIterations。
- body。
- continueOutcomes。
- exitOutcomes。
- exceededPolicy：fail或request_human，不允许静默继续。

### 5.3 递归类型质量

参考Activepieces递归类型的TypeScript计算问题：

1. TypeScript递归类型手写，不依赖无界z.infer展开。
2. Zod只在边界使用z.lazy，解析后再运行显式深度/节点预算遍历。
3. 所有遍历使用显式guard，不能假定Schema已经防住运行时复杂度。
4. 测试覆盖limit、limit+1、深嵌套、重复ID和循环错误。

## 6. Definition校验与RunSpec编译

### 6.1 校验顺序

1. DTO大小、strict Schema和版本。
2. Blueprint存在且版本受支持。
3. 节点ID唯一、类型注册、Schema版本兼容。
4. 结构深度、节点数、分支数和循环预算。
5. required role、终点和可达性。
6. input/output slot类型。
7. outcome、Choice、Loop和skip policy。
8. risk policy与人工审核要求。
9. 用户权限与Definition revision/hash。
10. 本次资源引用、revision、Hash和可用能力。

任何错误在Workflow Start Outbox之前返回稳定Problem Detail；不允许半启动后才发现Definition非法。

### 6.2 规范化与Hash

规范化规则：

- 保留Sequence语义顺序。
- 对语义无顺序的集合按稳定key排序。
- 去除View State和未声明默认值。
- 所有默认值显式展开。
- 时间、随机数和环境值不参与Definition Hash。
- RunSpec加入实际解析的资源ref、policy和版本证据。

Definition Hash与RunSpec Hash分别计算，不互相代替。

### 6.3 资源解析

Application读取已经提交的Memory/Profile、Project Context、Rule Revision和Skill Capability：

- explicit selection优先。
- disabled/archived/过期revision拒绝。
- required引用失败关闭。
- optional引用形成明确exclusion，不静默消失。
- Provider/Memory endpoint和密钥永远不进入RunSpec。

## 7. Node Run事务模型

### 7.1 原则

Node Run不是Workflow日志镜像。它必须和对应业务事实一起收敛：

- compilePlanningInput创建planning Attempt时，原子开始agent.plan Node Run。
- publishPlanForReview提交Plan与Approval时，原子完成agent.plan并把human.plan_review置为waiting_human。
- submitPlanDecision提交Decision时，原子完成review Node Run；Resume Outbox仍在同事务。
- beginExecutionAttempt原子创建execute child Node Run。
- completeRunAttempt原子结束execute child Node Run。
- persist/validate/commit分别在自己的业务事务中更新对应Node Run。
- Note Candidate、Note Decision和Note Commit同样遵守。

不能先提交业务事实、再用另一个“最好成功”的通用日志Command补Node Run，否则崩溃会留下永久不一致。

### 7.2 通用Command只用于没有业务事实的边界

允许通用内部Command：

- queueNodeRun。
- beginNodeRun。
- markNodeRunSkipped。
- failNodeRun。

业务成功终态优先由业务Application用例原子提交。

### 7.3 Retry

1. Vercel重放同一个Step使用相同Command ID，命中Receipt，不创建第二Node Run。
2. 安全重试创建新attemptNumber和新Node Run。
3. 外部写入失联进入outcome_unknown，不自动新建attempt。
4. Product Commit重试复用已验证候选和同一幂等Command。

## 8. Runner设计

### 8.1 固定代码Runner

Vercel Workflow仍由代码转换。动态部分是Runner读取经过校验的RunSpec：

~~~text
loadRunSpec
→ executeSequence
   → executeTask
   → executeChoice
   → executeBoundedLoop
   → executeComposite
→ settleProductRun
~~~

新增Node Type仍需要实现静态Executor、测试、版本证据和部署。

### 8.2 Executor Registry

packages/workflows拥有静态映射：

- context.memory。
- context.project。
- policy.rules。
- capability.skills。
- agent.research。
- agent.plan。
- human.plan_review。
- execute.plan。
- result.validate。
- product.commit。
- note.extract。
- note.classify。
- human.note_review。
- note.commit。

Executor不打开Product Store；它调用已有或新增的API私有Application Command。

### 8.3 Human Review

Human节点由Runner特殊处理：

1. 业务Application先创建Plan Approval或Note Candidate Review事实。
2. Runner创建对应typed Hook。
3. Runtime Binding保存产品Review Ref到Hook Token的私有映射。
4. 浏览器提交Plan Decision或Note Decision Command。
5. Application先提交决定与Resume Outbox。
6. Dispatcher恢复Hook。
7. Runner重新读取已提交决定，不能信任Hook Payload正文。

policy auto-continue不创建假的human Decision：

- 由Application编译policy resolution。
- Node Run记录policy_auto_continue。
- actor是system_policy。
- Policy Resolution绑定运行前用户配置、实际候选revision/hash和策略revision/hash。
- 高风险动作不允许该结果；当生成后的实际Execution Contract达到强制人工等级时，即使运行前选择auto也必须进入waiting_human并绑定当前Plan的human Decision。

### 8.4 旧Runner兼容

S4新增Runner版本，不原地改变活动planning-execution-workflow.v2：

- 已活动旧Run继续由原Bundle恢复。
- 新Run在切换门后使用新Runner和RunSpec。
- 本地旧版本不兼容仍按现有version recovery收敛。
- 历史Product Run依赖保存的View Snapshot/Node Run，不依赖旧Bundle才能查看。

## 9. API设计

### 9.1 Query

~~~text
GET /api/workflow-node-types
GET /api/workflow-blueprints
GET /api/workflow-definitions
GET /api/workflow-definitions/:definitionId
GET /api/runs/:runId/workflow-view
GET /api/runs/:runId/workflow-nodes/:nodeRunId
GET /api/notes
GET /api/notes/:noteId
~~~

列表使用服务端Cursor。Workflow View返回图和Node Run摘要；Node Detail按需返回安全Manifest、Timeline和动作。

### 9.2 Command

~~~text
POST /api/sessions/:sessionId/messages
POST /api/workflow-definitions
POST /api/workflow-definitions/:definitionId/drafts
POST /api/workflow-definitions/:definitionId/validate
POST /api/workflow-definitions/:definitionId/publish
POST /api/workflow-definitions/:definitionId/archive
POST /api/runs/:runId/decisions
POST /api/note-candidates/:candidateId/decisions
~~~

不使用一个万能PATCH修改Definition。每个写动作带commandId；修改现有聚合带expectedRevision；发布再绑定draft revision和Hash。

### 9.3 Workflow View DTO

摘要包含：

- Product Run状态与runKind。
- View Definition ref/hash。
- nodes：定义节点、最近/当前Node Run摘要、可展开子运行计数。
- edges：有限语义和选中outcome。
- currentNodeRunIds。
- updatedAt。

Node Detail包含：

- Node Run身份、状态、attempt、executionPath和时间。
- 安全配置快照。
- input/output manifests与预览。
- Product refs、Evidence和允许动作。
- Public Timeline。
- 安全错误与recoveryAction。

公开DTO不含Runtime identity、Executor key、raw Trace或Provider原始错误。

## 10. 前端设计

### 10.1 组件与状态边界

建议结构：

~~~text
apps/web/src/workflows/
  api/
  hooks/
    use-workflow-view.ts
    use-node-detail.ts
    use-workflow-definitions.ts
  graph/
    project-workflow-graph.ts
    layout-structured-lr.ts
    run-node.tsx
    run-edge.tsx
  inspector/
    node-inspector.tsx
    input-panel.tsx
    output-panel.tsx
    timeline-panel.tsx
    evidence-panel.tsx
  composer/
    workflow-picker.tsx
    run-config-panel.tsx
  designer/
    definition-designer.tsx
    node-config-form.tsx
    structure-operations.ts
~~~

不继续膨胀use-real-chain.ts；Workflow Query使用独立hooks，RealWorkspace只组合结果。

### 10.2 Run Viewer

- read-only React Flow。
- nodesDraggable=false、nodesConnectable=false。
- stable graph layout，不因状态更新重算位置。
- 只有Definition结构变化时重算。
- 当前节点变化只更新data/class。
- 用户检查某节点时不自动fitView。
- “定位当前节点”是显式按钮。
- Loop主图只画稳定回边；每次iteration在Inspector中展示。

### 10.3 Inspector

页签：

1. 概览。
2. 输入。
3. 输出。
4. 时间线。
5. 证据。

Human Review节点在概览中嵌入现有Plan审核或Note审核内容。审核Action继续使用原Command与Pending Command恢复语义。

### 10.4 Composer

1. 选择Blueprint允许的published Definition。
2. 读取Definition和Catalog形成有限配置控件。
3. 只生成Run Configuration联合。
4. PendingSend必须同时保存Definition ref/hash和配置；网络结果未知时原样重试。
5. 服务端能力未开放时不显示可点击的假配置入口。

### 10.5 Designer

Designer不提供自由连线：

- 添加到Blueprint允许的slot。
- 顺序拖拽只产生move语义操作。
- 启停只作用于optional task。
- Choice和Loop由专门容器表单创建。
- config表单来自Public Config Fields。
- 保存前本地提示，最终以后端validate为准。
- View State只保存在浏览器偏好，不进入Definition Hash。

## 11. Note Capture最小产品设计

### 11.1 为什么Note是产品资源

用户希望有一个长期笔记位置，并区分Idea、项目想法、学习主题等。Assistant Message、Trace或Workflow Output都不能替代可查询、可修订、可打标签的Note。

### 11.2 最小对象

Note：

- noteId，前缀nte。
- ownerPrincipalId。
- currentRevisionId。
- status：active、archived。
- revision、createdAt、updatedAt。

Note Revision：

- noteRevisionId，前缀ntr。
- noteId、noteRevision。
- title。
- kind：idea、project_idea、learning、general。
- content：Markdown。
- tags：{key,label}有限数组；key按版本化Unicode规范规则生成并去重，label保存安全显示文本，二者都有数量和长度上限。
- sourceRefs：Message/Selection及Hash。
- sha256、createdAt。

Note Candidate：

- noteCandidateId，前缀ntc。
- productRunId、source refs。
- candidateSequence、supersedesCandidateId可选。
- proposed title/kind/content/tags，创建后内容不可变。
- status：under_review、confirmed、revision_requested、rejected、failed。
- revision、sha256；用户编辑或request_revision产生新的successor Candidate，不覆盖旧候选。

Note Decision：

- noteDecisionId，前缀ntd。
- candidate ID/revision/hash。
- kind：request_revision、confirm、reject。
- principalId、commandId、createdAt。

### 11.3 参考项目调整

- 采用Memos的Markdown快速捕获和标签过滤。
- 采用Joplin把Note和Tag/Revision视为正式资源的思路。
- 不采用Memos从正文井号自动产生正式标签；模型和解析器只能提出Candidate。
- 不在P6加入分享、评论、附件、同步、Notebook树和公共可见性。

## 12. 大输入输出、隐私与容量

### 12.1 不拍脑袋确定阈值

实现阶段先收集真实B2 Plan、Memory Context、Project Context、Execution Candidate和Note样本分布，再以Activepieces的截断/切片方式为参考选择：

- inline preview上限。
- Artifact offload阈值。
- Definition节点/深度/分支/循环上限。
- Viewer初始渲染预算。
- Timeline分页与保留策略。

所有阈值成为版本化常量，测试limit和limit+1。未完成测量前不在架构稿中虚构整数。

### 12.2 安全摘要

每个Node Type提供自己的public projector：

- 决定哪些config字段可见。
- 决定input/output的摘要。
- 决定错误和metrics。
- 默认拒绝未知字段。

禁止使用一个通用JSON.stringify把Executor输入输出送到浏览器。

## 13. 错误族

在现有Problem Detail基础上增加有限错误：

- workflow_definition_invalid。
- workflow_definition_conflict。
- workflow_definition_version_unsupported。
- workflow_node_type_unsupported。
- workflow_policy_forbidden。
- workflow_run_spec_invalid。
- workflow_node_transition_invalid。
- workflow_limit_exceeded。
- note_candidate_conflict。
- note_candidate_invalid。

网络结果未知继续使用retry_same_command；Definition结构错误不可重试，必须修订；revision冲突使用rehydrate_and_retry。

## 14. Store与迁移

### 14.1 串行版本

实际版本号必须从任务开始时main的最新Schema继续，不能在当前稿预占固定下一版本号：

1. S1：新增View Snapshot、Node Run、Transition和legacy backfill。
2. S4：新增Definition、Definition Revision和RunSpec；泛化workflow start/resume Outbox。
3. S5：新增Note、Note Revision、Candidate、Decision及Note Run分支。
4. S6优先复用S4模型；除非真实合同缺口，不新增Schema版本。

### 14.2 Legacy backfill

旧Planning Run只从已提交Product事实生成：

- Context节点来自Context Request/Package。
- Planning节点来自Planning Attempt与Plan Revision。
- Review节点来自Approval与Decision。
- Execute子节点来自Execution Attempt和Step Result。
- Validate/Commit节点来自Validation、Final Message和Run终态。

无法证明的细粒度时间不伪造；Transition标记projectionSource=legacy_product_facts。迁移结果必须Hash稳定、可重复并通过完整性校验。

### 14.3 回滚

每个Schema任务：

- rename前失败保留旧文件。
- 成功迁移后不自动向下写旧Schema。
- PR回滚前必须使用其兼容读取版本或恢复迁移前备份，不能让旧代码打开新Schema猜测。
- 真实生产数据库替换不在本阶段冒充完成。

## 15. 代码质量设计

### 15.1 文件责任

1. 不创建WorkflowService、WorkflowRepository-per-table或万能utils。
2. contracts按workflow-definition、workflow-run、workflow-api、workflow-internal-runtime拆文件。
3. domain按workflow-structure、workflow-node-run、workflow-policy拆文件。
4. application按definition commands、run compiler、node run coordination、workflow queries拆文件。
5. workflows按runner、control containers、node executor family拆文件。
6. web按graph、inspector、composer、designer拆目录。

### 15.2 规模与风格

- TypeScript strict、noUncheckedIndexedAccess、exactOptionalPropertyTypes。
- 网络/Store/Runtime边界strict Schema。
- 不新增any；unknown必须缩窄。
- 不使用Record<string, unknown>作为扩展口袋。
- 函数超过80行、React Hook/组件超过500行、模块超过800行触发责任审查。
- Command ID、revision、Hash、Product ID与Runtime ID的中文注释解释是什么、为什么、怎样失败。
- 纯函数不读取全局时间、随机或环境；由组合根注入。
- 业务成功与Node Run状态尽量同事务提交。

### 15.3 测试覆盖的定义

本模块不以一个好看的全仓line percentage代替行为覆盖。强制覆盖：

1. 每个状态机全部合法转换和全部非法终态重开。
2. 每个IR联合成员、Node status、Run kind、Decision kind和Problem code至少一个正例与反例。
3. 每个公开Command有happy、strict validation、CAS、commandId replay和commandId conflict。
4. 每个Store迁移有空/非空/损坏/悬空/Hash/IO失败。
5. 每个Node public projector有秘密与正文canary。
6. 每个Runner control container有正常、边界、重启和超限。
7. 每个用户界面有loading、empty、success、waiting、failed、unknown、窄屏和键盘。
8. Planning与Note各有真实纵向门，S7有组合门。

任务开始时可引入与当前Vitest匹配的coverage provider作为开发证据，但必须先记录版本、许可证和退出方式。Coverage报告用于发现未执行分支；不得为了阈值写无断言测试。

## 16. 明确拒绝的方案

1. 前端保存任意React Flow图，后端按边解释。
2. 每个用户Definition动态生成TypeScript再构建Workflow。
3. 把Vercel Workflow Run/Step直接作为Product Run/Node Run。
4. 直接把Trace JSONL暴露给浏览器。
5. 给所有节点一个disabled/pass-through统一语义。
6. 用一个万能Node Executor接口吞掉Human Hook、外部副作用和Product Commit差异。
7. 为快速上线把Definition、RunSpec和Node Run塞进Product Run任意metadata。
8. 先做完整自由编辑器，再补服务端校验和真实Runner。
9. 用Note Assistant Message冒充正式Note。
10. 为Reminder提前宣称已经调度外部通知。

## 17. 需要由任务证据决定的参数

以下不是架构方向问题，进入对应任务后以真实Spike决定：

1. React Flow精确版本与安装Hash。
2. inline preview、Artifact offload和Timeline分页阈值。
3. Definition最大节点、深度、分支和循环数。
4. LR布局在最大允许图上的渲染预算。
5. legacy backfill是否需要单独存View Snapshot去重。
6. scoped coverage的最低基线与慢测试拆分。

任务必须把测量数据和最终常量写入version evidence或相应合同，不能只留在PR讨论。

## 18. 参考证据

- [Activepieces Run Debugging](https://www.activepieces.com/docs/flows/debugging-runs)
- [Activepieces Durable Execution](https://www.activepieces.com/docs/install/architecture/durable-execution)
- [Activepieces Limits](https://www.activepieces.com/docs/install/reference/limits)
- [Activepieces固定源码：Execution Journal](https://github.com/activepieces/activepieces/blob/e91c79d302b3ce9b46c66918b109ff420fba0a65/packages/core/execution/src/lib/flow-run/execution/execution-journal.ts)
- [Dify固定源码：Workflow和Node Execution](https://github.com/langgenius/dify/blob/7522ae14b25fe7b431eca8a643232fce990b3e8b/api/models/workflow.py)
- [Dify固定源码：Human Input](https://github.com/langgenius/dify/blob/7522ae14b25fe7b431eca8a643232fce990b3e8b/api/core/workflow/nodes/human_input/entities.py)
- [Windmill OpenFlow](https://www.windmill.dev/docs/openflow)
- [n8n Workflow Execute源码](https://github.com/n8n-io/n8n/blob/master/packages/core/src/execution-engine/workflow-execute.ts)
- [React Flow Layouting](https://reactflow.dev/learn/layouting/layouting)
- [Vercel Workflow Code Transform](https://useworkflow.dev/docs/how-it-works/code-transform)
- [Vercel Workflow Hooks](https://useworkflow.dev/docs/foundations/hooks)
- [Memos Memo模型固定源码](https://github.com/usememos/memos/blob/4e8b262d6d739b6fc6979ece398a481c86331c0c/proto/api/v1/memo_service.proto)
- [Memos Tags文档](https://usememos.com/docs/usage/tags)
- [Joplin Data API](https://joplinapp.org/help/api/references/rest_api/)
