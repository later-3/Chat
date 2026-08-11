# Agent Workbench 基础形态与差异形态研究计划 v0.1

> status: candidate
> date: 2026-08-12
> scope: 只研究工作台设计思路、真实画面与开源实现证据
> forbidden: 原型、生产 UI、部署、push、PR、frozen 登记

## 1. 研究问题

不再问“还有哪些 Agent 产品”，只回答两个问题：

1. 大多数 Agent 工作台共同使用的基础设计是什么？
2. 哪些工作台真的改变了主对象、工作节奏或人的介入方式，而不只是换了颜色和栏目位置？

## 2. 暂定基础形态

AnythingLLM / Open Computer 作为当前基线：

```text
Navigation / Projects
  + Conversation / Goal input
  + Primary work surface（Artifact / Browser / Files / Desktop / Canvas）
  + Plan / Run / Task / Logs inspector
  + Human controls（reply / approve / revise / stop / handoff）
```

大多数产品会调整这些区域的左右位置、默认宽度、覆盖关系和打开方式。布局本身表达上下文所有权、主焦点、连续性和介入成本，因此也必须进入证据。后续检查下面 5 种差异：

1. **布局与焦点不同**：什么在左 / 中 / 右，哪些表面能并排，哪些必须跳转或弹出？
2. **主对象不同**：Conversation、Work Item、Flow Run 或 Agent Team 谁拥有页面中心？
3. **时间模型不同**：即时回复、长任务、事件驱动 Run 或持续团队协作？
4. **人工介入不同**：回复、审批、改 Plan、接管桌面、评论 Diff，还是重跑节点？
5. **交付与写回不同**：文件下载、Artifact 编辑、任务状态、流程输出或代码 Diff？

这不是 Agent 全景图；每个项目只回答这 5 个问题。

## 3. 限定候选池

### 3.1 基础型

| 参考 | 开源证据 | 研究责任 |
|---|---|---|
| AnythingLLM / Open Computer | 官方仓库，AnythingLLM MIT；Open Computer AGPL-3.0 | 固定“Conversation + Workbench”基线，不重复深挖 |

### 3.2 进入一屏差异筛查的 4 个项目

| 原闭源关注点 | 对应开源项目 | 为什么可能不同 | 当前证据门 |
|---|---|---|---|
| Copilot Cowork / Claude Cowork / Manus | [Eigent](https://github.com/eigent-ai/eigent)（Apache-2.0） | 页面中心可能是可组装的 Agent Workforce，而不只是一次 Chat Run | 官方源码、桌面 UI、Browser / Terminal、多 Agent 画面 |
| monday.com / ClickUp Brain | [Plane](https://github.com/makeplane/plane)（AGPL-3.0） | 页面中心是 Work Item / Cycle / Project；Agent 进入已有工作事实，而不是拥有工作台 | 官方源码、Cloud / Self-host、Project / Wiki / AI 画面 |
| Kestra | [Kestra](https://github.com/kestra-io/kestra)（Apache-2.0） | 页面中心是声明式 Flow 与 Execution；等待、重试、失败和输出由节点表达 | 官方源码、UI 文档、Topology / Execution / Logs 画面 |
| Orca | [stablyai/orca](https://github.com/stablyai/orca)（MIT） | 页面中心是并行 Agent fleet + worktree + Diff；人主要做分配、监控和代码审阅 | 官方源码、桌面 / 移动、Diff 评论、Agent 状态画面 |

### 3.3 只做排除判断，不进入源码深审

| 用户原范围 | 开源对应 | 暂不深挖理由 |
|---|---|---|
| Slack / Teams | Mattermost + Mattermost Agents | Channel / feed 形态已被 Microsoft Agent Feed 与 Chat 对话覆盖；只有 participant / permission 出现新证据才升级 |
| Miro | AFFiNE | Canvas / placement / knowledge 已有 Heptabase；避免重复研究白板外观 |
| Reclaim.ai | Atomic 等开源日程项目 | 当前开源对应物证据偏旧，且 Time / Calendar / Todo 已被 HEY Calendar 与 Things 覆盖 |
| Microsoft Researcher | GPT Researcher | 主要仍是来源 → Research Run → Report，和既有 Researcher / Heptabase 证据重叠 |
| Awesome AI Agents | 目录，不是产品 | 只用于发现项目，不能作为交互参考 |

## 4. 分阶段执行

### Stage A｜Codex 固定外部证据

Codex 只负责 Pi 无法可靠取得的输入：

1. 每个项目捕获能代表主工作方式的真实产品画面；
2. 固定官方 URL、仓库和提交；
3. 把画面与来源放入 Pi 可读的本地证据目录；
4. 没有真实画面或只有营销首页的项目标为 evidence blocked。

这不是研究结论阶段，只是给 Pi 准备可靠输入。

### Stage B｜Pi 视觉、布局与交互比较

Pi 在同一个 Mission 的独立 Stage 中比较：

1. 左 / 中 / 右区域、覆盖层、弹出面与可并排表面；
2. 导航入口、主焦点、信息密度和状态显著性；
3. Conversation、Plan、Run、Artifact、Evidence 的往返路径；
4. 共同骨架、真正不同和证据缺口。

Codex 通过轻量 Trace 持续看护；Pi 正常推进时不因耗时或工具次数停止。

### Stage C｜Pi 单项目源码路径

视觉比较后，Codex 根据差异度选择最能回答问题的项目继续，不要求用户在每个内部 Stage 批准。每个开源项目单独一个 Pi Stage / Attempt，不把多个产品放入同一 Prompt。固定追踪：

```text
自然语言或工作入口
→ 计划 / 任务 / Flow / Agent 分配
→ 运行中人类介入
→ 结果 / Diff / Artifact / Run output
```

每次从固定入口文件开始，但允许 Pi 根据真实依赖继续追踪；不预设工具调用次数。Pi 只提供源码候选证据；Codex 负责截图、事实核对与采用判断。

### Stage D｜差异总结与用户检视

不制作原型，只交付：

1. 一个基础工作台骨架；
2. 两个真正不同的工作台变体；
3. 每个变体的 Take / Adapt / Refuse；
4. 哪些场景应由布局切换解决，哪些必须由产品状态模型解决；
5. 用户一次性检视研究结果；确认最终参考项目后，才另开原型 Session。

## 5. Pi 看护与低成本 Trace

工具调用次数、Token和墙钟时间都是诊断信号，不是正常任务的自动停止目标。Pi需要怎样使用工具就怎样使用；Codex根据可观察进展判断是否继续。

每个 Stage 采用：

1. 只读 discovery；需要改动时在同一 Mission 后续 execute Stage 中进行；
2. 开始时记录预计首次检查时间，但它只决定 Codex 何时查看 Trace，不决定何时杀进程；
3. Trace 只读取 ledger 中的 `state / health / latestEventId / turns / toolCalls / token totals / elapsed / recent tool pattern / termination`，不读取隐藏推理或反复展开完整 Session；
4. 事件、turn、工具、usage或工作树证据持续前进时，判定 Pi 正常工作；
5. 只有重复相同工具模式、长时间无任何可观察进展、明显偏离任务、越权风险或用户要求时，Codex才 steer 或 stop；
6. 每次发现稳定的弯路模式，都形成可复用的 Brief 规则、Trace 检查或 pi-taskd 工具，而不是下一次继续人工解析同一堆日志。

当前 pi-taskd 的 `maxDurationMs` 会在绝对时间到达后无条件 abort，不符合上述看护原则。本轮先在独立分支改进：提供紧凑 `observe` 汇总，并把绝对墙钟从普通完成条件中移出，改为进展信号与人工监督优先。该分支只供用户审核，不自动合入。

## 6. 当前停点

AnythingLLM 继续作为基础型候选。下一步先完成 pi-taskd 看护改进，再由 Codex 准备真实画面，随后让 Pi 按 Stage B → C 连续研究。研究完成后一次性交给用户检视；不制作原型。
