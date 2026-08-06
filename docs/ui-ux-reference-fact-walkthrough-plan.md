# Chat UI/UX参考产品事实走查计划

> 状态：**事实研究方法与7/10/8目标投入比例已确认；2026-08-01用户看过真实效果后明确移除GitHub Actions，并确认保留Super Productivity及其3组Chat模式取舍。当前活动清单为24个产品、28条流程，A档6个候选加1个空位；0条O完整、1条O局部、27条无O证据。Routine A-RT-01已取得D/S事实并转成MD-01可操作原型，MD-01的4项决定已获用户批准；参考证据等级和后端实现状态不因此提高。**
>
> 日期：2026-08-01
>
> 目标：通过可追溯的产品体验事实，抽取交互逻辑、布局规则、视觉语言和状态表达，为Chat后续界面组合与90%页面交互确认提供输入。
>
> 边界：本轮不研究源码，不修改Chat架构，不把下列产品加入日常正式架构参考集。LibreChat仍是唯一正式外部Web架构主参考；本清单中的24个活动产品只是一次性、限定范围的UX体验研究对象。

Chat的目标载体仍是Web并逐步具备PWA能力。桌面App可以提供局部交互参考，但不能直接证明Web可行；
手机端或响应式没有单独实测时，任何模式都不能获得“移动端已验证”结论。

## 1. 本计划解决什么

这项工作不是收集漂亮截图，也不是选择一个“最像Chat”的产品。它要回答：

1. 在一个明确用户任务中，参考产品的用户从哪里进入、做什么、系统怎样反馈、状态怎样变化、失败后怎样恢复、完成后去哪里。
2. 这些行为由怎样的信息架构、布局、视觉层级和状态语言支撑。
3. Chat究竟采用哪个具体模式、为什么要改造、哪些对象和语义必须拒绝照搬。
4. 哪些Chat关键链路没有直接参考，必须由本项目依据权威状态和用户控制原则自主设计。

研究链路固定为：

> Chat用户场景 → 研究问题 → 参考产品真实任务 → 事实证据 → 交互/布局/视觉模式 → 采用/改造/拒绝/待验证 → Chat原型旅程

截图只证明某一时点的可见画面，不能证明点击行为、数据保存、失败恢复、响应式、跨设备连续性或长期使用效果。

## 2. 从完整用户场景推导6个研究组

以下6组来自已批准的16类场景族，不由现有页面反推。呈现面轴随后用于反查，保证Personal Home、Personal Workspace、Project Dossier、Workflow Run View等已确认界面不被遗漏。

| UX场景组 | 覆盖的场景族 | 用户此刻要回答的问题 | 必须保留的Chat呈现面 |
|---|---|---|---|
| UXG-01 重新定位、捕获与继续 | SCN-01、SCN-07、SCN-11、SCN-13 | 我现在在哪里；今天先继续什么；一条想法先放哪里；换会话或入口后怎样接上 | Personal Home、Activity Rail、Continuous Chat、Conversation Day、Activity Calendar、Idea Garden、权威搜索 |
| UXG-02 自主管理学习与工作 | SCN-02、SCN-03、SCN-04、SCN-06、SCN-16 | 我有哪些事项；某个Project怎样；下一步谁负责；学习、研究和周期工作怎样推进 | Personal Workspace、Today、Project Dossier、Work Board、Plan/Action与责任泳道、Learning Queue、Knowledge、Schedule |
| UXG-03 理解、准备与决定 | SCN-08、SCN-09、SCN-10 | Chat理解成什么；用了哪些Context；准备怎样做；我是否同意 | Intent Review、Clarification、Multi-intent、Context Inspector、Protocol、Workflow Selection、ExecutionDraft、HITL/Approval |
| UXG-04 运行、介入与恢复 | SCN-09、SCN-10、SCN-12、SCN-16 | 现在运行到哪里；为什么走这条路；我能否暂停、纠正、重试或恢复 | Workbench、Workflow Run View、节点与真实路径、Agent/Tool活动、Tool Ledger/Diff、Run Timeline、Recovery |
| UXG-05 结果、证据与交付 | SCN-04、SCN-05、SCN-06、SCN-09、SCN-10、SCN-14、SCN-16 | 产出了什么；是否可信；是否已接受和送达；以后怎样继续使用 | Artifact Preview/Gallery、Evidence、Provenance、Validation、Result Commit、Delivery/Receipt、Memory Review、Daily/Weekly Review |
| UXG-06 配置、身份、跨入口与运营 | SCN-11、SCN-13、SCN-14、SCN-15 | 实际使用了哪个配置；谁有权限；不同载体怎样继续；运营者怎样可信看护整体 | Configuration Center、Identity/Scope、手机与Channel、Obsidian/第三方投影、Super Admin Console、Admin Audit、Diagnostics |

同一场景可以跨多个呈现面，同一呈现面也可以服务多个场景。Workbench只是布局容器，Workflow Run View是运行投影，Canvas是未来空间型Artifact，三者不能合并。

## 3. 证据标签和结论上限

每条事实都必须带证据ID，例如O03或D02。

| 标签 | 证据类型 | 可以证明 | 不得外推 |
|---|---|---|---|
| O 实机观察 | 在记录日期、账号、套餐、平台和视口下亲自完成的操作 | 该环境中真实发生的入口、动作、反馈和状态转换 | 其他版本、权限、设备或未操作分支 |
| D 官方说明 | 官方帮助、产品文档、发布说明或完整官方演示 | 官方公开承诺的功能与规则 | 当前实例一定无缺陷、长期效果、未演示状态 |
| S 截图事实 | 带上下文的当前截图 | 当时可见的结构、文字、层级和样式 | 按钮行为、保存、恢复、动效、响应式 |
| U 用户报告 | 公开或授权取得的真实用户反馈 | 某些用户遇到的困难、习惯和感受 | 普遍频率、产品机制、实测事实 |
| I Chat推断 | 基于O/D/S/U形成的项目判断 | Chat的候选映射、组合和取舍 | 参考产品事实或已确认设计 |

没有证据时必须写“未验证”或“未涉及”。用户报告只作补充，不能替代产品实测。

## 4. A/B/C研究深度

| 层级 | 数量 | 研究量 | 最低完成门 | 可以形成的结论 |
|---|---:|---:|---|---|
| A 深拆 | 目标7个；当前6个+1个空位 | 每个3条完整流程；当前18条 | 先声明中心主张；O实机走通起点到终点和全部中心主张；逐步截图或录屏；记录环境；安全时实测至少1个与研究问题相关的非正常状态；D官方说明补证 | 仅对取得匹配O证据的主张写“已实测”，并抽取交互、布局、视觉和状态规则 |
| B 专项拆 | 10个产品 | 每个1条限定流程，共10条 | 先声明限定流程的中心主张；O实机完成该流程和中心主张；记录关键前后状态与环境；D官方说明补证 | 只为取得匹配O证据的局部主张背书，不能外推整个产品 |
| C 视觉/概念 | 8个产品 | 不计入实测流程 | D官方表达或S带上下文截图 | 只形成可见视觉或概念候选，不能声称交互、保存或恢复已验证 |

A或B产品无法登录、付费能力不可用、没有真实数据、无法安全触发关键状态时必须降级为D官方说明、
S截图事实或未验证。当前活动研究问题总数为28，另行统计“O完整、O局部、D/S、未验证”4种实际结果；
只有O完整进入有效实测完成数。

替补按单条研究问题处理，不按整个产品自动升降：B档产品不会因为A档产品不可访问，就自动继承其余
3条流程。任何替换必须证明它回答同一个研究问题、重新列出关键状态和最低证据门，并由用户审核后
替换候选分母。

研究不得修改用户的生产数据。需要创建内容、失败Run、分享或多角色评审时，使用专用测试内容和可撤销范围；涉及付费、对外发送、真实发布或其他外部副作用时另行取得用户授权。

### 4.1 主张级证据门

“走过正常路径”不能自动证明整条交互。每个结论还要通过与主张类型匹配的门：

| 要声称的内容 | 必须取得的O实机证据 | 只有D/S时怎样写 |
|---|---|---|
| 已保存或可恢复 | 刷新、关闭后重开或产品支持的重新进入，确认同一状态仍存在 | “官方说明会保存”或“截图中显示已保存”，不能写已实测 |
| 跨视图一致 | 在两个视图中确认是同一对象或同一稳定身份，并观察一次修改同步 | 只能分别描述两个画面 |
| 双角色、权限或Delivery | 使用第二角色/身份实际接收、拒绝、撤权或查看回执 | 只能描述官方权限规则，不声称闭环 |
| 失败与恢复 | 安全触发与研究问题相关的失败、中断或取消，再实际执行恢复动作 | 只能写官方恢复入口或历史截图可见 |
| 移动端与响应式 | 在真实手机浏览器、官方移动App或单独的移动运行环境完成关键动作 | 桌面缩窄或营销图不能写移动端已验证 |
| 跨日或周期 | 在真实日界线、产品支持的测试机制或另一实际触发周期中重新进入 | 只能写官方周期规则 |
| 版本与比较 | 创建或取得至少两个真实版本，并验证切换、差异和返回 | 不能由版本按钮存在推断比较行为 |
| 来源与失效 | 打开真实来源，并安全验证删除、撤权或失效后的产品反应 | 只能写“来源链接可见” |

流程结果使用4类状态：

- **O完整**：起点到终点和回答该研究问题所必需的全部中心主张均取得匹配的O证据。
- **O局部**：正常路径或部分中心主张已实测，其余明确标为D、S或未验证。
- **D/S**：没有形成足够的实机交互事实，但取得了与主张匹配的官方说明或带上下文截图。
- **未验证**：没有取得足够证据回答该研究问题。

“A/B目标深度”是研究投入，不是完成状态。

## 5. 24个活动候选产品总览

### 5.1 A档：7个深拆产品

| 编号 | 产品与候选官方入口 | 计划流程 | 主要Chat映射 | 当前访问门槛与降级 |
|---|---|---:|---|---|
| A01 | [Super Productivity](https://app.super-productivity.com/) | 3 | Home、Workspace、Today、Project Dossier、Work Detail | 用户已确认保留；匿名Web已完成环境预检与1条O局部流程，另2条仍为D/S与未验证段；不得从官方演示外推保存、返回或恢复 |
| A02 | [Routine Quick Tour](https://help.routine.co/articles/4807448-quick-tour) | 3 | Capture、Home、Calendar、Conversation Day、Review | D-ACCESS-A02；O登录/流程：未验证；I计划：取不到环境则对应流程保持未验证，另提Sunsama单流程替换审核 |
| A03 | [Linear Project Overview](https://linear.app/docs/project-overview) | 3 | Workspace、Project Dossier、Work Board、Search | D-ACCESS-A03；O登录/流程：未验证；I计划：无法跨3层或安全写入时，对应流程保持未验证，另提Plane单流程替换审核 |
| A04 | [Capacities Daily Notes](https://docs.capacities.io/reference/dates-and-daily-notes) | 3 | Idea、Knowledge、Dossier、Context与关系 | D-ACCESS-A04；O登录/流程：未验证；I计划：关系流程失败时另提Anytype单流程替换审核 |
| A05 | [Dropbox Replay](https://www.dropbox.com/replay) | 3 | Artifact、Review、Evidence、Version、Delivery | D-ACCESS-A05；O登录/流程：未验证；I计划：无双角色或付费能力时只保留已验证段 |
| A07 | [Replit Agent](https://docs.replit.com/learn/build-with-agent) | 3 | Intent/Plan、Workflow Run、HITL、Artifact迭代 | D-ACCESS-A07；O登录/流程：未验证；I计划：关键流程不可测时保持未验证，另提Manus单流程替换审核 |

`A06`稳定编号不复用。2026-08-01用户在看到真实运行列表、失败Run摘要和Step日志效果后，明确拒绝
GitHub Actions式开发者流水线界面；该产品及`A-GA-01`至`A-GA-03`已退出活动候选与流程分母。
此前观察只保留为拒绝决定的来源，不再向Chat贡献交互、布局或视觉模式。A档当前留下1个空位，未经
用户先看真实效果并认可，不自动用Vercel、Sentry或其他产品补位。

### 5.2 B档：10个专项产品

| 编号 | 产品与候选官方入口 | 限定研究主题 | 主要Chat映射 |
|---|---|---|---|
| B01 | [Leantime](https://leantime.io/features/) | Project健康摘要下钻到真实阻塞 | Workspace、Project Dossier |
| B02 | [Plane Personal Home](https://docs.plane.so/core-concepts/account/overview) | Cycle/Module到Work Item并保持视图 | Dossier、Work Board、Work Detail |
| B03 | [Vikunja公开Demo](https://try.vikunja.io/) | Quick Add后在List/Board保持同一事项 | Workspace、Work Board |
| B04 | [RemNote](https://www.remnote.com/) | 学习记录进入复习队列并产生反馈 | Learning Queue、Knowledge、Home |
| B05 | [Reader by Readwise](https://readwise.io/read) | 高亮重现时返回来源与上下文 | Knowledge、Review、Context、Evidence |
| B06 | [Sunsama](https://www.sunsama.com/) | 容量约束下安排、完成和结转一天 | Home、Workspace、Schedule |
| B07 | [Anytype Queries](https://doc.anytype.io/anytype/organize/queries) | 同一对象进入多个关系视图而不复制 | Dossier、Knowledge |
| B08 | [Vercel Deployments](https://vercel.com/docs/deployments) | 构建、Preview、Redeploy与Promote的状态区分 | Run View、Artifact、Delivery |
| B09 | [Sentry Trace View](https://sentry.io/changelog/the-new-trace-view-is-generally-available/) | 从Issue进入Event/Trace并跟踪解决/回归 | Trace、Evidence、Operations |
| B10 | [Manus](https://manus.im/) | 长任务的Plan、Run、Artifact、Source和下一版 | Intent、Run View、Artifact、Evidence |

### 5.3 C档：8个视觉或概念产品

| 编号 | 产品与候选官方入口 | 只观察什么 | 绝不由此声称什么 |
|---|---|---|---|
| C01 | [Day One](https://dayoneapp.com/) | Today、Calendar、Conversation Day和日记的时间视觉 | 跨日保存、恢复和Chat工作状态已验证 |
| C02 | [mymind](https://mymind.com/) | 低摩擦捕获、Top of Mind和视觉卡片 | 自动整理适合Project/Work或可审计 |
| C03 | [AFFiNE](https://affine.pro/) | Page与Edgeless、文档到空间视图 | Canvas可成为Chat默认工作台或事实源 |
| C04 | [AppFlowy](https://appflowy.com/) | Workspace、多视图、移动详情 | 任意Schema适合Chat权威对象 |
| C05 | [Memmy Getting Started](https://memmy.bot/docs/start/getting-started/) | Memory卡片、来源、范围和纠正的可见表达 | 扫描结果可以自动成为Accepted Memory |
| C06 | [Mem0 Self-hosted Dashboard](https://docs.mem0.ai/open-source/setup) | Memory实体、Scope、历史、删除和管理分区 | API控制台适合普通用户或其对象模型应被照搬 |
| C07 | [MemOS Cloud Quick Start](https://memos-docs.openmem.net/memos_cloud/quick_start/) | Preserve、Update、Transfer、Rollback等操作词 | 已有成熟最终用户工作台或恢复交互 |
| C08 | [TencentDB Agent Memory](https://cloud.tencent.com/document/product/1813/132100) | 短期Context、长期Memory和来源治理概念 | 企业云控制台可以替代个人Chat体验 |

以上链接是研究入口，不是已经取得的交互证据；正式走查开始时仍需记录访问日期、版本、套餐、设备和实际可达范围。

### 5.4 当前可执行性标签

2026-08-01只完成了访问预检，必须分开理解：

- **O-ACCESS-01 匿名入口预检**：当前24个活动候选的官方入口在匿名HTTP预检时均返回200；这只证明当时URL有响应，不证明页面可交互、账号可登录或流程可走通。
- **LOGIN-GATE**：当前24个活动候选均未在本计划中完成登录实测。
- **FLOW-GATE**：当前28条活动流程为0条O完整、1条O局部、27条无O证据；A-SP-01只完成匿名桌面Web的快速捕获与Today落位，未完成跨Project整理、跨日与恢复主张；已拒绝候选的历史预看不计入活动研究进度。

下表中的`D-ACCESS-*`是平台、套餐或准备成本的官方说明证据。访问日期统一为2026-08-01；事实只按链接页面的公开表述记录，不外推账号实际可用性。

| 证据ID | 产品 | 本轮访问门事实 | 精确官方来源 |
|---|---|---|---|
| D-ACCESS-A01 | Super Productivity | 官方提供Web App；计划先验证免账号使用边界 | [Web App](https://app.super-productivity.com/)、[产品页](https://super-productivity.com/) |
| D-ACCESS-A02 | Routine | 实际App需账号；完整Dashboard与Contextual Capture的可用平台/套餐需按官方说明核对 | [Quick Tour](https://help.routine.co/articles/4807448-quick-tour)、[Dashboard](https://www.routine.co/features/dashboard)、[Pricing](https://www.routine.co/pricing) |
| D-ACCESS-A03 | Linear | Project能力有免费账号路径；真实跨层流程仍需登录和自建数据 | [Project Overview](https://linear.app/docs/project-overview)、[Pricing](https://linear.app/pricing) |
| D-ACCESS-A04 | Capacities | Basic提供核心对象能力；Task、Calendar Integration与Smart Queries等受套餐限制 | [Daily Notes](https://docs.capacities.io/reference/dates-and-daily-notes)、[Pricing](https://capacities.io/pricing) |
| D-ACCESS-A05 | Dropbox Replay | 实际评审需Dropbox账号；Version Compare受Replay套餐限制 | [Replay](https://www.dropbox.com/replay)、[Replay plans](https://www.dropbox.com/plans) |
| D-ACCESS-A07 | Replit Agent | 实际Agent需账号；免费档额度与复杂任务成本以官方定价为准 | [Build with Agent](https://docs.replit.com/learn/build-with-agent)、[Pricing](https://replit.com/pricing) |
| D-ACCESS-B01 | Leantime | Cloud体验需账号；官方提供试用，Community Edition需自行部署 | [Features](https://leantime.io/features/)、[Pricing](https://leantime.io/pricing/) |
| D-ACCESS-B02 | Plane | Cloud有免费路径；完整Project Overview能力可能受套餐限制 | [Personal Home](https://docs.plane.so/core-concepts/account/overview)、[Pricing](https://plane.so/pricing) |
| D-ACCESS-B03 | Vikunja | 官方公开Demo可用于测试，数据会重置且不得放真实内容 | [Public Demo及页面说明](https://try.vikunja.io/)、[Pricing中的Live Demo说明](https://vikunja.io/pricing/) |
| D-ACCESS-B04 | RemNote | 核心学习能力有免费账号路径；部分考试和高级能力受Pro限制 | [Spaced Repetition](https://www.remnote.com/feature/spaced-repetition)、[Pricing](https://www.remnote.com/pricing) |
| D-ACCESS-B05 | Reader by Readwise | 实际产品需账号；官方提供试用，持续使用受订阅限制 | [Reader](https://readwise.io/read)、[Pricing](https://readwise.io/pricing/reader) |
| D-ACCESS-B06 | Sunsama | 实际体验需账号；官方提供限时试用，之后订阅 | [Daily Planning](https://www.sunsama.com/features/daily-planning-and-shutdown)、[Pricing](https://www.sunsama.com/pricing) |
| D-ACCESS-B07 | Anytype | 官方客户端覆盖桌面与移动平台；没有可直接承担本轮完整Web实测的公开Web App | [Queries](https://doc.anytype.io/anytype/organize/queries)、[Platform feature list](https://doc.anytype.io/anytype-docs/advanced/feature-list-by-platform/graph) |
| D-ACCESS-B08 | Vercel | Dashboard可从Hobby账号进入，但真实流程需要自备并部署Project | [Deployments](https://vercel.com/docs/deployments)、[Pricing](https://vercel.com/pricing) |
| D-ACCESS-B09 | Sentry | 有开发者免费路径；真实Trace流程需要创建Project并发送数据 | [Trace View](https://sentry.io/changelog/the-new-trace-view-is-generally-available/)、[Pricing](https://sentry.io/pricing/) |
| D-ACCESS-B10 | Manus | 实际产品需账号和credits；可用额度与并发受套餐限制 | [Plan Mode](https://manus.im/blog/manus-plan-mode)、[Pricing](https://manus.im/pricing) |
| D-ACCESS-C01 | Day One | Web需账号；Calendar与Daily Chat等能力的套餐边界需分别核对 | [Web App](https://dayoneapp.com/web/)、[Plans](https://dayoneapp.com/plans/) |
| D-ACCESS-C02 | mymind | 实际App需账号；公开视觉可直接看，完整能力受账号与套餐限制 | [产品页](https://mymind.com/)、[Pricing](https://access.mymind.com/pricing) |
| D-ACCESS-C03 | AFFiNE | 官方提供Web入口和免费路径；实际交互仍需注册验证 | [Web App](https://app.affine.pro/)、[Pricing](https://affine.pro/pricing) |
| D-ACCESS-C04 | AppFlowy | 官方提供浏览器产品和免费路径；实际交互仍需账号验证 | [Browser说明](https://appflowy.com/blog/AppFlowy_is_now_right_in_your_browser)、[Pricing](https://appflowy.com/pricing) |
| D-ACCESS-C05 | Memmy | 终端体验需要桌面端或CLI，不是免安装Web工作台 | [Getting Started](https://memmy.bot/docs/start/getting-started/) |
| D-ACCESS-C06 | Mem0 | Platform需账号/API Key；自托管Dashboard还需本地运行环境与Provider配置 | [Platform Quickstart](https://docs.mem0.ai/platform/quickstart)、[Self-hosted Dashboard](https://docs.mem0.ai/open-source/setup) |
| D-ACCESS-C07 | MemOS | Cloud体验需注册、登录和API Key；公开入口主要用于文档与产品说明 | [Cloud Quick Start](https://memos-docs.openmem.net/memos_cloud/quick_start/) |
| D-ACCESS-C08 | TencentDB Agent Memory | 实际控制台需要腾讯云账号、实名与实例；费用以官方计费说明为准 | [接入准备](https://cloud.tencent.com/document/product/1813/132102)、[购买指南](https://cloud.tencent.com/document/product/1813/132103) |

可达页面不等于可实测流程。实际研究层级只由第4节证据门决定。

## 6. 28条待走查流程

### 6.1 A01 Super Productivity

| ID | 研究问题 | 起点 → 终点 | Chat映射 | 重点状态 | 降级条件 |
|---|---|---|---|---|---|
| A-SP-01 | 用户怎样把收件、逾期和跨Project事项整理成今天真正能开始的行动序列 | 混合待办 → Today整理/排序/排除 → 打开第一项 | UXG-02；Home、Workspace、Today | 空态、跨Project、逾期、容量不足、撤销、完成、结转 | 未走通整理→开始，或只有样例数据 |
| A-SP-02 | 用户怎样在Project、具体工作、子任务和信息之间切换并保持原上下文 | Project概览 → Work Detail/子任务/备注 → 保存 → 返回原位置 | UXG-02；Workspace、Dossier、Work Detail | 空Project、层级、阻塞、未保存、保存、完成、筛选/滚动恢复 | 未验证返回上下文，只保留布局事实 |
| A-SP-03 | 工作被打断后怎样恢复并在历史中确认记录 | 开始专注/计时 → 暂停/中断 → 恢复或结束 → Work Log | UXG-02/04；Workspace、当前行动、Review | 未开始、进行、暂停、恢复、放弃、完成、重复点击 | 未形成并恢复真实记录；不得外推Product Run |

#### 6.1.1 首轮事实卡：环境与结论上限

> 模式状态：**Super Productivity作为A档参考保留；2026-08-01用户已批准下列“采用/改造/拒绝”作为Chat交互方向。批准不提高O证据等级，不表示完整界面旅程已经确认，也不授权Schema或代码实现。**

| 证据ID | 类型 | 2026-08-01事实 | 结论上限 |
|---|---|---|---|
| O-SP-ENV-01 | O | 匿名桌面Web App，1280×720，首次进入选择`Productivity Suite`；初始Today为空，页面同时提供Today、Inbox、Planner、Schedule、Boards、Habits、Projects、Tags和全局操作栏 | 只为该匿名本地环境背书；没有登录、同步、移动端、跨设备或长期保存结论 |
| O-SP-01A | O | 空Today显示`No tasks planned`，计时按钮禁用并提示先添加任务；全局`+`打开快速录入，字段包含标题、Inbox、Today、Estimate与Repeat。保存1条测试任务后，Today计数变为1、Inbox计数由4变5，任务行保留Inbox来源，计时按钮变为可用 | A-SP-01为**O局部**；证明“快速捕获→Today落位→来源可见→第一项可开始”的局部链，不证明跨Project排序、逾期、容量、撤销、结转或刷新恢复 |
| O-SP-02A | O片段 | 在Today点击任务标题后，任务行原位进入标题编辑，Today列表与来源标签仍留在同一画面 | 不是A-SP-02完成证据；未打开Project概览、完整详情、Notes，也未验证保存与返回原筛选/滚动位置 |
| O-SP-03A | O片段 | 空Today时全局计时按钮不可用；任务落入Today后按钮转为`Start/stop tracking time`可用 | 只证明开始计时的前置状态，不证明开始、暂停、恢复、停止、重开或History记录 |

本轮没有读取源码。Web App在引导页明确提示：未配置同步时数据留在当前设备；这不能替代Chat的服务端
权威事实、认证、授权或恢复保证。

#### 6.1.2 A-SP-01：跨Project行动队列

**第一方视觉事实。** 2026-08-01仍由官方商店公开展示的
[Today截图](https://play-lh.googleusercontent.com/Go6bV9BkJ8_dLSEHs2vqPVYMu2hlWGaDftqSIbI_NALqvAH6a74VJfxi-fY5r_fvyGN1L0soUYRF3u_b-fJpsg=w1052-h592-rw)
中，同一Today列表聚合了带`Work`、`Personal`和`Open Source` Project标签的任务；任务行同时显示估时、
普通标签与`Later Today`分段，顶部展示当日剩余估时、已工作时长和无休息时长。该图片来自
[Google Play官方上下文页](https://play.google.com/store/apps/details?hl=en&id=com.superproductivity.superproductivity)，
自身无版本水印，因此只记为S事实，不写成当前版本的逐像素实测。

**官方交互规则。** 官方人工维护Wiki说明：每条任务只属于1个Project；排到今天会进入Today，改到未来
日期会离开Today；Today拥有独立于Project/Tag列表的用户自定义顺序，可拖拽或用键盘重排，且该顺序会
保存。Today在午夜切换日期，设为今天较晚时间的任务可能直到对应时间才出现。证据见
[Today View](https://github.com/super-productivity/super-productivity/wiki/4.01-The-Today-View)、
[Project View](https://github.com/super-productivity/super-productivity/wiki/4.06-Project-View)与
[Task Attributes](https://github.com/super-productivity/super-productivity/wiki/4.09-Task-Attributes)。
这些D事实补足产品规则，但不能替代本轮未做的跨日、拖排与重开O验证。

**公开用户信号。** 部分用户把Today当作跨Project、手工排序且未完成继续保留的行动队列，而不是单纯
“今日到期”切片；Overdue上线后出现重新移回Today与顺序变化的额外整理成本
（[#4406](https://github.com/super-productivity/super-productivity/issues/4406)、
[#4392](https://github.com/super-productivity/super-productivity/issues/4392)、
[#4660](https://github.com/super-productivity/super-productivity/issues/4660)）。另有讨论要求把“计划哪天做”
与“真正截止日”分开（[#4521](https://github.com/super-productivity/super-productivity/discussions/4521)）。
这些是主动反馈，能暴露风险，不能估计发生率。

**Chat已批准取舍。**

1. **已批准采用**：Today只承担“用户此刻选中的可开始行动序列”；任务行保留Project、责任主体、阻塞和来源上下文。
2. **已批准改造**：`计划日期`、`真正截止时间`、`跨日结转决定`和`手工优先顺序`分开建模与呈现，不能让一个日期字段同时承担4种语义。
3. **已批准拒绝**：不把跨Project聚合压成无来源清单，不用生产力评分或连续打卡暗示用户做得好坏，也不让浏览器本地数据成为Chat权威事实。

#### 6.1.3 A-SP-02：任务层级与上下文往返

**第一方视觉事实。** 官方Press Kit仍公开的
[Schedule Day Planner截图](https://super-productivity.com/images/screenshots/schedule-day-panel-light.png)
把Inbox任务列表与单日日程并排，父任务在列表原位展开2个子任务；这证明任务层级可以原位展开，不证明
Project Dossier、Notes编辑、保存或返回恢复。上下文见[官方Press Kit](https://super-productivity.com/press-kit/)。

**官方交互规则。** Project View只展示该Project的任务，并提供Project Notes、Settings与可选Backlog；
任务可打开侧边详情。Task Note支持Markdown和Checklist；子任务是拥有独立ID、完成状态、Note和计时的
真实任务，父任务聚合进度与时间。证据见
[Project View](https://github.com/super-productivity/super-productivity/wiki/4.06-Project-View)、
[First Steps](https://github.com/super-productivity/super-productivity/wiki/1.01-First-Steps)、
[Task Notes](https://github.com/super-productivity/super-productivity/wiki/4.10-Task-Notes)与
[Subtasks](https://github.com/super-productivity/super-productivity/wiki/4.11-Subtasks)。官方资料没有说明详情究竟
自动保存、失焦保存还是显式保存，也没有说明返回后是否恢复原Project、展开层级、选中对象和滚动位置。

**公开用户信号。** 已有用户分别报告从详情返回时跳错位置、详情开关不对称、切换任务后详情仍显示旧对象
等风险（[#3607](https://github.com/super-productivity/super-productivity/issues/3607)、
[#5272](https://github.com/super-productivity/super-productivity/issues/5272)、
[#5435](https://github.com/super-productivity/super-productivity/issues/5435)）。这些报告不证明当前桌面Web普遍存在缺陷，
但要求Chat把返回锚点、当前对象身份和开关对称性列为正式验收项。

**Chat已批准取舍。**

1. **已批准采用**：轻量子任务可在Work列表原位展开；编辑时保留Project或当前队列的空间上下文。
2. **已批准改造**：Project Dossier仍是完整Project档案，Work Detail使用稳定对象ID；关闭后恢复原筛选、滚动和选中位置，保存中/成功/失败必须可见。
3. **已批准拒绝**：不把原位子任务展开冒充Project Dossier；不允许详情面板显示旧对象而用户已经选择新对象。

A-SP-02当前结果为**D/S**：只有O片段和第一方视觉证据，尚无Project→Detail→保存→返回的完整O链。

#### 6.1.4 A-SP-03：任务计时与历史

**第一方演示事实。** 官方Press Kit的
[Standard Layout演示视频](https://super-productivity.com/videos/standard-light.webm)
显示：给任务设置2小时估时后开始计时，全局Play变Pause、任务行高亮并出现暂停控件，剩余估时递减；
完成后任务进入Done Tasks并显示累计时长。视频没有展示History/Work Log、周月统计、日志修订、导出或
重开恢复，因此这些仍未验证。

**官方交互规则。** 同一时刻只有1个活动计时任务，启动另一任务会切换目标；Pause后累计总时间与按日
时间保留，再次Play即继续。停止计时、完成任务与`Finish Day`是3个不同动作，`Finish Day`只归档已完成
任务并进入日终报告。当前统一历史入口名为`History`，旧Worklog/Quick History路由也进入该视图；历史
按任务、日期和时长展示，并由活动/归档任务的按日时间计算，父任务为避免重复不再次累计子任务时间。
History在打开或手动刷新时重算，不会在追踪过程中持续实时刷新。证据见
[How Time Is Logged](https://github.com/super-productivity/super-productivity/wiki/4.14-How-Time-Is-Logged)、
[Timers and Focus Mode](https://github.com/super-productivity/super-productivity/wiki/4.15-Timers-and-Focus-Mode)、
[Worklog](https://github.com/super-productivity/super-productivity/wiki/4.21-Worklog)与
[Time Tracker](https://super-productivity.com/use-cases/time-tracker/)。公开资料仍不足以证明浏览器崩溃、断电或
最后一个tick的恢复保证。

**公开用户信号与能力边界。** 维护者在两个独立讨论中说明产品长期保存的是按日累计，而不是每次开始/结束
的会话时间戳（[#2476](https://github.com/super-productivity/super-productivity/discussions/2476)、
[#3578](https://github.com/super-productivity/super-productivity/discussions/3578)）；2026年的会话级计时请求获得较集中支持
（[#6378](https://github.com/super-productivity/super-productivity/issues/6378)）。另有少量版本或平台特定的暂停后
多算、后台重开后丢时报告；它们只能作为异常测试线索，不能外推当前Web实例。

**Chat已批准取舍。**

1. **已批准采用**：当前行动与开始/暂停控制保持近距离，运行中在任务行和全局栏同时给出明确反馈。
2. **已批准改造**：用户专注计时、Product Run、Provider/Tool耗时、Worker活动和登录活跃时长必须是不同指标；每项标明来源、口径、数据新鲜度和未知状态。
3. **已批准拒绝**：Work Log不能冒充Run Trace或Evidence；只有每日累计时长时，不能绘制虚构的连续会话区间，也不能声称恢复过一次中断。

A-SP-03当前结果为**D/S**：已观察开始按钮前置状态，但未完成真实开始、暂停、恢复、结束与History核对。

### 6.2 A02 Routine

| ID | 研究问题 | 起点 → 终点 | Chat映射 | 重点状态 | 降级条件 |
|---|---|---|---|---|---|
| A-RT-01 | 用户怎样低成本捕获未分类内容，之后归为任务、笔记或日程且保留原始表达 | 任意入口输入 → Quick Capture → 归类/关联 → 在目标位置重新找到 | UXG-01；Chat输入、Capture、Idea、Conversation Day | 空输入、类型不确定、重复、保存中/失败、撤销、重新归类、移动端 | 未完成捕获→归类→找回，或来源只能推断 |
| A-RT-02 | 用户怎样在日历占用和待办之间协商时间并处理冲突 | 今日待办+日历 → Timeblock/重排 → 处理冲突/超载 → 可行日计划 | UXG-02；Home、Workspace、Schedule | 无任务、无空档、冲突、拖动、重排、删除、超载、保存失败 | 只能看演示；未实测移动端不得外推触摸 |
| A-RT-03 | 日终怎样处理完成、继续和放弃，并形成下一日可信入口 | 当日混合状态 → Review → 完成/结转/放弃 → 下一日入口 | UXG-01/02/05；Home、Conversation Day、Daily Journal | 空日、全部/部分完成、逾期、结转、放弃、日界线、撤销 | 未跨日验证时只为当天操作背书 |

#### 6.2.1 A-RT-01事实卡与Chat取舍（2026-08-01）

本次未登录、未创建数据，结果为 **0条O、9组D、3组S**。它仍属于“无O证据”流程，但公开事实已经足够支持
MD-01的有限吸收，不需要继续扩大Routine研究范围。

| 证据 | 等级 | 事实 | Chat结论 |
|---|---|---|---|
| D-RT-01 | D | [Dashboard](https://help.routine.co/articles/0079805-dashboard)可从桌面全局唤起；临时隐藏再打开时未提交文字仍在 | 采用全局入口；不能把暂存草稿冒充服务端保存 |
| D-RT-02 | D | [Console](https://help.routine.co/articles/9217592-console)列出命令候选、贴近输入展示理解，并允许指定父对象 | 采用可检查反馈；改造成类型未定候选，不静默默认Task |
| D-RT-03 | D | [Quick Tour](https://help.routine.co/articles/4807448-quick-tour)与[Inbox](https://help.routine.co/articles/4471171-inbox)支持先捕获、后集中处理 | 采用延后整理；稳定找回入口改为Garden待整理区 |
| D-RT-04 | D | [Redirection](https://routine.co/features/redirection)与[Hierarchy](https://help.routine.co/articles/6411531-hierarchy)支持捕获时归位和事后移动 | 关联或升级必须保留原话、来源与关系，不能只改父层级 |
| S-RT-01—03 | S | 中央轻量输入层、输入附近的解析结果和统一Inbox可见 | 只支持布局/视觉，不证明保存、撤销或恢复 |

公开材料未证明类型中立保存、保存失败恢复、普通Undo、原文回链、幂等重试或移动端同等语义；这些均由Chat
自主设计并明确标为待实现。完整采用/改造/拒绝与4项待审核决定见
[MD-01设计档案](./ui-ux-modules/md-01-quick-capture-and-idea-destination.md)。

### 6.3 A03 Linear

| ID | 研究问题 | 起点 → 终点 | Chat映射 | 重点状态 | 降级条件 |
|---|---|---|---|---|---|
| A-LN-01 | 用户怎样在Workspace、Project、周期和事项间保持方向感 | Workspace → Project/时间范围 → 筛选 → Work Detail → 返回 | UXG-02；Workspace、Dossier、Board | 空/多Project、大量事项、筛选无结果、完成范围、权限、返回上下文 | 未跨至少3层或未验证返回 |
| A-LN-02 | 用户怎样在高密度详情中理解状态、责任、关联和历史并完成一次安全修改 | 列表 → Work Detail → 修改字段/说明 → 反馈 → 列表同步 | UXG-02；Dossier、Work Detail、Board | 只读、编辑、保存中/成功、校验失败、权限、并发、撤销、Activity | 未实际写入和验证跨视图一致 |
| A-LN-03 | 熟练用户怎样跨Project找到对象并返回原工作 | 深层页面 → Search/Command → 目标预览/打开 → 安全动作 → 返回 | UXG-01/06；Search、Command、Workspace | 无最近项、无结果、同名、跨Project、键盘、权限、危险确认、返回 | 只见命令面板，未验证打开与返回 |

### 6.4 A04 Capacities

| ID | 研究问题 | 起点 → 终点 | Chat映射 | 重点状态 | 降级条件 |
|---|---|---|---|---|---|
| A-CP-01 | 用户怎样先自由记录，再把有长期价值的内容转成稳定对象并保留原记录关系 | Daily Note/自由文本 → 转为对象 → 属性/关联 → 集合与原记录找回 | UXG-01/03；Idea、Conversation Day、Knowledge | 空记录、未分类、类型选择、重复、属性不全、保存、原文关联、撤销 | 未验证原记录与新对象双向关系 |
| A-CP-02 | 用户怎样从对象集合进入完整档案并返回原筛选位置 | Type/Collection → 筛选/排序 → Detail → 返回 | UXG-02；Dossier、Knowledge、Workspace | 空/大集合、无结果、属性缺失、只读、返回位置、移动层级 | 未验证往返或筛选保持 |
| A-CP-03 | 用户怎样理解对象与Project、记录和来源为什么相关 | Object Detail → Relations/Backlinks → 来源对象 → 返回/修改关系 | UXG-03/05；Context、Dossier、Evidence | 无/多关系、来源失效、权限、增删关系、返回、重复 | 不能打开来源或验证关系写入；不得冒充Provenance |

### 6.5 A05 Dropbox Replay

| ID | 研究问题 | 起点 → 终点 | Chat映射 | 重点状态 | 降级条件 |
|---|---|---|---|---|---|
| A-DR-01 | 创建者怎样让评审者知道评审哪个版本和从哪里反馈 | 待评审Artifact → 分享/权限 → 评审者打开 → 状态变为待评审 | UXG-05；Artifact、Review Inbox、Dossier Recent Outputs | 无版本、上传/处理、待评审、链接无效、权限、加入、撤销、重复邀请 | 未用双角色验证时不声称完整评审闭环 |
| A-DR-02 | 反馈怎样锚定到具体位置，并保留回复、解决和重开历史 | 定位时间点/区域 → 评论 → 回复/修改 → Resolve → 重新打开 | UXG-05；Artifact、Evidence、Review Thread | 新/未读评论、回复、待处理、解决、重开、版本漂移、网络失败 | 未完成双角色往返或历史复查 |
| A-DR-03 | 用户怎样区分旧版、新版、修改请求、批准和真正交付 | 旧版反馈 → 新版 → 比较 → Approve/Request changes → Delivery/Receipt | UXG-05；Artifact Version、Evidence、Delivery | 旧/新版、处理中、待修改/批准、已批准、被替代、交付中/失败/送达 | 任一关键段未实测，只为完成段背书 |

### 6.6 A07 Replit Agent

| ID | 研究问题 | 起点 → 终点 | Chat映射 | 重点状态 | 降级条件 |
|---|---|---|---|---|---|
| A-RA-01 | 模糊目标怎样变成可修正的理解、澄清和计划 | 自由文本目标 → 解析/提问 → 用户补充 → Plan/Scope → 接受执行 | UXG-03；Chat、Intent、Context、Plan Review | 清楚/模糊/多目标、缺Context、无法完成、修订、接受、放弃 | 只看演示或无法观察/修正理解 |
| A-RA-02 | 长任务怎样让用户看护、介入，并在失败后安全继续或停止 | 已接受计划 → Run/Tool活动 → HITL → 失败/恢复/停止 → 终态 | UXG-04；Run View、Approval、Runtime Detail | queued、running、waiting、approval、Tool、failed、retry、resume、cancel、断线重开 | 未安全触发介入或失败，不为恢复背书 |
| A-RA-03 | 用户怎样针对可见结果给反馈并得到不覆盖旧版的下一版 | Preview → 定位反馈 → 修改中 → 比较新旧版 → 接受/继续/停止 | UXG-03/05；Artifact、Chat、Dossier | 加载/失败/partial、v1、修改中、v2、无法执行、接受、来源 | 无法保留或回看旧版，不为版本连续性背书 |

### 6.7 B档10条专项流程

| ID | 产品 | 研究问题与起点 → 终点 | Chat映射 | 重点状态 | 降级条件 |
|---|---|---|---|---|---|
| B-LT-01 | Leantime | Project健康摘要怎样下钻到可行动的Milestone/Task原因并返回确认变化 | UXG-02；Workspace、Dossier | empty、normal、risk、overdue、unknown、blocked、updated | 只有样例Dashboard或指标不可解释 |
| B-PL-01 | Plane | 用户怎样找到当前周期或模块中自己负责的事项，更新后返回原分组与筛选 | UXG-02；Dossier、Board、Detail | 空/活动/完成周期、跨组、过滤、权限、返回 | 无法写入或验证返回视图 |
| B-VK-01 | Vikunja | Quick Add → Project/日期 → List/Board切换/移动 → 完成 → 另一视图同步 | UXG-01/02；Workspace、Board | 空、未安排、逾期、拖动/失败、完成、撤销、跨视图一致 | 无法证明同一事项跨视图引用 |
| B-RM-01 | RemNote | 学习记录 → 可复习内容 → 到期队列 → 作答/评价 → 下一次状态 | UXG-02/05；Learning Queue、Knowledge、Home | 新建、未到期、到期、答对/错、自评、跳过、逾期、空队列 | 未验证到期与下一状态，只为可见段背书 |
| B-RW-01 | Readwise | 导入/高亮 → Daily Review → 原始来源/上下文 → 处理结果 | UXG-01/02/05；Knowledge、Review、Context、Evidence | 导入、重复、重现、来源可用/失效、已处理、跳过、空 | 未实际导入并回到来源 |
| B-SS-01 | Sunsama | Backlog+Calendar → 今日选择/Timebox → 冲突/超载 → 完成或结转 → 下一日 | UXG-01/02/05；Home、Workspace、Schedule | 空、正常容量、超载、冲突、未完成、结转、放弃、下一日 | 只能走Onboarding，未验证真实结转 |
| B-AT-01 | Anytype | 用户怎样让同一知识对象在多个关系视图中出现，一次修改后仍保持一致 | UXG-02/03；Dossier、Knowledge | 属性缺失、空关系、重复、无结果、修改、一致、同步未知 | 未证明跨视图同一对象 |
| B-VC-01 | Vercel | 用户怎样判断一次构建只是成功、已经可预览，还是可以正式发布，并在失败时选择下一步 | UXG-04/05；Run View、Artifact、Delivery | queued、building、failed、cancelled、ready、preview过期、promote失败 | 无受控Project/发布权限时降为D |
| B-ST-01 | Sentry | 用户怎样从异常信号定位到足够证据，完成分派/解决后再确认是否复发 | UXG-04/06；Trace、Evidence、Operations | new、ongoing、context缺失、assigned、ignored、resolved、recurred、permission | 未生成真实Event或观察解决后变化 |
| B-MN-01 | Manus | Prompt → Plan/Run → Artifact/Source → Feedback → 下一版或停止 | UXG-03/04/05；Chat、Run View、Artifact、Evidence | planning、running、waiting、failed、partial、source unavailable、complete、modify、stop | 只有官方视频时降为D |

## 7. 高风险状态覆盖审计

下表是依据“计划研究什么”形成的预期覆盖，不是参考产品已经做到的事实。真实走查后必须用O/D/S/U
证据重算；没有取得证据的格子一律改为“未验证”。

| 编码 | Chat必须覆盖的状态 | 本批候选覆盖情况 | 当前结论 |
|---|---|---|---|
| H1 | 澄清、待决定、审批 | Replit、Replay、Manus局部较强 | 可借交互节奏，不能替代Chat版本/Hash治理 |
| H2 | 阻塞、逾期、等待、跨日遗留 | Super Productivity、Routine、Sunsama较强 | 可借个人注意力与Carryover表达 |
| H3 | 失败、发送后结果未知 | Vercel、Sentry、Replit仅覆盖一般失败 | Chat的outcome_unknown仍需自主设计 |
| H4 | 取消、中断、重试、恢复、新Attempt | Vercel、Sentry、Replit部分覆盖 | Retry、Restart、Resume、Cancel必须保持Chat对象边界 |
| H5 | 版本差异、并发冲突、合并 | Replay版本、Replit迭代局部覆盖 | 跨Product Session CAS/Diff/Rebase基本空白 |
| H6 | Artifact、Evidence、Validation、Delivery/Receipt | Artifact评审较强，证据提交和可靠Delivery较弱 | 不能用评论、Build成功或分享替代Evidence/Delivery |
| H7 | 来源失效、Memory纠正/删除 | Backlink、Readwise Source和C档Memory只有相邻表达 | 失效传播仍需Chat自主设计 |
| H8 | Identity、Role/Grant、管理员敏感访问审计 | 28条活动流程几乎为空 | Super Admin不能由运维Dashboard冒充 |
| H9 | empty、unknown、partial、stale、forbidden等诚实状态 | 候选没有系统性覆盖 | 继续以Chat现有投影合同自主设计 |

## 8. 必须由Chat自主设计的15条链路

以下缺口不是“再找一个相似竞品”就能解决。它们来自Chat稳定产品目标和权威状态边界：

1. 自然语言输入 → Intent Set → 可回答Clarification → 用户修正；多Intent有独立Context并允许部分成功。
2. Context候选召回 → 纳入/排除/锁定 → 来源revision与失效 → ContextPackage。
3. 发送前Workflow Selection绑定Definition版本；发送后Workflow Run View只投影实际Product Run。
4. ExecutionDraft可编辑 → revision/Hash失效 → HITL Policy/Approval → 不可变RunSpec → 逐次ModelCallDraft。
5. Personal Home、Conversation Day和Continuous Chat跨多个Product Session恢复，但不把完整历史当模型Context。
6. Personal Home → Personal Workspace → Project Dossier → Work/Action → 返回原上下文的完整跨面旅程；
   Dossier同时表达目标、阶段、Work/Plan、3类责任、方法、知识、Repository、Evidence、Schedule和Delivery，
   并诚实显示unknown/partial。
7. 模型提出Tool → 权限/参数审批 → Operation Ledger → 副作用 → outcome_unknown → 查询、补偿或人工处置。
8. Product Run、Run Attempt、Runtime Job和Workflow Checkpoint分开；Retry、Restart、Resume、Cancel分别表达。
9. Artifact → Evidence/Provenance → Validation → Completion Claim → Result Commit → Work状态，并在来源失效后降级。
10. Schedule Occurrence → 独立Run → Artifact → Delivery Attempt/Receipt；Delivery失败不重做原工作。
11. 多Product Session并发 → revision/CAS → Diff/Rebase/合并；允许保留Artifact但拒绝陈旧状态提交。
12. Memory Candidate → 接受、纠正、删除、来源失效；模型生成不自动生效。
13. Web、手机、Channel、Obsidian共享Product事实，通过Identity、Scope和Binding连续协作而不双写。
14. Configuration Center显示Agent/Profile/Workflow/Provider的实际有效来源和覆盖优先级；保存配置不等于授权执行。
15. Identity/Auth Session/Role/Grant → Activity/Usage可信口径 → Super Admin Console → 敏感访问与管理动作审计。

## 9. 每条流程的事实抽取卡

每条流程必须生成一张独立研究卡，固定包含：

### 9.1 研究头信息

- 流程ID、产品、观察日期、版本/套餐。
- Web/桌面App/手机、浏览器和视口。
- 账号角色、测试数据状态、是否涉及付费能力。
- 对应Chat场景族、UX场景组和呈现面。
- 本次研究问题、明确不研究内容和安全边界。

### 9.2 交互路径账

| 步骤 | 前置状态 | 入口 | 用户动作 | 即时反馈 | 状态转换 | 可逆性 | 保存/恢复 | 下一步 | 证据ID |
|---|---|---|---|---|---|---|---|---|---|

必须实事求是地记录：

1. 用户从哪里进入，完成或返回后去哪里。
2. 点击、拖拽、输入、快捷键或触摸怎样操作。
3. 局部更新、Toast、Skeleton、进度、确认或无反馈。
4. 临时页面状态与持久结果的区别。
5. 撤销、取消、修改和重新进入。
6. 刷新、关闭、跨页面和跨设备后是否恢复；未实测不能写“已保存”。
7. 空、加载、等待、失败、权限、冲突、陈旧、完成和复盘状态。

### 9.3 布局与视觉事实

- App Shell与导航层级。
- 主栏、辅栏、抽屉、Modal和滚动所有权。
- 首屏注意力、信息密度、展开层级和返回上下文。
- 字号/字重相对层级、颜色角色、间距节奏、圆角/边框/阴影、图标分工。
- 列表、卡片、表格、时间线、图形分别承载什么。
- 动效的触发与目的、焦点、对比度和非颜色状态表达。
- 桌面与手机怎样重排；未观察手机端必须写“移动布局未验证”。

没有测量时只记录相对层级，不编造像素值。

### 9.4 Chat模式迁移卡

| 字段 | 必填内容 |
|---|---|
| 模式 | 精确到某个入口、动作、反馈、布局或视觉规则 |
| Chat用户需要 | 解决哪个SCN和高风险状态 |
| Chat呈现面 | Home、Workspace、Dossier、Run View等 |
| 事实依据 | 对应O/D/S/U证据ID |
| 决定 | 采用 / 改造 / 拒绝 / 待验证 |
| 采用什么 | 精确说明，不以整个产品为单位 |
| 不采用什么 | 不复制哪些团队对象、状态机、权限或假数据 |
| Chat改造 | 对应的对象语义、权威状态、桌面/手机行为和反馈 |
| 当前能力 | 已实现 / 契约壳可做 / 需先补状态合同 |
| 风险与验证门 | 需要哪条Chat原型旅程和用户审核 |

截图事实可以支持视觉或布局候选，但不能单独支持“采用某交互”。

## 10. 执行顺序和用户审核门

1. **后台候选池**：本文件的24个活动产品、28条流程、6个场景组和自主设计区只负责防漏；用户无需先批量审核整张清单，研究也不以“做完一个产品”为工作包。
2. **默认一次一个模块**：每轮先固定用户目标、起点、终点和非目标，每个模块只选择1个真正回答同一问题的主参考；只有关键状态缺失时才增加最多1个辅助参考。两个新模块只有在共享紧密旅程、参考事实和视觉上下文，不涉及高风险控制语义且仍可独立拍板时才合批；三个模块只用于已批准模块的组合一致性走查。
3. **事实卡校准**：Super Productivity已形成3条事实卡；A-SP-01为O局部，另2条为D/S。2026-08-01用户已审核其事实颗粒度和3组模式取舍；批准不提升证据等级，也不表示相邻模块已确认。
4. **当前Checkpoint**：用户已确认[Chat 90%交互设计模块总表](./chat-interaction-design-module-map.md)中的28个模块；MD-01已单独完成事实、原型与模块内审核，当前1/28完成。下一模块MD-02尚未启动；A-RT-02日历协商和A-RT-03日终结转仍分别等待对应模块，不顺带完成。
5. **先出小效果再继续**：每个当前模块事实足够后，立即形成1—3个关键画面或1个轻量HTML，补1个最重要风险态、采用/改造/拒绝理由和2—4个待拍板决定。
6. **后续按模块取参考**：A/B/C候选只在某个模块需要时进入；不可访问流程按本文件降级，A档空位也只有在用户先看真实效果并认可后才补入。
7. **后台累计覆盖**：用户批准一个模块后，只更新相关Interaction Unit；在自然组合点及30%、60%、90%进行跨模块一致性和分母校对，不把总账变成当前模块的阻塞审核门。

这条横向UX研究线不改变PROJECT_PLAN中的W0—W10开发优先级。

## 11. 研究完成门

只有同时满足以下条件，一条A/B流程才可以标记“O完整”：

1. 起点、终点、账号环境、平台、视口和观察日期明确。
2. 研究问题的中心主张已经在走查前声明，并分别满足第4.1节对应的主张级证据门。
3. 正常路径完整走通；安全可行时观察至少1个与研究问题相关的空态、撤销、等待或异常分支。无法安全触发的分支标为D或未验证，不冒充O完整。
4. 入口、动作、即时反馈、状态转换、持久结果、返回/恢复均有记录；某项不是本流程中心主张时明确写“不适用”，不能留空。
5. 布局、视觉和状态语言分别提取，不用“简洁、现代、卡片化”代替。
6. 结论逐条绑定O/D/S/U证据，I类Chat推断单独分栏。
7. 形成模式级采用/改造/拒绝/待验证判断及Chat映射。
8. 未实测移动端、权限、失败或跨设备时明确标记，不能补猜。

28条活动候选流程最终都取得O完整、O局部、D/S或未验证状态，仍不等于Chat界面已经确认。只有证据模式被选中、
组合成Chat原型、覆盖适用状态并经过用户旅程审核后，才进入“页面交互已确认”的计数。

## 12. 已审核决定与下一审核门

2026-08-01本轮已确认：

1. Super Productivity继续作为A档参考，其3组采用/改造/拒绝决定获批。
2. 证据状态仍为0条O完整、1条O局部、27条无O证据；模式批准不冒充事实升级。
3. 全部工作必须服务“确认Chat 90%系统交互”；阶段性展示实际效果、设计原因和取舍，由用户拍板后才计入覆盖率。
4. 24个活动候选、28条流程和15条自主设计链继续作为后台防漏池，不要求用户先整体审核，也不决定单次工作包大小。
5. 86个Interaction Unit候选不再设置为继续工作的前置冻结门；每个模块获批后增量校对，到自然里程碑再冻结revision和计算百分比。
6. 每轮固定采用“小循环”：少量参考事实 → Chat采用/改造/拒绝 → 小草图或HTML → 设计原因 → 用户拍板。

`MD-01 快速捕获与Idea去向`已于2026-08-01完成审核：用户批准入口形态、默认落点、分类时机、反馈与撤销4项决定，
对应`IU-104`、`IU-105`进入设计批准记录。Routine `A-RT-01`仍保持0条O、9组D、3组S，批准不冒充证据升级或
后端实现。当前没有活动审核门；下一模块MD-02只在新Session按
[交互设计续接入口](./chat-interaction-design-handoff.md)启动，本次不顺带展开其他Routine流程。
