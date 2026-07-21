# Chat 项目状态

## 1. 当前结论

| 项目 | 当前事实 |
|---|---|
| 产品身份 | 独立开发、独立运行、独立运营并持续演进的完整 Chat 产品 |
| 当前目录 | `/Users/xulater/Code/Chat` |
| 代码状态 | 前后端工程骨架、MAF + AG-UI 纵向链路和真实模型回合已完成 |
| 设计状态 | 总体架构已按完整用户场景重写，等待用户审核；尚未进入领域详细设计或业务开发 |
| Session 状态 | 9个能力域、74项能力、R0-R6恢复分级和Phase 0-8路线已形成，待与新架构一起审核 |
| 数据状态 | 没有产品Schema，没有迁移旧数据库、历史会话或旧环境配置 |
| Git 状态 | 私有仓库`later-3/Chat`，分支`main`；最后已推送提交`acdbaef`，本轮定位、架构、计划和产品元数据修订尚未提交 |

## 2. 已确认的稳定事实

### 2.1 产品与架构

1. 项目不保留背景章节，直接围绕 6 个用户问题、6 个目标和完整闭环设计。
2. Chat 是独立完整产品，不是 Adapter、薄通道或外部系统附属实现。
3. OPC-OS Chat 是可对等互操作的外部系统；特定拓扑中的通道角色不改变 Chat 产品身份。
4. Chat 自己承担 Conversation、Work、Approval、Run、Evidence、Delivery、Memory 和 Trace 的产品事实责任。
5. Product Session、MAF AgentSession/Workflow Checkpoint、AG-UI Thread、Product Run 是不同对象；Product Run 与 Run Attempt 也不同。
6. REST 管理产品资源，AG-UI 管理一次 Agent Run 的实时交互；Product DB 是产品事实源，MAF 负责运行时语义。
7. Interaction 与 Product Run 不是同一对象；一次 Interaction 可以触发零到多个 Run。
8. 模型输出只能提出 Intent、Work、Memory 和结果候选，不能自动成为长期正式事实。
9. Session总体规划必须先覆盖完成历史、活动流、Worker、Tool、Workflow/HITL和跨入口连续性，再按依赖拆交付。

### 2.2 已批准技术路线

1. 后端：Python、Microsoft Agent Framework（MAF）、FastAPI。
2. 前后端 Agent 协议：AG-UI over HTTP/SSE，不是 assistant-ui。
3. 前端：React 19、TypeScript、Vite、`@ag-ui/client`和自研UI。
4. UI基础：Tailwind CSS、Radix UI、Lucide React；Zustand只管理页面状态。
5. MAF运行状态与产品领域状态分开拥有；SQLite是已批准的Product Store实现起点，但必须验证目标架构所需保证。
6. 外部Web产品参考只保留LibreChat这1个正式主参考；新增参考项目仍需用户批准。

## 3. 本轮纠正与完成

- [x] 新增[项目经验与反例](./PROJECT_LESSONS.md)，建立每次回复前强制读取规则。
- [x] 记录4个可执行反例：交付阶段偷换目标架构、集成角色降级产品、模块清单冒充设计、场景未穿透架构。
- [x] 纠正`AGENTS.md`和`PROJECT_CONTEXT.md`中的产品身份与外部关系。
- [x] 删除稳定产品上下文里的“第一阶段/后续能力/非上位系统”式范围定义。
- [x] 重写[总体架构研究](./docs/overall-architecture-research.md)，公开上一版推导错误、研究过程、证据等级、覆盖矩阵和方案比较。
- [x] 重写[总体架构候选](./docs/overall-architecture-proposal.md)：
  - 目标形态改为“模块化产品核心 + 持久执行平面 + 可靠交付平面”。
  - 定义4个有界域、12个产品模块及每个模块的内部组件、状态、合同、不变量、失败恢复和测试责任。
  - 定义API、Execution Worker、Scheduler/Reconciler、Delivery Worker、Projector进程角色。
  - 定义5类逻辑存储、12类关键合同、ID链、生命周期和4个提交门。
  - 用7个用户场景逐步映射组件、合同、状态、失败和用户结果。
  - 只在文档最后给出交付阶段。
- [x] 重写`PROJECT_PLAN.md`，按10条工作流、依赖图和9个交付阶段映射目标架构。
- [x] 更新README项目定位与文档入口。
- [x] 完成所有Session专项文档中的旧产品身份和误导性阶段措辞一致性修订。
- [x] 清理Python包、FastAPI元数据、Agent描述和Web品牌中的旧“OPC-OS附属通道”命名，统一为独立Chat产品。
- [x] 完成全仓文档交叉审计、本地链接检查和工程验证：3个后端测试、前端类型检查与生产构建通过。

## 4. 已完成的工程与研究证据

### 4.1 工程基线

1. 已建立独立Git、`.gitignore`、`.editorconfig`、Python 3.12/uv和前端npm工程。
2. 后端当前依赖：`agent-framework-core 1.11.0`、`agent-framework-openai 1.10.1`、`agent-framework-ag-ui 1.0.0rc8`。
3. 前端当前依赖：React 19、TypeScript 6、Vite 8、`@ag-ui/client 0.0.57`。
4. `POST /api/agent`接收AG-UI请求并通过SSE返回运行和文本事件。
5. 无模型密钥时使用确定性Bootstrap Agent；`backend/.env`存在有效模型配置时创建真实模型Agent。
6. `GET /api/health`只返回安全运行信息，不输出密钥。
7. VS Code后端`8030`、前端`5073`；调试前后定向清理对应端口和项目进程。

### 4.2 已有验证

1. 后端3个测试通过：健康合同、ARK配置映射、AG-UI完整事件流。
2. 前端类型检查和生产构建通过；最新`npm install --package-lock-only`审计122个包，0个已知漏洞。
3. 浏览器完成真实消息回合，控制台错误为0；窄屏无横向溢出。
4. 真实模型AG-UI文本回合：HTTP 200、82个事件、`RUN_STARTED`到`RUN_FINISHED`。
5. 清理脚本已验证可分别终止端口8030的Uvicorn和5073的Vite，清理后无监听残留。

### 4.3 Session与参考项目研究

1. 已按当前安装版本、MAF源码、测试和示例核对Session、HistoryProvider、AG-UI和Workflow能力。
2. 已研究pi、nanobot的Session存储、恢复、并发和失败边界。
3. 已在固定提交`8e5ef1fb31e9d63b735c089b21cbc82c50acce46`研究LibreChat Conversation、Message树、Generation Job、活动流、失败终态、HITL和Web总体分层。
4. 已实测MAF HistoryProvider终态顺序、保存失败、per-service持久化和双历史风险。
5. MAF与LibreChat可复用知识已写入`/Users/xulater/Code/opc-os/agent_knowledge`对应目录。

## 5. 尚未实现的能力

1. Product Store Schema、迁移和Repository。
2. Product Session列表、服务端历史恢复、Message Tree和搜索。
3. Principal/Scope、ContextPackage、Intent、Work/Plan、ExecutionDraft和持久Approval。
4. Product Run/Attempt正式状态机、Runtime Job/Event、Worker、Lease和Reconciler。
5. Tool Ledger、幂等、对账、Workflow Checkpoint与跨进程HITL。
6. Memory、Evidence、Provenance、Artifact、Delivery/Outbox和产品Trace。
7. OPC-OS Chat或其他入口的正式集成合同。
8. 真实模型失败/超时/取消/错误脱敏完整验证。

## 6. 风险和未知

1. MAF安装版与本地参考源码不是同一发布快照；具体API、事件和异常必须以安装版合同测试为准。
2. AG-UI当前为RC版本，升级可能改变事件、Snapshot和Interrupt/Resume行为。
3. AG-UI Client会发送客户端消息全集；若同时装配Product History、MAF History和Snapshot会形成重复上下文。
4. Product Finalization Gate如何阻止过早`RUN_FINISHED`仍需安装版Spike。
5. MAF Workflow Checkpoint与Product Run、持久Approval、Tool Ledger的跨进程接合尚未完成E2E。
6. SQLite的事务、Outbox、事件写入、Lease原子领取和多Worker边界尚未压测。
7. 外部Tool副作用没有通用Exactly-once；必须按工具定义幂等、查询、补偿和人工处置。
8. Intent、Work、Approval、Evidence、Delivery等主要来自本项目需求，参考项目未提供可直接复制的完整状态机。
9. OPC-OS Chat正式身份、权限、能力、消息和回执合同尚未取得。
10. 安全、容量、SLO、数据保留和灾难恢复的数值目标尚待产品审核。

## 7. 当前审核门

当前只审核总体产品与架构，不创建正式Schema、Repository、Worker或业务模块：

1. 审核 Chat 独立完整产品定位和对等外部集成关系。
2. 审核“模块化产品核心 + 持久执行平面 + 可靠交付平面”。
3. 审核4个有界域、12个产品模块及其内部组成、合同和状态所有权。
4. 审核API、Execution Worker、Scheduler/Reconciler、Delivery Worker和Projector进程角色。
5. 审核REST/AG-UI协调、5类逻辑Store、ID链和4个提交门。
6. 审核7个完整场景是否真正覆盖用户需要。
7. 审核交付阶段是否只表达依赖顺序，没有缩小目标架构。
8. 总体架构通过后，再审核Session Phase 0合同和D1-D6持久化子设计。
