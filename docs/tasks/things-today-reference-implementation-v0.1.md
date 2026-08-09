---
status: approved
version: 0.1
date: 2026-08-09
owner: Chat product design
task_type: reference-study prototype
branch: design/things-today-reference-v0.1
---

# Things Today 高保真 HTML 参考实现

## 1. 用户结果

用户可以在浏览器中直接检查一个接近 Things macOS Today 的可运行 HTML，判断它是否真正还原了 Things 的两条组织轴、留白节奏和对象附近操作，而不是给旧 Chat 页面换一层浅色皮肤。

## 2. 视觉真相

1. 主视觉以 Things 当前官方 Today 截图 `01-today-current.jpg` 为唯一首屏真相。
2. 展开状态以官方 `06-todo-open-mac.png` 为真相。
3. 日期决策以官方 `09-when-popover-mac.png` 为真相。
4. Quick Find 以官方 `08-quick-find-mac.png` 为真相。
5. 只还原截图中可见的 macOS 产品表面；不混入 Chat 主题、旧 UL1 壳层或自造 Dashboard。

## 3. 核心流程

`Today → 打开 To-do 原位详情 → When → This Evening / Tomorrow → 完成或重新改期`

流程中必须满足：

1. To-do 在 Today 仍显示 Project / Area 来源。
2. This Evening 是 Today 底部的低权重区域，不是另一个页面。
3. When 修改 attention date；Deadline 保持独立入口。
4. 完成提供局部状态反馈与 Undo。
5. Quick Find 可以直接键入并跳转 Today / Project / To-do。

## 4. 范围

1. Things macOS 桌面窗口与左侧列表。
2. Today 的 Calendar events、daytime to-dos 与 This Evening。
3. To-do 原位展开的 Notes、Checklist、Tags、When 与 Deadline。
4. When popover：Today、This Evening、Tomorrow、Someday、Clear。
5. Magic Plus 创建新 To-do，并插入当前可见列表。
6. Checkbox 完成、Undo、父 Project 跳转和返回 Today。

## 5. 不做

1. 不接 Cultured Code 或 Chat 的真实服务。
2. 不复制到生产 UI。
3. 不实现同步、通知、账号、Calendar 权限或完整拖拽持久化。
4. 不把 Chat 的 Decision、Run、Blocker、Artifact 待办化。
5. 不在本轮发明 Chat 化的颜色、品牌或导航。

## 6. 完成门

1. 首屏在相同视觉比例下完成源图与实现并排 Design QA。
2. 三栏结构、窗口比例、字体层级、行密度、留白、Today 黄色和底部工具栏可一眼对应源图。
3. 核心流程可完整操作，详情、When、This Evening、完成与 Undo 均有可见反馈。
4. 浏览器无控制台错误；`npm run build` 与 `npm run test:sites` 通过。
5. `design-qa.md` 最终结果必须为 `passed`。
