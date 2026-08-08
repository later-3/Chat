# Chat 项目状态

> 更新日期：2026-08-08

## 1. 当前结论

| 项目 | 当前事实 |
|---|---|
| 产品身份 | 独立、完整、持续运营的Chat产品 |
| 主分支 | `main`为PR #10合并提交`8acafb5`；M2候选在`codex/m2-memmy-memory-import`的Draft PR #11等待最终合入 |
| 前端 | React + TypeScript + Vite；响应式PWA；最小Plan审核与运行投影已接真实后端 |
| 后端 | Node.js + TypeScript；Hono协议入口；Application拥有事务 |
| Product Store | M2候选升级为`chat-product-store.v3`；串行支持v1→v2→v3，保持单实例单写者、原子替换与损坏失败关闭 |
| Workflow | 规划仍由唯一`PlanningExecutionWorkflow`完成；M2另有独立`MemoryImportWorkflow`拥有导入/对账副作用生命周期 |
| Agent Runtime | `pi-agent-core` + `pi-ai` + `pi-coding-agent`；百炼真实`qwen3.7-plus`已验证 |
| 调试与回放 | 固定端口VS Code Compound；严格脱敏Trace；Trace + Product Store多源Replay |
| 代码状态 | P0、P1.1、P1.2、B1、B2和M1已合入`main`；M2真实memmy显式导入纵向链已完成、待PR #11最终合入 |
| 当前阶段 | 长期上下文与知识复用：Memory、BMAD项目上下文、用户规则集 |
| 当前任务 | 完成M2自审、质量门和PR合入；下一任务用Tencent MemoryCore真实Adapter验证查询/导入抽象 |

## 2. B2已完成的真实证据

1. PR #7已合入`main`，合并提交为`06d1177bdfd0f78bd84430d2eb57513b7638d08c`。
2. 真实Provider门`pnpm test:provider:bailian`通过3/3；使用本地私有配置调用百炼`qwen3.7-plus`，凭据不进入Git、Trace或文档。
3. 真实浏览器E2E`pnpm test:e2e:planning-execution:real`通过：发送消息、Plan v1、刷新恢复、手机布局、要求修订、Plan v2、旧审批409、批准、真实执行、正式Assistant Message、完成后刷新恢复。
4. 真实运行`run_610673cbd1464274a5cc5af5213b22d3`产生2版Plan、2个Decision、4次HTTP 200的真实Provider调用、124条严格Trace事件；Replay发现0个完整性错误。
5. `format`、`lint`、`typecheck`、326项测试、`build`和生产依赖审计全部通过；PR #7的6个CI检查全部通过。
6. 已知非阻断现象：Workflow SDK 4.8按官方`Promise.race`实现Hook与超时时，会在胜出后报告两个未提交sleep operation警告；本次运行、Store、Trace和Replay均正确，后续升级SDK或修改等待策略时重新验证。

## 3. M1与M2的真实证据

1. M1已经由PR #10合入；固定memmy提交为`211d521b310fc23c63dd3d9ca848941173981c5e`，真实查询、冻结ContextPackage、规划采用、执行和Replay闭环均已证明。
2. M2的`pnpm test:memory:memmy-real-import`通过：真实add、相同requestId/正文原生幂等、不同正文409、GET+Search物化验证及SQLite唯一对象均成立。
3. M2的`pnpm test:memory:memmy-response-drop`通过：真实路径贯穿Product Store、Outbox、Workflow与Memmy；Memmy返回200并落库后代理销毁响应，Chat提交`outcome_unknown`，再以同一身份对账为`materialized`，Replay无缺口且SQLite仍只有1条。
4. `pnpm test:e2e:memory-import:real`从clean提交通过1/1（2.1分钟）：390×844正式消息选区、真实导入、API/Workflow真重启恢复、无Memory对照、新会话真实查询、百炼`qwen3.7-plus`规划与执行全部成功。
5. 同一真实门的Import Replay含6个事件、Run Replay含103个事件，二者完整性错误为0且默认不含正文；Trace不含唯一canary、消息选区、密钥、endpoint或Runtime私有身份。
6. M2把Store升级为v3，非空v2 Memory事实逐对象迁移；截断、未知Schema、悬空引用、Hash篡改、迁移I/O故障均失败关闭且不改原文件。
7. 当前确定性测试共484项；全仓build/lint/format/typecheck、生产依赖审计和真实Memmy两条门已通过。最终百炼浏览器门会从当前clean提交再跑一次，不能用旧提交证据替代。

## 4. 已冻结决定

1. Product Store是产品事实源；外部Memory服务、Workflow Store、pi Session、Trace和浏览器缓存不能替代产品事实。
2. 浏览器不直接调用Vercel Workflow、pi或外部Memory服务，也不持有Hook Token、Workflow Run ID和pi Session ID。
3. HITL先提交产品Decision，再由后端恢复Workflow Hook。
4. Trace只记录系统路径、关联、状态、版本、耗时、错误和对象引用；正文只保存在对应权威事实源。
5. 新的Memory、项目上下文和规则能力必须通过Port/Adapter隔离外部实现，但不建立没有真实替换价值的万能接口。
6. 每个重要架构决定必须指出真实参考项目证据、Chat场景调整和明确拒绝项，不能只靠经验猜测。
7. 实现任务使用独立Git worktree、`codex/`分支和PR；简单任务不扩大验证，纵向里程碑必须运行真实服务、真实模型和浏览器E2E。
8. 弱服务器只接收开发机或CI构建、测试、校验后的可追溯产物，不在服务器安装依赖、编译或运行测试。

## 5. 当前没有的能力

1. 已有真实memmy查询和显式L2导入；尚无第二真实后端Adapter、自动后台记忆和生产Memory服务部署配置。
2. 没有长期Project/Work/Stage/Status、项目文档清单和版本化Context Package实现。
3. 没有带标签、场景范围、修订和选择证据的用户规则集，也没有规划节点规则注入。
4. 没有Chat有序SSE Cursor Runtime Journal；B2仍使用受控Query轮询。
5. 没有外部副作用Tool、多实例数据库、备份恢复和生产后端部署拓扑。

## 6. 下一阶段的三个用户结果

1. **Memory**：M1/M2已让用户按标签查询真实memmy并把明确选区导入；下一步接入Tencent MemoryCore，验证同一能力边界能承载异步物化与不同隔离语义。
2. **项目上下文**：用户用Chat推进项目时，可以恢复当前阶段、状态、目标、决定、阻塞、文档与下一步；结构受BMAD真实方法启发，但允许按项目类型裁剪。
3. **用户规则**：用户可以在统一界面维护带标签和场景范围的个人习惯/要求，也可以让Chat提出维护建议；对话中可主动勾选或按标签筛选，规划时记录最终采用规则及其版本。

详细任务数量、依赖、合同和完成门必须在复核本地参考项目与既有分析后写入任务书，审核前不假装已冻结。

## 7. 安全与开发边界

1. 不提交API Key、Memory服务Token、本地数据库、运行Trace、缓存、构建产物或`.env`。
2. 不把外部Memory记录直接当成Chat长期事实；召回结果先成为有来源的上下文候选，导入动作必须有明确目标与幂等语义。
3. 不让模型直接修改项目阶段、正式规则或文档清单；模型输出先形成候选，再经过确定性校验及必要的用户决定。
4. 不为了三个后续能力建立万能Context Service或插件平台；抽象只覆盖已经验证的真实差异。
5. 不把三个阶段目标放进一个巨大PR，也不把单个DTO拆成没有用户结果的小PR。
