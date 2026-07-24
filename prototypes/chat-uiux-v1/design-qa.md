# Chat UI/UX v1 — Design QA

## 验证结论

**Final result: passed**

本轮交付是可交互 HTML 原型，不接真实 Provider，也不会执行 Tool 副作用。主页、连续对话、Workflow Workbench、发送前审批与移动端布局均已完成浏览器验证。

## 视觉真源与实现快照

- 选定视觉真源：`/Users/xulater/.codex/generated_images/019f840a-3141-7611-b279-102b4f0a0e6c/call_YXVirXmCRV6QwYLeKuDikXQe.png`
- 真源像素：`1487 × 1058`
- 实现主页：`qa-home.png`
- 实现工作流：`qa-workflow-final.png`
- 实现审批：`qa-approval.png`
- 移动端：`qa-mobile-home.png`、`qa-mobile-workflow.png`、`qa-mobile-approval.png`
- 主页并排比较：`qa-home-comparison.png`

桌面实现快照为 `1707 × 960`，移动端快照为 `693 × 1500`。并排比较时，主页实现按视觉真源尺寸归一化，避免把设备像素密度或截图画布差异误判为布局差异。

## 比较范围

### 全视图

1. App Shell 的层级、左侧 Activity Rail、顶栏搜索和当前 Workflow 入口保持一致。
2. 主页继续保留“问候 → 继续推进 → 年度协作日历 → 产物与灵感”的信息顺序。
3. 最新设计方向要求更接近 Material 3 Expressive，因此实现使用更强的欢迎区、异形日期块和更有情绪的卡片节奏；这是经过意图确认的演进，不是误差。
4. 根据用户最新反馈，移除了紫色主色和渐变；当前主色为深绿/青绿，辅以珊瑚橙、暖黄和信息蓝。

### 重点区域

1. **持续对话**：显式上下文以彩色 Chip 呈现；用户可以在发送前选择 Project、规则、文件和经验。
2. **Workflow Workbench**：与聊天区平行；完整系统链路和真实 MAF 路径分层显示，分支原因可见，节点可点击检查公开输入、输出和路径原因。
3. **发送前审批**：所有可发送内容采用普通文本和结构化表单编辑；Provider 预览与可读编辑视图来自同一状态；修改后必须先保存新版本，再允许批准。
4. **移动端**：Activity Rail 变为底部导航；Workbench 和审批变成全屏工作面，不压缩聊天正文。

## 交互验证

1. 点击“运行”进入 Workbench。
2. 点击任一 Workflow 节点会切换节点检查器。
3. 打开审批后修改目标，批准按钮立即失效。
4. 保存修改后版本从 `r4` 更新为 `r5`，批准重新可用。
5. Provider 预览同步展示模型、输入、工具和 `store = false`。
6. 点击“返回对话”后，输入框草稿保持不丢失。
7. 点击“批准并继续”只展示原型完成提示，不调用模型、不执行工具。
8. 浏览器控制台未发现页面运行错误；生产构建和 Sites Worker 的 4 个测试通过。

## 发现与修正记录

| 级别 | 发现 | 修正 | 复验 |
|---|---|---|---|
| P2 | Workbench 的节点类型、节点名和路径说明偏小，可能复现此前“看不清”的问题 | 节点名提高到 `13px`，说明提高到 `10–11px`，检查器正文提高到 `14px` | `qa-workflow-final.png` 通过 |
| P2 | 视觉真源含紫色灵感标识，但用户明确不喜欢紫色 | 全部替换为青绿、珊瑚橙、暖黄与信息蓝 | `qa-home-comparison.png` 通过 |
| P2 | 审批修改后若仍可直接批准，会破坏版本绑定 | 修改即进入 dirty 状态，禁止批准，必须保存新 Revision | 浏览器交互通过 |

未发现 P0 或 P1 问题。

## 边界

1. 这是 UI/UX 决策原型，不是生产功能迁移。
2. 原型数据均为演示数据。
3. 真正接入现有 Chat 时，Product Session、Product Run、MAF Workflow、AG-UI Run 和 ModelCallDraft 仍须遵循后端权威状态与既有审批合同。
