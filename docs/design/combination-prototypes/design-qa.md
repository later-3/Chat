# Literal Reference Compositions — Design QA

final result: **passed**

- Stage 1 literal composition：`P0=0 / P1=0 / P2=0`
- Stage 2 themes：`P0=0 / P1=0 / P2=0`
- 自动化：`107/107`
- production build：`4805 modules`
- 页面 console warn/error：`0`

## 1. 对照对象

当前实现不再对照旧的抽象组合画面，而是逐个对照 6 个冻结来源：

| 来源 | freeze | 组合内代表状态 |
|---|---|---|
| Basecamp | `13656c41f0407e24d94a2f174a71525f21c2fc9c` | Enormicom Project Room |
| Linear | `a74e088c0f7f1d04c653ae0a18c2487e0dff3879` | Issue List + Peek |
| Things | `2b431c0942b7747e4c56210ada148e37684f109d` | Today |
| HEY Calendar | `87596d433e120fa09c85484bd8591c1c6a4fdd30` | Day + Event candidate |
| Microsoft Agent Feed | `eed0aa0e4b9fec38fcf7e4eb6684a23e9897e8aa` | Needs attention + detail |
| Heptabase | `3f9d9b5bf70f315580fa0d3f831f45f87a3d95eb` | Whiteboard + Card panel |

同尺寸 source-left 对照见 `evidence/stage1/visual-compare/compare-*.png`；六来源总表为 `compare-six-sources-contact-sheet.png`。判断依据是同屏比较，不是只看实现截图。

## 2. Stage 1：原型原貌组合

### 2.1 桌面视觉

- CSS viewport：`1440×900`；最终主题矩阵记录的设备像素比为 `1.5`。早期同屏证据曾使用 `0.75` 图像归一化比例，那不是浏览器 DPR。
- 宿主胶水：左栏 `58px`；顶部 header + context 共 `90px`；iframe `1382×810`。
- 6/6 来源直接显示冻结字体、颜色、图标、资产、内容密度与原交互层级。
- Basecamp 长页 `scrollHeight=1157` 属原来源；HEY 比 iframe 高 `3px` 属舍入 P3；其余来源无横溢。
- fresh-tab 6 场景 console warn/error `0`。

证据：`evidence/stage1/visual-compare/` 与 `evidence/stage1/pass1/`。

### 2.2 移动矩阵

- CSS viewport：`391×844`。
- 3 组合 × 8 场景 = `24/24` 非空，owner / source 映射正确。
- document root、组合按钮、场景导航和 6 来源均无横向溢出。
- 可见启用控件 `<44×44 = 0`；无名称控件 `0`；console warn/error `0`。
- Things / HEY / Agent Feed / Heptabase 使用原生单列或 section 层级；没有缩放桌面窗口或 Canvas。

证据：`evidence/stage1/mobile-audit/`，最终 Agent 宽度复验在 `after-fix-2/agent-feed-391x844.png`。

### 2.3 真实核心路径

1. Basecamp Home → Project Room → Tasks / Schedule / My Events / Do Today 的 canonical owner 跳转。
2. Linear List → Peek → full detail → Back；Project Updates → compose → publish → history / Pulse。
3. Basecamp Todo List → Detail → Complete → Back（只在 `room-basecamp` 可达）。
4. Things Today → Complete → Undo；Event row → HEY Calendar。
5. HEY Day → Week → Year；email candidate → conflict → free slot → Save。
6. Agent Feed `outcome_unknown` → Reconcile；Open record → 当前组合的 Work owner。
7. Heptabase Card → Locations / Library / Chat / Board；Share focus lifecycle。
8. 浏览器 / 产品返回保持来源对象与焦点语义。

## 3. Stage 2：4 个统一主题 + source 基线

### 3.1 自动化合同

- 宿主 / owner / theme：`15/15`
- Basecamp：`22/22`
- Linear：`16/16`
- Things：`18/18`
- HEY：`3/3`
- Agent Feed：`11/11`
- Heptabase：`18/18`
- Sites：`4/4`
- 合计：`107/107`

所有来源都在原 `styles.css` 后加载 `theme-overrides.css`；override 只命中 `warm-room / quiet-day / graphite-ops / common-thread`，`source` 没有 selector。合同禁止主题层重画 display / grid / position / width / spacing 等布局声明。

### 3.2 桌面 30 面

- 5 主题 × 6 来源 = `30/30`。
- host `data-theme` 与激活 iframe `html.dataset.theme`：`30/30` 一致。
- 真实内容：`30/30`；空白 `0`；横溢 `0`；console warn/error `0`。
- CSS viewport：`30/30` 为 `1440×900`。
- Warm `#245a46 / r10`、Quiet `#126fd3 / r8`、Graphite `#5b5fc7 / r6`、Common `#3d6f60 / r8` 在六来源的 canvas / ink / border / primary / radius 上均可区分且同主题一致。Quiet 从视觉参考的 `#1677e8` 下调亮度，白字对比由 `4.34:1` 提升到 `4.95:1`。
- Quiet 对比度调整后由根 IAB 定点重跑 6/6 来源：`data-theme=quiet-day`、真实内容、`1440/1440`、console `0`；新截图为 `quiet-day-*-accessible.png`，并已覆盖 `theme-quiet-day-contact-sheet.png`。

证据：

- `evidence/theme-qa/desktop/metrics.json`
- `theme-warm-room-contact-sheet.png`
- `theme-quiet-day-contact-sheet.png`
- `theme-graphite-ops-contact-sheet.png`
- `theme-common-thread-contact-sheet.png`
- `source-vs-themes-{projects,work,today,calendar,agents,knowledge}.png`

### 3.3 移动 40 面

- 5 主题 × 8 场景 = `40/40` 非空，主题传播 `40/40`。
- 3/3 组合切换通过。
- Host / iframe 无横溢 `40/40`；组合栏、主题栏、场景栏无横滚 `40/40`。
- 可见启用控件 `<44×44 = 0`；无名称控件 `0`；console warn/error `0`。
- 首轮 16 张矩阵截图为 CSS `391×844`，浏览器输出像素 `520×1125`；Quiet 对比度调整后另有 8 张逐场景 accessibility 定点复验和 1 张 contact sheet。
- Quiet 对比度调整后再次定点重跑 8/8 场景：host 与 child 均 `391/391`、主题同步 `8/8`、console `0`；新证据为 `quiet-day-*-accessible-391x844.png` 与 `quiet-day-accessible-contact-sheet.png`。

证据：`evidence/theme-qa/mobile/`。

### 3.4 状态连续性

主题最初复用 `chat:route`，会把 Linear canonical `peek=1` 重放，形成 P1。已拆成独立 `chat:theme`：只 `replaceState` 子 iframe 的 theme query 与 `documentElement.dataset.theme`，不 dispatch `popstate`、不重建 React App。

真实浏览器复验 6/6：

| 来源 | 非默认状态 | 切主题后 |
|---|---|---|
| Basecamp | Unstar Enormicom | 仍为未星标 |
| Linear | Close Peek | Peek 保持关闭，iframe src 不重建 |
| Things | Complete Action + Undo toast | Action 仍完成，Undo 仍在 |
| HEY | Event composer draft | dialog / draft 保留 |
| Agent Feed | 选择 `outcome_unknown` item | pressed item 与 detail 保留 |
| Heptabase | Locations tab selected | `aria-selected=true` 保留 |

## 4. 修复历史

### Stage 1

- **P1** direct `scene=room` 首载误显示 Basecamp Home → iframe 初始 URL 捕获当前 deep-link。
- **P1** Linear Work 默认没有 Peek → canonical route 增加 `peek=1`。
- **P2** 126px 宿主壳导致 HEY 首屏裁切 → desktop shell 压到 90px。
- **P1** `room-basecamp` Project Tasks 已打开 Basecamp Todo，但宿主仍标 Room → 所有组合都先进入 canonical Work scene。
- **P2** 移动组合栏 / 场景栏持久横滚 → 缩减到 44px 网格并消除滚轨。
- **P2** Basecamp mobile brand 宽 35px → 扩到至少 44px。
- **P2** Agent Feed page-bar 多出 8.38px → grid item stretch / max-width 收口，最终 root / workspace / page-bar 均 `391/391`。

### Stage 2

- **P1** 主题切换重放 canonical route，Linear Peek 重新打开 → 独立 `chat:theme`，状态 6/6 保留。
- **P1** 带 `theme=` 的 direct deep-link 初始 iframe 仍先固定为 `source`，部分来源 URL 已变但 `data-theme` 未同步 → stable iframe 的一次性 initial URL 直接捕获当前 theme；之后切换仍只走 `chat:theme`。
- **P2** 移动场景按钮 focus tooltip 把底栏从 391 扩到 478px → 移动端隐藏视觉 tooltip，accessible name / title 保留。

## 5. 残余边界

- P3：旧 Stage 1 全页截图没有后来加入的主题按钮；iframe 内 `source` 原貌未漂移。当前 theme QA 已提供新版 source-vs-theme 对照。
- P3：HEY 桌面有 `3px` 内滚动舍入；不遮挡持久控件。
- P3：原型使用内存 fixture，刷新恢复初始状态；不声称 Product Store 持久化。
- 浏览器工具本身偶发 Statsig 网络日志不属于页面；页面 `dev.logs({warn,error})` 始终为 `[]`。

最终残余：`P0=0 / P1=0 / P2=0`。
