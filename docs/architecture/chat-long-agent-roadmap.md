# Chat Long Agent 实施状态与迁移要求

## 1. 文档状态

2026-09-07：用户已确认完整 Long Agent 定义、配置、连续性、调度、Docker 与四个场景，要求先落文档，由执行 Agent 后续开发，架构师负责方向与审核。

本次交付仅包含文档和导航更新。本文是现状/目标差距表与迁移要求，不是已下发的开发任务书，也不表示部署完成。

目标事实源为[定义与配置模型](./chat-long-agent-capability-model.md)、[架构](./chat-long-agent-architecture.md)、[场景验收](./chat-long-agent-scenarios.md)。现有 JSON/API 用法见[系统配置](../configuration.md)，旧执行合同见[当前集成基线](./chat-nanoclaw-pi-integration.md)。

本轮新增明确要求为共享项目/进度的机制化发现、长期职责与自主推进（灵魂模式）、自由活动与具体任务的区分，以及 Social 事件触发。建议机制和新增场景在[共享认知与自主工作](./chat-long-agent-awareness-and-autonomy.md)评审，默认策略与具体合同尚未确定。

用户随后认可方向并要求机制收口，目标以可组合、可扩展的机制覆盖约70%～80%的常见需求。[机制与扩展合同](./chat-long-agent-mechanism-contract.md)现为新增需求归类和实施评审入口；该比例尚未验证，当前源码能力不因文档收口而改变。

本轮进一步要求在软件工程/项目管理动作之前，确认原生能力接入、代码质量、测试、场景覆盖和实施依赖。静态核查及决策建议见[实施前基线](./chat-long-agent-engineering-baseline.md)，尚未下发任务书或进入代码设计实现。

2026-09-09：用户确认 Long Agent 比照 Project 建设为一级管理实体，身份、配置、Session、Memory、任务、日志与 Workspace 全量隔离，共享资源只能放在明确规定的共享位置且写入 Agent 配置后才生效，每个 Agent 拥有独立 Daily Project。决策与 S1～S5 实施切片见[管理实体与隔离架构](./chat-long-agent-management.md)；该文档与本文的差距表共同作为实施输入，S1（配置根）是当前首个可下发切片。

2026-09-09 进展（任务一）：Skill 生效可见性（T1.2）、四级 Skill 归属树（`/api/skills/tree` + Skills 页树形总览）、Long Agent 按树勾选配置、Workflow Agent 资源纳入 Project 持久配置（T1.3，durable config 新增 `resources` 字段 + 读写端点）、配置中心壳（T1.1，左下角改“配置中心”分层菜单）均已落地并上线。

2026-09-09 进展（任务二）：S1 配置根（definition 拆分为 `long-agents/<id>/definition.json` + 索引化 + 幂等迁移）、S2 生命周期（create/archive/unarchive/delete 服务、API、前端入口、`long_agent_manage` Tool、`long-agent-management` Skill）、S3 独立 Daily Project（`daily-<id>` + 存量归属迁移）、S4 自有资源目录接入装配与展示、S5a 日常主 Session 按日轮换均已落地并有测试门禁。**当前唯一切片级剩余项是 S5b（Agent Memory 迁入 Chat Home 本地 OKF 服务）**；“配置为唯一生效来源”、跨域授权记录、换日上下文恢复与 Agent 时区为后续迭代。

2026-09-09 修正：S3 迁移改为**启动时全量执行**（替代依赖入口的懒迁移），并且迁移会建立新 Daily Project 的当日主 Session、把指向旧共享 daily 绑定的通道绑定重定向到新绑定——否则存量 Telegram 等通道会话会永远路由到旧会话。修正有回归测试（config-root.test.mjs）。

2026-09-09 进展（通道主动联系）：新增 `channel_send` 系统 Tool（Long Agent 默认能力；目的地由服务端按可信身份从 Registry 绑定解析，NanoClaw 强制校验接线）、NanoClaw 窄端点 `POST /v1/agent-messages`、公共 Skill `channel-messaging`（何时联系、内容与节制规则、失败处理）。定时任务/自由活动的触发机制仍属机制合同后续项，但通道出口已就绪。

## 2. 当前能力与目标差距

以下依据当前工作区源码、配置文档及先前已完成的链路记录；本轮没有重新执行模型、Channel 或 Docker 验收。“原生有”不等于“Chat 已接入”。

| 能力 | 当前 Chat/NanoClaw 状态 | 已确认的目标 |
|---|---|---|
| Pi 执行 | 公共装配入口，Web/Channel 使用 Chat Pi | 保持统一配置与 Session 事实 |
| 多身份 | 单 Host 多 Group；Long Agent 稳定映射 | 每个 Agent 完整独立空间及生命周期管理 |
| 配置来源 | long-agents.json + Nano Group 数据/文件 | 独立 Agent 文件配置根，受管字段只有一个可写定义 |
| 模型 | Chat 模型选择及认证校验已接入 | 自身有效配置/目录查询、明确范围和替代策略 |
| 身份与 Memory | Group Snapshot、Standing Instructions、OKF 核心注入与 agent_memory_* | 保留领域合同，整合独立根、完整来源与维护能力 |
| Personal/Project Memory | Chat Memory Tool 已接入 | 与 Agent Memory 分工，不隐式复制 |
| Daily | 共享 daily，未按 Agent/日历分区 | 每 Agent 独立 Daily，按日选择日常主 Session |
| 业务 Session | Project × Agent 唯一 primarySessionId | 多个主题 Session，可选择、续接、跨日 |
| Channel | Telegram/微信文本路径、耐久 Event/Delivery/Ack | 显式工作切换、通知回复关联、富消息与目的地管理 |
| 历史连续性 | Pi 历史与 Memory；缺完整 Agent 活动索引/查询 Tool | 自动关联、分区历史 Prompt、按需查询与交接 |
| Project 管理 | project-management Skill 与 6 个 Tool 已在工作树实现 | 与 Agent 工作切换及资源授权配合 |
| 共享认知 | 已有 Project 查询；面向 Agent 的可见进度/活动概览、统一更新与装配未完整接入 | 无须用户逐一告知，按共享范围发现项目与进度，详情和工作分别授权 |
| Prompt | 共用 Agent Definition，已有自定义指令/资源能力 | 完整有序区域、任意自定义区域、同源预览 |
| 自有资源 | 部分共享/Project资源可装配；Nano私有Skill/Template未完整接入 | 独立资源目录、版本化装配、增删改和依赖影响 |
| 调度 | Nano 原生支持一次性/周期/检查脚本，Chat 非Channel唤醒未打通 | 固定 Project 的 Task/Run/Session/Delivery 合同 |
| 长期职责与自由活动 | 当前 Standing Instructions 有职责文本，未形成完整自主推进与管理合同 | 持久职责、自主安排、项目工作连续性；自由活动保留无交付空间 |
| Social 事件 | Social及其订阅链未实现；Channel耐久事件不代表已经支持动态订阅 | 可见更新触发处理、过滤/去重/合并、可只读或不回应 |
| 主动投递 | 主要是文本原路回复 | 结构化 Destination、通知政策和可续接结果 |
| 附件与交互 | Nano原生有文件/卡片/提问/编辑/Reaction；Chat主要是文本合同 | 按Channel能力适配，保留回复和待处理事项关联 |
| 权限与Credential | Channel发送者控制已使用；原生OneCLI执行链未接入Chat Pi | 复用Chat Credential引用和领域授权，明确需要用户决定的动作 |
| Agent/模板生命周期 | 原生有创建与模板；Chat完整管理面未接入 | 创建独立空间、管理资源和模板更新，保留本地修改与数据 |
| Docker | chat-pi 跳过原生 Session Runtime 与所有 Docker 管理 | 解耦后的受控工具、脚本、MCP和开发环境 |
| Social/每日整理 | 未实现 | 按 Agent/日期的活动与有来源回顾 |
| 公共管理 Skill | 仓库文档/开发导航已有；运行时公共管理Skill未发布 | 所有 Long Agent 可发现并查询真实有效配置 |
| Agent 间交互 | 原生 Nano 有通信能力，Chat Tool 未接入 | 暂待讨论 Session、参与者与多方交互 |

关键实现证据：

- [Long Agent 配置与默认工具](../../src/long-agents/types.ts)、[配置校验](../../src/long-agents/configuration.ts)。
- [唯一主 Session 的当前实现](../../src/long-agents/project-agent.ts)。
- [当前 Long Agent 执行](../../src/long-agents/runtime.ts)、[公共 Pi 装配](../../src/agents/pi-agent-session.ts)。
- [Group/Memory 服务](../../src/long-agents/agent-group-service.ts)。
- [Nano 非 Channel 唤醒限制](../../nanoclaw/src/modules/chat-integration/execution-driver.ts)、[恢复范围](../../nanoclaw/src/modules/chat-integration/recovery.ts)。
- [Nano 任务创建](../../nanoclaw/src/modules/scheduling/create.ts)、[原生任务语义](../../nanoclaw/docs/scheduled-tasks.md)。
- [关闭原生 Runtime 的启动边界](../../nanoclaw/src/agent-execution-startup.ts)。
- [原生跨会话功能](../../nanoclaw/src/modules/cross-session-context/index.ts)、[模板](../../nanoclaw/docs/templates.md)。

## 3. 已确认替换的旧约束

| 旧实现/旧设计 | 新目标与迁移要求 |
|---|---|
| 所有 Long Agent 默认使用共享 daily | 分配独立 Daily Project；普通 Chat 的默认 daily 可继续保留 |
| 一个 Project × Agent 永远一个主 Session | 保留旧 Session，增加主题集合、参与关系和当前选择 |
| 长期连续性依赖一条持续增长的 Session | Daily 按日轮换，历史/活动/Memory维持连续性 |
| Group 显示名与 Chat 别名可能不同 | 产品身份由文件配置统一定义，Nano 保存明确运行投影 |
| 身份在数据库、模型在注册表、Prompt各处分散 | 独立 Agent 定义与统一 Resolver；状态/缓存不成为第二配置源 |
| 所有 Docker 功能永久禁用 | 支持隔离工具环境；继续禁用另一套原生 Agent Runtime |
| 自我扩展一律需要提案和审批 | 已授权自有修改可执行；共享/扩权按 Policy 处理 |
| 新 Skill 在仓库落盘等同于已安装 | 发布、发现、选择、授权、装配和实际 Tool 分别验收 |

## 4. 实施依赖顺序

后续任务书可以按以下依赖组织，具体拆分、负责人和排期尚未下发：

以下保留能力依赖概览；实际先后与可并行分支以[基础场景B0～B6](./chat-long-agent-engineering-baseline.md#7-基础场景的实施依赖)为准。尤其不能把Docker、Web、并发和多方消息的风险验证全部留到最后。

1. 锁定独立配置、领域事实所有权与迁移 Schema，建立有效配置查询/编辑及能力检查。
2. 实现 Agent 独立根、独立 Daily 与资源合同，发布公共管理 Skill。
3. 实现多 Session 选择、按日 Daily、活动索引、历史及共享概览查询和 Prompt 装配。
4. 接入 Docker 工具环境、依赖与权限，并验证没有宿主执行旁路。
5. 接入统一主动触发、Task/Run/Session/Delivery、目的地和回复关联，并按评审合同承载长期职责的自主推进、自由活动与事件订阅。
6. 实现每日整理、Memory维护和 Social，验证连续多日与来源失效。
7. 完成 Agent 详情及 Project/任务/环境/日记的同源展示和编辑。
8. 单独评审多 Agent 合同，再安排其实现；已有 Workflow 调用继续复用。

这些是能力依赖，不是只交付后端再长期缺少前端的阶段划分。每个可用能力需同时交付配置、管理 Tool/API、实际装配、前端可观察性、文档和验收证据。

### 4.1 收口后的首项交付：详细合同与任务书

前置步骤：先完成实施前基线中的约束、验证及D1～D6决策评审，然后准备决策记录与需求/约束/测试对应表，再将本节作为详细设计阶段的交付要求。当前不提前分派实现或生成排期。

由执行Agent先提交详细设计，架构师审核后再实施。合同需覆盖：

| 合同包 | 必须明确 | 评审证据 |
|---|---|---|
| 定义与发现 | 独立目录迁移、职责/任务/订阅和共享策略Schema、版本、公共Skill与有效配置查询 | Web/Tool/Prompt同源解析示例，旧配置兼容与应用状态 |
| 归属与交互 | Daily轮换、业务多Session、参与者/工作/消息关系、真实身份与Pi原生消息映射 | 单聊、Agent互助、多方讨论、跨入口及跨日的ID与历史示例 |
| 触发与执行 | 消息/时间/事件、职责推进、状态迁移、去重、等待/继续、并发与Docker边界 | 重复触发、互相追问、共享写入冲突、重启及投递失败处理 |
| 展示与交付 | 配置编辑、能力检查、工作状态、共享概览、Social与继续入口；分批任务及迁移顺序 | 每批均有完整用户路径、实际装配和场景验收对应关系 |

详细设计可以选择具体实现，不重新穷举行业；使用机制合同E1～E4说明扩展级别。不能先写业务旁路再用文档解释，也不能以未定字段为由重新开启无限场景讨论。此处是交付要求，尚未向任何运行Agent下发开发任务。

## 5. 迁移边界

### 5.1 配置与 Agent 数据

稳定 Agent/Group ID 保留。将已有定义、名称、Standing Instructions、资源与环境声明迁入统一文件合同；旧受管入口停止独立写同一字段。记录源 revision、迁移标记与应用结果。

Agent Memory 仍使用 NanoClaw OKF 服务，迁移物理根时保证单一可写目录。路径适配、停止/恢复写入和失败恢复在详细任务书中明确；不通过无边界挂载或直接读取 Nano 数据库绕过 API。

### 5.2 Daily 与已有会话

为每个 Agent 创建独立稳定 Daily Project；普通 Chat 的 daily 不自动删除。

旧共享 Daily 历史保留原 ID、Project 与来源。按可核实参与关系建立受控历史入口，不把全部旧记录复制给每个 Agent，也不改写历史 Project 来伪造隔离。后续新日常交互进入各自 Daily。

已有业务 primarySessionId 作为可续接 Session 保留，不清空、不重复导入。Project × Agent 关系升级后允许多个主题会话。

### 5.3 原生任务与 Docker

任务迁移必须解析负责人、Project、Session 策略和投递目的地。无法可靠推断的旧任务保留为待配置/暂停并说明原因，不能自动指定共享 Daily。

Docker 接入需要新的环境执行合同及部署门禁。仅移除 chat-pi 或恢复 Nano 原生 Provider 会违反统一 Pi 架构，不能作为迁移办法。环境不可用时报告失败/等待，不静默回退宿主无限权限执行。

部署约束：Docker按需安装、显式启用，基础Chat/Nano Channel服务不得因未安装Docker而拒绝启动。仅声明依赖Docker环境的任务受其可用性约束；当前仍未提供这套工具环境的产品开关，已有chat-pi无Docker路径继续保留。

### 5.4 派生数据与恢复

配置快照、活动索引和 Social 有明确来源/版本，引用更新或撤回后可失效或重建。并发创建、重试和恢复不能重复创建当日主 Session、同次 Run 或 Delivery。

已完成外部动作不可凭重试重放；结果不确定时保存待核实状态。运行取消、数据移除、Agent 归档的作用域需要明确显示。

## 6. 交付与验收

[场景验收编号](./chat-long-agent-scenarios.md)是后续执行 Agent 提交证据的入口。跨日、恢复、Channel 回复、配置生效与 Docker 隔离必须走用户实际使用链；单纯新增 Tool 声明、文档或单元测试不表示产品能力完成。

此轮只做文档链接、内容一致性和差异检查，不运行 pnpm verify，不声称目标场景通过。代码实施时按 AGENTS.md 执行相应完整验证。

## 7. 机制已收口，转入具体合同审核

已有[交互模拟](./chat-long-agent-interaction-simulations.md)和[共享认知与自主工作](./chat-long-agent-awareness-and-autonomy.md)作为场景依据，分类、机制与扩展范围已进入收口合同。停止按具体业务无限发散，下一步按第4.1节审核详细合同与任务书。

按用户最新要求，进入第4.1节前先审核实施前基线，特别是Skill的发现/选择/装配区分、Nano调度责任、Pi消息投影及跨仓库测试覆盖。

需在详细合同中完成参与者与Pi角色、消息和工作关联、等待/继续、发言策略、取消与结果回传的具体表达；外部A2A仅在出现互操作需求时评估为适配，不作为当前内建协作的前置依赖。

已确认并发需求：同一Agent可同时与用户、其他Agent交互，独立工作不因身份相同而全局串行。会话写入、共享资源和独占工具分别控制冲突；具体消息队列与调度实现需证明满足该合同。自由活动不因收到正式任务而一律暂停，长期职责也不能被零散消息长期饿死。

用户关于“复用调用Workflow的原理，另建Session，由Agent发起交互”的判断针对底层实现。场景已用于检验参与、介入、共享和完成行为；后续把这些要求映射到现有Project、Pi和公共装配，不要求中央协调者，也不增加Team Runtime。
