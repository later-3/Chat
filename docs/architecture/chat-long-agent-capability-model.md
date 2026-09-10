# Chat Long Agent 定义与配置模型

## 1. 状态与阅读范围

状态：2026-09-07 用户确认的目标架构。本文规定 Long Agent 是什么、拥有哪些能力、配置和资源如何管理；不表示这些能力已经实现。

- 用户入口：[Long Agent 使用与配置](../long-agents.md)。
- 执行与数据流：[Long Agent 架构](./chat-long-agent-architecture.md)。
- 分类、组合与实施评审：[机制与扩展合同](./chat-long-agent-mechanism-contract.md)。
- 设计前接入核查与工程约束：[实施前基线](./chat-long-agent-engineering-baseline.md)。
- 使用验收：[场景与验收要求](./chat-long-agent-scenarios.md)。
- 本轮新增要求与机制评审：[共享认知与自主工作](./chat-long-agent-awareness-and-autonomy.md)。
- 当前实现及迁移差距：[实施状态](./chat-long-agent-roadmap.md)。
- 当前可用配置语法：[Chat 系统配置](../configuration.md)。

本次确认替代旧设计中的“所有 Agent 共用 daily”“每个 Project × Agent 永久只有一个主 Session”“Chat 永久禁用所有 Docker 能力”。协作、共享认知和自主工作已进入机制收口；多参与者与Pi消息映射等具体实现合同仍需审核，不能从场景中的角色分工反推已批准的会话拓扑。

## 2. Long Agent 的定义

Long Agent 是 Chat 中具有持续身份、独立空间、长期记忆和主动工作能力的助手。它可以从不同 Channel 接受请求，在不同 Project 中工作，并在更换 Session、模型或执行容器之后保持工作连续性。

它由身份、配置、资源、历史和持久任务定义，不由某个一直运行的进程或无限增长的 Pi Session 定义。每个 Long Agent 对应一个 NanoClaw Agent Group；一个 Group 不是一个多 Agent Team。默认一个 NanoClaw Host 承载多个 Group。

Long Agent 与 Workflow 共用 Pi 底座：Workflow 组织一次执行，Long Agent 持有长期身份并可调用 Workflow；两者都通过 createChatPiAgentSession() 装配。Pi AgentSession 是一次执行对象，Pi SessionManager 管理持久会话。

## 3. 已确认的硬约束

1. 每个 Long Agent 有独立配置根、工作空间、自有资源、Agent Memory 和 Daily Project。
2. 所有 Session、主动任务、定时任务和 Workflow Run 必须归属 Project。
3. 进入业务 Project 工作，创建或续接该 Project 的 Session；切换 Project 不修改原 Session 的归属。
4. Daily Project 长期稳定；其日常主 Session 按 Agent 配置的日历日轮换。业务 Project 的 Session 按工作主题组织，可以跨日。
5. 换 Daily Session、换 Project、换 Channel、换模型和重建容器不能导致工作失忆。
6. 模型目录、认证和模型配置由 Chat 管理；Pi 的用户目录不是 Long Agent 的配置事实源。
7. 文件配置是产品定义的事实源。Frontend、Agent Tool 和实际执行使用同一套配置服务及 Resolver。
8. 详情页能够查看所有已定义配置项、来源、作用域、版本和生效状态；Credential 仅显示引用或掩码。
9. Prompt 使用 System Prompt 与有序区域机制，允许用户任意增加自定义区域；规则和经验仍是 Prompt 资源。
10. Agent 在授权范围内自行维护配置和资源；权限扩大、跨 Agent 或共享资源变更按对应 Policy 处理，不能把所有自我维护一律变成审批提案。
11. Docker 纳入隔离执行能力，同时保持统一 Pi Runtime、模型配置和 Session 事实。
12. 公共管理知识可被每个 Long Agent 发现；实际能力与运行身份由服务端注入和 Tool 查询，不能依靠猜目录。
13. 同一个 Long Agent 可以同时与用户、其他 Agent 交互并推进独立工作。不能以长期身份为单位强制全局串行；会话推进、共享数据写入与独占工具的不可并发边界分别定义，并受资源预算约束。
14. Agent 可通过系统机制发现配置为可见的 Project、进度和活动，不依赖用户逐 Agent 告知；共享概览、读取详情和执行工作分别控制。
15. 支持长期职责与自主推进（用户称“灵魂模式”），与无交付要求的自由活动、具体任务分别表达；时间与事件可为这些活动提供触发机会。

## 4. 能力与配置面

以下是必须设计、呈现和管理的能力领域，不是现有 JSON Schema 示例。

| 领域 | 必须表达的配置与状态 |
|---|---|
| 身份 | 稳定 ID、名称、职责、描述、启停、展示头像（auto/emoji/图片引用）、NanoClaw Group 映射 |
| 独立空间 | Agent 单一根（配置、Workspace、按天会话、memory、资源）、持久数据位置 |
| 模型 | Chat Provider/Model 引用、Thinking、默认与显式选择、已授权替代策略 |
| Prompt | System Prompt、有序区域、自定义内容、资源引用、条件与预算、实际装配结果 |
| Skill | 自有与共享资源、安装来源、版本、发现、选择、启停、更新与卸载 |
| Tool/MCP/Extension/Plugin | 注册能力、依赖、运行位置、授权、来源、版本和装配结果 |
| Memory | Agent Memory、可访问的 Personal/Project Memory、维护策略、来源与修订 |
| 历史连续性 | 活动索引、近期历史、未完成事项、查询入口、Daily 轮换时区 |
| Project | 可见概览及进度、详情与执行范围、参与关系、Session 集合、当前交互焦点和项目资源 |
| 主动工作 | 长期职责、自主安排、自由活动、具体 Task、时间/事件触发、Session 策略、预算、重试和补跑策略 |
| Channel | 入口绑定、发送者权限、Thread、Destination、通知与回复关联 |
| 执行环境 | Docker 镜像、依赖、挂载、网络、CPU/内存、并发、超时、持久卷 |
| 日记与 Social | 整理计划、覆盖日期、信息来源、修订、可见范围 |
| 生命周期 | 创建、暂停、归档、配置重载、运行取消、恢复、数据导出与删除影响 |

生命周期操作必须区分“暂停新工作”“取消某次 Run”“重建环境”“停止 Channel”“归档 Agent”；不能都叫“重启 Agent”，也不能因归档身份就隐式删除项目历史。

## 5. 独立空间与共享空间

### 5.1 目标目录合同

配置根采用 Chat Home 下按稳定 longAgentId 分区的独立目录。**2026-09-09 归一：Long Agent 只有一个根**——`long-agents/<longAgentId>/` 同时是它的 Agent Workspace、日常项目根与资源根，根下按天保存会话。不再存在“Agent Workspace 与 Daily Workspace”两个概念，也不再有单独的 `daily-<longAgentId>` 项目。独立根的身份文件、索引降级、全量隔离与生命周期合同以[管理实体与隔离架构](./chat-long-agent-management.md)为已确认决策；下面仍是目标逻辑布局，分文件 Schema 是后续详细设计项。

~~~text
<CHAT_HOME>/
  agent/                         # Chat Personal 模型目录、认证及共享资源
  prompt-resources/              # Personal Rule / Experience
  long-agents/<longAgentId>/      # 每个 Long Agent 的独立根
    agent.json                   # 身份和能力配置；目标文件名
    prompts/                     # 自定义 Prompt 文件
    skills/                      # 自有 Skill
    tools/                       # 自有工具资源与声明
    extensions/
    plugins/
    memory/                      # Agent Memory（唯一可写位置；S5b 迁入）
    workspace/                   # Agent Workspace，同时是它的日常项目根（cwd）
    sessions/                    # 按天轮换的会话（归一后由 projects/daily-<id> 迁入）
    environments/                # 环境定义与依赖声明
    tasks/                       # 该 Agent 的任务定义，每条明确绑定 Project
  workspaces/longagentshare/     # 公共 Long Agent 资源共享空间（原共享 daily；不默认打开）
  projects/<projectId>/          # 只有用户自己的真实项目
    sessions/                    # Pi 原生 Session
    memory/                      # Chat Project Memory
    prompt-resources/            # Project Rule / Experience
  runtime/                       # 派生快照、同步和执行状态；不是配置事实源
~~~

身份、人格和职责以文件配置为准，不能在 Memory 中另藏一份覆盖身份的定义；Memory 可以保存事实与记忆维护方法，发生冲突时应修正并保留来源。

Project 源码保持原位置，使用 .chat/project.json 与 .chat/config.json。**Long Agent 只有一个根**：`long-agents/<id>/workspace` 就是它的日常项目根与 cwd；业务 Project 的文件不会因为 Agent 参与而搬入它的私有目录。

Agent Memory 保留 NanoClaw Markdown/OKF 的领域合同，通过受控 Resource API 管理。迁移后必须只有一个可写事实位置；不能同时维护 `groups/<folder>/memory` 与 Chat Home 中一份双向同步的副本。NanoClaw 路径适配及迁移顺序见实施状态，尚未实现。

### 5.2 共享资源的边界

模型目录、公共管理 Skill、获授权的 Personal 资源可以共享；引用共享内容不表示复制到每个 Agent。Agent 私有资源不能落入 Personal 全局目录而被其他 Agent 自动继承。

已授权的 Project Memory 可供项目参与者共享；Agent Memory 与独立 Daily 原始数据默认属于该 Agent。项目概览、活动和日记可按持久配置提供共享视图，不要求读取者先成为项目参与者，也不开放整个 Daily 或完整私有历史。概览范围及来源机制见[共享认知设计](./chat-long-agent-awareness-and-autonomy.md)。

目录划分本身不提供执行隔离，访问仍需服务端身份校验与 Docker 执行范围约束。

## 6. 配置事实与服务边界

| 对象 | 事实与管理责任 |
|---|---|
| 身份、Prompt、能力选择、模型引用、环境、长期职责、共享策略及任务/订阅定义 | Chat 文件配置服务；用户与 Agent 共用管理入口 |
| 模型目录与 Credential | Chat 模型/认证服务；Agent 只持有模型和 Credential 引用 |
| NanoClaw Group、Channel/Wiring、触发和投递状态 | NanoClaw 领域服务；通过版本化合同与 Chat 协作 |
| Agent Markdown Memory | NanoClaw Memory 领域服务，单一持久目录 |
| Personal/Project Memory | Chat Catalog 与 Mem0；索引可重建 |
| Session 消息、Tool 结果与 Compaction | Pi SessionManager；Chat 增加产品关联元数据 |
| 活动索引、Social 聚合、配置快照 | 引用源事实的派生视图，不反向覆盖配置或原始消息 |

目标中，NanoClaw 对 Chat 管理的身份和任务定义保存运行投影，不能与 Chat 文件配置分别形成可独立修改的真相。所有允许的原生管理入口必须调用同一配置合同，或明确拒绝修改该受管字段。NanoClaw 独立运行模式不受此产品配置迁移支配。

管理写入必须校验 Schema、引用、权限和 expectedRevision，原子保存，记录来源，再同步所需运行投影。页面区分“已保存”“待应用”“已生效”“应用失败”，不能在 NanoClaw 尚未接收任务时宣称任务已启用。

## 7. 模型与配置解析

Long Agent 模型引用 Chat 模型目录。当前目录/认证服务使用的路径见系统配置；目标不会为每个 Agent 另建 models.json、auth.json，也不读取 ~/.pi 作为产品配置。

解析按字段合同处理：

1. 读取 Chat 共享默认与 Long Agent 自身配置，确定身份和运行能力。
2. 解析当前 Project 的上下文、资源和权限；Project 不隐式覆盖 Agent 身份。
3. 应用明确允许的 Session/本轮调整，保留其范围；历史 Session 中的旧模型不能静默压过已修改的 Agent 持久配置。
4. 校验模型与认证可用性、工具注册及资源权限，冻结本轮有效配置。
5. 下一轮重新解析；重试同一轮使用已有快照，除非显式建立新的执行尝试及配置变更记录。

明确区分修改整个 Agent 的模型、修改某个任务选择和仅调整本轮。替代模型必须来自已配置且已授权的 Chat 策略；实际选用模型及替代原因进入 Run/Turn。

## 8. Prompt 区域

System Prompt 和区域选择来自配置。复用 Workflow Agent 的 Prompt 资源及公共装配机制，不为 Long Agent 建立第二套拼接系统。

| 区域 | 内容与装配要求 |
|---|---|
| 身份与职责 | 当前 Agent 的 System Prompt/职责声明，保持单一配置来源 |
| 当前运行信息 | 服务端注入 Agent、Project、Session、Run、日期、时区和入口 |
| 公共管理知识 | 如何查自身配置、Chat 架构、能力目录及管理 Skill |
| Agent 核心 Memory | 有预算的稳定事实和索引 |
| 近期历史 | 最近工作的摘要与来源入口 |
| 未完成事项 | 持久任务状态、待决策、交接信息 |
| 长期职责与自主安排 | 当前有效职责及范围、关联工作与计划入口，配置和实际进展分开 |
| 可见项目与近期动态 | 按受众解析的有预算概览、来源/更新时间及进一步查询入口；无需用户逐一介绍 |
| 当前 Project | 简短目标、Project Memory/资料入口、当前工作说明 |
| Skill 与 Tool | 当前可发现的 Skill 元信息与实际可用 Tool；Skill 正文按需读取 |
| Rule / Experience | 已选择的资源引用和固定 revision |
| 用户自定义区域 | 可任意新增、命名、排序、编辑、启停，内容或文件引用 |
| 当前 Session 历史 | 由 Pi 构造有效历史；不是另存一份 Prompt 文本 |

区域机制必须表达稳定标识、顺序、来源、作用域、启停、适用条件、预算及截断行为。历史可以继续划分为近期回顾、相关 Session、项目进展等类别。

实际 Tool 注册、权限和可信运行身份由后端保证，自定义文字不能赋予权限。用户可以自由增加自定义区域，无需额外设计脚本语言。

Frontend 检查页与实际执行必须解析到同一份内容和 revision，能解释某个区域为何加载或省略。

## 9. Skill、Tool 与自我管理

能力生命周期统一为：发现 → 选择/授权 → 解析依赖和版本 → 装配 → 执行 → 更新/停用/移除。安装 Skill 不等于其 Tool 已注册，也不等于当前 Agent 已获授权。

- Agent 自写 Skill、维护自己的 Prompt、Memory 或配置，在已授权范围内可直接完成。
- 引入可执行依赖、网络能力、共享资源或更大权限时，按对应 Policy 处理。
- Tool 名必须对应真实 Pi 注册能力；Skill 不得承诺当前工具清单没有的动作。
- 新增资源在下一轮可发现；更新产生新 revision；已冻结的轮次保持原版本。
- 移除资源校验任务和其他资源的引用，返回具体影响，不静默改用同名资源。
- Plugin/Template 保留来源及本地修改信息，更新不能覆盖 Agent 自有内容而不报告冲突。
- Rule/Experience 复用现有 Prompt 资源身份、来源与授权合同，不因“Agent 自主”取消共享规则治理。

NanoClaw 的安装/补丁 Skill 与 Agent 日常使用 Skill 分开管理。前者改变 Host 或安装依赖，后者进入 Agent 资源目录；不能把 /add-wechat 当作普通运行时技能自动执行。

## 10. 每个 Agent 如何知道这些规则

目标提供公共 Long Agent 管理 Skill，并由产品发布机制向每个 Long Agent 提供可发现入口。Skill 是使用工作流和文档导航；完整架构留在本文档组，实际配置留在服务端。

每轮至少具备：

1. 可信的当前身份、Project/Session、日期及时区，以及实际配置版本。
2. 公共管理 Skill 的描述和可读取正文/参考资料入口。
3. 已授权资源目录、真实 Tool 清单和自身有效配置查询能力。
4. 更新后的能力版本信息，使下一轮能发现新增、停用或已移除资源。
5. 可见项目、活动和自身长期职责的发现入口；背景事实来自服务查询，不依赖其他 Agent 口述或重复写入 Memory。

目标管理 Tool 至少覆盖：自身配置读写与预览、模型目录、资源目录及管理、Session/历史检索、长期职责和 Task/订阅管理、环境检查、Project/进度/活动查询与 Memory。具体名称和 Schema 待实施设计，不能把这张能力清单当作当前可调用工具。

本仓库的 chat-architecture Skill 只是开发导航，不会自动安装到运行中的 Long Agent。新公共管理 Skill 的打包、启动安装、引用资料发布、显式资源模式下的发现，以及刷新后生效都必须单独验收。仅在 Git 中新增文档不等于已注入 Nexus。

## 11. 前端必须能够解释运行

Long Agent 详情统一显示身份、配置来源、Prompt 预览、资源、Memory、Project/Session、任务、Channel、Docker 环境、活动与 Social。无需在首屏堆放所有字段，但所有已定义配置必须可达，不能存在只在后端生效而无法查看的隐藏配置。

用户编辑与 Agent 编辑走相同校验、冲突和应用状态。Agent 的修改记录应显示“谁改了什么、为什么、影响哪些后续执行”；敏感值只显示引用，必要运行身份显示可理解的逻辑位置。

## 12. 收口后的详细合同

场景依据见[交互模拟](./chat-long-agent-interaction-simulations.md)及[共享认知与自主工作](./chat-long-agent-awareness-and-autonomy.md)。分类、机制职责、并发和扩展边界以[机制与扩展合同](./chat-long-agent-mechanism-contract.md)收口，不再通过穷举业务完善架构。

后续由实施Agent提交具体合同，以既有场景验证参与者、合作目标、用户介入、信息可见范围与完成标准。复用Chat Session、Project、Pi和现有Workflow能力继续保持，需明确：

- Agent 发起一次调用、双向继续与长期协作的区别。
- 新 Session 中真实参与者的身份，以及用户加入后的显示与权限。
- 多 Agent 加用户的共同会话、发言调度与并发。
- 是否需要外部 A2A 兼容层；不预先引入标准或独立协议系统。
- 取消、等待、结果回传及多方关系的最小表达。

场景中的 Nexus 协调和多个工作 Session 是演练选择，不把树形协作、中央协调者或共享房间确定为唯一模型。
