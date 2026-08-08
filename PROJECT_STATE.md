# Chat 项目状态

> 更新日期：2026-08-08

## 1. 当前结论

| 项目 | 当前事实 |
|---|---|
| 产品身份 | 独立、完整、持续运营的Chat产品 |
| 主分支 | `main`；远端与本地已同步到PR #7合并提交`06d1177` |
| 前端 | React + TypeScript + Vite；响应式PWA；最小Plan审核与运行投影已接真实后端 |
| 后端 | Node.js + TypeScript；Hono协议入口；Application拥有事务 |
| Product Store | `chat-product-store.v1`版本化JSON快照；单实例、单写者、原子替换、损坏失败关闭 |
| Workflow | 唯一`PlanningExecutionWorkflow`；规划、Hook等待、修订循环、批准、执行、验证、Product Commit在同一运行中完成 |
| Agent Runtime | `pi-agent-core` + `pi-ai` + `pi-coding-agent`；百炼真实`qwen3.7-plus`已验证 |
| 调试与回放 | 固定端口VS Code Compound；严格脱敏Trace；Trace + Product Store多源Replay |
| 代码状态 | P0、P1.1、P1.2、B1和B2均已合入`main` |
| 当前阶段 | 长期上下文与知识复用：Memory、BMAD项目上下文、用户规则集 |
| 当前任务 | 收口旧会话并复核真实参考项目，形成有依赖关系的小任务书后逐项实现 |

## 2. B2已完成的真实证据

1. PR #7已合入`main`，合并提交为`06d1177bdfd0f78bd84430d2eb57513b7638d08c`。
2. 真实Provider门`pnpm test:provider:bailian`通过3/3；使用本地私有配置调用百炼`qwen3.7-plus`，凭据不进入Git、Trace或文档。
3. 真实浏览器E2E`pnpm test:e2e:planning-execution:real`通过：发送消息、Plan v1、刷新恢复、手机布局、要求修订、Plan v2、旧审批409、批准、真实执行、正式Assistant Message、完成后刷新恢复。
4. 真实运行`run_610673cbd1464274a5cc5af5213b22d3`产生2版Plan、2个Decision、4次HTTP 200的真实Provider调用、124条严格Trace事件；Replay发现0个完整性错误。
5. `format`、`lint`、`typecheck`、326项测试、`build`和生产依赖审计全部通过；PR #7的6个CI检查全部通过。
6. 已知非阻断现象：Workflow SDK 4.8按官方`Promise.race`实现Hook与超时时，会在胜出后报告两个未提交sleep operation警告；本次运行、Store、Trace和Replay均正确，后续升级SDK或修改等待策略时重新验证。

## 3. 已冻结决定

1. Product Store是产品事实源；外部Memory服务、Workflow Store、pi Session、Trace和浏览器缓存不能替代产品事实。
2. 浏览器不直接调用Vercel Workflow、pi或外部Memory服务，也不持有Hook Token、Workflow Run ID和pi Session ID。
3. HITL先提交产品Decision，再由后端恢复Workflow Hook。
4. Trace只记录系统路径、关联、状态、版本、耗时、错误和对象引用；正文只保存在对应权威事实源。
5. 新的Memory、项目上下文和规则能力必须通过Port/Adapter隔离外部实现，但不建立没有真实替换价值的万能接口。
6. 每个重要架构决定必须指出真实参考项目证据、Chat场景调整和明确拒绝项，不能只靠经验猜测。
7. 实现任务使用独立Git worktree、`codex/`分支和PR；简单任务不扩大验证，纵向里程碑必须运行真实服务、真实模型和浏览器E2E。
8. 弱服务器只接收开发机或CI构建、测试、校验后的可追溯产物，不在服务器安装依赖、编译或运行测试。

## 4. 当前没有的能力

1. 没有Memory Adapter注册与配置、真实Memory查询/导入节点，也没有Memory来源与采用记录。
2. 没有长期Project/Work/Stage/Status、项目文档清单和版本化Context Package实现。
3. 没有带标签、场景范围、修订和选择证据的用户规则集，也没有规划节点规则注入。
4. 没有Chat有序SSE Cursor Runtime Journal；B2仍使用受控Query轮询。
5. 没有外部副作用Tool、多实例数据库、备份恢复和生产后端部署拓扑。

## 5. 下一阶段的三个用户结果

1. **Memory**：用户能够选择或配置真实Memory后端；Workflow按需查询记忆，或把经过明确选择的信息导入指定后端，并保留来源、后端、请求和结果证据。
2. **项目上下文**：用户用Chat推进项目时，可以恢复当前阶段、状态、目标、决定、阻塞、文档与下一步；结构受BMAD真实方法启发，但允许按项目类型裁剪。
3. **用户规则**：用户可以在统一界面维护带标签和场景范围的个人习惯/要求，也可以让Chat提出维护建议；对话中可主动勾选或按标签筛选，规划时记录最终采用规则及其版本。

详细任务数量、依赖、合同和完成门必须在复核本地参考项目与既有分析后写入任务书，审核前不假装已冻结。

## 6. 安全与开发边界

1. 不提交API Key、Memory服务Token、本地数据库、运行Trace、缓存、构建产物或`.env`。
2. 不把外部Memory记录直接当成Chat长期事实；召回结果先成为有来源的上下文候选，导入动作必须有明确目标与幂等语义。
3. 不让模型直接修改项目阶段、正式规则或文档清单；模型输出先形成候选，再经过确定性校验及必要的用户决定。
4. 不为了三个后续能力建立万能Context Service或插件平台；抽象只覆盖已经验证的真实差异。
5. 不把三个阶段目标放进一个巨大PR，也不把单个DTO拆成没有用户结果的小PR。
