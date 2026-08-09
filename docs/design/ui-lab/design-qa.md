# UI Lab UL1 Design QA

## 对照对象

- Source visual truth：
  - `docs/design/screenshots/source-workspace-p11-okr-light.png`：Chat 已批准的黑白壳层、持续工作上下文与信息密度基线。
  - `docs/design/screenshots/source-workspace-p11-today-light.png`：Chat 已批准的 Today 壳层与主导航基线。
  - `docs/design/references/basecamp-interaction-audit-v0.1.md`：Project Room、tool view、item detail 与返回路径。
  - `docs/design/references/things-today-interaction-audit-v0.1.md` 与 `hey-calendar-interaction-audit-v0.1.md`：Today / This Evening、时间约束与对象来源。
- Rendered implementation：`http://127.0.0.1:8100/`。
- Implementation screenshots：
  - `docs/design/ui-lab/evidence/ul1-project-thread-desktop.png`
  - `docs/design/ui-lab/evidence/ul1-today-thread-desktop.png`
  - `docs/design/ui-lab/evidence/ul1-today-paper-mobile.png`
- Combined comparison evidence：
  - `docs/design/ui-lab/evidence/ul1-qa-project-comparison.png`
  - `docs/design/ui-lab/evidence/ul1-qa-today-comparison.png`

## 视口与密度归一化

- Source desktop screenshots：`1707 × 960` px，对应约 `1707 × 960` CSS px。
- Browser desktop verification：页面报告 `1440 × 900` CSS px；implementation screenshot 为 `1920 × 1200` px，IAB 捕获密度约 `1.33`。
- Browser mobile verification：页面报告 `390 × 844` CSS px；implementation screenshot 为 `520 × 1125` px，IAB 捕获密度约 `1.33`。
- Combined comparison 将 source 与 implementation 的同一首屏区域都归一化到 `900 × 506`，不把浏览器捕获密度差异当成设计偏差。
- 额外验证最低视口：IAB 报告 `374 × 844`，页面与文档宽度无横向溢出。

## 对照状态

1. Project：`scene=project&theme=thread&state=overview`。
2. Project 下钻：`scene=project&theme=thread&state=work-detail`。
3. Today：`scene=today&theme=thread&state=default`。
4. Today 整理反馈：`scene=today&theme=paper&state=evening-moved`。
5. 深色主题：`scene=project&theme=graphite&state=overview`。

## 完整页面比较

### Project Room

- 保留 source 的 88px 全局导航、稳定上下文栏、hairline、系统字体与黑白骨架。
- 按 UL0 批准结论，将原来的“会话 + 运行分栏”改为稳定 Project Room；最新可信更新、当前 Work、需要介入、Agent 与 Artifact 都属于同一个 Project，而不是等权 Dashboard 卡片。
- 标题尺度与房间式单页结构是有意变化：用于建立 Project 的长期地点感；没有复制 Basecamp 六宫格或 Linear 灰阶密度。
- `Project → Work → Work detail → browser back` 保留 Project 归属与 URL 状态，符合对象连续与返回合同。

### Today

- 保留 source 的全局导航、主内容留白和黑白排版，同时删除旧版四宫格 Dashboard。
- 按 Things / HEY 审计改为 `时间约束 → 白天 → 今晚` 的连续垂直节奏；Event、Decision、Run、Blocker 保留不同类型、来源与动作。
- “今天留一点空白”与注意力容量条提供克制的产品性格，但容量只属于个人投影，不修改 Project 权威优先级。

## 聚焦区域比较

1. `project.latest-update`：health、署名、时间和正文同时出现；正文明确“不是自动摘要”。该区域在 Project combined comparison 中可读，无需额外裁切。
2. `project.needs-attention`：使用局部暖色的“阿橘 → 你”交接结；Agent 身份色不与 success / warning / danger 状态色混用。
3. `today.calendar`：时间、连续轨道、来源 Calendar 与 Project 关联同时可见；Event 不提供 Work 完成按钮。
4. `today.daytime`：Decision、Run、Blocker 使用文字、形状和颜色三通道，不全部使用 checkbox。
5. `today.undo-toast`：移动到今晚后显示明确结果与撤销；URL state 可刷新恢复。

## 五项设计检查

1. **字体与排版**：只用项目既有系统字体栈和 400 / 600 字重；主标题使用紧凑字距，正文 15–16px，辅助文字 13px。中文标题在 390px 与约 375px 自然换行，无截断或横向滚动。
2. **间距与布局**：桌面为全局导航、上下文栏、主工作区三层；Project 使用一张房间式大表面而非卡片墙；Today 使用连续时间与列表。移动端隐藏两个侧栏，改为单列内容 + 底部导航，主操作不被遮挡。
3. **颜色与 Token**：`Thread Light`、`Paper`、`Graphite Dark` 共用组件结构；组件 CSS 没有硬编码颜色，全部消费语义 Token。无渐变、发光或重阴影。
4. **图像与资产**：source 与 UL1 目标不包含照片、品牌插画或非标准图标，因此实现不生成占位图片，也不使用 emoji、手绘 SVG 或装饰性资产。Agent 首字头像是身份内容，不替代某个被遗漏的 source asset。
5. **文案与内容**：Project、Work、Decision、Run、Artifact 使用同一 fixture identity；页面持续标记 `UI Lab / Fixture / 非真实服务`，不会冒充已接后端或真实完成。

## 行为、响应式与可访问性

- 两个场景、三个主题与关键状态均可由 URL 深链接并在刷新后恢复。
- 已验证 Project Overview → Work → Work detail → 浏览器返回两级路径。
- 已验证 Today “移到今晚 → 状态反馈 → 撤销”，白天 `3 → 2 → 3`、今晚 `1 → 2 → 1`。
- 已验证键盘 `T / P` 切换 Today / Project，主题 `select` 键盘可用。
- `1440 × 900`、`390 × 844` 与约 `375 × 844` 均无页面级横向溢出。
- 390px 下两个侧栏隐藏、底部导航出现，所有可见 button / select 最小高度为 `44px`。
- Thread / Paper / Graphite 辅助文字对比度分别通过；Paper tertiary 初版 `4.46:1` 已调整到 `4.53:1`。
- 浏览器控制台无应用 error 或 warning。

## 比较与修复历史

### 第 1 轮

- [P2] `Paper --text-tertiary` 对主背景对比度为 `4.46:1`，低于正文 AA 门槛。
  - 修复：`#776d61 → #766c60`。
  - 修复后：对比度 `4.53:1`；Thread tertiary `4.51:1`，Graphite tertiary `6.69:1`。
- [P2] Today fixture 初版把错误的对象设为可移动，点击其他行可能移动 Decision。
  - 修复：只有 `today_decision` 支持“移到今晚 / 移回白天”，Run、Blocker 与普通晚间复核不显示错误动作。
  - 修复后：页面只存在 1 个“移到今晚”入口，URL、列表数量与撤销结果一致。

### 第 2 轮

- 重跑桌面、390px、约 375px、三主题、深链接、刷新、返回、移到今晚和撤销；未发现新的 P0 / P1 / P2。
- P3 后续：Gate B 可根据用户标注微调主标题尺度和 Project 首屏密度，但不阻塞 UL1 结构审核。

## 最终结果

final result: passed
