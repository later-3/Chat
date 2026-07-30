# Chat

Chat 是一个独立开发、独立运行、独立运营并持续演进的 AI 协作产品。它以 Web 对话为主要入口，自己承担会话、上下文、工作、受控执行、恢复、知识、证据、交付和治理的完整产品责任。

Chat Web通过自己的REST/AG-UI Adapter访问后端；Telegram等终端平台必须经过具体Channel Adapter，OPC-OS Chat必须经过独立Bridge Adapter，再统一进入内部Interaction Ingress。外部集成不改变本项目的产品身份，也不产生第二个产品事实源。

## 项目目标

通过自然语言对话形成连续、可审核、可执行、可恢复的AI协作闭环：

```text
对话
-> 上下文与意图
-> 计划与人/AI行动
-> 执行前审核
-> Agent或Runtime执行
-> 结果、证据与Trace
-> 工作和记忆更新
```

核心价值包括：

1. 会话连续。
2. 意图可见。
3. 工作可推进。
4. 执行可控制。
5. 状态可恢复。
6. 事实可追溯。

对用户而言，Chat不是“记住更多聊天”，而是一个持续管理和推进个人学习、工作与想法的统一入口：想法能留下，事项有状态，隔天能继续，执行可看护，结果有证据。Project、Work、Plan、Note、Memory、规则和资源共同构成Product Harness；输入区的上下文选择界面只是这些既有信息的友好投影，不复制第二套知识源。

对独立运营而言，Chat还必须提供受严格授权和审计的超级管理员看护：可信回答谁登录、怎样使用、Project/Work和Artifact/Evidence推进到哪里，以及哪些用户、作品或运行需要关注。它与普通用户个人主页、Workflow执行看护和开发运维可观测性是3种不同视角。

## 当前状态

工程骨架、真实模型纵向回合和逐次模型调用审批切片已经完成：

1. FastAPI、MAF和AG-UI SSE端点可运行。
2. React前端通过`HttpAgent`完成了浏览器真实消息回合。
3. Ruff、Pyright、Biome、覆盖率、迁移升降、后端自动测试、前端类型检查和生产构建已建立为本地与CI质量门。
4. 后端以私有`backend/config.json`配置火山方舟和阿里云百炼，前端按Provider联动选择模型；真实模型AG-UI文本回合已通过。
5. Product Session Phase 1文本底座已完成：SQLite/Alembic、Session/Message/Interaction/Run/Attempt、REST恢复、服务端唯一历史、失败收敛和成功终态门。
6. 前端可创建、打开、重命名、归档和配置Session默认Provider/模型，并展示Run/Attempt摘要；没有迁移旧数据库或历史会话。
7. 前端可查看嵌套Workflow实时/恢复进度，并配置`planner`与`reviewer`两个Agent的名称、职责、Instructions及Provider/模型。
8. 受治理双Agent Workflow已跑通：规划Agent、确定性交接、审校Agent共3个节点；两次真实Provider调用分别审批，第2次能查看和修改原始目标、规划结果及交接要求。
9. pi coding agent已作为真实MAF FunctionTool接入：使用官方JSONL RPC，每次模型请求和内部Tool调用分别审批，支持Tool配置、参数改写、Token/耗时/调用统计和启动中断收敛。
10. 持续协作主Workflow已经支持Product DB持久Checkpoint、Interrupt Link和Lease Outbox Worker；实际独立OS进程可从一次已提交决定恢复到下一审批安全点。该保证暂不外推到嵌套Workflow或外部Tool副作用。
11. ExecutionDraft已有17部分完整可读编辑工作台；保存产生新revision与Hash，必须重新审批后才能编译不可变RunSpec。
12. Product Harness D1-D8已经落地：Project、Work、Plan/Action、Note、Memory与两阶段Context使用服务端权威Schema、CAS、幂等命令、Trace和Outbox；前端提供Project Explorer、Work Board、Knowledge和Context Inspector。
13. 持续协作主Workflow v1.8.0现有39个真实MAF节点；除7套协作协议、不可变Context revision、Repository Source Freshness、TurnDigest v1、StepInputProjection和持久Intent Set外，已根据批准的RunSpec在`answer_only`、受治理pi只读执行与隔离工作区精确编辑间显式路由，并接入Result Claim准备与提交决定。SD3已实现受管Git worktree和`ToolOperation/Attempt/Reconciliation`，只开放`read/grep/find/ls/edit`，不直接修改活动仓库，也不开放Shell、commit或push。
14. Runtime Job、活动流游标和通用Execution Worker纵向切片已经完成；完整Session仍按Phase 2-8继续补齐Steer/Follow-up、分支、强退/多端矩阵、Tool副作用对账和跨入口恢复。
15. Chat概念空间已经建立：14个概念簇统一Chat系统/Harness、Session、Workflow、Agent/Executor、恢复动作、模型审批、Tool、上下文结果、界面、外部入口、人工介入、连续协作和超级管理员运营看护的共同语言。
16. Q0工程安全底座已有可运行纵向基线：Governance/Harness已按纯规则、只读查询、命令记录和事务协调继续拆分；Agent重连Hook、Workflow运行投影和对话呈现已有独立Feature边界；8个重型前端Feature按需加载，当前主入口为473.22 KiB并受自动包体门保护。统一Problem Detail、关联日志/Trace/Metrics/诊断、CI、覆盖率、迁移、Playwright/axe、故障实验室和供应链门均通过本地验证；大型Application Service、持续协作Workflow、生产Exporter/SLO和远端CI首次运行仍在后续范围。
17. Super Admin Operations目标已经确认：Identity负责真实Authentication Session和Role/Grant，运营模块负责Activity/Usage、可重建工作/作品投影与管理员审计；当前尚未实现真实登录、活动采集、管理API或控制台，固定`local-user`和技术耗时不能冒充该能力。

## 技术方向

已批准的技术路线：

```text
React 19 + TypeScript + Vite
├── REST -> Product API -> Product DB
└── @ag-ui/client / HttpAgent
    -> AG-UI（HTTP + SSE）
    -> FastAPI AG-UI Endpoint
    -> Microsoft Agent Framework
    -> Agent / Workflow / Tool / Model
```

Product资源走REST，单次Agent Run的实时事件走AG-UI；Product DB与MAF运行时状态分开拥有。前端使用自研UI，基础组件采用Tailwind CSS、Radix UI和Lucide React；Zustand只管理页面状态。完整边界见[项目上下文](./PROJECT_CONTEXT.md#71-四个必须区分的对象)。

## 环境要求

1. Python `3.12.x`，由`uv`安装并放入项目专用虚拟环境；不使用系统Python。
2. [`uv`](https://docs.astral.sh/uv/)，依赖以`uv.lock`为准。
3. Node.js `20.19+`或`22.12+`，推荐Node.js 24。
4. npm `>=10`。

## 本地启动

初始化环境：

```bash
cp backend/config.example.json backend/config.json
cp frontend/.env.example frontend/.env
uv python install 3.12
uv venv --python 3.12 .venv
UV_PROJECT_ENVIRONMENT=.venv uv sync --frozen --dev
(cd frontend && npm ci)
(cd frontend && npx playwright install chromium)
```

`backend/config.json`是唯一后端运行配置源，包含密钥，因此已被Git忽略；不要把它的内容复制到文档、日志或提交中。

耐久Product Store在后端启动时自动执行`alembic upgrade head`。需要单独检查迁移或执行回滚演练时使用：

```bash
.venv/bin/python -m alembic check
.venv/bin/python -m alembic upgrade head
```

终端1，启动后端：

```bash
.venv/bin/python -m uvicorn backend.app.asgi:app --host 127.0.0.1 --port 18030 --reload
```

终端2，启动前端：

```bash
cd frontend
npm run dev
```

打开`http://127.0.0.1:15073`。没有任何配置完整且启用的Provider时，会使用确定性Bootstrap Agent，仍走完整MAF与AG-UI事件链路。

## 手机公网访问

当前已建立经用户批准的公网IP + HTTP验证链路：

```text
http://121.43.113.236/chat/
```

该入口提供与桌面相同的对话、Workflow、Project/Work/Knowledge资源和配置能力，
并继续经过原有Product Session、MAF Workflow、AG-UI、HITL和Product Store。
访问账号为`later`，密码只保存在被Git忽略的
`backend/.data/deployment/chat-http-access-password`。

安装本地常驻后端与反向SSH、发布Web版本、验收或停止链路分别使用：

```bash
scripts/install-mobile-relay.sh
scripts/deploy-mobile-web.sh
scripts/verify-mobile-relay.sh
scripts/uninstall-mobile-relay.sh
```

公网HTTP不加密聊天或口令，也不能注册标准PWA Service Worker；当前Basic Auth只是
验证阶段的边缘访问门，不是正式Product身份系统。拓扑、安全边界、故障语义和回滚见
[手机公网访问与云端中转运行手册](./docs/mobile-cloud-relay.md)。

## 后端JSON配置

[配置示例](./backend/config.example.json)默认包含3个Provider：`ark`（火山方舟）、`dashscope`（阿里云百炼）和`kimi-code`（Kimi Code）。每个Provider按同一结构维护：

1. `id`是稳定且唯一的内部标识，`label`是前端显示名称。
2. `protocol`当前支持`openai_responses`和`openai_chat_completions`；前者发送`instructions + input`到`/responses`，后者发送`messages`到`/chat/completions`。只提供其他私有协议的Provider仍需新增Transport适配器，不能只加配置。
3. `base_url`和`api_key`只留在服务端私有配置中。
4. `default_model`必须出现在该Provider的`models`数组中。
5. `models`中的每一项包含不可重复的`id`和用户可读的`label`；可选的`context_window`、`reasoning`和`thinking_level_map`用于把真实模型能力投影给pi等Runtime。
6. `enabled`为`false`时，该Provider不会成为运行路由，也不会出现在前端目录中。

新增模型时，向对应Provider的`models`数组追加一项；需要把它设为默认模型时，同时修改`default_model`。新增Provider时，复制一个完整Provider对象，修改其`id`、显示名、地址、密钥和模型列表。修改后重启后端，前端便会按新目录联动展示；当前不调用Provider的在线模型发现接口。

审批页只展示服务端确认可用的Provider及其模型，服务端在保存和发送前再次校验组合。`api_key`和`base_url`不会进入浏览器返回值。

## VS Code调试

打开项目目录后，可以直接选择：

1. `Chat Backend (MAF + FastAPI)`：后端`127.0.0.1:18030`。
2. `Chat Frontend (React + Vite)`：前端`127.0.0.1:15073`。
3. `Chat Full Stack`：同时启动前后端。
4. `Chat Distributed Stack`：API、Execution Worker、Outbox Worker和前端4个独立调试进程。

每个配置在启动前和停止后都会调用`scripts/cleanup-dev.sh`：

1. 清理对应端口上的监听进程。
2. 清理命令行中明确属于当前项目的遗留Uvicorn、debugpy或Vite进程。
3. 先发送`TERM`，最多等待1秒，仅对仍存活的已解析PID发送`KILL`。

清理目标严格限定为端口`18030`、`15073`和当前项目路径，不使用宽泛的Python、Node或OPC-OS进程名匹配。

运行诊断入口不会输出消息、Prompt、Provider Payload或Checkpoint正文：

```bash
.venv/bin/python -m backend.app.diagnostics_cli
.venv/bin/python -m backend.app.diagnostics_cli --run-id <product-run-id>
```

HTTP探针分别为`/api/live`（进程存活）、`/api/ready`（Product Store可用）、`/api/diagnostics/operations`（Job/Outbox/Worker积压）和`/api/diagnostics/metrics`（进程内计数与耗时）。

## 一键验证

快速反馈和完整验证分别使用：

```bash
./scripts/verify-fast.sh
./scripts/verify-fault-lab.sh
./scripts/verify.sh
```

快速门执行概念与密钥检查、格式、Lint、类型、编译、后端测试和前端逻辑测试。完整门在此基础上还执行：

1. 后端分支覆盖率门和机器可读`coverage.xml`。
2. 在临时SQLite数据库上执行Alembic`upgrade -> check -> downgrade base -> upgrade`，不接触私有Product Store。
3. 前端生产构建、Vite manifest包体/按需Feature回归、桌面/窄屏Playwright真实浏览器回合和axe可访问性检查。

故障实验室单独运行10项高风险并发、Checkpoint/HITL、Runtime Cursor和长跨度Harness场景，并把JUnit证据写入`.artifacts/fault-lab.xml`。

GitHub Actions使用Python 3.12、Node 22、`uv.lock`和`package-lock.json`运行同一完整门。普通质量门不读取`backend/config.json`，也不发起真实模型调用。

依赖漏洞和许可证门需要联网查询漏洞库，因此与离线可重复的功能验证分开：

```bash
./scripts/verify-supply-chain.sh
```

## 目录结构

```text
backend/app/      组合根、FastAPI边界、产品服务、MAF Workflow与运行适配
backend/tests/    后端合同和事件流测试
frontend/src/    React界面、Feature API、HttpAgent投影与页面状态
scripts/         可重复执行的工程验证
概念空间/       Chat概念治理、索引、概念簇和结构校验
项目掌握/       面向Later的总地图、专题、调试实验和掌握验收
```

## 文档入口

如果目标是从小白开始掌握当前设计、源码、数据库和调试路径，先进入
[项目掌握知识库](./项目掌握/INDEX.md)。它以一条真实Product Run为主线，按“具体场景 -> 对象样本 ->
代码链 -> 断点/SQL/Trace -> 掌握验收”组织；下面的治理、设计和状态文档继续作为权威事实来源。
只有少量C/C++基础时，第一篇读[从C++到Chat：前后端怎样跑起来](./项目掌握/00-从这里开始/从C++到Chat前后端怎样跑起来.md)：它把TypeScript/React、Python/FastAPI、进程、端口、HTTP/JSON/SSE和当前启动配置落到真实文件与30分钟实验。

1. [项目上下文](./PROJECT_CONTEXT.md)：问题、定位、目标、闭环和边界。
2. [项目经验与反例](./PROJECT_LESSONS.md)：每次项目回复前必读的错误案例和强制检查。
3. [项目计划](./PROJECT_PLAN.md)：工作流、依赖、分阶段路线和完成门。
4. [项目状态](./PROJECT_STATE.md)：当前完成项、待审核项和下一道门。
5. [协作规则](./AGENTS.md)：开发和AI协作必须遵守的规则。
6. [概念空间方法来源](./概念空间.md)与[Chat概念资产索引](./概念空间/00-索引.md)：共同语言方法、14个概念簇、边界、别名、正反例和实现状态入口。
7. [总体架构研究与证据](./docs/overall-architecture-research.md)：完整场景推导、MAF、pi、nanobot、QwenPaw与LibreChat证据、覆盖缺口和方案比较。
8. [总体架构基线](./docs/overall-architecture-proposal.md)：先由本项目9类完整用户场景、失败/安全风险和产品保证推导Web/Channel适配、Interaction Ingress与11个产品模块，再用MAF、pi、nanobot、QwenPaw和LibreChat源码校准运行适配、状态所有权、恢复和工程取舍。
9. [架构新手导读](./docs/architecture-beginner-guide.md)：从用户点击“发送/批准”开始，串起前端、协议、后端数据库、Agent Session/Tool、Provider请求、响应解析、产品提交和React渲染，并对照当前代码与目标架构。
10. [Session能力全集与目标边界](./docs/session-capability-catalog.md)：9个能力域、74项能力、R0-R6恢复层级、参考覆盖、明确非目标和最终用户场景。
11. [Session分阶段交付路线](./docs/session-delivery-roadmap.md)：Phase 0-8、53个任务、优先级、依赖、方案、目标和各阶段完成场景。
12. [Session持久化研究与方案推导](./docs/session-persistence-research.md)：MAF、pi、nanobot与LibreChat的逐项源码证据、适用边界、方案比较和决策推导。
13. [Session持久化设计](./docs/session-persistence-design.md)：Phase 1文本持久化设计、代码落点与审批Workflow适配。
14. [Session持久化审核包](./docs/session-persistence-review.md)：已批准D1-D6的原因、参考覆盖、选项、实现适配和边界。
15. [pi Agent Tool使用与运行手册](./docs/pi-agent-tool.md)：JSONL RPC选型、两道审批门、Provider/模型切换、Kimi K3 API映射、参数、监控、恢复语义和验证方法；pi接K3与Kimi Code CLI开发工具严格分开。
16. [Workflow恢复与Outbox Worker运行说明](./docs/runtime-recovery-operations.md)：单/双进程部署、日志、重试、死信和升级门。
17. [Product Harness、Work与Memory详细设计](./docs/product-harness-detailed-design.md)：已批准D1-D8、状态机、Agent工具、两阶段Context和长跨度场景验收基线。
18. [产品级工程审计](./docs/product-engineering-audit-2026-07-23.md)：代码结构、质量门、API合同、日志、调试、测试、文档和参考项目对照。
19. [产品能力与工程质量Todo](./docs/product-engineering-backlog.md)：17项Todo的用户场景、目标、方案级做法、验证和完成门。
20. [工程质量门与故障实验室](./docs/quality-gates.md)：快速门、完整门、覆盖率、浏览器和高风险故障矩阵。
21. [关键依赖升级手册](./docs/dependency-upgrade-runbook.md)：MAF、AG-UI、pi和Provider脆弱接合、升级步骤与回退门。
22. [应用组合根ADR](./docs/adr/0001-application-composition-and-process-entrypoints.md)与[可观测性ADR](./docs/adr/0002-observability-and-sensitive-data-boundary.md)：当前工程边界的原因、不变量和验证。
23. [工程编码与模块设计规范](./docs/engineering-standards.md)：适度模块规则、事务所有权、注释/日志边界、有界Context、步骤级执行工作包、规模审查与场景驱动完成门。
24. [Chat愿景方案与完整场景模拟验证](./docs/chat-vision-scenario-validation.md)：已获方向审核的协作协议、执行层输入、用户看护、12个端到端场景、24个异常场景和分阶段测试矩阵。
25. [Chat系统分阶段实现基线](./docs/chat-system-implementation-roadmap.md)：Chat Harness、MAF AI Runtime、执行层、前端边界以及阶段A-F的交付与验证门。
26. [Chat持续协作系统研究与落地推导](./docs/chat-collaboration-system-research.md)：项目/任务/学习/笔记方法，MAF与参考项目源码事实，摘要、检索、SQLite和协议落地取舍。
27. [类LifeOS产品方法与Chat Harness启发研究](./docs/lifeos-product-method-research.md)：Obsidian、Notion及跨平台LifeOS类产品的运行协议、设计原因、呈现、维护成本和Chat候选启发。
28. [Kimi Code CLI开发工具手册](./docs/kimi-code-cli-tool.md)：已验证版本、个人Codex Skill、只读调用、交互式修改和未来ACP产品接入边界。
29. [Chat开发Chat自举详细设计](./docs/chat-self-development-design.md)：第一性原理、19个用户场景、架构/模块/接口、8层测试、8个端到端场景、SD0-SD6路线、自检修正，以及已批准的D1-D9与SD1交付状态。

## 下一步

SD1、SD2、SD3以及F02的SD4-A/SD4-B/SD4-C已经落地；真实Qwen隔离写入、内容寻址Artifact Store、
确定性Validation Runtime和主Workflow Result Commit链均有纵向证据。当前F02仍需完成SD4-D失效传播
与SD4-E完整Evidence UI/Dogfood；在F05前不承诺pi跨进程续跑。`write/bash/commit/push`仍未开放；
当前私有部署还需配置Artifact scope密钥才会启用真实Artifact写入。Super Admin Operations、长期
`TaskPlanRevision`、独立Branch Execution和完整Conversation Day继续保留在已批准路线中。
