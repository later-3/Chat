# Chat 项目计划

## 1. 计划目标

以[完整目标架构](./docs/overall-architecture-proposal.md)为边界，按依赖顺序交付一个独立运行、持续运营的 Chat 产品：从会话连续、上下文与意图，到工作推进、受控执行、运行恢复、知识证据、可靠交付、超级管理员运营看护和外部集成，最终形成完整用户闭环。

阶段只决定交付顺序和阶段验收，不能重新定义产品范围。任何阶段的 Schema、API 或代码都必须能演进到目标模块、合同和状态所有权，禁止为了短期交付建立另一套临时事实模型。

## 2. 计划原则

1. 先审核完整场景、目标架构和模块合同，再做领域详细设计。
2. 先建立权威产品事实，再让 Runtime、活动流、Worker 和外部集成消费这些事实。
3. 每个能力依次经过：研究证据 -> 方案审核 -> 详细设计 -> 实现 -> 故障验证 -> 用户场景验收。
4. MAF API 与行为先查安装版、源码和测试；产品架构不能由 MAF 类型反推。
5. Product Session、MAF Session/Checkpoint、AG-UI Thread、Product Run 和 Run Attempt 始终分开。
6. 每个阶段明确“已兑现保证”和“仍未兑现保证”，不把局部测试外推为完整恢复能力。
7. 真实模型、真实浏览器、进程故障、重复请求和外部副作用验证不能被 Mock 成功路径替代。

## 3. 目标工作流拆分

这 11 条工作流覆盖目标架构，项目经理可在阶段内进一步拆 Epic、Story 和验证任务。

| 工作流 | 主要模块/组件 | 主要交付物 | 前置依赖 | 验收结果 |
|---|---|---|---|---|
| W0 产品治理与架构 | 全局 | 产品定义、经验约束、目标架构、ADR、术语和ID合同 | 无 | 4类读者能用文档继续决策、排期和开发 |
| W1 工程与合同基础 | Bootstrap、Interfaces、测试基础 | 可运行前后端、配置、OpenAPI/AG-UI合同、错误分类、CI/本地验证 | W0技术路线 | 真实MAF回合和合同测试稳定 |
| W2 身份与产品会话 | Identity与Channel Binding、Conversation、Product Store | Principal、Role/Grant、Authentication Session、Scope、Product Session、Interaction、Message Tree、生命周期和查询 | W0、W1 | 输入先持久化，历史可重开，越权被拒绝 |
| W3 上下文与理解 | Context、Memory、Collaboration | ContextPackage、唯一历史装配器、受控Memory、多Intent、澄清和用户修正 | W2 | 用户可见并修正系统理解和上下文 |
| W4 工作与执行治理 | Collaboration、Interaction协调器 | Work/Plan/Action、Draft、Approval、执行门和版本失效 | W2、W3 | 用户批准的内容与实际执行严格一致 |
| W5 产品运行控制 | Run管理、Runtime Store、AG-UI协调 | Product Run/Attempt、Job、Event Cursor、Cancel/Retry/Resume、Finalization Gate | W2、W4 | 无假成功；刷新和断线能回到权威状态 |
| W6 MAF/Workflow执行 | MAF Adapter、Worker、Scheduler/Reconciler | Agent/History、Workflow/Checkpoint、Lease、Worker接管和HITL映射 | W5 | 失联可判断，从验证过的安全点恢复 |
| W7 Tool副作用治理 | Tool执行 | Tool Catalog、Approval桥接、Ledger、幂等、结果未知和对账 | W4、W5、W6 | 不盲目重做外部副作用，有处置证据 |
| W8 知识、证据与审计 | Memory、Evidence、Run Trace、Artifact/Index | Memory候选、Evidence、Provenance、Trace、失效传播和运营视图 | W2、W3、W5、W7 | 结果可验证，来源失效能正确降级 |
| W9 交付与外部集成 | Delivery、Identity与Channel Binding、具体Channel Adapter、Channel Adapter Host、Interaction Ingress | Outbox、Delivery/Receipt、Binding、平台/Bridge合同版本、跨入口连续性 | W1、W2、W5、W8 | 平台不直连核心；送达可追踪，多入口不双写、不越权 |
| W10 超级管理员运营看护 | Identity、Super Admin Operations、Product Harness、Evidence、Super Admin Console | Authentication Session、Role/Grant、Activity/Usage、Work/Artifact运营投影、管理员审计 | W2、W4、W5、W8 | 可信回答谁登录、怎样使用、工作/作品进度与异常；普通用户不可越权，投影不双写 |

### 3.1 工作流依赖

```mermaid
flowchart LR
    W0["W0 治理与架构"] --> W1["W1 工程与合同"]
    W1 --> W2["W2 身份与会话"]
    W2 --> W3["W3 上下文与理解"]
    W3 --> W4["W4 工作与治理"]
    W2 --> W5["W5 运行控制"]
    W4 --> W5
    W5 --> W6["W6 MAF/Workflow执行"]
    W6 --> W7["W7 Tool治理"]
    W3 --> W8["W8 知识证据审计"]
    W5 --> W8
    W7 --> W8
    W1 --> W9["W9 交付与集成"]
    W2 --> W9
    W5 --> W9
    W8 --> W9
    W2 --> W10["W10 超级管理员运营看护"]
    W4 --> W10
    W5 --> W10
    W8 --> W10
```

## 4. 当前状态总览

| 交付阶段 | 目标 | 当前状态 |
|---|---|---|
| 0. 产品定义与治理 | 固定独立产品身份、6个问题、完整闭环和协作规则 | `最终愿景、概念边界和阶段A协作协议已获确认` |
| 1. 工程与真实链路 | 建立独立前后端、MAF、AG-UI、调试和验证基线 | `真实模型门通过；2项收尾` |
| 2. 目标架构与合同基线 | 审核目标拓扑、模块、状态、合同、恢复矩阵 | `总体架构已批准；模块详细设计按交付门继续` |
| 3. 产品事实与完成历史 | 身份、Session、Message、Run/Attempt和历史恢复 | `Phase 1文本底座、显式Retry/Restart和精确取消窄切片完成；完整身份和树操作继续` |
| 4. 上下文、意图、工作与执行门 | Context、Intent、Work、Draft、Approval | `Product Harness D1-D8、ExecutionDraft完整编辑、39节点主Workflow、Intent Set/复合Plan、SD1 Repository只读、SD2受治理pi只读、SD3受管Workspace精确编辑与真实Qwen隔离写入、4个前端工作区完成；独立分支执行与部分成功继续` |
| 5. 持久执行与活动流 | Job/Event、Worker、Lease、重连和Reconciler | `D1-D8纵向切片完成；完整强退、多端、保留和容量矩阵继续` |
| 6. Tool、Workflow与HITL恢复 | Tool Ledger、对账、Checkpoint和持久Interrupt | `主Workflow审批安全点跨进程恢复完成；Tool与任意Workflow恢复继续` |
| 7. 知识、证据、交付与运营 | Memory、Evidence、Provenance、Outbox、Trace、超级管理员看护和告警 | `Note/Memory生命周期与Harness事务Outbox完成；超级管理员目标已确认，独立Evidence、Artifact、Delivery和运营能力继续` |
| 8. 外部入口连续性 | 通过具体Channel Adapter接入终端平台，并通过Bridge Adapter与OPC-OS Chat对等集成 | `未开始` |

## 5. 阶段 0：产品定义与治理

目标：让所有后续设计以同一个独立 Chat 产品身份、完整场景和经验约束为前提。

任务：

- [x] 固定要解决的 6 个问题和 6 个核心目标。
- [x] 固定完整产品闭环和核心对象。
- [x] 确认后端 MAF、前后端 AG-UI、React 自研 UI 技术路线。
- [x] 建立`AGENTS.md`、`PROJECT_CONTEXT.md`、`PROJECT_PLAN.md`、`PROJECT_STATE.md`和`README.md`。
- [x] 纠正产品身份：Chat 是独立完整产品，OPC-OS Chat 是外部集成关系。
- [x] 新增并持续维护`PROJECT_LESSONS.md`，当前记录47个反例，并把Product Harness事实不能从聊天摘要猜测、不得回退系统Python、产品级工程收敛、可持续模块质量、外部编码Agent权限、Session标题一致性、模型结果去向审计、移动端完整产品视角、超级管理员运营看护、pi安装/隔离运行身份、数据库测试独立收集、虚拟环境沙箱路径、验证产物收口、懒加载样式所有权、Workflow代码可学习性、确定性双Trace、跨仓源码调试所有权、PWA认证失效恢复、反向SSH端到端健康判定和学习文档代码事实口径加入回复前置门。
- [x] 建立Chat概念空间：方法来源、目录治理、发现索引、14个高风险概念簇、概念/实现双状态和自动结构/链接校验。
- [x] 把最终产品愿景固定为“想法能留下、事项有状态、工作可继续、执行可看护、结果有证据”，并明确Product Session不是Project边界、Context面板不是第二事实源。
- [x] 用户已确认本轮愿景与概念纠正准确进入稳定项目文档。
- [x] 用户已确认“谁登录、怎样使用、工作和作品进度”属于超级管理员目标能力；个人主页、执行看护和技术可观测性不能替代。

完成门：项目定义无需依赖 OPC-OS 也能完整描述用户、价值、责任和产品边界；所有项目回复前强制读取经验文档。

## 6. 阶段 1：工程与真实链路

目标：建立不依赖旧`opc-os/chat`运行环境的独立工程和可重复验证入口。

已完成：

- [x] 初始化私有 Git 仓库、Python 3.12/uv、React 19/TypeScript/Vite。
- [x] 建立 FastAPI、MAF Agent 和 AG-UI HTTP/SSE 端点。
- [x] 建立无密钥 Bootstrap Agent，以及支持按数组扩展Provider/模型的私有后端JSON配置路径。
- [x] 建立 Tailwind CSS、Radix UI、Lucide React和局部页面状态基础。
- [x] 建立后端测试、前端类型检查/构建和一键验证脚本。
- [x] 完成浏览器真实回合、窄屏检查和真实模型 AG-UI 回合。
- [x] 完成逐次模型调用审批纵向切片：服务端Provider/模型目录与联动选择、固定Key/类型化Value可读编辑、同源Provider JSON、完整请求编辑、版本/Hash失效、二次审批、精确发送、审批协议消息隔离、放弃恢复输入和真实Provider回合。
- [x] 建立 VS Code 前后端/全栈调试与定向端口、进程清理。
- [x] 完成手机公网HTTP验证链路：本地回环后端与内嵌Worker由LaunchAgent常驻，反向SSH只绑定云服务器回环端口，Nginx以同源`/chat/`与`/chat-api/`提供完整响应式Web并统一Basic Auth；不可变前端发布、备份回滚、断线自动恢复和真实移动浏览器三次模型审批回合均已验证。HTTPS、标准PWA安装和正式Product Identity仍不在该验证阶段保证内。

剩余：

- [x] 建立Provider超时、发送后取消和结果未知恢复合同测试；真实双Provider成功路径已验证，故障路径不做可能产生未知计费的真实外部重放。
- [ ] 固定旧项目“复用、重写、仅参考”的文件级清单。

完成门：空数据环境可重复启动，成功和关键失败路径均有真实链路证据；不迁移旧数据库、历史或密钥。

## 7. 阶段 2：目标架构与合同基线

目标：在任何正式领域 Schema 和模块实现之前，冻结能承载完整场景的架构边界。

任务：

- [x] 完成 MAF、pi、nanobot、QwenPaw 和 LibreChat 的限定源码研究与知识同步；QwenPaw专项覆盖Web/Channel/Queue/统一请求入口拓扑。
- [x] 完成 Session 9 个能力域、74 项能力和 R0-R6 恢复分级。
- [x] 完成 Session Phase 0-8 的任务与依赖路线。
- [x] 重写[总体架构研究](./docs/overall-architecture-research.md)，公开错误修订、研究过程、证据、参考覆盖和项目推导。
- [x] 重写并批准[总体架构基线](./docs/overall-architecture-proposal.md)，按pi、nanobot、QwenPaw和LibreChat真实结构推导Web/Channel Adapter、Interaction Ingress、11个产品与应用模块、合同、状态、失败恢复和9个场景；第11个Super Admin Operations来自已确认的本项目运营需求，参考项目研究明确未涉及完整链路。
- [x] 新增并补全[架构新手导读](./docs/architecture-beginner-guide.md)：按前端View、协议DTO、内部Envelope、产品领域对象和MAF运行对象5层展开；从“发送/批准”两个用户动作串起数据库、Session、Tool、Provider请求、响应解析、产品提交和React渲染；同时对照当前代码链与目标链。
- [x] 完成[Chat愿景方案与完整场景模拟验证](./docs/chat-vision-scenario-validation.md)：以12个完整场景、24个异常场景、拒绝/修改矩阵和长跨度测试计划验证项目、任务、学习、研究、周期工作、用户标准、执行层最小工作包与用户看护；其中9项方案优化仍待用户审核，不构成正式Schema授权。
- [x] 完成[Chat持续协作系统研究与落地推导](./docs/chat-collaboration-system-research.md)：逐项核对Scrum/Kanban/PMI、学习科学、W3C PROV、Git、SQLite/FTS5、长上下文与RAG研究，并与MAF安装版、pi、nanobot、QwenPaw、LibreChat和Codex固定版本源码/文档区分证据等级。
- [x] 把愿景场景扩展为5组逐状态桌面推演：固定前置状态、读取、模型/Tool调用、提交差异、用户可见结果、故障注入和不变量；覆盖确定性Project查询、四天混合焦点、同名消歧、pi执行恢复和多Intent并发。
- [x] 用户审核目标架构决定；2026-07-24进一步确认Super Admin Operations属于完整产品目标。
- [x] 用户已审核愿景场景验证推导出的协作协议、步骤投影、周期工作、验证修复与多Intent方向；各阶段仍按自己的完成门交付。
- [x] 用户已审核协议、Context面板、TurnDigest、检索、存储、执行层边界和方法覆盖方向；阶段A已实现，阶段B-F仍按路线推进。
- [ ] 审核模块公开合同、ID链、错误分类、并发/幂等原则和四个提交门。
- [ ] 建立 MAF/AG-UI 安装版合同测试设计和依赖升级门。
- [ ] 把 Session R0-R6 验收矩阵映射到 Conversation、Context、Collaboration、Run、Tool执行、Delivery 与 MAF Runtime 组件。
- [ ] 为每个模块建立详细设计任务、负责人边界和验收清单；不冻结字段实现。

完成门：架构师能继续出数据、接口、部署和安全方案；项目经理能排 W2-W10；开发能知道模块和合同；产品负责人批准场景覆盖和设计原因。

## 8. 阶段 3：产品事实与完成历史

目标：建立所有后续能力共同依赖的服务端权威事实，并支持已完成和失败回合的恢复。

主要方案任务：

- [x] 审核并实现Conversation与Run管理的Phase 1聚合、状态机和Application Service；完整Identity/Channel Binding仍待后续阶段。
- [x] 建立固定本地Scope、Product Session、Interaction和树兼容Message字段；真实Principal/Binding与分支操作尚未启用。
- [x] 建立Product Run、Run Attempt和稳定错误分类；不与Runtime Job合并。
- [x] 建立输入接纳门和产品成功终态门。
- [x] 建立Product Store迁移、短事务、CAS并发和启动恢复基础；备份、保留和容量策略仍待治理阶段。
- [x] 实现REST Session/Message/Run查询和AG-UI实时投影对齐。
- [x] Product Session自动标题记录来源Message；来源撤回时回滚，并在侧栏、聊天标题和设置中显示稳定短定位码及复制完整ID入口。
- [x] 服务端唯一历史装配；防止Product History、Provider History和客户端消息重复。
- [x] 实现创建、列出、打开、归档、重启恢复和失败Retry/Restart；重试保留旧Run/Attempt并建立新Run血缘，不冒充Checkpoint Resume。
- [ ] 实现已批准的多Product Session共享同一Harness并行协作：不同资源允许并行；同一资源以
  revision/CAS、来源Trace、过期Context失效和可见冲突收敛，不使用跨模型/Tool调用的全局长锁。
- [ ] 固化 MAF HistoryProvider 保存、错误和终态顺序合同测试。
- [ ] 完成桌面、窄屏、重复提交、并发和重启端到端验证。

完成门：用户输入先于模型持久化；完成和失败回合可在重启后打开；Run/Attempt/Trace可解释。该门不表示活动流、Worker、Tool或Workflow恢复已经成立。

## 9. 阶段 4：上下文、意图、工作与执行门

目标：用户知道系统理解了什么、使用什么、准备做什么，并能把对话转成长期工作。

主要方案任务：

- [x] 审核并实现[Product Harness、Work与Memory详细设计](./docs/product-harness-detailed-design.md)D1-D8及11号领域迁移。
- [x] 建立 Context Source、纳入/排除、Token 预算、版本和 Hash。
- [x] 实现Intent识别、依据/置信度、澄清、运行时用户修正、Intent Set/Intent不可变revision、跨Run Clarification和最多4个有序目标的主Workflow纵向切片。
- [x] 建立 WorkItem、TaskPlan、Plan Node、ActionItem、依赖和责任状态。
- [x] 按[执行治理合同](./docs/execution-governance-contract.md)建立持久ExecutionDraft、授权后编译的不可变RunSpec、HITL Policy Resolver、Decision Record、一次性Grant/Consumption和ModelCallDraft/Attempt纵向链路。
  - [x] [正式Schema、状态机与前端HITL配置矩阵](./docs/execution-governance-detailed-design.md)的D1-D7已于2026-07-22获用户批准并完成9号迁移、后端服务、主Workflow接合和前端矩阵。
- [x] 建立ExecutionDraft revision/Hash变化使旧批准失效的合同；Context/Plan/Policy/Capability其余资源的跨对象失效继续随正式领域实现补齐。
- [x] 主Workflow只允许已接受ExecutionDraft revision编译不可变RunSpec并绑定Product Run；独立Worker能力执行与跨进程恢复仍属于阶段5-6。
- [x] 建立ExecutionDraft 17部分完整可读编辑工作台、CAS保存、新revision/Hash和重新审批。
- [x] 建立对应前端 Context Inspector、Project Explorer、Work Board和Knowledge工作区。
- [x] 完成21天32轮项目开发与28天40轮技能学习长测，覆盖跨Session/入口、API重开、CAS、幂等、假完成、来源失效、Memory拒绝/接受和Token预算。
- [x] 完成Product Harness接合后的真实模型浏览器纵向回合：简单问答3次模型调用逐次审批；多Intent回合4次逐次审批、28节点完成、权威Project目录事实与独立文本回答均正确且不创建长期资源。
- [ ] 把复合Plan接入既有WorkItem的长期`TaskPlanRevision`，并实现独立Branch Execution、部分成功、聚合结果与Evidence；当前Run内复合Plan不能外推为独立分支执行保证。
- [x] 每次Provider Attempt持久记录发送、接收、首字节、解码、HTTP/Provider ID、用量、可见输出Hash与Workflow采用去向；明确Project目录查询改为0次模型调用的确定性分支。

完成门：一个多意图真实请求可形成可修改计划；高影响执行无法越过批准门；用户修改任一绑定项后旧批准不能运行。

## 10. 阶段 5：持久执行与活动流

目标：把 HTTP/SSE 连接与执行生命周期分开，支持活动 Run 重连和 Worker 失联处置。

主要方案任务：

- [x] 批准并实现[活动Run重连与通用Execution Worker详细设计](./docs/runtime-execution-detailed-design.md)D1-D8及12号迁移。
- [x] 实现周期Reconciler、通用Execution Worker及独立CLI进程角色。
- [x] 实现Run/Attempt/Job显式映射、幂等领取、Lease Epoch Fence、精确取消和Checkpoint Resume命令；Retry/Restart仍沿用“新Run/Attempt/Job”血缘。
- [x] 实现AG-UI公开事件Journal、签名Cursor、REST状态/回放接口、前端Sequence/Hash重放和Product终态校正。
- [x] 浏览器断线只结束订阅，不隐式取消Run；真实Provider断线验证仍由同一Job完成。
- [x] Worker失联按未外发安全重领、Product已终结修复或外发结果未知三类收敛，旧Epoch不能写事件或Final。
- [ ] 补齐真实API进程强退、多标签页/换设备、Cursor实际过期、事件保留清理和Delta批量写的完整阶段验收；当前专项并发/跨OS进程/断线/真实模型纵向切片已通过。

完成门：活动流可按游标接回；Worker 失联不会产生双执行或假成功。该门不表示任意 Tool 结果未知时可以自动恢复。

## 11. 阶段 6：Tool、Workflow 与 HITL 恢复

目标：外部副作用和长时 Workflow 在批准、故障和人工中断下可安全推进。

主要方案任务：

- [x] 建立嵌套Workflow可视化种子：MAF原生异构节点与两层子Workflow运行，标准AG-UI事件实时投影，Product Trace刷新恢复；该项不包含Checkpoint/HITL或跨进程恢复。
- [x] 建立受治理多Agent种子：可编辑且有Revision的Agent Profile、规划与审校Agent、确定性完整会话交接、两次Provider调用逐次审批、AG-UI节点投影和Product终态提交；该项不包含动态拓扑、群聊或持久Checkpoint。
- [x] 建立pi Agent Tool种子：MAF FunctionTool封装官方JSONL RPC；每次Provider请求和内部Tool调用分别进入可编辑审批，前端可配置真实Tool并查看模型/Tool/Token/耗时统计；启动将遗留执行收敛为中断，但不冒充通用副作用对账或R6恢复。
- [x] 详细设计 Tool执行模块的Tool Catalog、Tool Operation Ledger、幂等和能力声明；
  [F01/SD3字段级设计](./docs/tool-operation-workspace-detailed-design.md)已于2026-07-25批准。
- [ ] 建立 MAF Function Middleware 到 Tool Gateway 的唯一执行路径。
- [ ] 工具参数动态扩权时回到持久 Approval，而不是进程内默认批准。
- [ ] 实现`result_unknown`、查询对账、补偿和人工处置。
- [x] 为持续协作主Workflow实现Product Run/Attempt与MAF Checkpoint、Definition/version、图签名和Interrupt Link映射；其他Workflow仍需逐一定义恢复边界。
- [x] 为持续协作主Workflow实现持久Decision与MAF/AG-UI Interrupt/Resume双向接合、Lease Outbox和独立Worker入口；活动流重连与通用Tool恢复不在该保证内。
- [ ] 验证工具请求前失败、请求后断线、重复回调、部分成功、补偿失败和跨进程 HITL。

完成门：只从验证过的安全点恢复；外部副作用结果未知时不盲目重做；不承诺通用 Exactly-once。

## 12. 阶段 7：知识、证据、交付与运营

目标：让结果可验证、知识受控生效、送达可追踪，并让超级管理员能在受授权、可审计的前提下看护用户、工作、作品和异常。

主要方案任务：

- [ ] 详细设计 Memory、Evidence、Delivery、Run Trace和Super Admin Operations；超级管理员Schema/API/指标/隐私必须单独审核。
- [x] 建立 Memory Candidate、接受、纠正、撤销/失效、范围、不可变revision和来源关联。
- [ ] 建立 Evidence、Artifact、Provenance Graph、验证和失效传播。
- [ ] 建立 Transactional Outbox、Delivery Worker、Attempt、Receipt、重试和死信。
- [ ] 建立用户 Trace、审计策略、Correlation、运营视图、告警和人工处置。
- [ ] 在Identity中建立真实Principal、Role/Grant、Authentication Session和认证事件；前端菜单可见性不能替代服务端授权。
- [ ] 建立User Activity Event、Activity Window与Usage Aggregate，分别定义登录会话、前台活跃、有效协作和Run/Provider/Tool耗时。
- [ ] 建立只读的Project/Work/Plan与Artifact/Evidence运营投影、Projection版本/游标、延迟标记和全量重建能力；不得反向修改源事实。
- [ ] 建立Super Admin Console、专用REST查询、细粒度内容/导出Grant、目的记录、Super Admin Audit和数据保留规则。
- [ ] 验证来源删除/权限撤销对 Evidence、Memory、Context 和 Work 的传播。
- [ ] 验证 Run 成功但 Delivery 失败、重复投递、乱序回执和 Artifact 中断。
- [ ] 验证普通用户越权、管理员撤权、多设备/多标签、后台空闲、心跳丢失/重复/乱序、时钟偏差、投影延迟/重建、跨用户缓存和审计失败关闭。

完成门：用户能回答“结果是什么、证据是什么、是否已送达、来源是否仍有效”；运维能定位并处置积压和失败；超级管理员能可信回答谁登录、怎样使用、工作/作品进度和需要关注的异常，且普通用户不可越权、敏感访问可审计。

## 13. 阶段 8：外部入口连续性

目标：在不改变Chat产品身份和事实源责任的前提下，通过具体Channel Adapter接入终端平台，并通过独立Bridge Adapter与OPC-OS Chat对等互操作。

主要方案任务：

- [ ] 获取并审核外部系统的身份、能力、消息、命令、事件和回执规范。
- [ ] 详细设计 Channel Binding、合同版本、来源 Envelope、入站幂等和撤销传播。
- [ ] 实现 Inbound Integration Gateway 和具体 Channel Adapter。
- [ ] 验证外部消息转为同一个 Chat Interaction，不复制第二套 Session/Work/Run 规则。
- [ ] 验证跨入口并发、重复输入、权限撤销、来源失效和 Delivery 回执。
- [ ] 完成兼容性、升级、审计和降级策略。

完成门：至少两个入口能够授权继续同一个 WorkItem，不重复执行、不越权、不形成双重事实源；任一外部系统不可用时，Chat 自身仍可独立运行。

## 14. Session 专项路线映射

Session 是 W2-W9 的横向能力，仍由两份专项材料维护：

1. [Session能力全集](./docs/session-capability-catalog.md)：9个能力域、74项能力、R0-R6恢复分级。
2. [Session交付路线](./docs/session-delivery-roadmap.md)：Phase 0-8、53个任务和场景验收。

| Session 路线 | 项目阶段 | 主要架构位置 |
|---|---|---|
| Phase 0 术语与恢复合同 | 阶段2 | W0/W1，跨全部模块 |
| Phase 1 产品会话与历史 | 阶段3 | Identity、Conversation、Run Trace |
| Phase 2 Run控制与并发 | 阶段3-5 | Conversation、Collaboration、Run管理 |
| Phase 3 生命周期、分支与长上下文 | 阶段3-4 | Conversation、Context、Collaboration |
| Phase 4 活动流重连 | 阶段5 | Run管理/Runtime Store/AG-UI Reconciler |
| Phase 5 Worker恢复 | 阶段5 | Scheduler/Worker/Lease/Reconciler |
| Phase 6 Tool恢复 | 阶段6 | Tool执行/Evidence |
| Phase 7 Workflow/HITL恢复 | 阶段6 | Collaboration/Run管理/MAF Workflow |
| Phase 8 跨入口与治理 | 阶段7-8 | Identity与Channel Binding/Memory/Evidence/Delivery/Run Trace |

专项路线不能创造与总体架构冲突的对象或事实源；D1-D6 持久化方案只是阶段3中的子设计，需在总体架构和 Phase 0 合同通过后重新审核。

## 15. 全程质量门

每个阶段都必须满足：

1. 文档、代码、Schema、事件和实际行为一致。
2. 自动测试覆盖成功、失败、重复、并发和关键反例。
3. MAF/AG-UI 关键路径有安装版合同测试和升级回归。
4. 真实模型或 Agent 验证不能被 Mock 替代。
5. 浏览器端到端、响应式和可访问性不能被 API 测试替代。
6. 按能力注入断线、进程退出、超时、结果未知和恢复故障。
7. 密钥、数据库、历史、日志和构建产物不进入 Git。
8. 阶段完成必须列出已兑现和未兑现保证；用户价值审核不能被工程绿灯替代。
9. 新增或修改高风险概念时，概念索引、唯一正文、相关UI/API命名和事实所有者必须一致，并通过概念空间校验。

## 16. 产品能力与工程质量Todo

2026-07-23完成[产品级工程审计](./docs/product-engineering-audit-2026-07-23.md)，并把功能缺口和工程整改统一登记在[产品能力与工程质量Todo](./docs/product-engineering-backlog.md)。详细用户场景、目标、方案级做法和验证门只在该Todo中维护，本节只维护执行状态。

### 16.1 Q0工程安全底座

2026-07-23用户已批准Q0实施；完成状态仍以逐项验证门为准。

- [ ] Q01 自动质量门与CI（本地纵向基线通过；待提交后的远端CI首次运行与合并保护验证）。
- [ ] Q02 后端模块与应用边界收敛（实施中：组合根、HTTP边界、Workflow Contracts/Prompt/Graph Factory、Governance Catalog/错误/Policy/Run Query与Harness合同/命令记录/Context Query已拆；Execution/ModelCall与Project/Work/Knowledge命令协调继续）。
- [ ] Q03 API合同、错误与安全边界统一（纵向基线完成；真实Principal、公开API版本和全部响应模型继续）。
- [ ] Q04 可观测性、日志和调试体系（纵向基线完成；生产Exporter、SLO、告警和保留继续）。
- [ ] Q05 测试金字塔、覆盖率与故障实验室（纵向基线完成；多设备、容量、性能和完整故障矩阵继续）。
- [ ] Q06 前端Feature架构与交互质量（实施中：统一Client、7个Feature API、Settings边界、App/审批组件、Agent重连Hook与Workflow运行投影已拆；8个生产按需Feature和包体门已建立；[视觉基线v1](./docs/ui-ux-visual-baseline.md)及4项轻量情绪层已获批准，生产界面迁移、性能与更广泛人工无障碍继续）。
- [ ] Q07 文档、注释、ADR与依赖治理（纵向基线完成；随Q02/Q06及依赖升级持续维护）。

### 16.2 后续产品能力

- [ ] F01 通用Tool Operation Ledger与副作用对账（字段级设计已于2026-07-25批准；受管worktree内
  单文件精确`edit`纵向切片已实现并通过确定性故障矩阵；本机pi Gateway凭据冲突已修复，真实pi
  已使用Qwen完成一次隔离写入Product Run；网络外部副作用、补偿和人工处置仍未完成，因此通用F01
  不勾选完成）。
- [ ] F02 Evidence、Artifact、Provenance与独立生命周期（SD4-A记录层和SD4-B内容寻址Artifact
  Store/确定性Validation Runtime已完成；SD4-C Result Commit Coordinator、REST commit端点、
  Harness完成门与主Workflow结果证据链接线（v1.8.0/39节点、ResultPipelineCoordinator、
  精确绑定Decision与幂等重放）已实现；2026-07-26 verify-fast/verify全量门均通过（后端461项、
  覆盖率80.08%、21次迁移升降无漂移、前端76项与生产构建、Playwright 19通过3跳过）；当前私有部署仍需配置scope密钥
  后才启用Artifact写入；SD4-D失效传播和SD4-E UI/Dogfood仍待交付）。
- [ ] F03 Runtime完整故障、容量和游标矩阵。
- [ ] F04 Session完整生命周期、树、控制与可移植性。
- [ ] F05 任意Workflow、嵌套Workflow和pi持久恢复。
- [ ] F06 独立Intent、Harness交互与Context权限治理。
- [ ] F07 Principal、Role/Grant、Authentication Session、Scope、Channel Binding与Delivery。
- [ ] F08 Provider配置、运营、备份、保留与SLO。
- [ ] F09 超级管理员身份、使用与作品运营看护。
- [ ] F10 Chat开发Chat自举纵向闭环（SD1、SD2与SD3真实Qwen隔离写入已完成；SD4/F02与
  SD5/F05仍保留各自详细设计门）。

推荐主依赖顺序是`Q01 -> Q03 -> Q04 -> Q02 -> Q05 -> F01-F03 -> F04-F06 -> F07 -> F09`；F08在Q0后可与产品能力并行，F09的身份底座随F07推进，但完整工作/作品看护依赖F02、F06和真实身份。F10是穿透既有能力的Dogfood纵向线：SD1只读资源绑定可在详细设计审核后先行，SD3写入必须等待F01，SD4完成声明必须等待F02，SD5持久恢复必须等待F05；不能为了尽快看到自举效果绕过这些门。Q06-Q07贯穿对应阶段。工程收敛不得改变现有Product Store、MAF/AG-UI合同、Workflow节点ID、审批Hash或用户可见语义。
