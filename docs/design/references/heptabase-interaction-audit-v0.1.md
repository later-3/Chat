---
status: approved
version: 0.2
date: 2026-08-10
product: Heptabase
surface: Whiteboard + Card + Tabs + Context Chat
evidence: official-wiki + official-product-screenshots
---

# Heptabase Workbench 交互审计 v0.2

## 1. 结论

Heptabase 最重要的设计不是无限白板，而是一条非常清楚的所有权规则：**Whiteboard 不拥有 Card，所有 Card 都属于 Card Library；同一张 Card 可以出现在多个 Whiteboard。**

这为 Chat 的工作区提供了架构级启发：白板、工作流、Today、Conversation 和 Project Room 都应该是对象的观察或编排表面，不得复制 Work、Artifact、Decision 或知识事实。位置和连线表达思考上下文，但不自动成为权威业务关系。

## 2. 对象与壳层

```text
Shared card database
├── Card Library ── owns Card identity/content
├── Whiteboard ──── places Card references + spatial objects
├── Journal / Inbox / Tag Database / Highlight
└── Chat ────────── private or collaborative conversations

Application shell
├── left top: apps / research
├── left bottom: normal / web / pinned tabs, folders, groups
├── center: current card / whiteboard / web tab
└── right sidebar: chat / references / info / location / insight
```

## 3. 点击与操作地图

| # | 入口 / 操作 | 结果与反馈 | 证据 | 设计理由 |
|---|---|---|---|---|
| 1 | Card Library 打开 Card | Card 作为 tab 打开；Info 显示 tags、properties、出现过的 Whiteboards | `D+O` | 以稳定 Card 为中心，而非以某张白板为中心 |
| 2 | 将 Card 拖到 Whiteboard | 放置同一 Card 的空间实例，不转移所有权 | `D` | 同一知识可进入多个思考语境 |
| 3 | 在 Whiteboard 新建 Card | 新 Card 同时进入 Card Library | `D` | 画布创建仍遵守统一事实源 |
| 4 | Card Info 的 Whiteboard name | 打开对应 Whiteboard 并聚焦 Card 位置 | `D` | 从对象回到它的空间语境，而不靠复制内容 |
| 5 | Whiteboard 空白处右键 | 新建 Card、Text、Mindmap、Journal、Section、Sub-whiteboard 等 | `D` | 空白区承担“为思考增加结构” |
| 6 | 画框多选 / 右键对象 | 批量移动、换色或执行高级动作 | `D` | 空间编辑遵循桌面式直接操纵 |
| 7 | New tab / Global Search `Cmd+O` | 搜索 Card、Whiteboard、Chat、Tag、Google、YouTube 并打开为 tab | `D` | 搜索同时是导航和工作上下文入口 |
| 8 | Pin / Folder / Tab Group | 保持常用上下文并按 Work / Life 等场景分组 | `D+O` | 用户组织的是正在进行的上下文，不是数据目录 |
| 9 | 右侧 Card Library | Card 在 side panel 中作为参考；Whiteboard 上可继续拖入 | `D` | 写作或思考时保留主表面，同时并排引用 |
| 10 | 右侧 Chat | 当前 tab 名称对 AI 可见，但内容不会自动送入模型；开启 Space search 后系统可检索 Space，实际读取会显示 `searched / viewed` | `D` | 工作位置、检索范围和真正读取的材料必须区分 |
| 11 | Chat `+` / `@` | 手动增加 Card、Whiteboard、Section、PDF 等上下文并返回引用；关闭 Space search 时可只允许这些显式材料 | `D` | 上下文可见、可增补、可追溯，并给敏感材料一个确定边界 |
| 12 | 拖动 AI response 到 Whiteboard | 变成可编辑、可注释和连接的内容；也可保存为 Note Card | `D` | 模型输出先是候选，用户选择后才进入知识空间 |
| 13 | Card 的 Whiteboard location | 查看该 Card 在哪些 Whiteboard 的哪个位置 | `D` | 对象身份与每个空间实例的位置分离 |
| 14 | `Cmd+K` Command Palette | 查找动作和快捷键 | `D` | 复杂工作台提供统一动作发现面 |

## 4. 关键路径

### 4.1 同一对象进入多个思考空间

```text
Card Library owns Card A
  → place A on Whiteboard X
  → place A on Whiteboard Y
  → edit Card A
  → both placements show same content
  → Info lists X + Y and can focus either location
```

### 4.2 在当前材料旁与 AI 协作

```text
Open Card / Whiteboard tab
  → open Chat right sidebar
  → AI knows the current tab name, not its content
  → manually add sources, or enable Space search
  → show searched / viewed access records
  → answer with citations
  → drag useful answer to Whiteboard / save as Card
```

关键边界：`Space search` 在当前产品中默认开启，可搜索整个 Space，但模型只读取系统选出的少量对象（官方说明约 20 个），且访问会显示 `searched / viewed`。用户若不希望自动检索敏感材料，应关闭它并只手动添加上下文。AI response 在被保存前只是对话输出；保存后仍应保留来源和生成身份。

### 4.3 浏览式工作上下文

```text
Global Search / New tab
  → open Card / Whiteboard / Web
  → pin important tabs
  → group by scenario
  → keep reference in right sidebar
```

## 5. 为什么成立

1. Card identity 与 Whiteboard placement 分离，允许复用而不复制。
2. 左侧 apps 是稳定能力，tabs 是短期工作记忆；信息架构与进行中上下文分层。
3. 中央主表面与右侧引用 / Chat 构成“做事 + 看材料”的并排工作台。
4. 空间位置、Section、连接和子白板帮助外化思考，但 Card Library 仍保存权威对象。
5. AI 只先知道当前 tab 名称；真正读取来自手动上下文或 Space search 的可见访问记录，回答带引用；模型与材料关系可追踪。

## 6. 风险与证据边界

1. 无限画布容易变成缺少入口、命名和维护规则的视觉仓库。
2. 位置、颜色与连线含义由用户自行约定，不能直接成为系统权威关系。
3. Apps + Tabs + right sidebar 形成多层导航，窄屏和新用户认知成本高。
4. 右键、拖拽、画框和 hover AI actions 都必须有键盘 / 触摸 / 辅助技术等价路径。
5. AI 自动创建新 Card 会增加重复内容和来源治理压力。
6. 官方 Wiki 不能证明焦点顺序、屏幕阅读器语义、协作冲突与离线恢复。
7. Space search 目前只能按整个 Space 开关，不能声明“可搜索本 Space、但永不读取其中某张 Card”；这不是细粒度 consent 模型。
8. 共享 Whiteboard 的权限边界依赖显式放置：协作者只看到被分享 Whiteboard 及其关联 Card；嵌入但未直接放置的 Card 可能不可见，不能从“同在一个 Space”推断可见性。

## 7. 对 Chat 的翻译

### Take

1. 对象归 Product Store，Workbench 只拥有布局与视图状态。
2. 同一 Work / Artifact 可出现在 Project、Whiteboard、Conversation 和 Today。
3. 主工作面与上下文侧栏并排，AI 上下文显式可见。
4. 从对象可回到每个空间位置，避免“画布里失踪”。
5. 把 AI 的搜索范围、实际读取记录和手动上下文分开显示。

### Adapt

1. Whiteboard placement 保存 `objectId + position + local annotation`，不复制对象事实。
2. 连接先是用户的视觉关系；确认后才可升级为 Dependency / Evidence link 等领域关系。
3. AI response 落入 Workbench 时标记为 candidate；采纳或保存后保留 provenance。
4. 桌面可用三栏，移动端改成层级导航和明确返回，不缩小无限画布硬塞。
5. Chat 的 visibility / consent 必须由 Participant、Resource 与版本化权限事实表达；不能照搬 Heptabase 当前整个 Space 的搜索开关。

### Refuse

1. 不把无限画布作为默认首页或所有工作的唯一入口。
2. 不把位置、颜色、箭头直接当 Project / Run 的权威状态。
3. 不在拖拽时复制 Work、Decision、Artifact 或 Card。
4. 不让 AI 自动生成的 Card 无来源地进入长期知识。
5. 不把“当前打开”“同一 Space”或“Agent 搜索得到”当成用户已同意读取、共享或写回。

## 8. 对 UI Lab 的约束

1. UL1 Workbench 必须证明同一对象跨 Conversation / Project / Whiteboard 身份一致。
2. 移动对象只改 placement；编辑对象内容更新所有视图。
3. 从对象可列出并跳到所有 placements，返回时恢复缩放和焦点。
4. AI 上下文 chips、引用、candidate 状态和保存动作必须可见。
5. 右键、拖拽、hover 都有按钮或菜单等价动作。

## 9. 2026-08-10 当前界面与边界复核

1. 当前官方首页的 `Whiteboard + Card detail` 仍直接证明：画布承担空间编排，Card 内容在相邻编辑面中保持独立身份；`Whiteboard + PDF + AI Chat` 又证明主材料、阅读面和 AI 对话可以并排工作。
2. 当前 `User Interface Logic` 继续明确：所有 Apps 共享同一 Card 数据库；Card Info 可列出出现过的所有 Whiteboards；右侧 Card Library 可作为参考并把同一 Card 拖入 Whiteboard。
3. 当前 AI 数据说明纠正了旧审计中的“当前 tab 自动成为内容上下文”推断：默认只知道 tab 名；只有手动添加、或 Space search 后显式 `searched / viewed` 的对象正文会发送给模型。
4. 当前 Collaboration Q&A 明确：Space 默认私有；协作者只看到显式共享的 Whiteboard 及其关联 Card；权限分 Owner / Full access / Can edit / Can view；共享范围不是未来 Chat 社交系统的替代品。
5. 本轮冻结原型把这些边界做成可点击证明，而不是扩写 Heptabase：`Card Library → placement → all locations → back`、`explicit context → access log → AI candidate → save as Card`、`Share → per-Whiteboard × per-participant permission`，移动端改成 Section 顺序大纲。

## 10. 官方证据

1. [User Interface Logic](https://wiki.heptabase.com/user-interface-logic)。
2. [Fundamental Elements](https://wiki.heptabase.com/fundamental-elements)。
3. [Use Case and Workflow](https://wiki.heptabase.com/use-case-and-workflow)。
4. [Heptabase current product page](https://heptabase.com/)，本轮于 2026-08-09/10 从页面实际渲染与官方图片资产复核。
5. [What data can AI access when Space search is on?](https://support.heptabase.com/en/articles/13009956-what-data-can-ai-access-when-i-turn-on-the-space-search-option-in-an-ai-conversation)。
6. [Collaboration Q&A](https://support.heptabase.com/en/articles/10510497-collaboration-q-a)。
7. [Publish Whiteboards with a public link](https://support.heptabase.com/en/articles/12121546-how-do-i-publish-whiteboards-with-a-public-link)。
