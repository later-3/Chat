# Chat 项目状态

## 1. 当前结论

| 项目 | 当前事实 |
|---|---|
| 产品身份 | 独立开发、独立运行、独立运营并持续演进的完整 Chat 产品 |
| 当前目录 | `/Users/xulater/Code/Chat` |
| 代码状态 | 前后端骨架、MAF + AG-UI纵向链路、Product Session R0/R1与可见定位码、双协议模型治理和持久Provider Attempt审计、34节点持续协作主Workflow、HITL策略矩阵、持久Checkpoint/Outbox恢复、ExecutionDraft完整编辑、Product Harness纵向生命周期、协作协议/Context revision/步骤输入阶段A、Intent Set与复合Plan阶段B、SD1 Repository只读纵向闭环、SD2受治理pi只读执行、Runtime Job/Event/Cursor/通用Execution Worker纵向切片，以及手机公网HTTP中转与完整响应式Web纵向链路已完成 |
| 设计状态 | 总体架构已按完整用户场景重写并获批准；2026-07-24进一步确认Super Admin Operations是完整产品的第11个产品与应用模块，详细身份/活动/指标/隐私设计尚未开始；Execution治理D1-D7、Product Harness D1-D8、活动Run与通用Execution Worker D1-D8均已获用户批准并迁移；Chat UI/UX视觉基线v1及4项轻量情绪层已获批准，生产前端迁移尚未完成；“Chat开发Chat”D1-D9、SD1 R1-R12、SD2 R1-R12和“Chat自开发可用门v1”8阶段节奏已获批准，SD1-A/B/C/D与SD2-A/B/C/D/E只读纵向切片已完成；下一阶段SD3必须先通过F01 Tool Operation Ledger字段级详细设计审核，SD4/F02与SD5/F05仍保留各自审核门 |
| Session 状态 | 9个能力域、74项能力、R0-R6和Phase 0-8路线已批准；Phase 0-1完成，Phase 2进行中，Phase 4-5完成纵向切片但尚未通过全部阶段故障矩阵 |
| 工程质量状态 | Q0纵向基线已建立且本地完整门通过：CI/静态质量门、统一Problem Detail、请求关联、结构化日志、基础Metrics/Trace、诊断入口、分层覆盖率、Playwright/axe、故障实验室、组合根拆分和前端Feature边界均可运行；Q02已继续提取治理纯策略/Run查询、Harness命令记录/Context查询，Q06已拆出Agent重连Hook、Workflow两类运行投影并建立8个生产按需Feature；剩余大型Application Service、持续协作Workflow、性能/人工无障碍、远端CI首次运行和生产Exporter/SLO不在已完成范围 |
| 数据状态 | Product Store Schema与18个Alembic迁移已建立；执行治理、TurnDigest、MAF Workflow Checkpoint、Product Harness、Repository Binding/Snapshot、协作协议、Context revision、StepInputProjection、Intent Set/Clarification、Runtime执行投影、受治理ToolExecution、Session标题来源和模型传输审计均为本项目新事实，没有迁移旧数据库、旧历史或旧项目配置 |
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
11. Chat概念空间已经成为共同语言入口；概念资产维护名称、边界、关系和反例，稳定产品责任、实现状态和源码行为仍由各自事实源拥有。
12. ExecutionDraft、RunSpec和HITL治理合同已经冻结并完成可运行纵向切片：ExecutionDraft是可编辑产品执行草稿，当前revision接受后才允许编译不可变RunSpec；ModelCallDraft仍是Run内某一次Provider调用。HITL Resolver按系统不可放宽下限与用户偏好两阶段解析，人工和自动推进都持久留痕。
13. Execution治理详细设计D1-D7已于2026-07-22获用户批准并实施；12个Decision Point、持久Policy revision/CAS、Evaluation/Request/Decision、一次性Grant/Consumption、ExecutionDraft/RunSpec、ModelCallDraft/Attempt和治理查询均已落地。10号迁移新增Product绑定的MAF Checkpoint；Governance Outbox、Interrupt Link与独立Worker已能恢复持续协作主Workflow的无外部Tool副作用审批安全点。
14. 超级管理员运营看护已进入稳定产品范围：Identity拥有Principal、Role/Grant和Authentication Session；Super Admin Operations拥有User Activity、Usage Aggregate、可重建跨模块运营投影和Super Admin Audit；Product Harness与Evidence继续分别拥有Work和Artifact事实。该项是目标边界，不表示代码、Schema或控制台已经实现。

### 2.2 已批准技术路线

1. 后端：Python、Microsoft Agent Framework（MAF）、FastAPI。
2. 前后端 Agent 协议：AG-UI over HTTP/SSE，不是 assistant-ui。
3. 前端：React 19、TypeScript、Vite、`@ag-ui/client`和自研UI。
4. UI基础：Tailwind CSS、Radix UI、Lucide React；Zustand只管理页面状态。
5. MAF运行状态与产品领域状态分开拥有；SQLite是已批准的Product Store实现起点，但必须验证目标架构所需保证。
6. 架构技术基线包括MAF、pi、nanobot和QwenPaw；外部Web产品主参考保留LibreChat。新增其他参考项目仍需用户批准。
7. 模型调用治理采用“MAF原生Workflow + 自定义确定性Executor”：每次调用都生成持久ModelCallDraft revision、Policy Evaluation和一次性授权；产品默认仍是人工审批，也可在系统下限内按作用域配置有界自动推进。`store=False`展示完整显式上下文，关闭MAF自动Tool循环；Provider与模型由服务端目录约束，Readable/Provider JSON同源，任何Body或路由变化都生成新版本、Hash并重新评估，放弃零发送并恢复原输入。持续协作主Workflow的Interrupt已通过Product绑定Checkpoint和Outbox支持跨进程恢复；该保证不外推旧Workflow、嵌套Workflow和Tool副作用。
8. 后端以私有`backend/config.json`作为唯一运行配置源；Provider按数组扩展并各自维护模型目录，当前配置包含火山方舟和阿里云百炼。仓库只提交脱敏示例，密钥和Base URL不进入浏览器响应或Git。

## 3. 本轮纠正与完成

- [x] 新增[项目经验与反例](./PROJECT_LESSONS.md)，建立每次回复前强制读取规则。
- [x] 持续记录31个可执行反例；覆盖Product Harness事实不能由Agent从聊天摘要猜测、不得回退系统Python、重大里程碑后必须做产品级工程收敛、禁止用“大文件先跑通、以后再整理”持续制造不可维护代码、不得把外部编码Agent非交互模式冒充受治理工具、撤回首条消息不能继续冒充Session标题、必须区分模型可见输出/Workflow采用/Product提交结果、移动端完整产品视角，以及协作协议/步骤输入和超级管理员运营看护边界。
- [x] 纠正`AGENTS.md`和`PROJECT_CONTEXT.md`中的产品身份与外部关系。
- [x] 删除稳定产品上下文里的“第一阶段/后续能力/非上位系统”式范围定义。
- [x] 在`agent_knowledge/project-studies`新增pi、nanobot架构与模块源码研究，补齐QwenPaw Web/Channel入口拓扑和LibreChat源码模块拓扑、责任与缺口。
- [x] 重写[总体架构研究](./docs/overall-architecture-research.md)，按固定提交还原pi、nanobot、QwenPaw、LibreChat真实模块，再逐项执行“源码事实→Chat问题→模块决策”。
- [x] 重写并批准[总体架构基线](./docs/overall-architecture-proposal.md)：
  - 取消“数据/知识/执行/交付平面”等自创分类；补正为Web/API Adapter、具体Channel Adapter、Channel Adapter Host、Interaction Ingress、11个产品与应用模块、MAF与基础设施适配器。
  - 每个模块定义参考来源、存在原因、用户价值、内部组件、状态、合同、不变量、失败和测试责任。
  - 定义FastAPI API、Execution Worker、Scheduler/Reconciler、Delivery Worker、Projector进程角色。
  - 定义状态所有权、ID链、事件合同、关键状态机和4个提交门。
  - 用9个用户场景逐步映射组件、合同、状态、失败和用户结果，其中分别展开Web、OPC-OS Bridge、Telegram Adapter和Super Admin Operations路径。
  - 只在文档最后给出交付阶段。
- [x] 新增[架构新手导读](./docs/architecture-beginner-guide.md)：
  - 区分前端交互对象、协议对象、产品领域对象和MAF/Worker运行时对象。
  - 逐项解释前端8个区域、后端核心对象、MAF Agent 10个内部部件及Agent外的Workflow、AG-UI与产品控制。
  - 用“整理Session计划并审核后写文档”的20步场景串起对象创建、版本、审批、执行、证据、交付和失败恢复。
  - 补充“发送→审批→Provider→响应解析→产品提交→React渲染”的完整时序，解释Agent内外两类Session/Tool责任、5类逻辑Store及当前代码与目标架构差距。
- [x] 重写`PROJECT_PLAN.md`，按11条工作流、依赖图和9个交付阶段映射目标架构。
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
- [x] 建立Chat概念空间：保留OPS-OS方法来源，新增目录治理、全局/Chat索引、14个高风险概念簇和结构/链接校验；概念状态与实现状态分开，Session、Workflow、Agent/Executor、恢复动作、模型审批、Tool、知识结果、界面、外部入口、人工介入、连续协作和超级管理员运营看护均有唯一语义边界。
- [x] 完成首轮界面概念一致性修正和 Workflow Run 工作台：顶部不再把对话、Workflow、Agent、Tool误画成同级页面，统一为聊天工作区与配置中心；桌面会话侧栏可完全折叠且会话列表独立滚动，Chat Pane与右侧Workbench并行，窄屏使用覆盖式工作台；聊天发送前明确显示Workflow选择。设计者工作台可按真实代码展开为4个运行层、12个代码阶段，并明确只有`ModelCallApprovalExecutor`是MAF图节点；阶段状态由持久`workflow.stage` Trace实时投影，关闭工作台不取消运行。演示Workflow和工具Workflow仍可在配置中心目录独立运行。
- [x] Workflow节点内容现可点击查看：同一Product Trace按稳定`executor_id`关联公开输入、公开输出、运行事实和源码入口；可读Key-Value视图不展示隐藏推理，也不拿Provider JSON冒充节点内容。发送前可选择的Workflow目录已从静态单项改为后端注册表驱动，AG-UI Client按所选Definition端点运行且Resume保持原端点。
- [x] 完成三方成语接龙多Agent Workflow：`输入校验Executor -> 接龙Agent甲 -> 确定性交接Executor -> 接龙Agent乙 -> 结果Executor`共5个真实MAF节点；用户和两个Agent按同字四字成语规则轮流接龙，两次Provider调用分别生成Draft/Hash/Approval，Agent Profile可在配置中心查看编辑。
- [x] 成语接龙自动化覆盖完整两次审批、连续两轮、用户接错上一轮末字、Agent输出不合规则、第一位Agent放弃零发送、第二位Agent放弃仅1次发送及无假Assistant成功；真实浏览器使用火山方舟`glm-5.2`得到“一心一意 -> 意气风发 -> 发扬光大”，5/5节点完成，两个审批载荷和节点公开内容均可查看。
- [x] 完成执行治理D1-D7迁移与服务：12个Decision Point目录、系统下限/产品默认/用户作用域策略、结构化Conditional、不可变Policy revision与CAS激活、Evaluation/Request/Decision/Grant/Consumption、ExecutionDraft/RunSpec、ModelCallDraft/Attempt、TurnSummary及安全治理查询均进入Product Store。
- [x] 完成配置中心“人工介入”矩阵：同一作用域下显示12行本层设置、继承来源、最终动作、条件和重新暂停原因；当前支持我的默认、Web、当前Session、当前Workflow和只读系统规则，短生命周期Run/Interaction配置仍待运行工作台入口。
- [x] “持续协作主 Workflow”成为唯一发送前可选根Workflow：v1.5.0的31个真实MAF节点覆盖输入接纳、主题摘要候选召回、Product Harness阶段A目录、两级Context revision投影、Context/Intent Set/Project/Plan决策、阶段B工作集与Repository规则采用、协作协议解析、确定性Project目录查询、ExecutionDraft、授权后RunSpec编译、协作响应、回合主题提取、Work/Memory候选治理提交和Product提交；简单问答、可回答澄清、明确Project查询护栏、多Intent组合Plan、修改意图、模型自动推进、放弃零发送、Repository Source失效零发送和跨回合开放问题/项目摘要复用均有自动化场景。
- [x] 主Workflow工作台可点击查看同一节点的公开输入/输出、Trace事实及持久治理事实；ExecutionDraft、RunSpec、Policy Evaluation、Human Decision Request、ModelCallDraft revision/Attempt和TurnSummary均按稳定节点ID关联，不展示隐藏推理。
- [x] 主Workflow设计者视图已补齐可解释控制流并升级为思维导图式拓扑：系统执行链明确区分前端、Product、Worker、MAF与最终呈现；真实Definition节点、选择前路径、`scenario_router`的4条MAF SwitchCase候选边和选中分支后续在同一可缩放视图中呈现。边上显示声明顺序、公开条件、实际值、选中目标和未走原因；点击任一图节点可查看同一`executor_id`的公开内容与治理事实，当前34节点完整台账按需展开。节点结果默认展开，实际步骤输入、公开输入、运行事实和治理事实按需展开；布局分组明确不是额外MAF节点，旧Run仍只按已保存最终分支兼容显示，不伪造逐项历史求值。
- [x] Chat Harness阶段A已完成：7套内置协作协议以不可变Definition revision和Work→Project→User→System优先级Binding解析；ContextPackage支持采用、排除、锁定、文字修订、Token预算、revision/CAS及旧Draft授权失效；TurnDigest v1保留来源和候选而不把模型文字升级成事实；StepInputProjection为每个真实节点保存最小工作包、能力、预算、输出合同、停止条件和Hash。
- [x] 前端完成协议配置与本轮信息渐进披露：第一层展示方法、来源、数量和预算，第二层展开阶段、规则和Context来源，第三层再展示revision/hash、实际步骤输入、Trace和治理事实；界面命令只创建服务端revision，不直接覆盖权威状态。
- [x] 主Workflow真实浏览器回合使用火山方舟`glm-5.2`完成3次逐次模型审批：意图识别、回答和回合摘要均发送成功，主链按`ExecutionDraft -> 授权 -> RunSpec -> 响应`推进，Draft终态`accepted`、RunSpec为`bound`、3个Provider Attempt为`completed`；宽屏/窄屏无横向溢出且控制台0错误。
- [x] 修复“澄清问题被塞进意图审批卡但无法回答”：`clarify`不再创建可接受的Intent绑定请求，而是提交Assistant澄清问题并回到可用聊天输入；TurnSummary标记未回答问题，下一轮即使短回答也会优先带回。明确的“我有哪些项目/我想查看现有项目列表”由确定性护栏路由到`project_catalog_query`，只返回正式Project空目录和对话候选，不触发新建分支或协作响应Agent。
- [x] 真实浏览器完成“明确Project查询”和“含糊输入→下方输入回答→Project查询”两条回合：每次仅审批真实意图模型请求，后续均进入确定性目录节点；澄清输入框可用、前一开放问题进入下一次Provider请求、没有第二张意图审批卡或额外响应模型调用，21节点工作台投影正确，页面无横向溢出且控制台0错误。
- [x] 完成持续协作主Workflow的Product DB Checkpoint与跨进程HITL接合：Checkpoint绑定Product Run/Attempt、Definition/version、图签名和MAF request；进程丢失后从安全点恢复，不重跑前置Executor，图版本不兼容时失败关闭。
- [x] 完成Lease型Governance Outbox Worker：决定与Outbox同事务提交，Worker不持有数据库事务调用Runtime，支持竞争领取、退避、8次死信和独立进程部署入口；实际`spawn`的新OS进程完成一次决定到下一审批的恢复。
- [x] 完成ExecutionDraft 17部分完整编辑工作台：固定Key、递归类型化Value编辑、CAS冲突、保存新revision/Hash和强制重新审批；真实浏览器修改revision 1为2后完成3次真实模型审批，5个Interrupt全部恢复且Run成功。
- [x] Product Harness D1-D8于2026-07-23获用户批准并完成迁移：Project、WorkItem、TaskPlan/PlanNode、ActionItem、Note/NoteRevision、MemoryCandidate/AcceptedMemory/MemoryRevision、显式关联、ContextPackage/Adoption、命令幂等、CAS、Trace与Outbox均进入Product Store；Note失效会传播到关联Memory和候选。
- [x] Product Harness REST与主Workflow完成接合：阶段A读取权威Project轻量目录，阶段B只加载已绑定Project的Work/Plan/Action/Note/Accepted Memory；已批准Work/Memory候选才会经幂等产品事务提交，简单问答不会创建长期资源。
- [x] 前端新增Project Explorer、Work Board、Knowledge和Context Inspector四个Workbench视图；项目、工作、笔记、记忆候选、上下文采用/排除及持久HITL请求均从服务端权威资源投影。
- [x] 完成21天32轮开发与28天40轮学习长测：覆盖3个Session、Web/Telegram入口标记、API进程重开、Plan CAS、假完成拦截、Evidence、幂等、Note三版纠正、Memory拒绝后接受、来源失效和Context Token预算；本地权威事实、Trace与Outbox数量一致。
- [x] 完成3天混合焦点长场景：7轮跨5个Product Session并重建API/数据库连接，依次学习FastAPI、切换书签API、回到学习、次日续学、第三天新建背单词CLI、查询Project并再次续学；3个Project工作集持续隔离，14条原始消息不被无脑拼入Context。
- [x] 活动Run与通用Execution Worker D1-D8于2026-07-23获用户批准并完成12号迁移：全部AG-UI入口改为入队/Worker/Journal订阅；Runtime Job与Attempt一对一，Lease Epoch保护事件和终态，取消与Checkpoint Resume进入持久Control Command。
- [x] 前端支持活动Job的Sequence/Hash回放、缺口关闭失败、新Segment清除旧Interrupt、Cursor过期回退Product Hydrate，并在设计者工作台展示Product Run、AG-UI Run、Attempt、Runtime Job、Worker/Lease和事件Sequence。
- [x] 完成产品级工程审计并建立16项详细Todo：7项工程安全底座与9项产品能力分别写明用户场景、目标、方案级做法、验证和完成门；审计确认当前42个后端模块无循环依赖，但核心服务/组合根过载，且CI、Lint、Python静态类型、覆盖率、自动浏览器E2E、统一错误合同和全链路可观测性尚未建立。该结论只登记整改，不表示Q0重构已经批准或完成。
- [x] 2026-07-24按用户审核把“谁登录、使用时长、工作与作品进度”固定为超级管理员能力；总体架构、研究证据、概念空间、计划和Todo均明确4类时间指标、权威事实归属、专用REST查询、最小披露和管理员审计。本轮没有提前创建正式Schema或代码。
- [x] 2026-07-23用户批准Q0工程安全底座，实施顺序固定为`Q01质量门 -> Q03错误合同 -> Q04可观测性 -> Q02无行为拆分 -> Q05自动产品测试`，Q06前端Feature与Q07文档/依赖治理贯穿推进；该批准不允许改变现有产品状态机、Schema、Workflow节点、AG-UI事件、审批Hash或Provider Payload。
- [x] 完成Q0首个可运行纵向基线：应用Factory/Composition/Lifecycle/Router/DTO拆分保持OpenAPI、Product Schema和Workflow Catalog指纹不变；统一Problem Detail、请求关联、结构化日志、OpenTelemetry基础Span/Metrics、Liveness/Readiness/时间线/诊断入口、前端统一API Client与7个Feature API边界均已落地。
- [x] 建立可重复验证门：Ruff、Pyright、Biome、Python/前端覆盖率、Alembic完整升降、42个前端逻辑/合同测试、Playwright桌面与Pixel 5、axe、10项故障实验、密钥/许可证/漏洞/文档校验和GitHub Actions；Q02大型聚合拆分、Q06大型组件/性能/人工可访问性及远端CI首次运行继续保留为未完成项。
- [x] 完成Q02/Q06第二批无行为收敛：持续协作主Workflow把Graph Factory改为依赖注入的独立模块，治理Catalog/默认策略与Harness状态机/公开投影成为纯合同模块；前端`App.tsx`把顶部栏、会话推拉侧栏、消息气泡和输入区拆为Feature组件，`model-call-review.tsx`把结构化Key/Value、Tool和模型参数编辑器拆到独立Feature。事务仍由原Application Service持有，模型审批草稿/Hash状态仍由原容器持有，MAF节点ID、审批Hash、AG-UI事件和用户可见语义未变。
- [x] 完成Q02/Q06第三批无行为收敛并固化[工程编码与模块设计规范](./docs/engineering-standards.md)：Governance拆出错误合同、纯Policy DSL和只读Run治理查询，Harness拆出调用方事务内命令记录器与两阶段Context查询；架构测试禁止Query写库、协作者擅自提交事务或前端协调器职责回流。前端把AG-UI活动Run重连从主Agent Hook拆出，把Workflow代码阶段、MAF节点和治理内容投影分开，并把对话呈现从`App.tsx`移出。
- [x] 根据Chat愿景与Codex/Claude Code限定调研扩充[工程编码与模块设计规范](./docs/engineering-standards.md)：增加产品协议/权威状态/运行投影分离、有界Context、步骤级最小执行工作包、确定性代码与Agent/Skill/Tool/Hook分工、合同失效和场景驱动设计门；没有引入多套公司规范或新平台样板。
- [x] 完成待审核的[Chat愿景方案与完整场景模拟验证](./docs/chat-vision-scenario-validation.md)：用12个端到端场景和24个异常场景穿透项目、任务、学习、周期资讯、研究、用户标准、多Intent、pi执行、HITL看护、验证修复、并发和恢复；推导出协作协议、协议绑定、步骤输入投影、周期Schedule及验证修复合同等9项待审核决定，尚未据此创建正式Schema或代码。
- [x] 完成Chat最终愿景与落地研究收敛：`PROJECT_CONTEXT.md`已明确用户眼中的统一持续协作入口、设计者眼中的产品事实/受治理Workflow/有界执行层，以及Product Session不等于Project、Context面板不构成第二事实源；[研究文档](./docs/chat-collaboration-system-research.md)按证据等级核对项目/流动/学习/笔记方法、MAF安装版、固定参考源码、Codex、SQLite/FTS5和摘要检索边界。
- [x] 愿景验证新增5组可复核逐状态桌面推演：每一步固定前置状态、读取、模型/Tool、提交差异、用户可见结果和不变量，并用“Project目录查询、四天学习/项目切换、同名Context选择、pi失败恢复、多Intent来源失效/并发”反推5项方案修正；这是待审核设计证据，不是新功能已实现声明。
- [x] 建立生产代码分割回归门：Workflow Run、Harness、ExecutionDraft/HITL相关配置、Agent、Tool和两类审批共8个Feature按真实打开时机加载；Vite manifest验证主入口450.2 KiB、单Feature与CSS预算，原约594 kB单包警告已消除。
- [x] 补齐关键结构化日志：HITL策略激活、ExecutionDraft/RunSpec、ModelCall注册与Attempt、TurnSummary、Harness命令暂存和两阶段Context只记录关联ID、状态与计数；不记录Prompt、知识正文、Provider Body或隐藏推理。
- [x] 建立Kimi Code CLI个人Codex Skill与项目运行手册：本机`0.29.0`匹配Tag源码完成命令、Session、`stream-json`和ACP权限边界核验；非交互审查通过显式只读Tool Allowlist，真实回合正确读取项目文件并返回可恢复Session ID。该完成项是开发辅助工具，不表示Chat产品Kimi ACP Adapter或其内部逐次Provider Payload审批已实现。
- [x] 使用Kimi Code CLI只读审查并完成首轮前端可读性与Workflow工作台交互优化：所有显式可见字号建立11px下限合同；设计者工作台按实际Workflow显示标题，当前保留26个真实节点并支持渐进式详情、收起内容和定位当前节点；371px窄屏显示“返回对话”，关闭后焦点恢复到Chat入口。既有桌面与Pixel 5共7项Playwright通过。
- [x] 修复Session定位与全链路模型审计：侧栏、聊天标题和设置显示`PS-XXXXXXXX`并可复制完整Product Session ID；自动标题绑定来源Message并在撤回后回滚。Provider Attempt持久保存有序发送/接收/解码事件、HTTP与Provider ID、首字节、用量、脱敏元数据、可见输出文本/Hash及采用去向；节点详情可直接查看，进程JSONL日志按Session、Run、Attempt、Workflow与Executor关联，高频只读轮询降为DEBUG。
- [x] 完成阶段B首个多Intent纵向切片：新增Intent Set/Intent不可变revision、最多4个有序目标、依赖校验、CAS接受和跨Run Clarification；主Workflow升级为v1.4.0/28节点并强制多目标进入组合Plan。多目标中的权威Project目录事实由确定性Product查询先完成，再以只读事实交给Planner/Response，不重复规划不存在的Tool调用。
- [x] 修复多Intent运行中的3个集成缺陷：内置Agent Profile旧revision精确迁移到新结构且不覆盖用户编辑；新Product Run清除线程级MAF Workflow缓存，避免错误复用旧Checkpoint；Project目录终结分支只在单Intent时生效，多Intent继续进入规划。协作协议保留基础Definition/Hash，同时用可审计`composition_overlay`公开本轮实际启用的Planner策略。
- [x] 前端“本轮”工作台已区分基础协作方法与本轮有效组合策略：多目标卡片先解释为什么仍需组合Plan，方法卡展示“基础不需要规划/本轮必须形成组合计划”，展开后再看阶段和规则；可读投影直接来自`collaboration_protocol_resolver`的持久StepInputProjection，不从卡片数量猜测运行事实。
- [x] 完成手机访问HTTP验证阶段：手机主导航可以进入对话、Workflow运行与节点内容、Harness资源和配置中心；全部前端API统一支持同源或`/chat-api`前缀，`/chat/`子路径生产构建、Manifest和图标已验证；Product Session本机草稿按会话隔离，离线可编辑但禁止发送，活动Run网络重连采用有界退避。云服务器Nginx现以Basic Auth保护`/chat/`和`/chat-api/`，反向SSH只把本地`127.0.0.1:8030`送到云端回环`127.0.0.1:4620`，本地后端与Relay由两个LaunchAgent常驻；不可变发布、配置备份、断线与后端退出自动恢复、既有服务回归和390×844真实模型回合均已验证。公网IP纯HTTP仍不能注册标准PWA Service Worker，且Basic Auth不是正式Product Identity；TLS和正式身份认证尚未实现。
- [x] 完成[Chat开发Chat自举详细设计](./docs/chat-self-development-design.md)与第一轮自检：从19个正常、拒绝、并发、恢复和安全场景反推单一根Workflow、Repository Binding、隔离Execution Workspace、同一Product Run下的pi Tool Execution、Context/RunSpec装配、Tool Operation和Evidence提交门；定义8层测试、8个浏览器端到端场景、真实Chat仓库Dogfood、4天长场景和SD0-SD6交付节奏。设计纠正了“pi不知道AGENTS”“pi是子Product Run”“直接修改活动仓库”“Tool统计等于副作用账本”“嵌套Workflow自然恢复pi”“测试通过等于Work完成”6个错误候选；该完成项只表示设计与自检已经形成，不表示Schema、迁移或功能代码已存在。
- [x] 2026-07-24用户批准“Chat开发Chat”D1-D9：Chat自身使用普通Project加Repository Binding；Git/文件系统拥有代码事实；主Workflow以确定性Dispatch调用同一Product Run下的pi Tool；写入默认使用受管worktree；F01前只读；Chat显式编译Harness事实；确定性Validator优先；commit/push/deploy分别授权；F05前不承诺pi持久恢复。批准时关于“pi自动加载AGENTS”的初始假设已由SD2源码核对纠正：实际执行关闭隐式Context发现，只传递已治理的Context/StepInput。当前批准不冻结后续写入字段、迁移和API，也不提前开放写Tool。
- [x] 2026-07-24完成[SD1 Repository Binding/Snapshot模块详细设计](./docs/repository-resource-detailed-design.md)：固定Workspace Root Catalog、Binding/Snapshot Schema候选、三态状态机、只读Git Inspector、治理文档Manifest、Context Source新鲜度门、两段式事务、REST、响应式UI、日志/Trace和7层测试；自检纠正“仓库已不可用却沿用最近成功Hash”等6个错误候选。该条只表示审核材料已经形成，R1-R12批准前不创建迁移或生产代码。
- [x] 2026-07-24用户批准SD1 R1-R12，允许按SD1-A/B/C/D实施只读Repository资源纵向闭环；该批准不因此开放pi源码读取、文件写入、worktree、commit、push、deploy或Evidence完成声明。
- [x] 2026-07-24完成SD1-A：实现Workspace Root Catalog、路径安全、固定只读Git Inspector、
  Repository Binding/不可变Snapshot Schema与线性迁移、两段式Application Service、双CAS、
  Command/Trace/Outbox原子提交和Root身份对账。真实Git异常矩阵、内存/持久SQLite 8路并发、
  Alembic全升降与漂移检查、全量后端200项、前端65项合同测试、生产构建及当前Chat仓库只读
  Dogfood均通过；真实仓库检查前后HEAD、index和status指纹一致。该完成项不包含REST、UI、
  Context采用、Provider发送前新鲜度门或任何写能力。
- [x] 2026-07-24完成SD1-B：新增安全Root/目录浏览、Repository Binding查询与
  bind/refresh/rebind/detach REST合同，Project资源卡、历史基线详情、桌面Modal与手机Sheet；
  浏览器只提交Root Key和相对路径，绝对路径不进入DTO或响应。前端按Feature拆出Project Explorer、
  Repository API和对话框，绑定命令回写Project/Binding CAS版本，同一Binding操作互斥。专项API、
  前端合同和桌面/Pixel 5完整生命周期均通过；E2E进一步发现并修复工作台层叠上下文遮挡对话框、
  刷新与重绑竞态，以及对话框先打开、Root目录后返回时的迟到投影恢复。最终完整门为后端
  204项/78.41%覆盖率、前端66项/61.24%语句覆盖率、
  Playwright桌面与Pixel 5共13项通过且3项按设计跳过；Alembic全升降、OpenAPI指纹、生产构建和
  Bundle预算均通过。Repository样式已进入Harness懒加载Chunk，避免把Feature成本写回全局入口。
  该完成项仍不把Snapshot或治理文档加入Context，不发送给模型，也没有任何Repository写入、
  pi执行、worktree、commit、push、deploy或Evidence完成声明。
- [x] 2026-07-24完成SD1-C：Repository Context Contributor把阶段A轻量目录和阶段B
  Snapshot/治理规则作为有来源、版本、采用原因的Context项；治理正文只允许固定清单，默认最多
  2份且总量受32 KiB约束，超限先显示Manifest并由用户选择后在事务外核对Hash、再生成不可变
  Context revision。持续协作主Workflow升级到v1.5.0/31节点，用户审核后的目录/详情revision均有
  独立投影节点；用户在目录Context决定点修改或跳过时先生成新的不可变revision，后续投影不会
  把旧来源重新装回。ModelCallDraft准备、审批和Provider Dispatch前均执行Source Freshness Guard。
  Binding代次/位置、最新Snapshot可用性或Semantic Hash任一失配时，Run以
  `context_source_stale`可恢复失败，旧授权失效且Provider Attempt保持0；相同Semantic Hash的重复
  Snapshot仍可继续。可读模型审批与Provider请求由同一任务内容派生，前端本轮信息与审批页公开
  来源类别、版本、采用原因和实际文字，并提供“按最新仓库重新准备”。全量后端211项/
  78.59%覆盖率、前端67项/61.26%语句覆盖率、桌面与Pixel 5共15项Playwright通过且3项按设计
  跳过；浏览器测试真实发现并修复手机Context卡片Flex收缩覆盖编辑按钮。该阶段仍不读取任意源码、
  不采用秘密文件、不写Repository，也不开放pi、worktree、commit、push、deploy或Evidence完成。
- [x] 2026-07-24完成SD1-D真实只读Dogfood与阶段收口：Chat自身作为普通Project绑定真实仓库，
  3个独立Product Session恢复同一Project/Binding；最终Product Run
  `d6d67699-3abd-48f8-b000-31befab7c602`经3次逐次审批成功回答当前阶段、Work、HEAD、工作树
  变更数量、规则和下一步，Runtime Job/Checkpoint/Outbox/Attempt均收敛且没有Work/Memory候选。
  同一Run前后Snapshot sequence 3/4的HEAD、Semantic Hash、Worktree Fingerprint和
  `change_count=129`完全一致。真实回合发现并修复Context预算阻塞、健康投影路径泄露、Summary重复
  治理正文和只读请求仍产生写回候选4类问题；Summary估算由约12,574 Tokens降至约2,556，最终回归
  约1,827 Tokens。完整门为后端215项/78.87%、前端67项、桌面与Pixel 5共15项Playwright通过且
  3项按设计跳过，迁移、静态检查、构建、包体、漏洞和许可证门全部通过。SD1保证与不保证边界见
  [Repository详细设计15.5-15.6节](./docs/repository-resource-detailed-design.md#155-sd1已兑现保证)。
- [x] 2026-07-24完成[SD2受治理pi只读执行详细设计](./docs/pi-readonly-execution-detailed-design.md)：
  基于安装版MAF 1.11.0/AG-UI rc8、pi固定源码和现有Runtime Journal事实，固定3个候选真实MAF节点、
  根图与pi子活动两层工作台、Chat-owned只读Tool Gateway、ExecutionDraft/RunSpec/StepInput、
  ToolExecution/Result状态机、HITL矩阵、故障恢复和9层测试。源码审查发现并纠正“pi内部活动伪装
  MAF节点”“Checkpoint自然恢复pi进程”“内置Tool加cwd检查足够”“agent_end等于成功”等8个危险
  假设；另提出关闭pi祖先规则自动发现、改由Chat显式装入已Hash治理规则的D6实现修正。
- [x] 2026-07-25用户批准SD2 R1-R12与SD2-A至E实施，并批准
  [“Chat自开发可用门v1”8阶段节奏](./docs/chat-self-development-design.md#102-已批准的chat自开发可用门-v1交付节奏)。
  本批准不越过F01、F02、F05的字段级详细设计门，也不授权SD2写文件、执行Shell或声明Work完成。
- [x] 2026-07-25完成SD2受治理pi只读执行：持续协作主Workflow升级为v1.6.0/34个真实MAF节点，
  根据已批准RunSpec显式选择`pi_readonly`或`answer_only`；同一Product Run内的pi只读
  ToolExecution绑定Run Attempt、Runtime Job、StepInput和Repository Snapshot。Chat-owned
  `read/grep/find/ls`逐次重验路径与快照，pi禁用内置Tool、Context File发现、Session和自动重试；
  每次模型调用继续生成持久治理记录和可编辑审批。设计者工作台可点击节点查看权威结果、模型/Tool
  子活动、Token/耗时与审计索引，明确子活动不是伪造的MAF节点。
- [x] SD2真实模型Dogfood使用Chat仓库完成1次成功Product Run：2次真实模型审批、2次Chat-owned
  `read`、41,936输入Token、2,061输出Token、45,446ms，最终只读取`README.md`和
  `PROJECT_STATE.md`；ToolExecution、Provider Attempt、Product Run与最终消息均成功，运行前后
  未产生Shell、写文件或Git操作。真实排障同时固定DashScope的system-role/Thinking预算兼容、
  Chat Completions的assistant tool_calls/tool消息校验，以及8MiB JSONL RPC读取上限。

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

1. 当前工作区后端239项全量测试通过，总覆盖率79.12%，覆盖18次迁移、审批合同、双协议、Session恢复/并发/Retry/取消、治理策略、34节点主Workflow、协作协议/Context revision/Repository Source Freshness/StepInputProjection/TurnDigest、Intent Set/Clarification、Product Harness完整生命周期、Repository Context预算与只读写回抑制、SD2只读Tool路径/符号链接/Protected Source/结果预算/失败/放弃/路由、长跨度场景、ExecutionDraft revision/CAS、Checkpoint/Outbox跨进程恢复、Provider传输审计、Runtime双OS进程领取/Lease/Cursor/取消/断线/并发对账/终态修复，以及手机云端中转的回环绑定、访问控制、流式代理和项目虚拟环境部署合同。
2. 前端68个逻辑/合同测试、Biome、类型检查和生产构建通过；字号合同禁止低于11px的显式可见字号，覆盖统一错误、Feature API、ExecutionDraft、协议/Context/Harness/HITL、Repository来源呈现与载入、多Intent方法投影、Runtime事件、Session定位码、Workflow路由/节点内部活动/权威ToolExecution结果、跨部署路径、HTTP浏览器ID兼容、重连退避和本机草稿。当前生产构建主入口473.22 KiB，按需Feature边界保持有效。
3. 浏览器完成ExecutionDraft完整工作台真实回合：修改执行摘要和Scope后由revision 1生成revision 2及新Hash，重新授权后3次火山方舟`glm-5.2`调用均完成，5个Interrupt全部为resumed、22个Checkpoint可审计、Product Run成功且TurnSummary保持candidate；520px最小视口无横向溢出，控制台0错误。
4. 火山方舟Responses与阿里云百炼Chat Completions各完成1次真实模型审批回合；后者核对最终Body仅含`model/messages/tools/store/stream`并返回预期文本。
5. 清理脚本已验证可分别终止端口8030的Uvicorn和5073的Vite，清理后无监听残留。
6. 概念空间结构校验通过：14个概念簇、17个目录文档和136个本地链接均可发现且无断链；101份项目Markdown和274个本地链接通过治理校验，`git diff --check`纳入提交前验证。
7. 2026-07-23真实浏览器用火山方舟`glm-5.2`完成Product Harness接合后的3次逐次模型审批；25个节点完成，结果为`HARNESS_REAL_MODEL_OK`，且正式Project、Work、Note、Memory前后均为0，控制台0错误。桌面推拉侧栏和780 CSS像素窄屏抽屉均完成展开/收起验证。
8. 2026-07-23新增3天混合焦点长场景：7轮跨5个Product Session、1次后端服务与数据库连接重建（模拟API进程重启），依次推进FastAPI学习、切换书签API、回到学习、次日续学、第三天新建背单词CLI、查询全部Project并再次续学；3个Project及其Work/Action/Note/Memory持续独立，9份ContextPackage证明Stage A只取轻量目录、Stage B只装配被选Project，14条原始消息未被无脑塞入Context。
9. 2026-07-23完成Runtime真实Provider断线验证：审批后批准，在新Segment首个`RUN_STARTED`后主动关闭订阅；同一Runtime Job继续完成并可回放连续57条Journal事件，只有1条终态，Product Run、Runtime Job和Provider Attempt均为成功，Provider没有因重连创建第二个Attempt。
10. Runtime专项10项测试覆盖8 Worker竞争、两个OS进程唯一领取、旧Epoch拒写、双Reconciler竞争、空闲Worker心跳、断线后台继续、Cursor回放、外发前/运行中取消、Lease过期和Product/Runtime终态修复；浏览器确认新工作台字段、Workflow节点和审批界面正常且控制台0错误，浏览器验证Run已放弃并保持零Provider发送。
11. 2026-07-23 本轮Q0收敛完成本地全量验证：后端114项及76.34%总覆盖率、前端42项及行57.24%/分支67.53%/函数77.31%覆盖率、12次迁移完整升降、10项故障实验、桌面与Pixel 5共5项Playwright/axe通过且1项桌面专属检查在移动项目按设计跳过；概念空间11个概念簇/109个链接、86份项目Markdown/215个本地链接、生产包体、密钥扫描、Python/npm漏洞与许可证门和`git diff --check`均通过。
12. 2026-07-23真实浏览器完成模型审计纵向回合：Product Session `PS-CDE5083F`、Product Run `48d3f48e-906f-4852-a8f7-2102fa6a289c`经3次逐次审批得到`MODEL_AUDIT_E2E_OK`；3个真实火山方舟Attempt均保存HTTP 200、Provider请求/响应ID、首字节、Token用量、可见输出Hash和`accepted_as_intent/response/summary`去向。独立Project目录查询Run `c352573a-3d0c-43d3-a863-d7716a6fca5b`验证模型调用数为0。
13. 2026-07-23浏览器以Product Session `PS-5FD84B57`、Product Run `27253126-38dc-4ef4-99d5-03e7e36d1179`验证可解释分支：输入“我有哪些项目？”命中`project_catalog`第1条Case，目标为`project_catalog_query`，其余3条边逐项显示未走原因，Provider模型调用数为0；桌面与窄屏无工作台横向溢出。
14. 同一Product Run已验证思维导图式运行视图：9个选择前节点、真实`scenario_router`、4条候选边和6个选中分支后续节点来自同一Definition与Trace；点击“查询正式Project目录”后详情切换到对应`executor_id`的公开输入、输出和Sequence 35运行事实。桌面与移动Playwright共7项通过、1项桌面专属axe在移动项目按设计跳过，浏览器控制台0错误。
15. 2026-07-24浏览器以Product Session `PS-A61F8C51`、Product Run `23de8b35-9031-46e7-887f-549b9b329548`完成阶段A真实模型纵向回合：意图、协作响应和TurnDigest三次火山方舟`glm-5.2`调用逐次暂停、逐次审批，3个Provider Attempt均HTTP 200并分别记录603、845、489 Tokens；Run完成26节点，协议为`simple-answer@r1`，正式Project、Work、Accepted Memory及Memory Candidate均为0。
16. 同日浏览器以Product Session `PS-8EA295AE`验证“我有哪些项目？只查看正式列表，不要创建任何事项。”：否定创建约束不会再误命中创建意图，Run `ca52e679-0602-46c8-a715-a4b47792e193`由确定性护栏进入Project目录分支，模型调用数为0；工作台显示26个真实节点、4条候选边、协议选择依据和实际步骤输入。
17. 新增长跨度协议/Context验收：Day 1先做权威Project目录查询并证明模型文字只进入未验证候选，再建立学习Project、排除Note并锁定Project；Day 2切到软件交付Project且不泄漏学习Context；Day 3重建服务后回到学习并保持协议、Context和五类步骤输入隔离。
18. 2026-07-24浏览器以Product Session `PS-78979C26`、Product Run `87e4ec66-56ab-47b2-ae2b-184766719112`完成多Intent真实模型回合：2个独立目标依次完成权威Project空目录查询和斐波那契一句话解释；Intent、Planner、Response、TurnDigest共4次火山方舟`glm-5.2`调用逐次审批，28节点Run完成，未创建Project、Work、Task或长期Memory。工作台同时展示基础协议`直接回答@r1`与本轮`必须形成组合计划`的有效覆盖策略。
19. 2026-07-24用户确认连续对话流、对话日、个人主页与协作日历、灵感花园4个产品概念；目标信息架构不再以Session Sidebar作为默认用户入口。Product Session继续作为服务端交互、恢复和访问控制容器，目标主页、时间导航、每日日记和灵感花园仍处于设计阶段，不能标记为已实现。
20. 2026-07-24用户审核通过个人主页第一轮草图：固定Activity Rail、今日继续、年度协作日历、近期产物、灵感花园和本周轨迹的首页信息层级，以及Material 3 Expressive与克制工作区结合的视觉方向。连续对话/Workflow工作台与协作日历/对话日草图仍待分别审核，整套前端改造尚未获实现授权。
21. 2026-07-24用户批准[Chat UI/UX视觉基线v1](./docs/ui-ux-visual-baseline.md)：当前可交互原型作为后续生产前端的渐进改造基线，不再继续寻找单一“完美参考”。优先加入基于真实Harness状态的主页问候、关键动作反馈、公开AI运行状态和可追源协作日历4项轻量情绪层；完整主题编辑、插画系统、复杂动效、游戏化和大规模品牌重塑延后。该批准是设计与实施范围授权，不表示生产界面已经完成。
22. 2026-07-24完成[手机公网访问与云端中转运行手册](./docs/mobile-cloud-relay.md)对应的真实部署：云端`/chat/`与`/chat-api/`统一Basic Auth，本地LaunchAgent常驻后端和只绑定云端回环的反向SSH。Relay与后端分别被终止后都出现可观察短暂中断并以新PID恢复；AuditTraceAI、Mini-Claw和Nginx保持active。390×844浏览器从公网创建Product Session `PS-53F42E0E`，Intent、Response、TurnDigest三次火山方舟`glm-5.2`调用逐次审批后得到`MOBILE_RELAY_E2E_OK`，Product Run成功、Session revision为2，Project、Work和Accepted Memory均为0，控制台0错误且无横向溢出。

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
7. 旧模型审批Workflow仍依赖进程内草稿Store；持续协作主Workflow已把ModelCallDraft、Decision/Grant/Consumption、Provider Attempt、MAF Checkpoint和Interrupt Link持久化。全部在线AG-UI入口现由通用Runtime Job/Worker承载，主Workflow的REST决定由独立Outbox写Control Command并可由Execution Worker跨OS进程恢复；旧/嵌套Workflow和Tool副作用Checkpoint仍不能类推。
8. `backend/config.json`是启动时只读快照，当前包含2个Provider；修改Provider或模型目录后需要重启后端，尚未实现在线重载或Provider模型自动发现。

## 5. 尚未实现的能力

1. Session Phase 2-3的Steer、Follow-up、分支/Fork、搜索、标签、长上下文Compaction、附件、导入导出和完整资源生命周期；Retry/Restart、精确取消和主Workflow Checkpoint Resume已有独立语义。
2. Principal/真实身份Scope、Channel Binding、可独立修订的Intent，以及Context Source的权限撤销和任意来源类型全图失效传播；Product Harness基线已实现，但当前仍使用固定本地Scope。
3. Runtime纵向切片已实现，但完整阶段验收仍缺真实API/Worker强退矩阵、多标签页/换设备、事件保留清理与真实410、Delta批量写/背压、队列容量和Lease过期风暴压测；Provider/Tool精确外发边界尚未替换当前保守标记。
4. 通用Tool Operation Ledger、外部副作用幂等/结果未知/对账，以及旧/嵌套Workflow和pi Tool的持久Checkpoint恢复；主Workflow无外部Tool副作用审批安全点已恢复，pi专用执行记录仍只提供可观察终态与启动中断收敛。
5. 独立Evidence聚合、Provenance Graph、Artifact、Delivery Outbox和完整运营Trace；Work当前只接受内嵌Evidence引用，尚未形成独立证据生命周期。
6. Telegram等具体Channel Adapter合同，以及OPC-OS Chat Bridge的正式身份、能力、消息和回执合同。
7. Provider结果未知后的查询对账、补偿和人工处置。
8. 公网访问当前仍是HTTP + Basic Auth验证阶段：尚无传输加密、正式Principal/Authentication Session、多设备撤权和标准PWA安装保证；进入长期日常使用前必须迁移到HTTPS并接入正式Identity。
9. 真实Authentication Session、Super Administrator Role/Grant、User Activity Event、Usage Aggregate、Work/Artifact运营投影、Super Admin Audit和Super Admin Console；当前固定`local-user`、技术耗时、个人主页原型和诊断API都不能替代。
10. 2026-07-24用户已批准“同一Chat、多个Product Session并行推进同一Harness”为稳定产品目标。
    现有产品边界已经允许多个Session引用同一Project/Work，长场景也验证过跨Session顺序推进，部分
    资源已有revision/CAS；但跨Session活动感知、完整读取版本绑定、统一冲突Diff/rebase、来源Session
    可见性、手机/桌面并发和容量矩阵尚未实现。本轮只完成产品与交付边界升格，没有创建Schema、
    迁移或代码，不能把目标已批准外推为并发能力已经可用。
11. “Chat开发Chat”已完成SD1与SD2只读纵向闭环：用户能在Project界面管理Repository、保留不可变
    Snapshot、把有版本的代码基线/治理规则纳入可编辑Context，在Provider发送前阻断过期Source，
    并由持续协作主Workflow把已批准RunSpec和最小StepInput派发给受治理pi只读Runtime。真实Chat
    仓库、跨Product Session和真实模型Run均证明仓库没有被修改。完整自举仍未形成：目前没有隔离
    Execution Workspace和写Tool。写入必须等待F01，完成声明必须等待F02，pi跨进程持续恢复必须
    等待F05。TaskPlan PlanNode当前还是修订快照，
    实时进度权威是WorkItem/ActionItem；Plan进度投影仍归F06。

## 6. 风险和未知

1. MAF安装版与本地参考源码不是同一发布快照；具体API、事件和异常必须以安装版合同测试为准。
2. AG-UI当前为RC版本，升级可能改变事件、Snapshot和Interrupt/Resume行为。
3. AG-UI Client会发送客户端消息全集；若同时装配Product History、MAF History和Snapshot会形成重复上下文。
4. Product Finalization Gate已阻止过早`RUN_FINISHED`，并能修复Product已提交但Runtime终帧缺失的崩溃窗口；Product与Runtime终结当前仍是有序的两个事务，依赖Reconciler收敛而非宣称单事务原子完成。
5. MAF Workflow Checkpoint与Product Run、持久Decision的正式薄桥已进入主Workflow、治理API和独立Outbox Worker；安装版AG-UI RC8不转发`checkpoint_id`，当前隔离恢复桥依赖MAF私有Runner/编码API，升级必须跑版本锁定测试并优先移除私有接合。
6. SQLite已验证单Approval的8并发领取、两个Outbox Worker竞争和新OS进程接管；持续高并发、长队列、Lease过期风暴、数据库故障和容量边界仍未压测。
7. 外部Tool副作用没有通用Exactly-once；必须按工具定义幂等、查询、补偿和人工处置。
8. Intent、Work、Approval、Evidence、Delivery等主要来自本项目需求，参考项目未提供可直接复制的完整状态机。
9. OPC-OS Chat正式身份、权限、能力、消息和回执合同尚未取得。
10. 安全、容量、SLO、数据保留和灾难恢复的数值目标尚待产品审核。
11. Chat原生Channel Adapter内置部署、独立Adapter进程和由OPC-OS Chat托管渠道是3种物理选择；逻辑上均必须经过Interaction Ingress，具体采用范围待架构审核和外部合同确认。
12. 安装版`agent-framework-ag-ui==1.0.0rc8`的Workflow桥可能在关闭文本或诊断事件前产生`RUN_FINISHED`/`RUN_ERROR`；当前薄Wrapper把终态缓冲到事件流最后并有合同测试，依赖升级时必须重新验证并尽量移除兼容层。
13. 安装版MAF原生`WorkflowExecutor`不向外层观察者展开子图内部生命周期；当前`VisibleWorkflowExecutor`只做单进程嵌套事件转发且明确拒绝子级HITL，不代表Checkpoint、跨进程或R6恢复已经实现。
14. 安装版MAF `AgentExecutor`支持`full_conversation`会话传递，但会直接调用内部Agent；严格逐次审批场景使用自定义受治理Agent Executor，不能把原生Agent-as-Executor误认为已经经过产品Approval。
15. `main.py`已从726行组合根拆为Factory、Composition、Lifecycle、Router和HTTP DTO；
    `governance/service.py`为2,237行，`harness/service.py`为2,048行，持续协作Workflow提取
    Contracts/Prompts/Graph Factory后仍为2,849行，`model-call-review.tsx`为703行。它们均超过
    规模审查线；本轮新增的来源投影和写回策略已放在纯Contracts/Prompts而非继续内联，但Application
    Service、Workflow协调器和审批编辑器仍必须在后续能力叠加前按事务、状态所有权和变化原因继续拆分。
16. CI、Ruff、Pyright、Biome、分层覆盖率、Playwright/axe和故障实验室已经建立；真实多设备性能、完整容量和人工无障碍体验仍不能由这些自动门外推。
17. HTTP边界已统一为Problem Detail、稳定错误码、请求关联和脱敏异常映射；真实Principal/Scope认证、公开API版本与全部端点的字段级响应模型仍未完成。
18. 统一结构化日志、关联上下文、基础OpenTelemetry、Metrics、Liveness/Readiness、运行时间线与脱敏诊断入口已经建立；生产多实例Exporter、SLO、告警路由和长期保留尚未完成。
19. Alembic Schema漂移检查和18次迁移完整升降已通过，但SQLAlchemy仍报告执行治理表之间存在不可排序的外键环；当前SQLite迁移可运行，未来SQLAlchemy升级或迁移自动生成前必须先消除或显式设计这些约束环。
20. 超级管理员能力的登录/活跃/有效协作口径、多设备与空闲语义、默认可见字段、敏感正文额外授权、隐私告知、数据保留、审计不可篡改和运营投影容量仍待详细设计；在这些决定获批前不得用登录时间差或Run耗时拼出“用户使用时长”。

## 7. 当前开发门

1. Session Phase 1证明R0/R1文本恢复，Runtime纵向切片证明活动订阅与Worker所有权的部分R2/R3；仍不得外推为完整多设备、Tool副作用或任意Workflow/HITL恢复。
2. Workflow可视化种子只兑现运行中投影和完成Trace恢复；后续Checkpoint/HITL不得复用这份Trace冒充运行恢复。
3. 多Agent种子已验证两套显式会话传递、4个Profile Revision、逐次模型调用审批和成语接龙确定性规则；它仍不代表任意动态Agent拓扑、持久Checkpoint或并发群聊已经完成。
4. pi Agent Tool已验证官方JSONL RPC、两道治理门和真实Tool loop；它仍不代表跨进程pi Session、持久Approval、通用副作用对账或R6恢复完成。
5. 概念状态“有效”只表示语义边界可正式使用；任何功能是否实现、恢复级别和验证证据仍必须回到本文件及对应源码/测试判断。
6. 跨进程HITL只对`continuous-collaboration v1.6.0`中已建立Checkpoint/Interrupt合同且没有活动外部进程的安全点成立；活动流订阅已由通用Runtime承载，但旧/嵌套Workflow、活动pi进程、Tool副作用和通用R6仍不得类推。SD2进程重启会把`starting/running/waiting_human`的pi执行诚实收敛为`interrupted`，不会伪恢复或自动重放。
7. Product Harness D1-D8已批准并实现；后续扩展仍必须保持“模型只提候选、Decision后提交、CAS/Trace/Outbox同事务”，不得把TurnSummary直接改写成长期事实。
8. “Chat开发Chat”D1-D9、SD1 R1-R12与SD2 R1-R12已经批准，SD1-A/B/C/D与SD2-A/B/C/D/E
   只读纵向切片已完成。[SD2受治理pi只读执行详细设计](./docs/pi-readonly-execution-detailed-design.md)
   记录了实现与验证证据。SD2只覆盖受治理只读执行；SD1/SD2保证不能外推为
   Execution Workspace、写Tool、Evidence完成门、PlanNode实时进度或pi跨进程恢复。
