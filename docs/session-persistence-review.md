# Session持久化审核包

> 状态：`研究与Spike已完成；D1-D6待用户逐项批准；未创建Schema；未实现`
>
> 更新日期：2026-07-21
>
> 前置材料：[研究与方案推导](./session-persistence-research.md)；[候选设计](./session-persistence-design.md)

## 1. 这次需要审核什么

本审核包不要求用户先掌握MAF、AG-UI、pi、nanobot或LibreChat。每项决策都说明：问题背景、为什么现在决定、参考源真正覆盖什么、全部可行选择、优缺点、当前建议、建议原因、未验证项和需要用户批准的句子。

需要先固定4个不同事实：

1. Product Message是否已经写入。
2. 模型可见History/Checkpoint是否已经写入。
3. Product Agent Run是否已经成功。
4. AG-UI客户端是否已经收到`RUN_FINISHED`。

它们可以在一次正常回合中按顺序发生，但不能互相冒充。尤其是：Checkpoint不是产品Message，AG-UI Snapshot不是产品数据库，`RUN_FINISHED`也不能先于产品成功提交。

### 1.1 6项建议总览

| 编号 | 决策 | 当前建议 | 主要理由 | 信心 |
|---|---|---|---|---|
| D1 | 第一阶段保存哪些状态、在哪里恢复 | 一个SQLite Product DB；持久AG-UI Snapshot关闭；页面REST恢复 | 保留单一产品事实源，避开Snapshot fail-soft和双历史加载 | 高 |
| D2 | Product与协议/Provider ID如何映射 | Product Session ID与AG-UI `threadId`同值；Run、Message和Provider ID显式映射 | 第一阶段Session映射简单，但不牺牲对象、权限和运行边界 | 中高 |
| D3 | 谁加载模型历史 | `ProductHistoryProvider`唯一加载；`store=False`+per-service；入口校验全量历史并只传新delta | 当前版本实测无重复、可在每次服务调用后持久化 | 中高（RunContext合同待固化） |
| D4 | 成功终态何时发送 | User/Run先提交；Checkpoint暂存；包装器观察并暂扣终态后，外层事务写Assistant和成功Run，再放行`RUN_FINISHED` | 可证明产品成功早于客户端成功终态，不让Checkpoint或Snapshot反向拥有产品事实 | 中高（终态门合同待固化） |
| D5 | 同Session并发和重复请求 | 最多一个活动Product Run；重复幂等；新请求返回`SESSION_BUSY` | 最小且可解释，避免历史尾部竞争和重复外部调用 | 高 |
| D6 | SQLite数据访问与迁移工具 | SQLAlchemy 2+Alembic+`aiosqlite` | 后续领域对象多，显式迁移与事务约束的收益大于依赖成本 | 中高 |

批准D1-D6以后，才会把[候选逻辑记录](./session-persistence-design.md#10-候选逻辑记录)转为正式Schema和迁移。批准外部参考范围不等于批准这6项设计。

## 2. 已完成的证据工作

### 2.1 MAF当前版本

当前项目安装版本：

- `agent-framework-core 1.11.0`
- `agent-framework-openai 1.10.1`
- `agent-framework-ag-ui 1.0.0rc8`
- `@ag-ui/client 0.0.57`

本地MAF源码参考提交：`9c4cd07899502157284b64a73f9a0adfb4594d96`。最终兼容判断以项目`.venv`中的安装版本和运行Spike为准。

已验证结果：

1. `ProductHistoryProvider`作为唯一加载器、AG-UI请求只向MAF传当前User delta时，第二轮模型输入是`q1,a1,q2`。
2. 默认AG-UI Client全量消息不裁剪、同时启用加载型HistoryProvider时，第二轮会重复为`q1,a1,q1,a1,q2`。
3. `require_per_service_call_history_persistence=True`会让HistoryProvider围绕每次模型服务调用加载和保存。
4. 同时`store=False`时，本地HistoryProvider拥有上下文续接，Provider Response ID不会被用作本地会话续接身份。
5. 正常文本Spike中，HistoryProvider提交发生在`RUN_FINISHED`之前。
6. HistoryProvider保存抛错时得到`RUN_ERROR`，没有`RUN_FINISHED`。
7. AG-UI Snapshot Store保存抛错会被内部吞掉，仍可能发送`RUN_FINISHED`；它不能作为产品提交门。

上述关键结论目前来自本轮一次性Spike，还没有全部固化为Chat仓库的永久回归测试。因此它们足以支持本次设计选择，但不能算实现验收。首批代码必须把双历史、事件顺序、Provider保存错误、per-service工具循环和Response/Conversation ID行为固化为repo合同测试。

当前无密钥`BootstrapAgent`不使用HistoryProvider，只能验证MAF/AG-UI传输，不能产生completion checkpoint或证明Session恢复。D3/D4首批纵向证据必须来自provider-backed正式Agent，或配置同一HistoryProvider合同的专用测试Agent；Bootstrap回合通过不计入Session方案验收。

### 2.2 pi与nanobot

pi直接证明了两个工程原则：完整Session记录与本轮模型Context分开；同Session有活动Prompt时拒绝第二个普通Prompt。它不使用MAF、AG-UI或关系型产品数据库。

nanobot直接证明了3个工程原则：用户输入先保存、同Session串行、持久历史与合法模型Replay分开。它还保存运行中Checkpoint，但采用JSONL与进程内边界，不直接决定本项目Schema和事务。

### 2.3 LibreChat

用户已批准且本阶段只新增LibreChat这1个外部产品参考。固定研究提交为`8e5ef1fb31e9d63b735c089b21cbc82c50acce46`。

LibreChat直接提供的产品证据：

1. Product Conversation和Message是MongoDB权威事实；活动Generation Job和Redis流是另一类运行/传输投影。
2. 正常成功路径先保存User和Assistant产品Message，再发最终事件。
3. Generation Job的`complete/error/aborted/requires_action`状态不能替代持久Product Run；成功后Job默认可删除。
4. ID必须和User/Tenant Scope一起校验；仅凭Conversation/Stream/Thread ID不能授权。
5. 断线续传依赖专门的后台Job、事件传输和快照，不是“保存聊天Message”自然获得的能力。

LibreChat同时提供了反例：部分保存失败会被捕获后继续运行，Abort路径存在先发终态再保存部分Message的较弱顺序；这些做法与本项目“不能假成功”冲突，明确不采用。

LibreChat不使用MAF或AG-UI，因此不能决定HistoryProvider、Workflow Checkpoint、AG-UI Snapshot、SQLite ORM和MAF事件顺序。它未涉及的地方会在每张决策卡中明确标注，不再自动研究第二个外部项目。

## 3. D1：第一阶段保存哪些状态、在哪里恢复

### 3.1 背景与原因

当前存在4类看起来都叫“会话状态”的对象：Product Session/Message、模型History、MAF AgentSession/Workflow Checkpoint、AG-UI Thread Snapshot。若第一阶段把它们都持久化，会有双加载、双写、对账和权限成本；若一个都不持久化，页面刷新和后端重启都会失忆。

现在必须决定的不是简单的“一个库还是两个库”，而是：第一阶段哪些状态真有恢复需求，谁是事实源，页面刷新走哪条路径。

### 3.2 参考覆盖

| 来源 | 覆盖程度 | 真正提供的证据 | 未涉及 |
|---|---|---|---|
| MAF | 直接覆盖扩展点 | HistoryProvider、AgentSession序列化和可选Snapshot Store；Snapshot保存fail-soft | 不指定产品库、SQLite分表/分库或REST产品恢复 |
| pi | 原则覆盖 | 长期Session记录与模型Context分开 | 未涉及AG-UI Snapshot和Web产品REST恢复 |
| nanobot | 原则覆盖 | 持久记录与Replay分开；重启恢复来自服务端存储 | 未涉及AG-UI Snapshot和关系库部署 |
| LibreChat | 产品层部分覆盖 | Product Message与活动流/Job分开；完整历史可独立于流恢复 | 未涉及MAF Snapshot；Mongo/Redis物理部署不能直接复制 |

### 3.3 可选方案

| 方案 | 优点 | 缺点 |
|---|---|---|
| A. **Product DB only；Snapshot off；REST恢复** | 只有一个权威恢复源；没有Snapshot双写和fail-soft成功歧义；最少表与适配代码；刷新不触发模型 | 第一阶段没有原生AG-UI Shared State、Interrupt/HITL恢复；旧SSE不能断线续传；前端需实现REST加载到本地投影 |
| B. Product DB+同一SQLite中的AG-UI Snapshot投影 | 将来Hydrate、State和Interrupt容易接入；本地只需备份一个文件 | 两套Message投影要revision对账；Snapshot依旧不能参与产品成功；增加迁移和升级兼容面 |
| C. Product DB+独立Snapshot DB/Redis | 运行投影可独立扩展、过期和替换 | 第一阶段部署、备份、跨存储一致性和故障模式明显增加；仍不能自动得到跨实例Job |
| D. 以AG-UI Snapshot作为Message/Session权威源 | 表面上最少产品表；能直接重放UI | Snapshot缺少产品元数据、Trace、权限和稳定Schema；保存fail-soft；与已批准的Product DB权威规则冲突 |

### 3.4 当前建议

建议A。第一阶段只做文本对话持久化，Product DB已经足以恢复Session、Message、Run和模型历史。AG-UI继续管理本次实时Run，但不保存持久Snapshot；页面刷新通过REST恢复，不发空Run。

同一个SQLite中可以同时保存Product Message和Run Checkpoint，但它们必须逻辑分表：新Run的默认模型历史只来自已提交且`context_eligible=true`的Product Message；Checkpoint绑定当前Product Run并标记`provisional`，只服务该活动Run的后续模型调用，历史Run Checkpoint默认不进入新Run。

MAF AgentSession第一阶段仍是请求内对象；Workflow Checkpoint、Shared State和Interrupt不进入当前切片。出现真实HITL或工具恢复需求时，再对B/C做专项审核。

### 3.5 风险与未验证项

1. 前端如何把REST Message无损装入AG-UI Client本地状态，需要实施时做浏览器合同测试。
2. 当前连接断开后的服务端取消行为需要实测；A不承诺续传。
3. 以后开启Snapshot时，必须重新设计revision和过期策略，不能无迁移直接切换。

### 3.6 需用户选择

请在A/B/C中选择；D不建议采用。建议批准语句：

> 批准D1：第一阶段使用一个SQLite Product DB保存产品事实和逻辑隔离的Run Checkpoint；新Run历史从可进入上下文的Product Message投影，不读取历史Run Checkpoint；不启用持久AG-UI Snapshot Store，页面刷新和重启通过REST恢复；MAF Workflow Checkpoint、Shared State、Interrupt和断线续传暂不实现。

## 4. D2：Product与协议/Provider ID如何映射

### 4.1 背景与原因

至少要处理6类身份：Product Session ID、AG-UI `threadId`、Product Agent Run ID、AG-UI `runId`、Product Message ID和AG-UI Message ID；Provider还可能返回Response/Conversation ID。若全部混成一个ID，将来一次Session包含多个Run、重试、Provider切换和权限检查都会失去边界。若第一阶段全部分开，又会增加没有产品收益的映射表和客户端同步问题。

### 4.2 参考覆盖

| 来源 | 覆盖程度 | 真正提供的证据 | 未涉及 |
|---|---|---|---|
| MAF/AG-UI | 直接覆盖协议行为 | `threadId`标识Thread但不能授权；当前适配器可能受Provider ID影响；per-service+`store=False`可避免本地续接依赖Provider ID | 不替产品决定Session/Run主键 |
| 当前AG-UI Client | 直接实测 | `@ag-ui/client 0.0.57`不会自动把服务端事件里的新Thread ID永久写回客户端 | 未涉及产品ID模型 |
| pi | 原则覆盖 | 稳定Session ID和独立运行状态重要 | 未涉及AG-UI映射 |
| nanobot | 原则覆盖 | Session key必须稳定且无碰撞 | 未涉及AG-UI映射 |
| LibreChat | 正反两面覆盖 | ID始终需User/Tenant校验；其Stream/Conversation/LangGraph Thread部分同值导致必须额外做createdAt/generation guard | 未涉及MAF ID；不能证明本项目应同值 |

### 4.3 可选方案

| 方案 | 优点 | 缺点 |
|---|---|---|
| A. **Product Session ID与`threadId`同值；Product Run与AG-UI `runId`分开映射** | 第一阶段Session路由和事件核对最简单；Run仍能支持重试、多个执行和幂等；Provider ID完全隔离 | 将来一个Product Session需要多个AG-UI Thread时要增加映射；字段命名必须防止概念合并 |
| B. Product Session、Thread、Product Run和AG-UI Run全部独立 | 边界最纯粹；天然支持一对多Thread | 第一阶段增加映射、查询、迁移和客户端状态同步；没有当前产品需求支撑 |
| C. Session/Thread同值，Product Run ID也直接使用AG-UI `runId` | 表更少；客户端与数据库查找直接 | 客户端相关性ID变成产品主键；重放、重试和冲突输入更难表达；协议ID格式变化影响数据模型 |
| D. 使用Provider Conversation/Response ID作为Session或Run ID | 可利用Provider托管续接 | Provider锁定；服务ID不是授权；当前客户端可能发生Thread漂移；与`store=False`冲突 |
| E. 浏览器随机生成Session并作为权威 | 无需先调用Session API | 服务端无法先建立Scope所有权；列表、归档、跨设备恢复和冲突处理不可靠 |

### 4.4 当前建议

建议A：服务端生成Product Session UUID，同值传给AG-UI作为`threadId`；这是第一阶段的部署映射，不是对象合并。Product Agent Run使用独立服务端UUID，并分别保存请求`agui_run_id`、请求Hash和可选Provider诊断ID。

Product Message也使用服务端UUID，并显式保存Session内唯一的`agui_message_id`。最终Assistant持久化时复用本次流事件里的AG-UI Message ID作相关性，但客户端ID不是Product主键或授权。第一阶段若为简化让两个Message ID同值，也只能是部署选择，不能写成长期不变量。

包装器需要保证标准Run事件继续使用原请求AG-UI `runId`。即使未来MAF或Provider返回其他ID，也只能记录为映射/诊断，不能静默改写Product Session或授权Scope。

### 4.5 风险与未验证项

1. MAF升级后是否仍抑制本地per-service路径的Response ID，需要合同测试。
2. 如果出现“一次Product Session内多个并行Agent Thread”的真实产品需求，应迁移到B。
3. User与Assistant流事件中的AG-UI Message ID稳定性、重放时的唯一约束需要合同测试。

### 4.6 需用户选择

请在A/B/C中选择；D/E不建议采用。建议批准语句：

> 批准D2：第一阶段由服务端生成Product Session UUID，并把同值用作AG-UI `threadId`；Product Agent Run ID、AG-UI `runId`和Provider ID分别保存；Product Message ID与Session内唯一的AG-UI Message ID显式映射；协议ID不得作为产品主键或授权，任何访问都必须结合服务端可信Scope。

## 5. D3：谁加载模型历史，以及浏览器全量消息怎么处理

### 5.1 背景与原因

当前可能提供历史的路径有4条：浏览器`messages`、MAF HistoryProvider、Provider托管Conversation、AG-UI Snapshot。只要两个来源同时加载同一段历史，就会重复token、打乱工具顺序甚至让模型看到伪造的Assistant消息；只要没有唯一来源，重启后又会失忆。

当前AG-UI Client会发送全量本地消息，不能靠前端改成“永远只传最后一句”作为安全边界。因此必须在后端校验完整前缀、裁剪出可信delta，再让唯一HistoryProvider装载服务端上下文。

### 5.2 参考覆盖

| 来源 | 覆盖程度 | 真正提供的证据 | 未涉及 |
|---|---|---|---|
| MAF | 直接覆盖 | `HistoryProvider`扩展点；只能有一个加载器；per-service模式；`store=False`本地托管；当前版本重复/不重复Spike | 不替产品决定Context选择、Message可见性和SQL模型 |
| pi | 原则直接覆盖 | 完整Session Tree投影成活动模型路径，不把所有记录无边界送入模型 | 未涉及MAF Provider和AG-UI客户端 |
| nanobot | 原则直接覆盖 | 持久历史裁剪为合法Replay；移除孤立Tool Result并按预算选后缀 | 未涉及MAF Provider和关系库 |
| LibreChat | 产品层部分覆盖 | 完整Message图与本轮分支上下文分开；服务端Message是权威 | 未涉及MAF HistoryProvider、per-service和AG-UI Snapshot |

MAF会把`AgentSession`交给Provider，但它不包含本项目可信Product Run身份；pi、nanobot和LibreChat也未涉及“MAF Provider如何绑定Product Run”。因此服务端RunContext+ContextVar是本项目推导，必须靠实现前隔离Spike和合同测试证明，不能写成参考项目已保证。

### 5.3 可选方案

| 方案 | 优点 | 缺点 |
|---|---|---|
| A. **`ProductHistoryProvider`唯一加载+`store=False`+per-service+入口delta裁剪** | Product DB权威；非AG-UI入口也能复用；当前版本实测无重复；未来工具循环可逐服务调用Checkpoint；Provider ID不驱动Thread | 需要自定义Provider和薄输入适配；每次服务调用增加DB读写；升级MAF必须重跑合同测试 |
| B. AG-UI Snapshot作为唯一模型历史加载源 | 与适配器默认重建路径接近；Hydrate方便 | Snapshot fail-soft且结构随协议版本；容易成为事实上的产品历史；非AG-UI入口难复用；与D1冲突 |
| C. Provider托管Conversation | 每轮本地发送内容少；Provider可能优化续接 | 数据保留、稳定ID、权限和供应商锁定；仍不解决产品Message、Context选择和REST恢复 |
| D. 浏览器全量消息直接作为模型输入 | 实现最少；无需后端HistoryProvider | 客户端可篡改Assistant/Tool历史；刷新状态决定模型事实；无法可靠审计和跨客户端恢复 |
| E. HistoryProvider与Snapshot/浏览器双加载 | 看似多一份备份 | 当前实测历史重复；顺序、token和工具调用都可能错误；没有合理采用场景 |
| F. 序列化`AgentSession`+内存HistoryProvider | 使用MAF原生对象 | 当前AG-UI请求每次新建Session；仍缺产品资源、权限和可靠事务；恢复入口需另写 |

### 5.4 当前建议

建议A，具体合同包含7条：

1. `ProductHistoryProvider`是唯一`load_messages=True`的Provider。
2. Agent显式`store=False`，不依赖当前OpenAI Client默认行为。
3. Agent启用`require_per_service_call_history_persistence=True`。
4. `ProductAwareAgentFrameworkAgent`核对浏览器消息与数据库前缀，只允许第一阶段的单个新User后缀。
5. 接纳事务立即把User保存为`committed + context_eligible=true`，并把该User占用的Session revision记为`history_cutoff_revision`；第一次进入MAF时只传当前User delta，Provider只加载`revision < history_cutoff_revision`的Product Message，并再次按`current_user_message_id`排除当前User。
6. 同一活动Run的后续模型调用才额外加载**本Run**的provisional Checkpoint，并按来源ID去重；历史Run Checkpoint默认永远不进入新Run。下一轮继续使用已提交User和成功的最终Product Assistant投影；模型失败不删除或隐藏User，只有partial/provisional Assistant与失败Run Checkpoint默认不可进入上下文。
7. 薄包装器在接纳后创建服务端RunContext，通过请求作用域`ContextVar`把可信Product Run身份交给Provider；Provider禁止用客户端`runId`、`threadId`或MAF `session_id`猜测Checkpoint归属，缺失Context直接失败。

per-service模式的价值不仅是“更频繁保存”。工具循环中可能有多次模型调用；每次调用后先保存该调用真正看见和产生的History，才能避免中途退出后本地记录与Provider真实经历不一致。代价是Provider必须按Run、服务调用序号和Payload Hash实现幂等。

### 5.5 风险与未验证项

1. 当前第一切片只有文本回合；工具调用、合成Tool Result和Middleware提前终止仍需进入工具阶段后单独验收。
2. Context长度裁剪第一阶段可以采用保守线性后缀，但Compaction、摘要和分支选择尚未设计。
3. `ProductHistoryProvider`不能把完整Product Trace、失败Message或隐藏推理无边界送入模型。
4. RunContext的并发任务隔离、嵌套调用、异常/取消清理尚未做正式Spike和repo测试；这是实现前置验收，不是已由MAF保证的行为。
5. 当前关键MAF探针还不是仓库回归测试；实现第一步必须固化双历史、事件顺序、per-service工具循环和Response ID合同。
6. 当前Bootstrap Agent没有HistoryProvider；若测试误用它，D3可能在没有历史/Checkpoint的情况下得到表面成功，必须由provider-backed Agent替代或另行适配。

### 5.6 需用户选择

请在A/B/C/D中选择；E不应采用，F不建议采用。建议批准语句：

> 批准D3：使用`ProductHistoryProvider`作为唯一模型历史加载器，显式`store=False`并启用per-service history persistence；后端校验AG-UI客户端全量历史，只把可信新User delta交给MAF；User在接纳事务即`committed + context_eligible=true`，并以它占用的`history_cutoff_revision`为边界只加载更小revision、再按`current_user_message_id`排除重复；同一活动Run的后续调用才额外加载本Run Checkpoint，历史Run Checkpoint不进入下一Run；Product Run身份必须来自接纳后的服务端RunContext，并通过隔离/清理合同测试。

## 6. D4：产品成功与`RUN_FINISHED`如何排序

### 6.1 背景与原因

流式Chat会先把文本delta展示给用户，再出现最终事件。如果最终事件先发、数据库后写，写入失败就会形成“页面显示成功，刷新后消失”的假成功；如果为避免这个问题而等完整回答保存后才发送任何事件，又会失去实时流。

还要避免另一个混淆：per-service HistoryProvider保存的是模型可见History/Checkpoint，不应在每次模型服务调用时直接创建产品Assistant Message或把Run标成成功。最终产品提交必须由知道Interaction、当前Run、Scope和幂等状态的外层Application Service完成。

### 6.2 参考覆盖

| 来源 | 覆盖程度 | 真正提供的证据 | 未涉及/反例 |
|---|---|---|---|
| MAF | 直接覆盖事件和Hook | HistoryProvider提交早于`RUN_FINISHED`；Provider抛错得到`RUN_ERROR`；公开包装入口可薄封装；rc8 `_run_common.py:431-449`显示普通终态通常无outcome、interrupt终态才有`outcome.type=interrupt` | Snapshot保存fail-soft；MAF不负责Product Run事务 |
| pi | 原则部分覆盖 | 运行事件和Session记录要有确定顺序 | 未涉及Web SSE、MAF和产品事务 |
| nanobot | 原则直接覆盖 | User先保存、`SAVE -> RESPOND`、Pending/Checkpoint区分 | 未涉及AG-UI终态和跨表Run提交 |
| LibreChat | 产品层直接覆盖正常路径 | 正常生成先保存User/Assistant Message再发最终事件；活动Job与产品Message分开 | 不使用MAF/AG-UI；Abort路径先发终态后保存是本项目不采用的反例 |

### 6.3 可选方案

| 方案 | 优点 | 缺点 |
|---|---|---|
| A. **预提交+provisional Checkpoint+外层产品提交门** | 保留实时delta；成功终态具有明确产品含义；Checkpoint与Product Message分开；当前MAF异常传播可复用 | 需要薄包装器暂扣终态、累积/核对最终结果和做CAS；依赖锁定版本事件合同；崩溃窗口需对账 |
| B. 接受MAF默认`RUN_FINISHED`，后台尽力写库 | 定制最少；框架升级成本低 | 数据库失败会产生假成功；不符合项目产品规则 |
| C. 让HistoryProvider在每次`after_run`直接写Product Message和Run成功 | 看似少一层包装；Provider错误会阻断终态 | 工具循环会多次调用；Provider不知道完整产品状态机；Checkpoint和产品事实混用；难做Interaction/Scope/CAS |
| D. 缓冲整段响应，数据库成功后一次性发全部事件 | 最容易证明“看到的都已提交” | 失去实时Chat体验，首字延迟变成完整模型延迟 |
| E. 先发`RUN_FINISHED`，再新增`DURABILITY_CONFIRMED` | 不拦截MAF默认事件；能表达第二种确认 | 客户端出现两个“成功”；通用AG-UI不理解；形成竞争协议语义 |
| F. 第一阶段直接实现LibreChat式后台Generation Job和断线续传 | 可跨连接继续生成并重连 | 需要Job租约、事件传输、跨实例所有权、保留期和取消协议；范围与复杂度显著扩大，仍要产品提交门 |

### 6.4 当前建议

建议A，正常顺序固定为：

1. **事务A**：提交`committed + context_eligible=true`的User Product Message、Interaction和Product Agent Run=`running`；Assistant失败不撤销用户已经提交的输入。
2. **运行中**：MAF发送非终态标准AG-UI事件；`ProductHistoryProvider`每次服务调用后保存绑定当前Run的provisional Run Checkpoint。
3. **完成Checkpoint**：最终模型响应保存为provisional完成条目和提交回执，Run可进入`committing`；此时还没有Product Assistant Message，也不是成功Run。
4. **观察终态并执行事务C**：包装器必须真的看到并暂扣MAF `RUN_FINISHED`，并核验事件属于当前Run、没有错误/待处理Interrupt/未完成Tool Call。当前rc8的普通成功事件通常没有`outcome`；`outcome.type == "interrupt"`或仍有pending interrupt时不能成功。通过这些检查后，才在一个短事务内创建`context_eligible=true`的Product Assistant Message、把Run和Interaction改为成功、清除活动Run并更新Session revision。User在事务A中已经可进入上下文；Checkpoint可封存供诊断，但不会变成下一Run默认历史。
5. **事务提交后**：才转发原MAF标准`RUN_FINISHED`。

HistoryProvider保存抛错时，当前MAF已经会输出`RUN_ERROR`；包装器仍需暂扣`RUN_FINISHED`，因为“事件类型是`RUN_FINISHED`且Hook没有报错”不等于没有interrupt、回执属于当前Run或外层产品事务成功。未来Interrupt/HITL应映射`suspended/awaiting_input`，绝不能进入`succeeded`；第一切片遇到不支持的暂停/待输入语义时明确拒绝或记录非成功状态。

当前顺序中的文本事件和`MESSAGES_SNAPSHOT`也早于事务C。它们可以提供实时体验，但只是provisional前端投影；若事务C失败，包装器随后发送错误，刷新页面必须以REST Product Message为准，不能把已经显示的Snapshot事件当成持久化证明。

崩溃落在第3和第4步之间时，只能证明Checkpoint保存，不能证明包装器观察到MAF终态；即使包装器已经在内存中观察到终态、但事务C尚未提交，也没有持久成功证据。启动对账必须把Run收敛为`interrupted`，保留可审查provisional候选但默认不进入历史，不自动成功也不重跑。崩溃落在第4和第5步之间时，产品终态事务已经成功，刷新REST应显示答案，即使旧连接没有收到终态。

### 6.5 风险与未验证项

1. MAF升级可能改变HistoryProvider与AG-UI终态的顺序；依赖升级必须重跑故障注入合同。
2. 从最终MAF响应/完成Checkpoint生成Product Assistant负载的规范化规则需要测试，不能仅依赖已发送delta拼接；实际观察到当前Run的普通`RUN_FINISHED`、确认无interrupt outcome和无pending interrupt都只是进入产品终态事务的必要条件。
3. 客户端主动取消、ASGI断线和Provider实际取消传播需要端到端验证；第一阶段不承诺后台继续或流续传。

### 6.6 需用户选择

请在A/B/C/D/E/F中选择；建议A。批准语句：

> 批准D4：模型调用前提交`committed + context_eligible=true`的User Message、Interaction和Product Agent Run；per-service HistoryProvider只写绑定当前Run的provisional Checkpoint以及至多一个非终态完成标记，不直接产生Product Assistant或产品成功；只有包装器实际观察并暂扣当前Run的`RUN_FINISHED`、确认没有`outcome.type=interrupt`或pending interrupt后，外层终态事务才能写可进入上下文的Product Assistant、把Run/Interaction改为成功，随后放行标准终态；Interrupt/HITL绝不标记成功，终态事务前崩溃收敛为`interrupted`，文本和`MESSAGES_SNAPSHOT`在此之前都只是provisional投影，任何失败都不得假成功或自动重跑模型。

## 7. D5：同Session并发、重复请求和重试

### 7.1 背景与原因

两个普通Run同时读取相同历史尾部并流式写回，会产生顺序交错、后写覆盖、重复工具调用和不可解释的上下文。移动网络又可能让同一提交被重发，因此“禁止并发”还不够，必须同时定义幂等。

约束对象应是Product Agent Run，不是Interaction：一次Interaction未来可能产生重试Run或HITL恢复Run。

### 7.2 参考覆盖

| 来源 | 覆盖程度 | 真正提供的证据 | 未涉及 |
|---|---|---|---|
| MAF | 未涉及产品策略 | 可以多次调用Agent | 不定义同Product Session并发、幂等和队列 |
| pi | 直接覆盖 | 活动Prompt存在时拒绝第二个普通Prompt；`steer/follow-up`是显式不同语义 | 未涉及数据库跨进程约束 |
| nanobot | 直接覆盖 | 每Session Lock和队列；同Session串行、跨Session并发 | 主要是进程内实现，不能替代数据库唯一约束 |
| LibreChat | 部分覆盖 | Generation Job所有权、当前Job校验和createdAt/generation guard防止旧Run覆盖新状态 | 未直接采用“一Session一活动持久Run”的关系约束 |

### 7.3 可选方案

| 方案 | 优点 | 缺点 |
|---|---|---|
| A. **同Session一个活动Run；新请求`SESSION_BUSY`；重复请求幂等** | 最小、确定、容易测试；不会暗中改变输入顺序；跨进程可用数据库约束 | 用户必须等待或明确重试；不能连续排队多条消息 |
| B. 后端持久FIFO队列 | 用户可连续提交；保持串行 | 需要队列状态、取消、超时、上下文revision、重启恢复和可见进度 |
| C. 明确区分`steer`与`follow-up` | 交互能力强；可修正当前运行或排队下一条 | UI、工具循环插入点和持久语义复杂；第一阶段范围扩大 |
| D. 允许并发并建立分支/revision | 支持多答案探索 | 需要树会话、分支选择、合并和独立Context，不是线性Chat最小切片 |
| E. 只用进程内Lock | 实现快速 | 多进程、崩溃和重启后失效；不能提供幂等唯一性 |

### 7.4 当前建议

建议A，并固定5条规则：

1. 同Session最多1个`accepted/running/committing` Product Agent Run。
2. 相同`scope+session+agui_run_id+request_hash`不再次调用模型，返回现有Run状态/结果。
3. 相同幂等ID但Hash不同返回`IDEMPOTENCY_CONFLICT`。
4. 不同ID但已有活动Run返回`SESSION_BUSY`，且不先写第二条User Message。
5. 用户显式重试使用新Run、新AG-UI `runId`和`retry_of`；旧失败Run不可改写。

请求Hash至少覆盖Session、起始revision、规范化User内容、附件引用和有效执行参数。进程内Lock可以减少争用，但数据库唯一约束/CAS才是最终保证。

### 7.5 风险与未验证项

1. AG-UI层“返回现有Run状态”的具体SSE/HTTP表达要在实现合同中固定，但不能触发第二次模型调用。
2. 多进程SQLite写竞争需用WAL、busy timeout和并发测试验证；SQLite不是无限并发方案。

### 7.6 需用户选择

请在A/B/C/D中选择；E不能单独采用。建议批准语句：

> 批准D5：第一阶段同一Product Session最多一个活动Product Agent Run；新普通请求返回`SESSION_BUSY`，相同幂等请求不重复调用模型，Hash冲突返回`IDEMPOTENCY_CONFLICT`；不同Session仍可并发，重试必须创建关联原Run的新Run。

## 8. D6：SQLite使用什么数据访问和迁移工具

### 8.1 背景与原因

第一版就需要Session、Message、Interaction、Agent Run、模型History/Checkpoint和Trace之间的关系、状态约束、幂等唯一性和迁移。后续还会增加Intent、WorkItem、Approval、Execution、Evidence和Memory。数据访问工具会影响事务边界、测试方式和以后迁移PostgreSQL的成本。

### 8.2 参考覆盖

| 来源 | 覆盖程度 | 真正提供的证据 | 未涉及 |
|---|---|---|---|
| MAF | 未涉及 | Store协议允许自定义实现 | 不指定ORM、SQLite或迁移工具 |
| pi | 未涉及关系库 | 使用版本化JSONL | 不能决定关系迁移方案 |
| nanobot | 未涉及关系库 | JSONL原子替换和fsync | 不能决定ORM或Alembic |
| LibreChat | 未涉及本技术选择 | 使用Node、MongoDB和Redis | 不能决定Python SQLite ORM；不应复制其栈 |

这项建议完全来自本项目的对象数量、事务约束、Python生态和本地优先部署目标，没有开源参考项目可以替用户做决定。

### 8.3 可选方案

| 方案 | 优点 | 缺点 |
|---|---|---|
| A. **SQLAlchemy 2+Alembic+`aiosqlite`** | 成熟事务和迁移生态；复杂关系/约束清晰；以后迁PostgreSQL成本较低；迁移文件可逐次审核 | 新增依赖和概念；异步Session误用会增加复杂度；`aiosqlite`不提升SQLite多写者能力 |
| B. 标准库`sqlite3`+显式SQL迁移表 | 依赖最少；SQL和事务完全透明；首版代码量可能较小 | 映射、迁移、回滚和测试基础设施都要自建；对象增长后维护成本高；异步路由需线程边界 |
| C. SQLModel+Alembic | 与FastAPI/Pydantic表面接近，上手简洁 | 复杂映射仍回到SQLAlchemy；容易误把API模型、ORM模型和领域对象合并；增加一层兼容面 |
| D. 现在直接PostgreSQL | 多写者并发和生产扩展更强 | 破坏本地一键运行目标；新增服务和部署；当前负载没有证据需要它 |

### 8.4 当前建议

建议A，但附带5个约束：

1. ORM模型不作为API、MAF Message或领域对象直接暴露。
2. 路由不直接写ORM；所有状态转换经过Application Service和Repository。
3. SSE和模型调用期间不保持数据库事务或SQLAlchemy Session。
4. SQLite启用foreign keys、WAL和busy timeout；写入都是短事务。
5. Schema变更只通过可审核Alembic迁移，不在启动时静默修改未知Schema。

### 8.5 风险与未验证项

1. 最终依赖版本要在实施时锁定并跑并发/迁移测试。
2. 若未来多实例写入成为实际需求，应以Repository合同迁移PostgreSQL，而不是强行让SQLite承担分布式锁。

### 8.6 需用户选择

请在A/B/C/D中选择；建议A。批准语句：

> 批准D6：使用SQLAlchemy 2、Alembic和`aiosqlite`实现SQLite Repository、短事务和显式Schema迁移；ORM、API、领域与MAF对象分离，路由不直接修改持久化状态。

## 9. 外部参考范围已收敛

本轮外部产品参考只有1个：LibreChat。它只用于Product Session/Message、持久Run与短命Job的区别、正常成功顺序、失败语义、流式续传所需条件和跨实例关联。

本轮不会自动研究或加入第二个外部项目。若未来出现LibreChat明确未涉及的问题，审核材料直接写“未涉及”；新增任何外部参考仍需先向用户说明具体缺口、限定范围和研究成本。

MAF API与事件顺序继续以当前安装源码和实测为准；pi与nanobot继续作为已批准的本地工程参考，不属于新增外部产品集合。

## 10. 建议的审核顺序与回复方式

建议按依赖关系审核：

1. 先D1，决定Snapshot off和REST恢复。
2. 再D2，固定ID映射和授权边界。
3. 再D3，固定唯一模型历史加载路径。
4. 再D4，固定产品提交和AG-UI成功终态顺序。
5. 再D5，固定并发、幂等和重试。
6. 最后D6，固定Schema实现工具。

如果全部同意，可以回复：

> 批准Session持久化D1-D6，按审核包当前建议进入第一实施切片。

如果只修改某项，可以直接回复，例如：

> D1、D2、D3、D5、D6批准；D4选择方案D。

未收到明确批准前，下一步仍然只允许修订设计和验证证据，不创建正式Schema、迁移或持久化服务。
