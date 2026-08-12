# Chat 项目状态

> 更新日期：2026-08-13

## 1. 当前结论

| 项目 | 当前事实 |
|---|---|
| 产品身份 | 独立、完整、持续运营的Chat产品 |
| 主分支 | `main`是唯一开发基线；精确提交以`origin/main`为准 |
| 前端 | React + TypeScript + Vite；响应式PWA；最小Plan审核与运行投影已接真实后端 |
| 后端 | Node.js + TypeScript；Hono协议入口；Application拥有事务 |
| Product Store | `chat-product-store.v10`；串行支持v1→v10，保持单实例单写者、原子替换与损坏失败关闭；新增Workflow Definition/RunSpec/Node事实、Note、Rules、Planning Project/Memory Context与Policy Resolution |
| Workflow | 旧`PlanningExecutionWorkflow`继续兼容历史Run；新Run由固定`configurable-planning.v1`或`note-capture.v1` Runner解释不可变RunSpec；Memory Import、Project Intake/Advancement保持独立生命周期 |
| Agent Runtime | `pi-agent-core` + `pi-ai` + `pi-coding-agent`；Planner/Executor与模型无关Project Understanding均已用百炼真实`qwen3.7-plus`验证 |
| 调试与回放 | 仓库统一`pnpm dev/dev:debug`拥有Memory、Workflow、API和Web服务图；VS Code只有应用级薄入口；固定端口、安全清理、严格脱敏Trace及多源Replay |
| 代码状态 | P0、P1、B1/B2、M1～M3、PS1/PS2.1与P6核心纵向均已进入`main`；PR #23 merge commit为`7fc8947`。原始P6 G3中的正式Research与Skill资源仍未交付 |
| 当前阶段 | 人—Agent工作台参考研究已经收口归档；统一骨架和当前前端差距已有证据，但尚未应用到生产前端 |
| 当前任务 | 下一Session从已归档选择中挑一个具体场景继续做视觉/交互优化；用户明确授权生产改造前，不修改`apps/web` |

## 2. B2已完成的真实证据

1. PR #7已合入`main`，合并提交为`06d1177bdfd0f78bd84430d2eb57513b7638d08c`。
2. 真实Provider门`pnpm test:provider:bailian`通过3/3；使用本地私有配置调用百炼`qwen3.7-plus`，凭据不进入Git、Trace或文档。
3. 真实浏览器E2E`pnpm test:e2e:planning-execution:real`通过：发送消息、Plan v1、刷新恢复、手机布局、要求修订、Plan v2、旧审批409、批准、真实执行、正式Assistant Message、完成后刷新恢复。
4. 真实运行`run_610673cbd1464274a5cc5af5213b22d3`产生2版Plan、2个Decision、4次HTTP 200的真实Provider调用、124条严格Trace事件；Replay发现0个完整性错误。
5. `format`、`lint`、`typecheck`、326项测试、`build`和生产依赖审计全部通过；PR #7的6个CI检查全部通过。
6. Workflow Runtime在Hook恢复事实写入后显式唤醒同一Run的审核超时sleep；最终两轮审核真实链没有未提交operation或Trace写入告警。

## 3. M1与M2的真实证据

1. M1已经由PR #10合入；固定memmy提交为`211d521b310fc23c63dd3d9ca848941173981c5e`，真实查询、冻结ContextPackage、规划采用、执行和Replay闭环均已证明。
2. M2的`pnpm test:memory:memmy-real-import`通过：真实add、相同requestId/正文原生幂等、不同正文409、GET+Search物化验证及SQLite唯一对象均成立。
3. M2的`pnpm test:memory:memmy-response-drop`通过：真实路径贯穿Product Store、Outbox、Workflow与Memmy；Memmy返回200并落库后代理销毁响应，Chat提交`outcome_unknown`，再以同一身份对账为`materialized`，Replay无缺口且SQLite仍只有1条。
4. `pnpm test:e2e:memory-import:real`从clean代码提交`3bcb7b7`通过1/1（浏览器2.8分钟、命令总计3.1分钟）：390×844正式消息选区、真实导入、API/Workflow真重启恢复、无Memory对照、新会话真实查询、百炼`qwen3.7-plus`规划与执行全部成功。
5. 同一真实门的Import Replay含6个事件、Run Replay含103个事件，二者完整性错误为0且默认不含正文；Trace不含唯一canary、消息选区、密钥、endpoint或Runtime私有身份。
6. M2把Store升级为v3，非空v2 Memory事实逐对象迁移；截断、未知Schema、悬空引用、Hash篡改、迁移I/O故障均失败关闭且不改原文件。
7. 当前确定性测试共484项；全仓build/lint/format/typecheck、生产依赖审计、真实Memmy两条门与最终clean提交百炼浏览器门均已通过。

## 4. 已冻结决定

1. Product Store是产品事实源；外部Memory服务、Workflow Store、pi Session、Trace和浏览器缓存不能替代产品事实。
2. 浏览器不直接调用Vercel Workflow、pi或外部Memory服务，也不持有Hook Token、Workflow Run ID和pi Session ID。
3. HITL先提交产品Decision，再由后端恢复Workflow Hook。
4. Trace只记录系统路径、关联、状态、版本、耗时、错误和对象引用；正文只保存在对应权威事实源。
5. 新的Memory、项目上下文和规则能力必须通过Port/Adapter隔离外部实现，但不建立没有真实替换价值的万能接口。
6. 每个重要架构决定必须指出真实参考项目证据、Chat场景调整和明确拒绝项，不能只靠经验猜测。
7. 实现任务使用独立Git worktree、`codex/`分支和PR；简单任务不扩大验证，纵向里程碑必须运行真实服务、真实模型和浏览器E2E。
8. 弱服务器只接收开发机或CI构建、测试、校验后的可追溯产物，不在服务器安装依赖、编译或运行测试。

## 4.1 M3的真实证据

1. 固定Tencent MemoryCore提交`3a9748d3c61c`真实HTTP门通过，证明L0接收、L0只读对账、L1 BM25查询、错误Token与错误隔离语义。
2. 真实Chromium + 百炼`qwen3.7-plus`纵向门通过：选后端、召回L1、规划采用、导入L0、accepted显示、手动对账、刷新恢复和拒绝闭环全部贯通。
3. UI由后端能力投影驱动：MemoryCore仅开放L1查询和L0会话捕获，不显示标签或标题；服务端再次拒绝越权参数。
4. `accepted`是L0已落事实的合法状态，不等同于L1 `materialized`；终态监督器不得把合法accepted误降级为结果未知。
5. PR #12与PR #13已合入；当时的真实VS Code Compound曾验证5个服务全部Ready和9个历史端口释放。该历史编排已被仓库统一启动器替代，不再作为当前开发入口。

## 4.2 统一应用启动与调试证据

1. `pnpm dev`真实启动memmy、Tencent MemoryCore、Workflow、API和Web；5个HTTP入口均返回200，应用最后才输出唯一`[chat] ready`行。
2. `pnpm dev:debug`复用同一服务图，只开放API `43120`与Workflow `43121`；Memory不创建默认Inspector，历史`43122/43123`不再属于冻结端口。
3. 同一Git仓库的worktree共享经过commit/tree/Hash复核的固定Memory源码缓存；Product Store、Workflow Store、Memory数据库和Trace仍按worktree隔离。
4. VS Code只显示`Chat：调试应用`一个入口；真实F5到达Ready后自动建立专属Profile的Chrome调试，并附加Chat自己的API与Workflow TypeScript进程；API源码断点成功绑定，没有Memory或准备阶段短命令调试会话。
5. 真实遗留浏览器门已通过：预置携带worktree专属Profile的Chrome与Singleton锁后，下一次F5自动收敛旧进程、无旧Session警告并成功附加新浏览器；连续干净F5也成功。
6. 从终端SIGINT以及VS Code停止后，Web、API、Workflow、两套Memory和两个Inspector共7个固定端口及专属浏览器全部释放，`pnpm dev:status`报告未运行。
7. 固定端口登记现由Git Common Directory锚定为仓库级运行投影。真实预置另一个worktree中无PID登记的Web/API/Workflow监听者后，当前`main`能按端口角色、命令、cwd和Git仓库四重身份自动收敛并Ready；随后在TraeCode真实F5中API停在`OutboxDispatcher.tick`断点、Workflow与内部Chrome均已附加，Stop后全部端口释放。

## 4.2 PS1的真实证据

1. 用户可从正式Chat显式进入建项模式；Message、queued Candidate、Receipt和Start Outbox原子提交，独立`ProjectIntakeWorkflow`完成模型理解、真实资源观察、Hook等待与恢复。
2. `ProjectIntakeUnderstandingPort`与服务端Model Profile解耦；真实E2E使用百炼`qwen3.7-plus`完成唯一一次模型调用，公开DTO不含Provider/模型，失败使用`FatalError`禁止自动付费重试。
3. 真实Resource Registry只接受服务端配置的rootId；已真实观察Git HEAD/branch/status/recent commits、治理文档Manifest与package脚本清单，不执行脚本、不写Git、不暴露绝对路径。
4. 建项确认原子创建Project、Method Snapshot、初始Stage、Resource、Participant、Work/Action、Decision、Evidence与Observation；Portfolio、Workspace和Timeline可在刷新后恢复。
5. “管理项目”对话可生成绑定revision/Hash的待办、决定和贡献Candidate；修订/确认/拒绝均经CAS，两个页面并发确认严格为一个201和一个409。
6. 独立恢复测试真实停止并重建API与Workflow进程；恢复后Candidate revision/Hash、Workflow Run ID和唯一理解调用不变，最终只创建一个Project。
7. 真实Chromium场景通过桌面与390×844手机视口；Trace含严格模型/对象/耗时证据，不含用户正文、决定正文、绝对路径、密钥或Runtime私有身份。

## 4.3 PS2.1的真实证据

1. 用户可在现有Project显式切换“推进项目”；正式Message、版本绑定queued Candidate、Receipt和Start Outbox原子提交，独立`ProjectAdvancementWorkflow`完成理解、Hook等待与恢复。
2. Method Snapshot v2与Stage v2进入Store v5；v4→v5对旧Project采用确定性映射并标记`migrated_v1`，不伪造历史用户Decision。非空迁移、重启幂等和跨对象完整性测试通过。
3. Candidate同时绑定Project/Stage revision与Method Hash；旧revision/Hash确认返回409。确认分支一次提交Decision、Stage revision、Milestone、负责人Project Update、Project revision和Resume Outbox。
4. Stage/Milestone状态转换必须经过Domain规则、Principal/Participant权限、Decision与Evidence校验；Timeline从严格State Transition、Decision和Update等产品事实组装，不用Trace冒充账本。
5. 免费恢复门真实停止并重建API与Workflow：Intake与Advancement等待确认后都恢复同一Candidate和Workflow Run，同一Candidate revision的Understanding调用各保持1次。
6. 真实Chromium + 当前服务端Model Profile的百炼`qwen3.7-plus`通过：建项、推进、直接修订、旧版本409、确认、刷新恢复和390×844无横向溢出；最终HEAD连续两轮真实门分别耗时28.6秒和27.7秒。pi Provider边界显式关闭Qwen思考模式并强制唯一结果工具，避免普通正文响应绕过候选合同。
7. Trace新增严格Project Advancement/Stage/Milestone/Update事件，只含对象ID、revision/Hash、模型版本、耗时和结果；真实canary、Stage/Update正文、密钥与Runtime私有身份扫描均为0。

## 5. 当前没有的能力

1. 已有真实memmy和Tencent MemoryCore查询/导入；尚无自动后台记忆、L1后台定时对账和生产Memory服务部署配置。
2. 已有版本化Planning Project Context与Rules注入；尚无完整Shaping Proposal、Iteration、Scope、Gate/Review和Correct Course产品纵向。
3. 已有Note、Rules与受限Workflow Designer；原始P6目标中的正式Research和Skill产品集合/消费链尚未交付，此外也没有Reminder/日历调度、任意插件市场或通用自动化节点。
4. 没有Chat有序SSE Cursor Runtime Journal；当前活动投影仍使用受控Query轮询。
5. 没有多实例数据库、备份恢复和生产后端部署拓扑；外部副作用仍只开放既有受治理能力。
6. 统一工作台骨架尚未接入生产前端；当前真实入口仍有独立壳层与固定双栏，Agent Profile、真正Pause/Resume、完整权限/写回合同和移动端等价路径仍需后续场景任务。

## 6. 下一阶段的三个用户结果

1. **工作台场景优化**：基于已归档的9项工作台、用户选择和冻结骨架，一次只优化一个具体场景；先形成可审核视觉/交互方案，再决定是否进入生产实现。
2. **Project Solution**：在已接Planning Project Context基础上继续Shaping Proposal、显式Iteration Commitment、Scope/Gate/Review与Correct Course。
3. **运行时与运营**：补Chat有序SSE Cursor、生产Store/备份/容量和正式Research/Skill/Reminder产品纵向，不把它们塞进通用Workflow表达式引擎。

详细任务数量、依赖、合同和完成门必须在复核本地参考项目与既有分析后写入任务书，审核前不假装已冻结。

## 7. 安全与开发边界

1. 不提交API Key、Memory服务Token、本地数据库、运行Trace、缓存、构建产物或`.env`。
2. 不把外部Memory记录直接当成Chat长期事实；召回结果先成为有来源的上下文候选，导入动作必须有明确目标与幂等语义。
3. 不让模型直接修改项目阶段、正式规则或文档清单；模型输出先形成候选，再经过确定性校验及必要的用户决定。
4. 不为了三个后续能力建立万能Context Service或插件平台；抽象只覆盖已经验证的真实差异。
5. 不把三个阶段目标放进一个巨大PR，也不把单个DTO拆成没有用户结果的小PR。
