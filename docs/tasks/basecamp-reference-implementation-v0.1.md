---
status: user-approved
version: 0.1
date: 2026-08-09
owner: Chat product design
task_type: reference-study prototype
branch: design/basecamp-reference-v0.1
---

# Basecamp Home → Project 高保真 HTML 参考实现

## 1. 用户结果

用户可以在浏览器中直接对照 Basecamp 截图与可运行 HTML，判断界面是否真的具有 Basecamp 的空间结构、信息密度和点击节奏，而不是只借用概念名词。

## 2. 视觉真相

使用用户提供的 `2266 × 1282` Basecamp Home 截图作为 Home 首屏的唯一视觉真相。实现不得混入 Chat 的视觉壳层、Fixture、主题或品牌表达。

## 3. 范围

1. Home：顶部全局导航、左侧管理区、中央 Project 卡片区、右侧 Activity、底部个人导航。
2. Project Room：从 Home 的 Project 卡片进入，保留 Basecamp 式项目地点感。
3. Tool View：从 Project Room 进入 To-dos。
4. Item Detail：打开一条 To-do，并能按原路径返回。
5. Search / Jump、Project 星标与背景切换提供即时界面反馈。

## 4. 不做

1. 不接 Basecamp 或 Chat 的真实服务。
2. 不复制到生产 UI。
3. 不实现账号、权限、拖拽持久化、通知和完整移动端。
4. 不把参考实现改造成 Chat 设计。

## 4.1 原型专用依赖

1. `@fortawesome/fontawesome-free@6.7.2`：匹配 Basecamp 的实体图标语言；MIT；删除本参考原型即可退出。
2. `chart.js@4.4.9`：实现 Project Tasks 的 Hill Chart，避免用 CSS 或手绘 SVG 冒充；MIT；删除 Hill Chart 组件即可退出。

## 5. 完成门

1. Home 在与源图相同的桌面宽高比下完成并排 Design QA。
2. 顶、左、中、右、底五个作用域的轮廓和比例可一眼对应源图。
3. `Home → Project Room → To-dos → Item → Back` 可完整操作。
4. 浏览器无控制台错误；`npm run build` 与 `npm run test:sites` 通过。
5. `design-qa.md` 最终结果为 `passed`；若仍存在 P0/P1/P2 差异则不得交付。

## 6. 用户验收

- 2026-08-09：用户在浏览器检查最终原型后确认“像了”。
- 结论：Basecamp Home 参考实现通过，可作为下一批参考实现的高保真流程基线。
