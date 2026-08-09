# S7任务书：兼容、容量、故障与最终发布验收

> 状态：已批准，待实现验收  
> 阶段目标：从整体而非单PR视角证明S1到S6组合后仍满足原始目标、既有产品不变量和长期代码质量要求  
> 前置完成门：S6受约束设计器真实E2E通过  
> 声明边界：只有S7完成，项目才可以声称前后端可配置工作流模块整体完成

## 0. 阶段约束

1. S7不是“补测试周”；S1到S6每个任务已各自通过，S7只做跨阶段组合、容量、兼容和独立反证。
2. 发现架构或事实所有权错误时回到对应阶段修复，不在S7堆兼容if、UI去重或弱断言。
3. 真实E2E必须使用隔离临时Store/账户/资源；不能迁移、清空或污染用户日常数据。
4. 不因最终门临近而删除旧Runner、迁移备份或恢复证据；退役另需运行样本证明。
5. 发布结论必须列出证据和未覆盖边界，不能以“全仓测试绿”代替用户结果。

## S7.1 Store、Definition、Run与活动旧实例兼容审计

### 目标与结果

系统性证明从仓库支持的所有Store版本、当前固定Planning Run、S4新Run和S6用户Definition升级后都可读、可恢复、不可漂移；形成明确兼容矩阵和回滚边界。

### 兼容矩阵

| 维度 | 必测组合 |
| --- | --- |
| Store | 每个仓库仍支持的历史版本→最终版本；最终版本重复打开 |
| Product Run | legacy planning、new planning、note_capture；各含活动/等待/终态 |
| Runner | 旧Bundle活动Run、新Bundle活动Run、Bundle不兼容恢复 |
| Definition | system seed旧版/新版、user copy、draft/published/superseded/archived |
| API client | 兼容期旧Submit、当前Submit；旧DTO版本拒绝/兼容策略 |
| Project/Rules/Memory | 当前实际资源版本、归档/旧revision、迁移后引用 |

### 方案

1. 建立versioned fixture manifest，记录每个Fixture来源commit、schemaVersion、对象计数和内容Hash；Fixture脱敏且不手工修成只适配新代码。
2. 按真实迁移链逐版升级，不写“直接改version字符串”的捷径；每一步执行integrity check和原对象守恒检查。
3. 对waiting_human旧Run保存真实Runtime version evidence并恢复Decision；对不能安全恢复的旧本地Bundle按既有recovery规则明确失败收敛，不伪造继续。
4. 历史Viewer只用View Snapshot/Node Run查询；测试在不提供旧Definition latest和旧Runner源码执行能力时仍能显示。
5. 对新Definition A/B、归档和Catalog版本漂移做读写兼容；不兼容只读状态必须可解释。
6. 输出兼容支持表：可读、可继续、只读历史、明确失败四类，不使用模糊“best effort”。

### 测试设计

1. 每个Fixture升级两次、重启、执行一个合法新事务、再次重启。
2. 原集合对象ID/revision/hash/数量守恒；新增投影按规则计数；无历史Message自动变Note。
3. 旧waiting_human批准/修订、旧execute checkpoint恢复、新Run同时运行，Hook/Outbox不串。
4. Definition Revision A活动时发布B/归档，A按原RunSpec继续；历史图不依赖B。
5. 降级演练：最终Store用旧不兼容构建打开必须明确拒绝而非损坏；兼容构建只读/停写步骤真实执行。
6. Store损坏、迁移中断、磁盘满/rename失败保留原文件与脱敏报告。

### 完成门

- 兼容矩阵每格有自动化测试或明确“产品不支持且安全失败”的批准记录。
- 升级不丢事实、不重复副作用、不重写历史Hash。
- 旧Runner保留/退役建议基于活动Run和恢复样本；S7默认不删除。

## S7.2 容量、性能、大输入输出、保留策略与覆盖证据

### 目标与结果

用S4/S5真实样本和最大结构Benchmark确定所有尚未拍板的上限，验证JSON Store、Compiler、Runner和Viewer在声明范围内稳定，并形成可审核的行为覆盖报告。

### 方案与测量方法

1. 只收集脱敏尺寸元数据：Definition节点/深度/分支/循环、Manifest ref数、Preview字节、Timeline条数、Note/Plan/Artifact正文长度、Store对象数和文件大小；不复制用户正文到报告。
2. 样本包括当前B2、S4真实Planning、S5真实Note、S6最大合法Definition和生成的边界Fixture。
3. 对validate/compile、Store transaction/load、workflow-view query、LR layout/render、Node detail和Checkpoint size分别测cold/warm、p50/p95、峰值内存与响应字节。
4. 最终上限同时满足：覆盖已批准用户场景、对真实样本有余量、在参考机器不造成不可接受交互/恢复成本、limit+1能快速失败。
5. 选择公式、参考机器和最终常量写入version evidence；若JSON Store无法满足必要规模，S7阻断并另立存储演进设计，不能缩小用户场景掩盖。

### 必须收敛的参数

- Request/Definition最大字节、节点、深度、分支、loop嵌套与迭代、Composite子项和总执行预算。
- Run View初始节点数、展开子节点数、Timeline page size和Preview字节。
- Note/Plan/Artifact正文当前内联上限及超过后的明确拒绝/产品资源引用策略。
- Workflow step/checkpoint最大产品ref数量与响应摘要。
- Product Store建议对象/文件规模、启动/事务告警点和备份建议。
- Trace保留与产品Node Timeline边界：Trace可按现有治理清理，Node Run/Decision/Revision等产品事实不跟随Trace删除。

### 大输入输出策略

1. Workflow View永远只含安全摘要和Product Ref，不因正文小就复制完整内容形成两种语义。
2. Node Detail按slot惰性查询、服务端截断、cursor分页；limit/limit+1返回明确truncated和完整资源链接/不支持原因。
3. Runner checkpoint只保存ref/outcome/identity；扫描保证没有大正文、Provider payload或Credential。
4. 画布超出初始预算时折叠Composite/Loop iteration并线性fallback，不自动引入ELK/虚拟化依赖；实测需要再审查。
5. 任何offload若需要新对象存储，必须另有依赖、所有权、清理、失败和退出设计；S7不能用临时文件冒充耐久存储。

### 测试设计与覆盖定义

覆盖以行为/不变量为权威，数字报告用来发现遗漏：

1. 所有状态机合法边与非法终态重开100%映射到测试ID。
2. 每个IR成员、Node status、Run kind、Decision kind、Field descriptor、Problem code至少一正一反。
3. 每个公开Command具备happy、strict validation、CAS、command replay、command conflict和权限测试。
4. 每次Store迁移具备空/非空/损坏/悬空/Hash/IO失败/重复升级。
5. 每个Node projector有secret、正文和unknown field canary。
6. 每个Runner control container有正常、边界、checkpoint重启、超限和版本漂移。
7. 每个主UI有loading、empty、success、waiting、failed、unknown、stale、窄屏和键盘。
8. Planning、Note、Designer分别有真实纵向门，S7.4有组合门。

可引入与锁定Vitest版本匹配的coverage provider，前提是记录版本、许可证、锁文件影响和移除方式。Scoped line/branch报告不得下降且关键纯状态机/Validator不得有可达未覆盖分支；不为达到百分比添加无业务断言测试。对策略、Hash、幂等、权限至少执行代表性mutation/delete test，证明测试会在保证被移除时失败。

### 完成门

- 每个参数有样本、基准、最终常量、limit/limit+1测试和用户可见失败语义。
- 行为覆盖矩阵无空格；代码覆盖报告中每个未覆盖生产分支都有删除、补测或书面不可达解释。
- 最大声明规模下无OOM、栈溢出、Checkpoint正文膨胀、画布失控或Store半写。
- 容量报告不含用户正文、密钥和Provider原始数据。

## S7.3 失败、恢复、并发、权限与敏感数据全矩阵

### 目标与结果

从跨层边界系统注入故障与竞态，证明所有场景只能收敛到成功、明确失败、等待人工或结果未知，不产生假成功、重复消费、越权或敏感泄漏。

### 方案与故障注入点

| 边界 | 代表注入 |
| --- | --- |
| Browser→API | 重复点击、响应丢失、离线、旧revision、篡改payload |
| API→Store | 每个事务写点异常、并发CAS、磁盘/rename失败 |
| Outbox→Workflow | 请求前后崩溃、ack丢失、重复派发、旧Bundle |
| Runner→Application | step重放、私有API 401/409/500、超时、错误版本 |
| Human Hook | 创建结果未知、重复/乱序resume、错误Review ref |
| Memory/Project/Rules | 零结果、stale、无权、部分失败、响应过大 |
| pi/Model | timeout、stream中断、Schema非法、重复回调、提示注入内容 |
| External action | 调用后失联、对账成功/失败/仍未知 |
| Viewer | SSE断开、旧ETag、跨Run node ID、超大Preview |

### 测试设计与一致性Oracle

1. 编写只读Product Integrity Auditor，检查Run终态、Node终态、Transition最后状态、RunSpec/Definition/View Hash、业务对象链、Decision/Policy和Outbox/Attempt对应关系。
2. Auditor只报告，不修复；测试在每个故障后运行，任何矛盾直接失败。
3. Browser断言必须以Query返回的产品事实为准，不能把Toast或CSS状态作为Oracle。
4. Workflow/Trace可暂时不可用，但不能改变Product Auditor结论。

### 并发矩阵

- 同一session并发Planning与Note；同一Definition并发多个Run。
- 同一review两个Decision、同一Candidate confirm与reject、同一Note两个revision。
- Definition两个draft save、save与publish、publish与archive。
- compile读取后资源变更、Decision提交后Run取消、对账与人工retry同时发生。
- API/Dispatcher多实例重复消费同Outbox；所有竞态使用barrier稳定复现。

### 安全矩阵

1. IDOR：跨owner Session/Run/Node/Definition/Note/Source ref逐路由测试。
2. 输入：stored/reflected XSS、Markdown HTML、恶意URL、超长Unicode、prototype-shaped keys、unknown fields。
3. Runtime隔离：公开API/SSE/HTML/localStorage无Workflow Run ID、Hook Token、Runtime Credential、pi Session ID。
4. 模型内容不可信：Memory/Project/Note文本中的提示不能提升工具/节点/skip/权限；结构结果仍经Schema和Policy。
5. 日志/Trace/Error/coverage/artifact扫描Credential、Authorization、endpoint敏感query、Provider payload、hidden reasoning和完整用户正文。
6. Command和Hash不能替代授权；知道ID/hash的其他用户仍无权读写。
7. CSP/依赖前端安全沿用项目基线，React Flow/Markdown renderer不新增不受控远程资源。

### 完成门

- 故障矩阵每格有可重复测试、预期产品状态和Auditor通过结果。
- 无一次未知外部结果被普通重试重复执行；无一次Decision/Note/Artifact重复提交。
- 权限与敏感扫描零高危；任何例外必须是明确测试Fixture canary且不会出现在产物。
- 发现跨层补偿需要新产品事实时回到对应架构任务，不用日志或后台脚本静默修。

## S7.4 干净环境Planning + Note + Designer真实组合E2E

### 目标与结果

从干净、隔离环境执行用户最初描述的两个核心流程和Definition编辑，证明安装、迁移、真实服务、浏览器、恢复和产品查询组合成立。

### 方案与环境原则

1. 使用mktemp创建明确临时工作目录和Store；所有清理只针对解析并校验过的临时路径，不触碰仓库外用户数据。
2. 复用项目固定端口/调试脚本，启动前preclean只清测试Runtime证据；检查密钥存在性，不打印值。
3. 使用真实Vercel Workflow、真实已批准Memory backend、真实Project/Rules数据Fixture、真实pi/model provider和真实浏览器。
4. 运行证据保存产品ID/revision/hash、状态、时间、脱敏错误和截图；不保存Provider全文或隐藏推理。
5. 测试失败保留隔离目录路径和安全诊断，用户批准后再清理；成功按脚本可恢复清理。

### 组合场景A：自定义Planning

1. 启动空Store并完成所有迁移/Seed。
2. 复制Planning Definition，配置允许的Memory/Project/Rules/Skill、manual review和有限修订循环，发布A。
3. 发送真实需求，查看各节点输入/输出；第一次Plan请求修订，第二次批准。
4. 执行、验证、提交真实产品结果；中途在waiting_human重启Workflow/API一次。
5. 发布Definition B，确认活动A不漂移；新Run摘要显示B但不必重复付费完成全链。

### 组合场景B：Note Capture

1. 在同一产品Session选择场景A的一段Message作为来源，选择Note Definition。
2. 真实模型生成project_idea Candidate；用户编辑tag/正文并确认。
3. Note提交后从列表按tag找到，打开详情与来源/Decision/Run Viewer。
4. 重启服务和刷新浏览器，Planning Artifact、Note Revision和两条Run历史保持。

### 测试设计与断言

- 不是只检查页面文字：直接Query并验证Definition→Revision→RunSpec→View→NodeRun→业务对象Hash链。
- 模型调用次数符合预期，刷新/重放/恢复不增加不该有的调用。
- Console无未处理错误，所有Network响应符合strict合同且无敏感字段。
- 同一Session两种Run不串phase、Decision、Hook、Node或最终资源。
- 手机viewport能完成查看/审核/Note确认，桌面能完成Designer与横向Viewer。

### 完成门

- 两个核心用户结果在一个干净环境真实完成并通过Product Integrity Auditor。
- 真实服务、真实模型和浏览器证据齐全；故障矩阵的可控替身没有冒充主场景。
- 脚本可重复运行且不依赖开发者手工修改Store/数据库；失败能定位到明确阶段和对象。

## S7.5 代码质量、依赖、as-built文档与发布门

### 目标与结果

在用户最终批准发布前完成全仓代码/架构审查、依赖与许可证审计、验证命令和as-built文档，让模块可以持续演进而不是只在当前Demo成立。

### 方案与代码质量审查

1. 依赖方向：Domain不依赖Hono/React/Vercel/AG-UI/pi；Router/Workflow Step/React不直接写Store；Adapter依赖Application Port。
2. 事实所有权：Product Store、Workflow Store、pi Session、Trace/Journal、浏览器缓存身份不合并；没有metadata万能袋。
3. 类型：strict、noUncheckedIndexedAccess、exactOptionalPropertyTypes；新增any为零，unknown显式缩窄，网络/Store/Runtime边界strict parse。
4. 责任规模：函数超过80行、Hook/组件超过500行、模块超过800行逐个记录保留/拆分理由；禁止WorkflowService、Repository-per-table、utils垃圾桶。
5. 事务/幂等：关键命令逐一审计command identity、expected revision、Hash、Outbox和结果未知；业务成功与Node状态原子提交。
6. 注释：关键跨层身份、数据结构、事务、恢复和失败边界说明“是什么、为什么、怎样失败”，不写复述代码的噪声注释。
7. 前端：Workflow hooks/graph/inspector/composer/designer职责分开；RealWorkspace/use-real-chain没有继续成为万能组件。

### 依赖与供应链

- 列出新增React Flow、可选coverage provider及其精确版本、许可证、安装原因、bundle/CI成本、替代与退出方式。
- 锁文件只含批准依赖；无临时Spike、ELK、通用JSON表单、表达式引擎或重复Markdown库残留。
- 执行仓库现有依赖/许可证安全检查能力；若无自动化能力，记录人工核对来源和已知限制，不假称完整SCA。
- Runtime与pi版本证据固定，旧Bundle兼容清单可审计。

### 测试设计与最终验证命令

至少在干净安装/构建环境执行并保存退出码：

~~~text
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
~~~

再执行S1到S7专项迁移、恢复、Kernel、真实Provider和Playwright命令。真实测试必须先运行对应preflight和固定Runtime evidence检查；具体脚本名随实现加入package.json并写入调试文档。

### 文档交付

1. 更新technology-contract仅在实际边界改变且经批准时；否则更新as-built system-boundaries/runtime-workflows。
2. 新增Workflow Definition/Run/Node/Note状态图、公开/私有API合同、Store迁移链、Runner恢复序列和前端交互说明。
3. 更新调试手册：固定端口、如何定位Product Run/Node、如何区分Trace与产品Timeline、如何恢复结果未知。
4. 更新PROJECT_STATE、PROJECT_PLAN、PROJECT_LESSONS和session handoff，明确已完成/未完成边界。
5. 生成最终追踪报告：42任务→S1到S7→O1到O14→原始用户六目标→测试证据。

### 发布/不发布判定

只有以下全部成立才建议批准：

- 42个任务均在独立PR有完成证据，且无被绕过的阶段门。
- O1到O14每项至少一个阶段证据和一个S7复验证据。
- 真实组合E2E成功，Product Integrity Auditor零矛盾。
- 无P0/P1安全、数据一致性、恢复或旧Run兼容缺陷。
- 容量范围、已知限制和未来非目标公开清楚。
- 用户审核最终体验、架构和证据后明确批准。

旧Runner删除、通用插件市场、任意脚本节点、Reminder调度、多人协作和数据库替换均不属于发布门，不得顺手实施。

## 6. S7最终反向验证

| 验证方向 | 必须得到的结论 |
| --- | --- |
| 从任务到阶段 | 每个任务只交付一个结果，任务并集覆盖对应阶段完成门 |
| 从阶段到整体 | S1到S7并集覆盖O1到O14，无阶段测试互相冒充 |
| 从整体到原始目标 | 配置、组合、审核、循环、两种流程、运行查看均有真实用户证据 |
| 从故障反推事实 | 任意边界失败只产生明确失败/等待/未知，无假成功和半提交 |
| 从未来变更反推架构 | 新Definition组合不改Runner；新Node仍需受控代码/测试；历史Run不随最新定义漂移 |
| 从代码反推维护性 | 无万能层、无重复引擎、严格类型/Schema/依赖方向和行为覆盖 |

若其中任何一项只能靠人工解释、日志猜测或未来计划才能成立，则整体尚未完成，不应批准发布。
