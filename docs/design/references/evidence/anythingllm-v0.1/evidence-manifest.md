# AnythingLLM / Open Computer 工作台视觉证据清单 v0.1

> captured: 2026-08-12
> purpose: Agent 工作台基础形态打样
> target source commit: `4af22f8b5c9ca3f90064b56c86c119e687602b48`
> evidence policy: 真实官方产品演示帧 + 固定提交的本地源码渲染；不把营销首页、阻塞页或未连接空状态当作运行证据

## 1. 一手来源

1. AnythingLLM 官方仓库：<https://github.com/Mintplex-Labs/anything-llm>
2. AnythingLLM 官方 README 当前引用的 v1.11.2 产品演示：<https://github.com/Mintplex-Labs/anything-llm/releases/download/v1.11.2/AnythingLLM720p.gif>
3. Open Computer 官方 README：<https://github.com/Mintplex-Labs/anything-llm/tree/master/open-computer>
4. Open Computer 官方 deep-research 演示：<https://github.com/user-attachments/assets/79334c87-c5ae-4c2c-8384-d7ef922e4184>
5. 本地固定源码：`/Users/xulater/Code/opc-os/anything-llm`，提交见文首。

AnythingLLM 官方文档页在本轮浏览器捕获时被 Cloudflare 验证页阻塞，因此没有把阻塞页保存为产品证据。文档中的 Agent Survey / AI Agents 能力只能作为后续待复核项，不能由本组截图替代证明。

## 2. 接受的截图

| 编号 | 文件 | 来源与状态 | 能证明什么 | 不能证明什么 |
|---|---|---|---|---|
| 00 | `screenshots/00-anythingllm-open-computer-evidence-grid.png` | 下列 02～07 的同尺度 3×2 总览 | 一眼比较 Conversation 型与 Computer Workbench 型的区域差异 | 不替代单张原图检查 |
| 01 | `screenshots/01-open-computer-source-default-1440x900.png` | 固定提交的 `open-computer/services/public/index.html` 本地渲染；WebSocket 未连接 | 顶栏、主桌面、右侧四页签、底部输入区的源码布局 | 不能证明真实 VM、Agent、Plan 或 Deliverable 正常运行 |
| 02 | `screenshots/02-anythingllm-start-official-1240x720.png` | AnythingLLM 官方 v1.11.2 演示，约 0.3 秒 | Workspace / Thread 左导航、中心对话起点、快捷动作 | 不是 2026 当前运行实例；只说明该官方演示版本的界面 |
| 03 | `screenshots/03-anythingllm-file-context-official-1240x720.png` | 同一官方演示，约 4 秒；演示视频主动放大输入区 | 文件以显式 chip 进入输入上下文，仍在同一对话入口内提交 | 不能证明权限、长期上下文或大文件处理 |
| 04 | `screenshots/04-anythingllm-agent-progress-official-1240x720.png` | 同一官方演示，约 12.5 秒 | Agent 查询以折叠状态条插入消息流，显示结果数、阶段文本与 token 量 | 不能证明暂停、恢复、失败和子任务所有权 |
| 05 | `screenshots/05-anythingllm-result-sources-official-1240x720.png` | 同一官方演示，约 20 秒 | 结果仍在主消息流；Sources 从右侧抽屉展开，输入框保持连续可用 | 不能证明来源选择、修订或写回产品对象 |
| 06 | `screenshots/06-open-computer-active-run-official-1280x720.png` | Open Computer 官方 deep-research 演示，约 0.5 秒 | 主对象是完整桌面；右侧 Chat/ Subagents/ Logs/ VM Logs；任务卡提供运行状态和 Abort | 当前帧不能证明 Plan 修改与批准步骤 |
| 07 | `screenshots/07-open-computer-deliverable-official-1280x720.png` | 同一官方演示，约 16 秒 | 桌面浏览器、右侧运行历史和 Deliverables 同屏；产物有 Download / Remove | 不能证明产物版本、评论、接受/拒绝或正式写回 |

## 3. 本轮视觉检查结论边界

本组画面足以分析：

1. 左侧 Workspace/Thread 导航与 Conversation 中心布局；
2. 文件上下文怎样进入输入区；
3. Agent 状态怎样嵌入消息流；
4. Evidence/Sources 怎样以右侧抽屉出现；
5. Desktop、Subagent、Logs 和 Deliverable 怎样在一个 Computer Workbench 中共存；
6. 运行中最小人工控制 `Abort run` 的位置。

本组画面不足以确认：

1. AnythingLLM Agent Survey 的澄清问卷和工具权限审批；
2. Open Computer Plan Review 的修改、批准、拒绝完整路径；
3. 等待、失败、恢复、重启和结果未知；
4. 多人权限、Participant、Visibility 和正式写回范围。

以上缺口只能继续由当前官方画面、真实运行或固定源码路径补证，Pi 不得根据截图自行补全。
