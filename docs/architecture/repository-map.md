# Chat 仓库目录与关键文件地图

> 文档类型：当前实现（as-built）导航
>
> 核对基线：`main` @ `47a12be`
>
> 当前能力事实以根目录[PROJECT_STATE.md](../../PROJECT_STATE.md)为准；目标架构以[技术合同](./technology-contract.md)为准。

## 1. 这份文档解决什么问题

这份文档回答三个问题：

1. 一个目录或包负责什么。
2. 一项行为从哪个入口开始，应该去哪些文件继续阅读。
3. 哪些目录是产品源码，哪些只是测试、生成物或本地私有数据。

它不逐行解释所有源码，也不复制字段级 Schema。字段合同由 `packages/contracts` 和对应测试拥有；具体业务状态以代码、测试和 `PROJECT_STATE.md` 为准。

## 2. 顶层目录

```text
Chat/
├── apps/
│   ├── web/                    React、PWA、公开API客户端和服务端状态投影
│   └── api/                    Hono入口、组合根、公开/私有路由和Outbox分发
├── packages/
│   ├── contracts/              网络合同、持久化Schema、ID、错误和Trace事件
│   ├── domain/                 纯领域规则、状态机、Hash和不变量
│   ├── application/            用例、事务边界以及外部能力Port
│   ├── product-store-json/     当前JSON Product Store Adapter及迁移
│   ├── workflows/              两套Vercel Workflow与本地Runtime
│   ├── pi-runtime/             pi Planner/Executor与百炼Provider适配
│   ├── memory-runtime/         memmy与Tencent MemoryCore Adapter/Registry
│   ├── realtime/               当前Trace与Replay；未来承接Runtime Journal/SSE
│   └── testing/                跨包架构、集成、恢复和调试合同测试
├── scripts/
│   ├── dev/                    Chat应用服务图、健康门、日志汇总和生命周期监督
│   ├── debug/                  固定端口、进程登记和低层安全清理
│   ├── e2e/                    真实浏览器/真实模型场景编排
│   └── memory/                 两个固定Memory参考服务及真实HTTP验证
├── docs/                       产品、架构、任务、调试、部署和设计文档
├── diagram/                    已提交的架构图导出物
├── .vscode/                    调用仓库启动器的单一应用级F5入口
├── .github/workflows/          CI质量门
├── AGENTS.md                   长期协作边界与强制架构规则
├── PROJECT_CONTEXT.md          产品上下文与核心对象
├── PROJECT_STATE.md            当前已经实现/尚未实现的唯一事实入口
├── PROJECT_PLAN.md             阶段计划与下一任务
├── PROJECT_LESSONS.md          会影响后续设计的高价值经验
└── package.json                Workspace统一命令入口
```

`node_modules/`、`dist/`、`.data/`、`.workflow/`、`.workflow-bundle/`、`.artifacts/`、`.test-artifacts/`、`.env` 等不是产品源码，不进入Git。不要从本地生成物反推当前源码行为。

## 3. 应用层

### 3.1 `apps/web`

责任：把Chat服务端的权威产品事实和当前活动状态投影成响应式PWA；保存草稿、主题和待重试命令身份等可丢弃浏览器状态。

关键文件：

| 文件 | 责任 |
|---|---|
| `src/main.tsx` | React与TanStack Query组合入口 |
| `src/App.tsx` | 真实工作区/视觉fixture入口、API健康状态、主题 |
| `src/components/RealWorkspace.tsx` | 当前真实对话、Plan审核、Memory选择/导入界面 |
| `src/real/use-real-chain.ts` | Query、Command、轮询、失效和恢复协调 |
| `src/api/client.ts` | 浏览器唯一公开API客户端；响应也执行Zod校验 |
| `src/real/real-storage.ts` | Session定位、活动Run与网络未知命令身份；不保存权威事实 |
| `src/drafts/` | 未发送草稿 |
| `src/styles/tokens.css` | 设计Token唯一值表 |
| `vite.config.ts` | PWA、API代理和Web测试边界 |
| `e2e/` | PWA、规划执行、Memory真实浏览器场景 |

依赖边界：运行时代码只能依赖公开的 `@chat/contracts/public`，不能导入Application、Store、Workflow、pi、Memory Adapter或Runtime私有合同。

### 3.2 `apps/api`

责任：终止HTTP、建立当前Principal上下文、校验DTO、调用Application用例、拥有当前JSON Store实例，并在事务外分发Outbox。

关键文件：

| 文件 | 责任 |
|---|---|
| `src/index.ts` | API进程入口、Trace、Store、Runtime凭据和Dispatcher装配 |
| `src/app.ts` | Hono应用、Request ID、HTTP Trace、健康检查和Router挂载 |
| `src/composition.ts` | API组合根；当前唯一允许实例化`JsonProductStore`的位置 |
| `src/product-routes.ts` | 浏览器可访问的公开Query/Command路由 |
| `src/internal-runtime-router.ts` | Workflow专用私有Application Command；不进入浏览器合同 |
| `src/outbox-dispatcher.ts` | 启动/恢复Workflow、导入/对账派发与结果未知监督 |
| `src/replay-main.ts` | 组合Product Store、Trace和版本证据的回放入口 |

Router不直接写JSON、调用pi或恢复Hook；产品事务只能由 `packages/application` 的用例拥有。

## 4. 内部包

| 包 | 当前责任 | 主要入口/文件 | 禁止承担 |
|---|---|---|---|
| `@chat/contracts` | strict Zod合同、ID、DTO、持久化快照、错误、Trace事件 | `src/public.ts`、`product-api.ts`、`product-store.ts`、`internal-runtime.ts` | 用例编排、I/O、框架组合 |
| `@chat/domain` | canonical Hash、Run/Plan/Memory状态机与不变量 | `canonical-hash.ts`、`run-state.ts`、`plan-state.ts`、`memory-import.ts` | Hono、React、Workflow、Provider、文件I/O |
| `@chat/application` | Query/Command用例、事务、CAS、幂等、Outbox、Port | `product-store-port.ts`、`*-use-cases.ts`、`*-ports.ts` | HTTP、SDK对象、直接外部调用 |
| `@chat/product-store-json` | 单实例单写JSON Adapter、原子替换、完整性校验和v1→v3迁移 | `json-product-store.ts`、`snapshot-integrity.ts`、`migrate-*.ts` | 路由、Workflow、产品策略 |
| `@chat/workflows` | `PlanningExecutionWorkflow`、`MemoryImportWorkflow`、Step、Hook、Runtime Binding和Local World | `planning-execution-workflow.ts`、`memory-import-workflow.ts`、`runtime-server.ts` | 直接打开Product Store、向浏览器泄漏Runtime ID |
| `@chat/pi-runtime` | pi Agent loop、Planner/Executor输出合同和百炼配置 | `planner.ts`、`executor.ts`、`agent-runner.ts`、`config.ts` | Product Run终态、审批、Store事务 |
| `@chat/memory-runtime` | 两套真实Memory Query/Import Adapter及服务端Registry | `registry.ts`、`memmy-adapter.ts`、`tencent-memorycore-adapter.ts` | 把外部记录升级成Chat权威事实 |
| `@chat/realtime` | 严格Trace写读、运行回放组装和CLI | `trace-sink.ts`、`trace-reader.ts`、`replay.ts` | 保存正文；当前尚未实现公开SSE Cursor Journal |
| `@chat/testing` | 架构依赖、跨Adapter集成、恢复和调试配置测试 | `architecture.test.ts`、`b2-backend-loop.test.ts`、`vscode-debug-config.test.ts` | 生产运行逻辑 |

## 5. 依赖方向

```text
apps/web ───────────────────────────────> contracts/public

apps/api ─┬─> application ─────────────> domain + contracts
          ├─> product-store-json ───────> application + domain + contracts
          ├─> memory-runtime ───────────> application ports + domain + contracts
          ├─> workflows ────────────────> application ports + adapters
          └─> realtime

workflows ─┬─> pi-runtime
           ├─> memory-runtime
           ├─> realtime
           └─> API私有Runtime Router ──> application ──> Product Store
```

依赖方向由 `packages/testing/src/architecture.test.ts` 自动检查。目录图表达的是源码依赖；运行时通信还包括API进程与Workflow进程之间的loopback HTTP，不能因为源码可以导入就绕过私有HTTP边界。

## 6. 从用户行为定位代码

| 用户行为/故障 | 第一入口 | 下一层 |
|---|---|---|
| 页面启动、创建Session | `apps/web/src/App.tsx`、`use-real-chain.ts` | `api/client.ts` → `product-routes.ts` → `session-message-use-cases.ts` |
| 发送消息并启动规划 | `use-real-chain.ts` | Message Route → Application事务 → Outbox Dispatcher → Planning Workflow |
| 修改/批准/拒绝Plan | `RealWorkspace.tsx` | Decision Route → `plan-decision-use-cases.ts` → Resume Outbox → Hook |
| Memory规划召回 | `ContextPicker.tsx` | Planning Context Application → Workflow Memory Step → Memory Adapter |
| 显式导入Memory | `ChatMessageItem.tsx`/`RealWorkspace.tsx` | Memory Import Route → Outbox → Memory Import Workflow → Adapter |
| Product Store损坏/迁移 | API启动 | `composition.ts` → `json-product-store.ts` → `snapshot-integrity.ts`/迁移 |
| Provider或候选失败 | Workflow Step | `pi-runtime` → 失败归一化 → Application失败提交 |
| 回放一次Run | `apps/api/src/replay-main.ts` | `packages/realtime/src/replay.ts` + Product Store + 版本证据 |
| 本地应用/VS Code启动失败 | `scripts/dev/start.mjs` | `scripts/dev/app-runtime.mjs` → `docs/debug/local-debug.md` |

## 7. 文档类型与事实优先级

为避免把计划写成现状，文档按以下顺序解释冲突：

1. 当前能力和缺口：`PROJECT_STATE.md`。
2. 当前源码与自动测试。
3. 本文、`frontend-backend-interaction.md`、`runtime-workflows.md` 等as-built文档。
4. 冻结的目标边界：`technology-contract.md`、`system-boundaries.md`。
5. 历史任务范围和验收证据：`docs/tasks/`。
6. 原型和截图：`docs/design/`，不得当成已实现行为。

任务书解释“为什么这样做、当时怎样验收”，但不是长期API参考。行为变化合入时，应同步更新最接近该行为的as-built文档和 `PROJECT_STATE.md`，不要只在新任务书中追加说明。

## 8. 维护规则

以下变化必须更新本文：

1. 新增、删除或重新命名App/Package。
2. 改变包的职责或依赖方向。
3. 增加新的进程、事实源或组合根。
4. 关键入口文件迁移。
5. 把当前目标能力变为真实实现，例如SSE Runtime Journal落地。

更新后至少运行：

```bash
pnpm format:check
pnpm --filter @chat/testing test
```
