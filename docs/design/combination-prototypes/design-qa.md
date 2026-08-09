# Combination Prototypes Design QA

## 对照对象

Source visual truth：

- `docs/design/ui-lab/evidence/ul1-project-thread-desktop.png`：已批准的 Project Room 黑白壳层、房间连续性与负责人 Update。
- `docs/design/ui-lab/evidence/ul1-today-thread-desktop.png`：已批准的 Today 连续日节奏、时间约束与对象分型。
- `docs/design/screenshots/heptabase/heptabase-workbench-desktop.png`：冻结参考原型中的对象身份、材料并排与工作台层级；组合原型有意不复制无限画布。
- `docs/product/design-guidelines.md`：Chat 语义 Token、44px、无渐变 / 重阴影、响应式与可访问性约束。

Rendered implementation：`http://127.0.0.1:4176/`（本次 freeze Session 保留的统一入口）。

Implementation screenshots：

- `evidence/qa/project-desktop-pass1.png`
- `evidence/qa/today-desktop-pass2.png`
- `evidence/qa/workbench-desktop-pass1.png`
- `evidence/qa/project-mobile-pass1.png`
- `evidence/qa/today-mobile-pass1.png`
- `evidence/qa/workbench-mobile-pass2.png`

同屏比较证据（左侧 source，右侧 implementation）：

- `evidence/qa/compare-project-source-left.png`
- `evidence/qa/compare-today-source-left.png`
- `evidence/qa/compare-workbench-source-left.png`

## 视口与密度归一化

- Desktop：页面报告 `1440 × 900` CSS px、`devicePixelRatio 1.5`；浏览器 override 为 `2160 × 1350`，implementation capture 为 `1440 × 900` px。
- Mobile：页面报告 `391 × 844` CSS px、`devicePixelRatio 1.5`；浏览器 override 为 `587 × 1266`，implementation capture 为 `391 × 843` px（捕获边界舍入 1px）。页面和文档 `scrollWidth = clientWidth = 391`。
- Project / Today source 原始文件为 `1920 × 1200`，其中已批准画面以 `960 × 600` 区域记录；同屏比较先裁出该区域并归一化到 `720 × 450`。
- Heptabase source 与 implementation 均为 `1440 × 900`，同屏比较各归一化为 `720 × 450`。

## 对照状态

1. Project Room：`?mode=project&view=overview`，Project Solution，Overview。
2. Today Rhythm：`?mode=today&view=overview`，全部范围，首屏。
3. Evidence Workbench：`?mode=workbench&view=overview`，需要我介入，全部 Agent。
4. Mobile：以上 3 个模式在页面实际报告的 `391 × 844` CSS 视口。
5. 额外状态：深色主题、Project Work 详情、Update editor、Decision revision / accept、Candidate edit / accept、Run reconciliation、Action complete / move / Undo。

## 五项设计检查

1. **字体与排版**：沿用 Chat 已批准的系统字体栈与 400 / 600–680 权重；页面标题 34–52px 自适应，正文 15–16px，小字 12–13px。桌面与 391px 中文标题自然换行，无截断。
2. **间距与布局**：桌面为全局模式、上下文与主工作区三层；Project 保持房间式表面，Today 保持连续垂直节奏，Workbench 保持监督列表 + 责任边界。移动端移除两层侧栏，改用顶部上下文、单列内容与底部模式导航。
3. **颜色与 Token**：所有组件颜色消费语义 Token；黑白骨架只用小面积暖色标记 Agent，success / warning / danger 保持独立。源码无渐变、发光或 box-shadow。
4. **图像与资产**：目标不需要照片、插画或品牌图像；所有 UI 图标使用 `@phosphor-icons/react`，未使用 emoji、inline SVG、手绘 SVG、占位图或 CSS 绘制的品牌资产。
5. **文案与内容**：3 个真实感 Project 覆盖工作、生活与爱好；Decision、Run、Candidate、Resource、Evidence、Participant 使用稳定 mock ID。页面持续标记组合原型与非真实服务，不冒充生产事实。

## 浏览器行为与可访问性

- Project：3 个 Project 可切换；Overview → Work → detail → 可见返回与浏览器返回均通过，返回焦点恢复到触发行；负责人 Update 编辑并发布 revision 通过。
- Today：Decision / Run / Blocker 没有完成按钮；4 个可逆 Action 才显示完成 / 移晚。完成 → Undo、移晚 → Undo 均恢复原状态。
- Workbench：Decision `revision 4 → 5` 且 hash 变化后接受；Candidate `revision 2 → 3` 后接受；已处理对象离开“需要我介入”。
- Run：`outcome_unknown → querying → verified / succeeded` 通过；全路径不存在 Undo，也不触发第二次发布。
- Filtering：Project status、Today scope、Workbench task type 与 Agent 均可交互；空结果有明确空态。
- Desktop 内置设备开关实测得到 `391 × 844` 移动壳层；真实 391px 视口自动使用同一层级导航。
- 391px 下无横向溢出、无未命名可见按钮，所有可见 `button / select` 宽高均不小于 44px。
- 键盘数字 `1 / 2 / 3` 切换模式，`Esc` 返回；`:focus-visible` 与 `prefers-reduced-motion` 已实现。
- 深色主题使用语义 Token 切换；浏览器控制台 `error / warn = 0`。
- 浏览器扩展在 capture 右侧叠加的两个粉色悬浮按钮不属于页面 DOM，已从实现判断中排除。

## 比较与修复历史

### 第 1 轮

- [P1] 可见“返回”按钮依赖 `history.state`，在外部浏览器控制面下点击没有离开详情。
  - 修复：可见返回使用 URL state 的 replace 导航；浏览器原生 Back 仍由 popstate 恢复列表。
  - 复验：Project detail → 返回得到 `?mode=project&view=work`，焦点恢复到 `work-list-work_memory_reconciliation-0`。
- [P2] 从 Project 滚动位置切换到 Today 时沿用了相同 scrollTop，Today 首屏从中段开始。
  - 修复：跨模式与列表 → detail 时重置 scrollTop；detail → list 恢复列表 scrollTop 和焦点。
  - 复验：Today / Workbench 切换后 `workspace-scroll.scrollTop = 0`。
- [P2] 移动 Workbench 的 status chip 作为 Grid item 被拉伸到整列宽。
  - 修复：移动选择器为 status chip 增加 `justify-self: start; width: auto`。
  - 复验：391px 下 chip `70px`、卡片 `359px`，不再拉伸且无横溢出。

### 第 2 轮

- 重新验证桌面、391px、深色主题、三套模式、设备开关、列表 / 详情 / 返回 / 焦点、筛选、编辑、决定、完成、撤销与对账。
- 同屏对照确认：实现保留已批准的字体、黑白骨架、栏宽层级、连续时间节奏与工作台结构；为组合冲突有意统一对象语法并拒绝复制 6 个产品皮肤。
- 未发现新的 P0 / P1 / P2。

## 残余边界

- P3：外部浏览器扩展会在截图右侧显示不属于页面的悬浮按钮；不影响应用 DOM、点击路径或交付 URL。
- P3：本原型为内存 Fixture，刷新会恢复初始状态；这是独立设计原型边界，不声称真实 Product Store 持久化。

final result: passed
