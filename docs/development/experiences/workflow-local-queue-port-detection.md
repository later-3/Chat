# Nitro dev 多监听端口导致 Workflow 本地队列消息悬挂

## 现象与影响

2026-09-02 部署验证时，`pnpm verify` 在最后一步 `pnpm test:dev` 稳定失败：`POST /runs` 返回 202 且日志出现 `[workflow] accepted`，但 Workflow Run 永远停在 `pending`，没有任何 Step 事件，`waitForReview` 15 秒超时后断言失败。偶发的首次运行能看到一次 `[world-local] Queue message failed (HTTP 500)`，之后完全静默——队列消息既没送达也没有错误日志，排查时容易被误判为 Workflow 步骤或 Pi Agent 装配故障。

## 直接根因

`@workflow/world-local` 的队列按以下顺序解析回调节点地址：`WORKFLOW_LOCAL_BASE_URL` → `config.port` → `PORT` 环境变量 → `getWorkflowPort()` 自动探测。自动探测通过 `process.report`/lsof 枚举**本进程所有监听端口**，再对每个端口 HEAD 探测 `/.well-known/workflow/v1/flow?__health`；探测全部失败（超时仅 500ms）时回退到端口列表第一项。

`nitro dev` 进程除了主 HTTP 端口外，还监听一个内部 watcher/IPC 端口（该端口接受 TCP 连接但不回应 HTTP）。当探测发生在服务器繁忙（rolldown 构建中）时，健康探测超时，队列回退到错误的 watcher 端口，`fetch` 永久悬挂：没有重试、没有错误日志、Run 永远 `pending`。

生产（`PORT=43110`）和 `pnpm dev`（`PORT=43112`）都显式设置了 `PORT`，只有 `scripts/dev-server.test.mjs` 使用随机保留端口且未设置任何地址变量，因此只有它命中这条失效路径。

## 为什么原验证没有发现

该测试引入时 `nitro dev` 可能只有一个监听端口（`ports.length === 1` 时直接返回不探测），或探测时序恰好总能命中主端口。依赖升级引入第二个监听端口后，探测从"唯一端口直选"退化为"探测 + 失败回退"，故障才暴露。这类问题在单元测试中不可见，只有真实启动 `nitro dev` 并走完队列回调才能发现。

## 正确姿势

1. 任何用随机端口启动 Workflow Runtime 的测试或脚本，必须显式设置 `WORKFLOW_LOCAL_BASE_URL`（或 `PORT`）指向该端口，不依赖自动探测。
2. 本次回归门禁：`scripts/dev-server.test.mjs` 在 spawn 环境中固定 `WORKFLOW_LOCAL_BASE_URL: baseUrl`。
3. 排查"Run 停在 pending 且无日志"时，先查 world-local 队列的地址解析与投递，再怀疑 Step 或 Agent 装配；持久化数据目录中的 `runs/*.json` 和 `events/*.json` 能区分"从未投递"（只有 `run_created`）和"Step 失败"。
4. 队列 HTTP 500 与消息悬挂是两种不同故障：前者说明送达了但 Handler 崩溃，后者说明地址解析错误。不要根据一次 500 就断定根因在 Workflow 代码。
