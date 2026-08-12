# Plane 工作台视觉证据清单 v0.1

更新时间：2026-08-12

用途：工作台差异试点；不是第 7 个参考项目登记，也不是原型输入冻结。

## 证据边界

- 产品：Plane。
- 固定开源仓库：[`makeplane/plane`](https://github.com/makeplane/plane)，本地只读副本 `/Users/xulater/Code/opc-os/plane`。
- 固定源码提交：`1c8a60f858d8472aa56e29994ec1c7926da2c6ce`（`preview`）。
- 画面来源：Plane 官方 Changelog 和上述官方 GitHub 仓库 README 引用的官方媒体域名。
- 当前未完成登录态实操。以下画面能证明公开展示的布局和交互构件，不能单独证明完整状态转换、失败恢复或 Community Edition 与 Cloud/Commercial 的功能同一性。
- 官方 Changelog 同时混有产品截图和抽象插画；本目录只保留经人工打开核验、能读出真实 UI 构件的 4 张画面。

## 已接受画面

### 01 — Plane AI：自然语言到交互图表

![Plane AI 生成交互图表](./screenshots/01-plane-ai-interactive-chart.webp)

- 文件：`screenshots/01-plane-ai-interactive-chart.webp`
- 尺寸：`1920 × 1080`
- SHA-256：`ecb1c47bca76e65be037fb12472a80138e213964421a41dc3d5a3826024d9105`
- 官方页面：[AI charts, column layouts, and project labels — 2026-03-16](https://plane.so/changelog/2026-03-16-ai-charts-column-layouts-and-project-labels)
- 官方原图：[`changelog-post-interactive-charts-in-plane-ai-light-desktop-4x-1920x1080.webp`](https://plane.so/api/media/file/changelog-post-interactive-charts-in-plane-ai-light-desktop-4x-1920x1080.webp)
- 能证明：对话请求和数据 Artifact 处于同一响应面；图表是可点击结果，而不是纯文本回答。
- 不能证明：检索步骤、Plan、工具调用、等待、暂停/恢复或来源面板。

### 02 — Wiki：AI Block 直接写入可编辑 Page

![Plane Wiki 中的 AI Block](./screenshots/02-ai-block-in-pages.png)

- 文件：`screenshots/02-ai-block-in-pages.png`
- 尺寸：`1920 × 1143`
- SHA-256：`7ee1091638d16cf0d83212774cf30aa70221fb1f4db3ef83217a50300cf63a8c`
- 官方页面：[AI Block in Pages — 2026-06-15](https://plane.so/changelog/2026-06-15-ai-block-in-pages)
- 官方原图：[`ai-block-pages-1-af8fa8f4-1920x1143.png`](https://plane.so/api/media/file/ai-block-pages-1-af8fa8f4-1920x1143.png)
- 能证明：AI 是 Wiki 的一级入口；提示、生成内容和 Page 编辑器同屏；生成内容落为可继续编辑的块。
- 不能证明：用户如何逐项接受修改、版本 Diff、回滚或冲突处理。

### 03 — Projects：完整工作台和多种工作视图入口

![Plane Projects 工作台](./screenshots/03a-github-overview.webp)

- 文件：`screenshots/03a-github-overview.webp`
- 尺寸：`3240 × 2112`
- SHA-256：`dfe2f6cb2e03dbfaeebe23ebd7c3092c05c59abc1e7c579bc90bf924fca81ba7`
- 官方页面：[Plane 官方 GitHub 仓库 README](https://github.com/makeplane/plane)
- 官方原图：[`github-top.webp`](https://media.docs.plane.so/GitHub-readme/github-top.webp)
- 能证明：两级左侧导航（产品级 + 项目级）、中央 Work items 看板、顶部视图切换和筛选同处一套工作台；对象范围从 Workspace/Teamspace/Project 逐层收窄。
- 不能证明：AI 是否能在这张工作台内直接驱动 Work item 状态，或不同布局切换后的数据保持方式。

### 04 — Intake：候选工作项的人工接受/拒绝边界

![Plane Intake 接受或拒绝](./screenshots/04-detailed-intake-work-item.webp)

- 文件：`screenshots/04-detailed-intake-work-item.webp`
- 尺寸：`1920 × 1080`
- SHA-256：`e54efa6b1cf248d2a1a85988399522d3373d1e397aacd89ef77cdc9a9fb892bb`
- 官方页面：[Web search in Plane AI, Project Subscribers — 2026-02-17](https://plane.so/changelog/2026-02-17-web-search-plane-ai-project-subscribers)
- 官方原图：[`changelog-detailed-intake-work-item-view-desktop-light-1920x1080.webp`](https://plane.so/api/media/file/changelog-detailed-intake-work-item-view-desktop-light-1920x1080.webp)
- 能证明：候选对象在进入正式工作系统前有显式 `Accept / Decline` 决定，且用户在决定前能看标题、描述和关键属性。
- 不能证明：该候选是否由 AI 创建、审批后精确写回到哪个范围、拒绝理由或重提流程。

## 已淘汰画面

- `Workspace views: Kanban and Calendar` 的官方媒体只显示两个抽象图标，没有导航、对象或状态信息，因此没有纳入工作台布局证据。
- GitHub README 中其余拼贴画面可辅助说明 Timeline、Views、Analytics，但与本轮“基础工作台 + AI 介入 + 人工边界”的 4 张核心证据重复，暂不扩大样本。

## 下一步验证

1. Pi 每次只读 1 张图，按固定字段描述布局、主要对象、可执行动作、状态反馈、人工边界和证据限制。
2. Codex 通过 Trace 检查 Pi 是否真正读取指定图片、是否跨图脑补、是否反复扫描。
3. 另开源码核对 Attempt，只核对导航、布局视图、Page 编辑器和 Intake 决定的组件归属；公开源码没有出现的 AI Cloud 表面必须标为“仅视觉证据”。
