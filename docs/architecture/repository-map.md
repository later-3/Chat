# Chat 仓库地图

## 顶层

```text
apps/
  api/                    Hono公开/私有协议入口与组合根
  dsh-web/                固定DeepSeek Harness依赖与受管启动入口
  pi-executor/             私有Pi Coding Executor Service进程入口
packages/
  dsh-lifeos-bridge/      DSH Host/Client插件与Chat适配
  contracts/              公开/内部网络合同与事件类型
  domain/                 产品对象、状态机、Hash与不变量
  application/            用例、事务、权限、幂等与Outbox
  product-store-json/     当前Product Store Adapter与迁移
  workflows/              Vercel Workflow定义与活动
  pi-runtime/             pi Planner、AgentSession、Operation Journal与Executor Client
  memory-runtime/         memmy与Tencent MemoryCore Adapter
  project-runtime/        受权本地Git/文档/脚本资源的只读Project Adapter
  realtime/               Trace与Replay
  testing/                合同、架构与测试工具
scripts/
  dev/                    统一应用监督器与production/debug实例合同
  dsh/                    DSH Profile准备与Host启动
  debug/                  固定端口、PID身份与停止/状态
  memory/                 固定Memory依赖准备与验证
  workbench/              固定code-server准备、运行、回收与真实验证
  e2e/                    真实纵向预检和服务编排
docs/
  getting-started/        全新克隆、固定工件准备与本地安装
  architecture/           当前合同与as-built
  product/                稳定产品原则
  debug/                  当前调试入口
```

仓库不包含旧自研Web、Agent Canvas、DeepSeek Harness源码副本或UI原型归档。删除内容需要时从Git历史读取。

## 用户主链定位

| 行为 | 入口 | 权威边界 |
|---|---|---|
| 打开页面 | `apps/dsh-web`、`scripts/dsh/start-web.mjs` | production 43110 / debug 44110 Gateway、内部DSH Host与Client插件图 |
| 发送消息 | `packages/dsh-lifeos-bridge` Host LLM Adapter | Chat Message Command |
| 创建Message/Run | `apps/api/src/product-routes.ts` | Application事务与Product Store |
| 规划 | `packages/workflows` -> `packages/pi-runtime` | Plan候选经Application提交 |
| 查看Plan/Approval | Bridge Host Query + Client Slot | Product Store投影 |
| 修订/批准/拒绝 | Bridge Client -> Host -> Chat Decision Command | Application校验后提交Decision |
| 执行与正式回复 | Workflow -> pi -> Product Commit | 正式Assistant Message来自Product Store |
| 打开开发工作台 | Bridge Client Workbench Surface | 独立Origin经Gateway代理固定code-server |

## 依赖方向

```text
DSH Client/Host Adapter ──> contracts/public
Hono Router ──────────────> application ──> domain + ports
Store/Workflow/Memory/Project Adapter ─> application/domain ports
pi Adapter ───────────────> contracts中的稳定运行合同
domain ───────────────────> TypeScript标准能力
```

禁止：Domain导入React/Hono/DSH/Workflow/pi；Client插件导入服务端实现；Router或Workflow Step直接写Product Store；Workbench绕过Chat事务写产品事实。

## 事实与规范的关系

1. 源码、运行时Schema、状态机和测试描述“当前实际实现了什么”。
2. `PROJECT_STATE.md`与as-built架构文档汇总当前交付事实。
3. `AGENTS.md`与技术合同规定“允许怎样演进”，不能被偶然实现静默覆盖。
4. `PROJECT_PLAN.md`描述阶段顺序，不是开工授权；任务书和研究只解释已审核范围与意图。
5. 实现事实与冻结规范冲突时必须停止并报告，由用户决定修实现还是修合同。

当前树不保留archive/legacy目录；Git历史是唯一历史档案。
