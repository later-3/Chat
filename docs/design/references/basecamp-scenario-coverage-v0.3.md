---
status: frozen
version: 0.3
date: 2026-08-09
product: Basecamp 5
evidence: official-help + current-run-browser-audit
---

# Basecamp 场景覆盖矩阵 v0.3

## 1. 冻结结论

本次以“用户处在什么情境、需要回答什么问题”为单位复核，而不是以页面数量或按钮数量复核。选定的 12 类参考场景均已有可体验的 UI、标志性交互和状态结果，可以作为 Chat 的设计研究证据冻结。

## 2. 场景矩阵

| # | 用户情境 / 问题 | Basecamp 的 UI 与交互模式 | 原型证据 | Chat 取舍 | 状态 |
|---|---|---|---|---|---|
| 1 | 项目多了以后，我怎样快速找到常去地点？ | Home 的 Search / Jump、Star、Recent projects | Home 搜索、键盘选择、8 个独立 Project、共享 star 状态 | `Take`：稳定 Project 目的地和全局跳转 | 覆盖 |
| 2 | 我怎样整理一组相关 Project，又不改变团队事实？ | Folder 只组织个人 Home，并提供 folder-scoped projects/activity | Home Folder shelf → Client work → 2 个同源 Project + folder activity | `Adapt`：个人入口组织与权威 Project 状态分离 | 覆盖 |
| 3 | 进入 Project 后，我如何知道自己在哪个协作范围？ | Project Room 显示 Project 身份、成员和按需工具 | 8 个 Project identity、成员 presence、6 个 tool destination | `Take`：Project 是长期地点，不是过滤标签 | 覆盖 |
| 4 | 决定和公告如何长期留存，后续讨论又不散落？ | Message Board 分类、置顶、thread 与 attached replies | 分类过滤、Pinned、thread detail、持久 reply | `Adapt`：Decision/公告拥有稳定 thread 和证据 | 覆盖 |
| 5 | 团队怎样找到并复用参考资料？ | Docs & Files 的目录、folder/type、过滤和 preview | 搜索、folder/type 元数据、reference preview、bookmark feedback | `Take`：Artifact 是可查找对象，不埋在聊天流 | 覆盖 |
| 6 | 一句快速协调值得怎样处理？ | Chat 的低门槛时间流和底部 composer | 连续消息流、作者/时间、固定 composer、发送后进入同一 stream | `Adapt`：轻对话与正式决定分层 | 覆盖 |
| 7 | 明确工作怎样被计划、分配、完成和讨论？ | To-dos list/detail、assignee、due date、subtask、comments | 创建、筛选、完成/重开、详情编辑、subtask、comments、bookmark | `Take`：同一 Work 对象跨投影复用 | 覆盖 |
| 8 | 时间承诺怎样横切 Project 工作？ | Schedule/Calendar 把 event、milestone 和 dated work 放在一起 | Agenda / Calendar 切换、日期明确的 event composer | `Adapt`：Calendar 是投影，底层 Work/Event 仍是权威对象 | 覆盖 |
| 9 | 流程型工作怎样从请求走到完成？ | Card Table 用 column 表达 stage，card 在 stage 间移动 | 4 个 stage、真实 card、Move to next stage、稳定 card ID | `Adapt`：只在流程确实重要时使用显式阶段 | 覆盖 |
| 10 | 任务完成百分比无法表达“不确定性”时怎么办？ | Hill Chart 由团队手动表达上坡未知与下坡执行 | Hill Chart、manual update、history | `Adapt`：Agent/Work 进度应允许“未知已被理解”的人工表达 | 覆盖 |
| 11 | 跨 Project 的变化、责任与定向输入怎样分开？ | Activity、Calendar、Reports、Everything、My bar、New for you 是不同作用域 | 10 个 aggregate view、My Tasks、Do Today、5 条 unread 和 Mark all read | `Take`：环境动态、我的责任、需要我处理不能混成一条 feed | 覆盖 |
| 12 | 深入 Project 后，我如何不丢失环境和个人入口？ | 主题属于全局偏好，My bar/notification sidebar 全局可达 | Home → Project → Tool → Item 保持浅色主题；深层页面持续显示 My bar | `Take`：导航不能暗中改变全局偏好或切断个人入口 | 覆盖 |

## 3. 关键区分

### Message Board vs Chat

1. Message Board 面向“以后还要找回来”的公告、决定和长讨论，强调 title、category、pin、thread 和 replies。
2. Chat 面向快速、低风险协调，强调时间顺序、作者在场和随时输入。
3. 原型用两种不同页面结构和状态模型表达差异，不再用同一个通用列表换标题。

### To-dos vs Workflow

1. To-dos 回答“谁在什么时候完成哪件工作”。
2. Workflow 回答“这类工作当前处在哪个流程阶段”。
3. 两者都不是装饰性看板：一个更新任务事实，一个移动稳定 card 的 stage。

### Home/Activity vs 权威对象

1. Home、Activity、Calendar、My Tasks、New for you 都是投影和入口。
2. Project、Todo、Message thread、Document、Event、Workflow card 才是用户继续处理的对象。
3. 投影深链回对象；不在 feed 里复制另一份完成事实。

## 4. 对 Chat 的 Take / Adapt / Refuse

### Take

1. Account / Project / Tool / Item 的稳定作用域。
2. 环境动态、个人责任和定向输入分层。
3. 同一对象跨 Home、聚合视图、Project 和 Detail 投影。
4. 轻量对话与耐久决定分层。
5. 全局偏好和全局入口不随页面导航改变。

### Adapt

1. Basecamp Folder / Star → Chat 的个人 Project 入口整理。
2. New for you → `需要我处理`，只承载决定、阻塞、确认和定向交付。
3. Message Board → Decision / Artifact discussion，绑定 revision、evidence 与权限。
4. Hill Chart → 人工表达 Agent Work 的未知、理解和执行阶段。
5. Card Table → 只服务真正需要显式 stage 的 Work 类型，不成为万能看板。

### Refuse

1. 不复制六宫格工具首页、Basecamp 品牌或页面位置。
2. 不把 Conversation、Run、Decision、Artifact 扁平化为等权工具。
3. 不让 feed、Everything 或 Dashboard 拥有完成事实。
4. 不用头像、颜色、星标替代 Chat 的正式状态和治理语义。
5. 不把真实副作用、权限和多人一致性伪造成纯前端交互已完成。

## 5. 研究边界

以下能力不是本轮选定的 UI/交互参考场景，保留为明确边界：

1. Client/team visibility 和 item-level permissions。
2. Notification work hours、per-project notification policy 和跨设备持久化。
3. Recurring event、真实时区和外部 Calendar subscription。
4. 真实文件上传、下载、版本历史和第三方链接副作用。
5. 多人实时、冲突处理、offline 和服务端权威状态。
6. Folder/Card drag-and-drop、复杂排序和批量操作。

这些能力若进入 Chat 产品范围，必须另立研究任务和合同，不应从当前前端原型推断。

## 6. 官方证据

1. [The Home Screen](https://5.basecamp-help.com/article/1159-the-home-screen)：Home、Folder、Star、Recent projects 与浅色主题偏好。
2. [The Basecamp Way to Work](https://5.basecamp-help.com/article/1072-the-basecamp-way-to-work)：不同 Project tool 对应不同协作场景。
3. [Message Board](https://5.basecamp-help.com/article/1075-message-board)：耐久公告、分类、置顶和 attached discussion。
4. [Chat](https://5.basecamp-help.com/article/1052-chat)：快速对话、回复、提及和消息编辑。
5. [Docs & Files](https://5.basecamp-help.com/article/1079-docs-and-files)：参考资料、folder、filter、preview 和 public link。
6. [Calendar](https://5.basecamp-help.com/article/1120-calendar)：event、assignment、Calendar/Agenda、reminder 和 recurring event。
7. [Card Tables](https://5.basecamp-help.com/article/1063-card-tables)：process stage、card movement、detail、comment 和 subtask。
8. [Notifications Sidebar](https://5.basecamp-help.com/article/1150-sidebar)：全局可达的定向输入和历史通知。
9. [What clients can see and do](https://5.basecamp-help.com/article/1082-what-clients-can-see-and-do)：client/team visibility 边界。
10. [Notification settings](https://5.basecamp-help.com/article/1177-notifications)：account/project scope 和 work hours。

## 7. 验证结果

1. 浏览器当前运行截图复核 7 个修订界面：Project Room、Folder、Message Board、Docs & Files、Chat、Schedule、Workflow。
2. 浏览器交互实测：Message category filter、persistent reply、Document search/preview、Chat send、Schedule Calendar、Workflow move 全部通过。
3. DOM 证据：Project/Tool 页背景 `rgb(255, 250, 246)`，My bar 存在；Workflow move 后 New `0`、Working on `2`。
4. `npm test`：21/21 passed。
5. `npm run build`：passed。

final result: frozen
