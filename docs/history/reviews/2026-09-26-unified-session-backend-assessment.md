# 三类 Session 统一后端：可行性与工作量评估

状态：源码评估，建议方案；尚未实现统一执行原型，非已交付能力。

## 目标

Long Agent 日常会话、Project 普通会话、主题节点会话共用会话读取、消息受理、Workflow 启动、实时反馈、控制和恢复。三类会话均可选择适用的 Workflow，同一会话连续切换 Workflow 保持原生 Session ID、历史和存储归属。

用户优先追求简约和优秀响应速度，并要求已有功能不受损。统一后端是本批目标；消除全量轮询、首屏读取分页等性能实施仍按性能方案交付，不能以统一执行完成冒称已达到 100ms。

## 源码核实

| 能力 | 当前事实 | 迁移含义 |
| --- | --- | --- |
| Session 与 Pi 装配 | `chat-session.ts`、`createChatPiAgentSession` 已共用；Workflow 的 `createWorkflowAgentSession` 是包装 | 不重写 Pi、Session 格式或工具运行时 |
| 历史及界面 | 公共 `/api/sessions/:id`、ChatWindow 已接三类会话 | 不需要重做聊天 UI；主要收敛控制器分支 |
| 普通 Workflow | `/runs` → `startChatWorkflow` → Workflow SDK；`start-chat-workflow.ts` 明确拒绝非 ordinary owner | 必须增加后端可信目标适配，不能只删除 owner 校验 |
| Friend 与主题消息 | 两者都走 `acceptLongAgentTurn` → `drainLongAgentTurns` → `executeAcceptedLongAgentTurn` | 不是三套底层，而是两类执行生命周期需收敛 |
| 受理及顺序 | Friend 有 requestId、payloadHash、sequence、冻结装配及耐久队列；普通 Run 有持久绑定并拒绝同 Session 新活跃 Run | 公共受理层提取已有能力，不能丢排队或增加第二套独立调度 |
| 实时控制 | Friend 有 live-turn、steer/follow-up/cancel；Workflow 有 Run 流与 Pi abort 注册 | 需要统一活动 Pi 控制与事件投影，不能只统一返回 JSON |
| 记忆 | writer 已共用；Workflow 通过 tail Step，Friend worker 直接调用普通函数 | 统一每轮编排所有权，避免 writer 跑两遍或提前完成 |
| 主题轮次 | running/completed 标记、relay 意图、settled 锚点由 Friend 路径维护 | 作为领域适配保留，完成必须绑定整轮执行事实 |
| 恢复 | Friend 从原生标记对账；Local Workflow 把丢失执行者的运行 Step 标为失败，审核 Hook 另行保留 | 不是任意断点自动重跑；迁移需保留结果不明不自动重放的规则 |
| Agent home 中运行 Workflow | `topic-session-create/start.ts` 已在 Agent home 创建普通准备 Session 并调用真实 SDK | 存储位置不是底层障碍；这不能替代直接 Friend Session 的统一运行证明 |

权威依据：`docs/modules/sessions/chat-session-architecture.md` §1 明确一条 Session 可以跨 Workflow；工程基线 C1/C4/C5/C8/C10 要求公共装配、可信身份、Pi 事实、单 Session 有序和兼容迁移。此方案调整当前双生命周期的组织方式，保留上述约束；实施时须同步模块合同的“当前路径”。

## 推荐结构

```text
Web / 现有 HTTP / Channel 与内部调用适配
                 ↓
可信目标解析（普通 Project / Friend 每日 / Topic 节点）
                 ↓
公共会话受理：请求身份、冻结输入、顺序与执行关联
                 ↓
既有 Workflow Runtime：本轮所选 Workflow
                 ↓
公共阶段 Agent 装配与 Pi AgentSession
                 ↓
同一事件/控制/结果投影 → Frontend 和领域回执
```

公共会话受理应从现有接受/排序机制提取，不另造通用任务调度系统。Run 启动前的耐久请求与启动后的 Run 是不同职责：请求记录保留来源和排队信息；Runtime 拥有 Run/Step 执行结果；请求回执由关联的 Run 对账，不能让旧 worker 和 SDK 分别执行、重试或判定同一轮完成。

具体持久记录存放及 Schema 演进需要在第一个里程碑确定。要求可恢复地关联 requestId、invocationId、runId，覆盖“受理后未启动”和“启动后关联尚未写全”窗口。不能仅靠进程内 Map，也不能假定固定 invocationId 自动保证 SDK 启动幂等。

## 需要保留的业务差异

- Friend 仍有独立身份、资源根、每日定位和渠道回执；它们成为可信受理/装配输入，不再形成第二套聊天执行循环。
- Project Session 保持原存储与配置规则；协作 Project 与 Session 所属 Project 分开，不能把整个执行上下文压成一个 projectId。
- Topic 的节点归属、冻结协作项目、relay、记忆及分叉完成条件保留为领域适配，不复制聊天实现。
- 当前已有 Channel、后台工作和内部接受调用都要纳入迁移清单；只改 Web 三个按钮不算完成。
- 旧 Run/Turn 继续可读。正在执行或等待审核的旧任务按原合同收尾；不能把运行中任务强行改写成新 Run 或重新执行。

### Workflow 与 Long Agent 身份

建议语义：默认直接聊天使用该 Friend 的有效定义；选择规划等 Workflow 时保留其阶段角色，主工作角色与 Friend 的绑定通过公共配置 Resolver 明确表达。Session 的 owner 不因阶段 Agent 改变。

不能把通用 coding Agent 偷换成 Friend，也不能把 Friend 的全部工具和私有记忆无条件注入每一个子 Agent。身份、阶段职责、可用能力和授权是分别解析的字段；资源检查页面与真实执行必须看到同一冻结结果。

切换 Workflow 仅改变下一轮选择，不启动 Run、不复制历史、不重新装配模型；运行中轮次不热换 Workflow。审核意见走当前审核合同，不能作为另一个新 Workflow 并行写同一 Session。

## 工作量估算

以一名熟悉本仓库的工程师的有效开发时间估算，含集成和修复，约 **7–12 人日**。这是源码评估，不是 AI 执行的墙钟时长承诺；置信度中等，主要不确定性是跨 SDK 启动/恢复/活动 Pi 控制的接缝，需首个纵向链验证。

| 工作 | 估算 | 完成证据 |
| --- | ---: | --- |
| 统一目标、身份、配置绑定与迁移合同；首个真实 Runtime 纵切 | 1–2 人日 | Friend 原 Session 跑默认流程和一次审核流程，身份、历史、Run 绑定正确 |
| 公共受理、Workflow 调度关联及三类目标接线 | 2–3 人日 | 三类会话经同一核心调用链，重复请求不启动第二轮 |
| 统一事件/控制/恢复、记忆、主题完成及旧调用适配 | 2–3 人日 | 停止、追加、审核挂起、relay 和中断均维持原保证 |
| 前端 Workflow 选择、公共控制器和刷新恢复 | 1–2 人日 | 三类界面同一功能链，切换选择不运行模型或丢历史 |
| 联合回归、故障注入、构建链、文档与迁移验证 | 1–2 人日 | 下述退出条件全部有证据 |

各项可穿插实施，不能机械理解为每项一个用户审核轮次。只做 happy path 接线可能明显更短，但不能称作“已有功能不受影响的统一”。本估算不包含动态开发/热加载 Workflow、Pi 内核重写、Nano Host 重构或完整读取性能改造。

## 三个内部里程碑，一个最终交付

1. **真实纵切**：先打通同一 Friend Session 的直接聊天 → 切换规划审核 → 批准 → 完成。使用真实 Workflow Runtime 与可控模型；验证身份/冻结项目、Step 打包、事件、停止、记忆只执行一次与稳定历史。跨接受/启动的两个持久窗口同期证明。不得以纯函数假模型替代 SDK 运行。
2. **迁移齐全**：Project、Friend、Topic 全部接同一核心；旧接口成为适配；追加/steer、渠道、后台工作、relay、主题锚点、审核与恢复的功能矩阵全部覆盖。旧记录/旧执行保持可读取和有界收尾。
3. **统一验收**：前端选择/控制/恢复跑完整故事；构建、生产与开发 Runtime、浏览器和迁移回归一起通过。新的正常流量不再进入两条独立聊天执行循环，旧兼容代码有明确可删除条件。

里程碑供内部检查与进度汇报，不是做完一小项就把任务交还用户。只有出现无法在既定语义内解决的实际架构冲突时，才列具体选择请求决策。

## 验收矩阵

不做所有维度的笛卡尔积，核心共同行为在三类会话上参数化；领域差异用针对性用例。

1. 三类会话原 Session 连续两轮并切换 Workflow；第二轮读到正确历史，存储、节点、协作 Project 不变。
2. Friend 身份及授权资源真实进入相应阶段；普通 Project 配置保持原意；模型参数不能伪造 owner、节点或协作项目。
3. 普通回答、图片、工具过程、审核修改/批准/取消、记忆开关和失败可见性不退化。
4. 一条 Session 的接受与写入顺序不乱；重复请求不重复执行；steer/follow-up 有真实 Pi 行为；等待审核不死锁且不会被并行新 Run 越过。
5. 工作/记忆阶段都能停止；切换页面只断观察；刷新/断线可重新订阅正确执行；结果不明不自动重放有副作用的工具。
6. relay 保留唯一消息和来源；锚点只来自允许分叉的完整轮次；失败、取消和待审核均不冒充成功。
7. 原 Channel 受理/回执、独立工作、跨日边界可用；已运行和已等待审核的旧任务有兼容读取/收尾方案。
8. 首屏读取与选择 Workflow 不创建 Run 或装配 Pi；统一过程不得增加全量扫描和串行网络往返。记录改造前后打开、受理、首事件的性能基线。
9. Builder、Nitro dev Step、生产构建、真实 Runtime 与浏览器用户路径通过；执行 `pnpm verify`、`pnpm check:architecture`、父/Frontend `git diff --check`。

## 与速度目标的关系

统一有助于只维护一套性能路径，不能自动消除当前约两秒的切换卡顿；后台全文轮询和等待完整详情之后才切换仍须按性能方案修正。

本批立即约束“打开/切换选择不执行 Workflow、不装配模型”，并保留时间标记；后续读取优化以已访问会话正确首屏 p95≤100ms、选中/输入 p95≤50ms 为目标。不要把 Workflow 的模型耗时混入导航，也不要把接口包装统一作为性能已经改善的证据。

## 本次评估范围

只读核实代码和现有文档，没有运行新统一链原型，也没有修改产品实现、迁移正式数据或部署。本评估不宣称既有测试能够直接证明目标架构；正式实施需要上述联合验收。
