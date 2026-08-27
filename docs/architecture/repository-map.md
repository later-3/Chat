# Chat 仓库地图

## 顶层

```text
apps/
  api/                    Hono公开/私有协议入口与组合根
  dsh-web/                固定DeepSeek Harness依赖与受管启动入口
  pi-executor/             私有Pi Coding Executor Service进程入口
packages/
  dsh-lifeos-bridge/      DSH Host/Client插件与Chat适配
  contracts/              公开/内部网络合同、事件类型、内部Runtime客户端与实例凭据
  domain/                 产品对象、状态机、Hash与不变量
  application/            用例、事务、权限、幂等与Outbox
  product-store-json/     当前Product Store Adapter与迁移
  workflows/              Vercel Workflow定义与活动
  pi-runtime/             pi Planner、AgentSession、Operation Journal与Executor Client
  memory-runtime/         memmy与Tencent MemoryCore Adapter
  realtime/               Trace与Replay
  testing/                合同、架构与测试工具
scripts/
  ci/                     Managed Sources、去凭据环境、测试lane、API/compat/ADR与供应链机械门
  dev/                    统一应用监督器与production/debug实例合同
  dsh/                    DSH Profile准备与Host启动
  debug/                  固定端口、PID身份与停止/状态
  memory/                 固定Memory依赖准备与验证
  workbench/              固定code-server准备、运行、回收与真实验证
  e2e/                    真实纵向预检和服务编排
config/
  managed-sources.json    Chat/Pi/DSH工具链、来源、构建输入、许可证与精确链接锁
  test-lanes.json         正式测试文件与根测试命令的唯一主要lane分类
  api-surface.baseline.json  从真实组合根生成的公共接口baseline
  api-compatible-change-records.json 公共新增的精确一次性审查记录
  compatibility-policy.json 六类read-old/write-current规则与Owner路由
  compatibility-facts.baseline.json 六类真实Owner源码生成的代际指纹
  supply-chain-policy.json 生产许可证例外与安装lifecycle白名单
docs/
  agent-governance/        Agent推进项目的规范、路由与理论证据
  getting-started/        全新克隆、固定工件准备与本地安装
  architecture/           当前合同与as-built
  product/                稳定产品原则
  debug/                  当前调试入口
  testing/                测试lane、默认内存与付费/外部写门
  decisions/              轻量ADR模板、索引与跨模块长期决定
```

仓库不包含旧自研Web、Agent Canvas、DeepSeek Harness源码副本或UI原型归档。DSH派生源码由独立Public仓库`later-3/deepseek-harness-chat`维护，本仓库只保存Fork链接声明、分支证据与漂移门；删除内容需要时从Git历史读取。

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
Store/Workflow/Memory Adapter ────────> application/domain ports
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

当前树不保留archive/legacy、个人学习资料、历史任务书或过程截图；Git历史是唯一历史档案。Chat开发事实只由源码、`PROJECT_STATE.md`与`docs/`中的当前合同/as-built描述。

## 工程与供应链入口

| 目标 | 入口 | 失败关闭内容 |
| --- | --- | --- |
| 新Agent接手 | `docs/getting-started/quick-context.md`、14个Workspace README | 缺README、坏链接或虚构脚本 |
| Managed Sources | `config/managed-sources.json`、`scripts/ci/managed-sources.mjs` | Fork来源/commit/dirty/marker/license/link漂移 |
| 测试lane | `config/test-lanes.json`、`scripts/ci/test-lanes.mjs` | 漏分、重复、脚本/命令漂移、默认Heap聚合 |
| 普通核心门 | `scripts/ci/verify-core.mjs` | 凭据/外部开关、build/lint/format/typecheck/core失败 |
| Browser纵向 | `scripts/e2e/run-dsh-mode.mjs`、唯一Playwright配置 | 端口/数据隔离、凭据sentinel、真实Host/Client失败 |
| CI结构 | `.github/workflows/ci.yml`、`scripts/ci/ci-workflow.test.mjs` | Action SHA、permissions、Job准备、paid/external混入 |
| 公共API Surface | `scripts/ci/api-surface.mjs`、`config/api-surface.baseline.json` | 外部请求/响应/状态/错误/导出漂移，未记录新增与未批准breaking change |
| 兼容政策 | `config/compatibility-policy.json`、`config/compatibility-facts.baseline.json` | 六类真实事实漏项、旧代扩权、原地改语义、无迁移升代 |
| ADR | `docs/decisions/README.md`、`scripts/ci/decision-records.mjs` | 漏索引、非法状态、缺范围/后果/回滚 |
| 最低供应链 | `scripts/ci/supply-chain.mjs`、`config/supply-chain-policy.json` | 三仓真实闭包的secret/license/lifecycle/audit失败；whole-fork债务另报 |

API Surface baseline由真实组合根、browser public barrel与package manifest生成，不手抄Schema字段，也不冻结
内部Application调用图；
兼容policy只保存规则和Owner路由，facts baseline由Owner源码生成；两者都不替代产品事实。
