# Chat Long Agent 使用与配置

## 1. 这是什么

Long Agent 是 Chat 中长期陪伴用户工作的助手。每个 Agent 有自己的身份、配置、资源、Memory 和 Daily Project；可以从微信、Telegram 或 Chat Web 接受请求，在学习、旅游、开发等 Project 中工作，也可以执行定时任务和主动检查。

目标原则是：每天换 Daily Session 不失忆，进入不同 Project 不失忆，换入口仍能继续工作。Session 保存具体工作，Agent 的活动索引、历史查询和 Memory 提供长期连续性。

**状态：本文包含已确认的产品目标。2026-09-20 当前实现只覆盖其中一部分，不是全部功能已经发布。** 当前可用配置和接口以[系统配置](../../configuration/README.md)为准，逐项能力状态见[实施状态](./chat-long-agent-roadmap.md)。

## 2. 现在可以做什么

首次使用从 Web 全局导航“Friend”点击“启用并创建默认助手”，系统准备 Nexus；无已选 Project 也可以操作。后续用“＋”新增 Friend，不需要手填 NanoClaw Group ID。启动 Host、配置 Chat 模型后，点击 Friend 即可对话。启用前提、错误重试及 HTTP 合同见[系统配置](../../configuration/README.md#long-agent注册与配置管理当前实现)。

当前已有 Chat Web 与 NanoClaw 文本对话、Telegram/微信接入路径、Long Agent 的部分配置管理、Agent 身份和 Standing Instructions 注入、Markdown Agent Memory 管理、Chat Personal/Project Memory、Workflow 调用，以及 Project 管理 Skill 和 6 个 Tool。

当前已支持独立 Agent home 与日常主 Session 按日轮换；换日总结与交接已实现；任务管理（LA2）、长期职责（LA3）与产物闭环（LA4：笔记与动态）已接入，合同见[Friend 任务](./tasks.md)、[Friend 长期职责](./duties.md)和[Friend 产物闭环](./deliverables.md)；Docker 工具环境及完整资源自我管理仍有实施差距，逐项以[实施状态](./chat-long-agent-roadmap.md)为准。旧界面或旧配置不能代表新目标已经生效。

2026-09-19 P1：以下目标已收敛为每 Friend 每日唯一直接交流 Session，项目逐轮装配；[公共装配](../../architecture/chat-context-resource-model.md#15-公共-agent-装配合同p12026-09-19)与[生命周期](./chat-long-agent-architecture.md#4-project-first-与会话选择)是实施合同，P2 公共装配和协作目标已接入，P3 每日生命周期已实现；P4 实时交互与 P5 本地迁移验收已完成，实际外部渠道验收边界见实施状态。

独立任务、长期职责、定时笔记/动态与群聊按[LA0–LA6 功能计划](../../development/long-agent-functionality-plan.md)推进。LA0 确定“每日唯一”只约束直接交流，后台任务与群参与使用独立上下文；LA1–LA4 已交付；群聊（LA5）的**模块合同与短设计已交付、实施进行中**（[群聊与多 Friend 协作合同](./group-chat.md)），能力未发布前不得按现状使用。

## 3. 应该如何使用

| 目的 | 目标使用方式 |
|---|---|
| 日常沟通 | 找到某个 Long Agent，进入它当天的 Daily Session |
| 学习道德经 | 创建或打开学习 Project，与同一 Friend 在当天 Session 继续，项目规则自动装配 |
| 旅游规划与监控 | 在旅游 Project 保存计划、配置监控任务、查看变化来源 |
| Ziji 开发 | 选择具体子项目，在 Friend 当天交流中发起工作；普通项目 Session 仍可独立使用 |
| 问昨天做了什么 | 查询该 Agent 的活动/日记，再打开相关 Session |
| 换入口继续 | 在 Web 打开对应会话，或回复带工作关联的 Channel 消息 |
| 管理能力 | 查看自身配置、模型和资源目录，修改授权范围内的配置 |
| 查看自动工作 | 从 Agent 或 Project 的任务列表检查 Run、结果与投递状态 |
| 持续负责某项学习 | 在 Friend 设置的“职责”中配置目标、资料、成果要求与推进节奏；Agent 用 `duty_manage` 推进并留下进度与依据 |
| 不重复介绍项目 | Agent 可通过系统概览发现向它开放的项目、用途和进度 |
| 让 Agent 持续负责内容运营 | 配置 Content Lab 的长期职责，由 Agent 自主安排并跨日推进 |
| 每天 3 条动态 + 1 篇笔记 | 在任务中把 4 个时段配置为产物任务（动态/笔记 + 槽位 + 受众），在"交付"页查看状态与产物 |
| 查看其他 Agent 动态 | 订阅可见 Social 更新，通过事件获得处理机会 |

这些使用方式的完整模拟与验收见[四个场景](./chat-long-agent-scenarios.md)。Friend 模式切项目只更新下一轮协作上下文，不切会话；普通项目模式仍按项目定位自己的 Session。

## 4. 配置在哪里、改动影响什么

每个 Agent 的能力定义位于独立配置根 `<CHAT_HOME>/long-agents/<longAgentId>/definition.json`，`long-agents.json` 只保留身份、绑定与状态索引；每个 Agent 拥有独立 home Project（projectId 即 `longAgentId`）与按日轮换的日常主 Session。NanoClaw Group 和 Memory 通过管理 API 维护；具体路径、JSON 与 API 见系统配置。生命周期（创建/归档/恢复/删除）由后端服务统一执行，页面与 `long_agent_manage` Tool 同源。

目标为每个 Agent 提供独立的 `<CHAT_HOME>/long-agents/<longAgentId>/` 配置与资源根、独立 Daily Project 与 Workspace；身份、配置、Session、Memory、任务和日志按 Agent 全量隔离，共享资源只能放在明确规定的共享位置，且写入该 Agent 配置后才生效。管理实体、隔离与生命周期合同见[管理实体与隔离架构](./chat-long-agent-management.md)，目录布局说明见[定义与配置模型](./chat-long-agent-capability-model.md#5-独立空间与共享空间)。当前不能据此手工创建文件来启用尚未实现的能力。

模型目录与认证统一来自 Chat。Agent 修改模型时应明确是整个 Agent、某个任务还是本轮；不能自行到 ~/.pi 修改配置，也不为每个 Agent 复制 Credential。

配置在下一次执行重新解析；已运行的轮次保留其版本。需要重建环境、应用调度或重新连接 Channel 的变更，页面应显示应用进度及失败原因。

## 5. Long Agent 详情应该展示什么

完整目标包括身份、System Prompt 与自定义区域、模型、Skill/Tool/MCP/Extension/Plugin、Memory、项目和会话、任务与 Run、Channel 与通知、Docker 环境、活动日记和修改记录。

每项能看到来源、作用域、配置版本和实际生效状态。用户与 Agent 经由同一套管理服务编辑，避免“界面显示一种配置、Agent 实际使用另一种配置”。密钥只显示引用或掩码。

## 6. 每日会话、记忆与日记的关系

Agent 的 Daily Project 长期稳定，日常主 Session 按其时区每天轮换。Friend 的学习、旅游、开发交流使用当天同一 Session；跨日靠交接继续，普通项目 Session 可跨日。停止环境或切模型不改既有历史。

新会话先获得少量近期历史、未完成事项和记忆入口，需要细节时查询原 Session 或产物。Project Memory 保存项目事实，Agent Memory 保存助手自身的长期知识；公共 Personal Memory 由授权控制。

Social 使用日历和时间流展示每个 Agent 每天的工作及来源。没有生成总结时仍可看到活动；计划、进行中和已完成分别显示。日记生成失败不影响第二天继续工作。

## 7. 长期职责、自由活动与触发

灵魂模式表示 Agent 持续承担一份工作，例如运营 Ziji Content Lab；它自行安排每天先做什么，通过 Skill、Tool 和 Workflow 推进，具体工作归属业务 Project。自由活动来自兴趣与社交，没有用户规定的交付职责；“22点提醒睡觉”是具体定时任务；朋友圈更新则可通过事件触发查看或交流。这些能力可以并存，时间和事件也能为长期职责提供推进机会。

职责、共享范围、工作节奏、活动偏好和订阅使用 Chat 的文件配置与统一管理入口；项目进度和运行结果来自领域事实。详细使用模拟与待审机制见[共享认知与自主工作](./chat-long-agent-awareness-and-autonomy.md)。

### 具体任务配置

任务至少明确：谁负责、属于哪个 Project、做什么、何时触发、使用哪种 Session、何种情况通知、发往哪里，以及失败和错过时间如何处理。

LA2 任务触发复用 LA1 独立工作 Session；迁移前已接受的旧 Nano 定时消息保留原 Session；显式 Workflow 委派保留独立子 Session，不能当作第二条 Friend 直接交流。后台运行不会抢走你当前聊天的位置。没有变化的检查可以不调用模型，但仍留下运行记录；通知失败与工作失败分别处理。

LA2 提供具体任务管理，见 [Friend 任务](./tasks.md)。长期职责自主拆解和群聊尚属后续阶段，不能把周期执行相同说明称为自主持续学习。

## 8. Docker 意味着什么

目标中的 Docker 为工具、脚本、MCP 和开发提供受控环境。Agent 有独立环境配置，进入不同项目按授权获得工作范围；多人并行开发可使用独立副本。

Docker是可选环境依赖，不是Chat或Nano Channel Host的安装前提。当前chat-pi可在无Docker机器运行；后续只有显式选择Docker环境的任务才依赖它，环境缺失应报告不可用，不能自动回退宿主执行。无Docker部署与当前能力边界见[部署文档](../../operations/README.md)。

停止或重建容器不删除 Agent 的身份、Memory、Session 和任务。执行环境、Project 工作目录和 Agent 自身 Workspace 分开管理。当前 chat-pi 仍关闭 NanoClaw 原生 Agent 容器，新的 Docker 工具环境尚未接入。

## 9. Agent 应如何阅读本说明

先确认当前身份、Project、Session、有效配置与真实工具目录，再按任务读取管理 Skill 和相关文档。文档中的目标能力不是调用成功的证据；缺少 Tool 或运行适配时应说明当前缺口。

本轮只将设计写入仓库文档及开发导航，没有向运行中的 Long Agent 发布新的公共管理 Skill。后续发布必须验证安装、发现、版本更新及引用文档在 Agent 环境中可读。

## 10. 机制收口与后续实施

新需求先使用[机制与扩展合同](./chat-long-agent-mechanism-contract.md)归类：明确请求、长期职责、自由活动与消息/时间/事件分别组合，再选择配置、能力资源、Workflow或接入适配。目标是多数常见需求不需要修改核心机制，不按具体业务增加互斥模式。

设计前的代码约束、Nano原生复用、Skill动态生效、Session扩展、验证与基础场景顺序见[实施前基线](./chat-long-agent-engineering-baseline.md)。先确认这些输入，再开展工程管理和详细方案。

[交互场景收敛与模拟](./chat-long-agent-interaction-simulations.md)包含临时互助、多方工作、后台协作与自由活动的正常路径、并发与突发分支，作为机制的验证材料；具体呈现进入详细设计。

[共享认知与自主工作](./chat-long-agent-awareness-and-autonomy.md)补充Coder自动发现项目、Content Lab长期职责，以及提醒和朋友圈事件；方向已进入收口，具体Schema和参数在详细合同中审核。

后续执行Agent提交具体配置、Session/消息、调度与前端合同及任务书，架构师审核后实施并审查验收证据。Session与Workflow复用是技术原则，不预设中央协调者；外部互操作出现真实需求时再评估适配。

## 后台工作（LA1）

先打开一个 Friend，在侧栏“后台工作”点加号，填写名称和完整说明。创建后可以继续日常交流，或打开工作查看相同的实时过程、结果和历史；“返回日常交流”回到今天。工作固定创建时的项目，切换页面项目不会改变它。可停止单个工作，重启后不明执行会明确显示“已中断”，检查历史后再继续。

也可以让具备 `friend_work` 的 Friend 自己发起后台工作。默认管理的能力集增加此 Tool；显式自定义的能力集不强制改写，可在设置中选择。未确认提交应点击“确认上次提交”收敛同一请求，不要反复新建。完整边界见[LA1 实现合同](./chat-long-agent-architecture.md#la1独立后台工作实现合同)。定时编辑、长期学习策略和群聊尚不属于本阶段。

任务管理、触发投影和旧任务迁移见 [Friend 任务（LA2）](./tasks.md)。创建 Friend 只需名称和可选简介；服务连接、认证、接口版本错误分别提示，不再用一个含糊的“需要已更新的 Host”覆盖所有原因。
