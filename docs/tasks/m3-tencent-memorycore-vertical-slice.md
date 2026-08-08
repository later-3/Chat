# M3 任务书：Tencent MemoryCore 第二真实后端纵向闭环

| 项 | 冻结值 |
|---|---|
| 基线 | `main@0682ed4`（M2 合入点） |
| 分支 | `codex/m3-tencent-memorycore` |
| 固定源码 | `/Users/xulater/Code/opc-os/tencentdb-agent-memory`，commit `3a9748d3c61c2a2feb38237c9b28992250c1804e` |
| 服务 | MemoryCore `2.0.0-beta.1`，本地 Standalone，SQLite + BM25，embedding=`none` |
| 首版原则 | 先打通真实纵向路径；不伪造 L1，不把 `accepted` 显示成 `materialized` |

> 状态：已由 PR #12 合入 `main@6bd7129`；后续小任务补齐 MemoryCore VS Code Compound 与关键中文注释。

## 1. 目标

在现有同一套 Chat 交互、Workflow、Product Store 和 Memory Port 上增加第二个真实后端。用户可以：

1. 在“上下文”中选择 Tencent MemoryCore，查询真实 `POST /v3/atomic/search`，结果进入规划 ContextPackage。
2. 从正式会话消息选择 Tencent MemoryCore 导入，真实调用 `POST /v3/conversation/add`。
3. 导入后立即看到 `accepted`；通过同一个 MemoryImportWorkflow 按稳定外部 session 查询 L0 对账。
4. 只有查到该 session 对应的 L1 才升级为 `materialized`；未抽取时继续保持 `accepted`。
5. memmy 原有 query/import/reconcile 路径全部保持可用。

## 2. 明确不做

1. 不重做 Memory 页面，不做 UI 视觉优化，只做已有选择器/导入对话框的能力适配。
2. 不把 MemoryCore、SQLite 或 Workflow Store 当 Chat Product Store。
3. 不在 Chat 内复制 MemoryCore 的 L0/L1 全量对象。
4. 不调用 `atomic/update` 创建或重放导入。
5. 不为了测试伪造 embedding、MemoryCore HTTP 服务或 L1 物化结果。
6. 不部署第三方 MemoryCore 到弱服务器；真实门只在本机构建并启动固定 Git 快照。

## 3. 源码依据与设计理由

固定源码已经证明：

1. `/v3/conversation/add` 写入 L0，返回 `accepted_ids/accepted_versions/total_count`；Pipeline 通知失败不回滚已经写入的 L0。
2. `/v3/atomic/search` 查询 L1；Standalone 配置支持 SQLite + BM25，`embedding.provider=none`。
3. v3 数据面要求 Bearer 与 `x-tdai-service-id`；严格隔离还需要 team/user/agent/session。
4. `atomic/update` 只更新已存在 L1，并递增版本，不具备 create/replay 语义。
5. L1 抽取依赖真实 LLM，可能晚于导入，甚至失败后仍推进 Cursor。因此 Chat 不能根据 L0 成功推断 L1 已物化。

由此采用两个窄 Port，继续保持 Query 与有副作用 Import 分离；后端差异用判别联合表达，不增加任意 metadata 袋子。

## 4. 合同

### 4.1 查询能力

- `memmy`：标签=true，层级=L1/L2/L3/Skill（按现有配置）。
- `tencent_memorycore`：标签=false，层级=L1。
- 浏览器只提交 `backendId` 和该后端公开能力内的选择；endpoint、Token、serviceId 与隔离映射绝不公开。
- Application 在调用 Adapter 前再次校验标签、层级、limit 与预算，不能只依赖 UI 禁用。

### 4.2 导入能力

- `memmy.explicit_fact`：目标 L2，支持 title/tags，返回 Memory ID 后可读取和检索验证。
- `tencent.conversation_capture`：目标 L0，不向外部发送 title/tags；发送一条 user message，外部 session 由 `MemoryImportIntentId` 稳定派生。
- Tencent 成功响应的外部对象身份使用稳定 session，而不是某一次随机 message ID；随机 accepted IDs 只参与响应 Hash，不作为重放身份。

### 4.3 对账

1. 用同一个 serviceId + team/user/agent + stable session 调 `/v3/conversation/query`。
2. L0 中存在正文完全相同的记录：返回 `accepted`。
3. 再调 `/v3/atomic/query`，只有存在 `session_id=stable session` 的 L1 才返回 `materialized`。
4. 找不到 L0：返回 `outcome_unknown`，不得再次调用 `conversation/add`。

## 5. 服务端配置

| 环境变量 | 用途 |
|---|---|
| `CHAT_TENCENT_MEMORYCORE_BASE_URL` | 仅服务端 endpoint；本地默认 `http://127.0.0.1:18970` |
| `CHAT_TENCENT_MEMORYCORE_TOKEN` | Bearer；不进入日志/Trace/Product Store |
| `CHAT_TENCENT_MEMORYCORE_SERVICE_ID` | MemoryCore 实例隔离 |
| `CHAT_TENCENT_MEMORYCORE_TEAM_ID` | Team 隔离 |
| `CHAT_TENCENT_MEMORYCORE_USER_ID` | User 隔离 |
| `CHAT_TENCENT_MEMORYCORE_AGENT_ID` | Agent 隔离 |
| `CHAT_TENCENT_MEMORYCORE_CONFIG_REVISION` | 非秘密配置版本证据 |
| `CHAT_TENCENT_MEMORYCORE_CREDENTIAL_REVISION` | 非秘密凭据版本证据 |

本地 MemoryCore 固定端口为 `18970`，纳入统一 preclean 冻结端口检查；未知占用只报告、不终止。

远端必须 HTTPS；loopback 才允许 HTTP。配置缺失时后端仍可列出，但 `configured=false/health=unavailable`。

## 6. 模块改动

1. `packages/contracts`：后端/能力判别联合，公开 DTO 严格 Schema。
2. `packages/domain`：两种 descriptor/request 的 canonical Hash；旧 memmy Hash 不漂移。
3. `packages/application`：能力级校验，不写后端私有分支。
4. `packages/memory-runtime`：新增独立 Tencent Adapter 与 Registry 装配；不引入腾讯 SDK。
5. `apps/web`：复用现有选择器和导入对话框，按能力隐藏不支持的标签/title，展示异步语义。
6. `scripts/e2e`：从固定 Git 对象导出隔离快照，在本地安装/启动；不得读取参考工作树未提交内容。

## 7. Trace 与安全

Trace 只记录 backendId、operationId、阶段、耗时、稳定错误码、revision 和外部 ID Hash；不记录用户正文、Bearer、endpoint、serviceId、team/user/agent/session 原值或 MemoryCore 响应体。完整回放继续由 Trace + Product Message/Intent + Workflow 证据组装。

## 8. 测试门

### 8.1 确定性测试

1. 两后端同一 Query/Import Port conformance。
2. Tencent strict 请求/响应；坏 envelope、401/403、5xx、超时、断响应分类稳定。
3. 标签/层级越权在外呼前失败；错误隔离配置失败关闭。
4. `conversation/add` 只调用一次；对账只读 L0/L1，绝不调用 `atomic/update` 或再次 add。
5. Product Store 重启、幂等、Hash、Replay、Trace 无正文回归。

### 8.2 真实 MemoryCore 门

1. 固定 commit/tree 导出，Node 版本满足 `>=22.16.0`，本地安装并启动 18970。
2. 真实 `conversation/add` 后，真实 `conversation/query` 能读到唯一 L0；重复对账数量不增加。
3. 使用固定源码自己的 SQLite Store 写入一条真实 L1 fixture，再经真实 HTTP `atomic/search` 的 BM25 命中；embedding 保持 `none`。
4. 错 Token、错隔离与响应丢失均走真实服务验证。
5. 复跑 memmy 真实 query/import 门。

### 8.3 浏览器 E2E

1. 两个后端同时显示且能力不同。
2. Tencent 导入完成后页面显示“已接收，等待异步提炼”，刷新不丢。
3. 再次验证未出现 L1 时仍是 accepted，不显示 materialized。
4. Tencent 查询命中真实 L1 后，真实 `qwen3.7-plus` 规划采用该快照。

真实门缺固定源码、网络、pi 百炼凭据或所需本地依赖时失败关闭，不 Skip、不换假服务/模型。百炼凭据沿用已经批准的 pi 配置读取方式。

## 9. 完成判定

M3 首版只有在“双后端可选择 + Tencent 真实 query/import/reconcile + accepted/materialized 如实区分 + memmy 回归 + 全质量门 + CI”全部通过后才可合并。L1 自动等待、后台定时对账和更丰富能力展示属于后续优化，不阻塞这个真实纵向闭环。

## 10. 实施证据

1. 固定 MemoryCore `3a9748d3c61c` 的真实 HTTP 门通过：L0 add/query、L1 BM25 atomic/search、错误 Token、错误隔离、重复只读对账和端口释放均已验证。
2. 真实 Chromium E2E 通过：前端选择 Tencent → 真实 L1 查询 → 百炼 `qwen3.7-plus` 规划采用 → L0 导入 → accepted → 手动对账 → 刷新恢复 → 拒绝结束。
3. E2E 发现并修复两项跨层缺陷：公开能力曾错误硬编码 `tags=true`；Outbox 终态监督器曾把合法 L0 `accepted` 降级为 `outcome_unknown`。两项均有确定性回归测试。
4. Trace 与公开响应扫描未出现用户正文、Token、endpoint、service/team/user/agent 私有隔离值或 Workflow/pi 私有身份。
