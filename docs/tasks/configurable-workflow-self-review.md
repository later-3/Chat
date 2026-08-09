# Chat 可配置工作流实现前整体自审

> 状态：自审通过并获用户批准；实现进行中  
> 日期：2026-08-10  
> 审查对象：原始目标、阶段总纲、参考研究、详细架构、42个任务、测试与发布门  
> 结论：方案在当前冻结技术基线上可行，任务闭包完整；未发现需要推翻S1到S7顺序的阻断矛盾

## 0. 结论先行

本次自审给出的结论不是“文档很多所以可做”，而是以下六点同时成立：

1. **原始目标没有被画布需求替代。** 核心仍是发送前选择/配置、真实耐久运行、节点输入输出/时间线、人工审核与迭代、Planning和Note两个产品结果。
2. **架构没有变成缩小版n8n。** 可执行结构是受限IR，前端拖拽只产生语义操作；新增Node Type仍需后端代码、策略、版本和测试。
3. **S1到S7没有循环依赖。** 先建立当前Run产品投影和Viewer，再证明Kernel，再迁移Planning、验证Note复用、开放Designer，最后组合验收。
4. **42个任务能覆盖阶段门。** 每个任务有一个主结果、前置依赖、目标/方案/测试/完成门、O项映射和明确非目标；预计超过2日必须再拆。
5. **测试不是最后补。** 每个任务有确定性与故障测试，每个PR有真实已发布链回归，S2/S4/S5/S6有真实用户里程碑，S7再做干净组合门。
6. **仍未确定的数字和依赖版本被放进证据任务，而不是静默猜测。** React Flow版本、结构/预览上限、coverage基线必须由对应Spike/基准给出，失败会阻断下游实现。

因此，这套设计已达到“可以交给用户做实现前最终审核”的状态；它还不是已完成代码，也不授权安装依赖、修改Workflow或创建实现分支。

## 1. 审查材料与方法

### 1.1 当前仓库事实

自审以当前main工作区真实代码为准，重点核对：

- Product Store当前已演进到chat-product-store.v5，并已有逐版迁移、完整性校验和原子替换测试；新任务继续使用“届时主干下一版本”，未预占v6/v7。
- ProductRun当前仍是Planning专用phase；S4/S5明确用判别联合演进，避免互不相关optional字段。
- planning-execution-workflow当前是硬编码Memory→Plan/Review loop→Execute→Validate→Commit；S1先投影，不在同一任务改执行结构。
- Workflow step已有Trace支持，但Trace不拥有产品节点状态；S1新增Node Run产品事实而非重命名Trace。
- Web当前RealWorkspace、use-real-chain和PlanPanel已经较大；S2/S4/S6采用独立workflow hooks/目录，避免继续集中膨胀。
- Browser→Hono→Application→Product Store→Outbox→Workflow→private Application Command边界已经成立；方案沿用而非重写。

### 1.2 审查方法

采用六次反向检查：

1. 从用户原话向下检查是否有阶段、任务、UI、产品事实和真实测试。
2. 从每个任务向上检查是否映射至少一个O1到O14；无映射任务视为技术扩张。
3. 从S7最终证据向前检查是否依赖尚未交付或只能人工猜测的事实。
4. 从每个故障边界检查产品状态是否只能收敛为成功、失败、等待人工或结果未知。
5. 从参考项目决策检查是否只吸收证据，而没有复制其产品范围或许可证受限实现。
6. 从未来变更检查Definition、Node Type、Runner、Product Run、Runtime ID和前端Graph是否保持可替换边界。

## 2. 原始目标防漂移检查

| G | 用户原始目标 | 对应设计/任务 | 真实完成证据 | 自审判断 |
| --- | --- | --- | --- | --- |
| G1 | 运行前选择、启停、配置已有节点 | Run Configuration、Blueprint、skip/risk policy | S4.2/S4.6/S6.3，S7.4 | 完整；不是运行中修改 |
| G2 | 前端拖拽组合工作流 | 结构化IR + semantic operations + constrained React Flow | S6.2到S6.7 | 完整；明确无自由连线 |
| G3 | Planning调研、Memory/Project/Rules/Skill、任务书 | Planning Definition与真实资源refs | S4.3/S4.7，S7.4 | 完整；依赖Project/Rules先完成 |
| G4 | 审核、修订循环、批准/拒绝、允许时默认继续 | Human Review、Decision、Policy Resolution、BoundedLoop | S4.4、S6.4、S7.3 | 完整；高影响不能被auto绕过 |
| G5 | 执行前停下，执行后验证和提交 | waiting_human、Execution Contract、Validation、Commit | S4.4/S4.5/S4.7 | 完整；保留结果未知语义 |
| G6 | 左到右运行图，节点输入/输出/Trace日志 | View Snapshot、Node Run/Manifest/Transition、Evidence/Trace深链 | S1/S2、S7.4 | 完整；不把raw Trace当产品API |
| G7 | 不同工作流可替换/组合 | Published Definition + immutable per-run RunSpec | S4 Planning、S5 Note、S6 Designer | 完整；不是每个Definition生成代码 |
| G8 | 正式笔记、类型、标签和长期查询 | Note/Revision/Candidate/Decision与Notes UI | S5.1到S5.6，S7.4 | 完整；模型标签只是Candidate |
| G9 | 高质量架构、风格和测试，不自造低质引擎 | Workspace分层、有限联合、42任务门、S7审计 | 每PR质量门 + S7.2/S7.3/S7.5 | 完整；行为覆盖优先于漂亮百分比 |

### 2.1 有意不纳入本次完成声明

1. **Reminder/待办调度。** 用户把它作为后续可能场景；它需要时区、调度、通知投递、幂等和对账，不能用Note或聊天文字冒充已经提醒。
2. **Quick Answer独立Preset。** 受限Kernel能够以后增加agent.answer类Node，但S1到S7的第二生命周期证明选择Note；当前Chat既有简短对话能力不因P6回归。本次不为凑第三流程增加未经验证Node。
3. **任意自动化平台能力。** 插件市场、任意Code/HTTP、表达式、Join、局部执行、pin data和无界回边明确不做。
4. **实时多人Definition协作。** 首版用CAS冲突与语义操作重放，不引入CRDT。
5. **生产数据库替换、部署和旧Runner删除。** JSON Product Store仍是当前Adapter；容量不足会阻断并另立任务，不在S7偷换底座。

以上边界没有阻止原始主目标达成；若用户要求Quick Answer也作为本次必须交付的第三Preset，应在批准前新增独立纵向任务，而不是塞进S4.3。

## 3. 阶段闭环反证

| 阶段 | 阶段输入 | 阶段唯一新增能力 | 若缺失会怎样 | 下游直接消费者 | 判断 |
| --- | --- | --- | --- | --- | --- |
| S1 | 当前B2固定Run/Store/Workflow | 产品拥有的View Snapshot、Node Run和Query | UI只能猜phase/读Trace，历史漂移 | S2、S4、S5 | 必须最先 |
| S2 | S1真实Query | 只读LR Viewer、Inspector和内嵌HITL | 后续配置化运行仍不可观察 | S4/S5/S6真实门 | 顺序合理 |
| S3 | S1身份模型、S2可观察边界 | Catalog、IR、Compiler、固定耐久Runner实验 | 前端图无安全执行语义 | S4/S5/S6 | Lab位置合理 |
| S4 | S3 Kernel、已完成Project/Rules | 配置化Planning真实纵向与新旧Runner切换 | 最常用场景没有产品价值证明 | S5/S6/S7 | 首个生产纵向 |
| S5 | S4生产Kernel | 正式Note生命周期与第二流程复用 | 仍可能是Planning专用抽象 | S6/S7 | 设计器前必要 |
| S6 | 两个真实Blueprint | 受约束copy/edit/validate/publish/run | 只能开发者写Definition | S7 | 开放编辑时机正确 |
| S7 | S1到S6全部证据 | 兼容、容量、故障、组合与发布结论 | 单阶段绿但整体不可靠 | 发布决策 | 唯一最终声明门 |

### 3.1 顺序替代方案审查

- **先做Designer：拒绝。** 没有Node Run Query和Kernel，前端只能保存伪Graph。
- **S1与S3合并：拒绝。** 会在一次PR同时改历史投影、状态机、编译器和Runtime，无法隔离迁移风险。
- **Planning后直接Designer、跳过Note：拒绝。** 无法证明抽象没有把Planning字段伪装成通用接口。
- **Note放在Planning前：拒绝。** Note会成为第一个新Product aggregate，无法先证明既有高风险HITL/执行语义被保留。
- **把S7故障测试分散后取消总门：拒绝。** 单任务测试不能证明Store/Runner/Viewer/两个流程组合与干净安装。

未找到比当前S1→S7更低风险且仍能产生相同闭包的顺序。

## 4. 42个任务完整性检查

### 4.1 数量与结构

| 阶段 | 任务数 | 任务范围 |
| --- | ---: | --- |
| S1 | 6 | 身份/状态机、迁移、前后半投影、API恢复门 |
| S2 | 5 | 依赖/布局、画布、Inspector、HITL、浏览器门 |
| S3 | 6 | Catalog、IR、Compiler、Policy、Runner、黑盒门 |
| S4 | 7 | Definition Store、Submit、前半Runner、审核、后半Runner、Composer、切换门 |
| S5 | 6 | Note Domain、Store、API、Workflow、UI、复用门 |
| S6 | 7 | 生命周期、Catalog表单、Sequence、Choice/Loop、诊断、版本稳定、E2E |
| S7 | 5 | 兼容、容量/覆盖、故障/安全、组合E2E、发布门 |
| 合计 | 42 | 每项一个主结果 |

机器检查确认42个任务均包含“目标与结果、方案、测试设计、完成门”四类内容；任务地图第14节再逐项给出O项、明确非目标和主验证。

### 4.2 粒度审查

1. 大小档位已修正为XS 0.5到1日、S 1到2日、M 1.5到2日；原先M写成2到3日与总纲“超过2日继续拆分”冲突，已修正。
2. M任务多发生在不可拆事务或真实阶段门；真正实现预估超过2日时必须先拆，例如S4.3可以按实际Project/Rules合同再拆Executor子任务，但不得产生孤立无消费者Adapter。
3. S1.4/S1.5分开是为了隔离HITL与外部副作用；S4.3/S4.5同理，不是按层机械切Repository/Service。
4. Store迁移S1.3/S4.1/S5.2串行，避免多个PR同时预占schemaVersion。
5. S3水平Kernel任务有明确S4/S5消费者，并通过Lab执行，不属于“先建平台以后再说”。

### 4.3 依赖审查

- 所有任务组成单主链，无任务依赖未来阶段产物。
- S4显式依赖Project Solution和Rules按PROJECT_PLAN先完成，P6规划没有抢跑。
- React Flow只在S2.1证据门后安装；S1合同、S3 IR和API不依赖其类型。
- coverage provider只在S7.2经版本/许可证/退出审查后允许加入。
- 旧Runner删除没有成为任何任务前置；回滚不会要求改写活动Run的runnerFamily。

## 5. 架构质量反审

### 5.1 事实所有权

| 事实 | 唯一Owner | 明确不是Owner |
| --- | --- | --- |
| Definition/Revision/RunSpec/View | Product Store | React Flow、Workflow bundle |
| Product Run/Node Run/Decision/Note | Product Store | Trace、pi session、browser cache |
| checkpoint/hook/runtime attempt | Vercel Workflow Store | Product Run API |
| Agent loop/provider session | pi runtime | Product Session/完成事实 |
| Query cache/未发送表单/view state | Browser | 历史、审批、终态 |
| 可观察系统路径 | Trace/Journal | Product正文和隐藏推理 |

Node Run与Plan/Decision/Note/Artifact尽量在同一Application事务提交，是本设计最重要的质量约束之一；它避免“业务成功后再best-effort写节点日志”的永久不一致。

### 5.2 身份与版本

- Definition node ID、Node Run ID、Product Run ID、Workflow Run/Step、Hook和pi Session不合并。
- Revision语义内容/Hash不可变；Definition聚合指向current draft/published。
- 每次Run保存RunSpec、View Snapshot和runner/executor version evidence；Definition运行后不再修改本次Run只是正常读取结果，不额外制造“冻结功能”。
- loop iteration、review cycle和retry attempt进入executionPath/attempt identity，普通Workflow replay不创建新attempt。

### 5.3 可替换性

1. React Flow被WorkflowCanvas Adapter隔离，position不出web；可换SVG/List而不改Definition/API。
2. Vercel Workflow被固定Runner与Application private commands隔离；Definition不是Vercel DSL，未来换耐久Runtime不改产品事实。
3. pi只作为静态Node Executor Adapter；不会拥有Product Run/HITL/Note。
4. JSON Store通过ProductStorePort与逐版迁移隔离；容量不够时可换Adapter而不改Web/Runner合同。
5. Node Type“可扩展”不等于零代码：新增类型必须通过Catalog、Parser、Policy、Executor、Projector、version evidence和测试。

### 5.4 复杂度红线

以下机制均被结构性排除，而不是靠团队自觉不使用：

- Schema无任意expression/code/http字段。
- IR无任意edges/Join/while。
- Designer无自由edge handle和raw JSON fallback。
- Runner只有静态Executor Registry，无eval/dynamic import。
- Run Configuration是有限联合，无Record metadata口袋。
- Node public projector默认拒绝未知字段，无通用JSON.stringify输出。

## 6. 参考项目证据到设计与测试的映射

| 参考 | 吸收的真实证据 | 进入Chat设计 | 对应测试/任务 | 没有复制 |
| --- | --- | --- | --- | --- |
| Activepieces | typed action、Draft/Locked启发、Input/Output/Timeline、loop execution path、横向布局 | Catalog、Revision、Inspector、executionPath | S1.2、S2.1/S2.3、S3.1、S7.2 | Piece市场、通用disabled透传 |
| Dify | graph snapshot、node execution、Human Input动作/超时 | View Snapshot、Node Run、typed human review | S1.1/S1.2、S2.4、S3.5、S4.4 | mutable whole graph、任意LLM平台 |
| Windmill OpenFlow | sequence/branch/loop/suspend显式容器 | Structured IR、Choice、BoundedLoop | S3.2、S3.5、S6.4 | 任意脚本/表达式、公开resume URL |
| n8n | disabled、execution stack、Join/partial/pin data复杂度 | 作为负面边界和非法结构集 | S3.2、S3.4、S6.3/S6.4、S7.3 | 执行引擎与受限许可证代码 |
| React Flow | 自定义节点、选择、缩放、画布交互；不自带布局 | 只读Viewer与受控Designer renderer | S2.1/S2.2、S6.3、S6.7 | Graph对象成为执行事实、首期ELK |
| Vercel Workflow | code transform、step、hook、checkpoint/recovery | 固定代码Runner解释RunSpec | S3.5/S3.6、S4.7、S7.1/S7.3 | 每Definition codegen、公开Runtime身份 |
| Memos | 快速Markdown捕获、标签筛选 | Note Capture体验、简单列表 | S5.1/S5.5/S5.6 | 从正文自动提升正式标签、社交范围 |
| Joplin | Note/Revision/Tag独立资源 | Note聚合与历史/标签Query | S5.1到S5.3 | Notebook树、同步协议、附件生态 |

源码固定commit、许可证和官方链接保存在研究/详细架构文档。参考只为设计选择和复杂度边界背书；没有把其他项目对象当作Chat产品事实。

## 7. 测试体系反审

### 7.1 五层证据不能互相冒充

1. Domain/Contract证明状态和结构不变量，不证明Store原子性。
2. Store/Application证明事务、CAS、Receipt和迁移，不证明Workflow checkpoint。
3. Workflow集成证明step/hook/replay，不证明浏览器用户可完成。
4. 浏览器E2E证明交互，不证明外部结果未知一定无重复副作用。
5. 真实组合门把前四层与真实Memory/Project/Rules/model连接，才允许整体结论。

### 7.2 关键行为覆盖

任务设计已经逐项覆盖：

- 所有Node/Run/Candidate/Definition状态与非法终态重开。
- Sequence/Task/Choice/BoundedLoop/Composite、limit和limit+1。
- 每个公开Command的strict parse、权限、CAS、replay与conflict。
- 每次Store迁移的空/非空/损坏/悬空/Hash/IO失败/重复升级。
- Hook创建/恢复结果未知、重复/乱序resume和Decision-first语义。
- 外部Action结果未知、查询对账和人工处置。
- 每个public projector的正文/secret/unknown field canary。
- Viewer selection/viewport、offline/SSE、手机、键盘和XSS。
- Planning与Note真实纵向及S7干净组合门。

Code coverage仅用于发现未执行分支；行为矩阵和mutation/delete test证明测试真的守住策略、Hash、幂等和权限。没有承诺一个拍脑袋的全仓line percentage，也没有允许无断言测试冲数字。

### 7.3 真实测试纪律

- 每个实现PR运行相关现有真实服务、真实模型和真实浏览器链做非回归；任务专项测试证明新增结果。
- S3即使尚未接默认流量，也运行真实Vercel Workflow Lab和当前已发布Planning真实链回归。
- 付费调用使用最小输入/轮次并记录次数；Mock/可控Adapter只覆盖不可稳定制造的故障，不能冒充阶段主场景。
- S7从mktemp隔离Store开始，不读取或清理用户日常数据，证据不含密钥、Provider全文和隐藏推理。

## 8. 自审发现与已修正问题

| F | 发现 | 风险 | 修正 |
| --- | --- | --- | --- |
| F1 | 任务地图M档原写2到3日 | 违反总纲超过2日继续拆分 | 改为1.5到2日，超过2日实现前拆 |
| F2 | Node Detail路由在架构/任务书分别为nodes与workflow-nodes | 前后端合同漂移 | 统一为/runs/:runId/workflow-nodes/:nodeRunId |
| F3 | Inspector一处写4 tabs，一处写5 tabs | Timeline/Evidence含义混淆 | 统一Overview/Input/Output/Timeline/Evidence五页签 |
| F4 | Note tags仅写字符串，规范与显示不可兼得 | Unicode/大小写去重不稳定 | 改为版本化{key,label}；S5有golden测试 |
| F5 | Note Candidate修订可能覆盖旧候选 | 丢失模型/用户修改证据 | Candidate内容不可变，编辑/修订产生successor |
| F6 | auto_continue与高影响决定边界未写完整 | 可能绕过当前Plan审批 | Policy Resolution绑定实际候选；高影响强制human Decision |
| F7 | 每PR真实产品链要求未写进任务地图 | 与项目治理规则不一致 | 加入全局PR真实回归门，阶段门仍证明新增结果 |
| F8 | 任务书内容有测试但标题不统一 | 机器难以审计42项完整性 | 统一每任务四类固定内容并运行计数检查 |
| F9 | 逐任务缺少O项/非目标索引 | 无法快速发现技术扩张 | 任务地图第14节增加42行映射 |
| F10 | 阶段总纲仍写“尚待审核/下一步拆任务” | 治理状态过期 | 更新为总纲已确认、全设计待批准并链接产物 |

上述修正没有改变阶段目标，只消除了执行时容易产生歧义的合同。

## 9. 仍需任务证据决定、但不阻断方案批准的事项

| 项 | 为什么现在不写死 | 决策任务 | 失败时怎么办 |
| --- | --- | --- | --- |
| React Flow精确版本 | 需匹配届时React/Node/锁文件、bundle与许可证 | S2.1 | 不引入，退回SVG/HTML只读renderer |
| IR/loop/node上限 | 应覆盖真实Blueprint并由编译/运行基准支撑 | S3.4/S3.6、S7.2 | 缩小合法复杂度或阻断，不放开无界 |
| Preview/Timeline阈值 | 依赖真实Plan/Note/Artifact尺寸 | S1.6/S2.3、S7.2 | 统一截断/分页；必要offload另立设计 |
| Project/Rules精确ref合同 | 它们按项目路线先实现，当前尚非最终as-built | S4.2/S4.3 | 暂停S4并修订适配，不复制临时Schema |
| Vercel动态解释器生产可行性 | 最小Spike可行但完整Choice/Loop/HITL需真实恢复反证 | S3.5/S3.6 | Kernel不进入S4；调整受限结构或Runner设计 |
| Scoped coverage数字基线 | 需先拿实际新增模块报告，数字不能替代行为 | S7.2 | 以行为矩阵阻断，补测或删不可达代码 |

这些是“证据门内的参数”，不是把架构决策推迟到编码中随便决定。每个都有Owner任务、失败路径和下游阻断点。

## 10. 最终闭包证明

令P(Sn)表示阶段Sn全部完成门通过；令O1…O14为总纲整体标准。

~~~text
P(S1) ∧ P(S2)
  ⇒ 当前与历史真实Run可观察、可审核                     [O1 O2 O10 O12 O13]

P(S3) ∧ P(S4)
  ⇒ 受约束Definition可真实决定Planning耐久运行            [O3 O4 O5 O8 O9 O13]

P(S5)
  ⇒ 同一内核支撑不同产品生命周期                          [O7]

P(S6)
  ⇒ 用户能安全复制、编辑、发布并运行已有能力                [O6，强化O3 O4 O8 O12]

P(S7)
  ⇒ 兼容、容量、故障、安全与干净真实组合全部复验             [O9 O10 O11 O13 O14]

P(S1)…P(S7) ⇒ O1…O14
~~~

反方向也成立：O1到O14每项都至少有一个主证明阶段和S7复验；没有只靠未来任务或人工解释成立的O项。任务地图第14节又保证42个任务全部映射到至少一个O项。因此“全部任务通过但阶段/整体不通过”的已知缺口已经消除。

## 11. 最终建议

建议用户按以下四个问题做最终批准判断：

1. 是否批准本次只做Chat受约束工作流模块，而不是自由n8n平台。
2. 是否批准Planning + Note作为两条正式纵向，Reminder和独立Quick Answer Preset不计入本次完成声明。
3. 是否批准S1到S7顺序及42个任务；实现估时超过2日的任务在开工前继续拆，但不能改变阶段闭包。
4. 是否批准“每个PR真实链回归 + 每阶段新增结果真实门 + S7干净组合门”的成本与质量标准。

若四项批准，从S1.1开始创建独立worktree/分支/PR；任何一项需要调整，先修改总纲、架构、任务地图和受影响任务书，再开始实现。
