# OPC-OS 自研 Chat 通道

本项目实现OPC-OS Chat体系中的一个自研Chat通道。

`OPC-OS Chat`是包含多种可交互聊天通道、适配层和共享能力的上位系统；本仓库只负责其中一个独立开发、独立运行、独立验证的Web Chat通道。

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

工程骨架已经初始化并完成无密钥纵向验证：

1. FastAPI、MAF和AG-UI SSE端点可运行。
2. React前端通过`HttpAgent`完成了浏览器真实消息回合。
3. 后端3个测试、前端类型检查和生产构建均通过。
4. 已接入`backend/.env`并完成真实模型AG-UI文本回合。
5. 尚未完成模型失败路径、服务端历史恢复和产品领域数据库。
6. 没有迁移旧数据库、历史会话或环境配置。

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

Product资源走REST，单次Agent Run的实时事件走AG-UI；Product DB与MAF运行时状态分开拥有。前端使用自研UI，基础组件采用Tailwind CSS、Radix UI和Lucide React；Zustand只管理页面状态。完整边界见[项目上下文](./PROJECT_CONTEXT.md#71-产品对象协议对象与运行时对象的边界)。

## 环境要求

1. Python `3.12.x`。
2. [`uv`](https://docs.astral.sh/uv/)。
3. Node.js `20.19+`或`22.12+`，推荐Node.js 24。
4. npm `>=10`。

## 本地启动

初始化环境：

```bash
cp .env.example backend/.env
cp frontend/.env.example frontend/.env
uv sync --dev
(cd frontend && npm install)
```

如果`backend/.env`已经存在，只补充缺失项，不要覆盖原有密钥。

终端1，启动后端：

```bash
uv run uvicorn backend.app.main:app --host 127.0.0.1 --port 8030 --reload
```

终端2，启动前端：

```bash
cd frontend
npm run dev
```

打开`http://127.0.0.1:5073`。不配置密钥时会使用确定性Bootstrap Agent，仍会走完整MAF与AG-UI事件链路。

要启用真实模型，在项目自己的`backend/.env`中填写：

```dotenv
ARK_MODEL=your-model
ARK_API_KEY=
ARK_BASE_URL=https://your-openai-compatible-endpoint/v1
```

也可以使用`CHAT_MODEL`、`CHAT_MODEL_API_KEY`和`CHAT_MODEL_BASE_URL`覆盖对应`ARK_*`值。真实密钥不得提交到Git，也不得从旧项目直接复制环境文件。

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

1. Python编译检查。
2. 后端测试。
3. 前端TypeScript检查。
4. 前端生产构建。

## 目录结构

```text
backend/app/      FastAPI配置、MAF Agent与AG-UI端点
backend/tests/    后端合同和事件流测试
frontend/src/    React界面、HttpAgent投影与页面状态
scripts/         可重复执行的工程验证
```

## 文档入口

1. [项目上下文](./PROJECT_CONTEXT.md)：问题、定位、目标、闭环和边界。
2. [项目计划](./PROJECT_PLAN.md)：分阶段路线和完成门。
3. [项目状态](./PROJECT_STATE.md)：当前完成项、待审核项和下一道门。
4. [协作规则](./AGENTS.md)：开发和AI协作必须遵守的规则。
5. [Session持久化研究与方案推导](./docs/session-persistence-research.md)：MAF、pi、nanobot与LibreChat的逐项源码证据、适用边界、方案比较和决策推导。
6. [Session持久化候选设计](./docs/session-persistence-design.md)：建立在研究报告上的候选状态模型、生命周期和待审核决定。
7. [Session持久化审核包](./docs/session-persistence-review.md)：每项决定的原因、参考覆盖、全部选择、优缺点和建议。

## 下一步

Session的MAF、pi、nanobot与LibreChat研究已经完成，候选设计也已按“Product DB权威、AG-UI只做实时协议投影”修订。下一步先审核D1-D6；批准后才创建Schema、迁移、服务端历史恢复、Product Agent Run和基础Trace，同时继续完成真实模型失败、超时与错误脱敏验证及旧项目复用清单。
