# Chat 可配置工作流全任务地图

> 状态：已获用户批准；实现按任务依赖顺序进行  
> 日期：2026-08-09  
> 上位目标：[阶段总纲与验证闭包](./configurable-workflow-stage-program.md)  
> 详细架构：[可配置工作流详细架构与方案设计](../architecture/configurable-workflow-design.md)  
> 研究证据：[参考项目与技术研究](../architecture/configurable-workflow-research.md)

## 0. 本文解决什么问题

阶段总纲证明S1到S7如何逐步达成原始目标；本文把阶段进一步拆成42个可独立实现、独立验证、独立回滚的任务，并回答五个问题：

1. 每个任务交付一个什么可观察结果；
2. 它依赖什么，又为后续哪个任务提供什么；
3. 哪些任务修改Product Store、公开合同、运行时或前端；
4. 什么时候做真实服务和浏览器验证，避免只靠Mock证明；
5. 单个任务通过后，为什么阶段目标与整体目标仍然有机会必然成立。

本文不是实施排期。大小只用于限制任务范围，不能把多个风险边界塞进一个PR，也不能为了追求小PR制造没有消费者的抽象层。

## 1. 全局实施纪律

### 1.1 一个任务的完成定义

每个任务必须同时满足：

1. 只有一个主结果，审查者可以用一句话判断是否完成；
2. 代码、网络合同、Store迁移、测试和as-built文档在同一任务闭环；
3. 新行为至少覆盖成功、业务拒绝、基础设施失败、重复请求和恢复后重放中适用的类别；
4. 新增跨层类型在权威层只有一份定义，其他层通过显式映射消费；
5. 关键事务、幂等、身份转换和结果未知边界有中文解释性注释；
6. 不以全局单元测试通过替代该任务的专项测试，也不以截图替代产品事实断言；
7. 每个实现任务使用独立worktree、分支和PR，合并后才开始依赖它的下一个任务。

每个实现PR还必须运行一条与其变更范围相符的真实产品链回归：使用真实服务、真实模型和真实浏览器证明既有用户结果未回归；任务新增结果再由本任务专项门和阶段真实E2E证明。S3这类尚未接入默认用户链的实验任务，除真实Workflow实验外仍运行当前已发布Planning真实链回归。模型调用控制输入和轮次，但不能用Mock替代这条治理门。

### 1.2 大小档位

| 档位 | 预期审查范围 | 约束 |
| --- | --- | --- |
| XS | 0.5到1个工程日 | 单一合同、纯验证器或单一UI基础件，不跨越两个事实所有权 |
| S | 1到2个工程日 | 一个纵向小闭环，可含合同、应用、Adapter和测试 |
| M | 1.5到2个工程日 | 只用于必须一起证明的事务或真实E2E门；预计超过2日必须在实现前再次拆分 |

大小不是进度承诺；真实外部服务不稳定、迁移发现异常或架构边界不成立时，任务必须停止并回到设计审查。

### 1.3 串行规则

1. S1到S7严格按阶段顺序推进，不能以并行开发绕过阶段完成门。
2. 同一阶段内，只有任务表明确标为可并行的测试准备或纯UI基础件可以并行；Store迁移、合同变更和运行时切换必须串行。
3. S1.3、S4.1、S5.2是三次独立Store演进，版本号在真正实现时基于当时主干当前版本顺延，文档不提前写死版本号。
4. S4.7之前不把新Runner设为默认；S7.5之前不删除旧Runner或兼容读取。
5. React Flow只能在S2.1证据门通过后加入；覆盖率Provider只能在S7.2证明确有用途、退出方式和许可证后加入。

## 2. 任务依赖总图

~~~mermaid
flowchart LR
    S11["S1.1 View Snapshot"] --> S12["S1.2 Node Run Domain"]
    S12 --> S13["S1.3 Store Migration"]
    S13 --> S14["S1.4 Planning Projection"]
    S14 --> S15["S1.5 Execution Projection"]
    S15 --> S16["S1.6 Query/API Gate"]

    S16 --> S21["S2.1 Canvas Basis"]
    S21 --> S22["S2.2 Run Canvas"]
    S22 --> S23["S2.3 Inspector"]
    S23 --> S24["S2.4 HITL Integration"]
    S24 --> S25["S2.5 Browser Gate"]

    S25 --> S31["S3.1 Node Catalog"]
    S31 --> S32["S3.2 Structured IR"]
    S32 --> S33["S3.3 Compiler"]
    S33 --> S34["S3.4 Policy and Limits"]
    S34 --> S35["S3.5 Durable Runner Lab"]
    S35 --> S36["S3.6 Recovery Gate"]

    S36 --> S41["S4.1 Definition Store"]
    S41 --> S42["S4.2 Submit and Compile"]
    S42 --> S43["S4.3 Context Plan Review"]
    S43 --> S44["S4.4 Review Policies"]
    S44 --> S45["S4.5 Execute Validate Commit"]
    S45 --> S46["S4.6 Composer UI"]
    S46 --> S47["S4.7 Real Cutover Gate"]

    S47 --> S51["S5.1 Note Domain"]
    S51 --> S52["S5.2 Note Store"]
    S52 --> S53["S5.3 Note Use Cases"]
    S53 --> S54["S5.4 Note Workflow"]
    S54 --> S55["S5.5 Note UI"]
    S55 --> S56["S5.6 Reuse Gate"]

    S56 --> S61["S6.1 Lifecycle Commands"]
    S61 --> S62["S6.2 Catalog Forms"]
    S62 --> S63["S6.3 Sequence Editor"]
    S63 --> S64["S6.4 Choice and Loop"]
    S64 --> S65["S6.5 Diagnostics and CAS"]
    S65 --> S66["S6.6 Publish and Run"]
    S66 --> S67["S6.7 Designer Gate"]

    S67 --> S71["S7.1 Compatibility Audit"]
    S71 --> S72["S7.2 Capacity and Coverage"]
    S72 --> S73["S7.3 Failure Matrix"]
    S73 --> S74["S7.4 Combined E2E"]
    S74 --> S75["S7.5 Release Gate"]
~~~

依赖图故意保持主链清晰。实施时可以在不修改权威合同的前提下提前准备Fixture，但任何任务只有在直接前置任务合入main后才能宣称开始。

## 3. S1：当前硬编码Run成为可验证的产品投影

| ID | 单一交付结果 | 主要代码范围 | 直接依赖 | 大小 | 阶段证明 |
| --- | --- | --- | --- | --- | --- |
| S1.1 | 定义Workflow View Snapshot及稳定节点身份合同 | contracts、domain、testing | 当前B2基线 | S | 历史和活动Run不依赖当前代码猜图 |
| S1.2 | 定义Node Run、Transition和Value Manifest状态机 | domain、contracts、testing | S1.1 | S | 节点状态、时间线、输入输出可成为产品事实 |
| S1.3 | 迁移Store并对既有Run做诚实回填 | product-store-json、testing | S1.2 | M | 重启后仍可读取；不伪造细粒度历史 |
| S1.4 | Context、Planning、Review与业务事实原子投影 | application、workflows、realtime | S1.3 | M | 规划与审核节点不是best-effort日志 |
| S1.5 | Execution、Validation、Commit及动态子节点投影 | application、workflows、realtime | S1.4 | M | 执行阶段真实可见，循环/多Action身份稳定 |
| S1.6 | 提供Run图与节点详情Query/API并通过恢复门 | application、api、contracts、testing | S1.5 | S | S2只能消费产品查询，不接触Workflow内部ID |

详细任务书：[S1 当前Run产品投影](./configurable-workflow-s1-run-projection.md)

## 4. S2：真实只读Run Viewer

| ID | 单一交付结果 | 主要代码范围 | 直接依赖 | 大小 | 阶段证明 |
| --- | --- | --- | --- | --- | --- |
| S2.1 | 验证并引入React Flow，完成确定性LR布局基础件 | web、testing、依赖清单 | S1.6 | S | 画布工具有真实退出方式，无ELK和存储坐标依赖 |
| S2.2 | 真实Run DTO驱动只读横向画布 | web、contracts | S2.1 | S | 运行节点/边/状态与后端投影一致 |
| S2.3 | Node Inspector展示Input、Output、Timeline、Evidence | web | S2.2 | S | 节点细节有边界、截断、下载和错误态 |
| S2.4 | 审核交互嵌入Human Review节点并保持命令幂等 | web、application/API小调整 | S2.3 | M | 暂停、修订、批准不再脱离图语义 |
| S2.5 | 手机、桌面、无障碍和真实浏览器验收 | web E2E、debug docs | S2.4 | M | S2对用户可用且刷新/轮询不破坏视口 |

详细任务书：[S2 真实Run Viewer](./configurable-workflow-s2-run-viewer.md)

## 5. S3：Definition Kernel与耐久Runner实验室

| ID | 单一交付结果 | 主要代码范围 | 直接依赖 | 大小 | 阶段证明 |
| --- | --- | --- | --- | --- | --- |
| S3.1 | 建立有限Node Catalog、Blueprint和Executor注册一致性 | domain、application、workflows | S2.5 | S | 节点能力受后端白名单控制 |
| S3.2 | 建立Sequence、Choice、BoundedLoop、Task结构化IR | domain、contracts | S3.1 | M | 不把任意React Flow图当执行结构 |
| S3.3 | 建立规范化、Hash与RunSpec编译器 | application、domain、testing | S3.2 | M | 同一定义产生确定的不可变运行输入 |
| S3.4 | 建立风险策略、skip、资源绑定和结构/数据限制 | domain、application | S3.3 | S | 高影响节点不被任意跳过，极端输入可预期失败 |
| S3.5 | 固定Vercel Workflow Runner解释RunSpec | workflows、pi-runtime测试替身 | S3.4 | M | 顺序、选择、循环、暂停由耐久运行时正确恢复 |
| S3.6 | 通过重放、版本、并发、性能与生成式验证门 | testing、workflows、debug docs | S3.5 | M | Kernel不是只在Happy Path成立 |

详细任务书：[S3 Definition Kernel](./configurable-workflow-s3-definition-kernel.md)

## 6. S4：可配置Planning真实纵向闭环

| ID | 单一交付结果 | 主要代码范围 | 直接依赖 | 大小 | 阶段证明 |
| --- | --- | --- | --- | --- | --- |
| S4.1 | 持久化Definition/Revision/RunSpec并内置Planning Definition | domain、product-store-json | S3.6 | M | 配置定义有正式生命周期和迁移路径 |
| S4.2 | 发送命令原子绑定配置、Revision、资源选择与Outbox | application、api、contracts | S4.1 | M | 运行前配置被编译并绑定，重复发送不重复启动 |
| S4.3 | 新Runner真实完成Context到Plan到人工审核 | workflows、application、memory、pi | S4.2 | M | 最常用工作流前半段完成产品闭环 |
| S4.4 | 手工、自动继续和修订循环策略都可验证 | domain、application、workflows | S4.3 | M | 用户能停、能改、也能显式跳过允许的审核 |
| S4.5 | 执行、验证、提交及外部结果未知保持既有保证 | workflows、application、pi、realtime | S4.4 | M | 后半段不因可配置化丢失安全边界 |
| S4.6 | Composer提供Definition、资源和有限运行配置 | web、contracts | S4.5 | M | 用户在发消息前完成选择，刷新不丢命令身份 |
| S4.7 | 新旧Runner切换并通过真实Memory/Project/Rules/模型/E2E | 全栈、testing、运维文档 | S4.6 | M | S4是可用产品能力，不是实验室演示 |

详细任务书：[S4 可配置Planning](./configurable-workflow-s4-configurable-planning.md)

## 7. S5：Note Capture第二纵向证明

| ID | 单一交付结果 | 主要代码范围 | 直接依赖 | 大小 | 阶段证明 |
| --- | --- | --- | --- | --- | --- |
| S5.1 | 定义Note、Revision、Candidate、Decision产品不变量 | domain、contracts | S4.7 | M | 笔记是正式产品对象，不是Message或Trace |
| S5.2 | 持久化Note聚合并验证迁移、并发与回滚 | product-store-json、testing | S5.1 | M | 笔记和修订可恢复且不会半提交 |
| S5.3 | 完成Note命令、查询和公开API | application、api、contracts | S5.2 | S | 创建、修订、确认标签和查询边界稳定 |
| S5.4 | 用同一Catalog/IR/Runner实现Note Definition和节点 | workflows、application、pi | S5.3 | M | 第二流程不复制一套引擎 |
| S5.5 | Composer、审核、列表和详情形成真实笔记体验 | web | S5.4 | M | 用户能快速捕获并看见权威笔记结果 |
| S5.6 | 真实模型和浏览器证明跨流程复用并做重复实现审计 | 全栈、testing | S5.5 | M | 可配置内核的复用价值有证据 |

详细任务书：[S5 Note Capture](./configurable-workflow-s5-note-capture.md)

## 8. S6：受约束Definition Designer

| ID | 单一交付结果 | 主要代码范围 | 直接依赖 | 大小 | 阶段证明 |
| --- | --- | --- | --- | --- | --- |
| S6.1 | 完成Definition草稿、Revision、发布和CAS命令 | domain、application、api | S5.6 | M | 编辑与发布有服务器权威生命周期 |
| S6.2 | 公开Catalog/Blueprint/配置字段合同并生成受控表单 | contracts、api、web | S6.1 | M | 前端不复制节点校验规则或执行任意Schema |
| S6.3 | 完成Sequence和可选节点的语义化编辑 | web、application | S6.2 | M | 用户可增删、排序、启停，不能自由造非法边 |
| S6.4 | 完成Choice和BoundedLoop结构编辑 | web、domain validation | S6.3 | M | 分支和循环以结构操作表达并始终有上限 |
| S6.5 | 完成实时诊断、预览、脏状态与CAS冲突UX | web、application | S6.4 | M | 非法草稿不能发布，并发编辑不静默覆盖 |
| S6.6 | 发布Definition、发起新Run并证明历史Run不漂移 | 全栈 | S6.5 | M | 设计器真正接入运行链且版本冻结正确 |
| S6.7 | 手机/桌面/无障碍/安全/真实E2E验收 | web E2E、security、docs | S6.6 | M | 设计器在约束范围内真实可用 |

详细任务书：[S6 Definition Designer](./configurable-workflow-s6-definition-designer.md)

## 9. S7：整体兼容、容量与发布验收

| ID | 单一交付结果 | 主要代码范围 | 直接依赖 | 大小 | 阶段证明 |
| --- | --- | --- | --- | --- | --- |
| S7.1 | 审计并修复旧Store、Definition、Run和运行中实例兼容 | 全栈、迁移测试 | S6.7 | M | 升级不丢事实、不误恢复、不依赖旧代码重算历史 |
| S7.2 | 形成容量、性能、大输入输出、保留策略和覆盖率证据 | testing、CI、docs | S7.1 | M | 所有限制来自测量，覆盖率反映关键行为 |
| S7.3 | 执行失败、恢复、并发、权限与敏感数据全矩阵 | testing、security、全栈 | S7.2 | M | 跨层故障不会产生假成功和泄漏 |
| S7.4 | 从干净环境完成Planning与Note组合真实E2E | 全栈、真实服务、浏览器 | S7.3 | M | 原始两个核心场景端到端成立 |
| S7.5 | 代码质量、依赖、文档、调试和发布最终门 | 全仓 | S7.4 | M | 可以批准发布，旧兼容只能按证据退役 |

详细任务书：[S7 整体验收](./configurable-workflow-s7-acceptance.md)

## 10. 跨任务迁移与兼容顺序

| 时点 | 数据变化 | 兼容策略 | 回滚边界 |
| --- | --- | --- | --- |
| S1.3 | Run View Snapshot、Node Run、Transition、Manifest | 旧Run回填粗粒度产品节点；未知事实明确标legacy | 新代码写入前可回滚；开始写入后旧代码只能只读或经兼容Adapter |
| S4.1 | Definition、Revision、RunSpec、ProductRun的runKind演进 | 内置Planning Definition映射旧硬编码流程；旧Run保留runnerKind | 未切换默认Runner前可关闭新建；不删除新事实 |
| S5.2 | Note、Note Revision、Candidate、Decision | 新集合默认为空；不重解释历史消息 | 可以停用Note入口，已经确认的Note继续可读 |
| S6.1 | Definition编辑生命周期需要的revision/CAS字段 | S4内置Definition转为已发布Revision，不产生可变历史 | 停用编辑器不影响已发布Revision和Run |
| S7.1 | 只做发现问题后的向前修复 | 禁止无证据重写全部Store | 回滚应用版本前先验证当前Store reader兼容 |

三次迁移都必须具备：Fixture升级、重复升级、损坏输入拒绝、原子替换失败、升级后重启、旧事实数量守恒和敏感字段扫描测试。

## 11. 真实验证与成本控制

| 里程碑 | 真实依赖 | 证明内容 | 不重复花费的办法 |
| --- | --- | --- | --- |
| S1.6 | 真实JSON Store与本地Workflow恢复 | 产品投影在重启/重放后稳定 | Agent节点可使用固定Fixture，不证明模型质量 |
| S2.5 | 真实浏览器与一条已有B2 Planning运行 | 图、Inspector、HITL和响应式用户结果 | 复用一次成功Run完成多个只读断言 |
| S3.6 | 真实本地Vercel Workflow运行时 | checkpoint、hook、循环和重放 | 静态执行器，无付费模型 |
| S4.7 | 真实Memory、Project、Rules、模型、Workflow、浏览器 | 最常用Planning全闭环 | 只跑一条主成功场景；故障矩阵用可控Adapter |
| S5.6 | 真实模型、Workflow和浏览器 | Note第二流程与内核复用 | 一次短Note场景，限制token和输入 |
| S6.7 | 真实浏览器；发布后各发起一条受控Run | 编辑、发布、版本绑定和历史稳定 | 运行可复用S4/S5已批准Definition与最小输入 |
| S7.4 | 全部真实服务，从干净Store开始 | Planning+Note组合最终用户结果 | 作为唯一发布前付费全链回归，保存可审计证据而非Provider全文 |

真实E2E不得提交密钥、完整Provider Payload或隐藏推理。测试报告保存对象ID、状态、时间、Revision、Hash、证据引用和脱敏错误分类。

## 12. 原始目标到任务的双向追踪

| 原始目标 | 首次建立 | 纵向证明 | 最终回归 |
| --- | --- | --- | --- |
| 运行前选择和配置工作流 | S3.1到S3.4 | S4.2、S4.6 | S7.4 |
| 已支持节点可组合、启停、分支、有限循环 | S3.2到S3.5 | S6.3到S6.6 | S7.3、S7.4 |
| Planning调研、整理、任务书、审核迭代、执行 | S1.4、S1.5 | S4.3到S4.7 | S7.4 |
| Note等不同场景复用同一内核 | S3.1到S3.6 | S5.4到S5.6 | S7.4 |
| 左到右Run图和节点输入输出/Trace | S1.1到S1.6 | S2.1到S2.5 | S7.2到S7.4 |
| 运行版本稳定、恢复和幂等 | S1.2到S1.6、S3.3到S3.6 | S4.2到S4.7、S6.6 | S7.1、S7.3 |
| 高质量架构、代码和测试 | 每个任务完成定义 | 每阶段完成门 | S7.2、S7.3、S7.5 |

反向检查规则：任何任务如果不能落到本表至少一个原始目标或必要的兼容/安全支撑，就应删除；任何原始目标如果只落到一个Happy Path任务，就必须补测试或阶段门。

## 13. 任务地图自检结论

1. **没有先做空引擎。** S1先让当前真实Run可观察，S3 Kernel立刻被S4 Planning和S5 Note消费。
2. **没有把前端图当执行事实。** S2只读View Snapshot；S6只提交结构化语义命令，服务端重新校验和编译。
3. **没有把Node Run降级为日志。** S1要求与Plan、Decision、Artifact等业务事实在事务中共同提交。
4. **没有忽略第二场景。** S5是必过阶段，不允许用“理论可复用”代替真实Note闭环。
5. **没有把真实E2E拖到最后。** S2、S4、S5、S6都有阶段级真实验证，S7只是组合回归。
6. **任务数量虽为42个，但每个只有一个主结果。** Store迁移、运行时切换、前端交互和发布门没有被塞进同一个超大任务。
7. **仍需用户批准后才能实现。** 详细任务书中的测试与完成门是实施合同；实施发现合同不成立时先回到设计，不静默偏移。

完整反向审查见：[实现前整体自审](./configurable-workflow-self-review.md)。

## 14. 任务级O项、非目标与主验证索引

本表补足任务进入实现前的逐项固定门；详细测试仍以各阶段任务书为准。

| ID | O项 | 本任务明确不做 | 主验证 |
| --- | --- | --- | --- |
| S1.1 | O1、O8 | Node Run、公开UI、画布依赖 | 快照Schema、Hash和golden图 |
| S1.2 | O1、O2、O9 | 把Trace变产品事实 | 全状态转换表、幂等和属性测试 |
| S1.3 | O1、O8、O13 | 伪造历史时间、直接迁移用户Store | 全版本迁移、IO失败和诚实回填 |
| S1.4 | O2、O9、O13 | execute后半段、best-effort日志补写 | 业务事实与节点状态故障注入原子性 |
| S1.5 | O2、O9、O13 | 新控制流、未知副作用普通重试 | 父子Node聚合、retry/replay和对账 |
| S1.6 | O1、O2、O10 | 公开Runtime身份、第二事件协议 | API权限/ETag/恢复/敏感扫描 |
| S2.1 | O1、O12 | ELK、持久化坐标、设计器 | 依赖Spike、bundle证据和布局性质 |
| S2.2 | O1、O12 | 从phase猜图、可编辑节点 | Hook/画布状态与视口稳定 |
| S2.3 | O2、O10、O11 | raw Trace/Provider JSON直出 | Manifest renderer、XSS与大数据边界 |
| S2.4 | O5、O9、O12 | 前端拥有Decision、重复审核表单 | HITL竞态、command identity和刷新恢复 |
| S2.5 | O1、O2、O12、O13 | 重做整个Chat交互 | 三viewport、键盘、真实Planning浏览器门 |
| S3.1 | O4、O7 | 插件市场、通用Code/HTTP节点 | Catalog/Blueprint/Executor一致性 |
| S3.2 | O4、O5、O11 | 任意图、Join、表达式、无界循环 | IR正反例、limit边界和生成式测试 |
| S3.3 | O4、O8、O9 | 动态代码生成、可变RunSpec | 确定性/敏感性Hash与资源竞态 |
| S3.4 | O4、O5、O10、O11 | 客户端决定风险/预算 | 策略矩阵、limit与篡改测试 |
| S3.5 | O5、O9 | 默认切换生产Runner | 真实Workflow六Fixture与checkpoint恢复 |
| S3.6 | O4、O5、O9、O11 | 用Lab宣称产品纵向完成 | 黑盒故障、版本、并发、生成式门 |
| S4.1 | O3、O8、O13 | 编辑Definition、删除旧Runner | Store迁移、Seed和旧Run回归 |
| S4.2 | O3、O4、O9、O10 | API直接启动Workflow、任意config | 六对象事务、CAS与Outbox结果未知 |
| S4.3 | O3、O7、O13 | 模型候选自动成为产品事实 | 真实资源/模型到waiting_human纵向 |
| S4.4 | O5、O9 | auto绕过高影响审核 | 决策矩阵、多轮修订和resume竞态 |
| S4.5 | O9、O13 | 对未知副作用普通retry | Contract到Artifact链与故障注入 |
| S4.6 | O3、O12 | raw Schema/Executor配置入口 | 表单穷尽、草稿/命令恢复和手机 |
| S4.7 | O3、O5、O9、O13、O14 | 删除旧Bundle或兼容事实 | 新旧并跑、真实全链和回滚演练 |
| S5.1 | O7、O8 | Reminder、分享、同步和知识库平台 | Note/Candidate/Decision状态与Hash |
| S5.2 | O7、O9、O13 | 从历史Message自动造Note | Note迁移、并发Revision和原子写 |
| S5.3 | O7、O10 | 万能PATCH、全文搜索表达式 | 命令/API/权限和commit事务 |
| S5.4 | O5、O7、O9 | 第二Runner/Node状态机/Viewer | Planning+Note共用Kernel harness |
| S5.5 | O7、O12 | 社交Feed、附件、虚假提醒状态 | 捕获/审核/列表/详情真实浏览器 |
| S5.6 | O7、O14 | 用类型复用代替真实用户结果 | 真实Note E2E与重复实现审计 |
| S6.1 | O6、O8、O9 | 硬删除、CRDT/多人实时协作 | 生命周期状态表、CAS和重启 |
| S6.2 | O4、O6、O10 | 暴露Zod/任意JSON编辑器 | field round trip和秘密投影canary |
| S6.3 | O3、O4、O6、O12 | 自由坐标/连边成为语义 | operation性质、拖放/键盘等价 |
| S6.4 | O4、O5、O6、O11 | 表达式、任意回边、无界循环 | Choice/Loop结构与真实Workflow Fixture |
| S6.5 | O4、O6、O9 | 强制覆盖、JSON自动合并 | diagnostics、旧响应和CAS重放 |
| S6.6 | O3、O6、O8、O9 | 修改活动Run或自动修Published | A/B Revision活动恢复和历史查看 |
| S6.7 | O6、O10、O12、O14 | 只做桌面Happy Path | 两Blueprint、三viewport、安全真实E2E |
| S7.1 | O8、O9、O13 | 无证据删除旧兼容 | 全Store/Run/Runner/Definition矩阵 |
| S7.2 | O11、O13 | 拍脑袋阈值、临时文件offload | 样本基准、limit和行为覆盖矩阵 |
| S7.3 | O4、O5、O9、O10 | Auditor自动修数据 | 跨层故障/并发/权限/敏感全矩阵 |
| S7.4 | O1～O14 | Mock冒充主场景、触碰用户数据 | 干净隔离的Planning+Note组合真实E2E |
| S7.5 | O1～O14 | 顺手扩范围、自动部署或删旧Runner | 全仓质量命令、依赖/文档/发布审查 |
