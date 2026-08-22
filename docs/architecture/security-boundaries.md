# 安全边界一页图

> 目的：一页看清 Chat 的全部安全接缝——每条边界回答"谁被挡在外面、由谁执行、
> 失败时怎样表现"。as-built 性质；与代码冲突时以代码为准并回写本文。
> 对照基准：NanoClaw 的 `modules/{permissions, approvals, mount-security,
> egress-lockdown}` 集中可见；Chat 的分层防御分散在各层，本文是它的地图。

## 总览

```text
公网/浏览器                    私有 loopback                    隔离执行
┌──────────────────┐   ┌──────────────────────────┐   ┌─────────────────────┐
│ DSH Web / PWA     │   │ API 私有Runtime Router    │   │ Pi Coding Executor   │
│  ↕ 公开Query/     │   │  Workflow Runtime         │   │ (默认Pi CLI能力)      │
│   Command         │   │  ↕ rtk_凭据               │   │ Prompt审核/派发栅栏   │
└──────┬───────────┘   └────────────┬─────────────┘   └──────────┬──────────┘
       │ ①公开合同/public           │ ③内部凭据                    │ ⑤能力门
       ▼                            ▼                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Application：认证上下文、权限、revision/Hash/幂等校验（②④）             │
│ Product Store：单写Adapter、原子替换、完整性失败关闭（⑦）                │
│ Outbox：意图栅栏、outcome_unknown、对账（⑧）                           │
└──────────────────────────────────────────────────────────────────────┘
```

## 逐条边界

| # | 边界 | 执行者（代码位置） | 失败语义 |
|---|---|---|---|
| ① | 浏览器/前端只能消费公开合同 | `packages/dsh-lifeos-bridge`（架构门禁止 import 服务端包与私有身份字段）；`packages/contracts/src/public.ts` | 越界 import 被架构测试挡住；浏览器无 Workflow/Hook/pi 直连 |
| ② | 每个公开命令携带认证主体、幂等身份与预期 revision | Hono 认证上下文 + Application 校验（`apps/api/src/product-routes/`、`packages/application/src/session-message-use-cases.ts`） | 非法主体/过期 revision/重复命令安全失败 |
| ③ | API↔Workflow Runtime↔Pi Executor 的私有通道 | `packages/contracts/src/runtime-credential.ts`（rtk_ 凭据，0600 文件或 env，不打印不进 Trace）；三方进程只监听 loopback | 缺凭据/格式非法失败关闭；并发创建原子 |
| ④ | HITL 决定先于执行恢复：先提交产品 Decision，再恢复 Workflow Hook | `packages/application/src/plan-decision-use-cases.ts`、`packages/application/src/prompt-review-use-cases.ts`；Hook Token 不是授权身份 | 重复点击/旧页面/过期决定全部安全失败；Hash 不匹配拒绝 |
| ⑤ | Executor 能力边界：Direct 默认继承真实 `pi_cli_default`；只读/自定义限制只能来自用户选择的 Agent Version、Workflow 或会话临时配置；Workspace 仍须显式授权 | `packages/pi-runtime/src/direct-agent-executor.ts`、`packages/application/src/prompt-assembly-use-cases.ts`、`apps/pi-executor` | 手动审核时未批准的请求不越 Provider Gate；关闭审核时仍先过耐久派发栅栏；Runtime Manifest、Workspace 或能力 Hash 漂移在 Provider 前失败关闭 |
| ⑥ | Workflow 出网与 Provider 调用 | `packages/workflows/src/workflow-network-policy.ts`；Provider Key 走 Pi 标准凭据链，仓库不存 | 非白名单网络访问拒绝；Key 不进日志/Trace |
| ⑦ | 产品事实单写与完整性 | `packages/product-store-json`：单写 Adapter、临时文件原子替换、`snapshot-integrity/` 失败关闭 | 损坏即拒开，绝不猜测修复 |
| ⑧ | 外部副作用 | `packages/application` Outbox：意图先于调用落盘；`outcome_unknown`；查询对账 | 断线不盲重试；未知结果对账或人工处置 |
| ⑨ | Trace 不成为泄密通道 | `packages/contracts/src/trace/`：事件级严格白名单、无任意正文通道；不记密钥/完整 Payload/隐藏推理 | 未声明字段根部与嵌套层都失败关闭 |
| ⑩ | 远程公网入口（部署拓扑A） | `deploy/`：版本化 scrypt、登录节流、App 签名 Cookie；Workbench 不进远程部署 | 未认证请求在网关层终止 |

## 明确不在边界内的

- Pi 本身不内建权限系统（上游明示），Executor 隔离由 Chat 的进程与能力门承担。
- DSH Session、浏览器缓存、IndexedDB 只是投影/草稿，清空后服务端可重建正式状态。
- Workflow Run ID、Hook Token、Pi Session ID 都不是产品身份或授权依据。

## 新边界检查清单

新增一条接缝时，必须在本表登记：执行者代码位置、被挡对象、失败语义、
对应架构门或合同测试。未登记的边界视为不存在。
