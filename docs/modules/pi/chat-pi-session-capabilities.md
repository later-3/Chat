# Pi 会话能力与 Chat 适配基线

## 范围与事实口径

2026-09-27，核对 Chat 工作分支 `codex/unified-session-performance`，Pi 固定源码 `0343d486d8d8c4622384fa18e93c7f1398cbd749`，`pi-coding-agent` 0.85.1。这是开发工作区的核对结果，不代表已提交、部署或上游最新版。[早期 Pi 设计分析](./pi-agent-design.md)使用另一版本，不能代替本表。

用户场景是：Chat 增加 Project、Workflow、Friend、Topic、Memory 后，用户仍能连续交流、保留原始历史、压缩上下文、停止工作并恢复会话；业务编排不得改变 Pi 的基本会话语义。

判定分三层：原生能力存在、Chat 的真实执行链保留、产品入口可用。第三层缺失不能用第一层来宣称完整支持。下表逐项记录，不给没有运行证据的项目标记“已验证”。“保留”指源码调用路径仍成立；具体自动化证据单列。

- **保留**：沿用原生机制，未发现本次适配改变其核心语义。
- **业务适配**：原生机制之上有 Chat 的归属、持久化或权限规则，不能视为完全等同 Pi CLI。
- **本次修复**：本次发现并修正的行为；交付仍以验证结果为准。
- **缺口**：全部或部分产品路径缺失，不能算作可用。
- **端形差异**：终端专用呈现需要 Web 对应体验，不逐像素搬运。

共 49 项：13 项保留、11 项业务适配、8 项本次修复、16 项完整或局部缺口、1 项端形差异。缺口数是能力项计数，不是相互独立的缺陷数，不表示必须照搬 CLI 按钮。

原生测试的分类、失败/并发场景与 Chat 回归证据见 [Pi 测试场景对照](./chat-pi-test-coverage.md)，完整文件清单见 [468 个测试文件索引](./pi-test-file-inventory.md)。测试存在、原生测试通过和 Chat 产品可用是三个不同判断；测试对照不改变本表尚未接通的能力状态。

## 原生实现地图

| 事实源 | 负责的机制 |
|---|---|
| `pi/packages/agent/src/agent.ts`、`agent-loop.ts` | 模型流、工具循环、消息队列、取消、上下文转换 |
| `pi/packages/coding-agent/src/core/agent-session.ts` | prompt/steer/followUp、重试、压缩、分支导航、模型/思考等级、扩展、统计、导出 |
| `pi/packages/coding-agent/src/core/session-manager.ts` | JSONL、Entry 树、当前 leaf、原生上下文构造、分叉、恢复 |
| `pi/packages/coding-agent/src/core/compaction/` | 压缩边界、摘要、分支摘要、令牌估算 |
| `pi/packages/coding-agent/src/core/sdk.ts` | 创建 AgentSession、恢复模型/思考等级和上下文、装配原生对象 |
| `pi/packages/coding-agent/src/core/settings-manager.ts`、`resource-loader.ts`、`extensions/` | 运行设置、资源解析、扩展生命周期与交互合同 |
| `pi/packages/coding-agent/src/core/agent-session-runtime.ts` | Session 生命周期操作；不得与 Workflow 运行时混淆 |
| `pi/packages/coding-agent/README.md`、`docs/sdk.md` | CLI 使用入口和 SDK 公共合同；CLI 命令不等于 SDK 自动提供 HTTP API |

Chat 对应入口：`src/agents/pi-agent-session.ts:createChatPiAgentSession`；Workflow 的薄包装 `src/workflows/agent-definition.ts`；Session 恢复 `src/chat-session.ts`；只读投影 `src/session-read-model.ts`；实时事件 `src/agents/session-events.ts`；浏览器 `frontend/hooks/useAgentSession.ts`。每个 Step 重建 AgentSession 对象，但使用同一个持久 SessionManager/Session ID；对象释放不等于会话清空。

## 逐项对照

| # | Pi 原生能力 / 主要符号 | Chat 现状与差异 | 判定 |
|---|---|---|---|
| 01 | 原生 user/assistant/toolResult 与工具调用配对 | 公共装配和读模型沿用；Workflow 元数据用 CustomEntry | 保留 |
| 02 | JSONL Entry 的 id/parentId 树 | 原文件保存树和分支；前端轻量树只是投影 | 保留 |
| 03 | `buildSessionContext` / `buildContextEntries` 选择当前分支 | 普通运行与历史投影调用原生选择逻辑，不拼接所有分支 | 保留 |
| 04 | 阈值自动压缩 `_checkCompaction` | Workflow/Long Agent 使用原生 AgentSession 设置与触发逻辑 | 保留 |
| 05 | 上下文溢出后的压缩与重试 | 由 Pi 判断溢出、生成摘要并继续；Chat 不重写该算法 | 保留 |
| 06 | 压缩不删除原始历史，重开恢复摘要和保留区间 | JSONL 留存全部 Entry；页面摘要由公共读模型投影 | 保留 |
| 07 | 压缩后下一次请求不得恢复已归档长文本 | Session Memory Writer 原来重投影原始分支；现在先限定本轮，再取原生有效上下文，保留完整父链后过滤隐藏控制消息 | 本次修复 |
| 08 | `compact(customInstructions)`、`abortCompaction` | 普通/私有 Friend 空闲会话通过 maintenance API、按钮和 `/compact` 调用原生方法；持久回执、取消和刷新恢复；群由专属合同限制 | 本次修复 |
| 09 | `compaction_start/end` 的原因、结果、取消、失败 | 原适配丢弃结果且 UI 不显示结束细节；现共用事件投影与运行状态显示原生计数、估计、失败/取消 | 本次修复 |
| 10 | `getContextUsage` 当前上下文用量 | 原生只读 helper 投影到 Web；压缩后新响应前保留未知值，读取不装配 Agent | 本次修复 |
| 11 | `getSessionStats` 全会话统计 | Pi 原生全文件聚合包含旧分支、摘要、工具 usage；顶部统计和 `/session` 已接 | 本次修复 |
| 12 | 模型请求自动重试、退避、取消 | Pi 原生执行；Chat Run 状态显示次数与等待，并通过公共取消控制停止 | 保留 |
| 13 | `summarization_retry_*` 事件 | 公共事件、浏览器解析与 RunStatus 已接次数/退避/重试恢复，结束清除倒计时 | 本次修复 |
| 14 | abort、流/工具结束、Session 持久记录 | Chat 取消走 Run/Friend 生命周期再调用实际 Pi session.abort；保留业务状态与回执 | 业务适配 |
| 15 | `steer` 在当前轮可接受边界追加引导 | Friend/Topic 有受理与实际 Pi 输入；普通 Workflow 前端拒绝运行中引导 | 缺口 |
| 16 | `followUp` 等当前工作完成后继续 | Friend/Topic 使用耐久下一轮队列；普通 Workflow 入口未接。业务耐久队列不是 Pi 的内存队列 | 缺口 |
| 17 | 查看/清空/取回待处理输入、队列模式 | Web queuedMessages 固定空，handleRecallQueue 空；不能因此表示服务端没有待办输入 | 缺口 |
| 18 | `resumePendingTurn` 与中断工具回合 | Chat 使用 Run 恢复/中断事实，不自动重放可能有副作用的工具。普通会话缺少对应显式继续入口 | 缺口 |
| 19 | 跨请求重开同一 Session、恢复历史 | `openChatSession` + 公共工厂；统一 Workflow 不替换 Session ID | 保留 |
| 20 | `setModel` 与模型变化记录 | Agent/Workflow 配置由 Backend 解析再传 Pi；Friend 使用自身/Personal 模型策略，不盲目继承上一业务节点模型 | 业务适配 |
| 21 | Thinking Level、模型能力与原生变化记录 | 设置/Agent 选择经公共装配，Pi 负责实际等级；不是新增第二套推理机制 | 业务适配 |
| 22 | System Prompt 与项目 Context 文件 | Chat 显式解析 Personal/Project/Friend 授权根、冻结规则，再交原生 ResourceLoader；不继承机器上偶然的父目录 | 业务适配 |
| 23 | 查看实际 System Prompt | Agent 检查 API 使用公共装配；聊天 hook 的 systemPrompt/loader 仍为空，需要接实际选定节点的检查结果 | 缺口 |
| 24 | 工具注册、调用、结果、继续模型循环 | Pi 执行；Chat 增加受权文件 Tool 和业务 Tool，同一 toolCallId 链路 | 保留 |
| 25 | 工具进度/错误与流式文本、思考内容 | 统一原生事件投影，Web 共用渲染，省略流中的重复大 partial 不改变落盘消息 | 保留 |
| 26 | 原生工具输出截断与大结果处理 | 仍调用 Pi Tool；Web 延迟加载图片/思考只是显示优化，不裁剪模型事实 | 保留 |
| 27 | Skill/Prompt/Extension/Plugin 资源加载 | Backend 范围与冻结策略之上使用 DefaultResourceLoader；不由前端维护第二份运行时资源 | 业务适配 |
| 28 | `/skill:name`、Prompt Template 展开 | 通过 session.prompt 的执行路径仍由 Pi 展开；Web loadSlashCommands 空，发现/补全缺失，所有业务入口未逐项验收 | 缺口 |
| 29 | Extension 工具与输入/上下文/压缩等运行钩子 | 已加载扩展进入原生 runner；不能由此推断所有扩展生命周期已生效 | 业务适配 |
| 30 | `bindExtensions` 的 session_start / resources_discover | 公共工厂未绑定；启动/资源发现生命周期缺失。补齐必须同时覆盖冻结与授权，不能只补一次无条件调用 | 缺口 |
| 31 | Extension select/confirm/input/editor、状态与 widget | Web hook UI 响应/状态为占位；headless 模式可用不代表需要交互的扩展在 Web 可用 | 缺口 |
| 32 | Extension 注册命令、快捷键、reload | Pi prompt 能解析已注册命令，但 Web 无命令目录；reload 内置命令拒绝。终端快捷键需要端侧适配 | 缺口 |
| 33 | CLI 内置 `/compact /reload /name /session /copy` | `/compact [说明]`、`/session` 已接；其余 3 个命令仍拒绝，改名/复制的其他入口不等于命令可用 | 缺口 |
| 34 | 读取旧 leaf 的历史 | Chat `/context?leafId` 只读；本地 activeLeaf 表示浏览位置，不是原生当前写入 leaf | 业务适配 |
| 35 | 原生分支后原地继续 | 浏览只读并暂停发送；显式继续以 expectedLeafId 检查冲突，原生 branch/resetLeaf + 元数据保存位置；用户节点回填草稿；完整助手节点定位响应后；群/Topic 不走通用导航 | 本次修复 |
| 36 | 从用户节点 fork 新 Session | 普通会话已有受锁保护、同 Project、幂等分叉；Topic 有领域分叉；每日/后台工作不能通过通用 fork 改属 | 业务适配 |
| 37 | 导航生成 `branch_summary` | 已有摘要可以原生恢复和 Web 展示；Chat 没有完整的生成、取消、导航事务入口 | 缺口 |
| 38 | Entry 标签/书签 `appendLabelChange` | 原生结构与已有标签投影存在；Chat 未接完整管理入口 | 缺口 |
| 39 | clone / JSONL import | Pi SessionRuntime 支持；Chat 没有带 Project/owner/来源校验的产品导入/克隆合同 | 缺口 |
| 40 | HTML 导出 | 现有受权 Session export 使用原生 HTML 导出并适配 Chat 展示 | 保留 |
| 41 | 原生当前分支 JSONL 导出 | Chat 尚无对应用户入口；原始文件仍在 Backend，不等于已经支持下载 | 缺口 |
| 42 | Session 名称 `appendSessionInfo` | 已有改名 API，锁和忙碌检查；保存原生 SessionInfo | 保留 |
| 43 | new / switch / list / remove | Chat 以 Project/owner/每日/工作/Topic 提供产品导航；切换只读，不启动模型 | 业务适配 |
| 44 | 用户 `!` / `!!` 命令，结果进入或排除模型上下文 | Web 明确拒绝 shell 输入。Agent 的 bash Tool 是另一能力，不能当成此项已支持 | 缺口 |
| 45 | 文件引用、图片/附件输入、输入历史 | Web 有自己的输入与 Backend 文件合同；图片还受模型能力和入口能力限制 | 业务适配 |
| 46 | 终端主题、外部编辑器、按键、终端渲染器 | 用 Web 的主题、编辑器、快捷键、无障碍交互对应；不要求直接运行终端 UI | 端形差异 |
| 47 | CLI trust / cwd / provider 登录 | Chat 的 Project 授权、资源策略、设置认证负责产品边界；Pi 仍负责模型认证/请求，不引入并行凭据目录 | 业务适配 |
| 48 | compaction/retry/queue 的 Settings 选项 | 原生 SettingsManager 在运行，但 Chat 设置页没有完整运行策略面板；需区分 Personal、项目、Agent 与本轮覆盖 | 缺口 |
| 49 | 摘要请求的预算/usage 归属 | Pi 共用 stream 边界覆盖普通、分段压缩、分支摘要及重试 gate；拒绝时零新增 HTTP。群讨论/群工作记录成功摘要 usage，并在下一请求前等待持久化 | 本次修复 |

## 压缩与历史的准确合同

Pi 默认自动压缩启用，`reserveTokens=16384`、`keepRecentTokens=20000`；Chat 配置可覆盖，不能将默认值当成每个会话的实测设置。自动压缩和手动压缩都交给 Pi；Workflow 不负责实现摘要算法。

三个不同事实不得混同：

1. **原始历史**：JSONL 所有 Entry，包括已压缩内容和其他分支，仍可追溯。
2. **模型上下文**：当前 leaf 的摘要、保留片段、新消息，加上本轮受权系统区域。不是全部历史，也不是前端当前滚动位置。
3. **Memory/每日交接**：Chat 业务持久化能力，有自己的来源和作用域；不能取代 Pi 会话上下文或删除历史。

Session Memory Writer 先从完整原生父链识别当前 invocation 的首个 user，再按 Pi `buildContextEntries` 选择有效 Entry，最后交集本轮 Entry 与 Chat 允许的上下文 Entry。先删隐藏 handoff 再遍历会断开父链；直接读取原始本轮又会撤销压缩，两种都不允许。无本轮 user 时拒绝记忆写入。

当前轮产生的原生压缩摘要可能包含更早历史的背景，不能宣称“摘要只含本轮”。Writer 只能记录本轮的结论，不得把摘要中旧事实当成本轮新结果；需要原文时通过受权工具按需读取，不能把整段归档历史自动加回每次请求。

原生 `getContextUsage` 在压缩后、下一次有效模型响应前返回 tokens/percent=null，表示未知；`estimatedTokensAfter` 只是估计，不能伪装成计费量。原生 `getSessionStats` 汇总全部分支与已压缩 Entry，并包括摘要及带 usage 的工具结果；不能从页面可见消息统计代替。

原探针发现 SDK gate 仅绑定 Agent.onPayload，而摘要直接调用 streamFunction。现已将 gate 和 Provider payload/response 钩子移到共用 stream 边界，普通请求不重复计数。`test/agents/compaction-recovery.test.mjs` 检查普通/分段/分支摘要/重试的真实 HTTP；`test/long-agents/summary-budget.test.mjs` 检查群根预算与独立工作预算。成功摘要用量按 Pi 结果计入软额度；Provider 未报告或失败摘要未保存的用量不能伪造为精确账单。

## 适配顺序与架构审核

已实施本次 P0：修复 Writer 绕过压缩；补齐原生压缩结束反馈，清除结束后的旧重试倒计时。复用原生方法和现有只读事件投影，无新增 Session 运行时或历史库。

手动操作、只读统计、历史继续已按 [维护合同](../sessions/chat-session-maintenance.md)实施。以下区分本次边界与后续工作，均不代表已部署：

1. **会话操作与观测**：08/10/11/35 和 33 的 compact/session 已实施。23 的实际 System Prompt 与其余命令仍待接。导航采用不生成摘要的原生 SessionManager 分支；Topic 沿用领域分叉，群不可借维护绕过预算/发布。
2. **输入与队列**（15–18/28/32）：复用当前真实 AgentSession 的 steer/followUp 与 Chat 耐久受理记录；不从 Web 启动第二个写入器。展示已受理/待消费/已消费，取回只允许尚未消费的输入。恢复不得自动重放已开始的有副作用工具。命令目录来自本轮有效资源，不另存前端静态扩展列表。
3. **扩展生命周期**（29–32）：在公共装配中定义执行、检查、重连的绑定时机；发现资源后再次做授权/冻结/预算检查。只读检查不得运行有副作用的 session_start。交互请求需要 requestId、目标 Session/Run、回复校验、超时、取消与断线恢复；无 UI 的 IM/headless 模式要准确报告能力。
4. **其余原生操作**（37–41/44/48）：标签、分支摘要、克隆导入、JSONL 导出、用户 shell、运行策略面板仍需接统一 Session 合同；49 的摘要预算已修复。

审核结论：P0 不改变 owner、工作/记忆阶段职责或 Pi 数据结构，适配位置正确。以上后续操作会涉及模型选择、同 Session 写入权、扩展副作用与领域分叉，必须在对应模块形成实现合同和反例验收后实现；不得把本清单中的建议直接写成现状。基础能力缺口继续保持开放，不以“业务差异”关闭。

## 回归证据与验收要求

| 层级 | 门禁 | 证明范围 |
|---|---|---|
| 原生接缝 | `test/agents/pi-assembly-seams.test.mjs` | 原生压缩、重开、项目规则与工具，不等于真实 Workflow Runtime |
| 普通 Workflow | `test/workflows/chat-session-workflows.test.mjs` | 自动压缩后同 Session 继续 |
| Friend 公共装配 | `test/long-agents/daily-lifecycle.test.mjs` | 真实压缩后规则恢复与工具执行 |
| Writer 回归 | `test/workflows/session-memory-writer-runtime.test.mjs` | 摘要保留、归档文本不回填、分支隔离、隐藏控制 Entry 不断父链 |
| 读模型 | `test/session-read-model.test.mjs` | 原生摘要映射、Entry ID 对应、历史不被改写 |
| 事件 → Web | `test/workflows/chat-run-events.test.mjs`、`frontend/lib/run-activity.test.mjs` | 计数、失败/取消、非法响应拒绝与重试状态清理 |
| 实际浏览器 | `scripts/session-memory-switch-browser.test.mjs` | 原生自动压缩完成后显示估计与原文保留说明，结果出现后输入区在 5 种视口仍完整可见 |
| 实际 Runtime | `scripts/unified-session-runtime.test.mjs` | HTTP Friend → Workflow SDK/Step → Pi → 本地受控模型 → 自动压缩 → 同 Session Writer 实际请求不回填原文 |

代码更改运行 `pnpm verify` 和父仓库/Frontend `git diff --check`；不得用构造一个 compaction Entry 的单元测试替代真实压缩。可复用故障记录见 [Writer 压缩回归](../../development/experiences/writer-compaction-boundary.md)。后续 Pi gitlink 更新或公共装配、transformContext、事件过滤、Workflow 生命周期变化时，重审本表受影响项并增加用户场景验收。

原 Writer 修复阶段的 982 项通过记录见 [早期验收](../../history/reviews/2026-09-27-pi-session-capabilities.md)；摘要预算、恢复与维护入口的后续结果见 [维护验收](../../history/reviews/2026-09-27-pi-session-controls.md)。测试通过不关闭表中未接通的能力。
