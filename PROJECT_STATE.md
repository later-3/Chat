# Chat 项目状态

## 1. 当前结论

| 项目 | 当前事实 |
|---|---|
| 产品身份 | 独立开发、独立运行、独立运营并持续演进的完整 Chat 产品 |
| 当前目录 | `/Users/xulater/Code/Chat` |
| 代码状态 | 前后端骨架、MAF + AG-UI纵向链路、双协议逐次模型审批、Product Session R0/R1文本会话底座、嵌套Workflow、受治理双Agent和pi Agent Tool纵向切片已完成 |
| 设计状态 | 总体架构已按完整用户场景重写；Workflow、多Agent和pi Agent种子已实现，Session R2-R6仍需按专项路线和恢复保证分别交付 |
| Session 状态 | 9个能力域、74项能力、R0-R6和Phase 0-8路线已批准；Phase 0与Phase 1文本底座、显式Retry/Restart和精确取消窄切片完成，R2-R6仍按后续阶段交付 |
| 数据状态 | Product Store Schema与8个Alembic迁移已建立；只包含本项目新会话、Agent Profile、Tool配置与执行记录，没有迁移旧数据库、旧历史或旧项目配置 |
| Git 状态 | 私有仓库`later-3/Chat`，分支`main`；按Feature节点提交并推送，私有配置和本地产物不进入Git |

## 2. 已确认的稳定事实

### 2.1 产品与架构

1. 项目不保留背景章节，直接围绕 6 个用户问题、6 个目标和完整闭环设计。
2. Chat 是独立完整产品，不是 Adapter、薄通道或外部系统附属实现。
3. OPC-OS Chat 是可对等互操作的外部系统；特定拓扑中的通道角色不改变 Chat 产品身份。
4. Chat Web通过Web/API Adapter访问后端；Telegram等终端平台通过具体Channel Adapter、OPC-OS Chat通过Bridge Adapter进入Channel Adapter Host，再统一调用Interaction Ingress，任何外部平台都不能直接调用产品核心。
5. Chat 自己承担 Conversation、Work、Approval、Run、Evidence、Delivery、Memory 和 Trace 的产品事实责任。
6. Product Session、MAF AgentSession/Workflow Checkpoint、AG-UI Thread、Product Run 是不同对象；Product Run 与 Run Attempt 也不同。
7. REST 管理产品资源，AG-UI 管理一次 Agent Run 的实时交互；Product DB 是产品事实源，MAF 负责运行时语义。
8. Interaction 与 Product Run 不是同一对象；一次 Interaction 可以触发零到多个 Run。
9. 模型输出只能提出 Intent、Work、Memory 和结果候选，不能自动成为长期正式事实。
10. Session总体规划必须先覆盖完成历史、活动流、Worker、Tool、Workflow/HITL和跨入口连续性，再按依赖拆交付。

### 2.2 已批准技术路线

1. 后端：Python、Microsoft Agent Framework（MAF）、FastAPI。
2. 前后端 Agent 协议：AG-UI over HTTP/SSE，不是 assistant-ui。
3. 前端：React 19、TypeScript、Vite、`@ag-ui/client`和自研UI。
4. UI基础：Tailwind CSS、Radix UI、Lucide React；Zustand只管理页面状态。
5. MAF运行状态与产品领域状态分开拥有；SQLite是已批准的Product Store实现起点，但必须验证目标架构所需保证。
6. 架构技术基线包括MAF、pi、nanobot和QwenPaw；外部Web产品主参考保留LibreChat。新增其他参考项目仍需用户批准。
7. 模型调用审批采用“MAF原生Workflow + 自定义确定性Executor”：每次模型调用都审批，`store=False`展示完整显式上下文，关闭MAF自动Tool循环；Provider与模型由服务端目录约束并联动，可读视图用固定Key和类型化Value控件，Provider JSON作为同一草稿的高级视图。所有Provider Body字段可编辑；Provider路由或Body修改都会生成新版本、Hash和审批，放弃零发送并恢复原输入。
8. 后端以私有`backend/config.json`作为唯一运行配置源；Provider按数组扩展并各自维护模型目录，当前配置包含火山方舟和阿里云百炼。仓库只提交脱敏示例，密钥和Base URL不进入浏览器响应或Git。

## 3. 本轮纠正与完成

- [x] 新增[项目经验与反例](./PROJECT_LESSONS.md)，建立每次回复前强制读取规则。
- [x] 记录10个可执行反例；新增对象可理解性与操作可走通性检查，要求从用户点击穿透前端、后端Store、MAF、Provider、响应解析和最终渲染。
- [x] 纠正`AGENTS.md`和`PROJECT_CONTEXT.md`中的产品身份与外部关系。
- [x] 删除稳定产品上下文里的“第一阶段/后续能力/非上位系统”式范围定义。
- [x] 在`agent_knowledge/project-studies`新增pi、nanobot架构与模块源码研究，补齐QwenPaw Web/Channel入口拓扑和LibreChat源码模块拓扑、责任与缺口。
- [x] 重写[总体架构研究](./docs/overall-architecture-research.md)，按固定提交还原pi、nanobot、QwenPaw、LibreChat真实模块，再逐项执行“源码事实→Chat问题→模块决策”。
- [x] 重写[总体架构候选](./docs/overall-architecture-proposal.md)：
  - 取消“数据/知识/执行/交付平面”等自创分类；补正为Web/API Adapter、具体Channel Adapter、Channel Adapter Host、Interaction Ingress、10个产品与应用模块、MAF与基础设施适配器。
  - 每个模块定义参考来源、存在原因、用户价值、内部组件、状态、合同、不变量、失败和测试责任。
  - 定义FastAPI API、Execution Worker、Scheduler/Reconciler、Delivery Worker、Projector进程角色。
  - 定义状态所有权、ID链、事件合同、关键状态机和4个提交门。
  - 用8个用户场景逐步映射组件、合同、状态、失败和用户结果，其中分别展开Web、OPC-OS Bridge和Telegram Adapter路径。
  - 只在文档最后给出交付阶段。
- [x] 新增[架构新手导读](./docs/architecture-beginner-guide.md)：
  - 区分前端交互对象、协议对象、产品领域对象和MAF/Worker运行时对象。
  - 逐项解释前端7个区域、后端核心对象、MAF Agent 10个内部部件及Agent外的Workflow、AG-UI与产品控制。
  - 用“整理Session计划并审核后写文档”的20步场景串起对象创建、版本、审批、执行、证据、交付和失败恢复。
  - 补充“发送→审批→Provider→响应解析→产品提交→React渲染”的完整时序，解释Agent内外两类Session/Tool责任、5类逻辑Store及当前代码与目标架构差距。
- [x] 重写`PROJECT_PLAN.md`，按10条工作流、依赖图和9个交付阶段映射目标架构。
- [x] 更新README项目定位与文档入口。
- [x] 完成所有Session专项文档中的旧产品身份和误导性阶段措辞一致性修订。
- [x] 清理Python包、FastAPI元数据、Agent描述和Web品牌中的旧“OPC-OS附属通道”命名，统一为独立Chat产品。
- [x] 完成全仓文档交叉审计、本地链接检查和工程验证：3个后端测试、前端类型检查与生产构建通过。
- [x] 完成模型调用审批合同Spike：精确流式Payload、SQLite 8并发唯一领取、跨两个OS进程的AG-UI/Product Approval/MAF Checkpoint重连、返回修改后二次审批、拒绝后新Run重新发送均通过。
- [x] 把审批合同落成可运行纵向切片：后端原生Workflow/Executor、进程内草稿与唯一Attempt、精确Provider Transport、REST修改端点，以及前端同源双视图、全字段编辑、二次审批、放弃恢复和清空输入。
- [x] 把当前项目`backend/.env`一次性迁移为权限`0600`且被Git忽略的`backend/config.json`；后端、VS Code调试和测试不再读取`.env`。配置以`providers`数组支持火山方舟、阿里云百炼及后续Provider/模型追加，并保留旧`.env`作为未被应用读取的迁移备份。
- [x] 修正审批页虚假Tool入口：移除`new_tool`和自由填写Tool名称；当前未接入真实Tool Catalog时只显示“暂无可用Tool”，可读视图与服务端都拒绝非空`tools`。确认发送在存在未保存修改时明确显示“请先保存修改”，保存生成新版本和新Hash后才可批准。
- [x] 完成Provider/模型能力级编辑与深层校验：Role、内容类型、参数类型/范围、上下文来源、采用原因和透明Token估算均由当前模型能力控制。
- [x] 完成Responses与Chat Completions双协议规范草稿：切换Provider时先转换为目标协议最终Body，保存后以新Hash审批，Transport不再改写；火山方舟和阿里云百炼均通过真实浏览器审批回合。
- [x] 完成Provider明确失败、超时结果未知和发送后取消结果未知语义；均只创建1次Attempt且不自动重试，用户可把原Prompt取回输入框。
- [x] 完成Product Session Phase 1文本底座：SQLite Product Store、Alembic迁移、Session/Message/Interaction/Run/Attempt/协议ID映射/Trace、REST恢复、服务端唯一历史、终态提交门和启动中断收敛。
- [x] 完成Session前端入口：会话列表、新建/打开、刷新恢复、标题、归档、Provider/模型默认配置、Run状态与Attempt摘要；浏览器已完成双轮真实模型、刷新、配置切换和放弃交叉验证。
- [x] 修复Web滚动所有权：App Shell不再由`body`整体滚动，桌面会话列表与右侧对话内容各自独立滚动且对话标题保持可见；窄屏会话抽屉按顶部栏以下的实际可视高度独立滚动，桌面与窄屏浏览器回归均通过。
- [x] D3按已批准的确定性审批Workflow做窄适配：当前由ProductSessionService在Workflow入口唯一装配历史；普通MAF Agent未来才启用ProductHistoryProvider，两条路径禁止同时加载。
- [x] 完成Workflow可视化种子：注册表描述8个异构节点和两层嵌套关系；MAF原生子Workflow通过窄`VisibleWorkflowExecutor`转发内部生命周期，AG-UI继续使用标准Step/Activity事件，前端按稳定节点ID原位投影实时进度。
- [x] Workflow复用Product Session、Product Run/Attempt和产品提交门；成功结果进入权威消息历史，失败保留User事实且不生成假Assistant成功，刷新从脱敏Product Trace恢复最近节点终态。
- [x] Workflow浏览器已验证实时中态、8节点成功、3层失败传播、刷新恢复、Chat历史交叉投影和371px窄屏；同时修复审批放弃留下withdrawn审计消息后，新Run按可见消息数量分配ordinal导致冲突的问题，并增加跨Feature回归用例。
- [x] 完成受治理双Agent会话传递：Product DB持久化`planner`/`reviewer` Profile与Revision，前端可查看和编辑名称、职责、Instructions及Provider/模型；每次Workflow开始取得不可变配置快照，配置本身不构成执行授权。
- [x] 完成`planner Agent -> 确定性交接Executor -> reviewer Agent`的MAF原生Workflow；原始用户目标、规划结果和显式交接要求完整进入第2次请求，两次真实Provider调用分别产生独立Draft、Hash、Approval和Attempt。
- [x] 多Agent已覆盖首轮放弃后修改Prompt重新运行、次轮请求修改产生v2/新Hash后继续、次轮放弃、配置并发CAS、无假Assistant成功和最终Product提交；浏览器真实模型回合得到3/3节点完成及Chat历史恢复。
- [x] 修复真实双Agent运行暴露的Trace并发竞争：不再使用`MAX(sequence)+1`，改为Product Run内数据库原子计数器；20个并发写入与真实33条Trace均连续唯一。
- [x] 完成pi coding agent真实Tool接入：MAF `FunctionTool`与确定性Workflow启动pi官方JSONL RPC子进程；本机Provider Gateway确保每次模型请求都生成完整可编辑Draft并逐次审批，pi扩展把每个内部Tool调用转换成可编辑参数的AG-UI Interrupt。
- [x] 完成pi Tool配置与监控入口：Provider/模型联动、工作目录根策略、7个真实内置Tool选择、Thinking/调用上限/超时/System Prompt、配置CAS Revision，以及模型/Tool/Token/成本/耗时/失败统计；重启把遗留`running`执行收敛为`interrupted`。
- [x] pi真实浏览器Tool loop验证完成：两次真实Provider审批、一次`read`，参数从`README.md`修改为`PROJECT_STATE.md`后执行，最终Product Message为`BROWSER_PI_OK`；371px无横向溢出，全新页面控制台0错误。
- [x] 完成失败Run的显式Retry/Restart窄切片：旧Run与Attempt不改写，新Run持久化`retry_of_run_id`和`retry/restart`语义；原样重试必须保持输入一致，修改后使用Restart，二者都重新进入逐次模型调用审批。
- [x] 修复Provider失败后把Prompt取回输入框时回退本地历史、与已提交Product User冲突的问题；产品历史继续保留失败输入，Retry/Restart的模型上下文会排除整条重试祖先输入链，避免Provider看到重复Prompt。
- [x] Retry和Restart浏览器真实模型交叉验证完成：审批载荷都只有1条本轮输入，分别得到`SESSION_RETRY_OK`和`SESSION_RESTART_OK`；371px无横向溢出，页面控制台0错误。
- [x] 完成按精确AG-UI `runId`映射的取消窄切片：Provider发送前收敛为`cancelled`，发送后保守收敛为`outcome_unknown`；取消与正常终态竞态可幂等读取目标终态，旧runId不会取消后续Run。
- [x] 发送后取消的真实浏览器验证完成：点击停止后Run为`结果未知`，等待Provider原请求结束并刷新后仍只有User产品消息，没有伪Assistant成功；371px窄屏无溢出。

## 4. 已完成的工程与研究证据

### 4.1 工程基线

1. 已建立独立Git、`.gitignore`、`.editorconfig`、Python 3.12/uv和前端npm工程。
2. 后端当前依赖：`agent-framework-core 1.11.0`、`agent-framework-openai 1.10.1`、`agent-framework-ag-ui 1.0.0rc8`。
3. 前端当前依赖：React 19、TypeScript 6、Vite 8、`@ag-ui/client 0.0.57`。
4. `POST /api/agent`接收AG-UI请求并通过SSE返回运行和文本事件。
5. 无可用Provider时使用确定性Bootstrap Agent；`backend/config.json`中至少一个启用Provider配置完整且默认Provider可用时，创建逐次审批的真实模型Workflow。
6. `GET /api/health`只返回安全运行信息，不输出密钥。
7. VS Code后端`8030`、前端`5073`；调试前后定向清理对应端口和项目进程。

### 4.2 已有验证

1. 当前工作区后端59个测试通过，覆盖工程基线、JSON配置、审批合同、双协议、能力校验、精确发送、Session迁移/恢复/并发/幂等/Retry血缘/精确取消、失败/超时/结果未知、Product提交门、嵌套Workflow、多Agent、pi RPC/Provider Gate/Tool Gate/执行统计、原子Trace和AG-UI终态顺序。
2. 前端17个逻辑测试、类型检查和生产构建通过；最新`npm install --package-lock-only`审计122个包，0个已知漏洞。
3. 浏览器完成Provider/模型联动、固定Key/类型化Value编辑、Role与内容类型同步、双视图同源、跨协议转换、修改后二次审批、放弃恢复，以及Session对话页/会话抽屉/设置弹窗窄屏回归；371px有效宽度无横向溢出。
4. 火山方舟Responses与阿里云百炼Chat Completions各完成1次真实模型审批回合；后者核对最终Body仅含`model/messages/tools/store/stream`并返回预期文本。
5. 清理脚本已验证可分别终止端口8030的Uvicorn和5073的Vite，清理后无监听残留。

### 4.3 Session与参考项目研究

1. 已按当前安装版本、MAF源码、测试和示例核对Session、HistoryProvider、AG-UI和Workflow能力。
2. 已研究pi、nanobot的Session存储、恢复、并发和失败边界。
3. 已在固定提交`8e5ef1fb31e9d63b735c089b21cbc82c50acce46`研究LibreChat Conversation、Message树、Generation Job、活动流、失败终态、HITL和Web总体分层。
4. 已实测MAF HistoryProvider终态顺序、保存失败、per-service持久化和双历史风险。
5. MAF、pi、nanobot、QwenPaw与LibreChat可复用知识已写入`/Users/xulater/Code/opc-os/agent_knowledge`对应目录。

### 4.4 模型调用审批合同Spike

1. 测试型Provider Adapter通过本地真实TCP HTTP/SSE流式请求证明：审核Hash对应的同一`bytes`缓冲区被直接发送，服务端捕获Body逐字节一致；两个用户视图从该Body投影，`store=False`且无Continuation引用。
2. 临时SQLite合同表在8个不同PID的Worker同时竞争同一已批准请求时，只有1个成功创建`ModelCallAttempt`并消费Approval；数据库重开后重复领取仍被拒绝。
3. 两个不同PID分别承载暂停和恢复请求；持久AG-UI Snapshot先恢复中断卡片，产品层`thread/approval -> checkpoint_id`薄桥恢复MAF Checkpoint，再由原生canonical resume完成发送；起始Executor没有重跑。
4. “返回修改”不会发送旧Draft：旧Draft和Approval变为`superseded`，服务端创建新版Draft和新Approval，第二次批准后只发送新版。
5. “拒绝”以已解决的产品决策结束当前Run且零Attempt；用户之后编辑并再次点击发送会创建新Product Run，再次审批后可以发送。待审批时直接塞入新消息会得到MAF `WORKFLOW_RESUME_REQUIRED`，不能绕过审批。
6. 证据位于`backend/tests/spikes/test_model_call_approval_spike.py`。这是测试型合同和临时`spike_*`表，不是正式Product Schema、Repository、Worker或生产Provider实现。

### 4.5 模型调用审批纵向切片

1. `backend/app/model_call_workflow.py`使用MAF原生Workflow、`RequestInfoMixin`和自定义确定性Executor，在Provider发送前通过AG-UI Interrupt暂停；修改后再次Interrupt，批准后只发送当前Hash绑定的请求。
2. `backend/app/model_call_review.py`维护单一请求草稿，生成Canonical JSON bytes和Body SHA-256；Provider路由与Body Hash共同生成审批Binding Hash。可读视图与Provider JSON均从该对象投影，实际Transport按已批准Provider直接发送已批准bytes，不再由Agent或Provider SDK二次装配。
3. 服务端提供不含密钥和Base URL的Provider/模型目录；前端先选Provider，再从该Provider模型列表中选择模型。完整input、知识/历史和Tools按固定Key卡片编辑，Reasoning、输出和传输参数使用文字、数字、布尔和枚举控件；未知扩展字段仍可在Provider JSON高级视图编辑。未保存修改不能批准；`store != false`、Continuation或Provider/模型不匹配时不能保存。
4. 放弃审批不会创建Provider Attempt，前端恢复发送前消息快照并把原用户输入放回输入框，可继续修改发送，也可用叉号清空；后端会过滤MAF `request_info`审批协议消息，放弃后再次发送不会递归夹带旧审批JSON。
5. 浏览器已验证Provider切换后模型列表从`glm-5.2/doubao-seed-code`联动为`secondary-model/secondary-fast`，普通文字和Reasoning控件修改会同步进入Provider JSON，保存后进入v2新Hash审批；全新页面控制台错误为0，窄屏文档和审批面板均无横向溢出。
6. 火山方舟Responses与阿里云百炼Chat Completions均通过完整真实审批回合；当前Provider/模型目录是启动时不可变配置快照，尚未实现从各Provider动态发现模型和参数能力。
7. Product Run和Run Attempt已经持久化；模型调用Draft、Approval、Provider Attempt和Workflow实例仍是单进程内存状态。进程重启会把活动Product Run收敛为`interrupted`，但不能恢复原Approval或Workflow，不能冒充R5/R6。
8. `backend/config.json`是启动时只读快照，当前包含2个Provider；修改Provider或模型目录后需要重启后端，尚未实现在线重载或Provider模型自动发现。

## 5. 尚未实现的能力

1. Session Phase 2-3的Resume、Steer、Follow-up、分支/Fork、搜索、标签、长上下文、导入导出和完整资源生命周期；Retry/Restart与精确取消已有窄切片，但尚未与后续活动Job/Checkpoint Resume混称。
2. Principal/真实身份Scope、Channel Binding、ContextPackage、Intent、Work/Plan、ExecutionDraft和持久Approval。
3. Runtime Job/Event、活动流游标、Worker、Lease、Heartbeat和Reconciler；当前只做启动时中断收敛。
4. 通用Tool Operation Ledger、外部副作用幂等/结果未知/对账、Workflow持久Checkpoint与跨进程HITL；当前pi专用执行记录只提供可观测终态与启动中断收敛。
5. Memory、Evidence、Provenance、Artifact、Delivery/Outbox和完整运营Trace。
6. Telegram等具体Channel Adapter合同，以及OPC-OS Chat Bridge的正式身份、能力、消息和回执合同。
7. Provider结果未知后的查询对账、补偿和人工处置。

## 6. 风险和未知

1. MAF安装版与本地参考源码不是同一发布快照；具体API、事件和异常必须以安装版合同测试为准。
2. AG-UI当前为RC版本，升级可能改变事件、Snapshot和Interrupt/Resume行为。
3. AG-UI Client会发送客户端消息全集；若同时装配Product History、MAF History和Snapshot会形成重复上下文。
4. Product Finalization Gate如何阻止过早`RUN_FINISHED`仍需安装版Spike。
5. MAF Workflow Checkpoint与Product Run、持久Approval的跨进程薄桥已通过合同Spike，但尚未进入正式API、Repository、Worker和浏览器E2E；pi已有窄执行记录，仍不能替代通用Tool Ledger和结果未知对账。
6. SQLite已验证单Approval的8并发原子领取；Outbox、事件写入、Lease、多进程持续竞争和容量边界仍未压测。
7. 外部Tool副作用没有通用Exactly-once；必须按工具定义幂等、查询、补偿和人工处置。
8. Intent、Work、Approval、Evidence、Delivery等主要来自本项目需求，参考项目未提供可直接复制的完整状态机。
9. OPC-OS Chat正式身份、权限、能力、消息和回执合同尚未取得。
10. 安全、容量、SLO、数据保留和灾难恢复的数值目标尚待产品审核。
11. Chat原生Channel Adapter内置部署、独立Adapter进程和由OPC-OS Chat托管渠道是3种物理选择；逻辑上均必须经过Interaction Ingress，具体采用范围待架构审核和外部合同确认。
12. 安装版`agent-framework-ag-ui==1.0.0rc8`的Workflow桥可能在关闭文本或诊断事件前产生`RUN_FINISHED`/`RUN_ERROR`；当前薄Wrapper把终态缓冲到事件流最后并有合同测试，依赖升级时必须重新验证并尽量移除兼容层。
13. 安装版MAF原生`WorkflowExecutor`不向外层观察者展开子图内部生命周期；当前`VisibleWorkflowExecutor`只做单进程嵌套事件转发且明确拒绝子级HITL，不代表Checkpoint、跨进程或R6恢复已经实现。
14. 安装版MAF `AgentExecutor`支持`full_conversation`会话传递，但会直接调用内部Agent；严格逐次审批场景使用自定义受治理Agent Executor，不能把原生Agent-as-Executor误认为已经经过产品Approval。

## 7. 当前开发门

1. Session Phase 1只证明R0/R1文本恢复；后续任务不得把它外推成活动流、Worker、Tool或Workflow/HITL恢复。
2. Workflow可视化种子只兑现运行中投影和完成Trace恢复；后续Checkpoint/HITL不得复用这份Trace冒充运行恢复。
3. 多Agent种子已验证MAF Agent-as-Executor合同、显式会话传递、配置Revision和逐次模型调用审批；它仍不代表任意动态Agent拓扑、持久Checkpoint或并发群聊已经完成。
4. pi Agent Tool已验证官方JSONL RPC、两道治理门和真实Tool loop；它仍不代表跨进程pi Session、持久Approval、通用副作用对账或R6恢复完成。
