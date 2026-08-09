# S4任务书：可配置Planning真实纵向闭环

> 状态：已批准，待实现验收  
> 阶段目标：把当前最常用的Planning流程接入S3内核，使用户能在发送前选择Definition、Memory、Project、Rules、Skill和审核方式，并完成真实规划—确认—执行—验证—提交  
> 前置完成门：S3 Kernel全部阻断风险关闭；Project Solution和Rules阶段已先按PROJECT_PLAN完成并合入main  
> 迁移原则：活动旧Run继续旧Bundle，新Run经过门控后才使用新Runner

## 0. 阶段约束

1. S4实施时必须重新读取届时已经完成的Project/Rules真实合同，不提前复制本任务书中的假想字段。
2. 新Run只能绑定已发布Definition Revision；运行开始后只读RunSpec，不回读最新草稿。
3. Browser提交的是有限选择和覆盖，不提交Executor key、任意Graph、Runtime ID或密钥。
4. 对高影响执行仍遵守“可读、可修订、版本绑定的决定”；运行前选择auto不能绕过对未知生成Plan的高风险审批。
5. 现有Outbox、HITL、Execution Contract、结果未知、Artifact commit和真实E2E保证只能增强，不能因通用Runner而变弱。

## S4.1 Definition/Revision/RunSpec持久化与内置Planning Definition

### 目标与结果

把S3实验室对象提升为正式产品事实，并用不可变已发布Revision表达当前Planning流程；现有Run可继续读取，未来新Run有精确Definition和Runner绑定。

### 方案

1. 新增WorkflowDefinition、WorkflowDefinitionRevision、WorkflowRunSpec持久Schema与ID；Definition是可变聚合身份，Revision与RunSpec不可变。
2. Product Run演进为严格判别结构：S4先把所有现有Run迁移为runKind=planning分支，并增加workflowViewDefinitionId、workflowRunSpecId可选和runnerFamily/bundle evidence。
3. Store下一版本新增definitions、definitionRevisions、runSpecs集合及完整性检查：
   - publishedRevisionId必须属于Definition且state=published；
   - published/superseded Revision内容不可变；
   - RunSpec的Product Run、Revision、View Snapshot、Hash互相一致；
   - legacy Run允许无RunSpec，但必须有legacy View Snapshot。
4. 通过版本化Seed迁移写入一个system-owned Planning Definition和已发布Revision，语义等价于届时主干当前固定流程，而不是照文档猜测。
5. Seed ID和语义Hash稳定；已有相同Seed重复升级只校验，不覆盖用户copy或历史Revision。

### 生命周期边界

- S4不开放编辑命令；内置Definition只读、已发布。
- RunSpec一旦随Run创建不可更新；取消Run也不删除。
- Definition归档只在S6实现，并且不影响已存在Run。
- ProductRun schema演进不能变成大量互不相关optional字段；Note分支在S5以新版本扩展。

### 测试设计

1. Store从届时当前版本升级：所有旧Run变planning legacy分支，ID/status/phase/Plan引用不变。
2. Seed空Store、已有Seed、Seed语义Hash冲突、用户同名Definition、重复迁移。
3. 完整性：悬空published ref、Revision跨Definition、可变Published内容、RunSpec/Run错绑、Hash错误拒绝。
4. 原子迁移失败与重启测试沿用S1标准；旧对象数量和Hash守恒。
5. Seed Revision经S3 Compiler重新编译，规范结构与保存Hash一致。
6. 现有所有ProductRun DTO、状态机和真实B2 Fixture兼容回归。

### 完成门

- 当前固定Planning流程有唯一、可审计的system Definition/Revision，但新Runner仍未成为默认。
- 旧Run无须旧代码推图，活动旧Run仍保存旧runner family可恢复。
- S4.2可在同一产品事务原子写Message、Run、RunSpec、Receipt和Outbox。

## S4.2 发送命令：配置编译、资源冻结与Outbox原子提交

### 目标与结果

用户点击发送时，后端先验证Definition和配置，再把消息、Planning Run、冻结RunSpec、命令Receipt和workflow_start Outbox一次提交；非法配置不会产生半个会话工作。

### 方案

1. 扩展Submit User Message Command，新增workflowSelection判别结构：definitionRevisionId/hash、有限Run Configuration、Memory/Profile、Project、Rule、Skill选择及其用户可见来源。
2. API Router只parse公开payload和认证上下文；Application加载已发布Revision与实际资源，调用S3 Compiler。
3. 编译在事务外读取快照以保持事务短；进入ProductStorePort.transact后重新校验Definition、资源revision/hash和权限相关事实没有变化，再原子写入。
4. RunSpec保存resolved refs、明确exclusions、review policy、limits和version evidence；Outbox只保存productRunId/runSpecId/runner family等小型产品引用。
5. requestSha256覆盖消息正文Hash、Definition revision/hash、规范化Run Configuration和资源ref；相同commandId同payload返回原Receipt，不同payload冲突。
6. 对旧客户端无workflowSelection的兼容期，服务端显式选择内置Planning默认Revision和默认资源策略；兼容期结束条件在S7审查，不做隐式永久分支。

### 失败语义

- definition不存在/未发布/Hash错：definition_stale，零写入。
- 资源归档/无权/revision变化：resource_stale或forbidden，零写入。
- policy拒绝skip/auto：policy_denied，零写入。
- Compiler/limit失败：422稳定diagnostics，零写入。
- Product Store提交成功但HTTP响应丢失：相同commandId返回原Message/Run/RunSpec结果。
- Outbox派发结果未知沿用既有reconcile/fence，不创建第二RunSpec或第二Run。

### 测试设计

1. 成功事务精确断言六类对象同时存在且hash/ref一致；每个写入点异常时六类对象全部不存在。
2. commandId重复、同ID异payload、两个并发相同语义命令、响应前进程退出。
3. Definition和每类资源在编译后/事务前变revision的barrier竞态。
4. 未知config、重复override、错误nodeId、禁止skip、非法review_mode、超限选择。
5. 旧客户端默认映射与新客户端显式默认产生等价RunSpec Hash，兼容日志可计数。
6. Outbox payload大小和敏感字段扫描；大Message/Project正文不复制进RunSpec/Outbox。
7. API Problem Detail不回显完整消息、资源正文或内部Schema stack。

### 完成门

- 任意失败不会留下Message无Run、Run无RunSpec、RunSpec无Outbox等半提交。
- 运行前用户选择能从RunSpec审计还原，且不含密钥/endpoint。
- Outbox Dispatcher能按runnerFamily选择新旧入口，但默认流量开关仍关闭。

## S4.3 新Runner完成Context、Research、Plan与人工审核

### 目标与结果

让新Runner用真实Memory、Project、Rules、Skill和模型完成Planning前半段，生成可读任务书并停在人工审核；所有节点输入输出与S1投影一致。

### 方案

1. 为context.memory、context.project、policy.rules、capability.skills实现静态Executor，优先调用届时已有Application/Port；不在workflows内复制资源读取逻辑。
2. 每个optional节点依据RunSpec resolved inclusion/exclusion执行或skipped；skip outcome和理由成为Node Run事实。
3. agent.research与agent.plan使用pi-agent-core Adapter；实现前再次读取固定本地pi源码和届时锁定版本，按真实API适配，不凭记忆构造Session。
4. 组装模型上下文只使用RunSpec选择的产品ref和明确预算；完整历史仍是证据，不默认塞入Prompt。
5. agent.plan输出先通过严格Plan schema、业务校验和安全摘要，再由Application原子提交Plan Revision、Approval Request、plan succeeded与review waiting_human。
6. Runner创建typed Hook并保存私有Runtime Binding；浏览器只看到Approval/Node allowed actions。

### 节点映射原则

- 一个真实业务边界一个用户可见节点；仅在内部调用函数不同但用户结果相同，不拆伪节点。
- Context输入Manifest引用Message、Memory selection、Project/Rule/Skill revisions；输出引用Context Package与exclusion证据。
- research若与plan在实际pi Adapter中无法形成独立、可持久证据，首版合并到agent.plan并调整Definition，不为对齐图而虚构research成功。
- 模型事件可通过AG-UI兼容类型流式显示，但Plan候选未校验/提交前不能成为Node成功或产品Plan。

### 测试设计

1. 每个Context节点：选中/未选、零结果、部分结果、资源过期、Port失败、重放。
2. Context Package精确断言只含选择范围和预算内内容，未选择资源不泄漏。
3. pi Agent：合法Plan、Schema非法、超预算、Provider失败、超时、流中断、重复回调；使用真实Adapter合同测试和可控模型替身。
4. publishPlan事务故障注入证明Plan/Approval/Node状态无半提交。
5. Hook创建前后崩溃、Hook已建响应丢失、重复注册与恢复绑定测试。
6. 一条受控真实Memory+Project+Rules+模型运行到waiting_human，断言产品对象和Viewer，不只断言文本出现。

### 完成门

- 新Runner在门控测试入口可稳定停在真实review节点，旧默认入口不变。
- Plan可读且绑定所有输入revision/hash；未选择内容不能在Manifest和生成上下文出现。
- 模型隐藏推理、Provider Payload和pi Session ID未进入Product Store、公开API或Trace。

## S4.4 手工审核、自动继续与修订循环策略

### 目标与结果

用户可以批准、拒绝、指出修改意见并迭代；允许低风险场景按运行前策略自动继续，但不能用一个“跳过审核”开关绕过高影响动作的版本绑定决定。

### 方案

1. manual模式沿用现有Decision用例：Decision绑定Approval Request、Plan Revision/Hash、Run expectedRevision和用户备注；先提交产品事实与resume Outbox。
2. request_revision把Decision和Revision Input原子提交；Runner恢复后进入下一次有界loop iteration，新Plan/Review使用新的executionPath/attempt。
3. auto_continue_if_policy_allows由Application对“实际Plan + Execution Contract风险”做解析，形成Policy Resolution产品证据，绑定Plan revision/hash、运行前用户配置command和策略revision/hash。
4. Policy Resolution不是伪造的human Decision；Node timeline明确actor=system_policy和reason。若实际动作达到human_decision/external_effect/product_commit的强制人工等级，则自动策略失败关闭并转waiting_human。
5. always_auto只允许Blueprint明确声明的候选生成/只读流程；Planning Blueprint含高影响执行时不能设置为无条件自动。
6. maxIterations来自RunSpec；超限fail或request_human由Definition声明，不能静默继续或无限调用模型。

### 决策矩阵

| 配置 | 实际风险 | 结果 |
| --- | --- | --- |
| manual | 任意 | waiting_human，接受用户Decision |
| auto_if_allowed | 只读/候选 | Policy Resolution后继续 |
| auto_if_allowed | 高影响 | 强制waiting_human，说明策略阻断原因 |
| always_auto | Blueprint不允许 | 编译期拒绝 |
| request_revision | 未达上限 | 新一轮Plan/Review |
| request_revision | 达上限 | 按exceededPolicy失败或人工终止选择 |

### 测试设计

1. approve/reject/request_revision各自重复、异payload复用commandId、错误hash/revision/approval。
2. 两轮与最大轮修订，检查每轮Plan、Decision、Node Run历史不可变且Prompt只带允许的revision input。
3. auto低风险成功、高风险强制人工、策略revision变化不影响已编译RunSpec、伪造前端risk字段失败。
4. Decision提交成功但resume失败/结果未知/重复resume，Product状态和UI allowed actions一致。
5. 用户A不能决定用户B的Run；已结束/取消Run不能再Decision。
6. paid模型调用计数断言：重复Workflow step、重复resume和Query刷新不产生额外规划调用。

### 完成门

- 用户最初提出的“这里停下来问我”和“允许时默认同意”都有明确、不同且安全的语义。
- 高影响Planning执行前始终存在绑定当前Plan版本的human Decision；自动策略不能伪装成人。
- 修订历史、Node timeline、当前Plan和最终执行输入完全可追溯。

## S4.5 Execute、Validate、Commit与结果未知保证

### 目标与结果

新Runner按已批准Plan执行、逐项记录候选、验证并提交最终产品结果；任何外部副作用未知、验证失败或提交冲突都不会显示假成功。

### 方案

1. execute.plan Executor复用现有Execution Contract编译和Run Attempt用例；Contract必须绑定已批准Plan revision/hash与Policy/Human Decision证据。
2. Composite根据Execution Contract的稳定step/action身份生成子Node Run；Runner不把自由Action脚本写入RunSpec。
3. 每个Action通过静态pi/工具执行能力运行，外部调用在产品事务外；结果用幂等Command提交Execution Candidate和Node outcome。
4. result.validate读取冻结Candidate和Contract，提交Validation Result；验证失败按产品状态机停止或回到明确人工节点，不自动把失败候选提交。
5. product.commit只提交已验证Candidate，原子创建Artifact/Final Message/Project事实与commit Node success、Run succeeded。
6. 外部响应丢失进入outcome_unknown与reconcile；普通异常重试不得对未知副作用再执行。

### 测试设计

1. 多step成功、单step失败、单step未知、可选step skipped、显式安全retry。
2. Contract绑定错误Plan/Decision/RunSpec/Node input时执行前拒绝。
3. Action调用后在响应前崩溃、Candidate提交前后崩溃、Validation/Commit每个写点失败。
4. outcome_unknown查询对账为成功/失败/仍未知；重复对账不重复副作用。
5. Validation不通过不得有Artifact/Final Message/Run succeeded；Commit冲突保留已验证Candidate可安全重试。
6. 隐藏推理、Provider Payload、Credential和完整工具原始结果敏感扫描。
7. 新旧Runner对相同已批准Plan的产品不变量对照，而非强求生成文字相同。

### 完成门

- 成功Run的Plan、Decision、Contract、Candidate、Validation、Artifact和节点引用形成完整链。
- 所有故障注入点都只有失败、等待对账或可安全重试三类明确结果，无半提交/假成功。
- 原B2执行、验证、提交测试在新Runner对应路径具备同等或更强覆盖。

## S4.6 Composer的Definition、资源与有限运行配置

### 目标与结果

用户在发消息前能看懂并选择要运行的Planning Definition、Memory、Project、Rules、Skill和审核模式；界面只呈现后端允许的配置，并准确提交版本绑定。

### 方案

1. Composer增加WorkflowPicker和RunConfigPanel，默认选中system Planning Definition；显示发布版本、用途、节点摘要和最后更新时间。
2. 配置控件来自Blueprint/Catalog公开DTO与现有资源Query，不把Zod/任意JSON Schema传到浏览器。
3. 对每个optional节点展示启用状态、资源选择和影响；高风险不可跳节点disabled并解释后端策略原因。
4. 提交前显示紧凑运行摘要：Definition版本、Memory源、Project、规则集、Skill和审核方式；用户可返回修改。
5. local draft按session存配置草稿，但权威selection在发送命令响应后来自RunSpec摘要；刷新pending command恢复相同commandId和payload hash。
6. Definition/资源在用户编辑期间更新时，提交409后保留草稿并标出变更，不静默切到最新版本。

### 前端状态边界

- Definition/Blueprint/Catalog/资源是服务端Query cache；未发送配置是本地草稿；已发送配置只读RunSpec DTO。
- useRealChain只组合active Run，不承载所有Workflow表单；新增useWorkflowDefinitions/useRunConfigDraft/useSubmitConfiguredMessage。
- UI字段联合穷尽渲染；未知未来field显示“不支持此版本”并禁止提交，不用通用JSON编辑器兜底。
- 不在浏览器保存Memory正文、Rule全文、Secret或完整RunSpec。

### 测试设计

1. 默认配置、显式选择、optional关闭、多Memory/Rule/Skill选择、不可跳节点、无资源和资源归档。
2. 后端field descriptor与前端renderer穷尽测试；未知type安全失败。
3. 草稿按session隔离、刷新恢复、发送成功清理、失败保留、切Definition迁移/清理不兼容字段。
4. 双击发送、响应丢失、409 stale、离线恢复的commandId/payload稳定。
5. 键盘、触控、屏幕阅读器label；手机panel不遮挡消息输入与发送结果。
6. 提交Network payload不含内部Executor/Runtime身份，响应后Viewer显示的RunSpec摘要与发送摘要一致。

### 完成门

- 一个不了解底层技术的用户能在发送前完成配置且看见风险约束原因。
- 浏览器无法通过篡改payload跳过服务端Compiler/Policy。
- 当前无配置发送路径在兼容期仍工作并有可观测使用计数。

## S4.7 新旧Runner切换与真实全链阶段门

### 目标与结果

在不破坏活动旧Run的情况下把符合条件的新Planning Run切到新Runner，并用真实Memory、Project、Rules、模型、Workflow和浏览器证明最常用场景完整成立。

### 方案与切换顺序

1. Outbox workflow_start根据Product Run保存的runnerFamily分派；不是根据当前全局配置猜测。
2. 上线顺序：读兼容 → Store迁移/Seed → 新API/UI但默认旧Runner → 内部测试Definition新Runner → 单用户/本地门控 → 默认新Runner。
3. 活动旧Run继续旧Bundle和原Hook；S4不删除旧入口、Runtime Binding或恢复证据。
4. 回滚只停止创建新runnerFamily Run；已经创建的新Run继续由对应Bundle恢复，不能改标旧Runner。
5. 运行时版本不兼容沿用version recovery，历史Viewer依赖产品快照，不要求旧Bundle在线。

### 真实主场景

1. 用户选择Planning Definition。
2. 勾选真实Memory，选择一个真实Project、已发布Rules与允许Skill。
3. 发送需求；Viewer从左到右显示context、plan、review。
4. 第一次Plan不满足，用户给出修改意见；第二次Plan绑定新revision。
5. 用户批准；执行节点展开Action，验证通过，提交Artifact/Project结果和最终Message。
6. 刷新浏览器并重启服务后，Run图、Node详情、Plan/Decision链和最终结果不变。

### 测试设计与阶段验证矩阵

1. 真实主成功场景只跑一次付费全链，保存脱敏产品证据。
2. Memory无结果、Project/Rule过期、模型Schema非法、Hook恢复失败、执行未知、验证失败用可控Adapter覆盖。
3. 在waiting_human和execute checkpoint各做一次真实Workflow进程重启。
4. 同时运行一个旧Runner等待审核Run和一个新Runner Run，分别Decision/恢复，证明不串Hook/Bundle。
5. 旧客户端默认路径、新客户端显式配置路径、越权/篡改payload安全测试。
6. 真实浏览器覆盖桌面与手机主审核路径，Console零未处理异常。
7. 统计模型/外部调用次数，证明重放、刷新、Query和重复resume没有额外付费调用。

### 完成门

- Planning原始用户场景从配置到最终交付真实完成，全部关键对象有ID/revision/hash证据。
- 活动旧Run恢复测试通过；默认切换和回滚步骤实际演练并写入调试文档。
- 新旧路径不存在两个竞争Product Run状态机或两套公开事件协议。
- 只有本任务通过后，S5才可用第二场景检验复用；不能以S4成功直接宣称平台完成。

## 8. S4阶段反向验证

| 原始目标 | 必须出现的产品证据 |
| --- | --- |
| 发送前配置工作流 | Submit Command + Definition Revision + RunSpec Hash |
| 拉Memory/Project/规则/Skill | 精确资源revision/hash、Context Package和exclusion |
| 先调研整理再出任务书 | context/research/plan Node Run与Plan Revision |
| 停下来审核并反复修改 | Approval、Decision、Revision Input和多轮executionPath |
| 允许时默认继续 | Policy Resolution；高风险仍强制绑定当前Plan的human Decision |
| 执行、验证、提交 | Contract → Candidate → Validation → Artifact/Project事实链 |
| 前端看节点细节 | S2 Viewer读取S4 Node Run和Manifest，不加特殊Planning假数据 |

以上任一结果只能从Trace、日志或浏览器本地状态找到而不能从Product Store查询，S4即判失败。
