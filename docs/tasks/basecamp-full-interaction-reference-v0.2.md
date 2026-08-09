---
status: implemented
version: 0.2
date: 2026-08-09
owner: Chat product design
task_type: reference-study prototype
branch: codex/basecamp-full-interaction-v0.2
figma: https://www.figma.com/design/9dcDDPleuMKECmq4NzQYPk
---

# Basecamp 全交互与 UI 优化参考实现 v0.2

## 1. 用户结果

用户可以在同一个前端内存原型里，从 Home 进入不同 Project，打开 6 类 Project tool，继续完成 To-do 创建、筛选、完成、详情、subtask 与评论等操作；所有可见控件都产生可解释结果，且桌面视觉继续保持 v0.1 已通过的 Basecamp 空间结构。

## 2. 当前问题

v0.1 已完成高保真 Home 与一条演示路径，但当前约 40 个可见控件仍是静默 no-op 或 toast 占位，且任务完成状态只存在详情局部。页面看起来接近 Basecamp，交互却没有形成同一对象跨视图投影。

## 3. 研究依据

1. [Basecamp 5 · The Home Screen](https://5.basecamp-help.com/article/1159-the-home-screen)：Home 的全局、管理、Project、Activity 与个人入口分区。
2. [Basecamp 5 · Creating and setting up a Project](https://5.basecamp-help.com/article/1176-creating-and-setting-up-a-project)：Project 是独立空间；工具按需启用，可包含 Message Board、To-dos、Docs & Files、Calendar、Chat、Card Table 与 external link。
3. [Basecamp 5 · To-Dos](https://5.basecamp-help.com/article/1077-to-dos)：To-do 创建、列表、分组、分配、日期、subtask、批量与个人任务投影。
4. [Basecamp 5 · Message Board](https://5.basecamp-help.com/article/1075-message-board)：新建、分类、筛选、固定与评论。
5. [Basecamp 5 · Docs & Files](https://5.basecamp-help.com/article/1079-docs-and-files)：新建文档/文件、筛选、排序、预览与下载。
6. [Basecamp 5 · Reports](https://5.basecamp-help.com/article/1161-reports)：跨 Project 的 Lineup、Mission Control、Hilltop、Upcoming、Overdue 与 activity 报告。
7. [Basecamp 5 · Hill Charts](https://5.basecamp-help.com/article/1078-hill-charts)：以 To-do list 为单位手动更新进度并保留历史。

## 4. 数据与导航合同

1. `Project`、`Tool`、`TodoList`、`Todo`、`Subtask`、`Comment` 各有稳定 ID。
2. Project card 打开自己的 Project；Tool、Todo detail 与浏览器返回都保留所属 Project/Tool。
3. To-do 完成、标题、负责人、日期、subtask、评论和 bookmark 只存在一份权威内存状态，列表与详情从同一对象投影。
4. 新增 Project、Folder、Message、Document、Event、Chat message、Card、To-do、Subtask 与 Comment 都进入对应集合，不使用仅 toast 的假成功。
5. URL 使用 query 参数保存 `view`、`project`、`tool` 与 `todo`；浏览器 Back/Forward 可恢复路径。

## 5. 页面范围

### 5.1 Home

1. Activity、Calendar、Reports、Everything 打开独立聚合视图。
2. Make a new project、Add a folder、Invite people、Adminland 打开可操作 dialog，并在提交后更新界面或设置。
3. Search / Jump 支持 Project、Person、Page，Arrow Up/Down、Enter、Escape 与焦点恢复。
4. Project star、背景主题与 View all activity 有真实状态/导航。
5. My Tasks、My Events、Do Today、My Bookmarks、My Notes、New for you 打开独立个人视图。

### 5.2 Project Room

1. 8 张 Project card 打开 8 个不同 Project。
2. Message Board、Docs & Files、Project Tasks、Chat、Schedule、Workflow 均有独立 tool view 与核心创建动作。
3. External links 打开明确的安全预览 dialog；不伪造真实外部跳转结果。
4. Project star 与 Home 使用同一状态。

### 5.3 Project Tasks

1. Bookmark、View as、Filter、Update、See history、Add to-do、group Add 全部可操作。
2. View as 支持 List / People / Due date；Filter 支持状态与负责人。
3. 完成/重开 To-do 后列表、计数、My Tasks 与详情同步。
4. 每条 title 打开自己的 Todo detail。

### 5.4 Todo detail

1. 完成/重开同步回列表。
2. 标题、负责人、日期、附件反馈、subtask 添加/完成与 comment 添加可操作。
3. Comment menu 提供 Copy link / Edit / Remove；删除是内存原型内可恢复的低风险状态变化。
4. Escape 按层关闭 menu/dialog；返回恢复 Project Tasks。

## 6. UI 优化

1. 保持 v0.1 Home 桌面视觉真相，不重做品牌、颜色、卡片密度或五区布局。
2. 统一 Project Room、Tool View、Item Detail 的最大宽度、左右 padding、标题与内容间距。
3. 修正列表 heading 与首行过近、不同页面字体/按钮高度不一致、窄屏溢出等问题。
4. Dialog、popover、empty state、toast 与 inline form 使用同一组圆角、边框、阴影、focus ring 和动作层级。
5. 验收 1707px 桌面、1220px、880px 与 375px；触控目标不少于 44px。

## 7. 明确不做

1. 不接 Basecamp、Chat 或第三方真实服务。
2. 不实现账号、权限、多人实时协作、上传或外部链接真实副作用。
3. 不将本参考实现复制到 Chat 生产 UI。
4. 不为了扩大页面数量牺牲主流程的状态一致性和视觉质量。

## 8. 完成门

1. 源码静态扫描中不存在 `onClick={() => {}}`、无 handler 的可见 button 或只改变焦点的伪交互。
2. 纯模型合同测试覆盖稳定 ID、跨视图对象身份、创建、完成/重开、筛选、subtask、comment 与 Hill update。
3. 浏览器 E2E 覆盖 Home → distinct Project → 6 tools → Tasks → distinct Todo detail → Back。
4. 键盘覆盖 Search / Jump、dialog、popover、Enter/Escape 与焦点恢复。
5. `npm test`、`npm run build`、`npm run test:sites` 通过，浏览器 console 零错误。
6. `design-qa.md` 更新为 v0.2，参考与实现同尺寸并排比较后无 P0/P1/P2 差异。
