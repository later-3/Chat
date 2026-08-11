# Microsoft Agent Feed Human Loop v0.2 Design QA

final result: passed

## 1. QA 范围

- v0.1 source：branch `codex/microsoft-agent-feed-reference-v0.1`，freeze `eed0aa0e4b9fec38fcf7e4eb6684a23e9897e8aa`，`http://127.0.0.1:4183/`。
- v0.2 implementation：branch `codex/microsoft-agent-feed-human-loop-v0.2`，`http://127.0.0.1:4184/`。
- 浏览器：Codex in-app Browser；没有使用独立 Playwright runner 替代视觉和交互 QA。
- 完成门：5 条主闭环、非法转换、1440×900、391×844、modal/focus/Escape/Back、console、横溢、44px、状态连续、同屏视觉对照。

## 2. 同屏视觉对照

`evidence/browser-qa/compare-v0.1-v0.2.jpg` 在相同 1440×900 CSS viewport、相同 Needs attention + Decision revision 7 状态下，把 v0.1 放左侧、v0.2 放右侧。浏览器 compositor 的 1920×1200 raster 只取经 DOM 证明的左上 1440×900 CSS 可视区，再并排；没有把合成留白当成页面布局。

复核结果：

1. 保留 Power Apps 紫色顶栏、应用 rail、Project Operations sitemap、Fluent 灰白层级、紧凑 feed、类型色条、圆形 Agent identity、薄 divider 与低圆角按钮。
2. 保留 feed/detail 主比例和 side/full 语义；full 模式增加 Agent 筛选列，移动端改为 Feed → Detail → Record，而不是缩小桌面 grid。
3. v0.2 新增 `Needs attention / Active / Recent results`、明确 status chip、权威对象条、Run timeline 与 typed action footer；没有重画成 Chat 自有 UI。
4. 删除硬编码 Insights 与 generic Undo 后，头部更安静；新增信息集中在详情内部，未破坏 Microsoft 参考的密度和读取顺序。

同屏检查后残余视觉 P0/P1/P2：`0/0/0`。

## 3. 自动化合同

| 套件 | 数字 | 结论 |
|---|---:|---|
| model / interaction contracts | `31/31` | 5 条主路径、再次修订、success/failure/re-entry、stale revision、manual disposition、reassign/stop、related record、非法转换、无万能动作 |
| Sites worker / packaging | `4/4` | 静态资源、app route fallback、API/write 不误回 shell、产物完整 |
| 合计 | `35/35` | 0 failed / 0 skipped |

`npm run build`：Vite `223 modules`，client JS `280.82 kB`（gzip `84.58 kB`），CSS `30.64 kB`（gzip `6.17 kB`），Sites 产物成功。

## 4. 真实浏览器路径

### A. Decision revision 7→8→Run

1. revision 7 显示 `8fe1…5c2a`、One waiting deployment Run 与 3 条 Evidence。
2. Request changes 打开真实 dialog；初始焦点在 Free-text feedback；自由文本、4 项结构化要求、Evidence、scope、material filename 可编辑。
3. Submit 后显示 `Waiting on agent / Agent revising`；Agent 返回 revision 8、hash `b47c…e910`、v7→v8 diff、Provider query ledger 与 5 项响应。
4. Approve 后 timeline 顺序为 `Decision fact committed → Resume accepted → Validate retry boundary → Authoritative policy record written`。
5. related record 显示 `decision-fact-8`、revision 8、hash、Evidence 与 Run；Back 后焦点回到 `Open record`。

### B. Assistance

1. 提交上下文、资源、manual result 与可选 filename。
2. Agent receipt 明确列出收到的 context/resources/manual result；Run 进入 Agent-owned resume。
3. 浏览器覆盖成功写回 Evidence record；模型合同另覆盖 failure 与再次请求介入，不生成假成功。

### C. Structured candidate

1. Health / Summary / Next step 可编辑；Accept 后成为 read-only authoritative Update。
2. Dismiss 后保持只读；Create new candidate 生成 `task-data-project-update-g2`，原 dismissed identity 保留。

### D. outcome_unknown

1. 可见普通 `Retry` 精确按钮数 `0`；状态机也拒绝 `retry`。
2. Reconcile 进入 `reconciling`，timeline 明示 `no new command sent`。
3. provider result found 后展示 command identity、request hash、provider hint、query Evidence。
4. Commit Product fact 后为 `reconciled`，精确 `Undo=0`、`Retry=0`；manual disposition 为另一路不创建 Product success fact。

### E. Agent—Agent delegation

1. Project Pilot 创建 delegated task 给 Evidence Scout；页面同时显示 parent task、delegated task、dependency、participants、visibility、current owner。
2. Evidence Scout 返回材料后 owner 回 Project Pilot；Pilot 消费后 parent 成功继续，related record 写入 returned Evidence。
3. 浏览器实点验证 Reassign 到 Research Navigator 与 Stop delegation；Canceled 保持 parent blocked。
4. composer 打开 4.3 秒后仍保持，证明人工编辑会暂停模拟 Agent 时钟；coordination events 始终标为 `Not Product facts`。

## 5. 响应式、可访问性和控制台

| 检查 | 桌面 | 移动 |
|---|---:|---:|
| CSS viewport | `1440×900` | `391×844` |
| `scrollWidth / clientWidth` | `1440 / 1440` | `391 / 391` |
| 可见启用控件至少一维 `<44px` | `0` | `0` |
| 页面 console warn/error | `0` | `0`（同一无错误构建） |

移动 detail 仍为 `391/391`；feedback dialog rect 为 `x=10, y=10, width=370.67, height=824`，完整处于 391×844 viewport；dialog 内小于 44px 的启用控件为 `0`。

焦点与层级：

1. Request changes 打开后初始焦点进入 textbox；Escape 关闭 dialog 并把焦点还给 Request changes。
2. Record Back 把焦点还给 Open record；移动端 `Agent Feed` Back 恢复列表和对象 focus。
3. modal 有 `aria-modal`、label/description、focus trap 与 backdrop；`prefers-reduced-motion` 取消非必要 transition/animation。
4. 最终发现 toast 会遮住右下 action footer；已上移到 footer 之上，随后 Reassign / Stop delegation 浏览器实点通过。

## 6. 修复记录与残余问题

修复的 P0/P1/P2：

- P1：假 Decision revision、Run 恢复不可见、通用 Undo、391px 横溢、toast 遮挡委派动作。
- P2：Assistance receipt、candidate 只读终态、新 candidate identity、provider query Evidence、Agent 委派、薄 record、硬编码 Insights、30/32px 控件、reduced-motion。

最终残余：`P0=0, P1=0, P2=0`。仅保留 P3：fixture 使用内存和定时器，不证明生产持久化或真实 Workflow；这是明确原型边界，组合或生产实现必须换成 Application / Product Store / Workflow 合同。

## 7. 证据索引

- v0.1 实测：`evidence/current-audit/01`～`04`。
- Decision：`evidence/browser-qa/02`～`06`。
- Assistance：`08`～`09`。
- Candidate：`10`～`11`。
- Reconciliation：`12`～`14`。
- Delegation：`15`～`19`。
- 391×844：`21-mobile-feed-391x844.png`、`22-mobile-detail-391x844.png`、`24-mobile-feedback-391x844.png`。
- 同屏视觉：`compare-v0.1-v0.2.jpg`。
