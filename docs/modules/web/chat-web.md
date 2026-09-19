# Chat Web：对象、交互与功能边界

当前实现说明。产品中的 Long Agent 统一显示为 **Friend**；后端实体、API 与已有数据标识继续使用 Long Agent。开发入口见 [Frontend 开发指南](../../../frontend/docs/development.md)，字体、颜色、尺寸和组件要求只在 [UI/UX 规范](../../../frontend/docs/ui-ux-guidelines.md)维护；HTTP 和状态来源见[模块合同](../../architecture/chat-module-contracts.md)。历史验证与未验证范围见[验收记录](../../history/reviews/2026-09-19-chat-web-step2-review.md)。

## 1. 对象与区域

Chat 面向持续交流和具体项目工作。Project 可以是软件、学习、思考、兴趣或相册；Long Agent 是 Friend。前端以 Friend 为主要入口，底层仍保留 Project-first 的执行和数据归属。

| 对象 | 拥有的事实 | 页面中的职责 |
|---|---|---|
| Long Agent | 长期身份、能力、职责和自身资源 | 全局 Friend 列表；打开该 Friend 的原生 Session |
| Project | 项目身份、目录、配置与工作记录 | 顶部上下文和右侧资料；项目模式中的普通 Session 列表 |
| Session | 一段持久模型上下文，具有固定 Project 和 owner | 中间交流、历史、分支、消息及本轮选择 |
| Run / Turn | 具体执行、工具动作与终态 | 过程、状态和用量；切页面不会迁移或取消原执行 |
| 动态 | 作者发布的内容和评论 | 全局阅读，按已加载作者筛选，不按当前 Project 过滤 |
| Channel | Web、IM 等接入方式 | 不复制 Friend 身份，也不与 Friend 运行状态合并 |

必须分别理解交流对象、当前浏览上下文、实际执行归属。切 Long Agent 不隐式切 Project；Friend 模式切 Project 不切 Long Agent，不重建身份，不改历史 Session 的归属。P2 起，发送时的 `contextProjectId` 是服务端校验并冻结的协作项目，实际影响该轮规则、cwd、资源及默认 Project Memory；null 为无项目。它不改变执行 Session 的存储归属。页面切换仅影响下一次发送；跨入口每日定位和统一实时更新仍属 P3/P4。

```text
┌────────┬────────────────────────────────────────────────────┐
│        │ Project / 当前交流标题       历史、分支、系统、资料 │
│ Friend   ├────────────┬────────────────────────┬──────────────┤
│ 项目   │ Friend 或普通 │ 消息、回复             │ 按需打开资料 │
│ 动态   │ Session   │ 消息、回复             │ 文件树/预览  │
│        │ 列表      │ 本轮用量 ↔ 展开过程    │ 或 Friend 简介   │
│ 设置   │           │ 活跃阶段 + 输入        │              │
└────────┴───────────┴────────────────────────┴──────────────┘
```

动态和设置沿用导航与主题，隐藏无关项目资料。Compact 使用底部导航与单主任务面；不会把桌面多列缩小塞进手机。具体断点和调宽规则由 UI/UX 规范定义。

## 2. 切换与恢复

| 动作 | 改变 | 保留 |
|---|---|---|
| Friend 模式切 Project | 顶部选择、项目文件、该上下文草稿 | Friend、Session、历史、已提交执行 |
| 切 Friend | 交流对象、Session、草稿、Friend 简介 | 当前 Project、文件来源 |
| 进入项目模式 | 当前 Project 的普通 Session 列表和最近位置 | 上次 Friend 选择及各自草稿 |
| 项目模式切 Project | 普通列表、最近有效 Session 或新会话、文件 | 其他项目历史与执行 |
| 打开普通 Session 深链接 | 后端确认的 Session 及所属 Project | 无关 Friend 定义 |
| 打开历史文件 | 右侧指定来源的文件 | 顶部当前项目；不能把旧路径拼进新目录 |
| 交流 → 动态/设置 → 返回 | 当前主视图 | 原交流、上下文、草稿和运行 |

明确点击/有效链接优先于本窗口历史，再使用最近偏好。失效明确链接保留地址并显示错误，不能静默向默认 Friend 或其他 Project 发送。异步加载采用请求序号或 AbortSignal；旧响应不能夺回新选择。

文字草稿按设备、Project、Session 隔离，Friend 再区分上下文 Project。窗口存储支持同标签页刷新，不广播导航到其他窗口；附件只在内存保留，刷新提示重新选择。待确认发送的文字单独保留，核对会话后手动恢复或清除，不自动重发、不覆盖后续草稿。

资料面板只展示文件树、指定来源预览或 Friend 简介之一；文件标签保留来源，项目切换后可返回最近文件。Friend 简介是只读摘要，编辑进入原配置。文件树与预览同时平铺仍不支持，不能把宽内容模式当作该能力。

## 3. 执行、过程和结尾

- 普通 Session 使用原 Workflow 接口；Friend 使用 Long Agent 消息接口。选择和发送均服从 Backend 返回的 Session owner。
- Friend 列表显示就绪、工作中、已停用、未知；网关连接状态独立显示；健康检查不代表 IM 已接通或全部管理接口可用。工作状态来自现有操作锁投影，终态来自 Pi Session/Workflow。没有可靠事实的离开、休息或等待用户不显示。
- 执行中保留真实阶段、计时及适用操作。等待模型、工具参数生成、工具执行是不同阶段；工具状态不能由颜色或静默时长猜测。
- 结束后保留回复正文，结尾将已确认完成、累计模型用量、工具次数、记录用时和过程入口合并。过程默认折叠，可展开全部原消息及工具结果；不会删除历史。
- 正常完成不再在输入区上方单独占一行。失败、取消、停止等待、断线和未知保留明确提示；不把最后一条工具成功当成全轮成功。
- Token 仅汇总当前可见轮次中模型已返回的 input/output/cacheRead/cacheWrite，缺失不估算；详情可看分项与已记录成本。工具次数按调用身份计数。用时来自 Session 输入到末条回复/工具结果的入库时间，包含等待；无时间记录则不显示虚假数值。
- 普通 Workflow 停止等待服务端确认；Friend“停止等待”不终止后台工作。返回/刷新只恢复事实，不隐式再次提交。

项目选择、会话标题与历史、分支、系统等操作合在同一条顶栏（48px）；不再显示“项目独立会话”或长期交流说明。侧栏折叠时仍保留当前对象标题。聊天节点是中间交流区自己的导航，独立于右侧资料：有用户消息即在桌面显示，可定位提问、回复和标题并懒加载历史；Compact 沿用不显示节点的约定。

## 4. 功能入口与配置归属

| 功能 | 现有入口 |
|---|---|
| 默认 Friend 启用、创建、选择、配置 | 全局 Friend 列表的空态、＋、设置；简介链接同一编辑页 |
| Project 选择、创建、打开目录 | 顶部项目条；显示名称，路径作为辅助辨认信息 |
| 普通 Session 新建、搜索、改名、移除/恢复、子会话 | 全局项目列表及原会话菜单 |
| 文件搜索、刷新、预览、标签、引用行 | 右侧项目资料；历史文件保留来源 |
| 完整历史、分支、系统、统计 | 交流工具栏；窄屏经更多/会话信息进入 |
| Workflow、Agent、本轮调整、审核、发送/停止 | 原交流及输入区，按 Session owner 选择合同 |
| 模型、Memory、Tool、Skill、Prompt、Plugin、Extension 管理 | 全局设置，复用原管理 API |
| 明暗/跟随系统、语言、标准/宽内容 | 设置 → 外观 |
| 刷新会话和文件、移动端自检 | 设置 → 辅助操作 |
| 动态作者筛选、评论阅读、返回 | 全局动态；仅使用已支持的阅读能力 |
| 提示音、通知、草稿、自动跟随 | 交流区与已有浏览器权限入口 |
| 设备切换 | 顶栏；至少有两个设备时出现 |

全局设置是导航入口，按外观、个人能力与记忆、项目资源、辅助操作分组；只有外观与模型等 Personal 配置是全局事实，项目资源页面明确显示当前上下文，不能把整个设置入口当作 Personal 作用域。Friend 配置属于该 Long Agent，不随顶部 Project 漂移。Workflow Agent 的持久配置明确标注当前 Project、自动保存及下次运行生效；本轮调整单独标记。字段清除、恢复默认、认证和 revision 冲突继续遵守[配置合同](../../configuration/README.md)，不能由 UI 重定义继承关系。

模型配置、工具/资源选择、插件/扩展、Prompt 管理应共享控件、字体和语义色；完整值可查看，长模型名不挤坏表单。代码/路径使用等宽字体，说明和按钮使用系统无衬线。统一外观不等于合并不同作用域的配置事实。


### 4.1 全部页面的组织合同

| 页面 / 区域 | 归属与交互 | 呈现方式 |
|---|---|---|
| 交流与输入、过程与结尾、聊天节点 | 当前 Session/Run，切页面不取消执行 | 单顶栏、正文、紧凑结尾；节点独立保留 |
| Friend 列表、创建、资料 | Personal Long Agent；项目只是上下文 | 联系人列表，名称/简介创建，详情进入同一管理入口 |
| Friend 管理：运行策略、Agent Group、Memory、任务、活动 | 各标签按所属配置/资源 API 管理，不复制事实 | 独立管理面、对象导航、标签、保留未保存确认与 revision 冲突 |
| 项目选择、目录选择、新建/改名/移除/恢复 | 当前 Project 及其普通 Session | 顶栏选择、列表动作、目录 Dialog、移除区；不把 Friend Session 混入普通列表 |
| 文件树、预览/标签、图片、Mermaid | 当前资料 Project 或明确历史来源 | 资料面板；图片/图独立查看器；代码保留等宽与独立滚动 |
| 设置 → 外观 | 本浏览器偏好 | 分类导航，无无关 Session 顶栏 |
| 设置 → 个人能力与记忆 | Chat 模型/认证；Memory 内再选 Personal/Project | 分类入口；模型编辑和记忆编辑各自保留任务结构 |
| 设置 → 项目资源 | 当前 Project 可见的 Tools/Skills/Plugins/Extensions/Prompt | 列表/详情，明确归属与启用来源；发现不等于 Agent 已选用 |
| Workflow Agent 配置 | 具体 Project/Workflow/Agent | 带作用域的自动保存表单，实际装配检查为只读 |
| 完整历史 | 当前 Session 全部 Pi 记录；浏览分支不改变正在交流的分支 | 共用阅读 Dialog，Pi HTML 隔离沙箱；Chat 主题；读取失败可重试，原导出保留 |
| 分支、系统提示词、Session 统计 | 当前 Session | 顶栏局部浮层；不能放进全局设置 |
| 动态与评论 | 全局作者与已发布内容 | 单列阅读；作者筛选；当前不提供评论写入 |
| 设备切换、离线、自检 | 连接与浏览器，不是 Agent 状态 | 顶栏/移动设备选择、连接状态面、自检详情 |
| Provider Requests、扩展控件 | 诊断记录/扩展提供的内容 | 诊断面与运行局部层；日志、ANSI、代码保留其内容语义，不覆盖成普通表单 |

Tools 目录诊断属于整个目录，不放在选中工具详情里假装该工具执行失败。约定 `.chat/extensions` 目录不存在代表未提供扩展；显式 Agent 扩展路径仍由 Pi 校验，真实失败保留诊断。工具使用关系按 Project 覆盖 Workflow 默认后展示，Friend 的实际工具进入该 Friend 的检查合同。

这次调整不删除已有有效功能。只迁移顶栏/设置入口和渐进展开低频详情；手机上的 Friend 管理操作也保留。历史页面复用 Pi 导出数据和脚本，主题适配在浏览器阅读层，下载的独立导出不被改写。

## 5. 明确取舍与后续能力

已按用户要求删除产品登录、产品 Cookie 和登录页面；Provider OAuth/API Key 与 NanoClaw 服务认证保留。未接通的自动标题按钮、Worktree/Git 状态查询、上游版本更新提示已撤下；原来没有可用的 Chat 后端，不应记成已迁移功能。手动改名和文件浏览继续可用。

当前 Friend 管理已提供任务与活动标签；完整任务产品、群聊、外部参与者授权、完整 Agent 个人空间、媒体动态及评论写入需要单独合同。自然语言切项目必须有结构化授权结果，不能匹配助手正文驱动页面；仅提及其他项目不自动移动工作位置。跨项目执行、跨 Session 连续历史也不能靠布局实现。对外开放通道不自动公开主人的历史、项目或 Memory。

## 6. 参考依据

只借鉴布局与机制，不复制外部运行时或迁入整套框架。视觉数值的选择依据见 UI/UX 规范；以下保留原核查的固定版本，避免过时讨论稿成为第二份现状。

固定版本证据：

- OpenBot `61cc46ae021718ec6c19684b5a9f97ba57512baf`：[频道创建](https://github.com/CopilotKit/OpenBot/blob/61cc46ae021718ec6c19684b5a9f97ba57512baf/app/src/lib/channels/start.ts)、[频道事件](https://github.com/CopilotKit/OpenBot/blob/61cc46ae021718ec6c19684b5a9f97ba57512baf/app/src/lib/channels/use-channel-events.ts)、[Bot Thread 恢复](https://github.com/CopilotKit/OpenBot/blob/61cc46ae021718ec6c19684b5a9f97ba57512baf/app/src/lib/copilot/bot-thread.ts)。
- LobeHub `7334cca4b98cb32a0c91189e12d2ab347bbebac8`：[topic 切换](https://github.com/lobehub/lobehub/blob/7334cca4b98cb32a0c91189e12d2ab347bbebac8/src/store/chat/slices/topic/action.ts)、[运行操作上下文](https://github.com/lobehub/lobehub/blob/7334cca4b98cb32a0c91189e12d2ab347bbebac8/src/store/chat/slices/operation/actions.ts)。
- OpenWork `e97477036b67dced9872bfdfee21c4b485a8a17b`：[Session 作用域](https://github.com/different-ai/openwork/blob/e97477036b67dced9872bfdfee21c4b485a8a17b/apps/app/src/app/lib/session-scope.ts)、[Session 归属校验](https://github.com/different-ai/openwork/blob/e97477036b67dced9872bfdfee21c4b485a8a17b/apps/app/src/app/lib/session-ownership.ts)。
- Cherry Studio `63bd1ed238a5654bbd3391489baa158bee52beeb`：[交流区与侧栏](https://github.com/CherryHQ/cherry-studio/blob/63bd1ed238a5654bbd3391489baa158bee52beeb/src/renderer/pages/home/Chat.tsx)、[会话流状态](https://github.com/CherryHQ/cherry-studio/blob/63bd1ed238a5654bbd3391489baa158bee52beeb/src/renderer/hooks/useTopicStreamStatus.ts)。


## P1 已确定的下一阶段合同（尚未实施）

Friend 保持每天一个交流 Session，项目选择对下一条消息的实际装配生效；不能只传一段项目名称说明，也不按项目另建 Friend Session。项目变更不改当前在途执行。URL/恢复明确区分会话存储和浏览项目，无项目为显式 null。

实时消息、工具、压缩/重试、终态与恢复共用公共消费层；停止等待与取消分开。已接受后续消息有独立冻结目标；引导仅作用同项目/同来源的正在执行 Agent。附加 Workflow 审核或 Friend 来源信息经适配提供，不复制第二套聊天组件。精确语义见[模块合同 P1](../../architecture/chat-module-contracts.md#p1统一请求执行反馈与入口适配2026-09-19待实施)。

用户验收应检查两个浏览器窗口选择不同项目时互不覆盖，以及旧日链接继续操作明确进入今天；查看资料、历史或配置不隐式触发执行。
