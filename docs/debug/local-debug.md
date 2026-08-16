# Chat 本地调试

## 固定端口

| 服务 | 地址 |
|---|---|
| DSH Web | `http://127.0.0.1:43110` |
| Chat API | `http://127.0.0.1:43111` |
| Workflow | `http://127.0.0.1:43112` |
| Code Workbench | `http://127.0.0.1:43113`（启用时） |
| API Inspector | `127.0.0.1:43120`（`dev:debug`） |
| Workflow Inspector | `127.0.0.1:43121`（`dev:debug`） |

所有服务只使用固定端口；冲突时失败关闭或在四重身份校验后回收同一Git仓库的旧进程，不能自动换号。

## 命令

```bash
pnpm install
pnpm dev
pnpm dev:debug
pnpm dev:status
pnpm dev:stop
```

`pnpm dev`依次准备固定Memory、Workflow兼容性、DSH Bridge/Profile，再启动Memory、Workflow、API和DSH Host。终端SIGINT或`pnpm dev:stop`必须反向停止并释放端口。

## DSH调试

断点与日志统一按“文件 + 函数/路由 + 观察变量”定位，不把易漂移的固定行号写成合同。

| 目标 | 文件/入口 | 观察内容 |
|---|---|---|
| Profile准备 | `scripts/dsh/prepare-web-profile.mjs` | 固定DSH版本、Bridge bundle、worktree私有`DSH_HOME` |
| Host启动 | `scripts/dsh/start-web.mjs` | `127.0.0.1:43110`、Boot Manifest、插件加载失败 |
| Session映射 | `AtomicBridgeStateStore`、`LifeosLlmAdapter.ensureChatSession` | `dshSessionId -> productSessionId`、原子状态、稳定Command |
| 消息发送 | `LifeosLlmAdapter.stream`、`ChatProductClient.submitMessage` | 只处理正常会话请求；title/compaction无产品写入 |
| Plan/HITL | `LifeosBridgeService.projection/decide`、Client Slot | Run revision、Plan/Approval版本与Hash、Decision Command |
| 决定提交 | `ChatProductClient.submitDecision` | 同一pending command、Run CAS、Plan/Approval版本与Hash |
| 正式回复 | Bridge LLM Adapter | 只从Chat Message Query选择正式Assistant Message |

不要在日志/Watch中展示完整用户正文、密钥、Hook Token、Workflow Run ID或pi Session ID。

## 后端主链断点

1. `apps/api/src/product-routes.ts`：Message/Decision路由，只做协议和认证边界。
2. `packages/application/src/session-message-use-cases.ts`的`submitUserMessage`：Message、Run、Receipt、Outbox原子提交。
3. `apps/api/src/outbox-dispatcher.ts`的`dispatchStart/dispatchResume`：只在Outbox事实之后启动或恢复Runtime。
4. `packages/workflows/src/planning-execution-workflow.ts`的`planningExecutionWorkflow`：Planning/HITL/Execution耐久步骤。
5. `packages/application/src/plan-decision-use-cases.ts`的`submitPlanDecision`：Decision的权限、CAS、Plan版本与Hash边界。
6. `packages/workflows/src/workflow-result-steps.ts`的`commitExecutionResultStep`与`packages/application/src/commit-runtime-use-cases.ts`的`commitExecutionResult`：候选验证后提交正式Message和Run终态。
7. `packages/pi-runtime`：Planner/Executor模型与工具边界。
8. `packages/product-store-json`：revision、迁移、原子替换与完整性校验。

## Trace

```bash
pnpm debug:trace -- list-runs
pnpm debug:trace -- inspect-run <productRunId>
pnpm debug:replay -- --run <productRunId>
```

Trace只保存可观察事件、对象引用、版本、耗时和安全错误，不保存模型隐藏推理或完整Provider Payload。

## Workbench调试

启用后检查：code-server固定版本与SHA、Workspace挂载、独立用户数据目录、HTTP与WebSocket代理、Terminal子进程回收、DSH关闭/重开Surface后的状态保持。Workbench端口不能直接暴露给非本机客户端。
