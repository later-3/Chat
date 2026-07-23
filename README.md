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

## 当前状态

工程骨架、真实模型纵向回合和逐次模型调用审批切片已经完成：

1. FastAPI、MAF和AG-UI SSE端点可运行。
2. React前端通过`HttpAgent`完成了浏览器真实消息回合。
3. 后端自动测试、前端类型检查和生产构建已建立为一键验证。
4. 后端以私有`backend/config.json`配置火山方舟和阿里云百炼，前端按Provider联动选择模型；真实模型AG-UI文本回合已通过。
5. Product Session Phase 1文本底座已完成：SQLite/Alembic、Session/Message/Interaction/Run/Attempt、REST恢复、服务端唯一历史、失败收敛和成功终态门。
6. 前端可创建、打开、重命名、归档和配置Session默认Provider/模型，并展示Run/Attempt摘要；没有迁移旧数据库或历史会话。
7. 前端可查看嵌套Workflow实时/恢复进度，并配置`planner`与`reviewer`两个Agent的名称、职责、Instructions及Provider/模型。
8. 受治理双Agent Workflow已跑通：规划Agent、确定性交接、审校Agent共3个节点；两次真实Provider调用分别审批，第2次能查看和修改原始目标、规划结果及交接要求。
9. pi coding agent已作为真实MAF FunctionTool接入：使用官方JSONL RPC，每次模型请求和内部Tool调用分别审批，支持Tool配置、参数改写、Token/耗时/调用统计和启动中断收敛。
10. 持续协作主Workflow已经支持Product DB持久Checkpoint、Interrupt Link和Lease Outbox Worker；实际独立OS进程可从一次已提交决定恢复到下一审批安全点。该保证暂不外推到嵌套Workflow或外部Tool副作用。
11. ExecutionDraft已有17部分完整可读编辑工作台；保存产生新revision与Hash，必须重新审批后才能编译不可变RunSpec。
12. Product Harness D1-D8已经落地：Project、Work、Plan/Action、Note、Memory与两阶段Context使用服务端权威Schema、CAS、幂等命令、Trace和Outbox；前端提供Project Explorer、Work Board、Knowledge和Context Inspector。
13. 持续协作主Workflow现有25个真实MAF节点；真实模型已验证意图、响应、回合摘要3次逐次审批，简单问答不会创建Project、Work、Note或Memory。
14. 完整Session仍按Phase 2-8继续：活动流游标重连、通用Execution Worker、Tool副作用对账和跨入口恢复尚未完成。
15. Chat概念空间已经建立：11个概念簇统一Session、Workflow、Agent/Executor、恢复动作、模型审批、Tool、上下文结果、界面、外部入口和人工介入策略的共同语言。

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
(cd frontend && npm install)
```

`backend/config.json`是唯一后端运行配置源，包含密钥，因此已被Git忽略；不要把它的内容复制到文档、日志或提交中。

耐久Product Store在后端启动时自动执行`alembic upgrade head`。需要单独检查迁移或执行回滚演练时使用：

```bash
.venv/bin/python -m alembic check
.venv/bin/python -m alembic upgrade head
```

终端1，启动后端：

```bash
.venv/bin/python -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8030 --reload
```

终端2，启动前端：

```bash
cd frontend
npm run dev
```

打开`http://127.0.0.1:5073`。没有任何配置完整且启用的Provider时，会使用确定性Bootstrap Agent，仍走完整MAF与AG-UI事件链路。

## 后端JSON配置

[配置示例](./backend/config.example.json)默认包含2个Provider：`ark`（火山方舟）和`dashscope`（阿里云百炼）。每个Provider按同一结构维护：

1. `id`是稳定且唯一的内部标识，`label`是前端显示名称。
2. `protocol`当前支持`openai_responses`和`openai_chat_completions`；前者发送`instructions + input`到`/responses`，后者发送`messages`到`/chat/completions`。只提供其他私有协议的Provider仍需新增Transport适配器，不能只加配置。
3. `base_url`和`api_key`只留在服务端私有配置中。
4. `default_model`必须出现在该Provider的`models`数组中。
5. `models`中的每一项包含不可重复的`id`和用户可读的`label`。
6. `enabled`为`false`时，该Provider不会成为运行路由，也不会出现在前端目录中。

新增模型时，向对应Provider的`models`数组追加一项；需要把它设为默认模型时，同时修改`default_model`。新增Provider时，复制一个完整Provider对象，修改其`id`、显示名、地址、密钥和模型列表。修改后重启后端，前端便会按新目录联动展示；当前不调用Provider的在线模型发现接口。

审批页只展示服务端确认可用的Provider及其模型，服务端在保存和发送前再次校验组合。`api_key`和`base_url`不会进入浏览器返回值。

## VS Code调试

打开项目目录后，可以直接选择：

1. `Chat Backend (MAF + FastAPI)`：后端`127.0.0.1:8030`。
2. `Chat Frontend (React + Vite)`：前端`127.0.0.1:5073`。
3. `Chat Full Stack`：同时启动前后端。

每个配置在启动前和停止后都会调用`scripts/cleanup-dev.sh`：

1. 清理对应端口上的监听进程。
2. 清理命令行中明确属于当前项目的遗留Uvicorn、debugpy或Vite进程。
3. 先发送`TERM`，最多等待1秒，仅对仍存活的已解析PID发送`KILL`。

清理目标严格限定为端口`8030`、`5073`和当前项目路径，不使用宽泛的Python、Node或OPC-OS进程名匹配。

## 一键验证

```bash
./scripts/verify.sh
```

该命令依次执行：

1. 概念空间结构与链接检查。
2. Python编译检查。
3. 后端测试。
4. 前端逻辑测试与TypeScript检查。
5. 前端生产构建。

## 目录结构

```text
backend/app/      FastAPI配置、MAF Agent与AG-UI端点
backend/tests/    后端合同和事件流测试
frontend/src/    React界面、HttpAgent投影与页面状态
scripts/         可重复执行的工程验证
概念空间/       Chat概念治理、索引、概念簇和结构校验
```

## 文档入口

1. [项目上下文](./PROJECT_CONTEXT.md)：问题、定位、目标、闭环和边界。
2. [项目经验与反例](./PROJECT_LESSONS.md)：每次项目回复前必读的错误案例和强制检查。
3. [项目计划](./PROJECT_PLAN.md)：工作流、依赖、分阶段路线和完成门。
4. [项目状态](./PROJECT_STATE.md)：当前完成项、待审核项和下一道门。
5. [协作规则](./AGENTS.md)：开发和AI协作必须遵守的规则。
6. [概念空间方法来源](./概念空间.md)与[Chat概念资产索引](./概念空间/00-索引.md)：共同语言方法、11个概念簇、边界、别名、正反例和实现状态入口。
7. [总体架构研究与证据](./docs/overall-architecture-research.md)：完整场景推导、MAF、pi、nanobot、QwenPaw与LibreChat证据、覆盖缺口和方案比较。
8. [总体架构候选](./docs/overall-architecture-proposal.md)：由pi、nanobot、QwenPaw和LibreChat源码结构推导出的Web/Channel适配、Interaction Ingress、10个产品与应用模块、运行适配器、状态所有权、场景穿透和交付依赖。
9. [架构新手导读](./docs/architecture-beginner-guide.md)：从用户点击“发送/批准”开始，串起前端、协议、后端数据库、Agent Session/Tool、Provider请求、响应解析、产品提交和React渲染，并对照当前代码与目标架构。
10. [Session能力全集与目标边界](./docs/session-capability-catalog.md)：9个能力域、74项能力、R0-R6恢复层级、参考覆盖、明确非目标和最终用户场景。
11. [Session分阶段交付路线](./docs/session-delivery-roadmap.md)：Phase 0-8、53个任务、优先级、依赖、方案、目标和各阶段完成场景。
12. [Session持久化研究与方案推导](./docs/session-persistence-research.md)：MAF、pi、nanobot与LibreChat的逐项源码证据、适用边界、方案比较和决策推导。
13. [Session持久化设计](./docs/session-persistence-design.md)：Phase 1文本持久化设计、代码落点与审批Workflow适配。
14. [Session持久化审核包](./docs/session-persistence-review.md)：已批准D1-D6的原因、参考覆盖、选项、实现适配和边界。
15. [pi Agent Tool使用与运行手册](./docs/pi-agent-tool.md)：JSONL RPC选型、两道审批门、配置、监控、恢复语义和验证方法。
16. [Workflow恢复与Outbox Worker运行说明](./docs/runtime-recovery-operations.md)：单/双进程部署、日志、重试、死信和升级门。
17. [Product Harness、Work与Memory详细设计](./docs/product-harness-detailed-design.md)：已批准D1-D8、状态机、Agent工具、两阶段Context和长跨度场景验收基线。

## 下一步

下一步进入Session活动流游标与通用Execution Worker详细设计，并继续独立Evidence/Provenance与Tool副作用对账；不能把Governance Outbox和主Workflow安全点恢复外推为完整R5/R6。
