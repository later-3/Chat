# S1任务书：当前Run产品投影

> 状态：已批准，待实现验收  
> 阶段目标：不改变当前Planning执行顺序，先让每个现有Run拥有可恢复、可查询、可审计的节点级产品投影  
> 前置：[阶段总纲](./configurable-workflow-stage-program.md)  
> 架构依据：[详细架构第3、7、9、14节](../architecture/configurable-workflow-design.md)

## 0. 阶段约束

1. 不引入用户可编辑Definition，不切换现有planning-execution-workflow。
2. Node Run不是Trace别名；状态、输入输出引用和业务事实必须由Product Store拥有。
3. 旧Run只能回填能从既有产品事实证明的节点，不伪造开始时间、模型调用或细分步骤。
4. 浏览器仍只用Product Run ID；公开合同不得出现Workflow Run ID、Hook Token、pi Session ID或内部Outbox ID。
5. 不修改现有审核幂等、外部结果未知、Execution Contract和Artifact提交语义。

阶段完成时必须能回答：这次Run当时有哪些用户可见节点、每个节点真实到哪一步、它消费和产生了哪些产品对象、为何停下或失败、重启后这些答案是否相同。

## S1.1 Workflow View Snapshot与稳定身份合同

### 目标与结果

为当前硬编码Planning流程建立不可变的用户可见图快照合同。新Run在创建时绑定快照；历史Run可以读取迁移生成的legacy快照，前端不再根据run.phase或当前代码临时拼图。

### 方案

1. 在packages/contracts增加workflow-view持久化Schema、ID解析器与公开DTO映射所需类型。
2. 在packages/domain增加纯验证：节点ID在快照内唯一、边端点存在、结构无不可达用户节点、Hash覆盖所有语义字段但不含createdAt。
3. 先提供一个版本化的legacy Planning View Factory，输出以下稳定节点角色：context、plan、review、execute、validate、commit；execute允许标记为container。
4. 快照只存nodeId、nodeType、label、role、parent、受控edge语义和source信息，不存React Flow坐标、Runtime Step、凭据或处理函数名。
5. 运行创建用例必须拿到快照ID和Hash后才能创建Product Run；当前阶段允许所有新Planning Run共享同一不可变legacy快照对象。

### 约束与失败

- nodeId使用Definition局部稳定标识，不使用数组下标、显示标题或运行时生成ID。
- Factory变化必须提升blueprintVersion并产生新快照；不得覆盖已有快照。
- Hash不一致、边指向未知节点、重复nodeId时拒绝启动新Run，返回内部配置错误而非容错修复。
- 本任务不创建Node Run，不改公开API，不安装画布依赖。

### 测试设计

1. Schema：合法Planning快照通过；未知字段、空节点、重复节点、悬空边失败。
2. 确定性：字段插入顺序不同仍得到相同规范Hash；语义字段变化必改Hash；createdAt变化不改Hash。
3. Factory golden test：精确断言六个角色、父子关系和边语义；快照Fixture经parse/stringify/parse不漂移。
4. 架构：domain不依赖React Flow、Vercel Workflow或Hono；contracts不导入web/runtime。
5. 安全：快照序列化结果扫描workflowRunId、hook、token、sessionId、executor函数名等禁入字段。

### 完成门

- 新Run创建路径在测试中无法构造没有View Snapshot引用的非legacy Product Run。
- 当前Planning可见图由一个版本化Factory产生，测试能发现任意节点或边的意外变化。
- 产物被S1.2和S1.3真实消费，无孤立抽象。

## S1.2 Node Run、Transition与Value Manifest状态机

### 目标与结果

建立节点执行的权威产品对象和状态机，使节点状态、时间线、输入输出引用在重放与重启后仍有一致含义。

### 方案

1. 新增WorkflowNodeRun、NodeRunTransition、NodeValueManifest及其ID类型。
2. Node Run唯一键为productRunId、definitionNodeId、canonicalExecutionPath、attemptNumber；executionPath显式记录循环节点与iteration。
3. 状态联合固定为queued、running、waiting_human、succeeded、failed、skipped、cancelled、outcome_unknown。
4. Transition只保存状态变化、reasonKind、序号、相关产品引用和时间，不保存正文、Prompt、Provider原始响应或Stack。
5. Manifest由命名slot与有限Product Ref联合组成；每个Ref携带ID、revision、sha256和安全label。控制结果使用outcomeCode，不滥造Artifact。
6. 在domain实现create、start、wait、resume、succeed、fail、skip、cancel、markOutcomeUnknown纯转换函数；终态不可重开，retry产生新attempt。

### 关键不变量

- 每次状态转换与Node Run revision、Transition append在同一事务。
- Transition nodeSequence从1单调递增，不能缺号或重复。
- waiting_human必须有Approval Request或等价Decision输入引用；resume必须关联已提交Decision。
- succeeded必须满足Catalog声明的必要输出slot；S1先用固定legacy node contract校验。
- skipped只能用于快照中声明可跳过的节点；commit、关键验证和产品事实提交节点不可跳过。
- outcome_unknown只用于无法确认外部副作用结果的节点，不替代普通失败。

### 测试设计

1. 状态机表驱动覆盖所有允许与禁止转换，包括终态重开、重复完成、失败后普通重试。
2. 幂等：同一transition command identity重复应用不增加revision或Transition；不同payload复用identity冲突。
3. 唯一键：相同executionPath键顺序规范化；不同loop iteration或attempt产生不同身份。
4. Manifest：每种Product Ref合法Fixture；错ID前缀、错revision/hash、未知slot、内嵌大正文失败。
5. 完整性：Transition最后状态必须等于Node Run状态；startedAt/finishedAt/duration关系合法。
6. 安全属性测试：生成任意状态序列，验证终态吸收、sequence单调和正文禁入。

### 完成门

- 纯domain测试能在没有Store和Workflow运行时的情况下证明状态机全部不变量。
- Node Run与Trace事件可明确区分：删除Trace不影响产品查询，删除Node Run则阶段合同失败。
- S1.3迁移能够直接使用这些Schema和完整性规则。

## S1.3 Store迁移与legacy诚实回填

### 目标与结果

把S1对象持久化到当前Product Store的下一版本，并从既有Run、Plan、Approval、Decision、Execution、Validation、Artifact事实生成可解释的legacy投影。

### 方案

1. 在实现时从主干实际PRODUCT_STORE_SCHEMA_VERSION顺延一版，不在任务书预占固定版本号。
2. Snapshot新增workflowViewDefinitions、workflowNodeRuns、nodeRunTransitions、nodeValueManifests集合及必要索引的可重建形式。
3. 迁移先创建唯一legacy Planning快照，再按每个既有Product Run的已提交事实回填节点：
   - 有Context Package才证明context成功；否则只按Run状态标queued或unknown，不猜执行时间。
   - 有Plan Revision才证明plan至少成功到对应revision。
   - 有Approval Request/Decision证明review等待或完成。
   - 有Execution Candidate、Validation Result、Artifact分别证明execute、validate、commit结果。
4. 回填Transition的occurredAt只取相关产品对象真实createdAt/updatedAt；无法区分start/end时只生成legacy_product_facts reason，不制造started事件。
5. Store事务提供按Run读写、按唯一键查Node Run和append transition帮助函数；索引若不持久化则在加载时校验/构建。

### 迁移与回滚

- 先完整parse旧Snapshot，再在内存迁移、执行integrity check、写临时文件并原子替换。
- 任一Run存在悬空引用、Hash不匹配或无法唯一归属时整体迁移失败，原文件保持不变，并输出脱敏对象ID。
- 迁移可重复执行；已是新版本时只验证，不重复生成对象。
- 应用开始写新对象后，不支持用旧二进制写回；回滚方案是停写、保留新Store、回到能读取新版本的兼容构建。

### 测试设计

1. v1到当前版本再到新版本的全链Fixture；当前上一版本直接升级Fixture。
2. 空Store、有完整成功Run、等待审核Run、修订多轮Run、失败Run、outcome_unknown Run、缺少中间历史Run分别回填。
3. 数量守恒：原有所有集合对象逐ID/hash不变；新增对象计数符合每个Run的可证明事实。
4. 诚实性：没有Plan时不得回填plan succeeded；没有时间证据不得生成伪startedAt。
5. 原子性：临时写失败、rename失败、fsync失败时旧文件字节不变；下次启动可重试。
6. 损坏测试：重复唯一键、悬空Product Ref、Transition序号断裂、未知schemaVersion都拒绝加载。
7. 重启：升级、写入一个新Node Run、关闭、重新打开，所有revision/hash/时间线完全一致。

### 完成门

- 真实开发Store副本只做只读dry-run验证；自动测试使用脱敏复制Fixture，不能直接迁移用户工作Store。
- 迁移报告列出Run数、回填节点数、缺失证据数，不包含消息正文。
- S1.4可以在一个Product Store事务内读写业务事实与Node Run。

## S1.4 Context、Planning与Review原子投影

### 目标与结果

让当前硬编码流程的context、plan、review三个节点跟随真实业务用例推进；任何业务事实成功都不能留下旧节点状态，节点成功也不能先于业务事实提交。

### 方案

1. 在application增加面向业务语义的Node Run协调器，不建立万能WorkflowNodeService。
2. 当前context request/result/adoption/context package完成事务，同时完成context Node Run及Manifest；Memory Adapter调用本身仍在事务外，结果通过既有幂等命令提交。
3. Plan Revision提交事务同时完成plan Node Run，输出引用精确到revision/hash。
4. Approval Request创建事务把review Node Run置waiting_human；Decision提交事务同时把对应attempt从waiting_human推进到succeeded并附Decision引用。
5. 请求修订时创建下一次plan/review attempt或显式executionPath reviewCycle，选定一种后用测试固定，不能覆盖上一轮输入输出。
6. Workflow step只调用这些应用命令；workflow-step-support可以发Trace，但不直接更新Product Store状态。

### 事务与幂等

- 每个应用命令使用既有commandId/operation identity并携带expected revision。
- 同一Plan Revision被Workflow重放提交时返回原结果，不增加Node Transition。
- Approval已等待而Hook注册结果未知时，产品事实仍是waiting_human；对账逻辑决定恢复，不回滚已提交Approval。
- Decision先成为产品事实，再恢复Hook；恢复失败保持可重试outbox/对账状态，不反向撤销Decision。

### 测试设计

1. 应用用例事务测试：业务对象和Node Run一起成功、一起失败；在每个写入点注入异常证明无半提交。
2. Memory零结果、部分结果、Adapter失败、Context adoption冲突对应Node状态和Manifest精确断言。
3. Plan schema无效、模型失败、重复提交、revision冲突，不产生假succeeded。
4. Review创建、批准、拒绝、request_revision、重复Decision、错误hash、无权限Decision完整覆盖。
5. Workflow重放同一step 2次、5次只产生一个业务事实和一个对应Transition序列。
6. Trace Sink失败不阻止产品事务；Product Store失败不能靠Trace显示成功。

### 完成门

- 运行现有Planning workflow tests时，context/plan/review每个用户可见状态均可从Product Store独立重建。
- 暂停时同时可查询Approval、review Node Run waiting_human及允许动作，三者revision/hash一致。
- 原有Plan/HITL合同测试全部保持通过，没有公共行为回归。

## S1.5 Execution、Validation、Commit与动态子节点投影

### 目标与结果

补全硬编码Planning后半段，并把Execution Contract中的多Action投影为execute容器下的稳定子Node Run，使真实执行失败、验证失败和提交结果可定位。

### 方案

1. execute顶层节点使用container语义；Execution Contract创建后，为每个按稳定actionId排序的Action创建子Node Run。
2. 子节点definitionNodeId由固定execute节点和Action语义ID确定，不能使用执行数组下标；attempt区分显式重试。
3. 执行结果提交事务同时更新对应子节点；全部必要子节点终态后，父execute根据聚合规则成功、失败或outcome_unknown。
4. Validation Result提交与validate Node Run原子绑定；验证未通过不能进入commit succeeded。
5. Artifact/Project产品事实提交与commit Node Run原子绑定；若外部动作结果未知，保留outcome_unknown和对账入口，不生成成功Artifact。
6. 对现有最大修订循环保留原限制；循环身份由reviewCycle写入executionPath，不能把多轮输出覆盖到同一Node Run。

### 聚合规则

- 任一必要Action outcome_unknown，父execute为outcome_unknown。
- 任一必要Action failed且无未知结果，父execute为failed。
- 可选Action显式skipped不阻断父节点，但必须记录skip reason与策略来源。
- 只有所有必要Action succeeded且Execution Candidate完整，父execute才succeeded。
- validate failed是业务终态还是回到修订由当前Planning状态机决定；S1不新增回边。

### 测试设计

1. 单Action、多Action、可选Action、顺序执行、重复actionId、动作列表重排的身份稳定测试。
2. 每个子Action成功/失败/未知的笛卡尔代表集，精确断言父状态和Product Run phase/status。
3. Execution Candidate、Validation Result、Artifact分别在事务中间失败，证明无节点假成功或孤立输出引用。
4. retry只新增attempt，历史attempt只读；普通Workflow重放不新增attempt。
5. 修订两轮后执行，旧plan/review节点和当前execute输入引用都正确。
6. 外部结果未知后对账为成功/失败的转换，权限、identity和重复对账覆盖。

### 完成门

- 一个真实Fixture成功Run可从context走到commit，每个业务对象都能反查唯一Node Run输出引用。
- 任意失败Fixture的Product Run终态、父子Node状态和已有业务事实不矛盾。
- 现有外部副作用与Artifact合同不被弱化。

## S1.6 Workflow View/Node Detail Query、API与恢复门

### 目标与结果

提供S2唯一允许消费的公开查询面，并证明新投影在授权、并发、重启和Workflow重放后保持稳定。

### 方案

1. application增加getWorkflowRunView(productRunId, principal)与getWorkflowNodeDetail(nodeRunId, principal)查询。
2. Workflow Run View DTO包含快照Hash、节点摘要、语义边、当前选中建议和整体revision；Node Detail按tab返回Manifest安全预览、Transition时间线、Evidence引用和允许动作。
3. 大正文默认只返回label、类型、大小、sha256和短预览；正文通过已有产品资源Query按权限读取，不在图DTO复制。
4. Hono只做认证上下文、路径/Query解析、Zod校验、ETag/If-None-Match和Problem Detail映射。
5. SSE只发送workflow_view_invalidated/node_run_changed一类失效提示或AG-UI兼容状态事件；权威详情仍由Query读取，不建立第二份浏览器状态机。
6. 404不泄漏对象存在性；无权访问Run时节点详情同样返回统一not found/forbidden策略。

### API合同

- GET /runs/:productRunId/workflow-view
- GET /runs/:productRunId/workflow-nodes/:workflowNodeRunId
- 可选include只允许summary、manifests、timeline、evidence有限枚举。
- response携带schemaVersion、productRunId、viewHash、revision、updatedAt和allowedActions。
- 不提供按Workflow Run ID或Hook Token查询的公开路由。

### 测试设计

1. Query映射：legacy成功、等待审核、多修订、失败、outcome_unknown、父子execute节点Fixture。
2. API合同：合法/非法ID、无权、跨Run nodeId、未知include、ETag命中、并发更新后的新ETag。
3. 敏感数据扫描：DTO和Problem Detail不含Token、endpoint、Provider Payload、Prompt、Stack、pi Session ID。
4. 重启恢复：在context、waiting_human、execute子Action和commit四个checkpoint重启，查询前后等价。
5. 重放：Workflow step重复执行后节点数量、Transition数量和业务对象数量不变。
6. 性能基线：用阶段代表数据测量列表与单节点查询，记录数据量、p50/p95和响应字节；本阶段只建基线，不凭空定最终阈值。
7. 架构测试：web不能导入product-store-json/workflows；api Router不直接mutate Store；Query只通过ProductStorePort。

### 完成门

- 公开API合同测试和四个恢复点测试全部通过。
- S2实现无需读取Run phase来猜节点，也无需直接读取Trace或Runtime内部接口。
- 阶段报告列出未能从legacy事实证明的细节，并在UI合同中明确显示为历史信息有限，而不是制造完成状态。

## 7. S1阶段反向验证

| 阶段问题 | 通过证据 | 失败时回退 |
| --- | --- | --- |
| 用户能否看到真实节点而不是装饰图 | View Snapshot + Node Run +业务引用一致性测试 | 不进入S2，修正事实模型 |
| 运行时重放会否重复节点或时间线 | 唯一键、command identity、四点恢复测试 | 修正应用事务/幂等，不能在UI去重 |
| 旧Run历史是否被伪造 | legacy迁移诚实性Fixture和缺失证据报告 | 降低回填粒度，显示未知 |
| Trace失败会否改变产品结论 | Trace故障注入测试 | 移除Trace到产品状态的反向依赖 |
| 前端是否需要内部Runtime身份 | 公开DTO敏感字段扫描和依赖测试 | 重做Query，不把Runtime ID脱敏后继续泄漏 |
| 是否改变了现有Planning行为 | 原B2合同、Workflow、HITL和真实E2E回归 | 回滚投影接入，保留Schema但不切流量 |

只有六项全部有自动化证据，S1才完成。通过S1只证明“现有固定工作流已经成为可观察产品事实”，不证明工作流已经可配置。
