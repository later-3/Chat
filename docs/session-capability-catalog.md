# Session能力全集与目标边界

> 状态：`目标全集已获用户批准；Phase 0与Phase 1文本会话底座已实现，Phase 2-8按本目录继续交付`
>
> 更新日期：2026-07-21
>
> 配套路线：[Session分阶段交付路线](./session-delivery-roadmap.md)
>
> 证据底稿：[Session持久化研究与方案推导](./session-persistence-research.md)

## 1. 本次审核结论

本项目的完整Session能力不能只等于“保存聊天记录”。建议把目标定义为9个能力域、74项能力，覆盖以下完整链路：

```text
创建和找到会话
-> 保存完整对话与分支
-> 组装本轮可信上下文
-> 管理一次Interaction与Agent Run
-> 断线后重连活动运行
-> 进程失败后恢复或收敛
-> 工具、Workflow与HITL安全续接
-> 跨设备、跨通道继续
-> 归档、导出、删除、审计和运维
```

这74项全部进入目标全集，后续分阶段只是交付顺序，不代表没有规划。现有D1-D6只覆盖其中“产品事实、模型历史与首个文本回合”的持久化子问题，不能再作为完整Session方案的审核入口。

## 2. “完整”的边界

### 2.1 Session直接负责什么

Session是一个有身份、权限、版本和生命周期的产品协作空间。它直接负责：

1. 会话自身的创建、发现、组织、归档、删除和保留策略。
2. 消息、分支、当前活动路径和用户可见历史。
3. Interaction、Agent Run、Run Attempt及其状态关联。
4. 页面恢复、实时连接恢复、运行恢复和HITL恢复所需的关联信息。
5. 本轮模型上下文、配置、附件、证据和外部领域对象的可追溯引用。
6. Web入口与OPC-OS Chat等外部系统之间的会话绑定和投影边界。

### 2.2 Session只关联、不吞并什么

以下对象必须能从Session恢复或追踪，但仍有自己的领域所有者：

| 对象 | 为什么不并入Session |
|---|---|
| Memory | 记忆需要独立的候选、接受、纠正、删除和作用域规则 |
| Intent | 一次会话可形成多个意图，意图也可跨会话继续 |
| WorkItem / TaskPlan | 工作生命周期长于单次对话，可被多个通道和Session共同推进 |
| Tool Execution / Evidence | 外部副作用和证据需要独立幂等、对账与保留规则 |
| Delivery | 一次结果可投递到多个通道，投递成功不等于Agent Run成功 |
| Trace | Trace记录可观察事件和证据，不能退化为Message或隐藏推理存储 |

### 2.3 明确不承诺的伪能力

以下内容不应被包装成Session能力：

1. 不承诺第三方模型已经断开的字节流可以从原Token位置精确续传；只能从可验证的安全点恢复、重试或明确中断。
2. 不承诺任意外部工具“恰好执行一次”；目标是幂等优先、保存回执、结果未知时对账，不盲目重放。
3. 不保存或展示模型隐藏思维链；只保存用户可见内容、工具事件、摘要、来源和必要诊断。
4. 对话分支不会自动回滚文件、数据库或外部系统副作用；分支只改变消息与上下文路径。
5. AG-UI Thread Snapshot、浏览器状态、MAF AgentSession或Workflow Checkpoint都不能替代Product Session事实。
6. 本轮不把多人同时编辑同一会话、离线优先客户端和自动分支合并纳入目标；当前参考项目没有形成足够一致的产品语义，本项目6个核心问题也不依赖它们。

## 3. 必须区分的对象与ID

| 对象 | 回答的问题 | 生命周期 |
|---|---|---|
| Product Session | 用户正在继续哪个产品会话 | 跨页面、进程、设备和通道长期存在 |
| Channel Binding | 某个外部通道会话映射到哪个Product Session | 可撤销、可迁移，受身份和通道Scope约束 |
| Product Message / Branch | 用户可见且可追溯的完整对话树是什么 | 长期产品事实 |
| Interaction | 用户这次提交了什么请求 | 一次提交，可触发0到多个Run |
| Product Agent Run | 这次Agent执行整体处于什么状态 | 长期保留，用于审计、幂等和恢复 |
| Run Attempt / Runtime Job | 哪个Worker正在执行第几次尝试 | 活动期与诊断期存在，可重建但不能冒充Product Run |
| MAF AgentSession | MAF Agent调用需要的运行时会话状态是什么 | 由应用持久化和恢复，不是产品容器 |
| MAF Workflow Checkpoint | Workflow从哪个执行安全点恢复 | 与Workflow版本绑定，不能冒充消息或Run成功 |
| AG-UI Thread / Run | 前后端实时事件关联到哪里 | 协议相关性标识，不负责授权和产品事实 |
| Tool Execution / Evidence | 某个副作用是否执行、结果是什么 | 跨重试保留，结果未知时必须对账 |
| Approval / Input Request | 正在等待用户决定什么 | 解决、拒绝、取消或过期前持续存在 |
| Context Snapshot | 当时模型真正使用了哪些上下文与配置 | 跟随Interaction/Run长期可追溯 |

即使某个交付阶段暂时让部分ID同值，代码和文档也必须分别命名、分别授权、分别定义生命周期。

## 4. Session恢复的完整层级

“恢复Session”至少有7种不同场景。它们需要不同数据和保证，不能只用一个`resume`概念回答。

| 层级 | 恢复场景 | 完成后的保证 | 主要参考 | 不能误称为什么 |
|---|---|---|---|---|
| R0 | 页面刷新或稍后重新打开已完成会话 | 读取完整产品历史，继续新的Interaction | pi、nanobot、LibreChat；MAF HistoryProvider | 不是恢复旧Run |
| R1 | 用户消息已接纳，但模型/服务失败 | 用户输入不丢；旧Run有明确失败/中断；可发起有血缘的新Attempt | nanobot最直接，LibreChat部分，MAF提供Hook | 不是自动重跑成功 |
| R2 | 浏览器断网、刷新或换设备，但后端仍在运行 | 重新订阅同一活动Run，补齐遗漏事件；断连不等于取消 | LibreChat最直接，AG-UI提供协议事件 | 不是Worker故障恢复 |
| R3 | API/Worker进程在纯模型运行中退出 | 从最后安全点接管、按策略新建Attempt，或明确标记需人工重试；保留部分结果和旧Attempt | MAF Checkpoint机制部分，nanobot故障收敛；pi不直接支持 | 不是原Token流精确续传 |
| R4 | 工具调用前后崩溃 | 已完成工具不盲目重做；未确认结果进入`unknown/reconciling`并对账 | nanobot最直接；MAF per-service历史只覆盖模型上下文 | 不是只靠聊天History恢复 |
| R5 | Workflow暂停或执行节点间崩溃 | 从兼容Checkpoint恢复，已完成节点不重复执行 | MAF Workflow Checkpoint直接支持；当前AG-UI接入仍有兼容性缺口 | 不是AG-UI Snapshot恢复 |
| R6 | 等待审批/补充信息期间重启或换Worker | 用户仍能看到原请求并批准、拒绝、取消或等待过期，响应绑定原版本 | MAF/AG-UI提供interrupt协议；LibreChat持久Checkpointer提供产品例证 | 不是进程内Approval Registry |

跨通道继续属于R0-R6之上的入口映射：它复用同一个Product Session及其恢复能力，但必须重新验证身份、权限、版本和投递语义。

## 5. 能力全集

优先级含义：

- `P0`：语义与数据正确性基础，后续能力都会依赖。
- `P1`：首个可用Session闭环，直接解决连续会话和失败可解释。
- `P2`：完整Web Chat体验与用户控制。
- `P3`：高可靠执行、跨进程、跨通道和治理能力。

参考缩写：`M`=MAF，`P`=pi，`N`=nanobot，`L`=LibreChat，`O`=本项目明确需求；`O`表示没有任何参考项目直接替本项目作出决定。

### A. 身份、所有权与状态边界（6项）

| ID | 能力 | 目标结果 | 优先级 | 依据 |
|---|---|---|---|---|
| A1 | Product Session身份与Scope | 每个Session有稳定产品身份，并始终结合用户/租户Scope授权 | P0 | L、O |
| A2 | 多对象ID显式映射 | Product、MAF、AG-UI、Provider和Runtime ID不再互相冒充 | P0 | M、L、O |
| A3 | Channel Binding | Web客户端或未来外部通道只通过受控绑定找到Product Session | P0 | N、O |
| A4 | Session修订与活动分支 | 每次结构变化可检测旧写，当前活动Leaf可恢复 | P0 | P、L、O |
| A5 | 资源级授权 | Message、Run、Checkpoint、附件和分享都继承并复核Scope | P0 | L、O |
| A6 | 单一事实源与投影边界 | Product DB、MAF运行态、AG-UI投影和浏览器状态职责固定 | P0 | M、L、O |

### B. 生命周期、发现与组织（10项）

| ID | 能力 | 目标结果 | 优先级 | 依据 |
|---|---|---|---|---|
| B1 | 创建Session | 新会话可显式创建或在首条有效输入时创建 | P1 | P、L |
| B2 | 列表、分页与打开 | 用户能稳定找到并打开自己的历史会话 | P1 | P、L |
| B3 | 标题生成与重命名 | 支持自动标题、手动修正和冲突保护 | P2 | L |
| B4 | 置顶、归档与恢复归档 | 活跃列表与长期保存区分开 | P2 | L |
| B5 | 标签、项目或工作区归类 | 大量Session可按产品语义组织 | P2 | L、O |
| B6 | 会话与消息搜索 | 可按标题、内容和限定Scope检索 | P2 | L |
| B7 | 复制、导入与迁移 | 用户可创建独立副本或导入兼容记录 | P2 | P、L |
| B8 | 导出与受控分享 | 可导出当前路径/全部分支；分享是有权限和过期时间的快照 | P3 | L |
| B9 | 临时Session与过期 | 用户可选择不进入长期历史，系统能按规则清理 | P2 | L |
| B10 | 删除、级联清理与保留策略 | 删除或过期时能清理关联投影，同时保留必须的审计边界 | P3 | L、O |

### C. 消息、版本与分支（9项）

| ID | 能力 | 目标结果 | 优先级 | 依据 |
|---|---|---|---|---|
| C1 | 模型前保存用户输入 | 已接纳输入不会因模型失败或进程退出而消失 | P0 | N、O |
| C2 | Assistant临时态与最终态 | 流式草稿、部分结果、错误和已提交结果不混用 | P0 | L、O |
| C3 | 稳定顺序、版本和提交门 | 旧Run不能覆盖新结果，客户端成功晚于产品提交 | P0 | L、O |
| C4 | 树状Message关系 | 目标数据模型能表达父子关系和活动路径，避免线性历史锁死 | P0 | P、L |
| C5 | 编辑历史用户消息 | 编辑产生新分支或新版本，不抹掉原始事实 | P2 | L |
| C6 | 重新生成与Sibling | 同一父消息可有多个Assistant候选 | P2 | P、L |
| C7 | 分支导航 | 用户能切换Sibling、回到任意Leaf并恢复对应上下文 | P2 | P、L |
| C8 | Fork与Clone | 可从选定消息复制当前路径、包含Sibling或指定层级 | P2 | P、L |
| C9 | 类型化内容 | 文本、摘要、Tool、文件、引用、错误和可见Agent更新有明确类型 | P1 | P、L、M |

### D. 历史、上下文与长期连续性（8项）

| ID | 能力 | 目标结果 | 优先级 | 依据 |
|---|---|---|---|---|
| D1 | 完整历史为产品事实 | 服务端保存可审计全记录，前端不成为权威库 | P0 | P、N、L、O |
| D2 | 活动分支Context投影 | 模型只读取当前Leaf的合法路径和本轮增量 | P0 | M、P、N、L |
| D3 | Token与消息预算 | 长会话不会无边界进入模型 | P1 | N、P |
| D4 | Compaction与Branch Summary | 压缩只改变模型视图，原始记录仍可访问和审计 | P2 | P、N |
| D5 | ContextPackage与来源 | 用户可看到本轮纳入、排除的上下文及来源 | P2 | M、O |
| D6 | 模型、Agent和工具配置快照 | 能解释某次回答使用了什么配置，后续修改不重写历史 | P1 | P、L、O |
| D7 | 附件、Artifact和Evidence引用 | 重新打开Session时相关资源仍可定位并校验权限 | P2 | L、O |
| D8 | Memory、Intent和Work引用 | Session可继续长期协作，但不吞并这些领域对象 | P3 | N、O；参考只部分涉及 |

### E. Interaction、Agent Run与用户控制（10项）

| ID | 能力 | 目标结果 | 优先级 | 依据 |
|---|---|---|---|---|
| E1 | Interaction与Run分离 | 一次用户提交可被拒绝、等待确认或产生多个Run | P0 | O；L未提供完整对象 |
| E2 | Product Run状态机 | queued/running/waiting/succeeded/failed/cancelled/interrupted等语义不混用 | P0 | M、N、L、O |
| E3 | Run Attempt与重试血缘 | 每次实际尝试独立保留，旧失败不会被新结果覆盖 | P1 | N、L、O |
| E4 | 提交幂等 | 重复点击、重发请求或网络重试不会创建重复Run和副作用 | P0 | L、O |
| E5 | 并发与活动Run规则 | 同一活动分支的普通Prompt有明确串行语义，跨Session可并发 | P0 | P、N、L |
| E6 | 取消与超时 | 用户取消、网络断连、系统超时和模型错误分别记录 | P1 | M、L、N |
| E7 | 失败后的Retry/Resume/Restart选择 | UI明确告诉用户是继续旧Run、新Attempt还是从历史新开Run | P2 | P、N、O |
| E8 | Steer当前运行 | 对仍在运行的Agent注入修正，而不是伪装成第二个普通Prompt | P2 | P、L |
| E9 | Follow-up队列 | 用户可排队后续输入，并看见、修改或取消队列 | P2 | P、N、L |
| E10 | 进度、用量与Run Trace | 用户和运维能看到阶段、耗时、模型、稳定错误码和可见证据 | P1 | M、L、O |

### F. 实时流与客户端连续性（6项）

| ID | 能力 | 目标结果 | 优先级 | 依据 |
|---|---|---|---|---|
| F1 | 标准AG-UI实时事件 | Agent运行继续使用AG-UI，不再建立竞争协议 | P0 | M、O |
| F2 | 临时投影与产品提交边界 | 文本流可先展示，但只有产品提交后才显示最终成功 | P0 | M、L、O |
| F3 | 断连不等于取消 | 浏览器消失不会暗中取消允许后台继续的Run | P2 | L |
| F4 | 事件游标、补发、去重和有序 | 重连可补齐缺口，重复事件不会重复渲染或提交 | P3 | P的RPC游标、L、O |
| F5 | 活动Run重连与再订阅 | 页面刷新、网络恢复后能接回仍在运行的任务 | P3 | L、M部分 |
| F6 | 跨设备接管与最终DB回退 | 另一设备可看同一Run；活动流已清理时从产品事实恢复最终结果 | P3 | L、O |

### G. 进程、工具、Workflow与HITL恢复（12项）

| ID | 能力 | 目标结果 | 优先级 | 依据 |
|---|---|---|---|---|
| G1 | 启动对账 | 重启后扫描遗留活动状态，不能把旧`running`当成功 | P1 | N、O |
| G2 | Worker所有权、Lease与Heartbeat | 只有当前Attempt拥有写入和发终态权，失联可被识别 | P3 | L部分、O |
| G3 | 模型调用History Checkpoint | 多次Provider调用之间可恢复合法上下文，但Checkpoint不冒充产品成功 | P1 | M、N |
| G4 | 安全点恢复策略 | 纯模型运行按能力选择续接、新Attempt或人工重试，并保留旧部分结果 | P3 | M部分、N、O |
| G5 | Tool Execution记录 | 调用参数摘要、权限、状态、Attempt和关联Run可追踪 | P3 | N、M、O |
| G6 | Tool结果、回执与Evidence提交 | 模型继续前先耐久保存工具结果和外部回执 | P3 | N、O |
| G7 | 副作用幂等与未知结果对账 | 已完成不重复；未知先查询外部系统，不能盲重试 | P3 | N、O；参考未提供通用解法 |
| G8 | MAF Workflow Checkpoint持久化 | Workflow可从持久安全点恢复，而不是依赖进程内对象 | P3 | M直接支持核心机制 |
| G9 | Workflow图与Checkpoint兼容性 | 恢复前验证Workflow版本，拒绝静默用新图解释旧状态 | P3 | M、O |
| G10 | Approval/Input Request持久化 | 等待内容、版本、权限和过期时间跨进程存在 | P3 | M、L |
| G11 | 跨重启批准、拒绝、取消和过期 | 用户响应精确绑定原Interrupt，旧批准不能用于已修改请求 | P3 | M、L、O |
| G12 | 人工处置与运维恢复 | 无法自动确定的Run可查看证据、标记结果、重试或终止 | P3 | O；现有参考只提供局部机制 |

### H. 跨设备、跨通道与投递（6项）

| ID | 能力 | 目标结果 | 优先级 | 依据 |
|---|---|---|---|---|
| H1 | 入站来源与Channel Binding | 每条输入保留来源、外部消息ID和可信身份映射 | P3 | N、O |
| H2 | 入站去重 | 通道重投不会产生重复Interaction | P3 | O；N未完整覆盖 |
| H3 | 同一Product Session跨通道继续 | Web与未来其他通道可在授权后继续同一上下文 | P3 | N部分、O |
| H4 | Outbox、投递回执与重试 | Product结果提交与通道投递分开；失败投递可安全重试 | P3 | O；N明确暴露此缺口 |
| H5 | 通道能力投影 | 不同通道只呈现其支持的卡片、附件、审批和流式能力 | P3 | N、O |
| H6 | 外部集成版本、权限和撤销传播 | 与OPC-OS Chat等外部系统互操作时不形成第二事实源，权限变化能阻断后续操作 | P3 | O；参考未直接涉及 |

### I. 治理、可移植性与质量（7项）

| ID | 能力 | 目标结果 | 优先级 | 依据 |
|---|---|---|---|---|
| I1 | 可审核事件与证据 | 能回答谁在何时用何配置执行了什么，不记录隐藏推理 | P1 | M、O |
| I2 | 保留、过期与删除级联 | 产品事实、运行投影、附件、Checkpoint和分享有一致清理规则 | P3 | L、O |
| I3 | 可移植导入导出 | 导出保留必要版本、分支和类型信息，导入先验证再落库 | P2 | P、L |
| I4 | 分享快照、权限与过期 | 分享内容不会随原会话后续修改越权泄露 | P3 | L |
| I5 | 运维可观测与卡死检测 | 能发现长期running、等待过期、事件积压和恢复失败 | P3 | O；参考未完整覆盖 |
| I6 | Schema、事件与Checkpoint版本迁移 | 旧Session可显式升级，失败可检测，不静默丢字段 | P0 | P、M、O |
| I7 | 故障注入与恢复验收 | 浏览器断连、API重启、Worker退出、工具未知和审批重启都有证据 | P0 | M测试思想、N、L、O |

## 6. 参考项目覆盖矩阵

没有一个参考项目能单独覆盖本项目的完整Session。当前4个来源互补，已经足以规划功能全集；未覆盖处必须由本项目明确产品语义，不能伪称“参考项目已有答案”。

| 能力域 | MAF | pi | nanobot | LibreChat | 本项目仍需决定 |
|---|---|---|---|---|---|
| 产品Session身份/生命周期 | 不提供完整产品模型 | create/open/list/delete/fork，单用户CLI语义 | Session Key与基础管理 | 列表、搜索、归档、置顶、标签、临时、删除、分享 | 多对象Scope、关系库事务和外部Channel Binding |
| 消息树与分支 | 不定义产品树 | 完整Session Tree、Leaf、fork、branch summary | 主要是线性历史 | `parentMessageId`、edit/regenerate/sibling/fork/duplicate | 目标模型保持树兼容及产品交互取舍 |
| 历史与Context | HistoryProvider、AgentSession序列化 | 完整Tree投影活动Context、Compaction | 历史裁剪、合法Tool边界、consolidation | 全历史与当前分支分离 | 唯一加载器、ContextPackage和配置快照 |
| Run并发和控制 | Agent/Workflow运行机制，产品并发由应用定义 | 普通Prompt拒绝、steer/followUp | Session Lock、Queue、跨Session并发 | abort、steer、Generation替换保护 | Interaction/Run/Attempt长期状态和幂等 |
| 浏览器断线续传 | AG-UI事件与可选Snapshot；Snapshot不是产品提交门 | Web场景未涉及 | 通道投影有限 | 后台Job、Chunk、重连、DB回退最完整 | AG-UI上的持久事件投影与游标合同 |
| API/Worker崩溃 | Workflow Checkpoint可跨进程；普通Agent Run不自动成为持久Job | 不支持活动Run跨进程续跑 | Pending User/Tool恢复并显式收敛 | 未证明普通Worker崩溃后自动续跑模型；HITL可配置持久Checkpointer | Worker Lease、Attempt接管和安全重试策略 |
| Tool副作用恢复 | per-service历史、Tool Approval、Workflow机制 | 保存Tool Entry，但不保证外部副作用回滚/恰好一次 | 保存Pending/Completed Tool，未知不盲重做 | Tool与HITL有产品实现，但无通用Exactly-once | Execution/Evidence、回执、对账和人工处置 |
| Workflow/HITL | Checkpoint、request_info、approval、resume直接支持 | 无Web HITL持久恢复 | 局部中断恢复 | 持久Checkpointer可跨重启/副本，内存回退不行 | 当前MAF AG-UI rc8与持久Workflow Checkpoint的接合验证 |
| 跨通道与投递 | 未负责 | 未涉及 | 多Channel和Session Key；可靠Outbox不足 | 主要是Web产品 | OPC-OS绑定、入站去重、Outbox和能力投影 |
| 治理与运维 | 可观察性与序列化机制 | 格式版本/迁移 | 损坏恢复与原子文件 | 租户Scope、TTL、分享、导入导出 | 审计、卡死检测、级联清理和全链路故障注入 |

## 7. 参考项目真正告诉我们的取舍

### 7.1 采用

1. 采用pi的“完整记录与模型Context分离”、树状Message关系、Compaction不删除原始记录、普通Run与steer/follow-up分语义。
2. 采用nanobot的“模型前保存用户输入”、Pending User/Tool显式恢复、未知副作用不盲重放、同Session串行和跨Session并发。
3. 采用LibreChat的Product Conversation/Message与活动Generation Job分层、正常终态晚于产品消息提交、浏览器断连不等于取消、分支和生命周期产品操作。
4. 采用MAF的HistoryProvider、AgentSession序列化、per-service历史、Workflow Checkpoint、Tool Approval和AG-UI协议能力。

### 7.2 改造后采用

1. pi的JSONL与nanobot的文件Session只借鉴记录思想，Web产品事实改由受事务和Scope约束的Product DB拥有。
2. LibreChat的Generation Job只借鉴活动运行投影；本项目仍长期保存Product Agent Run和Attempt。
3. MAF AgentSession、Workflow Checkpoint与AG-UI Snapshot必须放在产品身份、权限、版本和提交门之下。
4. nanobot的进程锁和队列要升级为可验证的数据库/运行协调语义，不能把单进程行为外推到多Worker。

### 7.3 明确不采用

1. 不采用pi或nanobot的本地文件作为Web产品权威库。
2. 不采用LibreChat中多种ID复用、成功后删除唯一Run记录、部分失败继续报成功的弱语义。
3. 不采用“持久了Message就等于可续传活动Run”的假设。
4. 不采用“有Workflow Checkpoint就等于当前AG-UI端点已经支持跨进程恢复”的假设。

## 8. 当前MAF能力边界

当前项目安装版本已确认存在：

1. `AgentSession.to_dict()/from_dict()`。
2. `HistoryProvider`及per-service保存模式。
3. `CheckpointStorage`、`InMemoryCheckpointStorage`、`FileCheckpointStorage`和Workflow从`checkpoint_id`恢复的核心能力。
4. `AgentFrameworkAgent`、`AgentFrameworkWorkflow`、AG-UI Thread Snapshot和interrupt/resume协议。

但仍有3个必须在详细设计前通过Spike/合同测试的边界：

1. 当前`agent-framework-ag-ui 1.0.0rc8`的Workflow适配主要通过缓存Workflow实例和Thread Snapshot恢复消息、State、Interrupt；其公开AG-UI入口没有直接暴露Product Run到MAF `checkpoint_id`的持久映射合同。
2. Snapshot保存是fail-soft，不能证明Product Run或Workflow Checkpoint已经耐久提交。
3. 当前Agent approval相关部分仍有进程内注册状态，不能直接宣称跨进程HITL已经成立。

因此路线中会先安排“MAF核心Checkpoint能力验证”和“AG-UI接合验证”，再决定是使用现有适配、做薄桥接还是等待/升级框架；这属于后续详细设计门，本文件不提前选择实现。

## 9. 全部能力最终满足的用户场景

完成全部路线后，用户应能获得至少18个场景：

1. 创建、命名、置顶、搜索、归档和重新打开会话。
2. 刷新页面、关闭浏览器或换设备后继续已完成的上下文。
3. 后端失败时仍看见已经被系统接纳的用户输入和明确失败原因。
4. 编辑旧问题、重新生成回答、切换Sibling并保留原分支。
5. 从任意消息Fork新会话，选择只复制当前路径或包含相关分支。
6. 长会话自动压缩模型上下文，同时仍能查看完整原始记录。
7. 看见本轮模型使用了哪些上下文、模型、Agent、工具和来源。
8. 在Agent运行中取消、修正方向或排队后续问题。
9. 重复点击或网络重发不会重复创建Run和副作用。
10. 浏览器断线后重新接回仍在运行的回答，并补齐遗漏内容。
11. API或Worker退出后，系统从安全点恢复、新建可追踪Attempt，或明确要求人工重试，不伪造成功。
12. 工具已成功但进程退出时不会盲目再次执行；结果未知时先对账。
13. Workflow执行到一半重启后，从兼容Checkpoint继续，已完成节点不重复。
14. 等待审批或补充信息跨越重启、换设备和较长时间后仍可继续。
15. 会话中的附件、Artifact、Evidence、Intent和WorkItem仍可定位并受权限保护。
16. 通过Web、OPC-OS Chat或其他外部入口，在授权后继续同一个Product Session。
17. 通道投递失败不影响已提交产品结果，并可凭Outbox安全重试。
18. 导出、分享、过期或删除会话时，分支、附件、运行投影和权限按一致规则处理。

## 10. 审核结果与当前交付边界

2026-07-21，用户要求按本规划开发Session，因而确认了3项总体约束：

1. 9个能力域、74项能力仍是完整Session目标全集。
2. R0-R6是不同恢复保证，不能用“保存历史”或一个`resume`笼统替代。
3. 精确续传第三方Token流、通用Exactly-once、隐藏推理存储、分支回滚外部副作用、多人实时编辑和自动分支合并仍是明确非目标。

当前实现兑现R0与R1的文本会话基础：Product Session/Message/Interaction/Run/Attempt耐久保存、REST重开、唯一服务端历史、失败输入保留、成功终态提交门和启动中断收敛。它不兑现R2-R6；活动流重连、Worker接管、Tool副作用、Workflow Checkpoint和跨重启HITL仍必须按后续阶段分别验收。
