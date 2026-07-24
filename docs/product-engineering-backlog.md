# 产品能力与工程质量Todo

> 状态：`Q0工程安全底座已于2026-07-23获用户批准并进入实施；F01-F08继续按各自详细设计门推进`
>
> 更新日期：2026-07-23
>
> 状态事实仍由[PROJECT_PLAN](../PROJECT_PLAN.md)与[PROJECT_STATE](../PROJECT_STATE.md)维护；本文只负责把每个Todo的用户场景、目标、方案级做法和验证门写完整，不替代详细设计。

## 1. 排序结论

项目不能继续只叠加高风险功能。建议按4个交付门推进：

1. **Q0 工程安全底座**：Q01-Q05。先建立可重复质量门、清晰模块边界、错误合同、日志与测试证据，不改变现有产品语义。
2. **Q1 执行可信闭环**：F01-F03。完成Tool副作用、Evidence和Runtime完整故障矩阵。
3. **Q2 连续协作完整性**：F04-F06。补齐Session、任意Workflow恢复、Intent/Harness/Context治理。
4. **Q3 多入口与运营**：F07-F08。完成身份、Channel、Delivery、Provider配置和生产运营。

| ID | Todo | 优先级 | 当前状态 | 前置 |
|---|---|---:|---|---|
| Q01 | 自动质量门与CI | P0 | 纵向基线完成，待远端CI首次运行 | 无 |
| Q02 | 后端模块与应用边界收敛 | P0 | 实施中：治理Rule/Query、Harness命令记录/Context Query及事务门已拆 | Q01、Q03-Q04 |
| Q03 | API合同、错误与安全边界统一 | P0 | 纵向基线完成，身份/API版本/响应模型继续 | Q01 |
| Q04 | 可观测性、日志和调试体系 | P0 | 纵向基线完成，生产运营能力继续 | Q01、Q03 |
| Q05 | 测试金字塔、覆盖率与故障实验室 | P0 | 纵向基线完成，容量/性能/多设备矩阵继续 | Q01-Q04 |
| Q06 | 前端Feature架构与交互质量 | P1 | 实施中：Agent重连、Workflow投影和8个生产按需Feature已拆；性能/人工无障碍继续 | Q01、Q03、Q05 |
| Q07 | 文档、注释、ADR与依赖治理 | P1 | 纵向基线完成，随工程持续维护 | Q01 |
| F01 | 通用Tool Operation Ledger与副作用对账 | P0 | 已批准目标，待详细设计 | Q02-Q05、现有Runtime |
| F02 | Evidence、Artifact、Provenance与独立生命周期 | P0 | 已批准目标，待详细设计 | F01、Harness |
| F03 | Runtime完整故障、容量和游标矩阵 | P0 | 已批准目标，纵向切片后续 | Q04-Q05 |
| F04 | Session完整生命周期、树、控制与可移植性 | P1 | 已批准目标，部分实现 | Q03-Q06、F03 |
| F05 | 任意Workflow、嵌套Workflow和pi持久恢复 | P1 | 已批准目标，主Workflow安全点已实现 | F01、F03 |
| F06 | 独立Intent、Harness交互与Context权限治理 | P1 | 已批准目标，部分实现 | F02、F04 |
| F07 | Principal、Scope、Channel Binding与Delivery | P2 | 已批准目标，未实现 | F02-F06 |
| F08 | Provider配置、运营、备份、保留与SLO | P1 | 已批准目标，部分实现 | Q01-Q05 |

## 2. Q01 自动质量门与CI

### 用户场景

1. 开发者修改审批、恢复或Session代码后，合并前能自动发现格式、类型、迁移、合同或前端构建回归。
2. 用户更新本地代码或切换机器时，得到与当前开发机相同的验证结果，而不是依赖某个固定Node路径或人工操作。
3. 依赖升级后，MAF/AG-UI私有接合与Provider请求合同会被自动重验。

### 目标

每个提交都能重复证明“代码可检查、合同可运行、迁移可升降、前后端可构建、关键依赖没有静默漂移”。

### 方案级做法

1. Python增加Ruff、严格静态类型检查和pytest-cov；前端增加ESLint/Biome、格式检查和覆盖率工具。
2. 把`verify.sh`拆为快速门与完整门：格式/Lint/类型/单测、迁移升降、合同/集成、生产构建、浏览器E2E。
3. 建立GitHub Actions或等价CI，固定Python、Node、uv锁、npm锁和MAF/AG-UI版本。
4. 增加`git diff --check`、私有配置/密钥扫描、依赖漏洞与许可证检查。
5. 删除VS Code启动配置中的用户绝对Node路径，改用项目或PATH解析。

### 验证与完成门

1. 故意引入未格式化代码、类型错误、迁移无downgrade、前端合同错误和测试失败，CI都必须失败。
2. 干净机器只根据README和锁文件能完成快速门与完整门。
3. 合并保护要求P0门通过；真实模型测试使用显式受控Job，不在普通PR中意外计费。

## 3. Q02 后端模块与应用边界收敛

### 用户场景

1. 新增一种HITL Decision Point时，不再回到曾经2,449行的治理Application Service、组合根和多个无关路由继续堆叠。
2. 新增Workflow或Worker时，开发者能明确知道领域规则、应用协调、MAF适配、存储和HTTP各自应该放在哪里。
3. 故障修复只影响一个边界，原有Session、审批和Harness场景不被连带破坏。

### 目标

保留现有Product Store、MAF、AG-UI和状态机语义，通过无行为重构建立可独立测试和替换的模块边界。

### 方案级做法

1. 把`main.py`拆为组合根/生命周期、HTTP Router、请求响应Schema、错误映射和AG-UI入口；`create_app`只装配依赖。
2. 按现有聚合拆分`ExecutionGovernanceService`：Policy、Decision、ExecutionDraft/RunSpec、ModelCall、Summary；共享事务由明确Application Coordinator持有。
3. 按Project/Work/Knowledge/Context拆分`HarnessService`，但仍共享同一Product事务和Outbox合同。
4. 把持续协作Workflow拆为State/Contracts、Executor、Decision Spec、Prompt/Compiler和Graph Factory；MAF节点ID与Definition版本不变。
5. 为Provider、pi、MAF Runtime、Clock和ID提供窄接口；基础设施实现不能反向成为领域事实源。
6. 每次只移动一个边界，禁止同时改Schema、状态机或用户可见语义。

### 验证与完成门

1. 现有112个后端测试、42个前端测试和真实模型纵向回合保持等价。
2. OpenAPI、AG-UI公开事件、Workflow节点ID、数据库Schema和Trace字段做快照对比，无计划外变化。
3. 模块依赖图无环；路由不能直接写数据库；领域/应用层不能依赖FastAPI。
4. 每个拆分提交都能单独回归，不采用一次性“大爆炸”迁移。

## 4. Q03 API合同、错误与安全边界统一

### 用户场景

1. 前端收到错误时能稳定区分“资源不存在、版本冲突、请求无效、运行结果未知、服务暂不可用”，并给出正确恢复动作。
2. Provider、数据库或内部库抛出异常时，用户不会看到内部路径、SQL或秘密配置。
3. 后续Channel和外部Client可依赖版本化合同，不需要解析中文异常字符串。

### 目标

所有REST和AG-UI边界使用稳定错误码、脱敏消息、关联ID和明确的可重试语义；OpenAPI成为可测试合同。

### 方案级做法

1. 定义统一`Problem Detail`响应：`code`、`message`、`request_id`、`retryable`、`details`白名单。
2. 用全局异常映射替代路由中重复的`detail=str(error)`；内部异常保存于受控日志，不直接外泄。
3. 为主要端点补Pydantic响应模型、错误响应和版本策略，生成前端DTO或共享Schema。
4. 明确认证、Principal/Scope注入点、CORS和pi网关凭据边界；私有Provider入口不出现在公开Schema。
5. Provider、Tool和Worker错误使用统一分类，但不把`outcome_unknown`降级为普通可重试错误。

### 验证与完成门

1. 对每个错误分类做合同测试，HTTP状态、错误码、重试提示和日志关联一致。
2. 注入数据库、Provider、Checkpoint损坏和非法Cursor错误，响应中不得出现密钥、路径、SQL或调用栈。
3. 前端对冲突、过期、410、未知结果和服务不可用分别展示可执行动作。

## 5. Q04 可观测性、日志和调试体系

### 用户场景

1. 某次回答停在审批、Worker失联或Product提交门时，开发者能从一个关联ID定位完整链路。
2. 用户反馈“页面一直等待”时，能够判断是浏览器订阅、Runtime Job、MAF节点、Provider、Tool、Outbox还是数据库故障。
3. 运行数天后，运维能看到积压、Lease过期、未知结果、错误率和耗时，而不是只翻本机文本日志。

### 目标

在不保存隐藏推理和秘密Payload的前提下，让每个关键状态变化可查询、可关联、可度量。

### 方案级做法

1. 建立统一日志初始化、JSON/控制台双格式、字段白名单和脱敏器。
2. 使用ContextVar或等价机制贯穿`request_id/principal_id/session_id/interaction_id/product_run_id/attempt_id/job_id/workflow_id/execution_request_id/worker_id`。
3. 对接OpenTelemetry兼容Trace和Metrics；至少记录请求/模型/Tool/节点/DB/Outbox/Worker耗时、错误、队列深度和Lease状态。
4. 区分`live`、`ready`、Worker健康、依赖健康和产品积压；现有`/api/health`不再承担全部职责。
5. 建立脱敏诊断包、Run时间线、事件游标检查器、Checkpoint兼容检查器和本地故障注入命令。

### 验证与完成门

1. 随机抽取一次真实模型Run，能从前端请求追到Provider Attempt和Product Final，且所有ID一致。
2. 注入Worker强退、Provider超时、Outbox死信、Cursor过期和Checkpoint损坏，日志与指标能明确区分。
3. 自动测试验证日志不含密钥、完整私有Payload、隐藏推理和用户未授权内容。

## 6. Q05 测试金字塔、覆盖率与故障实验室

### 用户场景

1. 用户连续几周推进学习和项目时，改动不会破坏跨天上下文、Work状态或Memory来源。
2. 浏览器刷新、多标签、API/Worker强退、重复点击和Provider结果未知都能稳定复现，而不是靠人工碰运气。
3. 前端组件在窄屏、键盘、读屏和错误恢复下可用。

### 目标

把当前“场景覆盖较强但证据分散”升级为可度量、分层、可重复的产品验证体系。

### 方案级做法

1. 单元层覆盖状态机、Hash/CAS、编译器和纯投影；合同层覆盖OpenAPI、AG-UI、MAF安装版、Provider和pi RPC。
2. 集成层使用真实SQLite/迁移、Worker进程、Checkpoint、Outbox和事件Journal。
3. Playwright覆盖聊天、审批、ExecutionDraft、Workflow、Session重开、配置和Harness工作区；加入axe或等价可访问性检查。
4. 建立可控Provider/Tool故障代理，精确注入“发送前、已发送无响应、部分流、回调重复、结果未知”。
5. 增加并发、属性测试、长场景、容量和性能基线；真实模型只验证不可由替身证明的边界。
6. 设分层覆盖率门，不追求一个总百分比掩盖高风险分支空白。

### 验证与完成门

1. CI输出后端、前端、合同、E2E和高风险状态转换的覆盖报告。
2. 完整故障矩阵可以单命令运行，并保留机器可读证据。
3. 21天项目、28天学习和跨项目切换长测保留，同时增加第二天重连、第三天新项目、多设备和权限撤销。

## 7. Q06 前端Feature架构与交互质量

### 用户场景

1. 用户切换聊天、Workflow、HITL、Agent、Tool和Harness时，各区域状态不串线，刷新后从服务端权威状态恢复。
2. 一个长回答或大Workflow不会让会话侧栏、Workbench或审批工作台卡顿。
3. 新Feature可复用统一表单、错误、加载、空态和可访问性模式。

### 目标

从当前平铺文件和超大组件演进为Feature边界清晰、API缓存一致、可测试且可访问的前端。

### 方案级做法

1. 按`chat/session/workflow/governance/harness/agents/tools/settings`建立Feature目录；公共UI、合同和API Client单独管理。
2. 拆分`App.tsx`、`use-chat-agent.ts`、`model-call-review.tsx`和`workflow-run-view.tsx`；Zustand只保留页面状态。
3. 建立统一Request Client、错误映射、取消、超时、缓存/失效和事件订阅生命周期。
4. 大列表使用分页/虚拟化；高频Delta批量渲染；清理轮询、计时器和订阅。
5. 建立基础设计Token、组件Story/测试夹具、键盘导航和响应式断点。

### 验证与完成门

1. 组件级测试覆盖加载、成功、空、冲突、断线和恢复；Playwright覆盖真实交互。
2. React Profiler或等价指标证明流式回复、100个Session和大型Workflow下没有非必要全树重渲染。
3. 键盘、焦点、ARIA、颜色对比和窄屏通过自动与人工审核。

## 8. Q07 文档、注释、ADR与依赖治理

### 用户场景

1. 新开发者能从一次用户点击定位到协议、应用服务、数据库、MAF和前端渲染，不依赖口头传承。
2. 升级MAF、AG-UI或Provider SDK时，能知道当前使用了哪些私有API和必须重跑哪些合同。
3. 用户查看项目状态时，不会看到已经实现的能力仍被写成“未来Todo”。

### 目标

代码说明非显然的“为什么”和不变量；文档拥有单一事实责任；依赖升级有证据和回退门。

### 方案级做法

1. 为公开应用服务、边界接口、状态机和复杂恢复逻辑补docstring/JSDoc；不写复述代码的注释。
2. 为私有MAF API、外部协议、事务门、Fence和结果未知建立ADR/兼容记录。
3. 在CI中校验文档链接、概念空间、OpenAPI快照、迁移头和计划/状态中的过期标记。
4. 把`PROJECT_STATE`保持为当前事实；历史变化进入Changelog/Release Note，避免无限追加时间线。
5. 建立MAF/AG-UI/pi/Provider依赖升级清单、版本锁、变更审查和真实回归门。

### 验证与完成门

1. 4类读者复核：架构师、项目经理、开发和产品负责人都能找到所需证据。
2. 故意制造失效链接、过期版本和OpenAPI漂移时，验证门失败。
3. 所有私有API使用点都能映射到一项版本锁定测试和替代计划。

## 9. F01 通用Tool Operation Ledger与副作用对账

### 用户场景

1. Agent创建Issue、写文件或调用外部系统后Worker崩溃，系统知道是未执行、成功、失败还是结果未知。
2. 用户重试时不会盲目重复扣费、重复发消息或重复修改外部资源。
3. 结果未知时，用户能查看证据并选择查询、补偿、接受现状或人工处理。

### 目标

Tool执行拥有独立、耐久、可授权、可对账的生命周期；不宣称无法保证的通用Exactly-once。

### 方案级做法

1. 建立Tool Catalog/Capability、Operation、Attempt、Idempotency Key、External Reference、Outcome和Reconciliation记录。
2. MAF Function Middleware统一进入Tool Gateway，Tool不能绕过治理直接执行。
3. 每种Tool声明只读/副作用、可幂等、可查询、可补偿、超时和权限扩张规则。
4. Tool请求、批准、外发边界、响应摘要和Evidence同一关联链；结果未知默认失败关闭。

### 验证与完成门

覆盖发送前崩溃、发送后断线、部分成功、重复回调、幂等冲突、查询成功/失败、补偿失败、人工裁决和跨进程HITL；外部副作用不得因自动恢复被重复执行。

## 10. F02 Evidence、Artifact、Provenance与独立生命周期

### 用户场景

1. 用户问“为什么说这个任务完成了”，可以看到验证证据、来源、时间和仍有效状态。
2. 来源文件删除或权限撤销后，相关Memory、Context和完成结论自动降级或失效。
3. Agent生成代码、报告或图片后，Artifact可追踪、可验证、可交付，而不是只存在于一条聊天文本。

### 目标

结果、证据、来源和交付物成为独立产品事实；模型陈述不能直接变成已验证完成。

### 方案级做法

建立Evidence、Evidence Check、Artifact/Revision、Provenance Edge、Validity、Source Revocation和Delivery引用；Work完成门只接受符合策略的Evidence，Trace只记录事件而不冒充证据。

### 验证与完成门

覆盖证据接受/拒绝、来源更新/删除/撤权、Artifact中断、校验失败、重复证据、跨Session引用和失效传播；用户界面能解释“结论、依据、有效性、下一动作”。

## 11. F03 Runtime完整故障、容量和游标矩阵

### 用户场景

1. 浏览器刷新、换设备或多标签同时查看同一Run时，内容不丢、不重复、不串Run。
2. API或Worker被强制结束后，安全任务被接管，外发中的任务进入结果未知，不产生双执行。
3. 长回答、并发Run和事件保留达到边界时，系统有明确背压、410和人工处置。

### 目标

把现有Job/Journal/Cursor/Lease纵向切片提升为经过容量与故障矩阵验证的R2/R3能力。

### 方案级做法

补齐真实SIGKILL、订阅竞态、Cursor签名/过期/保留、Delta批量写、背压、队列容量、Lease风暴、数据库故障和精确Provider/Tool dispatch marker；保留旧Epoch终态Fence。

### 验证与完成门

多OS进程、多标签/设备、真实410、事件缺口、百万级Delta基准、Worker风暴和真实Provider断线均有自动证据；终态、Event Journal与Product Message最终一致。

## 12. F04 Session完整生命周期、树、控制与可移植性

### 用户场景

1. 用户编辑历史消息、重新生成、Fork分支后，旧消息和旧Run仍可审计。
2. 活动Run中Steer、排队Follow-up或取消时，动作语义明确且可恢复。
3. 用户搜索、标签、导入、导出、分享、删除或过期Session时，附件、Run、Artifact和权限一致处理。

### 目标

完成Session能力全集中的生命周期、树、控制、资源和可移植性，而不把Product Session与MAF Session混用。

### 方案级做法

实现活动Leaf和分支血缘、编辑/重新生成/Fork、Steer/Follow-up队列、搜索/标签、Compaction、附件、导入导出、分享/删除/保留策略；所有操作绑定Principal和版本。

### 验证与完成门

覆盖分支并发、旧Run晚到、活动Run切支、跨重启Steer、导出再导入、删除与来源失效、跨设备恢复和大型树性能。

## 13. F05 任意Workflow、嵌套Workflow和pi持久恢复

### 用户场景

1. 任意已发布Workflow在等待审批、模型或子Workflow时重启，能从声明过的安全点恢复。
2. Definition升级后，旧Run仍按原版本解释，不被新图污染。
3. pi Agent或嵌套Workflow失败时，用户能看到子级状态、Checkpoint兼容性和不能自动恢复的原因。

### 目标

把主Workflow的特例桥扩展为版本化、可声明恢复能力的通用Workflow Host，同时不越过Tool副作用账本。

### 方案级做法

建立Definition版本仓库、图签名、Executor兼容声明、Checkpoint Adapter、父子Run/Checkpoint映射和恢复能力矩阵；pi Session、MAF Checkpoint和Product Run继续分开。

### 验证与完成门

覆盖旧Definition、嵌套成功/失败/审批、子级HITL、Checkpoint损坏、版本不兼容、Worker竞争、pi进程退出和Tool结果未知；已完成节点不重复，不能恢复时明确失败关闭。

## 14. F06 独立Intent、Harness交互与Context权限治理

### 用户场景

1. “我有哪些项目”直接查询权威Harness，不再由模型猜测或错误澄清。
2. 用户在学习、项目和简单询问间切换时，系统只装配当前目标的最小充分Context。
3. 用户能修正Intent、关联Project、采用/排除Context；来源撤权后不会继续进入Prompt。

### 目标

Intent、Project/Work、Context和Memory各自拥有版本、来源和生命周期；用户能看懂并控制Prompt装配。

### 方案级做法

把Intent从Workflow临时候选演进为可修订资源；完善Harness目录/详情/候选提交工作台；Context Source增加权限、失效传播和Adoption撤销；Prompt Compiler只消费获准版本。

### 验证与完成门

覆盖简单问答、项目目录、歧义澄清、短回答承接、跨天学习、项目切换、多Intent、用户排除Context、权限撤销和Token预算；长会话不无界拼接历史。

## 15. F07 Principal、Scope、Channel Binding与Delivery

### 用户场景

1. 同一用户从Web和Telegram继续同一个项目，身份与权限一致，不重复创建工作或执行。
2. 外部平台重复消息、乱序回执或暂时离线时，Chat仍保持唯一事实源。
3. 结果已完成但平台投递失败时，用户在Web仍能看到结果，系统可安全重投。

### 目标

建立真实身份、Scope、入口Binding和可靠Delivery；外部平台只通过合同接入，不形成第二套Session/Work/Run规则。

### 方案级做法

实现Principal、Membership/Scope、Channel Binding、Inbound Envelope/Idempotency、Delivery Outbox/Attempt/Receipt/Dead Letter；Telegram和OPC-OS Bridge分别使用版本化Adapter合同。

### 验证与完成门

覆盖身份绑定/解绑、越权、重复输入、跨入口并发、撤权传播、离线投递、乱序回执、死信和外部系统不可用；Chat本身仍独立可用。

## 16. F08 Provider配置、运营、备份、保留与SLO

### 用户场景

1. 管理员新增Provider和模型后，经校验和审批发布，不必手改代码；失败配置不会影响正在运行的Run。
2. 数据库损坏、磁盘不足或升级失败时，可以恢复产品事实并知道丢失边界。
3. 运维能依据SLO看到延迟、错误、积压、费用、Token和保留状态。

### 目标

把当前启动时私有JSON快照扩展为版本化配置和生产运营体系，同时保持秘密只在服务端。

### 方案级做法

建立Provider Capability同步/人工发布、配置Revision与热重载、运行快照绑定、结果未知处置、备份恢复、数据保留/清理、容量预算、费用/Token统计、SLO/告警和升级回滚。

### 验证与完成门

覆盖配置并发、错误回滚、运行中切换、Provider目录不可用、备份恢复演练、保留清理、磁盘/数据库故障、SLO告警和真实双Provider回归；任何日志、Trace、前端响应和Git都不含密钥。
