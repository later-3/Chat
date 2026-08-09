---
status: frozen
version: 0.3
date: 2026-08-09
owner: Chat product design
task_type: reference-study scenario audit
branch: codex/basecamp-full-interaction-v0.2
supersedes: basecamp-full-interaction-reference-v0.2
---

# Basecamp 场景完整性与主题连续性 v0.3

## 1. 用户结果

这个参考实现不再按“有多少页面”验收，而按 Basecamp 解决的工作场景验收。用户可以实际体验 Home 组织、Project 作用域、六类工具的差异、个人工作、定向通知和对象下钻；主题与个人导航在页面切换中保持连续。

## 2. 本轮修正的问题

1. Home 使用浅色参考，Project/Tool 使用深色参考，导航被误解为 Project 触发换肤。
2. Folder 已进入状态但 Home 不显示，新建成功对用户不可见。
3. Message Board、Docs & Files、Chat、Schedule、Workflow 只有通用列表和创建输入，未表现各自解决的问题。
4. My bar 只存在 Home 和 Aggregate，进入 Project 后个人责任与定向通知入口消失。
5. v0.2 按页面和按钮数量验收，不能证明设计场景已经覆盖。

## 3. 实施范围

1. 全局浅色环境贯穿 Home、Folder、Project、Tool 与 Item；水滴主题仍是全局环境偏好，深色只保留为 Project tool 缩略图或 Hill Chart 这类局部内容。
2. Home 显示 Folder，Folder 页面投影同一批 Project 对象和 folder-scoped Activity。
3. Message Board 支持类别筛选、置顶标识、thread detail 和持久 reply。
4. Docs & Files 支持查找、folder/type 信息和 reference preview。
5. Chat 使用连续消息流与固定 composer，发送后进入同一条 stream。
6. Schedule 支持 Agenda / Calendar 切换和带日期的新建事件。
7. Workflow 使用真实 card/column 模型，card 可推进到下一 stage。
8. My bar 和 New for you 在 Project、Tool 和 Item 内持续可达。
9. 新增场景矩阵，明确 `Take / Adapt / Refuse`，并记录未覆盖边界。

## 4. 完成门

1. 选定的 12 类参考场景均有可见 UI、可操作交互和可验证状态结果。
2. Home → Project → 6 tools 不改变全局主题；所有深层页面都有 My bar。
3. Folder、Message reply、Document search/preview、Chat send、Schedule view、Workflow move 通过浏览器实测。
4. 纯模型测试覆盖新场景的稳定 ID、作用域和不可变更新。
5. `npm test` 与 `npm run build` 通过，浏览器 console 无应用错误。
6. 权限、真实上传、多人实时、外部服务等未实现能力必须作为研究边界明确列出，不伪装为完成。

## 5. 冻结结论

2026-08-09 完成门全部通过。Basecamp 参考实现冻结在“场景研究原型”层级：后续只修 P0/P1 缺陷或新增明确研究问题，不继续按页面数量扩张。
