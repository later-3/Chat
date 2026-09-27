# Pi 原生测试场景与 Chat 覆盖对照

## 结论与核对范围

2026-09-27，基于 Pi 固定提交 `0343d486d8d8c4622384fa18e93c7f1398cbd749`（0.85.1）和 Chat `codex/unified-session-performance` 工作区。结论是：**Chat 保留了主要的原生会话执行与持久化机制，但没有完整接通 Pi 的产品能力，也没有覆盖原生测试中的全部失败、并发和恢复场景。** 不能以“依赖 Pi”或“Chat verify 通过”代替逐项验证。

本次完成整个 Pi 仓库的测试文件和静态声明索引，再按 Chat 实际调用链深入检查会话相关测试的安排、动作与断言。全量索引不等于逐个执行、逐个语义审查全部用例；下表明确给出深查的场景、已有 Chat 证据及尚未验证部分。

- [测试文件索引](./pi-test-file-inventory.md)：468 个测试源码文件，排除 fixture、helper、配置；包括 466 个 packages 文件和 2 个根 scripts 文件。
- [能力基线](./chat-pi-session-capabilities.md)：49 项能力的产品状态，本表不另建一套能力状态。原审计发现 22 项缺口；后续维护实现关闭其中 6 项，当前余 16 项完整或局部缺口，见能力表。原始审计记录保留当时结论。
- [本次执行记录](../../history/reviews/2026-09-27-pi-test-coverage.md)：只对选定的本地假模型测试和 Chat 回归记录实际结果；不把未运行、条件跳过的原生用例算作通过。

判定分开记录：**能力**回答执行链有没有、用户能不能使用；**覆盖**回答哪个测试实际穿过了 Chat 的装配、Workflow、接口或浏览器。原生单测通过只证明原生边界；Chat 的造数据读模型测试只证明投影；实际 Runtime 和浏览器分别需要自己的证据。未找到对应回归表示证据不足，不直接等于运行时已损坏。

## 全量分类：哪些代码属于我们的执行链

| Pi 区域 | 测试文件数 | 原生测试主题 | 对 Chat 的含义 |
|---|---:|---|---|
| `coding-agent` | 240 | AgentSession、JSONL、压缩、分支、资源、工具、模型配置，以及 CLI/RPC/终端组件 | 核心 Session/SDK 是直接依赖；CLI/RPC/交互模式的入口不会自动变成 Chat API |
| `agent` | 23 | Agent 循环、工具与队列；其中 19 个文件在 `test/harness/` | Chat 使用原生 Agent 循环；新的 Harness/Session 抽象不是当前 Chat Session 后端 |
| `ai` | 138 | 供应商请求与流解析、thinking、toolCall ID、图片、用量、重试、OAuth、模型目录 | 底层适配沿用；不能声称 Chat 的配置、凭据和入口已验证所有供应商组合 |
| `tui` | 32 | 编辑器、按键、Markdown、ANSI/CJK 宽度、弹层、终端图片、选择器 | Chat TUI 复用部分显示组件；Web 必须有自己的布局、键盘、主题和语言验收 |
| `client` | 6 | 请求、连接、状态、Session、释放、Unix socket | Pi 独立客户端协议测试，不证明 Chat HTTP 客户端 |
| `server` | 7 | 监听器、连接、协议、Session、conformance | Pi 独立服务端，不是 Chat Backend |
| `protocol` | 3 | 消息合同、framing、CBOR | 独立线协议；不能用来替代 Chat JSON/SSE 的校验与恢复测试 |
| `session-backends/sqlite-node` | 11 | 查询、分支缓存、迁移、写入租约、conformance | 当前原生 Chat Session 仍为 coding-agent JSONL；Chat 自己使用 SQLite 不代表采用此 Session 后端 |
| `telemetry` | 2 | 遥测事件与约定 | 底层设施，不等于 Chat 已有用户可见的统计入口 |
| `evals` | 4 | 评测 Harness、结果、工件、汇总 | 开发设施，不是最终用户的会话功能 |
| 根 `scripts` | 2 | 发布说明与模型目录检查脚本 | 上游维护设施，不是 Chat 产品缺口 |
| **合计** | **468** | **11 个源码区域** | **不能把文件数作为功能数或覆盖率分母** |

分类依据是源码归属与实际装配，不按包是否出现在依赖树就判断“已接入”。Chat 的运行事实仍是 `createChatPiAgentSession()` → `createAgentSession()` → 原生 AgentSession/SessionManager；不为了复用另一套测试而迁移到 Pi 实验性 server/Harness/SQLite。

## 12 类机制、32 组场景对照

以下 S 编号是场景组，不是测试用例数。每组可能对应多个原生断言；右栏的“缺覆盖”只针对列出的边界，不能理解为 Chat 完全没有该功能的测试。能力编号对应前述 49 项基线。

### 1. 历史持久化与上下文

| 场景 | Pi 测了什么 | Chat 能力与证据 | 还缺什么 |
|---|---|---|---|
| S01 重开会话、多轮、模型/思考记录 | [build-context][n-context]、[runtime][n-runtime]：从原生历史恢复消息和状态；更换 Session 前等待旧响应结束 | 已保留同一 Session，业务配置可明确覆盖上一节点模型。[Workflow][c-workflow]、[公共装配][c-factory]；[实际 Runtime][c-runtime]覆盖切 Workflow、进程替换后审核继续 | Pi 的“切换活动运行对象”不等于浏览器只读打开另一会话；不能用原生 runtime 用例代替 Chat 并发写入保护 |
| S02 当前分支、完整原文、压缩后的有效上下文 | [build-context][n-context]：只沿所选 leaf 父链，最新压缩摘要在保留区间之前；其他分支不混入；孤儿 Entry 不拼接缺失父链 | 已保留。[读模型][c-read]检验 Entry ID 与消息一致、另一分支的压缩不污染当前分支；[fork][c-fork]检验原文仍可读且不改变执行上下文 | 非法 leaf/损坏文件/迁移仍要按 Backend 合同检验，不能依赖底层某些容错回退来猜用户意图 |
| S03 Workflow 元数据与 Writer 上下文 | [build-context][n-context]：custom 元数据不自动成为模型消息；构造上下文时仍需完整父链 | 已有 [原生接缝][c-seams]、[Writer][c-writer]。上一轮修复后，摘要可见、归档长文不回填、隐藏 handoff 不截断父链；实际 Provider 请求由 [Runtime][c-runtime]验证 | Chat 自定义 transformContext 必须持续保留专门回归；Pi 自己不会测试 Chat 的 remember 阶段 |

### 2. 压缩与摘要

| 场景 | Pi 测了什么 | Chat 能力与证据 | 还缺什么 |
|---|---|---|---|
| S04 自动压缩后继续交流 | [compaction suite][n-compact]：阈值/溢出、摘要 Entry、计费 usage、估计压缩后大小 | 自动压缩已保留。[Workflow][c-workflow]、[Friend 生命周期][c-daily]、[实际 Runtime][c-runtime]覆盖真实压缩、同 Session 重开、工具与规则继续可用；[浏览器][c-browser]检查结果反馈 | 自动压缩的成功路径已经有 Chat 证据，不表示以下失败组合也已覆盖 |
| S05 切点、零 usage、旧 usage | [切点与估算][n-cut]：保留区间、跨 turn 切点、custom 消息预算；[#8328][n-zero]：零 usage 时按估算判断；[auto queue][n-autoqueue]：压缩前旧 usage 不引发重复压缩 | 底层算法沿用；Chat 本轮选定原生测试覆盖零/旧 usage 判断 | 缺少这些输入穿过 Chat 公共装配、节点重建后的完整回归。不能把 tokens=0 当作没有上下文，也不能把未知当作 0 |
| S06 溢出与输出截断的区别 | [compaction suite][n-compact]：未达到期望输出长度的 length stop 可压缩恢复；达到输出上限不乱压缩；第二次仍溢出/截断则停止恢复；[pre-prompt][n-preprompt]不从 assistant 尾部错误 continue | 原生处理仍在；Chat 尚未找到等价的“失败→压缩→单次重试→终止”完整链路测试 | 增加实际 Workflow 的请求次数、终态、下一轮可发送和原历史不丢失断言，防无限重试或重复工作 |
| S07 摘要截断不落盘 | [#7048][n-truncated]：摘要以 length 结束时抛错，compaction Entry 数保持 0 | 真实公共装配及 Nitro Runtime 以 length/配额错误触发摘要失败，验证无成功 checkpoint、原文保留、同 Session 新轮继续；空摘要与其他 Provider 协议仍需扩展。 | 本轮门禁见 [维护合同](../sessions/chat-session-maintenance.md)；未列场景不宣称已覆盖。 |
| S08 摘要断流重试与取消 | [#6647][n-summaryretry]：terminated 重试、禁用重试、配额错误不重试、次数耗尽、取消退避 | 公共装配覆盖断流重试/退避取消，实际 Runtime 覆盖取消和进程重启；修复 generic AbortError 被误报为 failed。摘要重试事件已接 Web，压缩来信队列竞态仍待补。 | 本轮门禁见 [维护合同](../sessions/chat-session-maintenance.md)；未列场景不宣称已覆盖。 |
| S09 手动压缩与互斥 | [compaction suite][n-compact]和[prompt suite][n-prompt]：无模型/认证拒绝、取消后 idle、压缩中拒绝 prompt、compaction_end 时可开始下一条 | 已实现维护 API、原生 compact/abort、Session 锁、持久幂等与恢复；test/session-maintenance.test.mjs、实际 Runtime 和浏览器覆盖入口。 | 本轮门禁见 [维护合同](../sessions/chat-session-maintenance.md)；未列场景不宣称已覆盖。 |

### 3. 用量与成本

| 场景 | Pi 测了什么 | Chat 能力与证据 | 还缺什么 |
|---|---|---|---|
| S10 当前上下文与全会话统计 | [stats][n-stats]：压缩后当前用量未知；新有效响应后恢复；总量保留已压缩历史，并含摘要和带 usage 的工具结果 | 原生只读 helper 与 AgentSession 共用统计逻辑，Web 顶栏和 /session 已接。原生 stats 与 Chat 维护回归覆盖旧分支、摘要用量、未知上下文。 | 本轮门禁见 [维护合同](../sessions/chat-session-maintenance.md)；未列场景不宣称已覆盖。 |
| S11 普通请求与摘要请求的预算入口 | [compaction suite][n-compact]、[stats][n-stats]验证摘要 usage 落盘，**没有证明 Chat 的准入回调覆盖摘要** | 已把 gate 移到 SDK 共用 stream 边界；公共装配检验普通/压缩/分支摘要/重试 HTTP 次数，summary-budget.test.mjs 检验真实群/工作预算拒绝与成功摘要用量。 | 本轮门禁见 [维护合同](../sessions/chat-session-maintenance.md)；未列场景不宣称已覆盖。 |

### 4. 工具循环与事件时序

| 场景 | Pi 测了什么 | Chat 能力与证据 | 还缺什么 |
|---|---|---|---|
| S12 工具执行、结果、继续回答 | [prompt suite][n-prompt]、[Agent loop][n-loop]：多工具、参数、工具返回后继续模型；并行完成顺序与落盘顺序区分；截断的工具调用不执行 | 原生循环保留；[Workflow][c-workflow]真实执行 memory_search/业务工具；[公共装配][c-factory]真实执行文件工具 | 缺少 Chat 下多工具乱序完成、length 工具调用不执行、晚到工具更新的组合回归；普通单工具成功不是这些断言 |
| S13 异步扩展与消息顺序 | [#1717/#2113][n-settlement]：异步 message_end 后 assistant 必须先落盘，再 toolResult；[#8537][n-customorder]：工具期间插入 custom 消息应放在整批结果之后 | 原生保障存在，Chat 有普通流投影和重连测试 | 未找到 Chat 注入消息/业务工具/异步扩展叠加后的对应测试；应检查实际 Provider 消息配对，不只看 UI 是否显示 |
| S14 真正结束与中间 agent_end | [#6363][n-settled]：重试或 agent_end 扩展追加 follow-up 后只发一次最终 agent_settled；waitForIdle 等 Session 级完成 | Chat 工作阶段 await 原生 prompt，再进入 remember/结算；已有[实际 Runtime][c-runtime]的工作与记忆完成/中断证据 | 未找到“扩展在 agent_end 追加工作 + 重试 + remember”组合回归。公共事件丢弃 agent_settled 本身不能直接判成提前完成，必须查等待与结算链 |

### 5. 输入、队列与中断继续

| 场景 | Pi 测了什么 | Chat 能力与证据 | 还缺什么 |
|---|---|---|---|
| S15 steer 与 followUp 时机 | [queue suite][n-queue]：引导在下次模型调用前消费，follow-up 在当前工作后消费；one-at-a-time/all；输入钩子转换与 handled | **部分接通**。Friend 的 [turn-feedback][c-feedback]覆盖引导一次投递、跨项目拒绝、晚到转下一轮、取消后 follow-up。普通 Workflow 入口未接（15/16） | Friend 的耐久下一轮队列与原生内存队列语义不同；普通 Workflow、批量模式和扩展输入转换需单独适配/验收 |
| S16 队列可见性、取回、压缩时序 | [queue suite][n-queue]：消费前移除 pending 文本，禁止把扩展命令当普通队列文字；[auto queue][n-autoqueue]/[compaction suite][n-compact]涉及压缩与队列 | Web queuedMessages 固定空、recall 空（17），不代表 Backend 没有队列 | 接耐久受理/待消费/已消费事实；压缩期间来信、取消与取回竞态必须测试，不能直接清空本地数组 |
| S17 中断后的显式继续 | [prompt suite][n-prompt]：resumePendingTurn 恢复未完成 user turn；已完整 assistant 尾拒绝恢复 | Chat 能恢复已受理队列与待审核 Run；[实际 Runtime][c-runtime]和[Topic 中断][c-interrupt]验证未知 in-flight 写入不自动重放。普通会话显式 resume 未接（18） | 需区分安全继续与重放副作用工具；“不自动重放”是保护，不等于已经支持用户主动继续 |

### 6. 普通重试与停止

| 场景 | Pi 测了什么 | Chat 能力与证据 | 还缺什么 |
|---|---|---|---|
| S18 可重试错误、上限、停止 | [retry suite][n-retry]：瞬时失败恢复、耗尽、禁用、认证错误不重试、取消退避；恢复后继续完成工具循环 | 原生机制保留，Chat [事件单测][c-events]验证普通 retry 投影；[Friend][c-feedback]覆盖停止、终态和后续轮次 | 没有等价的 Chat Provider 故障序列回归来证明所有 retry 分支；“终态显示失败”不是“重试策略已完整验收” |
| S19 取消后的记录与结算 | [retry suite][n-retry]：取消流后 aborted assistant 留存并最终 settled；[runtime][n-runtime]切换前中止工具并保存对应结果 | 原有取消/结算门禁之外，实际 Runtime 已补摘要失败、退避取消、压缩中 Backend 重启、同 ID 继续及不重放。 | 本轮门禁见 [维护合同](../sessions/chat-session-maintenance.md)；未列场景不宣称已覆盖。 |

### 7. 分支与生命周期操作

| 场景 | Pi 测了什么 | Chat 能力与证据 | 还缺什么 |
|---|---|---|---|
| S20 看旧节点与从旧节点继续 | [tree navigation][n-tree]：选 user 时返回编辑文本并切到其父节点；选 assistant 时定位该节点；无摘要导航不增 Entry | GET 仍只读；显式继续以原生 branch/resetLeaf、纯元数据、expectedLeafId 检查提交持久位置；用户节点回填，工具中间位置拒绝。不是 CLI 全部树钩子/分支摘要的等价实现。 | 本轮门禁见 [维护合同](../sessions/chat-session-maintenance.md)；未列场景不宣称已覆盖。 |
| S21 fork、分支摘要、标签 | [runtime][n-runtime]：fork 的 before/at、无效 ID、未落盘会话；[branch summary][n-branchsummary]验证位置/来源/usage；[labels][n-labels]验证增删改和持久化 | 普通 [fork][c-fork]已做同项目、锁、幂等和原文保留。原生已有标签能由[树投影][c-tree]展示；但标签写入口、分支摘要生成/取消未接（37/38） | 已有 fork 不能代替原地导航或摘要；Friend/Topic 要保留各自归属合同。标签“展示过”不等于可管理 |
| S22 clone/import 与业务归属 | [RPC clone][n-clone]只断言命令发送；[interactive import][n-import]验证路径参数、确认与错误提示，runtime 被替身替换；这些不是完整导入持久化证明 | Chat 缺少 owner/Project/来源校验下的完整产品合同（39）；不能把直接复制 JSONL 当已支持 | 定义幂等导入、来源、模型/资源恢复策略；保留可追溯性，拒绝借导入跨项目读取 |

### 8. Prompt、Skill 与上下文资源

| 场景 | Pi 测了什么 | Chat 能力与证据 | 还缺什么 |
|---|---|---|---|
| S23 Context 根、资源发现与优先级 | [resource loader][n-resources]：AGENTS.override、父目录层叠、信任、资源冲突、显式路径、reload | Chat **有意按授权根适配**：Personal/当前 Project/Friend，固定 revision；[公共装配][c-factory]覆盖切项目、符号链接越界、资源冻结与变更恢复失败 | 原生的祖先目录自动发现不是要照搬的功能。需要保留 Chat 对应反例，而非强行让原生发现规则全部生效 |
| S24 Skill/模板/命令展开 | [prompt suite][n-prompt]：/skill 展开、模板参数、sendUserMessage 显式选择展开；[prompt templates][n-templates]补参数解析 | 原生 prompt 路径能展开；Chat 已测资源装配和冻结，但 Web 命令目录/补全为空（28/32） | 逐入口检查普通 Workflow、Friend、Topic 的传参/展开/原文记录；不能用“System Prompt 里有 skill 名称”替代实际展开测试 |

### 9. 扩展

| 场景 | Pi 测了什么 | Chat 能力与证据 | 还缺什么 |
|---|---|---|---|
| S25 运行钩子与生命周期 | [model/extension suite][n-modelext]：input/context、工具阻止与改写、System Prompt、bindExtensions/start、reload/shutdown | 已加载扩展可进入原生 runner；[公共装配][c-factory]有代码冻结/恢复拒绝；Chat 工厂未 bindExtensions，start/discover 缺失（30） | 要区分执行、检查、恢复的生命周期，发现资源之后再次授权/冻结；只读检查不可借“补钩子”运行有副作用的启动逻辑 |
| S26 扩展命令、交互与显示 | [extensions runner][n-ext]：重名命令、UI 模式、快捷键冲突、错误隔离、renderer；原生 RPC 可接 UI 回复 | Web 的 extension UI、状态/widget/回复仍有占位，命令发现缺失（31/32） | 需带 Session/Run/requestId 的交互合同，以及超时、取消、断线恢复；不能把 headless 能运行当作交互扩展可用 |

### 10. 模型、思考等级与供应商

| 场景 | Pi 测了什么 | Chat 能力与证据 | 还缺什么 |
|---|---|---|---|
| S27 模型/思考等级与配置 | [model/extension suite][n-modelext]：模型变更记录、scoped 循环、thinking 能力夹取、xhigh/max、缺认证拒绝 | Chat Backend 解析有效配置并传 Pi；[配置测试][c-config]和[Workflow][c-workflow]覆盖覆盖顺序与记录，[公共装配][c-factory]覆盖 Friend 不误用项目模型 | 配置持久化测试不等于所有模型实际支持该等级；重开/切节点后有效等级、不同模型能力选项还需逐组合验收 |
| S28 协议与供应商边界 | `ai/test` 覆盖 toolCall ID/结果配对、thinking 签名重放、空块、图片、流截断、取消、usage/cache、重试与 OAuth | Chat 继承 Pi Provider，新增模型目录和认证管理；现有本地 HTTP 假模型主要证明经过选定协议的装配与传输 | 138 个原生文件并非 138 种已验收产品能力。有真实服务条件测试；本次未运行供应商实网矩阵。预算/自定义 stream/HTTP options 尤须过公共装配 |

### 11. 工具与附件

| 场景 | Pi 测了什么 | Chat 能力与证据 | 还缺什么 |
|---|---|---|---|
| S29 原生工具、用户 shell 与截断 | [tools][n-tools]和 bash 相关回归覆盖文件/命令结果；[bash persistence][n-bash]覆盖用户执行、取消、延迟输出/落盘 | 模型工具已接，Chat 额外的文件范围由[公共装配][c-factory]验证。用户 `!`/`!!` 输入在 Web 被拒绝（44） | 模型 bash 工具不等于用户 shell 模式；原生截断测试不证明 Web 没裁切按钮或丢失完整输出入口 |
| S30 图片输入与工具图片结果 | [prompt suite][n-prompt]：图片传到 Provider、纯图片不加空文本；[tool images][n-images]：结果图片进入后续模型上下文 | 普通 Workflow 有[输入校验][c-images]、读模型/延迟图片 API；Friend 的 [turn-feedback][c-feedback]明确在受理前拒绝图片 | 不能写成“所有 Chat 入口都支持图片”；从浏览器附件到实际请求的验收必须按普通/Friend/Topic 与模型能力区分 |

### 12. 产品外围、传输与显示

| 场景 | Pi 测了什么 | Chat 能力与证据 | 还缺什么 |
|---|---|---|---|
| S31 名称、导出与运行设置 | SessionInfo、[HTML XSS][n-html]、技能块、空白；[settings][n-settings]覆盖层叠、保存、reload；[JSONL RPC][n-jsonl]覆盖传输入口 | Chat [改名][c-name]、[HTML 导出][c-export]已有对应实现/测试；JSONL 下载与完整 compaction/retry/queue 设置入口未接（41/48） | 不应重复实现 Pi 解析器/统计器；需要产品作用域与后台 API，以及操作后的刷新恢复测试 |
| S32 Web/TUI、HTTP、实验后端 | TUI 宽度/按键/弹层与 RPC/socket/CBOR/Harness/SQLite 各测自己的边界 | Chat 有自己的 HTTP/SSE、[实际浏览器][c-browser]与 [TUI 客户端][c-tui]；未采用的 Pi server/SQLite 不是缺失基础 Session 的证据 | Web 中英切换、控件布局、主题不能由 Pi 终端测试背书；Chat HTTP 断线/重放/去重需自己的门禁 |

## 优先补齐的回归合同

以下是待实施项目；本次没有将缺陷行为写成“期望通过”，也没有新增一套 Session 运行时。

1. **P0：压缩失败与原文安全**（S05–S09）。真实公共装配 + 本地受控 Provider：零/旧 usage、溢出恢复一次、摘要被截断、摘要断流/配额错误、退避取消、压缩期间来信。检查 JSONL 原文、compaction 数、实际请求次数、同 Session、最终状态与下一轮。不得只手工 appendCompaction。
2. **P0：请求预算**（S11）已修复：统一准入、成功摘要用量、分段/分支/重试以及真实群预算均有门禁。保留供应商未报告 usage 与失败请求计费不可精确推断的边界。
3. **P1：结束时序**（S12–S19）。工具乱序完成/晚到更新、异步 message_end、custom 注入、agent_end 追加 follow-up、重试后工具。验证 remember 只在真实工作完成后启动，取消不记为完成，恢复不重放未知副作用。
4. **P1：用户可操作能力**（S09/S10/S15–S17/S20–S22）。手动压缩、用量、队列、从历史继续按 owner/锁/授权的统一 Backend 合同接入；原生方法存在不构成验收。
5. **P1：扩展及资源**（S23–S28）。执行与只读检查分开绑定，发现资源后授权与冻结，命令发现及 UI 往返明确能力；模型与思考等级以有效配置和实际请求验证。

验收要同时经过三层：选定原生用例、Chat 公共装配/领域回归、受影响用户路径的实际 Workflow Runtime/浏览器。原生用例无需全部复制进 Chat；只在 Chat 改变装配、过滤、事件、持久化、权限或生命周期的接缝增加业务回归。Pi gitlink 升级时重新核对场景和条件执行项。

## 读测试时的两个陷阱

- **名称不等于断言。** `agent-session-auto-compaction-queue.test.ts` 的一个标题写着 resume，但实际断言是 `continue` 没被直接调用；不能仅抓标题就宣称验证了完整恢复。需要结合 suite 和实际生产路径判断。
- **文件存在不等于执行过。** `agent-session-tree-navigation.test.ts` 使用 `describe.skipIf(!API_KEY)`；压缩文件也混合纯本地与真实服务条件测试。参数化、动态循环、共享 conformance suite 使静态声明数不同于执行案例数。未经单独说明，不给出“Pi 总测试通过率”或“Chat 继承覆盖率”。

[n-context]: ../../../pi/packages/coding-agent/test/session-manager/build-context.test.ts
[n-runtime]: ../../../pi/packages/coding-agent/test/suite/agent-session-runtime.test.ts
[n-compact]: ../../../pi/packages/coding-agent/test/suite/agent-session-compaction.test.ts
[n-cut]: ../../../pi/packages/coding-agent/test/compaction.test.ts
[n-zero]: ../../../pi/packages/coding-agent/test/suite/regressions/8328-zero-usage-auto-compaction.test.ts
[n-autoqueue]: ../../../pi/packages/coding-agent/test/agent-session-auto-compaction-queue.test.ts
[n-preprompt]: ../../../pi/packages/coding-agent/test/suite/regressions/pre-prompt-compaction-no-continue.test.ts
[n-truncated]: ../../../pi/packages/coding-agent/test/suite/regressions/7048-compaction-truncated-summary.test.ts
[n-summaryretry]: ../../../pi/packages/coding-agent/test/suite/regressions/6647-compaction-retries-transient-stream-drop.test.ts
[n-prompt]: ../../../pi/packages/coding-agent/test/suite/agent-session-prompt.test.ts
[n-stats]: ../../../pi/packages/coding-agent/test/agent-session-stats.test.ts
[n-loop]: ../../../pi/packages/agent/test/agent-loop.test.ts
[n-settlement]: ../../../pi/packages/coding-agent/test/suite/regressions/1717-2113-agent-session-event-settlement.test.ts
[n-customorder]: ../../../pi/packages/coding-agent/test/suite/regressions/8537-custom-message-tool-result-ordering.test.ts
[n-settled]: ../../../pi/packages/coding-agent/test/suite/regressions/6363-agent-settled-event.test.ts
[n-queue]: ../../../pi/packages/coding-agent/test/suite/agent-session-queue.test.ts
[n-retry]: ../../../pi/packages/coding-agent/test/suite/agent-session-retry-events.test.ts
[n-tree]: ../../../pi/packages/coding-agent/test/agent-session-tree-navigation.test.ts
[n-branchsummary]: ../../../pi/packages/coding-agent/test/branch-summary-extensions.test.ts
[n-labels]: ../../../pi/packages/coding-agent/test/session-manager/labels.test.ts
[n-clone]: ../../../pi/packages/coding-agent/test/rpc-client-clone.test.ts
[n-import]: ../../../pi/packages/coding-agent/test/interactive-mode-import-command.test.ts
[n-resources]: ../../../pi/packages/coding-agent/test/resource-loader.test.ts
[n-templates]: ../../../pi/packages/coding-agent/test/prompt-templates.test.ts
[n-modelext]: ../../../pi/packages/coding-agent/test/suite/agent-session-model-extension.test.ts
[n-ext]: ../../../pi/packages/coding-agent/test/extensions-runner.test.ts
[n-tools]: ../../../pi/packages/coding-agent/test/tools.test.ts
[n-bash]: ../../../pi/packages/coding-agent/test/suite/agent-session-bash-persistence.test.ts
[n-images]: ../../../pi/packages/coding-agent/test/suite/agent-session-tool-result-images.test.ts
[n-html]: ../../../pi/packages/coding-agent/test/export-html-xss.test.ts
[n-settings]: ../../../pi/packages/coding-agent/test/settings-manager.test.ts
[n-jsonl]: ../../../pi/packages/coding-agent/test/rpc-jsonl.test.ts
[c-workflow]: ../../../test/workflows/chat-session-workflows.test.mjs
[c-factory]: ../../../test/agents/public-assembly.test.mjs
[c-runtime]: ../../../scripts/unified-session-runtime.test.mjs
[c-read]: ../../../test/session-read-model.test.mjs
[c-fork]: ../../../test/session-fork.test.mjs
[c-seams]: ../../../test/agents/pi-assembly-seams.test.mjs
[c-writer]: ../../../test/workflows/session-memory-writer-runtime.test.mjs
[c-daily]: ../../../test/long-agents/daily-lifecycle.test.mjs
[c-browser]: ../../../scripts/session-memory-switch-browser.test.mjs
[c-events]: ../../../test/workflows/chat-run-events.test.mjs
[c-feedback]: ../../../test/long-agents/turn-feedback.test.mjs
[c-interrupt]: ../../../test/long-agents/topic-interruption-recovery.test.mjs
[c-tree]: ../../../test/session-tree-projection.test.mjs
[c-config]: ../../../test/workflows/agent-config.test.mjs
[c-images]: ../../../test/workflows/image-input.test.mjs
[c-name]: ../../../test/session-name.test.mjs
[c-export]: ../../../test/session-export.test.mjs
[c-tui]: ../../../test/workflow-tui.test.mjs
