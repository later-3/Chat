# Chat 参考组合原型

这不是 6 个产品皮肤的拼盘，而是用同一批稳定对象与同一套 Chat 视觉语言，验证 3 个互斥注意力模式。

## 为什么是 3 个模式

场景按“用户此刻在回答什么问题”收口后，形成 3 个不能继续合并的工作模式：

1. **Project Room**：我的长期 Project 现在处于哪个 Stage / Milestone / Iteration，哪些 Work / Scope / Action 正在推进，负责人怎样基于 Evidence 写 Update。
2. **Today Rhythm**：今天有哪些不可压缩的时间约束，我个人要完成、判断或看护什么；Today 只投影 Action，不拥有长期 Project。
3. **Evidence Workbench**：多 Agent 产生的 Decision、Candidate、Run 与 Evidence 中，哪里需要人；`outcome_unknown` 只允许查询对账。

合并 Project Room 与 Today 会混淆长期归属和个人注意力；合并 Today 与 Workbench 会把 Decision / Run 伪装成勾选任务；合并 Project Room 与 Workbench 会让监督 Feed 取代 Project 叙事。因此 3 套是当前场景轴下最小且有区分度的数量。

## 参考语法与拒绝项

| 模式 | 采用 / 适配 | 明确拒绝 |
|---|---|---|
| Project Room | Basecamp 的房间连续性；Linear 的 List → detail → return 与负责人 Update | 六宫格工具首页、活动日志冒充 Update、密集灰阶皮肤 |
| Today Rhythm | Things 的 Project × Today 正交；HEY 的连续日节奏与真实时间约束 | 所有对象都变成 checkbox、Work 自动变 Event、任意彩色装饰 |
| Evidence Workbench | Microsoft Agent Feed 的“需介入”分流；Heptabase 的稳定对象身份、材料并排与显式上下文 | 社交 Feed、Completed 大桶、无限画布默认首页、画布位置成为权威关系 |

三套共用 Chat 黑白骨架、Phosphor 图标、语义 Token、44px 控件与小面积暖色 Agent 标识。

## 可体验路由

本地服务器启动后：

- Project Room：`/?mode=project&view=overview`
- Today Rhythm：`/?mode=today&view=overview`
- Evidence Workbench：`/?mode=workbench&view=overview`

桌面右上角可切换 `391 × 844` 移动预览；真实窄屏会自动进入同一移动布局。数字键 `1 / 2 / 3` 切换模式，`Esc` 关闭详情。

## 合同边界

- `src/model.js` 保存稳定 mock IDs 与纯状态转换。
- 完成、移晚与撤销只允许作用于 `reversible Action`。
- Decision 修改会增加 revision 并重算 mock hash；接受绑定当前 revision。
- Candidate 可编辑或接受，但接受前不成为正式事实。
- `outcome_unknown` 不提供 Undo 或普通重试；只支持查询回执后提交正式结果。
- Decision、Run、Candidate 显式保存 visibility、consent 与 participant 边界。

## 验证命令

```bash
npm test
npm run build
npm run test:sites
```

视觉与交互证据见 [`design-qa.md`](./design-qa.md)。
