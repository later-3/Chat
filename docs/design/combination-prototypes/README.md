# Chat Literal Reference Compositions

这是 6 个冻结参考原型的**直接组合应用**，不是重新画一套“像参考产品”的 UI。Basecamp、Things、Linear、HEY Calendar、Microsoft Agent Feed、Heptabase 的真实 JSX、交互模型、CSS 和资产都保留在 `references/`；宿主只负责 3 件事：场景路由、重叠功能唯一主责、可切换主题。

此前的 `Project Room / Today Rhythm / Evidence Workbench` 抽象重绘方案已经废弃，不再是当前实现、体验 URL 或任务 2 输入。

## 为什么是 3 套

6 个参考里真正影响整 App 骨架的重叠主要发生在 Basecamp 与 Linear：

- 谁拥有多 Project 的默认入口：Basecamp Home，还是 Linear Project overview。
- 谁拥有 Work 的 List / Peek / Detail：Basecamp To-do，还是 Linear Issue。
- 谁拥有 Project Update：三套都由 Linear 独占，避免 Message Board 与 Update 重复。

Things、HEY、Agent Feed、Heptabase 分别独占 Today、Calendar、Agent supervision、Knowledge，不参与重复竞争。由此得到 3 个完整度高且不重复的有效组合；第 4 个数学组合“Linear Project 首页 + Basecamp Work”只增加第二套 Project / Work 跳转，没有新增能力，因此拒绝。

| 组合 | 默认骨架 | Projects | Room | Work | Update | 固定补全场景 |
|---|---|---|---|---|---|---|
| `room-linear` / 房间优先 | Basecamp | Basecamp | Basecamp | Linear | Linear | Things Today、HEY Calendar、Agent Feed、Heptabase |
| `room-basecamp` / 原生房间 | Basecamp | Basecamp | Basecamp | Basecamp | Linear | Things Today、HEY Calendar、Agent Feed、Heptabase |
| `work-linear` / 工作优先 | Linear | Linear | Basecamp | Linear | Linear | Things Today、HEY Calendar、Agent Feed、Heptabase |

每个能力在每套里只有 1 个 owner。被裁掉的只是重复入口，不是把两个任务系统拼在同屏：

- Linear-work 组合中，Basecamp 的 Project Tasks / My Tasks / Everything todos 都跳到同一个 Linear Work 场景；Basecamp Todo 链不可达。
- Basecamp-work 组合中，Linear Issues 不可达；Linear 只补 Project Update / Pulse。
- Calendar / My Events / Schedule 统一进入 HEY；Do Today 统一进入 Things。
- Agent Feed 的 related record 回到当前组合的权威 Work；Feed 不拥有 Decision / Run / Evidence 正式事实。
- Things 只拥有 Action；HEY 只拥有 Event；Heptabase 只拥有知识 Card / placement / context。

## 可体验入口

启动后统一入口为 `http://127.0.0.1:4177/`。

| 组合 | URL |
|---|---|
| 房间优先 | `/?composition=room-linear&scene=projects` |
| 原生房间 | `/?composition=room-basecamp&scene=projects` |
| 工作优先 | `/?composition=work-linear&scene=work` |

8 个场景均可直接 deep-link：`projects`、`room`、`work`、`updates`、`today`、`calendar`、`agents`、`knowledge`。例如：

```text
/?composition=room-linear&scene=room
/?composition=room-basecamp&scene=work
/?composition=work-linear&scene=agents
```

## 主题切换

顶部 `原 / 暖 / 静 / 准 / 合` 5 个按钮在同一套完整应用内切换：

| ID | 按钮 | 来源 |
|---|---|---|
| `source` | 原 | 6 个参考原型各自的冻结视觉；不做 override |
| `warm-room` | 暖 | Basecamp 的纸张、forest green、clay 协作感 |
| `quiet-day` | 静 | Things / HEY 的 clean white、ink blue、sky / gold 节奏 |
| `graphite-ops` | 准 | Linear / Agent Feed 的 graphite、indigo、cyan 精密感 |
| `common-thread` | 合 | 从 6 套提炼的 neutral stone、evergreen、amber Chat 共性 |

主题层只覆盖颜色、文字、边界、focus、圆角与阴影，不改 JSX、布局尺寸、图标、资产、对象或交互。主题使用独立 `chat:theme` 消息原地更新 iframe；不会重放 canonical route，因此关闭 Peek、编辑草稿、完成 Action、选择 Feed item 或切换 Heptabase panel 后换主题，状态仍保留。

可直接用 query 打开主题：

```text
/?composition=room-linear&scene=room&theme=warm-room
/?composition=room-linear&scene=today&theme=quiet-day
/?composition=work-linear&scene=agents&theme=graphite-ops
/?composition=room-basecamp&scene=knowledge&theme=common-thread
```

## 直接复用路径

```text
references/basecamp     Basecamp Home / Room / Tools / Todo
references/linear       Linear List / Peek / Detail / Update / Pulse
references/things       Things Today / Project / When / Deadline / Complete / Undo
references/hey          HEY Day / Week / Year / Event candidate / conflict / save
references/agent-feed   typed Agent supervision / HITL / outcome_unknown
references/heptabase    Card / Whiteboard / placement / context / provenance
```

宿主实现仅在 `src/App.jsx`、`src/model.js`、`src/styles.css`。每个来源的 `theme-overrides.css` 都在原 `styles.css` 后加载；`source` 不命中任何主题选择器。

## 核心可点击路径

- Basecamp Home → Project room → Message / Docs / Tasks / Chat / Schedule / Workflow → Back。
- Linear List + Peek → full detail → Back；Project Overview → Updates → New update → Publish → Pulse。
- Things Today → detail / When / Deadline / complete → Undo；Calendar row → HEY。
- HEY Day → Week → Year；Email candidate → conflict → free slot → Save。
- Agent Feed Needs attention → typed task → Decide / Reconcile / Open record。
- Heptabase Whiteboard → Card / Locations / Library / Chat / Board → Share。
- 3 套组合切换、8 场景切换、5 主题切换都不复制权威对象。

## 运行与验证

```bash
cd docs/design/combination-prototypes
npm install
npm run dev -- --host 127.0.0.1 --port 4177 --strictPort
npm test
npm run build
npm run test:sites
```

当前自动化为宿主 / 主题 `15/15` + 六来源 `88/88` + Sites `4/4` = `107/107`；production build `4805 modules`。桌面、移动、同屏视觉和状态连续性证据见 [`design-qa.md`](./design-qa.md)。

## 边界

- 这是独立设计原型，不修改 `apps/web` 或生产 UI。
- mock state 保存在当前 iframe 内存；刷新恢复 fixture。
- 参考 UI 只背书覆盖范围与交互语法；Chat 的 Stage / Milestone / Iteration / Work / Scope / Action / Decision / Evidence / Participant 仍由正式产品合同拥有。
- 当前不虚构跨账户社交、他人 Agent 授权、Agent—Agent 私聊或代表他人 consent。

工作 branch：`codex/literal-reference-compositions`。最终 freeze commit 以 [`../references/README.md`](../references/README.md) 登记为准。
