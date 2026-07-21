# OPC-OS 自研 Chat 通道：项目计划

## 1. 计划目标

建立一个独立、可运行、可验证的自研Chat通道，并逐步完成从连续会话到受控Agent执行的产品闭环。

计划按“先冻结定义，再建立技术基线，再扩展领域能力”的顺序推进。

## 2. 阶段总览

| 阶段 | 目标 | 当前状态 |
|---|---|---|
| 0. 项目定义与治理 | 固定身份、问题、目标、边界和协作规则 | `已完成` |
| 1. 技术路线与工程初始化 | 审核前后端路线并建立独立可运行骨架 | `真实模型门通过，收尾中` |
| 2. Session总体规划与最小纵向链路 | 先审核完整Session能力与路线，再实现会话、消息、MAF Agent、历史和基础Trace | `能力全集与路线待审核` |
| 3. 上下文、意图与审核 | 上下文包、多意图、执行Draft和用户确认 | `未开始` |
| 4. 工作与记忆闭环 | WorkItem、TaskPlan、人/AI行动和记忆候选 | `未开始` |
| 5. 受控执行与多Agent | 工具权限、副作用确认、多Agent和恢复 | `未开始` |
| 6. 上位系统集成 | 与OPC-OS Chat通道适配层和共享能力对接 | `未开始` |

### 2.1 Session横向交付路线

Session不是只属于阶段2的一张表，而是贯穿后续产品闭环的横向能力。完整目标与任务以两份审核材料为准：

1. [Session能力全集与目标边界](./docs/session-capability-catalog.md)：9个能力域、74项能力和R0-R6恢复层级。
2. [Session分阶段交付路线](./docs/session-delivery-roadmap.md)：Phase 0-8、53个任务、依赖理由和各阶段用户场景。

总体能力和路线批准前不进入详细设计；批准后先执行路线Phase 0，再重审现有D1-D6这个Phase 1持久化子设计。路线中的Phase 3-8会分别与本项目阶段3-6的上下文、工作、执行和上位系统能力协同，不能被阶段2“最小链路”替代。

### 2.2 总体架构横向基线

总体架构同样贯穿阶段2-6，目前有两份待审核材料：

1. [总体架构研究与证据](./docs/overall-architecture-research.md)：记录版本、检索过程、参考覆盖、采用/改造/拒绝和未知项。
2. [总体架构候选](./docs/overall-architecture-proposal.md)：提出领域模块化单体、8个产品模块、MAF Runtime边界、状态所有权、关键链路和部署演进。

总体架构批准前，不批量创建正式模块目录、Schema、Repository或Worker；批准后它只成为后续详细设计的边界基线，不代表具体表、API和类已经批准。

## 3. 阶段0：项目定义与治理

目标：用户审核前不让旧项目假设直接进入新代码。

任务：

- [x] 明确本项目是OPC-OS Chat体系中的一个自研Chat通道。
- [x] 固定要解决的6个问题。
- [x] 固定6个核心目标。
- [x] 固定完整产品闭环。
- [x] 建立`AGENTS.md`、`PROJECT_CONTEXT.md`、`PROJECT_PLAN.md`、`PROJECT_STATE.md`和`README.md`。
- [x] 确认前后端Agent协议为AG-UI，不是assistant-ui。
- [x] 审核并批准MAF、AG-UI和前端技术组合。
- [x] 用户审核技术路线。

完成门：用户明确批准技术路线和第一阶段边界。`已通过（2026-07-21）`

## 4. 阶段1：技术路线与工程初始化

目标：建立不依赖旧`opc-os/chat`运行环境的独立工程。

任务：

- [x] 初始化Git仓库和基础忽略规则。
- [x] 初始化前端工程与AG-UI Client集成骨架。
- [x] 初始化MAF后端、FastAPI AG-UI端点、配置、健康检查和Agent入口。
- [x] 定义前后端协议和本地开发启动方式。
- [x] 建立项目本地依赖、环境模板和测试入口。
- [x] 建立一键验证脚本。
- [x] 建立无密钥确定性MAF Agent并验证真实AG-UI/SSE事件流。
- [x] 在浏览器完成1次前后端消息回合，并检查窄屏和控制台错误。
- [x] 使用`backend/.env`配置本项目独立模型和密钥来源。
- [x] 完成1次真实模型文本回合。
- [ ] 明确从旧项目复用代码、重写代码和仅保留文档参考的清单。

完成门：空数据环境中可以一键启动前后端，完成1次真实模型文本回合，并通过基础构建和测试。

## 5. 阶段2：Session总体规划与Chat最小纵向链路

目标：先固定完整Session能力和交付顺序，再证明自研Chat通道可以稳定完成真实MAF会话，而不是只完成页面渲染或一组持久化表。

任务：

- [x] 完成[Session持久化研究与方案推导](./docs/session-persistence-research.md)，分别给出MAF、pi、nanobot和LibreChat的证据与边界。
- [x] 形成[Session持久化审核包](./docs/session-persistence-review.md)，补齐每项原因、参考覆盖、选项、优缺点和建议。
- [x] 在[项目上下文](./PROJECT_CONTEXT.md#71-产品对象协议对象与运行时对象的边界)中固定Product Session、MAF Session/Checkpoint、AG-UI Thread和Agent Run的概念边界。
- [x] 外部产品参考只保留LibreChat这1个正式主参考，移除Flowise及多套候选审核前置项。
- [x] 仅针对Product Session、Message、Agent Run和流式恢复研究LibreChat，并回填其真正覆盖与未覆盖项。
- [x] 补充LibreChat Conversation生命周期、Message分支、Fork、导入导出、分享快照和页面续接研究，并同步到`agent_knowledge`。
- [x] 按“Product DB权威、AG-UI只做协议投影”修订Session候选设计中的D1、D3和D4。
- [x] 实测MAF `HistoryProvider`提交顺序、保存失败终态、AG-UI全历史重复风险和`per-service + store=false`工具循环。
- [x] 形成[Session能力全集](./docs/session-capability-catalog.md)，定义9个能力域、74项能力、R0-R6恢复层级、参考覆盖和最终用户场景。
- [x] 形成[Session交付路线](./docs/session-delivery-roadmap.md)，按依赖拆出Phase 0-8、53个方案级任务和阶段完成场景。
- [x] 审计MAF、pi、nanobot与LibreChat对总体架构问题的覆盖，并把MAF总体位置与LibreChat Web分层补充到`agent_knowledge`。
- [x] 形成[总体架构研究与证据](./docs/overall-architecture-research.md)，记录研究过程、证据、覆盖缺口和推导链。
- [x] 形成[总体架构候选](./docs/overall-architecture-proposal.md)，定义架构风格、8个产品模块、MAF Runtime、状态所有权、关键链路和场景映射。
- [ ] 用户审核并批准总体架构风格、模块边界、状态所有权、提交门、Trace策略和Worker演进方式。
- [ ] 用户审核并批准Session能力全集、恢复分级、明确非目标、阶段顺序和任务拆分。
- [ ] 总体规划通过后执行路线Phase 0：固化术语、MAF兼容合同、恢复验收矩阵和版本演进原则。
- [ ] Phase 0通过后，把[Session持久化候选设计](./docs/session-persistence-design.md)与[审核包](./docs/session-persistence-review.md)作为Phase 1子设计重新审核，而不是总体方案。
- [ ] 子设计审核通过后先把MAF一次性Spike固化为仓库合同测试，并完成可信Run Context的并发隔离Spike。
- [ ] 创建、列出、打开和归档Session。
- [ ] 发送用户消息并接收Assistant回答。
- [ ] 服务端恢复历史，前端不承担权威历史。
- [ ] 分开记录Interaction、Product Agent Run与Run Attempt的状态、耗时、模型、血缘和稳定错误码。
- [ ] 实现基础Trace和重启恢复。
- [ ] 验证桌面与窄屏主要操作。

完成门：路线Phase 0和Phase 1通过；真实MAF Agent回合、R0/R1历史恢复、失败回合和浏览器端到端均有证据。不得把该门外推为活动流重连、Worker接管、Tool、Workflow或HITL恢复已经完成。

## 6. 阶段3：上下文、意图与审核

目标：让用户在执行前知道系统理解了什么、使用了什么、准备做什么。

任务：

- [ ] 自动装配核心记忆、近期消息和当前工作状态。
- [ ] 展示ContextPackage的纳入、排除和来源。
- [ ] 支持一个或多个Intent及其不确定性。
- [ ] 意图有歧义时主动请求确认。
- [ ] 生成可编辑ExecutionDraft。
- [ ] 审核绑定版本、Runtime、模型、工具、限制和请求Hash。
- [ ] 修改目标或上下文后使旧批准失效。

完成门：旧版本或旧Hash无法执行；用户可修正意图与上下文；驳回不会触发Agent执行。

## 7. 阶段4：工作与记忆闭环

目标：让对话形成可持续推进的工作，而不是只留下回答。

任务：

- [ ] 建立统一WorkItem模型。
- [ ] 建立TaskPlan、节点和依赖。
- [ ] 区分用户ActionItem与AI ActionItem。
- [ ] 支持候选、激活、完成和驳回状态。
- [ ] 建立Memory候选、接受、纠正和删除流程。
- [ ] 自动匹配既有事项并防止重复创建。
- [ ] 让下一轮上下文读取已确认状态。

完成门：一个真实多意图请求可以形成计划、人/AI行动和记忆候选，并在用户确认后跨重启继续推进。

## 8. 阶段5：受控执行与多Agent

目标：在不牺牲用户控制和可恢复性的前提下执行真实任务。

任务：

- [ ] 定义Agent角色、团队拓扑和收束机制。
- [ ] 为TaskPlan节点生成独立执行请求。
- [ ] 定义只读、可逆和高风险工具分级。
- [ ] 高风险副作用执行前二次确认。
- [ ] 保存Run、Evidence、Delivery和Trace关系。
- [ ] 超时、崩溃和外部结果未知时先对账，不盲目重试。
- [ ] 支持局部重评估和局部重跑。

完成门：至少1个多节点真实任务可以在权限门下执行、失败恢复并产生可验证证据。

## 9. 阶段6：上位系统集成

目标：让本项目作为一个Chat通道接入OPC-OS Chat上位系统，同时保持本项目内部边界清晰。

任务：

- [ ] 定义通道身份、能力声明和消息协议。
- [ ] 定义共享状态与通道私有状态边界。
- [ ] 接入上位系统的适配层。
- [ ] 验证跨通道继续同一事项时的版本、幂等和权限语义。
- [ ] 验证来源删除、权限撤销和证据失效传播。

完成门：至少2个不同通道可以在不重复执行、不形成双重事实源的前提下继续同一WorkItem。

## 10. 全程质量门

每个阶段都要满足：

1. 文档、代码和实际行为一致。
2. 自动测试覆盖成功、失败和关键反例。
3. 真实模型或Agent验证不能被Mock替代。
4. 浏览器操作和响应式验证不能被API测试替代。
5. 不提交密钥、数据库、历史、日志和构建产物。
6. 用户价值审核不能被工程绿灯替代。
