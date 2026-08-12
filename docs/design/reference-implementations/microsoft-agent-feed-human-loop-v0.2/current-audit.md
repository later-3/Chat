# Microsoft Agent Feed v0.1 真实浏览器复核

复核对象是未改动的原始 freeze `eed0aa0e4b9fec38fcf7e4eb6684a23e9897e8aa`，服务 `http://127.0.0.1:4183/`。截图在 `evidence/current-audit/`。

## 已捕获状态

1. `01-needs-attention.png`：Needs attention 列表与 Decision 选中态。
2. `02-decision-detail.png`：revision 7、hash、scope、Evidence 与薄 related record 入口。
3. `03-request-changes-result.png`：点击 Request changes 后直接进入 `Agent revising`，没有 composer，note 为写死文案。
4. `04-mobile-needs-attention.png`：391×844 路径的横向溢出与过小控件。

## 实测缺口

| 严重度 | 缺口 | 真实结果 | v0.2 处理 |
|---|---|---|---|
| P1 | Decision 修订是假闭环 | Request changes 无输入；revision 仍为 7；没有新 hash、Evidence、diff 或逐项响应 | 结构化 feedback composer + revision 8 完整回包 |
| P1 | Run 恢复不可见 | Approve / Complete 后看不到等待者、resume gate、执行步骤或终态 | fact-before-resume + typed Run timeline + authoritative record |
| P1 | 通用 Undo 可回退正式事实 | Decision、accepted Update、reconciliation 共用 Undo | 正式事实无 Undo；修订、新 candidate、manual disposition 各走独立命令 |
| P1 | 移动布局横溢 | CSS viewport `391×844` 时 `scrollWidth=451`、`clientWidth=391` | 单列移动层级，最终 `391=391` |
| P2 | Assistance 与 candidate 只到浅动作 | 没有材料/资源/人工结果回执；dismissed 仍可编辑 | typed assistance receipt；accepted/dismissed 只读；新发起新 ID |
| P2 | `outcome_unknown` 只有按钮结果 | 没有 command identity 查询 Evidence 与 Product Commit 分段 | `outcome_unknown → reconciling → result found → Product Commit/manual` |
| P2 | Agent 只是筛选维度 | 没有 parent/delegated task、dependency、current owner 或交接 | 可点击委派、返回、消费、改派、停止 |
| P2 | Related record 太薄 | 不能证明 Feed item 与权威对象的 identity 往返 | Product Store owner、事实、Evidence、Run 与焦点返回 |
| P2 | 展示和可访问性回归 | Insights 硬编码；6 个移动核心控件约 30/32px；无限旋转无 reduced-motion | 删除 Insights；44px；无无限动效；reduced-motion 静态化 |

这些结论与仓库既有审计一致；v0.1 freeze 保持未修改。
