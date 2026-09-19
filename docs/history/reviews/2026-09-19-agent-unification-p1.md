# 公共 Agent 装配 P1：合同、原生接缝与阶段自检

日期：2026-09-19。状态：P1 工程交付完成，待用户验收；P2–P5 尚未开始。关联[开发计划](../../development/agent-unification-plan.md)。本记录不代表新功能已经发布，不替代各模块规范。

## 1. 本阶段交付范围

只修改架构/模块合同、导航和原生接缝测试；未修改 `src/` 产品实现、Frontend 实现或 Pi/Nano 子模块源码，未迁移用户数据、调用付费模型、发送外部消息、提交、推送或部署。工作区原有未提交功能修改保留。

| P1 计划项 | 交付证据 | 结论 |
|---|---|---|
| 分层调用链和事实拥有者 | [模块合同 P1](../../architecture/chat-module-contracts.md#p1统一请求执行反馈与入口适配2026-09-19待实施) | 入口→生命周期→公共装配→Pi→反馈/投递；不增加第二运行时 |
| 装配字段、区域和版本 | [Context §15.1–15.2](../../architecture/chat-context-resource-model.md#15-公共-agent-装配合同p12026-09-19) | 定义、SessionRef、自身空间、协作上下文、Invocation、快照分别拥有 |
| 原生接缝 | [测试](../../../test/agents/pi-assembly-seams.test.mjs) | 同 ID/文件重新装配和真实工具验证，见第 2 节 |
| 时区、跨午夜、总结与无消息策略 | [Long Agent §4、§6](../../modules/long-agents/chat-long-agent-architecture.md#4-project-first-与会话选择) | 接受日/IANA 时区/唯一索引、旧日收尾、幂等交接、重试与降级已定义 |
| Web、通道、null 上下文 | [Long Agent §4.3](../../modules/long-agents/chat-long-agent-architecture.md#43-各入口的上下文与受众) | 入口绑定独立，后台不猜另一窗口焦点 |
| 来源、重复、权限和回复目的地 | [模块合同 P1](../../architecture/chat-module-contracts.md#p1统一请求执行反馈与入口适配2026-09-19待实施) | 稳定 ID、冲突失败、私有受众和 Delivery 分离 |
| 持久化/压缩和旧数据兼容 | [Session §10](../../modules/sessions/chat-session-architecture.md#10-friend-每日-session-与本轮项目p1待实施) | 原生消息不改写、历史标记可压缩、迁移冲突不猜测 |
| 旧约束冲突收敛 | AGENTS、能力模型、架构、Session、场景、路线图、工程基线及使用说明 | 按项目拆 Friend Session 和独立整理 Session 不再作为本轮输入 |
| 后续验证分配 | 本记录 §3、计划 P2–P5 | 每个 S 场景有合同与运行验证阶段，没有把计划中的测试写成通过 |

## 2. 原生实验及结论边界

测试模拟的只有 Provider HTTP 响应；实际使用受管 Pi SDK、ResourceLoader、AgentSession、SessionManager、原生 write、真实临时文件和 compaction。不会调用真实模型。测试已由 Backend glob 自动发现，不是一次性丢弃脚本。

| 实验 | 实际断言 | 没有声称的能力 |
|---|---|---|
| 同一 Session 从 A 重装配到 B | 文件/ID/header cwd 保留；模型系统区仅含当前项目规则；原生 write 分别写入 A/B；原消息和工具结果留在同一 Session；Pi 事件可订阅 | Chat 公共工厂当前已支持、文件工具已有沙箱 |
| CustomEntry 与 transformContext | CustomEntry 不出现在模型请求；临时投影进入模型但不新增/修改原生用户消息 | 单靠元数据能让模型记住项目、投影会自动用于压缩 |
| 原生压缩与重开 | hidden custom_message 项目标记实际进入压缩请求；原生 compaction 写入后重开继续，B 的新规则不被 A 规则覆盖 | 模型语义摘要永远完美、产品自动换日已完成 |
| 磁盘规则更新与缺失 | 装配后修改文件不改变已加载规则；新装配读取新版本；新项目无规则时不残留旧规则 | 所有 Skill/代码包均已冻结 |
| 内部维护轮次 | 同 Session 用原生 custom_message 触发模型，原生 assistant 保存；无新增伪 user、无启用业务工具 | 每日 Worker、重试与原子总结写入已实现 |

同跑已有 context-files 测试，确认只读 Personal 与精确项目根、拒绝越界符号链接。

原生源码依据：

- `pi/packages/coding-agent/src/core/sdk.ts`：显式 cwd 优先于 SessionManager.getCwd；公开 resourceLoader、sessionManager、transformContext 接缝。
- `pi/packages/coding-agent/src/core/system-prompt.ts`：基础/replace、append 区域和 contextFiles 的实际拼装。
- `pi/packages/coding-agent/src/core/agent-session.ts`：原生事件、sendCustomMessage、compaction 和恢复。
- `pi/packages/coding-agent/src/core/session-manager.ts`：CustomEntry 与 CustomMessage 分离，原生 JSONL/压缩记录。
- `src/chat-session.ts`：已有上下文过滤器仅排除特定旧 handoff；P2 新历史标记不得误用这些旧类型名。

结论：本轮核心接缝无需修改 Pi 源码。产品改造应进入现有 Chat 公共入口；P2 仍须通过该入口做同等业务验证，不能在生产另建一个直接调用 SDK 的工厂。

## 3. S01–S12 合同演练与后续证据

| 场景 | 按 P1 合同推导的 Session / 上下文 / 输出 | 当前证据及下一验证 |
|---|---|---|
| S01 A→B | 同日同 ID，快照 A→B，cwd/默认项目 Memory 目标随轮次；身份固定 | 原生 A/B 已证；P2 验证 Chat 装配和 Memory |
| S02 无项目 | 同日 ID，collaboration=null，cwd=自身空间；Project Memory 无隐式目标 | 合同明确；P2 无项目业务测试 |
| S03 失效/无规则 | 无规则是空来源；目标失效/越界失败，不用 Home 兜底 | 缺失/符号链接已有实测；P2 HTTP 和权限拒绝 |
| S04 运行中切换 | 已接受 A 保持快照，新消息 B 单独接受；取消对象按执行 ID | 规则磁盘冻结已证；P2/P4 页面切换与权限撤回 |
| S05 双入口并发 | Backend 解析同一 daily key，接受序号串行写历史；各自目标和回复地址不串 | 合同明确；P3 真接受服务并发/Nano 鉴权测试 |
| S06 跨日/总结失败 | 接受日唯一；旧日工作收尾；新日初始化恢复交接，缺失显式标记 | 内部维护原生可行性已证；P3 时钟/故障/重启 |
| S07 刷新/切页 | 只断观察，快照＋游标恢复，不再提交 | 合同明确；P4 实际浏览器/流断开 |
| S08 异常/取消 | Runtime 终态优先；连接状态独立；结果未知的写入不盲重试 | 合同明确；P3/P4 故障注入与取消 |
| S09 压缩 | 持久历史项目标记进入原生压缩，规则由当前装配提供 | 原生真实 compaction 已证；P3 自动阈值/跨日 |
| S10 普通/Workflow/TUI | 普通所属项目保持；同一公共装配；子 Workflow 显式关联 | Backend 现有回归；P2/P4 开发/生产/TUI |
| S11 重送/投递 | 同事件同 Turn；模型结果持久后只重试 Delivery，不重复执行 | 合同明确；P3/P5 生产者/消费者协议与真实渠道 |
| S12 旧链接/设备 | 旧历史可读，继续进入今天；UI 选择与来源分开 | 迁移合同明确；P4/P5 数据副本与浏览器 |

这些是 P1 场景推演，不是 S01–S12 全部产品验收通过。场景清单未删减，真实浏览器/通道/跨日验证仍由原计划阶段承担。

## 4. 自检发现、修复与复验

| 发现 | 修复 | 复验 |
|---|---|---|
| 旧文档要求业务项目另建 Friend Session、日记独立整理 Session | 修订能力、架构、Session、场景和使用说明；旧研究/长期机制明确范围优先级 | 同一日两个项目/整理均落单一 Friend Session；Workflow 子工作不混淆 |
| 只写 CustomEntry 会导致模型/压缩看不到项目归属 | 定义版本化元数据＋隐藏历史事实标记；现行规则每轮系统区装配 | 对模型请求和真实 compaction 请求都做断言 |
| isNewSession 注入无法覆盖先打开再发送或重装配 | 交接初始化单独幂等状态，每轮按 revision 恢复 | P1 完整规定失败/迟到/重开；P3 测试不可省略 |
| 23:30 总结可能遗漏之后的工作，且 Nano 通用调度不完整 | 23:30 只是草稿，日界/恢复 Worker 按截止范围最终整理 | 确定后台触发、无数据不调用、失败重试、迟到结果处理 |
| “工具 cwd 正确”等同于“已经隔离”会误导 | 明确绝对路径和 bash 不受 cwd 沙箱限制，受控文件与可信宿主能力分别验收 | 实验只承诺相对路径；P2 需独立越界/授权门禁 |
| 为 UI 一致性永久隐藏操作会缩减功能 | 明确取消、后续消息及同目标引导语义、来源限制和队列失败分支 | P4 退出条件不能靠隐藏控件满足 |
| 项目参与者可能看到 Friend 混合整日历史 | 私有每日受众不继承项目成员权限，只提供授权活动引用 | P2/P5 读投影权限测试 |
| 旧模型或项目设置可能改写 Friend 身份能力 | Friend 模型走自身定义/Personal，普通 Workflow 保留原链 | P2 模型/检查一致性验证 |

最终目标核对：计划的身份/空间、每日唯一、每轮上下文、工具目标、连续性、跨入口、公共交互、兼容恢复 8 项均有对应合同与验证阶段；没有用额外 Friend 会话、前端事实副本或新模型 Runtime 换取局部通过。

## 5. 验证记录与明确限制

- 原生接缝＋规则加载：7 项通过（5 项新增接缝、2 项既有根规则/路径边界）。
- `pnpm test:backend`：310 项通过，0 失败（含 5 项新增原生接缝）；本机运行约 42 秒。
- `pnpm check:architecture`：101 个入口、754 个本地链接通过；父仓库及 Frontend `git diff --check` 通过。
- 全量 verify 曾启动，但发现现有服务使用 `.output` 后，在 tooling 阶段终止，未进入构建；不把该中止当作通过。P1 不改产品源码，采用本阶段原生实验＋Backend 门禁；P2 产品修改须在不覆盖活动服务产物的隔离 checkout 完成全量 verify。
- 不宣称完成生产装配、实时 Web、真实 Telegram、每日 Worker、数据迁移、沙箱或最终业务验收。它们不是 P1 未做完的实验，而是计划 P2–P5 的产品交付。

P1 的策略选择和可实施接缝已明确，没有把核心所有权问题留给实现者猜。用户审核阶段结果后，下一步按 P2 在公共入口落地；不得直接跳到前端补提示文字。
