# Chat 项目经验与决策检查

本文件只保留会直接伤害新架构的高价值约束。每次设计、实现或审核前必须检查。

## 1. 不让Runtime拥有产品

Workflow Run、Checkpoint和pi Session能够恢复执行，但不能替代Product Session、Product Run、Approval、Work、Memory和Evidence。

检查：关闭或替换Runtime后，产品历史和长期事实是否仍完整？

## 2. 不把浏览器缓存写成事实源

TanStack Query、AG-UI reducer、IndexedDB和localStorage都只是缓存、草稿或投影。

检查：清空浏览器后，服务端是否能重建用户看到的正式状态？

## 3. 不用一个协议承载所有东西

产品资源使用Query/Command合同；活动Agent交互使用AG-UI兼容事件；媒体和大文件使用专用传输。它们可以共享身份与关联ID，但不能互相冒充。

检查：AG-UI事件是否被错误用作Project、文件或审批的唯一存储？

## 4. 不建立两套竞争实时协议

浏览器只订阅一条Chat有序事件流。Vercel Workflow原始流、pi原始事件和产品变化必须在后端归一化，不分别暴露给前端争夺游标与终态。

检查：一次Run是否只有一个公开sequence、cursor和终态来源？

## 5. Durability不是保存聊天记录

历史恢复、活动流重连、Workflow恢复、HITL恢复、Tool副作用对账和Worker接管是不同保证。

检查：方案是否明确进程退出时保存了什么、没有保存什么、怎样恢复？

## 6. HITL先提交决定，再恢复执行

浏览器不能直接持有或恢复Workflow Hook。用户决定必须先通过服务端身份、权限、revision、Hash和幂等校验，形成产品Decision，再由后端恢复Workflow。

检查：重复点击、旧页面、越权用户和过期决定是否都安全失败？

## 7. Product Session不等于长寿命Workflow

一个Product Session可以包含多个Product Run；一个Interaction可以触发零到多个Run。Workflow Run的生命周期不能反向规定产品会话结构。

检查：Workflow结束、替换或清理后，用户会话是否仍可继续？

## 8. 外部副作用不做盲重试

Provider或Tool请求发出后失联，状态可能是`outcome_unknown`。系统必须查询、对账、补偿或请求人工处置。

检查：普通异常重试是否可能重复扣费、发信、删除或写文件？

## 9. 模型输出只是候选

Agent说“完成了”不改变Work状态；必须经过结构校验、Evidence和产品提交门。

检查：最终状态能否由确定性事实解释，而不是依赖模型自述？

## 10. 先做一条完整纵向链

架构边界完整后，优先实现最小端到端场景，用真实断线、恢复和重复请求验证，再扩展节点类型与可视化工厂。

检查：新抽象是否服务当前纵向链，还是为尚不存在的未来预建平台？

## 11. 完成门从干净状态验证

先执行Build再启动可能掩盖Workspace源码解析、缺失产物和启动编排问题。完成门必须包含干净检出、无`dist`、冻结锁安装后的真实启动或端到端Smoke，并由CI固定。

检查：删除所有可再生产物后，声明可运行的入口是否仍按文档启动，而不是依赖审核者碰巧先执行过其他命令？

## 12. 版本证据不等于提前安装

未来阶段依赖可以在证据中记录版本、源码提交、许可证和升级门，但未被当前代码使用时不应为了“锁版本”进入生产依赖与审计面。

检查：新增依赖是当前工作包真实执行所需，还是只需要记录而不需要安装？

## 13. 版本号不能证明实际使用的是哪份源码

相同SemVer可能来自不同提交、分支或自定义源码。冻结源码时必须同时核对发布`gitHead`、Tag、Tree或发布包Hash，不能只比较`package.json`版本字段。

检查：本地、CI和未来部署使用的实际代码能否追溯到批准的源码提交，尤其是本地定制提交？

## 14. 依赖治理检查实际安装内容

新增依赖必须同时核对实际LICENSE文件、运行时`engines`、传递依赖安全审计和退出方式。注册表元数据缺失或错误时，记录证据来源；根运行时范围不得低于直接依赖要求。

检查：锁文件对应的实际安装内容是否通过许可证、运行时和生产依赖漏洞审计，而不是只在文档表格中看起来正确？

## 15. 先解释用户要得到什么，再说内部技术名词

`pi工件`、`Product Store证明级别`和`测试运行合同`对实现者可能精确，但不能直接说明用户场景、产品结果和选择影响。面向用户的计划先说“本地与CI是否使用同一份代码”“服务重启后数据是否还在”“哪些测试用真实组件”，必要时再补技术名词。

检查：不熟悉当前实现的人能否从任务说明回答“为什么做、完成后我能看到什么、不做什么、失败时怎样表现”？

## 16. 阶段目标不能直接当成一次开发任务

“第一条纵向链”可以是阶段目标，但同时包含前端宿主、消息、存储、Workflow、Agent、实时事件和正式提交时，已经不适合作为一个开发任务或一个PR。阶段必须拆成独立可合并、一次只证明一个结果的小任务，技术决定放到最近的任务中。

检查：当前任务是否只有一个主要结果、一个独立PR和清楚的完成门？如果预计超过2个单人开发日，是否继续拆分？

## 17. 目标交互形态要从第一批界面任务进入验收

如果产品已冻结为DSH Web，就不能先另做一套临时页面，再到后期“换壳”。DSH原生布局、插件Slot、响应式行为、草稿和网络失败语义应从第一条用户纵向开始验证；桌面壳与复杂离线能力只在真实需求出现后增加。

检查：第一批用户界面是否已经在真实DSH Host、手机视口、刷新和网络失败边界上验证，而不是只在临时Fixture中可见？

## 18. 后台能力必须有对应的用户看护界面

Workflow不能只作为后端实现存在。用户需要在Chat中看见当前工作、步骤、进度、暂停和失败，因此第一版前端外壳就要建立工作流运行区；后续Query和SSE只负责把真实状态接进去。这个区域是Chat拥有的产品投影，不是暴露Vercel Workflow控制台、内部ID或隐藏推理，也不等于提前实现完整图编辑器。

检查：新增后台能力时，计划是否同时说明用户在哪里看见和看护它？前端显示的是产品状态还是泄漏的Runtime内部状态？

## 19. 弱生产服务器只接收可追溯构建产物

低性能生产机不承担前端依赖安装、编译和测试。开发机或CI从审核通过的提交完成冻结锁安装、测试、构建、打包和Hash校验，服务器只接收静态产物并执行校验、解压、原子切换、Smoke与回滚。部署失败时切回上一release，不在服务器现场修代码或重新编译。

检查：发布过程能否证明产物对应哪个Git提交、是否经过校验、服务器上没有发生编译，以及失败后能否不重新构建就回滚？

## 20. 复杂Workflow先证明后端合同，再接前端

包含Agent节点、人工暂停、循环、执行和产品提交的Workflow，先用真实后端API、真实Workflow运行时、真实pi Agent loop与任务指定的真实Provider/模型证明完整状态链。前端可以先保留一个最小真实触发入口，但Plan、Decision和执行投影只能在后端Query/Command、错误族和事件语义稳定后接入，不能用fixture或React本地状态替后端决定产品语义。

检查：是否已经能够通过Chat API完成输入、计划、修改、批准、执行和正式结果，并证明同一Workflow恢复、旧决定失败、指定真实模型被调用且最终结果来自Product Store？

## 21. 可调试性和Trace是纵向链的交付物

复杂纵向链如果只能靠散落日志和手动启动复现，审核与故障定位会快速失控。必须提供固定端口、启动前清理本项目旧进程、未知端口占用安全失败、断点入口和按Product Run关联的结构化脱敏Trace。清理只能作用于已确认属于本项目的进程，不能使用模糊`pkill`伤害其他应用。

检查：连续两次启动调试是否使用相同端口且没有旧进程；一次Run能否从命令、事务、Workflow、Hook、Provider、pi一直追到Product Commit而不泄漏密钥、完整正文或隐藏推理？

## 22. 真实Provider完成门不能被替身冒充

状态机和失败注入应使用确定性测试，但当任务目标包含Provider或模型接入时，最终完成门必须运行用户指定的真实Provider与真实模型。真实测试应独立、显式、缺少凭据时失败关闭，并记录脱敏模型、请求ID、耗时和Usage；不能因费用或CI便利把可控模型结果写成真实接入证据。

检查：PR是否同时拥有稳定的纯规则测试和至少一次真实Provider证据，并对认证、限流、超时、付费重试和日志脱敏给出明确行为？

## 23. JSON Store也要守住事务和替换边界

阶段性使用JSON保存产品事实时，不能把它写成随处读写的全局文件。必须由一个Application Store Adapter单写、运行时校验、临时文件写入后原子替换、损坏时失败关闭，并明确单实例、并发、崩溃和未来数据库替换边界。

检查：Router、Workflow和pi是否都没有直接读写JSON；一次跨对象提交失败时旧快照是否完整；API重启能否重新读取已提交会话而不宣称已经具备多实例生产耐久性？

## 24. Trace记录系统路径，正文只保存一次

标签：`trace`、`observability`、`privacy`、`replay`

Trace负责记录系统时间线、调用关系、状态转换、Attempt、版本、耗时、错误、统计和产品对象引用，不复制用户消息、Plan、Decision、模型候选、Prompt或Provider Payload正文。正文和产品事实只保存在Product Store；Workflow状态由Workflow Store保存；Git、Workflow Definition、Prompt模板和模型配置由版本证据保存。历史回放由Replay Assembler按对象ID、revision和Hash组合这些来源，缺失引用或Hash不一致必须显式报告；真实模型重新执行必须创建新Attempt，不能覆盖历史运行。

检查：Trace合同是否使用事件级严格白名单并拒绝任意内容字段；能否用`productRunId`关联Trace与产品对象完成历史回放，同时保证Trace、PR证据和调试输出不复制正文、密钥、完整Provider Payload或隐藏推理？

## 25. 跨Runtime副作用先写意图栅栏

标签：`workflow`、`outbox`、`idempotency`、`outcome-unknown`

Workflow Start与Hook Resume跨过进程边界后可能丢失响应。调用前先耐久写入`starting/dispatching`意图，调用后只有可验证响应才能标记完成；任何无法确认的结果进入`outcome_unknown`并对账，不能因为HTTP重试再次Start或Resume。Runtime已有耐久运行数据但私有Binding文件丢失时必须拒绝创建空映射。

检查：断线发生在请求发出前、发出后、响应解析时和本地落盘时，系统是否都不会重复越过不可逆边界？

## 26. 能力源码与运行工件必须分开记账

标签：`dependency`、`supply-chain`、`pi`、`version-evidence`

本地源码提交可以证明API和行为，但不等于npm实际安装工件。运行合同必须同时记录包版本、发布基点和锁文件完整性；能力对照提交只能叫“能力证据”，不得冒充运行来源。升级时重跑流截断、工具次数、Provider证据与错误归一化测试。

检查：文档中的提交、锁文件中的SHA-512和CI安装到的包能否互相对应，是否还存在“同版本号所以同代码”的假设？

## 27. 付费E2E必须与普通回归物理隔离

标签：`e2e`、`provider`、`cost-control`、`test-isolation`

真实Provider E2E使用独立Playwright配置和显式命令；普通DSH Host/Client回归必须排除付费Spec。缺少Key时真实门失败关闭，普通CI仍可稳定运行确定性控制流测试，但不得把确定性pi结果写成真实Provider证据。

检查：普通`pnpm test`或DSH回归是否可能误触发付费调用；真实门缺Key时是否明确失败而不是Skip？

## 28. 集成设计必须从真实参考实现和本产品场景共同推出

标签：`research`、`architecture`、`integration`、`scope`

Memory、项目管理和规则系统不能只凭抽象接口或模型直觉设计。开始任务前必须定位实际参考项目、读取其数据结构、生命周期、接口和测试，明确“直接采用、按Chat调整、明确拒绝”三类结论；随后再用Chat的状态所有权、Workflow恢复、HITL和前端交互约束收敛方案。参考项目证明能力覆盖，不替Chat决定产品事实归属。

检查：任务书能否为每个重要模块指出真实来源证据和Chat场景调整，还是只写了听起来通用的Adapter、Service和标签？

## 29. 大目标按依赖拆小，但每个小任务必须形成可用纵向结果

标签：`delivery`、`task-sizing`、`e2e`、`quality`

“Memory + BMAD + 用户规则”是一个阶段，不是一个开发分支；但也不能把每个DTO或Adapter拆成等待很久、用户无法验证的小PR。先按共享合同、单一外部集成、单一用户场景和组合验收建立依赖图，每个PR只增加一个主要能力，同时从产品入口贯穿Application、Workflow、Adapter、Store和最小UI。局部测试在模块边界运行，真实模型和浏览器E2E只在形成纵向结果的里程碑运行，避免无意义地重复付费和拉长周期。

检查：当前任务是否既能独立审核和回滚，又能让用户实际完成一件事；验证是否放在最早能发现该类错误、且成本合理的节点？

## 30. 外部写入的“没收到响应”不是失败重试条件

标签：`memory`、`external-write`、`idempotency`、`reconciliation`

外部服务可能已经提交写入，只是Chat没有收到或无法解析响应。调用前必须固定operationId、规范化请求与request Hash；跨过fetch边界后，断连、超时、5xx和非法成功响应都先进入`outcome_unknown`。对账只能使用同一身份与同一正文，或按已知external ID读取验证，不能生成新ID盲目重写。`accepted`也不能直接显示“可查询”；需要按后端真实语义证明物化。

检查：把上游成功响应销毁后，产品是否先显示未知、再用同一身份收敛；外部数据库最终是否仍只有一个对象？

## 31. 能力与终态必须由后端合同表达，不能在投影层猜测

标签：`adapter`、`capability`、`workflow`、`memory`

不同Memory后端可能支持不同标签、层级和完成语义。公开能力必须逐字段投影Adapter声明，不能硬编码成第一个后端的能力；UI只负责据此显示，Application仍要再次校验。异步系统的`accepted`是“外部已接收”的合法收敛状态，不等于`materialized`，也不能被通用Workflow终态监督器误判成未提交或结果未知。后续物化通过显式、只读对账推进，不能重复写入。

检查：增加第二后端后，能力DTO是否仍逐字段来自真实Profile；每种非失败终态是否在Outbox监督、恢复、页面文案和回放中保持同一个含义？

## 32. 应用启动合同归仓库，VS Code只做薄调试入口且必须用真实F5证明

标签：`vscode`、`debug`、`process-lifecycle`、`acceptance`

本地服务图、准备、健康门和停止顺序必须由仓库统一`dev/dev:debug`启动器拥有，保证终端、VS Code和未来CI复用同一合同；不得再把Memory、Workflow、API和Web的生命周期复制进`launch.json/tasks.json`。VS Code只调用同一个启动器、附加Chat拥有的进程并在应用Ready后打开浏览器。浏览器必须使用worktree专属Profile，启动前只按“浏览器可执行文件+精确user-data-dir”身份收敛遗留进程和锁，不能为了避免旧Session警告杀全部Chrome；父会话停止时同时收敛整个专属浏览器。配置合同和等价命令仍不能替代真实F5：完成门必须从VS Code选择唯一应用入口，确认Chrome和TypeScript断点，再停止并确认端口、浏览器与进程投影收敛。私有环境在目标进程内部加载，不能用会把值展开到命令行的`envFile`。

检查：`pnpm dev`能否脱离编辑器独立启动应用；F5是否只调用同一启动器而不复制服务图；Memory、Workflow、API和Web是否全部Ready，Chrome与断点是否可用；遗留专属浏览器能否自动清理且日常Chrome不受影响；停止后固定端口是否释放且输出/argv没有凭据？

## 33. 关键纵向链必须同时交付中文代码导航和函数级调试文档

标签：`documentation`、`debug`、`maintainability`、`data-flow`

只有架构图无法解释断点中的具体对象，只有散落注释也无法给出完整阅读顺序。前端、公开API、Application事务、Outbox、Workflow私有API、Hook、Provider和Product Commit之间的主链必须同时具备两层导航：代码边界用中文注释解释数据结构、身份、所有权与失败语义；as-built文档用文件、函数/路由和观察变量给出可执行的断点顺序。断点索引以函数名为主，不能依赖会随注释漂移的固定行号。新增纵向能力时同步更新现有交互/调试事实源，不为同一行为再建互相竞争的说明。

检查：一个第一次阅读该功能的人，能否从README找到当前交互与调试入口，并在不猜Runtime身份、不翻历史任务书的情况下，从用户动作单步走到正式产品事实？

## 34. 本地旧Workflow版本不兼容时收敛工作，不能阻塞整套应用或删除事实

标签：`workflow`、`debug`、`version-evidence`、`recovery`

活动Workflow Run只能由创建它的代码/Bundle安全恢复；新代码不能静默续跑旧Checkpoint。但本地开发反复改代码时，一个不可恢复的旧Run也不应让Memory、API和Web全部无法启动。`pnpm dev/dev:debug`在Bundle构建后检查活动Run证据：一致则正常恢复；明确版本冲突则保留Message、Plan、Trace、Runtime事件、Binding和版本证据，通过Application原子终结Product Run/Attempt/Outbox，再用Workflow SDK取消旧Run并继续启动。证据缺失、损坏或映射不完整仍失败关闭。生产环境不使用这种开发降级，而应保留历史部署承接旧Run。

检查：代码变化后再次F5，旧Run是否形成可解释终态且当前应用Ready；是否没有删除`.data`、重放Provider/外部副作用或用新Bundle续跑旧Checkpoint？

## 35. 固定调试端口的所有权属于Git仓库，不能被worktree局部登记割裂

标签：`debug`、`process-lifecycle`、`worktree`、`ports`

多个worktree共享固定端口，却各自保存PID登记，会让一个worktree留下的Chat孤儿进程在另一个worktree中被误判为未知占用者，最终把“一键F5”退化为人工找PID。固定端口登记必须由Git Common Directory锚定为仓库级运行投影。登记因旧方案或IDE强停而丢失时，可以自动收敛的充分条件不是“进程名叫node”，而是固定端口角色、角色命令签名、进程cwd和Git Common Directory四重一致；发信号前还要再次校验命令与启动时间。任何一项不成立都继续失败关闭，不能用`pkill`、端口号或模糊路径误杀其他应用。

检查：另一个worktree留下无登记Chat服务后能否直接F5；换成相同端口上的其他仓库Node进程时是否仍拒绝清理；同一监听PID同时占服务端口和Inspector时是否只终止一次？
## 36. Project Solution不能退化为阶段、任务和文档CRUD

标签：`project`、`methodology`、`shape-up`、`bmad`、`domain-model`

用户需要的是一套能管理、维护和推进多个真实项目的解决方案，而不是BMAD文件目录或几张项目管理表。设计前必须分别研究：Shape Up如何为小团队处理Shaping、Appetite、Iteration、Scope、未知和Circuit Breaker；BMAD如何处理软件Artifact、Story准备度、开发、QA与Correct Course；Basecamp/Linear/Things如何处理Project地点、负责人Update和个人Next Action。Chat在此基础上拥有Project、Stage Goal/Milestone、Iteration、Work/Scope/Action、Resource、Participant、Contribution、Decision、Evidence和Update等产品事实。

Stage是长期发展阶段，Iteration是一次有限投入，Work是交付单元，Scope是执行中发现的结构，Action是具体待办；不能因为它们都“像任务”而合并。不同Method Profile选择需要的结构，小团队不强制六周，非软件和运维项目不强制BMAD Artifact或Iteration。每个设计概念必须经过多项目、小项目、棕地软件、非软件、运维、外部漂移和失败迭代场景验证。

检查：方案是否能基于证据回答用户有哪些项目、阶段目标、当前Iteration、谁在做、改了什么、为什么决定、有哪些待办和下一步；还是只能展示几个状态字段？

## 37. 项目进展、健康和完成必须由不同事实表达

标签：`project`、`progress`、`health`、`evidence`、`candidate`

Task完成比例不能代表Project进度，Git变化不能自动完成Work，Agent自述也不能成为verified Contribution。Project进展至少分为Stage/Milestone结果、Iteration边界、Scope未知度、Work/Action状态、负责人Project Update和真实Evidence。系统可以观察Resource、提示风险和起草Update，但健康判断由有责任的Participant发布；Stage、Iteration、Work和Project终态分别经过自己的Gate与Decision。

检查：10个Task完成8个但核心未知未解时，系统是否仍明确显示风险；PR合并后是否只形成Observation/Contribution Candidate，而不会自动把Project标成完成？

## 38. 先证明阶段闭包，再拆任务；任务也要先设计和测试再实现

标签：`planning`、`stage-gate`、`task-decomposition`、`verification`

大型能力不能从一份总体研究直接跳到“第一个任务书”，也不能一边实现一边补齐后续阶段。先写清整体用户目标、全局约束和最终证据，再一次性列出所有候选阶段的目标、输入、输出、不做事项、依赖与完成门；对阶段间的缺口、重叠、顺序和风险做自审，直到能够用追踪矩阵证明“每个阶段完成门全部成立时，整体目标一定被覆盖”。随后才形成整体及逐阶段的方案设计和测试设计，并再次检查组合是否闭合。

阶段总纲通过审核后，才一次性拆出全阶段的小任务依赖图，而不是只拆最近一个任务。任务地图也要检查是否完整覆盖阶段目标、是否存在孤立技术任务、是否能独立合并和回滚；之后每个任务分别完成用户结果、边界、实现方案、测试方案和完成门审核，最后才进入独立worktree、分支与PR实现。实现证据仍要在阶段结束和项目结束时回到阶段门与整体门复验，不能以“所有Task已完成”代替目标达成。

检查：是否已经证明阶段集合对整体目标完备且无关键缺口；是否在阶段总纲未通过前就写了PR编号或开始编码；每个任务是否在实现前已有可审核的方案、测试和上层目标映射？

## 39. 核心按责任所有权定义，非核心能力先复用上游

标签：`reuse`、`adapter`、`ownership`、`dependency`、`upgrade`

Chat最核心的代码不需要成为代码量最大的部分。产品事实、权限、决定、事务、幂等、失败终态、Workflow业务编排和治理必须由Chat拥有；文件、编辑器、Terminal、Git/Diff、Browser、Memory、前端宿主、Agent loop和耐久运行机制等通用能力，先审核并复用高质量、持续维护的上游。公开API/Slot/插件、独立Hosted App或Sidecar、固定且批准可追溯的Package是并列接入形态，应按所有权、隔离、权限、运行成本和退出路径选择；默认不复制、拆写或静默Fork上游源码。

“最小适配”指最小上游修改面和最窄稳定边界，不是最少代码。Bridge、Provider和Adapter仍必须承担当前边界适用的身份/namespace映射、外部Scope、Principal传递、运行时校验、生命周期、审计、升级门和退出路径；外部写副作用必须有幂等、`outcome_unknown`与对账，持久格式变化必须有迁移，只读边界不虚构写语义。它们不得拥有Application授权或事务、直接写Product Store，或把外部Session、Run和对象冒充Chat产品事实。是否复用不能只看Star、README、功能数量或LOC，也要比较许可证、安全、目标平台、运行控制面、维护活性、真实工件和长期升级成本。

检查：当前改动是在开发Chat不可替代的产品责任，还是在重写已有成熟能力；若选择外部项目，是否已经明确“直接使用 / Hosted App或Sidecar / 窄Adapter / 拒绝 / 自研”、事实所有者、稳定接缝、失败恢复、升级和可删除的退出方式？
