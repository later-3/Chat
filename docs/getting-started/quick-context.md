# Chat 0–15 分钟接手

这是一张导航图，不替代[协作规则](../../AGENTS.md)、[当前状态](../../PROJECT_STATE.md)或各
as-built。先用它确定事实Owner和完成门，再按任务继续阅读。

## 0–3 分钟：产品与当前状态

Chat是以对话为入口、由Product Store持有事实、由耐久Workflow推进、由用户在高影响动作前
审核的完整产品。它不是聊天页面、Agent外壳、Workflow Demo，也不是DSH、Pi或外部Provider
的适配器集合。

唯一运行图：

```text
Browser → DSH Web → LifeOS Bridge → Chat Query/Command API
                                  → Application → Product Store
                                                → Outbox → Workflow → Pi Executor
                                                → Product Commit → DSH投影
```

Product事实由Product Store/Application拥有；Checkpoint、Hook和重放由Workflow拥有；Pi
Session、Tool Journal和Provider调用由Pi Runtime拥有；DSH Session和浏览器缓存只属于DSH；
Plane、Git、Memory等外部系统只拥有自己的资源。它们的ID不能互换为产品身份或授权。

已完成：产品后端、Workflow/Agent Runtime、固定DSH派生、LifeOS Bridge、Project Bootstrap和
Capability治理。Workbench实现已完成但仍是Beta，提升为通用发布门已暂停。Memory暂停。当前优先
候选是Browser Provider，但尚未授权实现。不要从阶段计划推导开工授权；涉及真实数据处置前还要
读取[PROJECT_STATE](../../PROJECT_STATE.md)中的最新诊断，接手导航不授予修复权。

## 3–7 分钟：3 条纵向入口

1. 消息/规划/决定/提交：
   [Bridge dispatch](../../packages/dsh-lifeos-bridge/src/bridge-chat-dispatch.ts) →
   [产品路由](../../apps/api/src/product-routes.ts) →
   [Message用例](../../packages/application/src/session-message-use-cases.ts) →
   [Outbox Dispatcher](../../apps/api/src/outbox-dispatcher.ts) →
   [Planning Workflow](../../packages/workflows/src/planning-execution-workflow.ts) →
   [Pi Agent Runner](../../packages/pi-runtime/src/agent-runner.ts)。
2. Project Bootstrap：
   [Bridge Service专用入口/决定](../../packages/dsh-lifeos-bridge/src/bridge-service.ts) →
   [Bootstrap Message dispatch](../../packages/dsh-lifeos-bridge/src/bridge-chat-dispatch.ts) →
   [Application用例](../../packages/application/src/project-bootstrap-use-cases.ts) →
   [Project Adapter](../../packages/project-runtime/src/plane-ce-bootstrap.ts)。
3. 启动与恢复：
   [统一启动器](../../scripts/dev/start.mjs) →
   [服务图与Supervisor](../../scripts/dev/app-runtime.mjs) →
   [API组合根](../../apps/api/src/composition.ts) →
   [Workflow Runtime](../../packages/workflows/src/runtime-main.ts) →
   [Pi Executor入口](../../apps/pi-executor/src/index.ts)。

目录责任看[仓库地图](../architecture/repository-map.md)，每个Workspace先读本目录README。

## 7–10 分钟：开工与安全边界

1. 先确认用户授权、明确用户结果/不做事项/事实Owner/完成门。
2. 从用户指定基线或当前`main`建立独立worktree和`codex/`分支，保留所有既有改动。
3. 产品语义以Schema、状态机、Application和当前as-built为准；冲突时停止报告。
4. 普通变更先跑受影响包；跨层变更跑根级门。一个问题形成一条清晰本地提交。
5. 未明确授权时不得push、建PR、部署、改仓库设置、迁移真实数据或调用外部写。

付费测试只能走名称含`:paid`的命令，并同时设置`CHAT_ALLOW_PAID_TESTS=1`和精确Provider
凭据。真实Plane/Memory等外部写只能走`:external:`命令，同时设置全局和服务专用开关。
普通CI与`verify:core`统一去凭据。详见[测试lane](../testing/test-lanes.md)。

## 10–12 分钟：最安全的首个验证

```bash
pnpm managed-sources:verify
pnpm test:core
```

第一条不下载、不调用Provider，验证已准备的Pi/DSH来源、commit、marker、许可证与4个链接；
如果上次Build Input staging被中断，它还会按事务记录恢复Fork中的原文件，因此不是绝对零写入。
第二条使用去凭据环境和默认Node Heap，并写入被Git忽略的lane度量。全新克隆先按
[本地安装](./local-install.md)执行`pnpm managed-sources:prepare`。

## 12–15 分钟：失败定位与继续阅读

| 现象 | 先看 | 下一步 |
| --- | --- | --- |
| Fork origin/HEAD/dirty/marker/link漂移 | `config/managed-sources.json`与`pnpm managed-sources:verify` | 不改稳定Fork；核对受管checkout和Manifest |
| 端口或旧进程冲突 | `pnpm dev:status`、[本地调试](../debug/local-debug.md) | 不用`pkill`；按实例Owner停止 |
| Store/Workflow恢复失败 | [系统边界](../architecture/system-boundaries.md)、对应compat测试 | 先识别Product/Workflow/Pi事实Owner |
| Bridge页面与后端不一致 | [前后端交互](../architecture/frontend-backend-interaction.md) | 分查DSH Session、Product Query和Bridge State |
| lane漏测或OOM | `pnpm test:ci-baseline`、[测试lane](../testing/test-lanes.md) | 修Manifest/批次，不设置全局8 GiB Heap |
| Provider/外部门拒绝 | 命令名与安全门报错 | 未获授权不要补开关或读取Key |

按任务继续：产品边界读[技术合同](../architecture/technology-contract.md)；会话/轨迹读
[Session架构](../architecture/session-architecture.md)；Agent与Capability读
[Agent管理](../architecture/agent-management-as-built.md)和
[Capability治理](../architecture/capability-governance-as-built.md)；Workflow读
[运行设计](../architecture/runtime-workflows.md)；当前完成/暂停/候选只认
[PROJECT_STATE](../../PROJECT_STATE.md)。

完成门：行为与合同测试、中文导航/as-built同步；代码纵向最终跑`pnpm verify:core`、
`pnpm test:all:deterministic`及适用的`pnpm test:browser`，并报告实际运行与未运行项。paid、
external、Hosted CI、push、PR和部署不会因为本地门通过而自动获得授权。
