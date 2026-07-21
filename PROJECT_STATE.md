# OPC-OS 自研 Chat 通道：项目状态

## 1. 当前结论

| 项目 | 当前事实 |
|---|---|
| 状态 | `工程骨架与真实模型回合已完成，阶段1收尾中` |
| 当前目录 | `/Users/xulater/Code/Chat` |
| 项目层级 | OPC-OS Chat体系中的一个自研Chat通道 |
| 代码状态 | 前后端最小可运行骨架已建立 |
| Git状态 | 私有GitHub仓库`later-3/Chat`的`main`已建立；Session总体规划与总体架构材料随本次文档提交纳入`main`，内容仍等待用户审核 |
| 数据状态 | 没有迁移旧数据库、历史或环境配置 |
| 当前工作 | 总体架构候选、完整Session能力全集与Phase 0-8交付路线已形成，等待用户审核；D1-D6已降级为Phase 1持久化子设计并暂停审核；尚未创建Schema或业务实现 |

## 2. 已确认事项

1. 不在项目定义中保留历史背景章节。
2. 项目需要解决6个问题，见[项目上下文](./PROJECT_CONTEXT.md#3-要解决的6个问题)。
3. `OPC-OS Chat`是包含多种聊天通道和适配层的上位系统。
4. 本项目只是其中一个由我们自行开发的Chat通道。
5. 6个核心目标已获得用户认可。
6. 完整产品闭环基本获得用户认可。
7. 核心领域对象可作为后续建模参考，不视为已经冻结的数据库Schema。
8. 后端方向继续采用Microsoft Agent Framework（MAF）。
9. 前后端Agent交互协议是AG-UI，不是assistant-ui。
10. 2026-07-21用户批准完整技术路线。
11. 前端采用React 19、TypeScript、Vite、`@ag-ui/client`和自研UI。
12. UI基础采用Tailwind CSS、Radix UI和Lucide React；Zustand只管理页面状态。
13. 后端采用Python、MAF、FastAPI和AG-UI集成。
14. MAF运行状态与SQLite产品领域状态分开拥有。
15. Product Session、MAF AgentSession/Workflow Checkpoint、AG-UI Thread和Agent Run是4个不同对象；ID同值也不代表职责合并。
16. REST管理产品资源，AG-UI只管理一次Agent Run的实时交互；Product DB是产品事实源，MAF负责运行时语义。
17. Interaction与Agent Run不是同一个对象；一次Interaction可以触发0到多个Agent Run。
18. 外部产品参考只保留LibreChat这1个正式主参考；Flowise和其他相似平台不进入日常必查链路，新增参考仍需用户批准。
19. Session总体规划必须先于持久化详细设计：先审核完整能力、R0-R6恢复保证、阶段依赖和用户场景，再重审Phase 1的D1-D6。
20. 总体架构当前只是待审核候选；建议采用领域模块化单体、可分离Run Executor、8个产品模块和独立MAF Runtime技术模块，但尚未成为批准事实。

## 3. 本轮已完成

- [x] 创建`AGENTS.md`。
- [x] 创建`PROJECT_CONTEXT.md`。
- [x] 创建`PROJECT_PLAN.md`。
- [x] 创建`PROJECT_STATE.md`。
- [x] 创建`README.md`。
- [x] 把“完整OPC-OS Chat”和“当前自研Chat通道”分开定义。
- [x] 把技术路线未决项显式记录，避免提前锁死旧实现。
- [x] 初始化独立Git仓库、`.gitignore`和`.editorconfig`。
- [x] 初始化Python 3.12、`uv`依赖与锁文件。
- [x] 建立FastAPI健康检查和MAF AG-UI端点。
- [x] 建立无密钥可运行的确定性MAF Bootstrap Agent。
- [x] 建立React 19、TypeScript、Vite和`HttpAgent`前端。
- [x] 建立Tailwind CSS、Radix UI、Lucide React和Zustand页面基础。
- [x] 建立环境模板和一键验证脚本。
- [x] 后端3个测试通过：健康合同、ARK配置映射、AG-UI完整事件流。
- [x] 前端类型检查和生产构建通过。
- [x] 浏览器真实发送1条消息并收到MAF回复；控制台错误为0。
- [x] 窄屏检查无横向溢出。
- [x] 接入用户维护的`backend/.env`，支持`ARK_*`模型配置且不输出密钥。
- [x] 建立VS Code前端、后端和全栈调试配置。
- [x] 调试前后按端口和当前项目进程特征清理残留。
- [x] 把MAF源码、nanobot、pi和`agent_knowledge`维护责任写入协作规则。
- [x] 完成1次真实模型AG-UI文本回合：HTTP 200、82个事件、`RUN_STARTED`到`RUN_FINISHED`。
- [x] 验证清理脚本可以分别终止端口8030的Uvicorn和端口5073的Vite，清理后端口无监听残留。
- [x] 把“先研究MAF，再研究pi与nanobot，最后形成候选方案并先审核后实现”的顺序写入协作规则。
- [x] 按当前安装版本、MAF官方文档、本地源码、测试和示例完成Session能力核对。
- [x] 完成pi与nanobot的Session存储、恢复、并发和失败语义对照研究。
- [x] 形成[Session持久化研究与方案推导](./docs/session-persistence-research.md)，逐项公开MAF、pi、nanobot证据、限制、方案比较和推导链。
- [x] 形成[Session持久化候选设计](./docs/session-persistence-design.md)初稿；复核后D1、D3和D4已退回修订，未实现。
- [x] 形成[Session持久化审核包](./docs/session-persistence-review.md)，逐项补充原因、参考项目覆盖、其他选择、优缺点、建议和未验证项。
- [x] 在项目上下文中固定四对象关系以及REST、AG-UI、Product DB和MAF的所有权边界。
- [x] 把外部产品参考收敛为LibreChat这1个正式主参考，并统一协作规则。
- [x] 在固定提交`8e5ef1fb31e9d63b735c089b21cbc82c50acce46`上完成LibreChat的Conversation、Message、GenerationJob、正常终态、断连、取消、流式恢复和HITL边界研究。
- [x] 按当前安装版实测MAF `HistoryProvider`：成功提交发生在`RUN_FINISHED`前，保存异常会产生`RUN_ERROR`且不会产生`RUN_FINISHED`。
- [x] 实测`require_per_service_call_history_persistence=True`与`store=False`的两次模型调用工具循环，确认中间历史检查点、Provider响应ID抑制和终态边界。
- [x] 修订Session候选设计与审核包的D1、D3和D4，明确首阶段关闭durable Snapshot、REST恢复产品历史、唯一历史加载器和产品终态提交门。
- [x] 更新`agent_knowledge/MAF/01-Session-HistoryProvider与AG-UI-Thread-Snapshot.md`，同步当前安装版本、实测证据、四对象边界、HistoryProvider与Snapshot限制。
- [x] 在`agent_knowledge/project-studies/librechat/`建立固定提交的有界源码知识，记录Conversation/Message、Generation Job、流式恢复、失败终态、HITL、ID边界和迁移取舍。
- [x] 补充LibreChat的Conversation列表/搜索/归档/置顶/标签/临时/删除、Message树、编辑/重生成/Sibling/Fork、导入导出、分享快照和页面续接源码研究。
- [x] 将新增LibreChat生命周期与分支知识同步到`agent_knowledge/project-studies/librechat/Conversation生命周期与分支操作源码研究.md`并更新知识入口。
- [x] 形成[Session能力全集](./docs/session-capability-catalog.md)：9个能力域、74项能力、R0-R6恢复层级、参考覆盖、明确非目标和18个最终用户场景。
- [x] 形成[Session交付路线](./docs/session-delivery-roadmap.md)：Phase 0-8、53个任务、优先级、依赖、方案、目标和阶段完成场景。
- [x] 将Session持久化研究、候选设计与D1-D6审核包重新标记为Phase 1子设计证据，不再作为总体审核入口。
- [x] 完成文档交叉审计并再次运行`./scripts/verify.sh`：3个后端测试、前端类型检查和生产构建全部通过。
- [x] 按项目场景审计MAF、pi、nanobot和LibreChat的总体架构覆盖，确认无需新增第五个参考项目。
- [x] 定向补充MAF Agent、Session、Middleware、Workflow、AG-UI、Durable Task和Observability的架构位置研究，并同步到`agent_knowledge/MAF/02-Agent应用架构中的位置与边界.md`。
- [x] 定向补充LibreChat App Shell、Feature Route、Data Provider、产品Route、Agent入口、Generation Job和Event Transport研究，并同步到`agent_knowledge/project-studies/librechat/Web-Chat整体架构与模块边界源码研究.md`。
- [x] 形成[总体架构研究与证据](./docs/overall-architecture-research.md)和[总体架构候选](./docs/overall-architecture-proposal.md)，包含过程、证据、8个决策卡和7个用户场景。

## 4. 当前实施决定

1. 按已批准的新技术路线建立独立骨架，不直接复制旧FastAPI+Pi实现。
2. 当前只提交总体架构、完整Session能力与任务路线供审核，不进行详细Schema、API、类设计或业务开发。
3. 完整目标包括已完成会话恢复、活动流重连、Worker恢复、Tool恢复、Workflow/HITL恢复和跨通道连续性；阶段拆分只决定交付顺序，不代表删去后续能力。
4. 已批准的SQLite Product DB、MAF运行时、AG-UI投影和浏览器状态继续分开拥有；具体表模型、迁移/访问层、ID映射和Checkpoint存储由总体规划通过后的Phase 0/D1-D6详细审核决定。
5. 旧代码只作为产品交互、领域对象和测试反例参考；MAF、pi、nanobot与LibreChat继续按各自限定范围提供证据。
6. 总体架构当前建议领域模块化单体和可分离Run Executor；批准前不据此创建正式模块目录或重构Hello World骨架。

## 5. 当前工程事实

1. 后端：Python 3.12、FastAPI、`agent-framework-core 1.11.0`、`agent-framework-ag-ui 1.0.0rc8`、`agent-framework-openai 1.10.1`。
2. 前端：React 19、TypeScript 6、Vite 8、`@ag-ui/client 0.0.57`。
3. 传输：前端向`POST /api/agent`发起AG-UI请求，后端以SSE事件流返回运行与文本事件。
4. 无`CHAT_MODEL_API_KEY`和`ARK_API_KEY`时使用确定性MAF Agent；配置任一密钥后创建真实模型Agent。
5. `GET /api/health`只暴露安全的运行模式和架构信息，不返回密钥。
6. 当前没有产品SQLite Schema、Session列表、服务端历史恢复或长期领域对象实现。
7. 一键验证命令为`./scripts/verify.sh`，当前结果是3个后端测试、前端类型检查和生产构建全部通过。
8. 前端`npm audit`当前扫描121个依赖，0个已知漏洞。
9. 本地调试固定使用后端`8030`和前端`5073`；VS Code启动前后都会执行定向清理。
10. 后端优先加载`backend/.env`，并兼容`CHAT_MODEL_*`覆盖`ARK_*`。
11. MAF AG-UI使用安装版本支持的首选导入路径`agent_framework.ag_ui`。

## 6. 已知旧项目事实

旧`/Users/xulater/Code/opc-os/chat`可作为产品和测试参考，但不能直接代表新项目技术路线：

1. 当前旧代码前端是React 19、Vite、TypeScript、Tailwind CSS、Radix UI和Zustand。
2. 当前旧代码后端是FastAPI、Pydantic、SQLite和Pi CLI，不是MAF主线。
3. 更早的历史版本使用过MAF和AG-UI，但自研React前端主要走单独JSON接口，没有完整消费AG-UI事件流。
4. 旧项目记录过37项测试、真实Pi、迁移和浏览器证据；这些是历史快照，不能作为新项目当前验证结果。

## 7. 风险和未知

1. 如果直接复制旧代码，会把FastAPI+Pi的现状误当成MAF新路线。
2. 如果直接复制旧文档，会把“Chat Adapter”身份和过期实现假设同时带入。
3. 如果自研JSON消息流和AG-UI同时承担Agent运行协议，会形成双协议和双状态。
4. 如果没有先定义服务端历史与前端消息状态边界，容易形成双重事实源。
5. 如果第一阶段范围包含意图、计划、记忆、工具和多Agent全部能力，初始化会失去最小可验证闭环。
6. 当前MAF AG-UI包仍为RC版本，升级前必须重新验证事件合同。
7. Bootstrap Agent证明协议接通，不证明真实模型配置、质量、超时或错误映射正确。
8. 当前thread标识由前端创建，但服务端历史恢复尚未实现，不能宣称会话连续已经完成。
9. MAF本地参考源码提交与项目安装版本不完全一致；当前项目行为必须以`.venv`安装版本和实测为准，并在依赖升级后重跑合同测试。
10. MAF AG-UI的Snapshot保存是fail-soft，且当前rc8的Approval Registry仍是进程内实现；Snapshot不能充当产品提交回执，也不能据此宣称HITL可以跨进程恢复。
11. `OpenAIChatClient`默认使用Provider存储；实测`per-service history persistence + store=false`可以抑制Provider响应ID对AG-UI `threadId/runId`的替换，但正式实现仍需真实远端模型故障注入。
12. MAF实测证明`HistoryProvider`保存失败会转为`RUN_ERROR`；但per-service保存只是模型历史检查点，Product Run成功仍需外层成功终态与最终产品提交共同确认。
13. `@ag-ui/client 0.0.57`会发送客户端全量消息；若同时启用Product History和AG-UI Snapshot历史，会产生重复模型上下文，正式实现必须保持唯一历史加载器并校验、裁剪本轮增量。
14. LibreChat没有独立持久化Product Agent Run，它的GenerationJob主要是可删除的运行投影；本项目只能借鉴产品事实与流式投影分离、成功终态后置等原则，不能复制其ID合并或弱取消写入语义。
15. 真实工具故障、同Session并发、断连与取消、SQLite锁竞争、Workflow Checkpoint和rc8 Approval跨进程恢复仍未验证；它们已经进入完整路线，但只有对应Phase通过后才能承诺。
16. 当前事件顺序、双历史和per-service工具循环证据来自一次性Spike，尚未固化为仓库回归测试；服务端可信Run Context向HistoryProvider的并发隔离也仍需专项Spike。
17. 当前安装版MAF核心Workflow支持持久Checkpoint与`checkpoint_id`恢复，但`agent-framework-ag-ui 1.0.0rc8`主要以Thread Snapshot恢复消息、State和Interrupt；Product Run到持久Workflow Checkpoint的接合尚未形成已验证合同。
18. pi不提供活动Run跨进程续跑；nanobot主要通过显式中断收敛未知工具；LibreChat证明浏览器断连续传但未证明普通模型Worker崩溃后自动续跑。任何“自动恢复”都必须按R0-R6逐级验收。
19. Tool外部副作用没有通用Exactly-once保证；路线目标是幂等、回执、Evidence、结果未知时对账和人工处置。
20. 总体架构中Intent、Work、ExecutionDraft、Approval、Evidence和Delivery模块主要来自本项目产品需求，参考项目只部分覆盖；详细状态机仍需分模块审核。
21. MAF当前安装版与本地参考源码不是严格同一发布快照；总体能力边界可信，但具体Runtime Adapter和成功终态提交门仍需安装版合同测试。
22. 独立Worker、Job/Event Store、SQLite并发边界和未来存储产品均未选型；总体架构只预留端口和演进顺序。

## 8. 下一道门

当前仍在[阶段1：技术路线与工程初始化](./PROJECT_PLAN.md#4-阶段1技术路线与工程初始化)收尾，同时进入总体架构与Session总体规划审核门：

1. 用户先审核[总体架构候选](./docs/overall-architecture-proposal.md)的8项决定，并可通过[总体架构研究](./docs/overall-architecture-research.md)核对过程与证据。
2. 用户再审核[Session能力全集](./docs/session-capability-catalog.md)：9个能力域、74项能力、R0-R6恢复层级、参考覆盖和明确非目标。
3. 用户审核[Session交付路线](./docs/session-delivery-roadmap.md)：Phase 0-8、53个任务、依赖顺序、方案、目标和每阶段用户场景。
4. 总体架构与Session总体材料通过后才执行Phase 0的术语、MAF兼容合同、恢复验收矩阵和版本演进设计。
5. Phase 0通过后，再重审D1-D6这个Phase 1持久化子设计；未获批前不创建Schema、迁移、Repository或正式兼容层。
6. 与审核并行但不混入本次决策的阶段1收尾仍包括：真实模型失败/超时/错误脱敏验证，以及旧项目复用、重写和仅参考清单。
